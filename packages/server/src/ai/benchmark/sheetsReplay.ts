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
import { BOT_GAME_CATEGORY } from '@avalon/shared/stats';
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
  /** Lake seats corrected or filled from the chain (repairLakeChain, 站長 2026-11-20); absent = none. */
  lakeAutoFixes?: LakeAutoFix[];
  assassinTargetSeat?: number;
  winner: Camp;
}

export type ReplayParseResult =
  | { ok: true; game: ReplayGame }
  | { ok: false; reason: string };

export type PaipuRow = Readonly<Record<string, string>>;

/** One lake seat set from the chain (game_db.py fix_lake_chain): `from` null = the record left it unknown. */
export interface LakeAutoFix {
  kind: 'lake_chain';
  /** 1-based lake number among the lakes kept. */
  lake: number;
  field: 'holder' | 'target';
  from: number | null;
  to: number;
}

/** A lake as read, before repairLakeChain: an unknown seat is null. */
export interface RawReplayLake {
  round: number;
  holderSeat: number | null;
  targetSeat: number | null;
  claim: Camp | null;
}

/** 百科AI 的暱稱（同 generate_cache.is_pedia_bot_name：NFKC、小寫後以「百科AI」或「百科機器人」開頭）。 */
const PEDIA_BOT_NAME_RE = /^百科(機器人|ai)/;

/**
 * 百科AI（補位機器人）參與的局：分類「百科AI」，或有座位是百科AI 的暱稱。Edward 2026-11-03「有百科AI的另外算」：
 * 不進任何機器人訓練、擬合、基準（rowsFromSheet 直接拿掉）。
 */
export function isBotPaipuRow(row: PaipuRow): boolean {
  if ((row['分類'] ?? '').trim() === BOT_GAME_CATEGORY) return true;
  return PLAYER_NAME_COLUMNS.some((c) => PEDIA_BOT_NAME_RE.test((row[c] ?? '').normalize('NFKC').trim().toLowerCase()));
}

/** `[header, ...rows]` sheet table → keyed rows（百科AI 局不算：isBotPaipuRow）。 */
export function rowsFromSheet(table: readonly (readonly string[])[]): PaipuRow[] {
  if (table.length === 0) return [];
  const header = table[0];
  return table.slice(1).map((row) => {
    const out: Record<string, string> = {};
    header.forEach((key, i) => { out[key] = row[i] ?? ''; });
    return out;
  }).filter((row) => !isBotPaipuRow(row));
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

  // 牌譜分頁的列（有流水號）照試算表的規則從 0家起湖；總庫轉來的列（bankSource，沒有流水號）已經在 game_db.py 修過。
  const repaired = repairLakeChain(lakes, (row['流水號'] ?? '').trim() ? FIRST_LAKE_HOLDER_SEAT : null);
  return {
    ok: true,
    game: {
      id: (row['流水號'] ?? '').trim(),
      playerCount,
      seatRoles,
      names,
      proposals,
      quests,
      lakes: repaired.lakes,
      lakeChainValid: isLakeChainValid(repaired.lakes, quests),
      ...(repaired.fixes.length > 0 ? { lakeAutoFixes: repaired.fixes } : {}),
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
export function isLakeChainValid(lakes: readonly ReplayLake[], quests: readonly ReplayQuest[]): boolean {
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

/**
 * 站長 2026-11-20「湖中鏈的修正 應該是 你可以直接判斷 接湖的必為下一湖」：the seat lake k checks holds lake k+1.
 * Same rule as game_db.py fix_lake_chain (keep the two in step):
 *   1. an unknown seat is filled from the chain (a holder from the previous target, the first lake's from
 *      `firstHolder`; a target from the next holder); a lake that cannot be filled is left out;
 *   2. each broken link (holder k+1 ≠ target k; first holder ≠ `firstHolder`) is fixed on one side, the holder by
 *      default or the target; of every combination the one with the fewest other rule breaks (lakeing yourself or
 *      a seat that already held the lake), then the fewest target edits, wins; a tie changes nothing.
 * Only lakes of consecutive rounds are linked. `firstHolder` null = the table's start is not known.
 */
export function repairLakeChain(
  raw: readonly RawReplayLake[],
  firstHolder: number | null,
): { lakes: ReplayLake[]; fixes: LakeAutoFix[] } {
  const out = [...raw].sort((a, b) => a.round - b.round).map((l) => ({ ...l }));
  let fixes: LakeAutoFix[] = [];
  const next = (a: { round: number }, b: { round: number }): boolean => b.round === a.round + 1;
  out.forEach((l, k) => {
    const n = out[k + 1];
    if (l.targetSeat === null && n && next(l, n) && n.holderSeat !== null) {
      l.targetSeat = n.holderSeat;
      fixes.push({ kind: 'lake_chain', lake: k + 1, field: 'target', from: null, to: n.holderSeat });
    }
  });
  out.forEach((l, k) => {
    const prev = k > 0 ? (next(out[k - 1], l) ? out[k - 1].targetSeat : null) : (l.round === 2 ? firstHolder : null);
    if (l.holderSeat === null && prev !== null) {
      l.holderSeat = prev;
      fixes.push({ kind: 'lake_chain', lake: k + 1, field: 'holder', from: null, to: prev });
    }
  });
  const shownIdx = out.map((l, k) => (l.holderSeat !== null && l.targetSeat !== null ? k : -1)).filter((k) => k >= 0);
  const number = new Map(shownIdx.map((k, n) => [k + 1, n + 1]));
  fixes = fixes.filter((f) => number.has(f.lake)).map((f) => ({ ...f, lake: number.get(f.lake)! }));
  const lakes: ReplayLake[] = shownIdx.map((k) => ({ ...out[k], holderSeat: out[k].holderSeat!, targetSeat: out[k].targetSeat! }));

  const holders = lakes.map((l) => l.holderSeat);
  const targets = lakes.map((l) => l.targetSeat);
  const links: number[] = [];
  if (lakes.length > 0 && firstHolder !== null && lakes[0].round === 2 && holders[0] !== firstHolder) links.push(0);
  for (let k = 1; k < lakes.length; k++) {
    if (next(lakes[k - 1], lakes[k]) && holders[k] !== targets[k - 1]) links.push(k);
  }
  if (links.length === 0) return { lakes, fixes };

  type Edit = { field: 'holder' | 'target'; k: number; from: number; to: number };
  const scored: { score: [number, number]; edits: Edit[] }[] = [];
  const total = 2 ** links.length;
  for (let mask = 0; mask < total; mask++) {
    if (links[0] === 0 && (mask & 1)) continue; // the first holder has no target before it: holder only
    const h = [...holders];
    const t = [...targets];
    const edits: Edit[] = [];
    let targetEdits = 0;
    links.forEach((k, i) => {
      if (mask & (1 << i)) {
        edits.push({ field: 'target', k: k - 1, from: targets[k - 1], to: holders[k] });
        t[k - 1] = holders[k];
        targetEdits++;
      } else {
        const to = k === 0 ? (firstHolder as number) : targets[k - 1];
        edits.push({ field: 'holder', k, from: holders[k], to });
        h[k] = to;
      }
    });
    const held = new Set<number>(firstHolder !== null ? [firstHolder] : []);
    let violations = 0;
    h.forEach((holder, i) => { held.add(holder); if (held.has(t[i])) violations++; });
    scored.push({ score: [violations, targetEdits], edits });
  }
  scored.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1]);
  if (scored.length > 1 && scored[0].score[0] === scored[1].score[0] && scored[0].score[1] === scored[1].score[1]) {
    return { lakes, fixes }; // ambiguous: nothing changed, the chain stays invalid
  }
  for (const e of scored[0].edits) {
    if (e.field === 'holder') lakes[e.k].holderSeat = e.to; else lakes[e.k].targetSeat = e.to;
    fixes.push({ kind: 'lake_chain', lake: e.k + 1, field: e.field, from: e.from, to: e.to });
  }
  fixes.sort((a, b) => a.lake - b.lake || a.field.localeCompare(b.field));
  return { lakes, fixes };
}
