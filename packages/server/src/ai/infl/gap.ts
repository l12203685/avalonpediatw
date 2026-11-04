/**
 * 機器人 vs 強者真人的投票差距診斷（Edward 2026-11-04 第 2 點：一套讀人的模型擬合強者，機器人往它收斂；
 * 「機器人行為 − 強者模型」是每回合要縮小的診斷；docs/ai/strong_metrics.md）。
 *
 * 同一個 INFL 策略模型（`policyModel.ts` 的邏輯迴歸、`voteFeatures.ts` 的特徵）擬合兩次：強者群組的票、自我對打裡機器人的票。
 * 在同一組決策點上比較兩個模型的 P(贊成)：|Δp| 與 KL(強者 ‖ 機器人)。決策點依「處境」分類（`situationOf`，全部從特徵讀）。
 */
import { BASE_FEATURES, EXTRA_FEATURES, N_BASE, type RoleClass } from './voteFeatures';

const B = (name: (typeof BASE_FEATURES)[number]): number => BASE_FEATURES.indexOf(name);
const E = (name: (typeof EXTRA_FEATURES)[number]): number => N_BASE + EXTRA_FEATURES.indexOf(name);

export function roundOf(x: ArrayLike<number>): number {
  for (const r of [2, 3, 4, 5] as const) if (x[B(`r${r}` as 'r2')] === 1) return r;
  return 1;
}

export function attemptOf(x: ArrayLike<number>): number {
  for (const a of [2, 3, 4] as const) if (x[B(`att${a}` as 'att2')] === 1) return a;
  return 1;
}

export function campClassOf(cls: RoleClass): '藍' | '梅林' | '紅' {
  return cls === 'blue' ? '藍' : cls === 'merlin' ? '梅林' : '紅';
}

/** 粗分類：回合段 × 在不在隊上 × 陣營。 */
export function coarseSituation(x: ArrayLike<number>, cls: RoleClass): string {
  const r = roundOf(x);
  return `${r <= 2 ? 'R1-2' : r === 5 ? 'R5' : `R${r}`}·${x[B('on')] === 1 ? '隊上' : '隊外'}·${campClassOf(cls)}`;
}

/**
 * 細分類（前 10 名用）：回合、第幾次（1 / 2–3 / 4）、陣營、位置（隊長／隊上／隊外）、忠臣視角的乾淨度
 * （必有紅 / < 10% / 10–30% / 30–60% / ≥ 60%；第 1 局隊外三人隊在均分下約 12%）、局勢（紅兩勝／藍兩勝）、私訊（紅：隊上有沒有隊友；梅林：隊上有沒有看得到的紅）。
 */
export function situationOf(x: ArrayLike<number>, cls: RoleClass): string {
  const r = roundOf(x);
  const a = attemptOf(x);
  const on = x[B('on')] === 1;
  const leader = x[B('leader')] === 1;
  const pos = leader ? (on ? '隊長' : '隊長不在隊上') : on ? '隊上' : '隊外';
  const p = x[B('pClean')];
  const clean = x[B('provRed')] === 1 ? '必有紅' : p < 0.1 ? '乾淨<10%' : p < 0.3 ? '乾淨10–30%' : p < 0.6 ? '乾淨30–60%' : '乾淨≥60%';
  const state = x[B('keyRound')] === 1 ? '·紅兩勝' : x[B('blueTwo')] === 1 ? '·藍兩勝' : '';
  const camp = campClassOf(cls);
  const priv = camp === '紅' ? (x[E('allyAny')] === 1 ? '·有隊友' : '·沒隊友') : camp === '梅林' ? (x[E('seenRed')] === 1 ? '·看到紅' : '·沒看到紅') : '';
  return `R${r}-${a === 1 ? '1' : a === 4 ? '4' : '2/3'}·${camp}·${pos}·${clean}${state}${priv}`;
}

const clip = (p: number): number => Math.min(1 - 1e-4, Math.max(1e-4, p));

/** 伯努利 KL(p ‖ q)（bits）。 */
export function bernoulliKL(p: number, q: number): number {
  const a = clip(p);
  const b = clip(q);
  return a * Math.log2(a / b) + (1 - a) * Math.log2((1 - a) / (1 - b));
}

export interface GapCell {
  n: number;
  ps: number;
  pb: number;
  absDiff: number;
  kl: number;
  /** 強者實際贊成。 */
  human: number;
  /** 機器人重播在同一點贊成（有就算）。 */
  botReplay: number;
  botReplayN: number;
}

export class GapTable {
  readonly cells = new Map<string, GapCell>();
  add(key: string, ps: number, pb: number, human: boolean, botReplay?: boolean): void {
    let c = this.cells.get(key);
    if (!c) { c = { n: 0, ps: 0, pb: 0, absDiff: 0, kl: 0, human: 0, botReplay: 0, botReplayN: 0 }; this.cells.set(key, c); }
    c.n++;
    c.ps += ps;
    c.pb += pb;
    c.absDiff += Math.abs(ps - pb);
    c.kl += bernoulliKL(ps, pb);
    c.human += human ? 1 : 0;
    if (botReplay !== undefined) { c.botReplay += botReplay ? 1 : 0; c.botReplayN++; }
  }

  /** 依「預期不同的票數」= n × 平均 |Δp| 排序，n ≥ minN。 */
  top(k: number, minN = 30): [string, GapCell][] {
    return [...this.cells].filter(([, c]) => c.n >= minN).sort((a, b) => b[1].absDiff - a[1].absDiff).slice(0, k);
  }

  /** 經驗版（不靠模型）：n × |強者實際贊成率 − 機器人重播贊成率|，重播樣本 ≥ minN。 */
  topEmpirical(k: number, minN = 30): [string, GapCell][] {
    const gap = (c: GapCell): number => c.botReplayN * Math.abs(c.human / c.n - c.botReplay / c.botReplayN);
    return [...this.cells].filter(([, c]) => c.botReplayN >= minN).sort((a, b) => gap(b[1]) - gap(a[1])).slice(0, k);
  }
}
