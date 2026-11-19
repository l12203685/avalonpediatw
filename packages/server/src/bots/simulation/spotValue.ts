/**
 * 模擬瓦（2026-11-19）— 自動選 spot：什麼都沒指定的 /模擬 抽一局，挑這局最值得想的地方出題。
 *
 * Edward 2026-11-19：「以後/模擬 沒指定情境(spot)的話 就抽選一局 你應該要可以判斷出 該局最有價值最值得思考出題的幾個 spot
 * (是1-5? 2-5? 3-5? 第四局? 第五局? 還是派西維爾 在兩~三局任務結果+湖中宣告後找五好? 還是刺殺階段紅方開牌找梅林?)」
 *
 * 一局的 spot（enumerateSpots；篩選跟局面池同一套，見 scenario.midDecision）：
 *   1-5、2-5（第 1 局失敗，或 2-1～2-4 至少兩人不是派三加一）、3-5（第 2 局失敗）、
 *   第4局忠臣（第 4 局忠臣當隊長的每一次）、第5局（第 5 局的每一次）、
 *   派西（第 3、4 局派西維爾當隊長，前面已經有 2～3 局任務結果和至少一個湖的宣告）、刺殺（三藍、刺客視角）。
 *
 * 分數（scoreSpot，每一項 0～1，越高越值得想）：
 *   總分 = 0.15 × 資訊量 + 0.35 × 難度 + 0.15 × 後果 + 0.35 × 真人跟百科AI 不一樣
 *   - 資訊量 = (已完成任務數 + 有宣告的湖數 + 已看到的派票數 ÷ 4) ÷ 5，最多 1；
 *   - 難度：忠臣、派西維爾 = 1 − 百科AI 信念裡最安全的那一隊（含自己）的全好機率（第 4 局也看全好＝找五好）；
 *           刺殺 = 1 − 百科AI 刺殺排序（分數換成機率）裡最高的梅林機率；梅林、紅方視角知道紅是誰（找好人不難；要想的是怎麼藏，這個分數量不到），給偏低的 0.3；
 *   - 後果：刺殺、第 5 局 = 1；其他 = 這一局的任務會不會決定勝負（任一方已經兩局）1 : 0.5，
 *           不是強制出發（可能被否決）再 × 0.7；
 *   - 真人跟百科AI 不一樣：忠臣、派西維爾 = 真人那一隊的全好機率比最安全的隊低多少（相對差，0～1）；
 *           刺殺 = 真人刺的那一家的梅林機率比最高的低多少（相對差）；梅林、紅方 = 0.3。
 * 「百科AI」用的是正式參數（DEFAULT_AGENT_TUNING）的貝氏信念（跟 /區間、Threads 百科AI 答案的 top 同一套），不跑前向推理，
 * 一局幾毫秒；隨機數固定種子，同一局結果一樣。同分照列舉順序。開題從最高分開始，另外附同一局其他題型最高的 1～2 題的題號。
 */

import type { Role } from '@avalon/shared';
import { combinations } from '../../ai/worlds';
import { withSeededRandom } from '../../ai/benchmark/agreement';
import { seatId, seatOfId } from '../../ai/benchmark/replayObservation';
import { DEFAULT_AGENT_TUNING } from '../../ai/AgentTuning';
import { bayesOptionsOf, bayesWorlds } from '../../ai/belief/BayesBelief';
import { decisionObservation, defaultBot } from './aiRead';
import {
  TEAM_SIZES,
  assassinSeat,
  exerciseIdOf,
  midDecision,
  round4LoyalDecisions,
  selectExercise,
  type SelectRequest,
  type SelectResult,
  type SimGame,
} from './scenario';

export type SpotKind = '1-5' | '2-5' | '3-5' | 'round4' | 'round5' | 'percival' | 'assassin';

/** 模擬瓦能出的 spot 題型（回覆、說明用）。 */
export const SPOT_LABEL: Readonly<Record<SpotKind, string>> = {
  '1-5': '1-5',
  '2-5': '2-5',
  '3-5': '3-5',
  round4: '第4局忠臣',
  round5: '第5局',
  percival: '派西',
  assassin: '刺殺',
};

export interface Spot {
  kind: SpotKind;
  /** proposals[] 的索引；刺殺是 null。 */
  proposal: number | null;
  /** 視角：隊長（刺殺＝刺客）。 */
  seat: number;
  exerciseId: string;
}

export interface SpotScore {
  info: number;
  difficulty: number;
  stakes: number;
  divergence: number;
  total: number;
}

export interface RankedSpot {
  spot: Spot;
  score: SpotScore;
}

export const SPOT_WEIGHTS = { info: 0.15, difficulty: 0.35, stakes: 0.15, divergence: 0.35 } as const;

/** 不是在找好人的視角（梅林、紅方）的難度、分歧：知道紅是誰，給偏低的固定值。 */
export const SPOT_NEUTRAL = 0.3;

function proposalSpot(game: SimGame, kind: SpotKind, proposal: number): Spot {
  const p = game.proposals[proposal];
  return { kind, proposal, seat: p.leaderSeat, exerciseId: exerciseIdOf(game.id, p.leaderSeat, { round: p.round, attempt: p.attempt }) };
}

/** 派西維爾 spot：第 3、4 局（前面 2～3 局任務結果）派西維爾當隊長，之前至少有一個湖的宣告。 */
function isPercivalSpot(game: SimGame, proposal: number): boolean {
  const p = game.proposals[proposal];
  if (p.round < 3 || p.round > 4 || game.seatRoles[p.leaderSeat - 1] !== 'percival') return false;
  return game.lakes.some((l) => l.round < p.round && l.claim !== null);
}

/** 這一局能出的 spot（照列舉順序：1-5、2-5、3-5、第4局忠臣、派西、第5局、刺殺；同一題只列一次）。 */
export function enumerateSpots(game: SimGame): Spot[] {
  const out: Spot[] = [];
  const kinds: Array<[SpotKind, number]> = [];
  ([1, 2, 3] as const).forEach((round) => {
    const d = midDecision(game, round);
    if (d !== null) kinds.push([`${round}-5` as SpotKind, d]);
  });
  for (const d of round4LoyalDecisions(game)) kinds.push(['round4', d]);
  for (const p of game.proposals) if (isPercivalSpot(game, p.globalIndex)) kinds.push(['percival', p.globalIndex]);
  for (const p of game.proposals) if (p.round === 5) kinds.push(['round5', p.globalIndex]);
  const seen = new Set<string>();
  for (const [kind, d] of kinds) {
    const s = proposalSpot(game, kind, d);
    if (seen.has(s.exerciseId)) continue;
    seen.add(s.exerciseId);
    out.push(s);
  }
  const a = assassinSeat(game);
  if (a !== null) out.push({ kind: 'assassin', proposal: null, seat: a, exerciseId: exerciseIdOf(game.id, a, undefined, true) });
  return out;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** 資訊量：決定當下看得到的任務、有宣告的湖、派票。 */
export function spotInfo(game: SimGame, spot: Spot): number {
  const round = spot.proposal === null ? 6 : game.proposals[spot.proposal].round;
  const seen = spot.proposal === null ? game.proposals.length : spot.proposal;
  const quests = game.quests.filter((q) => q.round < round).length;
  const lakes = game.lakes.filter((l) => l.round < round && l.claim !== null).length;
  return clamp01((quests + lakes + seen / 4) / 5);
}

/** 後果：這一題的選擇會不會左右結果。 */
export function spotStakes(game: SimGame, spot: Spot): number {
  if (spot.proposal === null) return 1;
  const p = game.proposals[spot.proposal];
  if (p.round === 5) return 1;
  const before = game.quests.filter((q) => q.round < p.round);
  const fails = before.filter((q) => q.failed).length;
  const decisive = fails === 2 || before.length - fails === 2;
  return (decisive ? 1 : 0.5) * (p.forced || p.attempt === 5 ? 1 : 0.7);
}

/** 找好人的視角：忠臣、派西維爾（梅林、紅方知道紅是誰，難度不從「找全好的隊」來）。 */
function seeksGood(role: Role): boolean {
  return role === 'loyal' || role === 'percival';
}

/**
 * 派隊題：百科AI 信念下最安全的隊（含自己）和真人那一隊「全是好人」的機率。第 4 局也看全好（找五好）：
 * 「不會出 2 張失敗」在第 4 局幾乎都很高，分不出難易。
 */
function teamRead(game: SimGame, spot: Spot & { proposal: number }): { best: number; real: number } | null {
  const p = game.proposals[spot.proposal];
  const obs = decisionObservation(game, spot.seat, { kind: 'team_select', proposal: spot.proposal });
  const post = bayesWorlds(obs, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING }));
  const total = post.wts.reduce((a, b) => a + b, 0);
  if (post.worlds.length === 0 || total <= 0) return null;
  const safe = (mask: number): number => {
    let s = 0;
    post.worlds.forEach((w, i) => { if ((w & mask) === 0) s += post.wts[i]; });
    return s / total;
  };
  const maskOfSeats = (seats: readonly number[]): number => seats.reduce((m, s) => m | post.bitOf(seatId(s)), 0);
  const size = TEAM_SIZES[p.round - 1];
  const others = obs.allPlayerIds.filter((id) => seatOfId(id) !== spot.seat).map((id) => seatOfId(id));
  const self = post.bitOf(seatId(spot.seat));
  let best = 0;
  for (const m of combinations(others.map((_, k) => k), size - 1)) {
    const seats = others.filter((_, k) => (m & (1 << k)) !== 0);
    best = Math.max(best, safe(self | maskOfSeats(seats)));
  }
  return { best, real: safe(maskOfSeats(p.teamSeats)) };
}

/** 刺殺題：百科AI 刺殺排序（分數換成機率）的最高梅林機率、真人刺的那一家的機率。 */
function killRead(game: SimGame, seat: number): { top: number; real: number } | null {
  const obs = decisionObservation(game, seat, { kind: 'assassination' });
  const readout = defaultBot(game, seat).base.assassinationReadout(obs);
  if (!readout || readout.candidates.length === 0) return null;
  const raw = readout.candidates.map((id) => readout.scores.get(id) ?? 0);
  const max = Math.max(...raw);
  const exps = raw.map((x) => Math.exp(x - max));
  const z = exps.reduce((a, b) => a + b, 0);
  const realAt = readout.candidates.findIndex((id) => seatOfId(id) === game.assassinTargetSeat);
  return { top: Math.max(...exps) / z, real: realAt < 0 ? 0 : exps[realAt] / z };
}

/** 一個 spot 的分數（見檔頭）。 */
export function scoreSpot(game: SimGame, spot: Spot): SpotScore {
  const info = spotInfo(game, spot);
  const stakes = spotStakes(game, spot);
  let difficulty = SPOT_NEUTRAL;
  let divergence = SPOT_NEUTRAL;
  if (spot.proposal === null) {
    const k = killRead(game, spot.seat);
    if (k) {
      difficulty = 1 - k.top;
      divergence = k.top > 0 ? clamp01((k.top - k.real) / k.top) : 0;
    }
  } else if (seeksGood(game.seatRoles[spot.seat - 1])) {
    const t = teamRead(game, spot as Spot & { proposal: number });
    if (t) {
      difficulty = 1 - t.best;
      divergence = t.best > 0 ? clamp01((t.best - t.real) / t.best) : 0;
    }
  }
  const w = SPOT_WEIGHTS;
  const total = w.info * info + w.difficulty * difficulty + w.stakes * stakes + w.divergence * divergence;
  return { info: r3(info), difficulty: r3(difficulty), stakes: r3(stakes), divergence: r3(divergence), total: r3(total) };
}

/** 這一局所有 spot，分數高的在前（同分照列舉順序）。固定種子：同一局每次一樣。 */
export function rankSpots(game: SimGame): RankedSpot[] {
  return withSeededRandom(`${game.id}|spots`, () => {
    const scored = enumerateSpots(game).map((spot, i) => ({ spot, score: scoreSpot(game, spot), i }));
    scored.sort((a, b) => b.score.total - a.score.total || a.i - b.i);
    return scored.map(({ spot, score }) => ({ spot, score }));
  });
}

/** 每個題型只留最高分的那一個（照分數排）：開題和「這局也值得想」用，讓推薦的題型不重複。 */
export function bestPerKind(ranked: readonly RankedSpot[]): RankedSpot[] {
  const seen = new Set<SpotKind>();
  return ranked.filter((r) => (seen.has(r.spot.kind) ? false : (seen.add(r.spot.kind), true)));
}

/** 「這局也值得想」附幾題。 */
export const SPOT_ALSO_WORTH = 2;

type SelectBank = Parameters<typeof selectExercise>[0];

/** 什麼都沒指定的 /模擬（沒有角色、座位、局面、題號、刺殺、今天）。 */
export function isBareStart(req: SelectRequest): boolean {
  return !req.role && req.seat === undefined && !req.exerciseId && req.midRound === undefined && !req.special;
}

/** 選局時最多抽幾局（抽到沒有任何 spot 的局就再抽）。 */
const SPOT_DRAWS = 8;

/**
 * 抽一局（有網站牌譜連結的優先），從分數最高的 spot 開始；`alsoWorth` = 其他題型最高的 1～2 題。
 * 抽 SPOT_DRAWS 次都沒有 spot 就 null（呼叫端改用舊的選法）。
 */
export function selectValueSpot(bank: SelectBank, rng: () => number): SelectResult | null {
  const all = bank.games.map((_, i) => i);
  const linked = bank.records && bank.records.size > 0 ? all.filter((i) => bank.records?.has(i)) : [];
  const list = linked.length > 0 ? linked : all;
  if (list.length === 0) return null;
  for (let n = 0; n < SPOT_DRAWS; n++) {
    const gi = list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
    const game = bank.games[gi];
    const ranked = bestPerKind(rankSpots(game));
    if (ranked.length === 0) continue;
    const top = ranked[0].spot;
    const alsoWorth = ranked.slice(1, 1 + SPOT_ALSO_WORTH).map((r) => ({ exerciseId: r.spot.exerciseId, label: SPOT_LABEL[r.spot.kind] }));
    const extra = alsoWorth.length > 0 ? { alsoWorth } : {};
    if (top.proposal === null) {
      return { ok: true, game: gi, seat: top.seat, decision: game.proposals.length - 1, assassin: true, ...extra };
    }
    const p = game.proposals[top.proposal];
    return { ok: true, game: gi, seat: top.seat, decision: top.proposal, stage: { round: p.round, attempt: p.attempt }, ...extra };
  }
  return null;
}

/** 開題：什麼都沒指定 → 自動選 spot；其他（指定角色、座位、局面、題號、刺殺、今天）照舊 selectExercise。 */
export function selectStart(bank: SelectBank, req: SelectRequest, rng: () => number): SelectResult {
  if (isBareStart(req)) {
    const r = selectValueSpot(bank, rng);
    if (r) return r;
  }
  return selectExercise(bank, req, rng);
}
