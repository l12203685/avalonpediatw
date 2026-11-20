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
