/**
 * Sheets 牌譜 → replayable game (agreement benchmark, 2026-10-10).
 *
 * Strict re-parse of one `牌譜` row from `sheets_cache.json`. Unlike the
 * lenient importer (`parseSheetsGameCell`, which skips malformed lines),
 * this parser rejects any game whose record cannot be replayed exactly —
 * a single skipped proposal would shift the leader rotation for the rest
 * of the game and corrupt every reconstructed observation.
 *
 * Record conventions (local 10-player games):
 *   - one line per proposal: team seat digits (0 = seat 10) + optional
 *     anomaly tokens `X+` (off-team approve) / `X-` (on-team reject);
 *     every other seat cast the default vote (on-team approve, off-team
 *     reject);
 *   - leader rotates every proposal from seat 1 (`leaderSeatForProposal`);
 *   - the 5th proposal of a round is forced (no vote is held — the engine
 *     records a synthetic unanimous approve);
 *   - a line of `o`/`x` ends the round with the quest cards;
 *   - `X>Y o|x` = Lady of the Lake after rounds 2/3/4 (holder X inspected
 *     Y and publicly claimed good|evil; no letter / `?` = undeclared).
 *     The lady starts with seat 10 (right of the first leader).
 *   - `配置` = six seat chars for 刺/娜/德/奧/派/梅; everyone else is loyal.
 *   - `刺殺` = assassination target seat.
 */

import { AVALON_CONFIG, type Role } from '@avalon/shared';
import {
  __internal as sheetsInternal,
  leaderSeatForProposal,
  normalizeGameTextLines,
} from '../../services/sheetsGameRecordParser';

export type Camp = 'good' | 'evil';

/** Order of the six special roles in the `配置` code (刺娜德奧派梅). */
export const ROLE_CODE_ORDER: readonly Role[] = [
  'assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin',
];
export const EVIL_ROLES: ReadonlySet<Role> = new Set<Role>([
  'assassin', 'morgana', 'mordred', 'oberon',
]);
export const PLAYER_NAME_COLUMNS: readonly string[] = [
  '玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0',
];

export const REPLAY_PLAYER_COUNT = 10;
/** Seat that holds the Lady of the Lake first (right of the seat-1 leader). */
export const FIRST_LAKE_HOLDER_SEAT = 10;

export interface ReplayProposal {
  round: number;
  /** 1..5 within the round. */
  attempt: number;
  /** 0-based index across the whole game (drives the leader rotation). */
  globalIndex: number;
  leaderSeat: number;
  teamSeats: number[];
  /** Off-team approvers (`X+`). */
  plusSeats: number[];
  /** On-team rejecters (`X-`). */
  minusSeats: number[];
  /** votes[seat - 1] = approve? (literal reconstruction from the record). */
  votes: boolean[];
  approveCount: number;
  /** 5th proposal of the round — forced, no vote held. */
  forced: boolean;
  /** This proposal's team went on the round's mission. */
  wentOnMission: boolean;
  /**
   * Whether the reconstructed votes are trustworthy: not forced, and the
   * implied approve count agrees with the outcome (majority > half for the
   * proposal that went on the mission, ≤ half for rejected ones). Older
   * records often omit the anomalies on the approved proposal.
   */
  votesReliable: boolean;
}

export interface ReplayQuest {
  round: number;
  teamSeats: number[];
  successCount: number;
  failCount: number;
  failed: boolean;
}

export interface ReplayLake {
  /** Round after whose quest the lake was used. */
  round: number;
  holderSeat: number;
  targetSeat: number;
  /** Public claim; `null` = no (legible) declaration. */
  claim: Camp | null;
}

export interface ReplayGame {
  id: string;
  playerCount: number;
  /** seatRoles[seat - 1]. */
  seatRoles: Role[];
  /** names[seat - 1]; '' when unknown. */
  names: string[];
  proposals: ReplayProposal[];
  quests: ReplayQuest[];
  lakes: ReplayLake[];
  /** Holder chain starts at seat 10, follows targets, one lake after R2/R3/R4. */
  lakeChainValid: boolean;
  assassinTargetSeat?: number;
  winner: Camp;
}

export type ReplayParseResult =
  | { ok: true; game: ReplayGame }
  | { ok: false; reason: string };

export type PaipuRow = Readonly<Record<string, string>>;

/** `[header, ...rows]` sheet table → keyed rows. */
export function rowsFromSheet(table: readonly (readonly string[])[]): PaipuRow[] {
  if (table.length === 0) return [];
  const header = table[0];
  return table.slice(1).map((row) => {
    const out: Record<string, string> = {};
    header.forEach((key, i) => { out[key] = row[i] ?? ''; });
    return out;
  });
}

export function campOf(role: Role): Camp {
  return EVIL_ROLES.has(role) ? 'evil' : 'good';
}

const LAKE_LINE = /^([0-9])>([0-9])(?:\s*([oxOX?]))?$/;

function seatOfChar(ch: string): number {
  return sheetsInternal.charToSeat(ch);
}

function fail(reason: string): ReplayParseResult {
  return { ok: false, reason };
}

/**
 * Parse one 牌譜 row into a replayable 10-player game, or explain why not.
 */
export function parseReplayGame(row: PaipuRow): ReplayParseResult {
  const text = row['文字記錄'] ?? '';
  const code = (row['配置'] ?? '').trim();
  if (!text.trim()) return fail('no move record');
  if (!/^[0-9]{6}$/.test(code)) return fail('bad role code');

  const playerCount = REPLAY_PLAYER_COUNT;
  const config = AVALON_CONFIG[playerCount];

  const seatRoles: Role[] = new Array<Role>(playerCount).fill('loyal');
  const specialSeats = new Set<number>();
  for (let i = 0; i < 6; i++) {
    const seat = seatOfChar(code[i]);
    if (specialSeats.has(seat)) return fail('duplicate seat in role code');
    specialSeats.add(seat);
    seatRoles[seat - 1] = ROLE_CODE_ORDER[i];
  }

  const names = PLAYER_NAME_COLUMNS.map((col) => (row[col] ?? '').trim());

  const proposals: ReplayProposal[] = [];
  const quests: ReplayQuest[] = [];
  const lakes: ReplayLake[] = [];
  let round = 1;
  let roundProposals: ReplayProposal[] = [];
  let gameOver = false;

  for (const line of normalizeGameTextLines(text, code)) {
    if (gameOver) return fail('lines after game end');

    if (sheetsInternal.isQuestLine(line)) {
      const last = roundProposals[roundProposals.length - 1];
      if (!last) return fail('quest line without proposal');
      const cards = line.toLowerCase();
      if (cards.length !== last.teamSeats.length) return fail('quest card count != team size');
      const failCount = [...cards].filter((c) => c === 'x').length;
      const evilOnTeam = last.teamSeats.filter((s) => EVIL_ROLES.has(seatRoles[s - 1])).length;
      if (failCount > evilOnTeam) return fail('more fail cards than evil on team');
      last.wentOnMission = true;
      for (const p of roundProposals) {
        p.votesReliable = !p.forced && (
          p.wentOnMission ? p.approveCount * 2 > playerCount : p.approveCount * 2 <= playerCount
        );
      }
      quests.push({
        round,
        teamSeats: [...last.teamSeats],
        successCount: cards.length - failCount,
        failCount,
        failed: failCount >= config.questFailsRequired[round - 1],
      });
      const fails = quests.filter((q) => q.failed).length;
      const successes = quests.length - fails;
      if (fails >= 3 || successes >= 3) gameOver = true;
      round += 1;
      roundProposals = [];
      continue;
    }

    const lakeMatch = LAKE_LINE.exec(line);
    if (lakeMatch) {
      if (roundProposals.length > 0 || quests.length === 0) return fail('lake line mid-round');
      const decl = (lakeMatch[3] ?? '').toLowerCase();
      lakes.push({
        round: quests.length,
        holderSeat: seatOfChar(lakeMatch[1]),
        targetSeat: seatOfChar(lakeMatch[2]),
        claim: decl === 'o' ? 'good' : decl === 'x' ? 'evil' : null,
      });
      continue;
    }

    let parsed: { teamSeats: number[]; anomalies: { seat: number; kind: 'plus' | 'minus' }[] };
    try {
      parsed = sheetsInternal.parseProposalLine(line);
    } catch {
      return fail('unparseable line');
    }
    if (roundProposals.length >= 5) return fail('more than 5 proposals in a round');
    const teamSeats = parsed.teamSeats;
    if (teamSeats.length !== config.questTeams[round - 1]) return fail('team size mismatch (not a 10p record?)');
    if (new Set(teamSeats).size !== teamSeats.length) return fail('duplicate seat in team');
    const team = new Set(teamSeats);
    const plusSeats: number[] = [];
    const minusSeats: number[] = [];
    for (const a of parsed.anomalies) {
      if (a.kind === 'plus') {
        if (team.has(a.seat)) return fail('off-team approve marker on a team member');
        plusSeats.push(a.seat);
      } else {
        if (!team.has(a.seat)) return fail('on-team reject marker on a non-member');
        minusSeats.push(a.seat);
      }
    }
    const votes: boolean[] = [];
    for (let seat = 1; seat <= playerCount; seat++) {
      votes.push(team.has(seat) ? !minusSeats.includes(seat) : plusSeats.includes(seat));
    }
    const attempt = roundProposals.length + 1;
    const proposal: ReplayProposal = {
      round,
      attempt,
      globalIndex: proposals.length,
      leaderSeat: leaderSeatForProposal(proposals.length, playerCount),
      teamSeats,
      plusSeats,
      minusSeats,
      votes,
      approveCount: votes.filter(Boolean).length,
      forced: attempt === 5,
      wentOnMission: false,
      votesReliable: false,
    };
    proposals.push(proposal);
    roundProposals.push(proposal);
  }
  if (!gameOver) return fail('incomplete game');

  const fails = quests.filter((q) => q.failed).length;
  const resultLabel = (row['結果'] ?? '').trim();
  let assassinTargetSeat: number | undefined;
  let winner: Camp;
  if (fails >= 3) {
    if (resultLabel && resultLabel !== '三紅') return fail('result column mismatch');
    winner = 'evil';
  } else {
    const raw = (row['刺殺'] ?? '').trim();
    if (/^[0-9]/.test(raw)) assassinTargetSeat = seatOfChar(raw[0]);
    const merlinSeat = seatRoles.indexOf('merlin') + 1;
    if (assassinTargetSeat !== undefined) {
      if (EVIL_ROLES.has(seatRoles[assassinTargetSeat - 1])) return fail('assassination target is evil');
      winner = assassinTargetSeat === merlinSeat ? 'evil' : 'good';
      const expected = winner === 'evil' ? '三藍死' : '三藍活';
      if (resultLabel && resultLabel !== expected) return fail('result column mismatch');
    } else if (resultLabel === '三藍死') {
      winner = 'evil';
    } else if (resultLabel === '三藍活') {
      winner = 'good';
    } else {
      return fail('result column mismatch');
    }
  }

  return {
    ok: true,
    game: {
      id: (row['流水號'] ?? '').trim(),
      playerCount,
      seatRoles,
      names,
      proposals,
      quests,
      lakes,
      lakeChainValid: isLakeChainValid(lakes, quests),
      assassinTargetSeat,
      winner,
    },
  };
}

/**
 * Lakes happen after rounds 2, 3, 4 while the game is still running; the
 * holder chain starts at seat 10 and each target becomes the next holder,
 * never inspecting a previous holder.
 */
function isLakeChainValid(lakes: readonly ReplayLake[], quests: readonly ReplayQuest[]): boolean {
  const expectedRounds: number[] = [];
  let fails = 0;
  let successes = 0;
  for (const q of quests) {
    if (q.failed) fails++; else successes++;
    if (fails >= 3 || successes >= 3) break;
    if (q.round >= 2 && q.round <= 4) expectedRounds.push(q.round);
  }
  if (lakes.length !== expectedRounds.length) return false;
  const used = new Set<number>([FIRST_LAKE_HOLDER_SEAT]);
  let holder = FIRST_LAKE_HOLDER_SEAT;
  for (let i = 0; i < lakes.length; i++) {
    const lake = lakes[i];
    if (lake.round !== expectedRounds[i]) return false;
    if (lake.holderSeat !== holder) return false;
    if (used.has(lake.targetSeat)) return false;
    used.add(lake.targetSeat);
    holder = lake.targetSeat;
  }
  return true;
}
