import type { ReactNode } from 'react';

/** 分析各分頁共用的小節標題 (2026-10-14 從 AnalyticsPage 拆出)。 */
export default function SectionTitle({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h2 className="text-sm font-bold text-zinc-400 mb-2 mt-1 tracking-wide">{children}</h2>
  );
}
