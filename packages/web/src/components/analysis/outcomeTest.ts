import { chiSquareIndependence, type ChiSquareResult } from '../../utils/chiSquare';

/**
 * 幾組局的「三種結局比例差這麼多是不是運氣」(卡方檢定，組 × {三紅, 三藍死, 三藍活})。
 * 給 1-1 派票、湖中女神等「分組局」的一句話結論用 (Edward 2026-10-28：結論要從資料算)。
 * 每組的局數可以是英文鍵 (OutcomeBreakdown) 或中文鍵 ({三紅, 三藍死, 三藍活})；缺的組不算。
 * 只用在每局只屬於一組的分組 (互斥)；同一局會算好幾次的分組 (例如以任務為單位的隊長表) 不能用。
 */
export type OutcomeCountsInput =
  | { threeRed?: number; threeBlueDead?: number; threeBlueAlive?: number }
  | { 三紅?: number; 三藍死?: number; 三藍活?: number };

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function outcomeRow(c: OutcomeCountsInput): [number, number, number] {
  const o = c as Record<string, unknown>;
  return [n(o.threeRed ?? o['三紅']), n(o.threeBlueDead ?? o['三藍死']), n(o.threeBlueAlive ?? o['三藍活'])];
}

export function outcomeChiSquare(groups: ReadonlyArray<OutcomeCountsInput | null | undefined>): ChiSquareResult | null {
  const rows = groups.filter((g): g is OutcomeCountsInput => !!g && typeof g === 'object').map(outcomeRow);
  return chiSquareIndependence(rows);
}

/** 紅方最終勝率 % = (三紅 + 三藍死) ÷ 局數；0 局時 null。 */
export function redFinalRate(c: OutcomeCountsInput | null | undefined): number | null {
  if (!c) return null;
  const [r, d, a] = outcomeRow(c);
  const total = r + d + a;
  return total > 0 ? ((r + d) / total) * 100 : null;
}
