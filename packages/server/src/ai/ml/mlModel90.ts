/**
 * 第 90 回合（路線圖 Phase C，Issue #215）：離線訓練（`scripts/ml/train90.py`，只用 numpy）匯出的純 JSON 模型，在這裡用 TypeScript 推論。
 * 執行期零 Python；一個模型就是幾百個小陣列的加總，一次推論是微秒級。
 *
 * 模型格式（`ModelJson`）：
 * - `kind: 'gbdt'`：淺的梯度提升樹。分數 = `init` + `offset` 那一個特徵（係數 1；沒有就 0）+ Σ 每一棵樹的葉子值。
 *   每一棵樹用平行陣列存：節點 i 的 `f[i] < 0` = 葉子（值 `v[i]`）；否則 x[f[i]] ≤ t[i] 走 `l[i]`，不然走 `r[i]`。
 *   特徵值是 NaN 時走 `l[i]`（訓練時沒有 NaN，這只是保險）。
 * - `kind: 'logit'`：線性。分數 = `init` + `offset` + Σ w[k] x[k]。
 * - 二元模型（第 1 號：誰是紅）用 σ(分數)；分組模型（第 2 號：刺殺候選人）在一組候選人裡取 softmax(分數)。
 * `features` 是特徵名稱，載入時和程式裡的特徵清單逐一比對（不一樣就丟錯，避免權重和特徵對錯位）。
 */

export interface TreeJson {
  f: readonly number[];
  t: readonly number[];
  l: readonly number[];
  r: readonly number[];
  v: readonly number[];
}

export interface ModelJson {
  version: string;
  kind: 'gbdt' | 'logit';
  /** 'binary'：σ(分數)；'group'：一組裡取 softmax。 */
  objective: 'binary' | 'group';
  features: readonly string[];
  /** 加進分數、係數 1 的特徵（例如現行信念的 logit）；-1 或沒有 = 不用。 */
  offset?: number;
  init: number;
  trees?: readonly TreeJson[];
  w?: readonly number[];
  /** 訓練資料、切分、樣本外分數等說明（只給人看）。 */
  meta?: Record<string, unknown>;
}

export class MlModel90 {
  readonly json: ModelJson;
  private readonly off: number;

  constructor(json: ModelJson, expectFeatures?: readonly string[]) {
    if (expectFeatures) {
      const a = json.features.join(',');
      const b = expectFeatures.join(',');
      if (a !== b) throw new Error(`MlModel90 ${json.version}: feature list mismatch`);
    }
    if (json.kind === 'gbdt' && !json.trees) throw new Error(`MlModel90 ${json.version}: no trees`);
    if (json.kind === 'logit' && (!json.w || json.w.length !== json.features.length)) throw new Error(`MlModel90 ${json.version}: bad weights`);
    this.json = json;
    this.off = json.offset !== undefined && json.offset >= 0 ? json.offset : -1;
  }

  /** 原始分數（logit）。 */
  score(x: ArrayLike<number>): number {
    const j = this.json;
    let s = j.init + (this.off >= 0 ? x[this.off] : 0);
    if (j.kind === 'logit') {
      const w = j.w as readonly number[];
      for (let k = 0; k < w.length; k++) s += w[k] * x[k];
      return s;
    }
    const trees = j.trees as readonly TreeJson[];
    for (let ti = 0; ti < trees.length; ti++) {
      const t = trees[ti];
      let i = 0;
      while (t.f[i] >= 0) {
        const v = x[t.f[i]];
        i = v > t.t[i] ? t.r[i] : t.l[i];
      }
      s += t.v[i];
    }
    return s;
  }

  /** 二元模型的機率。 */
  prob(x: ArrayLike<number>): number {
    const z = this.score(x);
    return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
  }

  /** 分組模型：一組候選人的 softmax 機率（同序）。 */
  groupProbs(xs: readonly ArrayLike<number>[]): number[] {
    const z = xs.map((x) => this.score(x));
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const tot = e.reduce((a, b) => a + b, 0);
    return e.map((v) => v / tot);
  }
}

export const logit = (p: number, eps = 1e-4): number => {
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
};
