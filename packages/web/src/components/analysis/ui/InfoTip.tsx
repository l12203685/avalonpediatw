import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { openStatsHelp } from '../../../utils/statsHelp';
import { POPOVER_CLASS, usePopover } from './usePopover';

/**
 * InfoTip — 表格／區塊標題旁的小「ⓘ」(Edward 2026-10-30：段落式說明太長，改成滑鼠移過去／點一下再顯示)。
 *
 *  - 桌面滑過、手機點一下打開小視窗，內容是原本寫在表格旁邊／下面的整段說明 (照舊的 i18n 字串)。
 *  - 小視窗末尾「完整說明」→ 說明頁的「統計名詞與算法」(openStatsHelp)。
 *  - 開關、位置與 Term 共用 usePopover。
 */
export interface InfoTipProps {
  /** 小視窗內容；空的 (null / false / '') 不顯示 ⓘ。 */
  children: ReactNode;
  /** 小視窗標題 (通常是表名)。 */
  title?: ReactNode;
  /** 按鈕的無障礙名稱；預設「說明」。 */
  label?: string;
  /** 末尾放「完整說明」連結 (預設 true)。 */
  more?: boolean;
  className?: string;
  /** ⓘ 旁邊的小字 (例：「說明」)；預設只有圖示。 */
  text?: ReactNode;
  /** 測試用。 */
  testId?: string;
}

const POPOVER_WIDTH = 360;

export default function InfoTip({ children, title, label, more = true, className = '', text, testId }: InfoTipProps): JSX.Element | null {
  const { t } = useTranslation('common');
  const { pos, close, triggerProps, panelProps } = usePopover<HTMLButtonElement>(POPOVER_WIDTH);
  if (children === null || children === undefined || children === false || children === '') return null;

  return (
    <>
      <button
        type="button"
        aria-label={label ?? t('analytics.ui.info.label')}
        data-testid={testId ?? 'info-tip'}
        className={`inline-flex shrink-0 cursor-help items-center justify-center gap-0.5 rounded-full p-0.5 align-middle text-[10px] font-normal text-zinc-500 hover:text-amber-300 focus-visible:text-amber-300 focus-visible:outline-none ${pos ? 'text-amber-300' : ''} ${className}`}
        {...triggerProps}
      >
        <Info size={13} aria-hidden />
        {text}
      </button>
      {pos && createPortal(
        <div role="tooltip" className={POPOVER_CLASS} {...panelProps}>
          {title && <div className="mb-1 font-semibold text-white">{title}</div>}
          <div className="space-y-1.5">{children}</div>
          {more && (
            // 內容長、在小視窗裡捲的時候，「完整說明」固定在底部看得到
            <div className="sticky -bottom-3 -mx-3 -mb-3 mt-2 border-t border-zinc-800 bg-zinc-900 px-3 pb-3 pt-2">
              <button
                type="button"
                className="text-amber-300 underline-offset-2 hover:underline"
                data-testid="info-tip-more"
                onClick={() => { close(); openStatsHelp(); }}
              >
                {t('analytics.ui.info.more')}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
