import type { ReactNode } from 'react';
import { Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { chiSquareVerdict, formatPValue, type ChiSquareResult } from '../../../utils/chiSquare';
import Term from './Term';

/**
 * Takeaway — 分析小分頁最上面的一句話結論 (Edward 2026-10-28：「應該可以呈現更直觀的結果」)。
 * 句子裡的數字一律是畫面當下從資料算的 (呼叫端組字)，或是定義；不寫死任何結論。
 */
export function Takeaway({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-zinc-200 sm:text-[13px] ${className}`}
    >
      <Lightbulb size={14} className="mt-0.5 shrink-0 text-amber-300" aria-hidden />
      <div className="min-w-0 space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * 卡方檢定的白話判讀：「差異明顯（p≈0.002）」或「差異可能只是運氣（p≈0.19）」；p 那段可以點開看定義 (Term)。
 * result = null (沒有東西可比) 時不顯示。
 */
export function VerdictText({ result }: { result: ChiSquareResult | null }): JSX.Element | null {
  const { t } = useTranslation('common');
  if (!result) return null;
  const verdict = chiSquareVerdict(result);
  const p = formatPValue(result.p);
  return (
    <span>
      <span className={verdict === 'clear' ? 'font-semibold text-amber-300' : 'font-semibold text-zinc-300'}>
        {t(`analytics.r7.verdict.${verdict}`)}
      </span>
      {t('analytics.r7.verdict.open')}
      <Term term="chiSquare">{p.startsWith('<') ? `p${p}` : `p≈${p}`}</Term>
      {t('analytics.r7.verdict.close')}
    </span>
  );
}
