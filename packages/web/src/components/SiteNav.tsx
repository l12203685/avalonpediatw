import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, BookOpen, Bot, ExternalLink, Instagram, ListChecks, MessageCircle, MessageSquare, Play, ScrollText, Shield, Trophy, Tv,
  UserCheck, Youtube,
} from 'lucide-react';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { useGameStore, type GameState } from '../store/gameStore';
import { fetchAdminMe } from '../services/api';
import { getStoredToken } from '../services/socket';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import IOSInstallGuide from './IOSInstallGuide';
import ForceUpdateButton from './ForceUpdateButton';
import { clearRecordsHash } from './records/recordsLink';
import { clearAiGamesHash } from './aiGames/aiGamesLink';
import { PRACTICE_NS } from '../i18n/practice';

/**
 * 全站頂端導覽列（Edward 2026-10-30：「不要有首頁，一連進來直接看到內容」「頁籤直接分成 戰績排行／數據分析／
 * 百科攻略」「YouTube 實戰直播回放本身也是一個頁籤」「LINE／DC／IG／YT 要有文字」「開局 就好」）。
 *
 * 左：五個頁籤，選哪個記在瀏覽器，下次進站直接開那頁。右：開局（外連遊玩頁，最醒目）＋社群連結（原 Linktree）。
 * 寬度不到 1024px 時兩列：上列五個頁籤平分寬度（375px 寬也放得下，不橫向捲動），下列開局＋社群；
 * 1024–1279px 一列時頁籤不顯示圖示、社群連結用短字，1280px 以上才是完整的圖示與文字。
 * 「牌譜紀錄」（Edward 2026-10-30：「百科網站可以直接多一個頁籤是『牌譜紀錄與覆盤』」）= DC 論壇 #牌譜紀錄與覆盤 的牌譜。
 * 「ID認領」（Edward 2026-11-03）不是頁籤：社群連結旁一顆小按鈕，開 ID 認領頁（不用登入）。
 * 「與機器人練習」（站長 2026-11-03：「我希望自己跟 9 個機器人玩」）同樣是一顆小按鈕（不是首頁大按鈕，那些他 10-28 拿掉了），
 * 開練習設定頁（#practice，不用登入）；開局仍是最醒目的那顆。
 * 「百科AI 對局」（Edward 2026-11-05：百科AI 打的局自動記錄、可以針對 AI 的動作回饋）也是一顆小按鈕（#ai-games，不用登入）；
 * 400px 以下手機第二列放不下，那時不顯示（從「與機器人練習」頁的連結或 #ai-games 進來）。
 */

export type SiteTab = 'analytics' | 'analysis' | 'wiki' | 'streams' | 'records';

const SITE_TABS: readonly SiteTab[] = ['analytics', 'analysis', 'wiki', 'streams', 'records'];
const SITE_TAB_KEY = 'avalon.site.tab';

/** 進站時（gameState 'home'）要開的頁籤：上次選的，沒有就戰績排行。 */
export function lastSiteTab(): SiteTab {
  try {
    const stored = localStorage.getItem(SITE_TAB_KEY);
    // 'paipu' = 2026-10-31 改名為 records 前記住的牌譜紀錄頁籤
    const v = stored === 'paipu' ? 'records' : stored;
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
  const { t: tp } = useTranslation(PRACTICE_NS);
  const setGameState = useGameStore((s) => s.setGameState);
  const currentPlayer = useGameStore((s) => s.currentPlayer);
  const gameState = useGameStore((s) => s.gameState);
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
    // 離開牌譜紀錄時清掉 #records=…，免得重新整理又跳回那一局（不放在頁面卸載時做：開發模式的 StrictMode 會先卸載一次）
    if (tab !== 'records') clearRecordsHash();
    clearAiGamesHash();
    setGameState(tab);
    window.scrollTo({ top: 0 });
  };

  const tabs: { id: SiteTab; label: string; Icon: typeof BarChart3 }[] = [
    { id: 'analytics', label: t('nav.siteBoards', { defaultValue: '戰績排行' }), Icon: Trophy },
    { id: 'analysis', label: t('nav.siteAnalysis', { defaultValue: '數據分析' }), Icon: BarChart3 },
    { id: 'wiki', label: t('home.wikiAndGuide'), Icon: BookOpen },
    { id: 'streams', label: t('nav.siteStreams', { defaultValue: '直播回放' }), Icon: Tv },
    { id: 'records', label: t('nav.siteRecords', { defaultValue: '牌譜紀錄' }), Icon: ScrollText },
  ];

  return (
    <nav
      data-testid="site-nav"
      className="sticky top-0 z-40 border-b border-zinc-800 bg-black/90 backdrop-blur pt-safe"
    >
      <div className="mx-auto flex max-w-6xl flex-col xl:max-w-7xl gap-2 px-3 py-2 sm:px-4 lg:flex-row lg:items-center lg:gap-3">
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
          <div role="tablist" className="grid min-w-0 flex-1 grid-cols-5 gap-0.5 rounded-lg bg-zinc-900 p-1 sm:gap-1 lg:flex-none">
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active === id}
                data-testid={`site-tab-${id}`}
                onClick={() => go(id)}
                className={`flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-0.5 py-1.5 text-[12px] font-bold transition-colors min-[400px]:text-[13px] sm:gap-1.5 sm:px-3 sm:text-sm ${
                  active === id ? 'bg-white text-black' : 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                <Icon size={15} className="hidden flex-shrink-0 min-[480px]:block lg:hidden xl:block" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1.5 lg:ml-auto">
          <a
            href={PLAY_PLATFORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="site-play"
            title={t('home.playOnPlatform')}
            className="flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-lg bg-amber-400 px-1.5 py-1.5 min-[400px]:px-2 sm:gap-1.5 sm:px-3 text-sm font-bold text-black transition-colors hover:bg-amber-300 lg:flex-none"
          >
            <Play size={16} className="flex-shrink-0" />
            {t('home.playShort', { defaultValue: '開局' })}
            {/* 400px 以下省掉外連小圖示，讓出「ID認領」按鈕的位置（375px 不橫向捲動） */}
            <ExternalLink size={13} className="hidden flex-shrink-0 min-[400px]:block" />
          </a>
          {COMMUNITY_LINKS.map(({ key, label, short, href, Icon }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`site-link-${key}`}
              title={label}
              className="flex h-8 flex-shrink-0 items-center justify-center gap-px rounded-lg border border-zinc-700 bg-zinc-900 px-1 text-xs font-semibold min-[420px]:gap-0.5 min-[420px]:px-1.5 sm:gap-1 sm:px-2 text-zinc-200 transition-colors hover:bg-zinc-800 hover:text-white"
            >
              <Icon size={15} className="flex-shrink-0" />
              <span className="xl:hidden">{short}</span>
              <span className="hidden xl:inline">{label}</span>
            </a>
          ))}
          <button
            type="button"
            onClick={() => {
              if (active === 'records') clearRecordsHash();
              clearAiGamesHash();
              setGameState('practice');
              window.scrollTo({ top: 0 });
            }}
            data-testid="site-practice"
            title={tp('navLabel')}
            aria-label={tp('navLabel')}
            aria-pressed={gameState === 'practice'}
            className={`flex h-8 min-w-[30px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-xs font-semibold transition-colors sm:min-w-8 sm:px-2 ${
              gameState === 'practice'
                ? 'border-white bg-white text-black'
                : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            {/* 同「ID認領」：640px 以下只有圖示；640–1023px 兩列時長字；1024px 以上一列時短字「練習」，1280px 以上只有字 */}
            <Bot size={15} className="flex-shrink-0 xl:hidden" />
            <span className="hidden sm:inline lg:hidden">{tp('navLabel')}</span>
            <span className="hidden lg:inline">{tp('navShort')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (active === 'records') clearRecordsHash();
              setGameState('aiGames');
              window.scrollTo({ top: 0 });
            }}
            data-testid="site-ai-games"
            title="百科AI 對局：百科AI 打過的局與每一步的理由，可以回饋"
            aria-label="百科AI 對局"
            aria-pressed={gameState === 'aiGames'}
            className={`hidden h-8 min-w-[30px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-xs font-semibold transition-colors min-[400px]:flex sm:min-w-8 sm:px-2 ${
              gameState === 'aiGames'
                ? 'border-white bg-white text-black'
                : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            {/* 640px 以下只有圖示；640–1023px（兩列）長字；1024–1279px 一列最擠，只有圖示；1280px 以上短字 */}
            <ListChecks size={15} className="flex-shrink-0 xl:hidden" />
            <span className="hidden sm:inline lg:hidden">百科AI對局</span>
            <span className="hidden xl:inline">AI對局</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (active === 'records') clearRecordsHash();
              clearAiGamesHash();
              setGameState('idClaim');
              window.scrollTo({ top: 0 });
            }}
            data-testid="site-id-claim"
            title="ID 認領：紀錄裡你用過好幾個 ID？告訴管理者合併"
            aria-label="ID 認領"
            aria-pressed={gameState === 'idClaim'}
            className={`flex h-8 min-w-[30px] flex-shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-xs font-semibold transition-colors sm:min-w-8 sm:px-2 ${
              gameState === 'idClaim'
                ? 'border-white bg-white text-black'
                : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white'
            }`}
          >
            {/* 640px 以下只有圖示（手機上第二列放不下字）；1024px 以上一列時用短字「認領」，1280px 以上社群連結變長字，
                這顆改成只有字，免得擠到頁籤 */}
            <UserCheck size={15} className="flex-shrink-0 xl:hidden" />
            <span className="hidden sm:inline lg:hidden">ID認領</span>
            <span className="hidden lg:inline">認領</span>
          </button>
          <ForceUpdateButton
            compact
            className="flex h-8 w-[30px] flex-shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 sm:w-8 transition-colors hover:bg-zinc-800 hover:text-white disabled:cursor-wait disabled:opacity-50"
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
