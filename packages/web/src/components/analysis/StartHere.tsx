import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Compass } from 'lucide-react';

/** 「從這裡開始」的按鈕要去的地方（舊分頁 id，AnalyticsPage 經 core/coreTabs 導到新分頁的小分頁）。 */
export type StartHereTarget =
  | 'players' | 'stateTree' | 'lake' | 'roles' | 'position'
  | 'findings:twoRedCohort' | 'findings:discovery';

const COLLAPSE_KEY = 'avalon.analysis.startHere.collapsed';

// 2026-11-17 數據頁改版：總覽的四層大方向已經是第一眼的導讀，這塊預設收起（按過「打開」的瀏覽器照記憶）
function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) !== '0'; } catch { return true; }
}
function writeCollapsed(v: boolean): void {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* 無痕／封鎖儲存：只是不記住 */ }
}

const QUESTIONS: { id: string; targets: StartHereTarget[] }[] = [
  { id: 'improve', targets: ['players'] },
  { id: 'situation', targets: ['stateTree', 'findings:twoRedCohort', 'lake'] },
  { id: 'role', targets: ['roles', 'position'] },
  { id: 'strategy', targets: ['findings:discovery'] },
];

/**
 * 數據分析最上面的「從這裡開始」（2026-11-16 Edward：「數據分析有點太多太亂 也不知道怎麼去看數據或是從數據衍生出
 * 可以改善或優化的策略和方向」）：四個常見問題，各一句怎麼看、怎麼用，按鈕直接切到對的分頁。可以收起（記在這台瀏覽器）。
 */
export default function StartHere({ onGo }: { onGo: (target: StartHereTarget) => void }): JSX.Element {
  const { t } = useTranslation('common');
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (): void => { const v = !collapsed; setCollapsed(v); writeCollapsed(v); };
  const k = 'analytics.analysis.startHere';
  return (
    <section className="mb-3 rounded-xl border border-blue-900/60 bg-blue-950/20 p-3" data-testid="start-here">
      <button type="button" onClick={toggle} aria-expanded={!collapsed} className="flex w-full items-center gap-2 text-left">
        <Compass size={16} className="shrink-0 text-blue-300" />
        <span className="text-sm font-bold text-zinc-100">{t(`${k}.title`)}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400">
          {collapsed ? t(`${k}.show`) : t(`${k}.hide`)}
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>
      {!collapsed && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {QUESTIONS.map((q) => (
            <div key={q.id} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5" data-testid={`start-here-${q.id}`}>
              <p className="text-sm font-semibold text-zinc-100">{t(`${k}.q.${q.id}.q`)}</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">{t(`${k}.q.${q.id}.how`)}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {q.targets.map((target) => (
                  <button
                    key={target}
                    type="button"
                    onClick={() => onGo(target)}
                    className="rounded-md border border-blue-800 bg-blue-900/30 px-2 py-1 text-xs font-semibold text-blue-200 hover:bg-blue-800/50"
                  >
                    {t(`${k}.go.${target.replace(':', '_')}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
