import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';

export interface MoreDetailsItem {
  id: string;
  title: string;
  render: () => JSX.Element;
}

/**
 * 「更多細節」小分頁（2026-11-16 Edward：「數據分析有點太多太亂」）：比較少用、樣本小或只回答很細問題的區塊收在這裡，
 * 每一塊預設收起，打開才掛載（才去拿資料）。內容沒有刪，只是不放在第一眼。
 */
export default function MoreDetails({ items }: { items: MoreDetailsItem[] }): JSX.Element {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-2" data-testid="more-details">
      <p className="text-xs text-zinc-500">{t('analytics.analysis.more.intro')}</p>
      {items.map((item) => {
        const isOpen = open[item.id] === true;
        return (
          <section key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((o) => ({ ...o, [item.id]: !isOpen }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-zinc-200 hover:text-white"
              data-testid={`more-details-${item.id}`}
            >
              <ChevronRight size={14} className={`shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
              {item.title}
            </button>
            {isOpen && <div className="border-t border-zinc-800 p-2">{item.render()}</div>}
          </section>
        );
      })}
    </div>
  );
}
