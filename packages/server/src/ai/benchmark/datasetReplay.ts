/**
 * games_cache.json（每局資料集 v3）→ 可重播的 10 人局（人類 PR 量尺，2026-11-03）。
 *
 * 和 `sheetsReplay.parseReplayGame` 一樣嚴格：任何一處對不起來（隊伍人數、提議次數、任務牌數、結果）就整局跳過，
 * 因為少一個提議會讓後面的隊長輪替全部錯位。和牌譜解析的差別：
 *   - 票是資料集的「贊成座位」原樣（第 5 次強制派隊為空字串）；
 *   - 隊長：牌譜局（src 0）照牌譜慣例從 1 號位逐次輪替；Discord 局（src 1）用 `deriveLeaderSeats`
 *     （隊長幾乎都在自己的隊上，找覆蓋最多的起點），推不出來就跳過；
 *   - 名字不帶進來（公開 repo）：`names` 是空字串，座位強度另外放在 `prs`／`prov`（lineup：開打前、
 *     時間相對的 PR；暫定 = 生涯未滿 30 場或沒寫名字）。
 */

import { AVALON_CONFIG, type Role } from '@avalon/shared';
import {
  EVIL_ROLES,
  REPLAY_PLAYER_COUNT,
  ROLE_CODE_ORDER,
  isLakeChainValid,
  type Camp,
  type ReplayGame,
  type ReplayLake,
  type ReplayProposal,
  type ReplayQuest,
} from './sheetsReplay';

/** 資料集一局的位置陣列（只用到的欄位；順序見 shared/stats/dataset.ts 的 GAMES_DATASET_FIELDS）。 */
export type DatasetTuple = readonly unknown[];

export interface DatasetHeader {
  fields: readonly string[];
  vocab: { outcome: readonly string[]; noteTags: readonly string[] };
}

export interface DatasetReplayGame {
  game: ReplayGame;
  /** 0 = 牌譜、1 = Discord。 */
  source: number;
  date: string;
  /** 座位 1..10 開打前的 PR（0–100）；沒有 lineup = null。 */
  prs: number[] | null;
  /** 暫定座位（PR 最高 50、不進量尺的分組）。 */
  prov: boolean[] | null;
  /** 桌上 S（10 個座位 PR 的平均）。 */
  s: number | null;
  noteTags: string[];
}

export type DatasetReplayResult =
  | { ok: true; value: DatasetReplayGame }
  | { ok: false; reason: string };

const LEADER_MIN_SHARE = 0.8;
const LEADER_MIN_MARGIN = 3;

/** 座位字元 → 1..10（"0" = 10 號位）；不是數字 = null。 */
export function seatOfChar(ch: string): number | null {
  if (ch === '0') return 10;
  if (ch >= '1' && ch <= '9') return ch.charCodeAt(0) - 48;
  return null;
}

function seatsOf(team: string): number[] | null {
  const out: number[] = [];
  for (const ch of team) {
    const s = seatOfChar(ch);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/**
 * 每次提議的隊長（跨輪逐次輪替）：找讓「隊長在自己隊上」次數最多的起點，同 shared/stats/mistakes.deriveLeaderSeats；
 * 不夠明確（覆蓋 < 80% 或領先第二名 < 3 次）= null。回傳隊長座位（1..10）。
 */
export function deriveLeaderStart(teams: readonly number[][]): number | null {
  if (teams.length === 0) return null;
  const cover = Array.from({ length: 10 }, (_, start) =>
    teams.filter((team, k) => team.includes(((start + k) % 10) + 1)).length);
  const best = Math.max(...cover);
  const start = cover.indexOf(best);
  const second = Math.max(...cover.filter((_, i) => i !== start));
  if (best < teams.length * LEADER_MIN_SHARE || best - second < LEADER_MIN_MARGIN) return null;
  return start + 1;
}

function fail(reason: string): DatasetReplayResult {
  return { ok: false, reason };
}

/** 資料集一局 → 可重播的局，或跳過的原因。 */
export function replayGameFromDataset(row: DatasetTuple, header: DatasetHeader): DatasetReplayResult {
  const idx = (name: string): number => header.fields.indexOf(name);
  const get = <T>(name: string): T => row[idx(name)] as T;
  const playerCount = REPLAY_PLAYER_COUNT;
  const config = AVALON_CONFIG[playerCount];

  const code = get<string>('config');
  if (!/^[0-9]{6}$/.test(code) || new Set(code).size !== 6) return fail('bad role code');
  const seatRoles: Role[] = new Array<Role>(playerCount).fill('loyal');
  for (let i = 0; i < 6; i++) seatRoles[(seatOfChar(code[i]) as number) - 1] = ROLE_CODE_ORDER[i];

  const outcome = header.vocab.outcome[get<number>('outcome')];
  if (outcome !== '三紅' && outcome !== '三藍死' && outcome !== '三藍活') return fail('no outcome');

  const votes = get<Array<[number, number, string, string]>>('votes') ?? [];
  if (votes.length === 0) return fail('no proposals');
  const missionCells = (get<string>('missions') ?? '').split('|');

  // 提議依回合分組，回合內 attempt 必須 1..n 連續。
  const proposals: ReplayProposal[] = [];
  const teams: number[][] = [];
  for (const [round, attempt, teamText, approvedText] of votes) {
    const team = seatsOf(teamText);
    const approved = seatsOf(approvedText);
    if (!team || !approved) return fail('non-digit seat');
    if (round < 1 || round > 5) return fail('bad round');
    if (attempt < 1 || attempt > 5) return fail('bad attempt');
    if (team.length !== config.questTeams[round - 1]) return fail('team size mismatch');
    if (new Set(team).size !== team.length) return fail('duplicate seat in team');
    const prev = proposals[proposals.length - 1];
    if (prev ? !(prev.round === round ? attempt === prev.attempt + 1 : round === prev.round + 1 && attempt === 1)
      : !(round === 1 && attempt === 1)) return fail('proposal order');
    const forced = attempt === 5;
    const approveSet = new Set(approved);
    const teamSet = new Set(team);
    // 強制派隊沒有投票：和牌譜解析一樣存「隊內白、隊外黑」字面值（觀察重建時一律當全員贊成）。
    const voteArr: boolean[] = [];
    for (let seat = 1; seat <= playerCount; seat++) voteArr.push(forced ? teamSet.has(seat) : approveSet.has(seat));
    proposals.push({
      round,
      attempt,
      globalIndex: proposals.length,
      leaderSeat: 0,
      teamSeats: team,
      plusSeats: forced ? [] : approved.filter((s) => !teamSet.has(s)),
      minusSeats: forced ? [] : team.filter((s) => !approveSet.has(s)),
      votes: voteArr,
      approveCount: forced ? team.length : approveSet.size,
      forced,
      wentOnMission: false,
      votesReliable: false,
    });
    teams.push(team);
  }

  const source = get<number>('src');
  const start = source === 0 ? 1 : deriveLeaderStart(teams);
  if (start === null) return fail('leader rotation unknown');
  for (const p of proposals) p.leaderSeat = ((start - 1 + p.globalIndex) % playerCount) + 1;

  // 任務：每一回合的最後一次提議出任務。
  const quests: ReplayQuest[] = [];
  let fails = 0;
  let successes = 0;
  const lastRound = proposals[proposals.length - 1].round;
  for (let round = 1; round <= lastRound; round++) {
    const roundProps = proposals.filter((p) => p.round === round);
    const cell = missionCells[round - 1] ?? '';
    if (!/^[ox]+$/.test(cell)) return fail('missing mission cards');
    const last = roundProps[roundProps.length - 1];
    if (cell.length !== last.teamSeats.length) return fail('quest card count != team size');
    const failCount = [...cell].filter((c) => c === 'x').length;
    const evilOnTeam = last.teamSeats.filter((s) => EVIL_ROLES.has(seatRoles[s - 1])).length;
    if (failCount > evilOnTeam) return fail('more fail cards than evil on team');
    last.wentOnMission = true;
    for (const p of roundProps) {
      p.votesReliable = !p.forced && (p.wentOnMission ? p.approveCount * 2 > playerCount : p.approveCount * 2 <= playerCount);
    }
    const failed = failCount >= config.questFailsRequired[round - 1];
    quests.push({ round, teamSeats: [...last.teamSeats], successCount: cell.length - failCount, failCount, failed });
    if (failed) fails++; else successes++;
    if ((fails >= 3 || successes >= 3) && round !== lastRound) return fail('proposals after game end');
  }
  if (fails < 3 && successes < 3) return fail('incomplete game');
  if ((fails >= 3) !== (outcome === '三紅')) return fail('outcome mismatch');

  // 湖：lakes 的座位對決定第幾個湖（第 i 對在第 i+2 局之後，"--" = 那一局沒有湖）；宣告從 claims（持湖、目標、
  // x 紅／o 藍／其他）用持湖＋目標對上。沒有 lakes 只有 claims 時照順序從第 2 局排。
  const lakes: ReplayLake[] = [];
  const claimsText = get<string>('claims') ?? '';
  const lakesText = get<string>('lakes') ?? '';
  const claimOf = new Map<string, Camp | null>();
  for (let i = 0; i + 2 < claimsText.length; i += 3) {
    const c = claimsText[i + 2];
    claimOf.set(claimsText.slice(i, i + 2), c === 'o' ? 'good' : c === 'x' ? 'evil' : null);
  }
  const pairs: Array<[string, number]> = [];
  if (lakesText.length >= 2) {
    for (let i = 0; i + 1 < lakesText.length; i += 2) {
      const pair = lakesText.slice(i, i + 2);
      if (pair !== '--') pairs.push([pair, i / 2 + 2]);
    }
  } else {
    [...claimOf.keys()].forEach((pair, i) => pairs.push([pair, i + 2]));
  }
  for (const [pair, round] of pairs) {
    const h = seatOfChar(pair[0]);
    const t = seatOfChar(pair[1]);
    if (h === null || t === null) return fail('bad lake seat');
    lakes.push({ round, holderSeat: h, targetSeat: t, claim: claimOf.get(pair) ?? null });
  }

  let winner: Camp;
  let assassinTargetSeat: number | undefined;
  if (outcome === '三紅') {
    winner = 'evil';
  } else {
    winner = outcome === '三藍死' ? 'evil' : 'good';
    const kill = get<string>('kill') ?? '';
    const target = kill.length === 1 ? seatOfChar(kill) : null;
    if (target !== null) {
      if (EVIL_ROLES.has(seatRoles[target - 1])) return fail('assassination target is evil');
      const hit = seatRoles[target - 1] === 'merlin';
      if (hit !== (outcome === '三藍死')) return fail('kill / outcome mismatch');
      assassinTargetSeat = target;
    }
  }

  const lineup = get<unknown[] | undefined>('lineup');
  let prs: number[] | null = null;
  let prov: boolean[] | null = null;
  let s: number | null = null;
  if (Array.isArray(lineup) && (lineup.length === 4 || lineup.length === 5)) {
    prs = [...(lineup[2] as number[])];
    const mask = lineup[3] as number;
    prov = prs.map((_, i) => ((mask >> i) & 1) === 1);
    s = (lineup[1] as number) / 10;
  }

  const noteIdx = get<number[]>('note') ?? [];
  return {
    ok: true,
    value: {
      game: {
        id: String(get<string>('id')),
        playerCount,
        seatRoles,
        names: new Array<string>(playerCount).fill(''),
        proposals,
        quests,
        lakes,
        lakeChainValid: isLakeChainValid(lakes, quests),
        assassinTargetSeat,
        winner,
      },
      source,
      date: get<string>('date') ?? '',
      prs,
      prov,
      s,
      noteTags: noteIdx.map((i) => header.vocab.noteTags[i]),
    },
  };
}

/** 整個資料集 → 可重播的局＋跳過原因統計。 */
export function replayGamesFromDataset(dataset: DatasetHeader & { games: readonly DatasetTuple[] }): {
  games: DatasetReplayGame[];
  skipped: Record<string, number>;
} {
  const games: DatasetReplayGame[] = [];
  const skipped: Record<string, number> = {};
  for (const row of dataset.games) {
    const res = replayGameFromDataset(row, dataset);
    if (res.ok) games.push(res.value);
    else skipped[res.reason] = (skipped[res.reason] ?? 0) + 1;
  }
  return { games, skipped };
}
