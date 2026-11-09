/**
 * 優化迴圈第 32 回合・藍方（2026-11-05）。Edward 11/05 的新方向（本回合起綁定）：
 *   1.「全面換成強者真人表 判斷更準比較重要 勝率應該從其他玩法或策略上調整」——讀人模型全面換成強者表（`beliefStrongTables`，投票也換），
 *      勝率從玩法與策略拿回來，不從讀人模型拿。
 *   2.「不是只看當下共同資訊增加最多 也要看未來可能延續的共同資訊 所以藍方好人湖中鏈很重要」——見 `goodLakeChain`。
 *   3. 先把藍方拉到約 35%（忠臣 → 梅林 → 派西）；紅方凍結在現行預設。
 *
 * 本檔的開關（預設關，走勝率協定；每個候選都報強者同一個 INFL 點的逐點一致）：
 *   - `goodLakeChain`（藍方持湖）：見 `lakeChainValues`。
 *   - `goodOnTeamSuspect`（忠臣／派西在隊上的票）：見 `onTeamSuspectKeeps`。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { AVALON_CONFIG } from '@avalon/shared';
import { bayesOptionsOf, bayesRedShare, bayesWorlds } from './belief/BayesBelief';
import { buildWorlds } from './GoodLakeInfo';

// ── 藍方持湖：之後整場的共同資訊（`goodLakeChain`；Edward 2026-11-05「好人湖中鏈」）──────────────

function entropyOf(p: readonly number[]): number {
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log2(x);
  return h;
}

/** Lakes left in the game including the one being decided now (10 人局：第 2、3、4 局之後各一次；`currentRound` = 剛結束的那一局). */
export function lakesLeft(obs: PlayerObservation): number {
  const rounds = AVALON_CONFIG[obs.playerCount]?.questTeams.length ?? 5;
  return Math.max(0, rounds - (obs.currentRound ?? 1));
}

/** Seats that have held the lake or been laked (the lake can never go back to them). */
function usedLakeSeats(obs: PlayerObservation): Set<string> {
  const used = new Set<string>([obs.myPlayerId]);
  for (const rec of obs.lakeHistory ?? []) { used.add(rec.holderId); used.add(rec.targetId); }
  return used;
}

/**
 * 一個公開視角（`viewer` 以外只看公開紀錄的忠臣）上，從現在起之後每一次湖的期望資訊總和。
 *
 * Edward 11/05：「不是只看當下共同資訊增加最多 也要看未來可能延續的共同資訊 所以藍方好人湖中鏈很重要」。湖會交給被湖的人——被湖的人拿下一次湖，
 * 他的宣告可不可信（桌上讀他是紅的機率）決定下一次湖能增加多少共同資訊；下一次再交給下一個人，一路到最後一次湖。
 * 所以挑目標 c 的價值＝這一次的期望資訊 ＋ 宣告之後的後驗上、c 當持湖者、之後每一次都照同一個準則挑的期望資訊（遞迴到剩下的湖數）。
 * 各次的期望資訊相加等於 H(現在的後驗) − E[H(最後一次湖之後的後驗)]：整場剩下的湖帶來的共同資訊，不只當下這一次。
 * 宣告的概似和第 30 回合 `publicLakeGain` 相同：持湖者在這個世界是藍 → 照實；是紅 → 照後驗讀紅方持湖的那一格（`redLakeEvil`）。
 * 所以每一層都把「持湖者自己可不可信」算在裡面（Edward 先前的補充：湖中本身不被信任，宣告的資訊就少）：被湖的人越像紅，他之後的湖越不值錢——
 * 湖一個比較像藍、而且宣告之後更可信的人，下一次湖與下一次宣告才可信（信任鏈）。
 */
/** 一個圖像的不確定性：`joint` = 紅方集合的熵；`seat` = 每個座位「是紅」的二元熵加總（`goodLakeInfoMax` 的量法：挑隊看的是每個人）。 */
export type LakeMeasure = 'joint' | 'seat';

function uncertainty(worlds: readonly number[], p: readonly number[], bits: readonly number[], measure: LakeMeasure): number {
  if (measure === 'joint') return entropyOf(p);
  let u = 0;
  for (const b of bits) {
    let q = 0;
    worlds.forEach((w, i) => { if ((w & b) !== 0) q += p[i]; });
    if (q > 1e-12 && q < 1 - 1e-12) u -= q * Math.log2(q) + (1 - q) * Math.log2(1 - q);
  }
  return u;
}

function chainValueOneView(
  worlds: readonly number[], wts: readonly number[], bitOf: (id: string) => number, ids: readonly string[],
  holder: string, candidates: readonly string[], used: ReadonlySet<string>, depth: number, pRedEvil: number, pGoodEvil: number,
  measure: LakeMeasure,
): Map<string, { now: number; future: number }> {
  const out = new Map<string, { now: number; future: number }>();
  const bits = ids.map((id) => bitOf(id));
  const U = (w: readonly number[], tot: number): number => uncertainty(worlds, w.map((x) => x / tot), bits, measure);
  const rec = (w0: readonly number[], h: string, cands: readonly string[], usedNow: ReadonlySet<string>, k: number): number => {
    if (k <= 0 || cands.length === 0) return 0;
    let best = 0;
    for (const c of cands) { const r = one(w0, h, c, usedNow, k); best = Math.max(best, r.now + r.future); }
    return best;
  };
  // Expected information of laking `c` by holder `h` on (unnormalised) weights `w0`, plus the best continuation (c holds next).
  const one = (w0: readonly number[], h: string, c: string, usedNow: ReadonlySet<string>, k: number): { now: number; future: number } => {
    const tot = w0.reduce((x, y) => x + y, 0);
    if (!(tot > 0)) return { now: 0, future: 0 };
    const hb = bitOf(h);
    const cb = bitOf(c);
    const ev: number[] = [];
    const gd: number[] = [];
    worlds.forEach((w, i) => {
      const cRed = (w & cb) !== 0;
      const pEvil = (w & hb) !== 0 ? (cRed ? pRedEvil : pGoodEvil) : cRed ? 1 : 0;
      ev.push(w0[i] * pEvil);
      gd.push(w0[i] * (1 - pEvil));
    });
    const pe = ev.reduce((x, y) => x + y, 0);
    const pg = gd.reduce((x, y) => x + y, 0);
    const h0 = U(w0, tot);
    let after = 0;
    let future = 0;
    const nextUsed = new Set(usedNow);
    nextUsed.add(c);
    const nextCands = k > 1 ? ids.filter((id) => !nextUsed.has(id)) : [];
    for (const [wx, px] of [[ev, pe], [gd, pg]] as const) {
      if (!(px > 0)) continue;
      after += (px / tot) * U(wx, px);
      if (k > 1) future += (px / tot) * rec(wx, c, nextCands, nextUsed, k - 1);
    }
    return { now: h0 - after, future };
  };
  for (const c of candidates) out.set(c, one(wts, holder, c, used, depth));
  return out;
}

/** 量法與深度（`goodLakeChain` 的值 → 設定）。 */
export interface LakeChainSpec { depth: number; untrusted: boolean; measure: LakeMeasure; facts?: boolean }

export function lakeChainSpec(mode: number, left: number): LakeChainSpec | null {
  if (!(mode > 0) || left <= 0) return null;
  if (mode === 5) return { depth: left, untrusted: true, measure: 'seat', facts: true };
  return { depth: mode === 3 ? Math.min(2, left) : left, untrusted: mode !== 2, measure: mode === 4 ? 'seat' : 'joint' };
}

/**
 * `goodLakeChain=5`：共同資訊只算大家都同意的事實——任務結果與湖的宣告（`goodLakeInfoMax` 的共同圖像：`GoodLakeInfo.buildWorlds` 公開紀錄＋持湖者是藍），
 * 不算各人用票、派隊讀出來的後驗；量法 = 每個座位的二元熵加總，遞迴到剩下的湖數，之後的持湖者是紅時宣告不帶目標的資訊。
 * 真人局（`_r32_lakec`）：最後一次湖（沒有之後）用完整後驗挑的人和強者一致 20%，用這個共同圖像 29%——真人湖的資訊是「任務上連在一起的人」。
 */
function factChainParts(obs: PlayerObservation, candidates: readonly string[], spec: LakeChainSpec): Map<string, { now: number; future: number }> {
  const ws = buildWorlds(obs, false, true);
  const worlds0 = ws.length > 0 ? ws : buildWorlds(obs, false, false);
  const ids = obs.allPlayerIds;
  const bit = new Map(ids.map((id, i) => [id, 1 << i] as const));
  const tot = worlds0.reduce((a, w) => a + w.w, 0);
  if (!(tot > 0)) return new Map();
  return chainValueOneView(worlds0.map((w) => w.mask), worlds0.map((w) => w.w / tot), (id) => bit.get(id) ?? 0, ids, obs.myPlayerId, candidates, usedLakeSeats(obs), spec.depth, 0.5, 0.5, spec.measure);
}

/** 每個候選的這一次（now）與之後（future）的期望共同資訊，桌上持湖者以外每一個座位的公開視角平均（診斷與 `lakeChainValues` 共用）。 */
export function lakeChainParts(tuning: Readonly<AgentTuning>, obs: PlayerObservation, candidates: readonly string[], spec: LakeChainSpec): Map<string, { now: number; future: number }> {
  const out = new Map<string, { now: number; future: number }>();
  if (candidates.length === 0) return out;
  if (spec.facts === true) return factChainParts(obs, candidates, spec);
  const opts = bayesOptionsOf(tuning);
  const holder = obs.myPlayerId;
  const used = usedLakeSeats(obs);
  let n = 0;
  for (const viewer of obs.allPlayerIds) {
    if (viewer === holder) continue;
    const pub = { ...obs, myPlayerId: viewer, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [], publicLoyalView: true, gamePhase: 'team_vote' } as PlayerObservation;
    const { worlds, wts, bitOf, redLakeEvil } = bayesWorlds(pub, opts);
    if (worlds.length === 0) continue;
    const pr = redLakeEvil(true);
    const pg = redLakeEvil(false);
    const q = (pr + pg) / 2;
    const vals = chainValueOneView(worlds, wts, bitOf, obs.allPlayerIds, holder, candidates, used, spec.depth, spec.untrusted ? q : pr, spec.untrusted ? q : pg, spec.measure);
    for (const [c, v] of vals) { const o = out.get(c) ?? { now: 0, future: 0 }; out.set(c, { now: o.now + v.now, future: o.future + v.future }); }
    n++;
  }
  if (n > 0) for (const [c, v] of out) out.set(c, { now: v.now / n, future: v.future / n });
  return out;
}

/**
 * `goodLakeChain`：每個候選的「之後整場的共同資訊」（`chainValueOneView`），桌上持湖者以外每一個座位的公開視角平均。
 * 紅方持湖者的宣告怎麼讀：
 *   - 1、3、4（「不被信任的湖不增加共同資訊」）：紅的持湖者會照對紅方最有利的方式宣告，所以他的宣告和目標的真相無關（宣告紅的機率 = 後驗紅方持湖那一格對紅、藍目標的平均）——
 *     持湖者是紅的那些世界裡，宣告不帶任何目標的資訊；桌上越懷疑持湖者，這次湖的共同資訊越少。這就是 Edward 的「湖中的動作本身是否能被信任」：
 *     湖到一個桌上讀成藍的人，他之後的湖才算數。
 *   - 2：照後驗的紅方持湖那一格解讀（和第 30 回合 `publicLakeGain` 相同：紅的持湖者也照表宣告，反著讀仍然有資訊）。
 * 深度：1、2、4、5 = 遞迴到剩下的湖數；3 = 只看這一次與下一次。量法：4、5 = 每個座位的二元熵加總，其他 = 紅方集合的熵。
 * 5 = 共同圖像只用任務與湖的事實（`factChainParts`）。0 = 關（回傳空的表）。
 */
export function lakeChainValues(tuning: Readonly<AgentTuning>, obs: PlayerObservation, candidates: readonly string[]): Map<string, number> {
  const spec = lakeChainSpec(tuning.goodLakeChain ?? 0, lakesLeft(obs));
  const out = new Map<string, number>();
  if (!spec) return out;
  const w = (tuning.goodLakeChainFuture ?? 0) > 0 ? tuning.goodLakeChainFuture : 1;
  for (const [c, v] of lakeChainParts(tuning, obs, candidates, spec)) out.set(c, v.now + w * v.future);
  return out;
}

/** `goodLakeChain`: the candidate with the largest chain value (ties by seat order); null when off or not a good holder. */
export function pickGoodLakeTargetChain(tuning: Readonly<AgentTuning>, obs: PlayerObservation, candidates: readonly string[]): string | null {
  if (!((tuning.goodLakeChain ?? 0) > 0) || obs.myTeam !== 'good' || candidates.length === 0) return null;
  const vals = lakeChainValues(tuning, obs, candidates);
  let best: string | null = null;
  let bestV = -Infinity;
  for (const id of obs.allPlayerIds) {
    if (!candidates.includes(id)) continue;
    const v = vals.get(id) ?? 0;
    if (v > bestV + 1e-9) { bestV = v; best = id; }
  }
  return best;
}

// ── 忠臣／派西在隊上的內黑要指得出是誰（`goodOnTeamSuspect`）──────────────

/**
 * 強者差距第 1 名（`strong_metrics.md` 第 3、5 節）：第 3 局起藍方在隊上的內黑率 機器人 53%（強者表）、強者 25%。真人局強者藍方座位（`_r32_votes`，強者表後驗）：
 * 在隊上、這隊乾淨的機率 0.1–0.2 時強者仍然贊成 70%（隊上真的有紅 76%）；強者在隊上反對的時候，隊上多半有一個很可疑的人——
 * 隊上（自己以外）最可疑的人紅的機率 ≥ 0.95 時強者贊成 33–34%，< 0.3 時 87%。用門檻比「這隊乾淨的機率」逐點一致最多約 73%（一律贊成 71.8%）；
 * 現行 0.3 的門檻 52.7%。
 *
 * 邏輯：這隊乾淨的機率低，如果只是因為隊上每個人都還不確定（這個階段任何一隊的基準），否決只是把隊長交給下一個人，換來的隊有同樣的基準，
 * 還少了一次提議；指得出一個很可能是紅的人，否決才換得到東西（下一個隊長可以拿掉他）。
 * 規則：自己在隊上、第 3 局起、非強制、忠臣／派西（梅林照忠臣投票時也走這裡），`goodCleanVote`／`goodKeyVote` 要投黑，但隊上（自己以外）
 * 每個人紅的機率都 < t → 不投黑（回傳 true = 保留白）。
 */
export function onTeamSuspectKeeps(tuning: Readonly<AgentTuning>, obs: PlayerObservation, key = false): boolean {
  // 關鍵局（`goodKeyVote`）用自己的門檻 `goodOnTeamSuspectKey`（0 = 關鍵局照舊）。
  const t = key ? tuning.goodOnTeamSuspectKey ?? 0 : tuning.goodOnTeamSuspect ?? 0;
  if (!(t > 0) || obs.myTeam !== 'good') return false;
  if ((obs.currentRound ?? 1) < 3 || (obs.failCount ?? 0) >= 4) return false;
  const team = obs.proposedTeam ?? [];
  const me = obs.myPlayerId;
  if (!team.includes(me)) return false;
  const share = bayesRedShare(obs, bayesOptionsOf(tuning));
  const top = Math.max(0, ...team.filter((id) => id !== me).map((id) => share.get(id) ?? 0));
  return top < t;
}
