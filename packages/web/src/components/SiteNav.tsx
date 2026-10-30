import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, BookOpen, ExternalLink, Instagram, MessageCircle, MessageSquare, Play, Shield, Youtube,
} from 'lucide-react';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { useGameStore, type GameState } from '../store/gameStore';
import { fetchAdminMe } from '../services/api';
import { getStoredToken } from '../services/socket';

/**
 * 全站頂端導覽列（Edward 2026-10-30：「不要有首頁，一連進來直接看到數據排行 & 百科攻略的內容；
 * 開局、LINE、Discord、Instagram、YouTube 放在切換數據排行／百科攻略的按鈕旁邊」）。
 *
 * 左：兩個主分頁（數據排行／百科攻略），選哪個記在瀏覽器，下次進站直接開那頁。
 * 右：開局（外連遊玩頁，最醒目）＋社群圖示（原 Linktree 的按鈕，網址取自 linktr.ee/avalonpediatw）。
 * 手機兩列：上列兩個分頁平分寬度，下列開局＋四個圖示。
 */

export type SiteTab = 'analytics' | 'wiki';

const SITE_TAB_KEY = 'avalon.site.tab';

/** 進站時（gameState 'home'）要開的分頁：上次選的，沒有就數據排行。 */
export function lastSiteTab(): SiteTab {
  try {
    return localStorage.getItem(SITE_TAB_KEY) === 'wiki' ? 'wiki' : 'analytics';
  } catch {
    return 'analytics';
  }
}

/** 這些頁面掛導覽列；'analysis' / 'leaderboard' 是舊路由，歸在數據排行底下。 */
export function siteTabOf(state: GameState): SiteTab | null {
  if (state === 'wiki') return 'wiki';
  if (state === 'analytics' || state === 'analysis' || state === 'leaderboard') return 'analytics';
  return null;
}

const COMMUNITY_LINKS = [
  { key: 'line', label: 'LINE', href: 'https://line.me/ti/g/oO5RUpWeoj', Icon: MessageCircle },
  { key: 'discord', label: 'Discord', href: 'https://discord.com/invite/mBqFqM2TXs', Icon: MessageSquare },
  { key: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/avalonpediatw/', Icon: Instagram },
  { key: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/@AvalonPediaTW/streams', Icon: Youtube },
] as const;

export default function SiteNav({ active }: { active: SiteTab }): JSX.Element {
  const { t } = useTranslation();
  const setGameState = useGameStore((s) => s.setGameState);
  const currentPlayer = useGameStore((s) => s.currentPlayer);
  const [isAdmin, setIsAdmin] = useState(false);

  // 管理頁的入口只給管理員（原本在首頁）。
  useEffect(() => {
    if (!currentPlayer) return;
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    fetchAdminMe(token)
      .then((me) => { if (!cancelled) setIsAdmin(me.isAdmin); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return (): void => { cancelled = true; };
  }, [currentPlayer]);

  const go = (tab: SiteTab): void => {
    try { localStorage.setItem(SITE_TAB_KEY, tab); } catch { /* 無痕／封鎖儲存：只是不記住 */ }
    setGameState(tab);
    window.scrollTo({ top: 0 });
  };

  const tabs: { id: SiteTab; label: string; Icon: typeof BarChart3 }[] = [
    { id: 'analytics', label: t('home.stats'), Icon: BarChart3 },
    { id: 'wiki', label: t('home.wikiAndGuide'), Icon: BookOpen },
  ];

  return (
    <nav
      data-testid="site-nav"
      className="sticky top-0 z-40 border-b border-zinc-800 bg-black/90 backdrop-blur pt-safe"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/logo.png" alt="" aria-hidden="true" className="hidden h-8 w-8 rounded-full sm:block" />
          <div role="tablist" className="grid flex-1 grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1 sm:flex-none">
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active === id}
                data-testid={`site-tab-${id}`}
                onClick={() => go(id)}
                className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-bold transition-colors ${
                  active === id ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                <Icon size={16} className="flex-shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:ml-auto">
          <a
            href={PLAY_PLATFORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="site-play"
            title={t('home.playOnPlatform')}
            className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-bold text-black transition-colors hover:bg-amber-300 sm:flex-none"
          >
            <Play size={16} className="flex-shrink-0" />
            <span className="sm:hidden">{t('home.playShort', { defaultValue: '開局' })}</span>
            <span className="hidden sm:inline">{t('home.playOnPlatform')}</span>
            <ExternalLink size={13} className="flex-shrink-0" />
          </a>
          {COMMUNITY_LINKS.map(({ key, label, href, Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`site-link-${key}`}
              title={label}
              aria-label={label}
              className="flex h-8 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Icon size={17} />
            </a>
          ))}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setGameState('adminClaims')}
              title={t('nav.admin')}
              aria-label={t('nav.admin')}
              className="flex h-8 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-500 transition-colors hover:text-white"
            >
              <Shield size={16} />
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
