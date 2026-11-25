/**
 * 第 82 回合（藍方・梅林被世界線刺客認出來的訊號；`scripts/merlinTellStudy82.py`）：
 *
 * 量到的（基準線 3,000 局、真人局 1,193 個刺殺點，同一個刺客）：機器人的刺客先分層（當隊長時確定放過梅林看得到的紅的人排到後面），
 * 第一層裡再照世界線挑。機器人的梅林 94.6% 在第一層（真人梅林 91.2%、強的真人梅林 85.9%）——強的真人梅林第 3 局起、強制局
 * 有一成多的提議帶他看得到的紅，機器人梅林第 3 局起只有照派成功的隊會帶（分層不算照派）。世界線裡最大的一塊是派隊
 * （拿掉它刺中率少 3.9pp），票、湖、派西維爾那一側都在 1.5pp 以內。所以這裡的開關都是「讓梅林偶爾做忠臣會做、梅林平常不做的事」：
 *
 * 1. `merlinTierCover82 = q`（0–1，0 = 關）：第 3、4 局非強制的第 1–3 次提議（機器人局藍方隊長的隊帶看得到的紅，出任務的比例
 *    第 3 局 12–13%、第 4 局 16–25%）、紅方還沒兩勝，梅林以比例 q（照座位、局、第幾次提議雜湊）派一支「坐在他位置、只看公開紀錄的
 *    忠臣說得通的隊」（公開的「這隊沒有紅」≥ 最高的一半，同 `merlinLoyalFree80`）裡**剛好帶一個他看得到的紅**、公開分數最高的那支——
 *    忠臣在同一個位置也派得出來的「失誤」。他之前已經確定派過看得到的紅（分層已經把他排到後面）就不再做。
 *    出過失敗任務的看得到的紅（第 54 回合擋的）、他自己確定但看不到的紅、湖的規則擋下的人不放；過公開視角的邏輯閘門。
 *    `merlinTierCoverScope82`（位元）：1 = 只有第 3 局；2 = 一局最多一次；4 = 只有第 2、3 次提議（不碰第 1 次）；8 = 第 4 局要兩張失敗時
 *    只在他自己估「隊上沒有莫德雷德」≥ 0.7 時做（看得到的紅一個人敗不了第 4 局）。
 *    這和站長 11/25「在忠臣資訊視角內 可以派出的全沒拇指組合…那當然還是用能力避開」的字面不同（那條是梅林自己的乾淨隊優先），
 *    也碰到 INV-M1（梅林第 3 局起不派含看得到的紅的隊；目前登記的例外只有第 1、2 局注定被否決的提議與照派成功的隊）——**只量，採不採用要站長**。
 * 2. `merlinLakeMix82 = q`（0–1，0 = 關）：梅林持湖時以比例 q（照座位、第幾湖雜湊）照「只看公開紀錄的忠臣」挑湖的目標
 *    （第 13 回合 `merlinLakeLoyal` 的做法，那個開關是一律）：機器人梅林湖到看得到的紅 0%，真人梅林 9.3%、忠臣 20%。宣告照舊說實話（A0）。
 *
 * A0（好人持湖說實話）、A1（紅方已兩勝必出失敗）不相干：只改梅林自己的提議與湖的目標。開關關時逐局相同。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { loyalFree80Set } from './Round80';

/** 診斷計數（研究腳本用；不影響決策）。 */
export const round82Stats = { tierApplies: 0, tierCovered: 0, tierNoTeam: 0, lakeMixed: 0 };

function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 這一次梅林的提議能不能套 `merlinTierCover82`（不含比例）。 */
export function tierCover82Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  if (!((tuning.merlinTierCover82 ?? 0) > 0) || obs.myRole !== 'merlin' || obs.gamePhase !== 'team_select') return false;
  const bits = tuning.merlinTierCoverScope82 ?? 0;
  const round = obs.currentRound ?? 1;
  const fc = obs.failCount ?? 0;
  if (round < 3 || round > ((bits & 1) !== 0 ? 3 : 4)) return false;
  if (fc >= 3 || ((bits & 4) !== 0 && fc === 0)) return false;
  if (obs.questResults.filter((r) => r === 'fail').length >= 2) return false;
  const seen = new Set(obs.knownEvils);
  const me = obs.myPlayerId;
  // 之前（第 3 局起或強制局）已經確定派過看得到的紅：分層已經把他排到後面，不用再做。
  const prior = obs.voteHistory.filter((v) => v.leader === me && (v.round >= 3 || v.attempt >= 5) && v.team.some((id) => seen.has(id)));
  if (prior.length > 0) return false;
  return true;
}

/**
 * `merlinTierCover82` 的挑法：`cur` = 現行這一次會派的隊；`publicAllowed` = 公開視角的邏輯閘門；`barred` = 梅林不放的人
 * （第 54 回合擋的看得到的紅、他自己確定但看不到的紅、湖的規則擋下的人）。回傳要派的隊（不改就是 `cur` 本身）。
 */
export function tierCover82Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  cur: readonly string[],
  publicAllowed: (team: readonly string[]) => boolean,
  barred: readonly string[],
): readonly string[] {
  if (cur.length === 0 || !tierCover82Applies(tuning, obs)) return cur;
  const seen = new Set(obs.knownEvils);
  if (cur.some((id) => seen.has(id))) return cur;
  round82Stats.tierApplies++;
  const q = tuning.merlinTierCover82 ?? 0;
  if (hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|tier82`) >= q) return cur;
  const bits = tuning.merlinTierCoverScope82 ?? 0;
  if ((bits & 2) !== 0) {
    // 一局最多一次：之前的局（第 3 局起）有過一次「這個開關會做」的機會而且雜湊說做 → 這次不做。
    const me = obs.myPlayerId;
    const earlier = obs.voteHistory.some((v) => v.leader === me && v.round >= 3 && v.round < (obs.currentRound ?? 1)
      && v.attempt <= 3 && hash01(`${me}|${v.round}|${v.attempt - 1}|tier82`) < q);
    if (earlier) return cur;
  }
  const set = loyalFree80Set(tuning, obs, cur.length, 0.5, publicAllowed, barred);
  if (!set) { round82Stats.tierNoTeam++; return cur; }
  const twoFail = (obs.currentRound ?? 1) === 4 && obs.playerCount >= 7;
  const ownOpts = bayesOptionsOf(tuning);
  const pick = set.teams
    .filter((t) => t.plausible && t.thumbs === 1)
    .filter((t) => {
      if (!twoFail || (bits & 8) === 0) return true;
      const unseen = t.team.filter((id) => !seen.has(id) && id !== obs.myPlayerId);
      return (bayesTeamClean(obs, unseen, ownOpts) ?? 0) >= 0.7;
    })
    .sort((a, b) => b.score - a.score)[0];
  if (!pick) { round82Stats.tierNoTeam++; return cur; }
  round82Stats.tierCovered++;
  return pick.team;
}

/** `merlinLakeMix82`：這一湖梅林要不要照只看公開紀錄的忠臣挑目標。 */
export function merlinLakeMix82Now(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  const q = tuning.merlinLakeMix82 ?? 0;
  if (!(q > 0) || obs.myRole !== 'merlin') return false;
  const lakeNo = (obs.lakeHistory?.length ?? 0) + 1;
  const on = hash01(`${obs.myPlayerId}|${lakeNo}|lake82`) < q;
  if (on) round82Stats.lakeMixed++;
  return on;
}
