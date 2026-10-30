import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StatTermKey } from './statTerms';
import { POPOVER_CLASS, usePopover } from './usePopover';

/**
 * Term — 統計名詞的說明 (Edward 2026-10-28：「超額勝率是什麼意思 你有辦法做成 滑鼠移過去 會顯示那個名詞的
 * 算法/定義/意義嗎」)。
 *
 *  - 名詞加虛線底線；滑鼠移上去、鍵盤 focus 或點一下 (手機) 打開小視窗：定義 / 算法 / 怎麼看。
 *  - 文字在 i18n `statTerms.<key>.{name,def,calc,meaning}` (statTerms.ts 列出全部名詞)；說明頁的
 *    「統計名詞與算法」也列同一份 (pages/HelpPage → StatTermsHelp)。
 *  - 開關、位置的邏輯在 usePopover (InfoTip ⓘ 共用)。
 */
export interface TermProps {
  term: StatTermKey;
  /** 顯示的文字；預設是名詞本身 (statTerms.<key>.name)。 */
  children?: ReactNode;
  className?: string;
}

const POPOVER_WIDTH = 288; // 18rem

/** 名詞的定義 / 算法 / 怎麼看 (Term 小視窗與說明頁共用)。 */
export function TermRows({ term }: { term: StatTermKey }): JSX.Element {
  const { t } = useTranslation('common');
  const rows: Array<[string, string]> = (['def', 'calc', 'meaning'] as const)
    .map((part): [string, string] => [t(`statTerms.label.${part}`), t(`statTerms.${term}.${part}`, { defaultValue: '' })])
    .filter(([, text]) => text);
  return (
    <dl className="space-y-1">
      {rows.map(([label, text]) => (
        <div key={label}>
          <dt className="inline font-semibold text-amber-300">{label}：</dt>
          <dd className="inline">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Term({ term, children, className }: TermProps): JSX.Element {
  const { t } = useTranslation('common');
  const { pos, triggerProps, panelProps } = usePopover<HTMLButtonElement>(POPOVER_WIDTH);

  return (
    <>
      <button
        type="button"
        data-testid={`term-${term}`}
        className={`inline cursor-help border-b border-dotted border-current/60 text-inherit font-inherit leading-inherit ${className ?? ''}`}
        {...triggerProps}
      >
        {children ?? t(`statTerms.${term}.name`)}
      </button>
      {pos && createPortal(
        <div role="tooltip" className={POPOVER_CLASS} {...panelProps}>
          <div className="mb-1 font-semibold text-white">{t(`statTerms.${term}.name`)}</div>
          <TermRows term={term} />
        </div>,
        document.body,
      )}
    </>
  );
}
