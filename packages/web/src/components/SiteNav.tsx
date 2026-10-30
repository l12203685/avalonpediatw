import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, BookOpen, ExternalLink, Instagram, MessageCircle, MessageSquare, Play, Shield, Trophy, Tv, Youtube,
} from 'lucide-react';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { useGameStore, type GameState } from '../store/gameStore';
import { fetchAdminMe } from '../services/api';
import { getStoredToken } from '../services/socket';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import IOSInstallGuide from './IOSInstallGuide';
import ForceUpdateButton from './ForceUpdateButton';

/**
 * 全站頂端導覽列（Edward 2026-10-30：「不要有首頁，一連進來直接看到內容」「頁籤直接分成 戰績排行／數據分析／
 * 百科攻略」「YouTube 實戰直播回放本身也是一個頁籤」「LINE／DC／IG／YT 要有文字」「開局 就好」）。
 *
 * 左：四個頁籤，選哪個記在瀏覽器，下次進站直接開那頁。右：開局（外連遊玩頁，最醒目）＋社群連結（原 Linktree）。
 * 手機兩列：上列四個頁籤平分寬度，下列開局＋社群。
 */

export type SiteTab = 'analytics' | 'analysis' | 'wiki' | 'streams';

const SITE_TABS: readonly SiteTab[] = ['analytics', 'analysis', 'wiki', 'streams'];
const SITE_TAB_KEY = 'avalon.site.tab';

/** 進站時（gameState 'home'）要開的頁籤：上次選的，沒有就戰績排行。 */
export function lastSiteTab(): SiteTab {
  try {
    const v = localStorage.getItem(SITE_TAB_KEY);
    return SITE_TABS.includes(v as SiteTab) ? (v as SiteTab) : 'analytics';
  } catch {
    return 'analytics';
  }
}

/** 這些頁面掛導覽列；'leaderboard' 是舊路由，歸在戰績排行。 */
export function siteTabOf(state: GameState): SiteTab | null {
  if (state === 'leaderboard') return 'analytics';
  return SITE_TABS.includes(state as SiteTab) ? (state as SiteTab) : null;
}

/** short = 手機上的字（Edward 的寫法 LINE／DC／IG／YT）。 */
const COMMUNITY_LINKS = [
  { key: 'line', label: 'LINE', short: 'LINE', href: 'https://line.me/ti/g/oO5RUpWeoj', Icon: MessageCircle },
  { key: 'discord', label: 'Discord', short: 'DC', href: 'https://discord.com/invite/mBqFqM2TXs', Icon: MessageSquare },
  { key: 'instagram', label: 'Instagram', short: 'IG', href: 'https://www.instagram.com/avalonpediatw/', Icon: Instagram },
  { key: 'youtube', label: 'YouTube', short: 'YT', href: 'https://www.youtube.com/@AvalonPediaTW', Icon: Youtube },
] as const;

export default function SiteNav({ active }: { active: SiteTab | null }): JSX.Element {
  const { t } = useTranslation();
  const setGameState = useGameStore((s) => s.setGameState);
  const currentPlayer = useGameStore((s) => s.currentPlayer);
  const [isAdmin, setIsAdmin] = useState(false);
  // 左上角 logo＝加到手機桌面（Edward 2026-10-30）：能安裝時點 logo 彈安裝；iOS 開手動教學；已安裝或不支援時只是 logo。
  const { deferredPrompt, isStandalone, isIOS, promptInstall } = useInstallPrompt();
  const [showIosGuide, setShowIosGuide] = useState(false);
  const installable = !isStandalone && (deferredPrompt !== null || isIOS);
  const install = (): void => {
    if (deferredPrompt !== null) void promptInstall();
    else if (isIOS) setShowIosGuide(true);
  };

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
    { id: 'analytics', label: t('nav.siteBoards', { defaultValue: '戰績排行' }), Icon: Trophy },
    { id: 'analysis', label: t('nav.siteAnalysis', { defaultValue: '數據分析' }), Icon: BarChart3 },
    { id: 'wiki', label: t('home.wikiAndGuide'), Icon: BookOpen },
    { id: 'streams', label: t('nav.siteStreams', { defaultValue: '直播回放' }), Icon: Tv },
  ];

  return (
    <nav
      data-testid="site-nav"
      className="sticky top-0 z-40 border-b border-zinc-800 bg-black/90 backdrop-blur pt-safe"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          {installable ? (
            <button
              type="button"
              onClick={install}
              data-testid="site-install"
              title={t('home.installApp', { defaultValue: '加到手機桌面' })}
              aria-label={t('home.installApp', { defaultValue: '加到手機桌面' })}
              className="relative h-8 w-8 flex-shrink-0 rounded-full ring-2 ring-emerald-500/70 transition hover:ring-emerald-300"
            >
              <img src="/logo.png" alt="" className="h-8 w-8 rounded-full" />
              <span className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500 px-1 text-[9px] font-bold leading-3 text-black">+</span>
            </button>
          ) : (
            <img src="/logo.png" alt="" aria-hidden="true" className="h-8 w-8 flex-shrink-0 rounded-full" />
          )}
          <div role="tablist" className="grid flex-1 grid-cols-4 gap-1 rounded-lg bg-zinc-900 p-1 sm:flex-none">
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active === id}
                data-testid={`site-tab-${id}`}
                onClick={() => go(id)}
                className={`flex items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 py-1.5 text-[13px] font-bold transition-colors sm:gap-1.5 sm:px-3 sm:text-sm ${
                  active === id ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                <Icon size={15} className="hidden flex-shrink-0 min-[400px]:block" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1 sm:ml-auto sm:gap-1.5">
          <a
            href={PLAY_PLATFORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="site-play"
            title={t('home.playOnPlatform')}
            className="flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg bg-amber-400 px-2 py-1.5 sm:gap-1.5 sm:px-3 text-sm font-bold text-black transition-colors hover:bg-amber-300 sm:flex-none"
          >
            <Play size={16} className="flex-shrink-0" />
            {t('home.playShort', { defaultValue: '開局' })}
            <ExternalLink size={13} className="flex-shrink-0" />
          </a>
          {COMMUNITY_LINKS.map(({ key, label, short, href, Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`site-link-${key}`}
              title={label}
              className="flex h-8 flex-shrink-0 items-center justify-center gap-0.5 rounded-lg border border-zinc-700 bg-zinc-900 px-1.5 text-xs font-semibold sm:gap-1 sm:px-2 text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Icon size={15} className="flex-shrink-0" />
              <span className="lg:hidden">{short}</span>
              <span className="hidden lg:inline">{label}</span>
            </a>
          ))}
          <ForceUpdateButton
            compact
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:cursor-wait disabled:opacity-50"
          />
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
      <IOSInstallGuide isOpen={showIosGuide} onClose={() => setShowIosGuide(false)} />
    </nav>
  );
}
