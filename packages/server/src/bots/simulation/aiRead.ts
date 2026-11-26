/**
 * 模擬瓦 /區間（不帶內容）：百科AI 怎麼讀這個局面（Edward 2026-11-17：「反而比較像是想看到從目前派票 百科AI可以讀出來的
 * 區間 或是 百科AI會選擇哪些組合」）。
 *
 * 用的是正式機器人（ForwardAgent + 目前的預設參數），站在題目那一家、題目那一刻（buildReplayObservation 只放那一家當下
 * 看得到的資訊）：
 *   - 紅機率：bayesRedShare（機器人的信念，含派票、投票、任務、湖的讀法）。
 *   - 最可能的紅方：bayesWorlds 權重最高的幾個 4 紅組合。
 *   - 百科AI 會派：機器人這一刻真的會派的隊；藍方另列「全好機率」最高的其他隊（第 4 局看「不會出 2 張失敗」）。
 * 純函式（RNG 用固定種子），同一題每次結果一樣。
 */
import type { PlayerObservation } from '../../ai/types';
import { combinations } from '../../ai/worlds';
import { withSeededRandom } from '../../ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId, type DecisionPoint } from '../../ai/benchmark/replayObservation';
import type { ReplayGame } from '../../ai/benchmark/sheetsReplay';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../../ai/AgentTuning';
import { HeuristicAgent } from '../../ai/HeuristicAgent';
import { tuningForOpponent, type OpponentType } from '../../ai/humanProfile';
import { ForwardAgent } from '../../ai/forward/ForwardAgent';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, bayesTeamRedsBelow, bayesWorlds } from '../../ai/belief/BayesBelief';
import type { SimGame } from './scenario';

/** 模擬瓦、Threads 百科AI 作答讀真人局時用的策略層（第 56b 回合 C）。 */
export const SIM_OPPONENT: OpponentType = 'avgHuman';

export interface AiTeamOption {
  seats: number[];
  /** 全好（第 4 局：不會出 2 張失敗）的機率；紅方視角為 null。 */
  safe: number | null;
  /** 這是機器人真的會派的隊。 */
  chosen: boolean;
}

export interface AiReading {
  /** 每一家的紅機率（座位 1–10，自己也列）。 */
  redShare: { seat: number; p: number }[];
  /** 權重最高的紅方組合（座位遞增）。 */
  topWorlds: { seats: number[]; p: number }[];
  /** 機器人真的會派的隊在第一個；藍方再列兩個全好機率最高的其他隊。 */
  teams: AiTeamOption[];
  /** 第 4 局（10 人要 2 張失敗）：safe 是「不會出 2 張失敗」。 */
  twoFails: boolean;
  /** 題目那一家是不是藍方。 */
  good: boolean;
}

export function asReplay(game: SimGame): ReplayGame {
  return { ...game, names: Array.from({ length: game.playerCount }, () => '') };
}

/** 大廳的角色只給「有哪些角色」（照固定順序）：buildReplayObservation 照座位順序給，等於洩漏誰是什麼角色。 */
export function hideLobbyOrder(o: PlayerObservation): PlayerObservation {
  return { ...o, lobbyRoles: o.lobbyRoles ? [...o.lobbyRoles].sort() : o.lobbyRoles };
}

/** 題目那一家在 `point` 當下的觀察（只有那一家當下看得到的資訊；大廳角色不照座位）。 */
export function decisionObservation(game: SimGame, seat: number, point: DecisionPoint): PlayerObservation {
  return hideLobbyOrder(buildReplayObservation(asReplay(game), seat, point));
}

/**
 * 正式機器人（ForwardAgent 包 HeuristicAgent，參數＝目前的預設 DEFAULT_AGENT_TUNING，整份傳進去所以環境變數蓋不掉），
 * 已經用這一局第一次派票的觀察開局（onGameStart）。
 * 第 56b 回合 C（站長 2026-11-20「跟真人打的百科AI 用真人牌局當標準」）：題目都是真人局，所以用真人桌的策略層（`humanProfile.ts`）；
 * 題庫沒有桌上強度 S，一律一般真人桌（`avgHuman` = 預設＋真人桌的讀法）。
 */
export function defaultBot(game: SimGame, seat: number): { agent: ForwardAgent; base: HeuristicAgent; tuning: AgentTuning } {
  const id = seatId(seat);
  const tuning: AgentTuning = tuningForOpponent(SIM_OPPONENT, DEFAULT_AGENT_TUNING);
  const base = new HeuristicAgent(id, undefined, undefined, tuning);
  const agent = new ForwardAgent(id, base);
  agent.onGameStart(decisionObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  return { agent, base, tuning };
}

function sortedSeats(ids: readonly string[]): number[] {
  return ids.map(seatOfId).sort((a, b) => a - b);
}

/**
 * 題目那一家（`seat`）在第 `proposalIndex` 次提議當隊長時，百科AI 的讀法與派法。
 * 沒有世界（紀錄矛盾）時紅機率照機器人回傳（未知座位 50%），topWorlds 為空。
 */
export function aiReading(game: SimGame, seat: number, proposalIndex: number): AiReading {
  return withSeededRandom(`${game.id}|${seat}|read-${proposalIndex}`, () => readNow(game, seat, proposalIndex));
}

function readNow(game: SimGame, seat: number, proposalIndex: number): AiReading {
  const obs: PlayerObservation = decisionObservation(game, seat, { kind: 'team_select', proposal: proposalIndex });
  const id = seatId(seat);
  const { agent, tuning } = defaultBot(game, seat);
  const action = withSeededRandom(`${game.id}|${seat}|team-${proposalIndex}`, () => agent.act(obs));
  const chosenIds = action.type === 'team_select' ? action.teamIds : [];

  const opts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, opts);
  const redShare = obs.allPlayerIds.map((pid) => ({ seat: seatOfId(pid), p: share.get(pid) ?? 0 })).sort((a, b) => a.seat - b.seat);

  const post = bayesWorlds(obs, opts);
  const total = post.wts.reduce((a, b) => a + b, 0);
  const bitSeat = obs.allPlayerIds.map((pid) => ({ seat: seatOfId(pid), bit: post.bitOf(pid) }));
  const topWorlds = total > 0
    ? post.worlds
      .map((w, i) => ({ seats: bitSeat.filter((b) => (w & b.bit) !== 0).map((b) => b.seat).sort((a, b) => a - b), p: post.wts[i] / total }))
      .sort((a, b) => b.p - a.p || a.seats.join('').localeCompare(b.seats.join('')))
      .slice(0, 3)
    : [];

  const good = obs.myTeam === 'good';
  const size = chosenIds.length || 0;
  const twoFails = obs.playerCount >= 7 && obs.currentRound === 4;
  const safeOf = (ids: readonly string[]): number | null => {
    if (!good) return null;
    return twoFails ? bayesTeamRedsBelow(obs, ids, 2, opts) : bayesTeamClean(obs, ids, opts);
  };
  const teams: AiTeamOption[] = [];
  if (chosenIds.length) teams.push({ seats: sortedSeats(chosenIds), safe: safeOf(chosenIds), chosen: true });
  if (good && size > 0) {
    const others = obs.allPlayerIds.filter((pid) => pid !== id);
    const chosenKey = sortedSeats(chosenIds).join(',');
    const ranked = combinations(others.map((_, k) => k), size - 1)
      .map((mask) => {
        const picked = others.filter((_, k) => (mask & (1 << k)) !== 0);
        const ids = [id, ...picked];
        return { ids, key: sortedSeats(ids).join(','), safe: safeOf(ids) ?? 0 };
      })
      .filter((t) => t.key !== chosenKey)
      .sort((a, b) => b.safe - a.safe || a.key.localeCompare(b.key))
      .slice(0, 2);
    for (const t of ranked) teams.push({ seats: sortedSeats(t.ids), safe: t.safe, chosen: false });
  }
  return { redShare, topWorlds, teams, twoFails, good };
}

// ─── /公布：百科AI 會派的前三種組合（站長 2026-11-26） ─────────────────────────

/**
 * 站長 2026-11-26：「模擬瓦公布時加入「現行百科AI會派的組合前三種可能（若只有一種可能不用硬給到三種）」」。
 *
 * 正式機器人（defaultBot：ForwardAgent ＋ 目前的 DEFAULT_AGENT_TUNING，網站真人桌用的同一個）的決定裡有亂數，
 * 所以「會派哪一隊」是一個分布：換不同的種子讓它在題目那一刻、題目那一家重派很多次，數每一隊出現幾次。
 *   - 第 0 次的種子跟 /區間 一樣（`<局>|<座位>|read-<次>` 開局、`team-<次>` 派），所以 /區間 的「百科AI 會派」一定在樣本裡；
 *     刺殺題第 0 次跟 Threads 百科AI 作答一樣（`<局>|<座位>|assassinate`）。
 *   - 先派 AI_PICK_PROBE 次；每次都一樣 → 這一刻沒有亂數（大部分的題目），只列那一隊。不然派滿 AI_PICK_SAMPLES 次。
 *   - 出現不到 AI_PICK_MIN_SHARE（5%）的不列；最多列 3 種；只剩一種就只列一種（不硬湊三種）。
 *   - 每派一次讓出一次事件迴圈（不卡住其他聊天室和網站）；超過 budgetMs 而且已經派滿 AI_PICK_PROBE 次就照手上的算。
 * 同一題、同樣的次數，結果每次一樣（種子固定）。
 */
export const AI_PICK_SAMPLES = 24;
export const AI_PICK_PROBE = 8;
export const AI_PICK_MIN_SHARE = 0.05;
export const AI_PICK_MAX = 3;
/** 正式機一次 /公布 最多花多久重派（毫秒）。一般 0.1–2 秒。 */
export const AI_PICK_BUDGET_MS = 3_000;

export type AiPickPoint = { kind: 'team_select'; proposal: number } | { kind: 'assassination' };

export interface AiPick {
  /** 隊伍（座位遞增）；刺殺題是一個座位。 */
  seats: number[];
  /** 這一隊在樣本裡的比例。 */
  p: number;
}

export interface AiPicks {
  kind: 'team' | 'assassinate';
  /** 最多 AI_PICK_MAX 種，比例高的在前（同比例照座位）。 */
  picks: AiPick[];
  /** 沒列出來的其他組合加起來的比例（0 = 全部列了）。 */
  others: number;
  /** 實際派了幾次。 */
  samples: number;
}

export interface AiPickOptions {
  samples?: number;
  probe?: number;
  budgetMs?: number;
  now?: () => number;
  /** 每派一次之後呼叫（預設讓出事件迴圈）。 */
  yieldFn?: () => Promise<void>;
}

const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 第 k 次的種子尾巴（第 0 次跟 /區間、Threads 一樣，沒有尾巴）。 */
const tail = (k: number): string => (k === 0 ? '' : `|s${k}`);

/** 第 k 次：正式機器人在 `point` 會派的隊（座位遞增）／會刺的座位；派不出來 → null。 */
export function aiPickOnce(game: SimGame, seat: number, point: AiPickPoint, k: number): number[] | null {
  if (point.kind === 'assassination') {
    return withSeededRandom(`${game.id}|${seat}|assassinate${tail(k)}`, () => {
      const obs = decisionObservation(game, seat, { kind: 'assassination' });
      const { agent } = defaultBot(game, seat);
      const a = agent.act(obs);
      return a.type === 'assassinate' ? [seatOfId(a.targetId)] : null;
    });
  }
  const p = point.proposal;
  return withSeededRandom(`${game.id}|${seat}|read-${p}${tail(k)}`, () => {
    const obs = decisionObservation(game, seat, { kind: 'team_select', proposal: p });
    const { agent } = defaultBot(game, seat);
    const a = withSeededRandom(`${game.id}|${seat}|team-${p}${tail(k)}`, () => agent.act(obs));
    return a.type === 'team_select' && a.teamIds.length > 0 ? sortedSeats(a.teamIds) : null;
  });
}

/** 一串樣本 → 前幾種（比例 ≥ AI_PICK_MIN_SHARE，最多 AI_PICK_MAX 種）。沒有樣本 → null。 */
export function summarizePicks(kind: AiPicks['kind'], samples: readonly (readonly number[])[]): AiPicks | null {
  if (samples.length === 0) return null;
  const counts = new Map<string, { seats: number[]; n: number }>();
  for (const s of samples) {
    const key = s.join(',');
    const hit = counts.get(key);
    if (hit) hit.n += 1;
    else counts.set(key, { seats: [...s], n: 1 });
  }
  const ranked = [...counts.values()]
    .sort((a, b) => b.n - a.n || a.seats.join(',').localeCompare(b.seats.join(',')))
    .map((c) => ({ seats: c.seats, p: c.n / samples.length }));
  // 第一名一定列（就算每一種都很少，例如第 1 局隨便派）；其他要 ≥ 5%。
  const picks = ranked.filter((c, i) => i === 0 || c.p >= AI_PICK_MIN_SHARE).slice(0, AI_PICK_MAX);
  const shown = picks.reduce((a, c) => a + c.p, 0);
  return { kind, picks, others: Math.max(0, 1 - shown), samples: samples.length };
}

/** 題目那一家（`seat`）在 `point` 那一刻，正式機器人會派（刺）的前幾種，和各自的比例。派不出來 → null。 */
export async function aiPicks(game: SimGame, seat: number, point: AiPickPoint, opts: AiPickOptions = {}): Promise<AiPicks | null> {
  const total = Math.max(1, opts.samples ?? AI_PICK_SAMPLES);
  const probe = Math.min(total, Math.max(1, opts.probe ?? AI_PICK_PROBE));
  const budget = opts.budgetMs ?? AI_PICK_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const pause = opts.yieldFn ?? yieldLoop;
  const t0 = now();
  const samples: number[][] = [];
  for (let k = 0; k < total; k++) {
    const s = aiPickOnce(game, seat, point, k);
    if (s) samples.push(s);
    if (k + 1 === probe && samples.length > 0 && samples.every((x) => x.join(',') === samples[0].join(','))) break;
    if (k + 1 >= probe && now() - t0 > budget) break;
    await pause();
  }
  return summarizePicks(point.kind === 'assassination' ? 'assassinate' : 'team', samples);
}
