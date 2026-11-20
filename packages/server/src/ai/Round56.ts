/**
 * 第 56 回合（站長 2026-11-19，原話）：
 *
 * > 第二局的任務結果資訊 跟第一局任務結果資訊要合起來看
 *
 * > 先把 1-5 & 2-5 的派法跟邏輯訓練好 因為其實 1-1~1-4 & 2-1~2-4 做的事情都跟 1-5 & 2-5 一樣 你就是要當成每次派票都有可能提前出任務
 * > 而不是先預設不會出任務 並且在這個前提下去釋放自己的看法 區間 跟資訊
 *
 * 信念層（`BayesBelief.posteriorWith`）本來就是對「誰是紅」的每一種分配（世界）精確地把每一局的任務結果乘起來（確定性層 `Certainty.enumerateWorlds`
 * 硬性要求每一個失敗的任務隊上紅數 ≥ 失敗張數，再乘上每一局的任務牌概似），所以「R1 ABC 一張失敗、R2 ADE 一張失敗 → A 很可疑」在世界的層次是精確的。
 * 不精確的是兩件事：(1) 後驗另外讀了很多提議與票，這些項加起來比任務項重得多（第 53 回合 Q2：0 在兩次失敗的任務上，後驗只有 0.27）；
 * (2) 挑隊的流程有好幾步不是「挑 P(全好) 最高的隊」（照派、回應前面的提議、第 1 局的開局排法、派西的拇指計畫、用每個人的紅機率一個一個補人）。
 *
 * `missionJoint56`（κ，0 = 關）：忠臣／派西當隊長、已經有任務結果時，用「只有遊戲規則＋任務結果＋湖＋自己的視野」的後驗 M（`missionOnlyObs`：
 * 拿掉全部提議與票）算每一隊沒有紅的機率；最後的隊 M < κ × 最高 M 時，換成 M ≥ κ × 最高 M 的隊裡完整後驗最乾淨、過得了閘門與自己的票的一隊。
 *
 * `goLike56`（位元，0 = 關）：第 1、2 局第 1–4 次提議照第 5 次（強制局）的派法——在同一個紀錄上把「這是第幾次提議」當成第 5 次去派
 * （`ForwardAgent.decide` 用 failCount = 4 的觀察再走一次），新隊過不了自己的閘門或投票規則（真的第幾次）就照原本。
 * 位元 1 = 忠臣第 1 局、2 = 忠臣第 2 局、4 = 派西第 1 局、8 = 派西第 2 局；16 = 個人先驗（`ownView`，第 38 回合）照真的第幾次提議加權（強制局本來是 0）。
 *
 * `missionRole56`（`BayesBelief`）：任務牌模型分「隊上有沒有奧伯倫」，見 `MISSION_OBERON_56`。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** The observation with every proposal and vote removed: the posterior on it reads only the rules, the missions, the lakes and the viewer's sight. */
export function missionOnlyObs(obs: PlayerObservation): PlayerObservation {
  return { ...obs, voteHistory: [], proposedTeam: [], seatTeam: obs.seatTeam ?? obs.myTeam };
}

/** Whether `missionJoint56` applies here (a good loyal / Percival leader's pick with at least one mission result). */
export function missionJoint56Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  const k = tuning.missionJoint56 ?? 0;
  if (!(k > 0) || obs.gamePhase !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  if (obs.seatTeam !== undefined && obs.seatTeam !== 'good') return false;
  if (!(obs.myRole === 'loyal' || obs.myRole === 'percival')) return false;
  return obs.questHistory.length > 0;
}

export interface MissionJointScore56 { team: string[]; m: number; f: number }

/** Every team of `size` holding the viewer with M (missions only) and F (the full posterior); null when there is no world. */
export function missionJointScores56(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, size: number): MissionJointScore56[] | null {
  const me = obs.myPlayerId;
  const others = obs.allPlayerIds.filter((id) => id !== me);
  if (size < 1 || size - 1 > others.length) return null;
  const opts = bayesOptionsOf(tuning);
  const mObs = missionOnlyObs(obs);
  const fObs = obs.seatTeam === undefined ? { ...obs, seatTeam: obs.myTeam } : obs;
  const out: MissionJointScore56[] = [];
  for (const fill of combinations(others, size - 1)) {
    const team = [me, ...fill];
    const m = bayesTeamClean(mObs, team, opts);
    const f = bayesTeamClean(fObs, team, opts);
    if (m === null || f === null) return null;
    out.push({ team, m, f });
  }
  return out;
}

const TIE = 1e-9;

/**
 * `missionJoint56`: the leader's team when its M is at least κ × the best M; otherwise the team with the highest F among those whose M is at least
 * κ × the best M and that `allowed` accepts (equal F: the decision's random draw). null = keep the team.
 */
export function missionJoint56Team(
  tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, team: readonly string[], allowed: (t: readonly string[]) => boolean,
): string[] | null {
  if (!missionJoint56Applies(tuning, obs) || !team.includes(obs.myPlayerId)) return null;
  const kappa = Math.min(1, tuning.missionJoint56 ?? 0);
  const scores = missionJointScores56(tuning, obs, team.length);
  if (!scores || scores.length === 0) return null;
  const bestM = Math.max(...scores.map((s) => s.m));
  if (!(bestM > 0)) return null;
  const key = [...team].sort().join(',');
  const mine = scores.find((s) => [...s.team].sort().join(',') === key);
  if (!mine || mine.m >= kappa * bestM - TIE) return null;
  const ok = scores.filter((s) => s.m >= kappa * bestM - TIE && allowed(s.team));
  if (ok.length === 0) return null;
  const bestF = Math.max(...ok.map((s) => s.f));
  const top = ok.filter((s) => s.f >= bestF - TIE);
  return top[Math.min(top.length - 1, Math.floor(Math.random() * top.length))].team;
}

/** The `goLike56` bit of this decision (0 = it does not apply): a good loyal / Percival leader's R1 / R2 proposal 1–4. */
export function goLike56Bit(obs: PlayerObservation): number {
  if (obs.gamePhase !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return 0;
  if (obs.seatTeam !== undefined && obs.seatTeam !== 'good') return 0;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader !== obs.myPlayerId) return 0;
  const round = obs.currentRound ?? 1;
  if (round > 2) return 0;
  if (obs.myRole === 'loyal') return round === 1 ? 1 : 2;
  if (obs.myRole === 'percival') return round === 1 ? 4 : 8;
  return 0;
}

export function goLike56Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  const bits = tuning.goLike56 ?? 0;
  const bit = goLike56Bit(obs);
  return bits > 0 && bit !== 0 && (bits & bit) !== 0;
}

/** The observation the `goLike56` pick is made on: the same record, the proposal counted as the fifth (forced) one. */
export function goLike56Obs(obs: PlayerObservation, keepOwnView = false): PlayerObservation {
  return { ...obs, failCount: 4, ...(keepOwnView ? { goLikeOwnViewFc: obs.failCount ?? 0 } : {}) };
}
