/**
 * 第 90 回合（路線圖 Phase C，Issue #215，`docs/ai/NEXT_GEN_AI_ROADMAP.md`）：用兩顆輕量的監督式模型取代（或疊在）靜態的查表上。
 * 離線訓練：`scripts/ml/`（資料匯出 TypeScript、訓練 numpy，時間切分：照日期前 2/3 擬合、後 1/3 驗證）；這裡只讀純 JSON 權重，執行期零 Python，一次推論 < 1 ms。
 *
 * **第 1 號：世界後驗估值器**（`mlBelief90`，預設 0 = 關；關著時這個檔案不改任何東西）——藍方座位（忠臣；位元 1 加派西）的信念：
 * 1. 現行信念照舊算出 210 個紅方世界的權重（精確列舉＋真人表的概似）；
 * 2. 模型對另外每一個人估 P(紅)（`ml/beliefFeatures90.ts` 的特徵：誰上過哪幾次任務與失敗張數、票和隊伍、提議的樣子、湖的結果與宣告、座位與隊長順序，
 *    再加現行信念與「只用規則」的機率）；`mlBelief90 = 1` = 疊加版（從現行信念的 logit 出發、樹只學修正，`ml/belief90.json`）、
 *    `= 2` = 取代版（不用現行的表，只用規則＋特徵，`ml/belief90Pure.json`；起點是 L1* 世界均分）；
 * 3. 把世界的權重往模型的邊際機率傾斜（迭代比例調整：每一個人「在／不在紅方世界」的權重各乘一個倍數，直到每個人的紅機率等於模型說的；
 *    先把模型的機率在 logit 上平移，讓不確定的人的紅數總和等於世界裡的紅數），所以「這隊乾淨的機率」等所有讀世界的決策都跟著用新的後驗，
 *    規則推得出來的確定點（p = 0／1）不會變。
 * `mlBelief90Scope`（位元）：1 = 派西也用；2 = 隊長派隊時不用（只用在投票）；4 = 梅林座位的公開忠臣視角也用；8 = 模型與現行各一半（logit 平均）。
 *
 * **第 2 號：三藍刺殺估值器**（`mlAssassin90`，預設 0 = 關）：刺殺時四個紅方開牌，每個候選人的 P(梅林 | 公開紀錄, 紅方角色)
 * （`ml/assassinFeatures90.ts`：現行世界線刺客的邊際與分量、分層、跨回合的派隊／票／任務／湖、座位），真人局＋自我對打一起擬合（`ml/assassin90.json`）。
 * `= 1`：現行分層裡改用模型的分數取最高；`= 2`：不分層，所有候選人照模型取最高；`= 3`／`= 4`：同 1／2，但用只用真人局擬合的那一份（`ml/assassin90Human.json`）。
 * 重新擬合協定：藍方改了（例如開第 1 號），用新藍方的自我對打重新擬合第 2 號、再量一次（`scripts/ml/train90.py assassin --bot ...`）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { MlModel90, logit, type ModelJson } from './ml/mlModel90';
import { BELIEF_FEATURES_90, beliefFeatures90 } from './ml/beliefFeatures90';
import { ASSASSIN_FEATURES_90, assassinFeatures90 } from './ml/assassinFeatures90';
import BELIEF_STACK from './ml/belief90.json';
import BELIEF_PURE from './ml/belief90Pure.json';
import ASSASSIN from './ml/assassin90.json';
import ASSASSIN_HUMAN from './ml/assassin90Human.json';

let beliefStack: MlModel90 | null = null;
let beliefPure: MlModel90 | null = null;
let assassinModel: MlModel90 | null = null;
let assassinHuman: MlModel90 | null = null;

/** 第 1 號模型（1 = 疊加版、2 = 取代版）。 */
export function beliefModel90(kind: 1 | 2): MlModel90 {
  if (kind === 1) return (beliefStack ??= new MlModel90(BELIEF_STACK as unknown as ModelJson, BELIEF_FEATURES_90));
  return (beliefPure ??= new MlModel90(BELIEF_PURE as unknown as ModelJson, BELIEF_FEATURES_90));
}

/** 第 2 號模型：`human` = 只用真人局擬合的那一份（`ml/assassin90Human.json`）；否則真人局＋自我對打（`ml/assassin90.json`）。 */
export function assassinModel90(human = false): MlModel90 {
  if (human) return (assassinHuman ??= new MlModel90(ASSASSIN_HUMAN as unknown as ModelJson, ASSASSIN_FEATURES_90));
  return (assassinModel ??= new MlModel90(ASSASSIN as unknown as ModelJson, ASSASSIN_FEATURES_90));
}

/** 測試／研究用：換一份第 2 號模型（null = 回到正式的）。 */
export function setAssassinModel90(json: ModelJson | null): void {
  assassinModel = json ? new MlModel90(json, ASSASSIN_FEATURES_90) : null;
}

/** 診斷計數（不影響決策）。 */
export const round90Stats = { belief: 0, beliefPercival: 0, assassin: 0, assassinChanged: 0 };

export interface Ml90Cfg {
  model: 1 | 2;
  percival: boolean;
  noPicks: boolean;
  publicViews: boolean;
  half: boolean;
}

/** `BayesOptions.ml90`：開關的設定；關著 = undefined。 */
export function ml90Cfg(t: Readonly<Partial<AgentTuning>>): Ml90Cfg | undefined {
  const m = t.mlBelief90 ?? 0;
  if (m !== 1 && m !== 2) return undefined;
  const s = t.mlBelief90Scope ?? 0;
  return { model: m, percival: (s & 1) !== 0, noPicks: (s & 2) !== 0, publicViews: (s & 4) !== 0, half: (s & 8) !== 0 };
}

export const ml90Key = (c: Ml90Cfg): string => `ml90|${c.model}|${c.percival ? 1 : 0}${c.noPicks ? 1 : 0}${c.publicViews ? 1 : 0}${c.half ? 1 : 0}`;

/** 這個觀察用不用第 1 號：藍方座位（紅方凍結）的忠臣（派西要位元 1）；公開忠臣視角要位元 4；位元 2 = 派隊時不用。 */
export function ml90Applies(cfg: Ml90Cfg | undefined, obs: PlayerObservation): boolean {
  if (!cfg) return false;
  if ((obs.seatTeam ?? obs.myTeam) !== 'good' || obs.redLoyalView === true || obs.myTeam !== 'good') return false;
  if (obs.publicLoyalView === true && !cfg.publicViews) return false;
  if (cfg.noPicks && obs.gamePhase === 'team_select') return false;
  if (obs.allPlayerIds.length !== 10) return false;
  if (obs.myRole === 'loyal') return true;
  return cfg.percival && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2 && obs.publicLoyalView !== true;
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const CERTAIN = 1e-9;

/**
 * 世界的權重往目標邊際傾斜（迭代比例調整）。`worlds` = 紅方世界的位元遮罩、`w0` = 起點權重（和為 1）、`targets` = 座位位元 → 目標 P(紅)。
 * 起點權重裡確定（0／1）的座位不動；目標先在 logit 上平移，讓不確定座位的紅數總和等於世界裡的紅數。回傳新的權重（和為 1）。
 */
export function tiltWorlds90(worlds: readonly number[], w0: readonly number[], targets: ReadonlyArray<readonly [number, number]>, sweeps = 12): number[] {
  const w = [...w0];
  const marg = (b: number): number => { let s = 0; for (let k = 0; k < worlds.length; k++) if (worlds[k] & b) s += w[k]; return s; };
  const live: { b: number; z: number }[] = [];
  let K = 0;
  for (const [b, q] of targets) {
    const m = marg(b);
    if (m <= CERTAIN || m >= 1 - CERTAIN) continue;
    K += m;
    live.push({ b, z: logit(q, 1e-6) });
  }
  if (!live.length) return w;
  // Shift so that Σ σ(z + c) = K (bisection; monotone in c).
  let lo = -30; let hi = 30;
  for (let it = 0; it < 60; it++) {
    const c = (lo + hi) / 2;
    let s = 0;
    for (const x of live) s += sigmoid(x.z + c);
    if (s > K) hi = c; else lo = c;
  }
  const c = (lo + hi) / 2;
  const q = live.map((x) => sigmoid(x.z + c));
  for (let sw = 0; sw < sweeps; sw++) {
    for (let i = 0; i < live.length; i++) {
      const b = live[i].b;
      const m = marg(b);
      if (m <= CERTAIN || m >= 1 - CERTAIN) continue;
      const a = q[i] / m;
      const r = (1 - q[i]) / (1 - m);
      for (let k = 0; k < worlds.length; k++) w[k] *= (worlds[k] & b) ? a : r;
    }
  }
  const tot = w.reduce((x, y) => x + y, 0);
  return tot > 0 ? w.map((x) => x / tot) : [...w0];
}

/**
 * 第 1 號：新的世界權重。`base` = 現行信念的世界與權重（同一組 L1* 世界）。
 */
export function ml90Weights(obs: PlayerObservation, base: { worlds: readonly number[]; wts: readonly number[]; bitOf: (id: string) => number }, cfg: Ml90Cfg): number[] {
  const { worlds, wts, bitOf } = base;
  if (worlds.length === 0) return [...wts];
  const ids = obs.allPlayerIds;
  const shareOf = (ws: readonly number[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const id of ids) {
      const b = bitOf(id);
      let s = 0;
      for (let k = 0; k < worlds.length; k++) if (worlds[k] & b) s += ws[k];
      out.set(id, s);
    }
    return out;
  };
  const uniW = worlds.map(() => 1 / worlds.length);
  const pb = shareOf(wts);
  const pu = shareOf(uniW);
  const model = beliefModel90(cfg.model);
  const fx = beliefFeatures90(obs, cfg.model === 1 ? pb : pu, pu);
  const start = cfg.model === 1 ? wts : uniW;
  const startShare = cfg.model === 1 ? pb : pu;
  const targets: [number, number][] = fx.ids.map((id, i) => {
    let q = model.prob(fx.rows[i]);
    if (cfg.half) q = sigmoid(0.5 * logit(q, 1e-6) + 0.5 * logit(startShare.get(id) ?? 0.5, 1e-6));
    return [bitOf(id), q];
  });
  round90Stats.belief++;
  if (obs.myRole === 'percival') round90Stats.beliefPercival++;
  return tiltWorlds90(worlds, start, targets);
}

/** 第 2 號的模式：0 = 關；1／2 = 真人＋機器人的模型（1 分層裡用、2 不分層）；3／4 = 只用真人局的模型（3 分層裡用、4 不分層）。 */
export function mlAssassinMode90(t: Readonly<Partial<AgentTuning>>): 0 | 1 | 2 | 3 | 4 {
  const m = t.mlAssassin90 ?? 0;
  return m === 1 || m === 2 || m === 3 || m === 4 ? m : 0;
}

/** 第 2 號不分層（模式 2、4）。 */
export const mlAssassinNoTier90 = (t: Readonly<Partial<AgentTuning>>): boolean => { const m = mlAssassinMode90(t); return m === 2 || m === 4; };

/**
 * 第 2 號：刺殺分數換成模型的 log P(梅林 = 座位)。`scores` = 現行的分數（候選人 = 要排的座位）；`front` = 現行分層的第一層。
 * 關著或不適用（沒有紅方開牌、不是十人局）：原封不動的同一個 Map。
 */
export function mlAssassinScores90(t: Readonly<Partial<AgentTuning>>, obs: PlayerObservation, scores: Map<string, number>, front: ReadonlySet<string>): Map<string, number> {
  const mode = mlAssassinMode90(t);
  if (mode === 0) return scores;
  const evil = new Set(obs.allEvilIds ?? []);
  const all = obs.allPlayerIds.filter((id) => !evil.has(id) && id !== obs.myPlayerId);
  const fx = assassinFeatures90(obs, all, front);
  if (!fx) return scores;
  const model = assassinModel90(mode >= 3);
  const p = model.groupProbs(fx.rows);
  const lp = new Map(fx.ids.map((id, i) => [id, Math.log(Math.max(p[i], 1e-12))] as const));
  const out = new Map<string, number>();
  for (const id of scores.keys()) out.set(id, lp.get(id) ?? -30);
  round90Stats.assassin++;
  return out;
}
