/**
 * 第 26 回合：以策略為本的讀票接進正式的貝氏後驗（`BayesOptions.policyVotes`，`AgentTuning.beliefPolicyVotes`，預設關）。
 *
 * Edward 2026-11-04：「所有人的動作都應該建立在所有人對所有歷史動作的資訊流之上」「如果機器人跟真人（而且是強的真人）一樣的話，
 * 兩者應該要類似或接近相同」——讀每一個人的票 = 把那張票當成他自己的函數套在他當時的 INFL 上（`voteFeatures.ts`、`policyModel.ts`），
 * 而且只有一套讀人的模型：用強者分面前 5 的票擬合、向全體真人收縮（`scripts/fitPolicyVotes.ts` → `policy_strong.json`）。
 *
 * 線上的成本：每次後驗要「每次提議 × 每個座位」的忠臣視角（`FlowFeatures.seatView`，一次確定性層）。同一局的觀察只會往後變長，
 * 所以快取同一局較短資訊流算過的特徵（`FlowFeatures.adoptFrom`；以「前幾次提議的紀錄完全相同」判斷是同一局）。
 */
import type { PlayerObservation } from '../types';
import { flowOfObs, maskOf } from './flow';
import { FEATURE_NAMES, FlowFeatures, ROLE_CLASSES, type RoleClass } from './voteFeatures';
import { PolicyVoteReader, type PolicyModel } from './policyModel';
import MODEL from './policy_strong.json';

interface ModelFile { features: string[]; beta: Record<string, number[]> }

let model: PolicyModel | null = null;
function strongModel(): PolicyModel {
  if (model) return model;
  const m = MODEL as unknown as ModelFile;
  if (m.features.length !== FEATURE_NAMES.length || m.features.some((f, k) => f !== FEATURE_NAMES[k])) {
    throw new Error('policy_strong.json: feature list does not match voteFeatures.ts (refit with scripts/fitPolicyVotes.ts)');
  }
  const beta = {} as Record<RoleClass, Float64Array>;
  for (const c of ROLE_CLASSES) beta[c] = Float64Array.from(m.beta[c]);
  model = { beta, residual: false, useBayesView: false };
  return model;
}

interface Entry { sigs: string[]; ff: FlowFeatures }
/** 最近的幾局（自我對打同一時間只有一局；線上桌數不多）。 */
const recent: Entry[] = [];
const MAX_ENTRIES = 24;

const voteSig = (v: PlayerObservation['voteHistory'][number]): string =>
  `${v.round}|${v.attempt}|${v.leader}|${v.team.join(',')}|${Object.keys(v.votes).sort().map((k) => `${k}${v.votes[k] ? '+' : '-'}`).join('')}`;

/** 這個觀察的資訊流特徵（接手同一局較短資訊流的快取）。 */
function featuresOf(obs: PlayerObservation): FlowFeatures {
  const flow = flowOfObs(obs);
  const sigs = flow.votes.map(voteSig);
  let best: Entry | null = null;
  let bestLen = 0;
  for (const e of recent) {
    if (e.sigs.length === 0 || sigs.length === 0 || e.sigs[0] !== sigs[0] || !e.ff.flow.ids.every((id, k) => id === flow.ids[k])) continue;
    let k = 0;
    while (k < e.sigs.length && k < sigs.length && e.sigs[k] === sigs[k]) k++;
    if (k > bestLen) { best = e; bestLen = k; }
  }
  if (best && bestLen === sigs.length && best.sigs.length === sigs.length
    && best.ff.flow.quests.length === flow.quests.length && best.ff.flow.lakes.length === flow.lakes.length) return best.ff;
  const ff = new FlowFeatures(flow);
  if (best && bestLen > 0) ff.adoptFrom(best.ff, bestLen);
  recent.unshift({ sigs, ff });
  if (recent.length > MAX_ENTRIES) recent.length = MAX_ENTRIES;
  return ff;
}

/**
 * 世界 w（紅方座位遮罩，`belief/Certainty` 的位元：P1 = 1 …；和 `infl/flow.bitOf` 相同）的讀票 log 概似，函數形式；
 * 觀察者自己的票不讀。觀察者是梅林時，他看得到的紅決定誰是莫德雷德（`viewerSeesReds`）。沒有可讀的票時 null。
 */
export function policyVoteLog(obs: PlayerObservation): ((w: number) => number) | null {
  if (obs.voteHistory.every((v) => v.attempt >= 5)) return null;
  const ff = featuresOf(obs);
  const reader = new PolicyVoteReader(strongModel(), ff);
  const n = ff.flow.votes.length;
  const sees = obs.myRole === 'merlin' ? maskOf(ff.flow, obs.knownEvils) : null;
  const me = obs.myPlayerId;
  return (w: number) => reader.worldLog(me, n, w, sees);
}
