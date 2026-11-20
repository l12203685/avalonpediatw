/**
 * featureStudies 的 L139「R3+ 強制 P5 局勢偏移」（generate_cache.compute_forced_p5_feature、_annotate_l139 逐行移植；
 * 站長 2026-11-20「所有跟數字統計有關的 都應該跟資料庫連動 而不是寫死」：產生器每次從牌譜重算 L139，引擎在篩選後的
 * 局上用同一個定義重算，不篩選時與快取逐欄相同，中英文字串也一字不差）。
 *
 * 定義：第 k 輪「打到 P5」= 這局在第 k 輪有第 5 次提議（attempt 5，強制出發的那一隊）。每輪列 n、該組三紅率、
 * 三種結果比例減去全部局的比例（pp）。R1 不列（幾乎每局都打到 1-5，沒有對照組）；R3 另外分有 / 沒有。
 * 比例的分母是該組全部局（結果不是三紅 / 三藍死 / 三藍活的局也算，Python 同）。
 *
 * 數字用 Python 的 round(x, 2)（pyRound2：精確值在第 2 位五成雙）；字串用 pyFormatFixed（f"{x:.1f}"）。
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, OUTCOME_THREE_RED, OUTCOMES } from './constants';
import type { Game } from './dataset';
import { pyFormatFixed } from './pyround';

export interface ForcedP5Row {
  round: string;
  n: number;
  threeRedPct: number;
  deltaThreeRed: number;
  deltaThreeBlueAlive: number;
  deltaThreeBlueDead: number;
}

export interface ForcedP5Side {
  n: number;
  threeRedPct: number;
  deltaBaseline: number;
}

/** featureStudies.features 中 loopId = L139 的那筆（鍵與順序同快取）。 */
export interface ForcedP5Feature {
  loopId: 'L139';
  title: string;
  titleEn: string;
  oneLineHook: string;
  oneLineHookEn: string;
  sampleSize: { games: number };
  visualType: 'line';
  data: {
    axisLabel: string;
    baselineRedPct: number;
    rows: ForcedP5Row[];
    comparison: { withR3Forced: ForcedP5Side; withoutR3Forced: ForcedP5Side };
    note: string;
    noteEn: string;
  };
  takeaway: string;
  takeawayEn: string;
  sourceReport: string;
  computedAt: string;
}

/** Python 的 round(x, 2)（float）：f"{x:.2f}" 與 round(x, 2) 都是精確值在第 2 位五成雙。 */
function pyRound2(x: number): number {
  return Number(pyFormatFixed(x, 2));
}

/** 各結果占這組局的百分比（100 * 次數 / n，運算順序照抄；沒有局時分母當 1）。 */
function shares(games: readonly Game[]): Record<string, number> {
  const n = games.length || 1;
  const out: Record<string, number> = {};
  for (const o of OUTCOMES) {
    let count = 0;
    for (const g of games) if (g.outcome === o) count += 1;
    out[o] = (100 * count) / n;
  }
  return out;
}

/**
 * generate_cache._annotate_l139：結論文字由 R3 那列與基準改寫（沒有 R3 列時 n 印成 Python 的 None，數字當 0）。
 */
export function annotateForcedP5(f: ForcedP5Feature): void {
  const r3 = f.data.rows.find((r) => r.round === 'R3');
  const baseline = f.data.baselineRedPct || 0;
  const delta = r3?.deltaThreeRed || 0;
  const red = pyFormatFixed(r3?.threeRedPct || 0, 1);
  const n = r3 ? String(r3.n) : 'None';
  f.oneLineHook = `R3 出現 forced P5 的局三紅率 ${red}%（n=${n}），`
    + `比基準 ${pyFormatFixed(baseline, 1)}% ${delta >= 0 ? '高' : '低'} ${pyFormatFixed(Math.abs(delta), 1)}pp；但這是選擇偏誤，不是因果`;
  f.oneLineHookEn = `Games with a forced P5 in R3 end 3-red ${red}% of the time (n=${n}), `
    + `${pyFormatFixed(Math.abs(delta), 1)}pp ${delta >= 0 ? 'over' : 'under'} the ${pyFormatFixed(baseline, 1)}% baseline; selection bias, not causation`;
  f.takeaway = 'forced P5（連續五次否決，第五隊強制出發）本身就是局勢已經偏向紅方的結果：藍方掌握不了局面才會一路否決到底，'
    + '這些局本來就比較容易三紅。它只是局勢不利的徵兆，不是「紅方在掩護」的證據，也不能拿來當判斷依據。';
  f.takeawayEn = 'A forced P5 (five straight rejections, fifth team goes) is itself the result of a game already tilting evil: '
    + 'good keeps rejecting because it cannot control the table, so these games were headed for 3-red anyway. '
    + 'It is a symptom of a bad position, not evidence of evil cover, and not a read to act on.';
}

/** generate_cache.compute_forced_p5_feature。`asOf` = computedAt（篩選時是有效 as-of）。 */
export function computeForcedP5Feature(games: readonly Game[], asOf: string): ForcedP5Feature {
  const base = shares(games);
  const forced = games.map((g) => new Set(g.votingProposals.filter((p) => p[1] === 5).map((p) => p[0])));
  const rows: ForcedP5Row[] = [];
  for (const r of [2, 3, 4, 5]) {
    const gs = games.filter((_, i) => forced[i].has(r));
    if (!gs.length) continue; // 這輪沒有局打到 P5：不列（網站顯示 —）
    const sh = shares(gs);
    rows.push({
      round: `R${r}`,
      n: gs.length,
      threeRedPct: pyRound2(sh[OUTCOME_THREE_RED]),
      deltaThreeRed: pyRound2(sh[OUTCOME_THREE_RED] - base[OUTCOME_THREE_RED]),
      deltaThreeBlueAlive: pyRound2(sh[OUTCOME_BLUE_ALIVE] - base[OUTCOME_BLUE_ALIVE]),
      deltaThreeBlueDead: pyRound2(sh[OUTCOME_BLUE_DEAD] - base[OUTCOME_BLUE_DEAD]),
    });
  }
  const side = (gs: readonly Game[]): ForcedP5Side => {
    const red = shares(gs)[OUTCOME_THREE_RED];
    return { n: gs.length, threeRedPct: pyRound2(red), deltaBaseline: pyRound2(red - base[OUTCOME_THREE_RED]) };
  };
  const feature: ForcedP5Feature = {
    loopId: 'L139',
    title: 'R3+ 強制 P5 局勢偏移',
    titleEn: 'Forced P5 Round Outcome Shift',
    oneLineHook: '',
    oneLineHookEn: '',
    sampleSize: { games: games.length },
    visualType: 'line',
    data: {
      axisLabel: 'Δ 三紅 (pp)',
      baselineRedPct: pyRound2(base[OUTCOME_THREE_RED]),
      rows,
      comparison: {
        withR3Forced: side(games.filter((_, i) => forced[i].has(3))),
        withoutR3Forced: side(games.filter((_, i) => !forced[i].has(3))),
      },
      note: 'R1 不列：本社群幾乎每局都打到 1-5（尾派），沒有對照組。',
      noteEn: 'R1 is left out: nearly every game here reaches the forced 1-5, so there is no comparison group.',
    },
    takeaway: '',
    takeawayEn: '',
    sourceReport: 'generate_cache.py',
    computedAt: asOf,
  };
  annotateForcedP5(feature);
  return feature;
}
