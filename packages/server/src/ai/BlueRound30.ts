/**
 * 優化迴圈第 30 回合・藍方（2026-11-04）：第 29 回合紅方 `assassinReuseRead=12` 讀的是「第 2 局照派第 1 局成功、有梅林看得到的紅的隊」——
 * 新預設下梅林 0／159 照派（Edward 11/04 裁定 5：梅林第 1、2 局的提議不帶看得到的紅，`merlinReuseNoEarly`），其他藍方隊長 503／512 照派（98%），
 * 刺客把「照派了」讀成 ×0.05（幾乎一定不是梅林）。梅林不能改（裁定 5），所以從忠臣／派西這邊往強者真人收斂。
 *
 * 真人資料（`games_cache.json`，第 1 局成功之後第 2 局、忠臣／派西當隊長、非強制；scratchpad `_r30_teams`）：
 *   - 整隊保留（第 1 局的三個人都在第 2 局的隊上）：強者（藍方任務王前 5）忠臣 68.2%（隊長不在第 1 局的隊上 59.0%、在 81.5%）、派西 82.9%；
 *     全體真人忠臣 75.6%、派西 74.9%；機器人 100%／96%。
 *   - 第 1 局的隊真的有梅林看得到的紅時，強者忠臣整隊保留 54.1%（沒有 80.3%），全體 67.9%（80.1%）：真人不照派的時候，多半是那一隊真的有紅。
 *   - 用現行後驗站在那個隊長的位置（`_r30_r2fit`）：「不含整個第 1 局隊的最乾淨的隊」÷「照派的隊」這個比例越高，真人越常不照派
 *     （全體真人 0.5–0.6：照派 89.5%；≥ 0.9：69–74%），第 1 局的隊真的有紅的比例也越高（24% → 50%）——公開推理本身就有這個訊號。
 *
 * 開關（預設關，走勝率協定）：
 *   - `loyalR2Reuse=λ`：第 2 局、第 1 局成功（沒有失敗牌）、忠臣／派西當隊長、非強制；正式流程最後派的是「含整個第 1 局隊」的隊時，
 *     如果「含自己、不含整個第 1 局隊」的隊裡最乾淨的那一隊（後驗 P(沒有紅)）≥ λ × 原本那一隊，改派那一隊——
 *     照公開推理挑替代的隊（通常是拿掉第 1 局隊上嫌疑最高的人、補後驗最乾淨的人），不是亂數。
 *     λ = 0.8 時自我對打（第 29 回合預設 500 局）的不照派率 33.5%（隊長不在第 1 局的隊上 42.9%、在 13.6%），強者真人 41.0%／18.5%。
 *     替代的隊仍然要過好人的邏輯閘門、隊長自己湖的宣告（`goodVouchTeamConstraint`）與自己的投票規則（`ownVoteRejects`）。
 *   - `merlinR2Public`（要和 `loyalR2Reuse` 一起開）：見 `merlinR2PublicTeam`。
 *   - `goodLakeEntropy`（藍方持湖）：見 `publicLakeGain`。
 *
 * 第 30 回合結果（`docs/ai/optimization_loop.md` 第 30 回合）：四個都**沒有採用**（預設關）。`loyalR2Reuse` 自我對打 −0.6（0.85）、量尺忠臣派隊變差，
 * 強者點逐點一致 71.7 → 52.6%（Edward 2026-11-05：不照總比例調，看同一個 INFL 點的逐點一致）；`merlinR2Public` 一起開 −0.5；`goodReuseNoMatchPoint` 中性；
 * `goodLakeEntropy` 自我對打正、但和強者同一點的湖目標一致 27% → 9%，交給 Edward。本回合採用的是 `beliefLeadStrong`（`AgentTuning`）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean, bayesWorlds } from './belief/BayesBelief';
import { goodVouchTeamConstraint } from './GoodLakeFollowUp';
import { ownVoteRejects } from './GoodLeadConsistent';
import { loyalViewOf } from './RedR1Teammate';
import { anotherLakeFollows } from './GoodLakeInfo';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** The R1 team when this is a non-forced R2 pick after a clean R1 success (no fail card); otherwise null. */
export function r1SuccessTeam(obs: PlayerObservation): string[] | null {
  if ((obs.currentRound ?? 1) !== 2 || (obs.failCount ?? 0) >= 4) return null;
  if (obs.questResults[0] !== 'success') return null;
  const q1 = obs.questHistory.find((q) => q.round === 1);
  if (!q1 || (q1.failCount ?? 0) > 0) return null;
  return [...q1.team];
}

/**
 * `loyalR2Reuse`: the loyal / Percival R2 leader's alternative to re-proposing the successful R1 team — the cleanest team (with the
 * leader, without the whole R1 team) when it is at least λ times as clean as the chosen re-proposal; otherwise the action unchanged.
 */
export function loyalR2ReuseTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  const lambda = tuning.loyalR2Reuse ?? 0;
  if (!(lambda > 0) || action.type !== 'team_select' || obs.myTeam !== 'good') return action;
  if (obs.myRole !== 'loyal' && obs.myRole !== 'percival') return action;
  const r1 = r1SuccessTeam(obs);
  if (!r1 || !r1.every((id) => action.teamIds.includes(id))) return action;
  const opts = bayesOptionsOf(tuning);
  const base = bayesTeamClean(obs, action.teamIds, opts);
  if (base === null) return action;
  const me = obs.myPlayerId;
  const vouch = tuning.goodVouchFollowUp ? goodVouchTeamConstraint(obs) : null;
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), action.teamIds.length - 1)) {
    const team = [me, ...fill];
    if (r1.every((id) => team.includes(id))) continue;
    const p = bayesTeamClean(obs, team, opts) ?? 0;
    if (p <= bestP + 1e-12) continue;
    if (!allowed(team)) continue;
    if (vouch && (vouch.banned.some((id) => team.includes(id)) || vouch.required.some((id) => !team.includes(id)))) continue;
    best = team;
    bestP = p;
  }
  if (!best || bestP < lambda * base) return action;
  if (ownVoteRejects(tuning, obs, best)) return action;
  return { type: 'team_select', teamIds: best };
}

/**
 * `merlinR2Public`（和 `loyalR2Reuse` 一起用）：第 1 局成功的隊上沒有梅林看得到的紅時，梅林照「同一座位、只看公開紀錄的忠臣」的 `loyalR2Reuse` 決定照不照派——
 * 公開視角的忠臣會改派的時候梅林也改派同一隊（那一隊有他看得到的紅就維持照派，裁定 5）。第 1 局的隊有他看得到的紅時照舊（`merlinReuseNoEarly` 一定不照派）。
 * 只用 `loyalR2Reuse` 只讓忠臣／派西在乾淨的第 1 局隊上也不照派，刺客 `assassinReuseRead=12` 把「乾淨的照派隊沒照派」讀成 ×0.3（不像梅林：梅林看得到那一隊乾淨、
 * 一定照派）；梅林照公開視角做同一件事，這個讀法就不再分得出梅林（D3：同樣公開資訊的忠臣也會做的事）。第 2 局非強制的提議在自我對打幾乎都會被否決（第 1、2 局隊外贊成約 0%），
 * 所以這是訊號，不是任務的代價。
 */
export function merlinR2PublicTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  publicAllowed: (team: readonly string[]) => boolean = () => true,
): AgentAction {
  if (tuning.merlinR2Public !== true || !((tuning.loyalR2Reuse ?? 0) > 0)) return action;
  if (obs.myRole !== 'merlin' || action.type !== 'team_select') return action;
  const r1 = r1SuccessTeam(obs);
  if (!r1 || r1.some((id) => obs.knownEvils.includes(id)) || !r1.every((id) => action.teamIds.includes(id))) return action;
  const alt = loyalR2ReuseTeam(tuning, loyalViewOf(obs), action, publicAllowed);
  if (alt === action || alt.type !== 'team_select' || alt.teamIds.some((id) => obs.knownEvils.includes(id))) return action;
  return alt;
}

// ── 藍方持湖：場上共同資訊的期望增加（`goodLakeEntropy`；Edward 2026-11-05）──────────────

/**
 * Edward 2026-11-05：「藍方湖中其實不是一定要湖誰 而是要符合當下局勢 並且讓場上共同資訊最大化（可以從 entropy 的角度去看）」；
 * 「湖中的動作本身是否能被信任…如果湖完資訊量很大，但這個湖中本身不被信任，那其實共同資訊可能沒有增加最多（湖中是好人也屬於共同資訊之一）」。
 *
 * 場上的共同資訊＝桌上每一個座位（持湖者以外）只看公開紀錄的後驗（忠臣視角，`bayesWorlds`：紅方集合上的分布）。對候選 c，宣告 x ∈ {紅, 藍} 的機率
 * 照同一個後驗的讀法：持湖者在這個世界是藍 → 照實宣告；是紅 → 照後驗讀紅方持湖的那一格（`redLakeEvil`）。所以持湖者本身可不可信（公開視角下他是紅的機率）
 * 直接算在裡面：桌上越懷疑持湖者，宣告越不改變後驗。增益 = H(後驗) − Σ_x P(x)·H(後驗 | 宣告 x)（紅方集合的熵，bits），桌上各座位平均。
 * 宣告之後的後驗＝原本的世界權重乘上宣告的概似（藍的持湖者在和宣告矛盾的世界是 0），和後驗讀湖的方式相同。
 * 候選仍由呼叫端照現行的湖規則過濾（`goodLakeAvoidSet`：自己視角確定的紅、還湖等）；同分照座位序。
 */
export function publicLakeGain(tuning: Readonly<AgentTuning>, obs: PlayerObservation, target: string): number {
  return publicLakeStats(tuning, obs, target).gain;
}

/** `publicLakeGain` plus the table's average public P(target red) (the trust-chain term of `goodLakeEntropy=2`). */
export function publicLakeStats(tuning: Readonly<AgentTuning>, obs: PlayerObservation, target: string): { gain: number; pRed: number } {
  const opts = bayesOptionsOf(tuning);
  const holder = obs.myPlayerId;
  let sum = 0;
  let red = 0;
  let n = 0;
  for (const viewer of obs.allPlayerIds) {
    if (viewer === holder) continue;
    const pub = { ...obs, myPlayerId: viewer, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [], publicLoyalView: true, gamePhase: 'team_vote' } as PlayerObservation;
    const { worlds, wts, bitOf, redLakeEvil } = bayesWorlds(pub, opts);
    if (worlds.length === 0) continue;
    const hb = bitOf(holder);
    const tb = bitOf(target);
    const pRedEvil = redLakeEvil(true);
    const pGoodEvil = redLakeEvil(false);
    const h0 = entropyOf(wts);
    // Weights after each declaration (unnormalised) and their totals = P(declaration).
    const ev: number[] = [];
    const gd: number[] = [];
    worlds.forEach((w, i) => {
      const tRed = (w & tb) !== 0;
      const pEvil = (w & hb) !== 0 ? (tRed ? pRedEvil : pGoodEvil) : tRed ? 1 : 0;
      ev.push(wts[i] * pEvil);
      gd.push(wts[i] * (1 - pEvil));
    });
    const pe = ev.reduce((a, b) => a + b, 0);
    const pg = gd.reduce((a, b) => a + b, 0);
    const after = (pe > 0 ? pe * entropyOf(ev.map((x) => x / pe)) : 0) + (pg > 0 ? pg * entropyOf(gd.map((x) => x / pg)) : 0);
    sum += h0 - after;
    red += worlds.reduce((a, w, i) => a + ((w & tb) !== 0 ? wts[i] : 0), 0);
    n++;
  }
  return n > 0 ? { gain: sum / n, pRed: red / n } : { gain: 0, pRed: 0.5 };
}

function entropyOf(p: readonly number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log2(x);
  return h;
}

/**
 * `goodLakeEntropy`: 1 = the candidate with the largest expected public information gain; 2 = that gain plus the trust chain (the laked
 * seat holds the next lake: a target the table reads as good makes the next declaration trusted — 「湖中是好人也屬於共同資訊之一」):
 * score = ΔH(c) + (1 − 2·P_table(c red))·V, V = max ΔH now (the value of one more trusted lake), only when another lake follows and red
 * has fewer than two fails (as `goodLakeInfoMax`). Ties by seat order; null when off.
 */
export function pickGoodLakeTargetEntropy(tuning: Readonly<AgentTuning>, obs: PlayerObservation, candidates: readonly string[]): string | null {
  const mode = tuning.goodLakeEntropy ?? 0;
  if (!(mode > 0) || obs.myTeam !== 'good' || candidates.length === 0) return null;
  const stats = obs.allPlayerIds.filter((id) => candidates.includes(id)).map((id) => ({ id, ...publicLakeStats(tuning, obs, id) }));
  const v = Math.max(0, ...stats.map((x) => x.gain));
  const chain = mode >= 2 && anotherLakeFollows(obs) && obs.questResults.filter((r) => r === 'fail').length < 2 ? 1 : 0;
  let best: string | null = null;
  let bestS = -Infinity;
  for (const x of stats) {
    const sc = x.gain + chain * (1 - 2 * x.pRed) * v;
    if (sc > bestS + 1e-9) { bestS = sc; best = x.id; }
  }
  return best;
}
