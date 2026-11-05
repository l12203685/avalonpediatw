import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight, Loader2, RefreshCw, UserRound } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { retrySiteSession, sessionFailed, subscribeSessionFailed } from '../services/siteSession';
import PracticeSetupPanel from '../components/practice/PracticeSetupPanel';
import { PRACTICE_NS } from '../i18n/practice';

/**
 * 與機器人練習（站長 2026-11-03：「如果我希望自己跟 9 個機器人玩呢」）— 自己 + 9 個機器人的 10 人局，不計戰績。
 *
 * 2026-10-30 起沒有首頁，原本首頁的練習卡片搬到這頁：導覽列的「與機器人練習」小按鈕、#practice 連結都開這裡。
 * 不用登入：App 進站時已在背景拿訪客身分（services/siteSession.ts）；伺服器（免費方案）閒置會睡，
 * 第一次連線要等 30–60 秒，這段時間顯示喚醒中、開始鈕先停用，等太久可按「重新連線」。
 * 開始後進原本的遊戲畫面（RoomPage）；結束練習／回練習設定 → 回這頁，「返回」→ 上次的頁籤。
 */

/** 等這麼久（秒）還沒連上，就顯示「重新連線」。 */
const SLOW_AFTER_S = 60;

function isGuest(player: { name?: string; provider?: string } | null): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function PracticePage(): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const currentPlayer = useGameStore((s) => s.currentPlayer);
  const socketStatus = useGameStore((s) => s.socketStatus);
  const setGameState = useGameStore((s) => s.setGameState);
  const connected = currentPlayer !== null && socketStatus === 'connected';

  // 等了幾秒：since = 開始等（進頁、斷線、按重新連線）的時間
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  // 背景的訪客身分流程（App 進站時、或這頁的重新連線）失敗了
  const [failed, setFailed] = useState(sessionFailed);
  useEffect(() => subscribeSessionFailed(setFailed), []);
  const waited = Math.max(0, Math.floor((now - since) / 1000));

  useEffect(() => {
    if (connected) {
      setFailed(false);
      return undefined;
    }
    setSince(Date.now());
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return (): void => window.clearInterval(id);
  }, [connected]);

  const reconnect = async (): Promise<void> => {
    if (retrying) return;
    setRetrying(true);
    setSince(Date.now());
    await retrySiteSession();
    setRetrying(false);
  };

  const reconnectButton = (
    <button
      type="button"
      onClick={() => { void reconnect(); }}
      disabled={retrying}
      data-testid="practice-reconnect"
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-zinc-700 disabled:opacity-60"
    >
      {retrying ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      {retrying ? t('reconnecting') : t('reconnect')}
    </button>
  );

  let status: JSX.Element;
  if (connected) {
    status = (
      <p data-testid="practice-identity" className="flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-400">
        <UserRound size={13} className="flex-shrink-0 text-emerald-300" />
        <span className="text-zinc-200">{t('playingAs', { name: currentPlayer?.name ?? '' })}</span>
        {isGuest(currentPlayer) && <span>{t('guestNote')}</span>}
      </p>
    );
  } else if (failed) {
    status = (
      <div data-testid="practice-conn-failed" role="alert" className="rounded-lg border border-red-800 bg-red-950/60 p-3 text-xs text-red-200">
        <p className="flex items-center gap-1.5 font-bold">
          <AlertTriangle size={14} className="flex-shrink-0" />
          {t('failed')}
        </p>
        {reconnectButton}
      </div>
    );
  } else {
    status = (
      <div data-testid="practice-waking" role="status" className="rounded-lg border border-amber-700/70 bg-amber-950/50 p-3 text-xs text-amber-100">
        <p className="flex items-center gap-1.5 text-sm font-bold">
          <Loader2 size={15} className="flex-shrink-0 animate-spin" />
          {t('waking')}
        </p>
        <p className="mt-1 text-amber-200/80">{t('wakingDetail', { seconds: waited })}</p>
        {waited >= SLOW_AFTER_S && (
          <>
            <p className="mt-1 text-amber-200/80">{t('wakingSlow')}</p>
            {reconnectButton}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-xl px-4 pb-16 pt-4" data-testid="practice-page">
      <PracticeSetupPanel
        ready={connected}
        status={status}
        onBack={() => {
          setGameState('home');
          window.scrollTo({ top: 0 });
        }}
      />
      {/* 百科AI 在遊玩頁打的局（Edward 2026-11-05）：手機上導覽列放不下那顆按鈕，這裡也放一個入口 */}
      <button
        type="button"
        onClick={() => { setGameState('aiGames'); window.scrollTo({ top: 0 }); }}
        data-testid="practice-ai-games-link"
        className="mt-4 flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-zinc-800"
      >
        <span><span className="font-bold text-amber-200">百科AI 對局</span>：百科AI 在遊玩頁打過的局、每一步的理由，覺得怪可以直接回饋</span>
        <ChevronRight size={14} className="flex-shrink-0 text-zinc-500" />
      </button>
    </div>
  );
}
