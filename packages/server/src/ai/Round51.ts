/**
 * 第 51 回合（站長 2026-11-18，原話）：
 *
 * > 把一個策略放到考慮中: 當局沒有機會當隊長派任務的玩家 開外白的傾向上升 / 當局還有機會當隊長派任務的玩家 開內黑的傾向上升 /
 * > 比如 1-3 的派票 4家 跟 5家 開內黑的傾向上升 / 其餘玩家開外白的傾向上升 / 測測看
 *
 * 百科〈名詞說明與簡稱〉：內黑 = 隊伍內的玩家投反對、外白 = 隊伍外的玩家投贊成。所以：
 *   - 第 r 局第 k 次提議，這一局之後（第 k+1..5 次提議，含第 5 次強制局）還會當隊長的人，在隊上時比較容易反對（內黑）；
 *   - 其他人（這一局不會再當隊長）不在隊上時比較容易贊成（外白）。
 *
 * 真人局（`scripts/leaderVoteStudy.ts`／`.py`，第 51 回合第 1 節）：忠臣在隊上、第 3–5 局，之後還會當隊長的人贊成率低 8.5pp
 * [7.1, 10.0]；不在隊上低 4.2pp [3.3, 5.0]；機器人（現行預設）只有 0.7／0.4pp。
 *
 * 開關（`AgentTuning`，預設全部 0）：
 *   - `leaderOppVote51`（位元）：1 = 第 3–5 局在隊上、之後還會當隊長 → 內黑的門檻（`goodBayesBad`／`goodBayesBadKey`）降低 δ；
 *     2 = 第 3–5 局不在隊上、這一局不會再當隊長 → 外白的門檻（`goodBayesGood`／`goodBayesGoodKey`）降低 δ；
 *     4 = 第 1、2 局（現行是正常票的硬規則）：照真人的比例開——之後還會當隊長、在隊上 → 內黑；不會再當隊長、不在隊上 → 外白
 *     （外白不越過好人投票關卡）；8 = 派西也用（預設只給忠臣）。
 *   - `leaderOppVote51Delta`：內黑門檻的 δ（0 = 0.1）；`leaderOppVote51DeltaOut`：外白門檻的 δ（0 = 同 `leaderOppVote51Delta`）。
 *   - `leaderOppVoteRed51`：紅方（奧伯倫除外）第 3–5 局在隊上、之後還會當隊長、紅方還沒有兩勝 → 以這個比例內黑（照局面雜湊；
 *     真人紅方同一格低 5.4pp、強者 8.3pp）。硬約束（隊長自己的隊、紅方兩勝的隊、莫德雷德單獨在隊上贊成…）照舊優先。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { leadsLaterThisRound } from './BlueRound38';

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 同一個局面每次一樣的亂數（座位、第幾局、第幾次提議、表決中的隊伍、公開紀錄的長度）。 */
function spotDraw(obs: PlayerObservation, salt: string): number {
  const team = [...(obs.proposedTeam ?? [])].sort().join(',');
  return hash01(`${obs.myPlayerId}|R${obs.currentRound ?? 1}|A${obs.failCount ?? 0}|${team}|V${obs.voteHistory.length}|${(obs.questResults ?? []).join('')}|${salt}`);
}

/** 真人忠臣第 1、2 局的比例（`leaderVoteStudy` 全部真人、好人陣營）：[第 1 局, 第 2 局]。 */
export const EARLY_RATES_51 = {
  /** 不在隊上、這一局不會再當隊長：外白。 */
  offTeamWhite: [0.023, 0.032],
  /** 在隊上、之後還會當隊長：內黑。 */
  onTeamBlack: [0.015, 0.07],
} as const;

/** 這個座位這次投票適不適用（忠臣；位元 8 加派西）：好人、真的忠臣（不是梅林的忠臣視角）、不是隊長、不是強制局。 */
function eligible(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.leaderOppVote51 ?? 0;
  if (!(mode > 0) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return false;
  if (obs.publicLoyalView === true || obs.redLoyalView === true) return false;
  if (obs.myRole !== 'loyal' && !(obs.myRole === 'percival' && (mode & 8) !== 0)) return false;
  if (obs.currentLeader === obs.myPlayerId || (obs.failCount ?? 0) >= 4) return false;
  return (obs.proposedTeam ?? []).length > 0;
}

/**
 * 第 3–5 局的門檻位移（`BlueRound33.bayesVoteCriteria` 用）：回傳要從門檻減掉的值（0 = 不變）。
 * `onTeam` = 投票者在隊上（內黑的門檻）；否則外白的門檻。
 */
export function leaderOppShift51(tuning: Readonly<AgentTuning>, obs: PlayerObservation, onTeam: boolean): number {
  if (!eligible(tuning, obs) || (obs.currentRound ?? 1) < 3) return 0;
  const mode = tuning.leaderOppVote51 ?? 0;
  const delta = (tuning.leaderOppVote51Delta ?? 0) > 0 ? (tuning.leaderOppVote51Delta as number) : 0.1;
  const deltaOut = (tuning.leaderOppVote51DeltaOut ?? 0) > 0 ? (tuning.leaderOppVote51DeltaOut as number) : delta;
  const later = leadsLaterThisRound(obs);
  if (onTeam) return (mode & 1) !== 0 && later ? delta : 0;
  return (mode & 2) !== 0 && !later ? deltaOut : 0;
}

/**
 * 第 1、2 局（位元 4）：true = 外白、false = 內黑、null = 照原本（正常票）。外白要由呼叫端再過好人投票關卡。
 */
export function leaderOppEarly51(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean | null {
  if (!eligible(tuning, obs) || ((tuning.leaderOppVote51 ?? 0) & 4) === 0) return null;
  const round = obs.currentRound ?? 1;
  if (round > 2) return null;
  const onTeam = (obs.proposedTeam ?? []).includes(obs.myPlayerId);
  const later = leadsLaterThisRound(obs);
  if (onTeam && later && spotDraw(obs, 'lov51-black') < EARLY_RATES_51.onTeamBlack[round - 1]) return false;
  if (!onTeam && !later && spotDraw(obs, 'lov51-white') < EARLY_RATES_51.offTeamWhite[round - 1]) return true;
  return null;
}

/** 紅方（奧伯倫除外）：第 3–5 局在隊上、之後還會當隊長、紅方還沒有兩勝 → 以 `leaderOppVoteRed51` 的比例內黑。呼叫端先排除硬約束。 */
export function leaderOppRed51(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.leaderOppVoteRed51 ?? 0;
  if (!(q > 0) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil' || obs.myRole === 'oberon') return false;
  if ((obs.currentRound ?? 1) < 3 || obs.currentLeader === obs.myPlayerId || (obs.failCount ?? 0) >= 4) return false;
  if ((obs.questResults ?? []).filter((r) => r === 'fail').length >= 2) return false;
  if (!(obs.proposedTeam ?? []).includes(obs.myPlayerId) || !leadsLaterThisRound(obs)) return false;
  return spotDraw(obs, 'lov51-red') < q;
}

/**
 * 第 51 回合 B（站長 11/18「忠臣本身的思考能力不夠」的診斷第 1 名；`scripts/loyalGapStudy.ts`）：忠臣持湖時，同一批真人決策點上
 * 機器人湖「出過失敗任務的人」73%（強者真人 52%），湖沒出過失敗任務的藍方 24%（強者 38%）——用人類的優勢表打分數，這是忠臣單一決策裡
 * 落後強者最多的一項（第 2 湖後 −0.28pp／忠臣座位局）。`lakeUntainted51 = w`：`goodLakeInfoMax` 的湖中分數，對出過失敗任務的候選人
 * 扣 w × （最好的資訊量），其餘照舊（同分照座位序）。給忠臣與派西持湖者（派西照忠臣的湖法，INV-PL2）。回傳 null = 不適用。
 * 第 51 回合篩選的版本（`r51-screen` 的 LK）只給忠臣、只看失敗的任務；第 1 關的不變量（INV-PL2 派西沒有照忠臣的湖法、INV-B3 只讀任務結果）因此改成現在的寫法。
 */
export function untaintedLakePick51(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  pool: readonly string[],
  analyze: (obs: PlayerObservation, candidates: readonly string[]) => { candidates: ReadonlyArray<{ id: string; score: number; infoGain: number }> } | null,
): string | null {
  const w = tuning.lakeUntainted51 ?? 0;
  // 派西也照忠臣的湖法（INV-PL2／10/14 D4：派西持湖 = 帶著拇指事實的忠臣）。
  if (!(w > 0) || (obs.myRole !== 'loyal' && obs.myRole !== 'percival') || obs.myTeam !== 'good' || pool.length === 0) return null;
  const an = analyze(obs, pool);
  if (!an || an.candidates.length === 0) return null;
  // 出過任務而且任務裡有失敗牌（照張數讀，不只看任務結果：第 4 局一張失敗的成功任務也算；INV-B3）。
  const tainted = new Set(obs.questHistory.filter((q) => (q.failCount ?? 0) > 0).flatMap((q) => q.team));
  const value = Math.max(0, ...an.candidates.map((c) => c.infoGain));
  const order = new Map(obs.allPlayerIds.map((id, i) => [id, i]));
  const ranked = an.candidates.map((c) => ({ id: c.id, s: c.score - (tainted.has(c.id) ? w * value : 0) }))
    .sort((a, b) => (Math.abs(b.s - a.s) > 1e-9 ? b.s - a.s : (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)));
  return ranked[0]?.id ?? null;
}
