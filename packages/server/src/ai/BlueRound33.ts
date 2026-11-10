/**
 * 優化迴圈第 33 回合・藍方（2026-11-09）。Edward 2026-11-09 的裁定（綁定，不再問）：
 *   1.「本來就可以照派成功隊啊…這個不是早就給過指示」——梅林可以照派成功的隊，隊上有他看得到的紅也一樣：第 28 回合的
 *      `merlinReuseNoEarly`（預設開）和這條相反，本回合改成預設關（`AgentTuning.ts`）。
 *   2.「認為該組合不合理時, 就可以投內黑; 同理 認為該組合合理時, 就可以投外白…合理跟不合理的理由跟邏輯 還有標準, 要嚴格訂出來
 *      （可以先照你的貝氏信賴）」——見 `bayesVoteCriteria`（`goodBayesVote`；準則表在 `docs/ai/logic_first.md` 第 10C 節）。
 *   3.「我說的資訊流遞迴調整與修正怎麼好像還沒做到?」——遞迴讀人，見 `infl/recursiveRead.ts`（`beliefRecursive`）。
 *   4. 湖中鏈的權重自己選（`goodLakeChain`／`goodLakeChainFuture`），不問。
 * Edward 2026-11-09 另外：「忠臣的派票跟投票還是太弱了 繼續優化 就是因為忠臣這樣 梅林展現能力才會太明顯」；第 1 局的提議「適時疊票 也要適時做票源分散」
 * （`loyalR1Spread`）。
 *
 * 第 33 回合結果（`docs/ai/optimization_loop.md` 第 33 回合）：採用裁定 1（`merlinReuseNoEarly` 關、`merlinReuseExact` 開）、`goodReuseNoMatchPoint`、
 * `goodBayesVote=3`（θ 0.8／0.7／0.7／0.9；第 4 局照「隊上有紅」讀；自我對打合併 −0.80pp、逐點一致與量尺變好）；新預設對 main 合併 +1.00pp。
 * `beliefRecursive`、`beliefLeadRecursive`、`loyalR1Spread` 預設關（量測在同一節）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, bayesTeamRedsBelow, bayesVoteCell, bayesWorlds } from './belief/BayesBelief';
import { buildCertainty } from './belief/Certainty';
import { bestCleanWith, leaderAhead } from './GoodVoteAlt';
import { goodVouchTeamConstraint } from './GoodLakeFollowUp';
import { r1InflCtx, r1InfoValueInfl } from './BlueRound34';
import { fourthWhiteNow, onTeamStateApprove, percivalMerlinWhiteNow, r3TeamKeptAtR4, reuseWhiteNow } from './BlueRound38';

// ── 嚴格的貝氏內黑／外白準則（`goodBayesVote`；Edward 2026-11-09 裁定 2）──────────────

/**
 * 內建門檻＝第 33 回合採用的值（開關值 0 時用；`docs/ai/logic_first.md` 第 10C 節）。真人局強者藍方座位同一個 INFL 點最一致的是
 * 0.95／0.9／0.6／0.9，但自我對打合併 −2.5～−3.9pp；採用的 0.8／0.7／0.7／0.9（模式 3）合併 −0.80pp、逐點一致與量尺都變好。
 */
export const BAYES_VOTE_DEFAULTS = { bad: 0.8, badKey: 0.7, good: 0.7, goodKey: 0.9 } as const;

export interface BayesVoteVerdict {
  vote: boolean;
  /** 哪一條準則決定的（推理紀錄與測試用）。 */
  reason: 'bad' | 'provFail' | 'onDefault' | 'onState' | 'provRed' | 'lakeRed' | 'good' | 'alt' | 'reuse' | 'fourth' | 'merlinLead' | 'r4' | 'offDefault';
}

/** 這一局要幾張失敗牌任務才失敗（10 人局第 4 局 2 張）。 */
export function failsRequiredNow(obs: PlayerObservation): number {
  const round = obs.currentRound ?? 1;
  return AVALON_CONFIG[obs.playerCount ?? obs.allPlayerIds.length]?.questFailsRequired?.[round - 1] ?? 1;
}

/**
 * 嚴格的貝氏內黑／外白準則（忠臣、派西，以及梅林照忠臣投票時的公開視角；紅方照忠臣投票的視角不用——紅方凍結）。
 * 第 3 局起、非強制、自己不是隊長。後驗＝現行預設（強者表、取次方）。
 *
 * 在隊上（預設贊成＝正常票）：
 *   - P(隊上的紅夠讓任務失敗) ≥ θ_bad（關鍵局 θ_badKey）→ 內黑（`bad`）；
 *   - 公開邏輯：自己的確定性層證明這隊一定能失敗（例：保留了自己出過的失敗任務的其他所有人、自己湖到的紅）→ 內黑（`provFail`）；
 *   - 其他 → 贊成。
 * 不在隊上（預設反對＝正常票）：
 *   - 公開邏輯：確定性層證明隊上有紅，或隊上有被「看起來是藍的持湖者」（後驗紅 < 0.5）宣紅的人 → 反對（`provRed`／`lakeRed`），不看門檻；
 *     自己湖的宣告不符（漏掉自己宣藍的人、放了宣紅的人）→ 交給 `goodVouchFollowUp`（反對）；
 *   - P(這隊乾淨) ≥ θ_good（關鍵局 θ_goodKey）→ 外白（`good`）；
 *   - 公開邏輯：這隊至少和「到強制局為止之後每一任隊長能派的最乾淨的隊」一樣乾淨（否決換不到更好的隊）→ 外白（`alt`）；
 *   - 其他 → 反對。
 * 外白仍然要過好人投票關卡（呼叫端）。不適用時 null。
 * 模式（`goodBayesVote`）：1 = 上面全部；2 = 不用「換不到更好的隊」；3 = 2 ＋ 第 4 局（兩張失敗）在隊上照「隊上有紅」讀（採用的預設：照字面讀「至少兩紅」
 * 自我對打約 −3pp）。
 */
export function bayesVoteCriteria(tuning: Readonly<AgentTuning>, obs: PlayerObservation): BayesVoteVerdict | null {
  const mode = tuning.goodBayesVote ?? 0;
  if (!(mode > 0) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'good') return null;
  if (obs.redLoyalView === true) return null;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival') return null;
  const fc = obs.failCount ?? 0;
  if ((obs.currentRound ?? 1) < 3 || fc >= 4) return null;
  const me = obs.myPlayerId;
  if (obs.currentLeader === me) return null;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0) return null;
  const key = (obs.questResults ?? []).filter((r) => r === 'fail').length >= 2;
  const opts = bayesOptionsOf(tuning);
  const cert = buildCertainty(obs);
  if (team.includes(me)) {
    // 3 = 第 4 局也照「隊上有紅」讀（和現行 `goodKeyVote`／`goodCleanVote` 一樣，不分兩張失敗）。
    // 第 35 回合 `goodBayesR4Mix`：第 4 局（要兩張失敗）照字面讀，P(≥ 2 紅) 用角色混合讀人（只有這一格）。
    const r4Mix = tuning.goodBayesR4Mix === true && mode >= 3 && failsRequiredNow(obs) >= 2;
    const req = mode >= 3 && !r4Mix ? 1 : failsRequiredNow(obs);
    if (cert.minReds(team) >= req) return { vote: false, reason: 'provFail' };
    // 第 38 回合 `goodBayesR4Kept`（1、3；檢查表 AV-03）：第 4 局第 1 次提議、隊長留下第 3 局成功的整支隊，公開邏輯沒有指出隊上有紅、也沒有人被湖宣告紅 → 贊成。
    if (((tuning.goodBayesR4Kept ?? 0) & 1) !== 0 && r3TeamKeptAtR4(obs, team) && cert.minReds(team) === 0
      && !(obs.lakeHistory ?? []).some((l) => l.declaredClaim === 'evil' && team.includes(l.targetId))) return { vote: true, reason: 'onDefault' };
    const below = bayesTeamRedsBelow(obs, team, req, r4Mix ? bayesOptionsOf({ ...tuning, beliefRecursive: 5 }) : opts);
    if (below === null) return null;
    const bad = key ? (tuning.goodBayesBadKey || BAYES_VOTE_DEFAULTS.badKey) : (tuning.goodBayesBad || BAYES_VOTE_DEFAULTS.bad);
    if (!(1 - below >= bad)) return { vote: true, reason: 'onDefault' };
    // 第 38 回合 `goodOnTeamState`：內黑照局面（比分、整隊照派、自己還會不會派、被宣告紅的人），不是只看門檻。
    if (onTeamStateApprove(tuning, obs, 1 - below, key)) return { vote: true, reason: 'onState' };
    return { vote: false, reason: 'bad' };
  }
  // 自己湖的宣告（持湖者言行一致 `goodVouchFollowUp`：隊伍漏掉自己宣藍的人、或放了宣紅的人）也是反對的公開邏輯理由——交給那條規則投（它的推理紀錄寫明原因）。
  if (tuning.goodVouchFollowUp) {
    const c = goodVouchTeamConstraint(obs);
    if (c && (c.banned.some((id) => team.includes(id)) || c.required.some((id) => !team.includes(id)))) return null;
  }
  if (cert.minReds(team) >= 1) return { vote: false, reason: 'provRed' };
  const share = bayesRedShare(obs, opts);
  const lakeRed = (obs.lakeHistory ?? []).some((l) => l.holderId !== me && l.declaredClaim === 'evil' && team.includes(l.targetId) && (share.get(l.holderId) ?? 1) < 0.5);
  if (lakeRed) return { vote: false, reason: 'lakeRed' };
  // 第 38 回合 `goodReuseWhite`：這一局第 1 次提議、隊長整隊照派最近成功任務的隊（第 4 局 2:1、第 3 局 1:1）→ 外白。
  if (reuseWhiteNow(tuning, obs)) return { vote: true, reason: 'reuse' };
  // `goodBayesR4Kept`（2、3；檢查表 AV-07）：第 4 局第 1 次提議、隊長留下第 3 局成功的整支隊，P(隊上不到兩個紅) ≥ 0.7（紅方兩勝 ≥ 0.8）→ 外白。
  if (((tuning.goodBayesR4Kept ?? 0) & 2) !== 0 && r3TeamKeptAtR4(obs, team) && cert.minReds(team) < 2) {
    const b2 = bayesTeamRedsBelow(obs, team, 2, opts);
    if (b2 !== null && b2 >= (key ? 0.8 : 0.7)) return { vote: true, reason: 'reuse' };
  }
  // `goodBayesFsReuse`（檢查表 AV-08）：第 3 局第 1 次提議、第 1 局失敗第 2 局成功、原封不動派第 2 局的隊 → 外白門檻改用開關的值。
  const fsBar = tuning.goodBayesFsReuse ?? 0;
  if (fsBar > 0 && (obs.currentRound ?? 1) === 3 && fc === 0 && (obs.questResults ?? [])[0] === 'fail' && (obs.questResults ?? [])[1] === 'success') {
    const q2 = obs.questHistory.find((q) => q.round === 2);
    if (q2 && q2.team.length === team.length && q2.team.every((id) => team.includes(id))) {
      const pc = bayesTeamClean(obs, team, opts);
      if (pc !== null && pc >= fsBar) return { vote: true, reason: 'reuse' };
    }
  }
  // `goodFourthWhite`：第 3 局第 4 次提議、1:1，強制局的隊長不在這支隊上而且上過失敗的任務 → 外白。
  if (fourthWhiteNow(tuning, obs)) return { vote: true, reason: 'fourth' };
  // `percivalMerlinWhite`：派西讀得出來是梅林的那一根拇指當隊長、另一根不在隊上 → 外白。
  if (percivalMerlinWhiteNow(tuning, obs)) return { vote: true, reason: 'merlinLead' };
  // `goodR4White`：第 4 局（兩張失敗才失敗）不在隊上，P(隊上不到兩個紅) 過門檻 → 外白。
  if ((tuning.goodR4White ?? 0) > 0 && failsRequiredNow(obs) >= 2) {
    const below2 = bayesTeamRedsBelow(obs, team, 2, opts);
    if (below2 !== null && below2 >= (tuning.goodR4White ?? 0)) return { vote: true, reason: 'r4' };
  }
  // `goodR5NoWhite`：第 5 局不在隊上不用後驗門檻外白。
  if (tuning.goodR5NoWhite === true && (obs.currentRound ?? 1) === 5) return { vote: false, reason: 'offDefault' };
  const p = bayesTeamClean(obs, team, opts);
  if (p === null) return null;
  const good = key ? (tuning.goodBayesGoodKey || BAYES_VOTE_DEFAULTS.goodKey) : (tuning.goodBayesGood || BAYES_VOTE_DEFAULTS.good);
  if (p >= good) return { vote: true, reason: 'good' };
  if (p > 0 && mode < 2) {
    let alt = 0;
    for (let o = 1; o <= 4 - fc; o++) {
      const leader = leaderAhead(obs, o);
      if (leader === null) continue;
      alt = Math.max(alt, bestCleanWith(obs, leader, team.length, opts) ?? 0);
    }
    if (p >= alt) return { vote: true, reason: 'alt' };
  }
  return { vote: false, reason: 'offDefault' };
}

// ── 第 1 局的提議不疊人（`loyalR1Spread`；Edward 2026-11-09）──────────────

/**
 * Edward 2026-11-09：「我發現忠臣有個習慣是 1家派1AB 2家派2AB 3家忠臣幾乎就會直接跟著派A或B 至少一個人 但強者的忠臣幾乎會刻意避開讓一個人疊太多票」。
 * 真人局（`r1spread.py`，第 1 局第 2–4 次提議、忠臣隊長）：隊上（自己以外）前面提議過的人的比例 強者 0.48、全體真人 0.49，機器人在同一點 0.99
 * （兩個隊友都是前面提議過的人 99%；強者 11%）。第 1 局的提議（強制局以外）不會出任務，它的用處是讓這一輪的票多讀到一些人；一直派同樣的人，
 * 票只會一再讀同一組人——而且在派隊的概似裡「被別人派過」被讀成偏藍，機器人就越疊越多。
 *
 * 這一局前面每個提議裡出現過的次數（自己不算）。
 */
export function r1Appearances(obs: PlayerObservation): Map<string, number> {
  const out = new Map<string, number>();
  const round = obs.currentRound ?? 1;
  for (const v of obs.voteHistory) {
    if (v.round !== round) continue;
    for (const id of v.team) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** 這支隊（隊長自己以外）照 `mode` 算的「疊人」分數：1 = 前面提議過的隊友數超過 1 的部分（0 = 合格）；2 = 出現次數加總。越小越好。 */
export function r1StackScore(obs: PlayerObservation, team: readonly string[], mode: number, seen = r1Appearances(obs)): number {
  const me = obs.myPlayerId;
  const others = team.filter((id) => id !== me);
  if (mode === 1) return Math.max(0, others.filter((id) => (seen.get(id) ?? 0) > 0).length - 1);
  return others.reduce((a, id) => a + (seen.get(id) ?? 0), 0);
}

const h2 = (p: number): number => (p <= 1e-12 || p >= 1 - 1e-12 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

/**
 * `loyalR1Spread=3`（Edward 2026-11-09 更正：「不是刻意全部去派沒票的人 而是適時疊票 也要適時做票源分散」）：一支第 1 局的提議被投票之後，
 * 公開視角（只看公開紀錄的忠臣）對每個人「是不是紅」的不確定性預期減少多少——每張票和每個座位是不是紅的互資訊加總（Σ_投票者 Σ_座位 I(座位紅; 票)，
 * 各票在給定世界下當成獨立；
 * 票的機率照後驗讀票用的格子：投票者陣營 × 在不在隊上 × 隊上有沒有紅）。前面的提議已經把某些人讀得夠清楚時，再派他們換不到資訊（分散）；
 * 一個人還很模糊、而且他在不在隊上會讓票分得很開時，疊他才有資訊（疊票）。
 * 強制局隊長（尾家，第 1 局就是 5 家）自己那一位不算進資訊（只算「其他人是不是紅」）：強制局的隊是他派的，他要的是其他人的資訊——
 * 派他進來等於讓他少一個好人資訊（Edward 11/09），除非這樣的票對其他人的資訊仍然最多。
 */
export function r1InfoValue(obs: PlayerObservation, team: readonly string[], ctx: R1InfoCtx): number {
  const { worlds, wts, bit, ids, tailBit, cells, me } = ctx;
  let mask = 0;
  for (const id of team) mask |= bit(id);
  const seats = ids.filter((id) => id !== me && bit(id) !== tailBit).map((id) => bit(id));
  const pRed = seats.map((b) => worlds.reduce((a, w, x) => a + ((w & b) !== 0 ? wts[x] : 0), 0));
  const p1w = new Float64Array(worlds.length);
  let total = 0;
  for (const j of ids) {
    if (j === me) continue;
    const jb = bit(j);
    const on = (mask & jb) !== 0;
    let p1 = 0;
    worlds.forEach((w, x) => {
      p1w[x] = cells[((w & jb) !== 0 ? 2 : 0) + ((w & mask) !== 0 ? 1 : 0) + (on ? 4 : 0)];
      p1 += wts[x] * p1w[x];
    });
    const hv = h2(p1);
    seats.forEach((b, k) => {
      const a = pRed[k];
      if (a <= 1e-12 || a >= 1 - 1e-12) return;
      let q1 = 0;
      worlds.forEach((w, x) => { if ((w & b) !== 0) q1 += wts[x] * p1w[x]; });
      total += hv - (a * h2(q1 / a) + (1 - a) * h2((p1 - q1) / (1 - a)));
    });
  }
  return total;
}

export interface R1InfoCtx {
  worlds: readonly number[];
  wts: readonly number[];
  bit: (id: string) => number;
  ids: readonly string[];
  me: string;
  tailBit: number;
  /** P(贊成)：索引 = (投票者紅 ? 2 : 0) + (隊上有紅 ? 1 : 0) + (在隊上 ? 4 : 0)。 */
  cells: Float64Array;
}

/** 公開視角的資訊價值情境（梅林＝坐在他位置、只看公開紀錄的忠臣）。 */
export function r1InfoCtx(tuning: Readonly<AgentTuning>, obs: PlayerObservation): R1InfoCtx {
  const pub = { ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
  const opts = bayesOptionsOf(tuning);
  const bw = bayesWorlds(pub, opts);
  const round = obs.currentRound ?? 1;
  const cells = new Float64Array(8);
  for (let k = 0; k < 8; k++) cells[k] = bayesVoteCell(opts, (k & 2) !== 0 ? 'evil' : 'good', (k & 4) !== 0, (k & 1) !== 0, round);
  const tail = leaderAhead(obs, 4 - (obs.failCount ?? 0));
  return { worlds: bw.worlds, wts: bw.wts, bit: bw.bitOf, ids: obs.allPlayerIds, me: obs.myPlayerId, tailBit: tail && tail !== obs.myPlayerId ? bw.bitOf(tail) : 0, cells };
}

/** 第 1 局提議的排序分數（越小越先）：1、2 = 疊人分數（`r1StackScore`），3 = −資訊價值（讀票格子），4 = −資訊價值（INFL 讀票模型，第 34 回合）。 */
export function r1Scorer(tuning: Readonly<AgentTuning>, obs: PlayerObservation, mode: number): (team: readonly string[]) => number {
  if (mode >= 4) {
    // 第 34 回合：用 INFL 讀票模型算資訊價值（`BlueRound34.r1InfoValueInfl`）。
    const ctx = r1InflCtx(tuning, obs);
    return (team) => -r1InfoValueInfl(team, ctx);
  }
  if (mode >= 3) {
    const ctx = r1InfoCtx(tuning, obs);
    return (team) => -r1InfoValue(obs, team, ctx);
  }
  const seen = r1Appearances(obs);
  return (team) => r1StackScore(obs, team, mode, seen);
}

/** 第 1 局、非強制、前面已經有這一局的提議時才適用。 */
export function r1SpreadActive(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number {
  const mode = tuning.loyalR1Spread ?? 0;
  if (!(mode > 0) || obs.myTeam !== 'good') return 0;
  if ((obs.currentRound ?? 1) !== 1 || (obs.failCount ?? 0) >= 4) return 0;
  if (!obs.voteHistory.some((v) => v.round === 1)) return 0;
  return mode;
}

function teamsWith(me: string, others: readonly string[], k: number): string[][] {
  const out: string[][] = [];
  const pick = (start: number, acc: string[]): void => {
    if (acc.length === k) { out.push([me, ...acc]); return; }
    for (let i = start; i <= others.length - (k - acc.length); i++) { acc.push(others[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/**
 * `loyalR1Spread`（忠臣隊長）：第 1 局非強制的提議，照 `r1Scorer` 排序（1、2 疊人分數最小、3 資訊價值最大），同分挑後驗最乾淨的（再同分照列舉順序）；仍然過好人的邏輯閘門 `allowed`。
 * 派西第 1 局有自己的拇指規則（`percivalNoThumbsR1`），不在這裡；梅林在 `merlinLoyalStyleTeam` 用 `r1StackScore` 做同一件事。不適用時回傳原本的動作。
 */
export function r1SpreadTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  const mode = r1SpreadActive(tuning, obs);
  if (!mode || action.type !== 'team_select' || obs.myRole !== 'loyal' || obs.publicLoyalView === true) return action;
  const me = obs.myPlayerId;
  const size = action.teamIds.length;
  if (mode === 1 && r1StackScore(obs, action.teamIds, mode) === 0) return action;
  const score = r1Scorer(tuning, obs, mode);
  const opts = bayesOptionsOf(tuning);
  const scored = teamsWith(me, obs.allPlayerIds.filter((id) => id !== me), size - 1)
    .map((team) => ({ team, s: score(team), p: bayesTeamClean(obs, team, opts) ?? 0 }));
  scored.sort((a, b) => (Math.abs(a.s - b.s) > 1e-9 ? a.s - b.s : b.p - a.p > 1e-12 ? 1 : a.p - b.p > 1e-12 ? -1 : 0));
  const best = scored.find((c) => allowed(c.team));
  return best ? { type: 'team_select', teamIds: best.team } : action;
}
