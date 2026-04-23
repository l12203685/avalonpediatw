import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  User,
  Link2,
  Chrome,
  Loader,
  HelpCircle,
  Copy,
  Check,
  Unlink,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  renameGuest,
  signInWithGoogle,
  signInWithDiscord,
  signInWithLine,
  hasFirebaseAuthConfigured,
  upgradeGuestToRegistered,
  getIdToken,
} from '../services/auth';
import { initializeSocket, getStoredToken } from '../services/socket';
import {
  fetchLinkedAccounts,
  unlinkAccount,
  LinkedAccount,
  LinkProvider,
} from '../services/api';

type SectionId = 'basic' | 'binding';

interface SectionConfig {
  id: SectionId;
  labelKey: string;
  icon: typeof User;
}

/**
 * #86 IA v3 — 2026-04-23 拆頁：系統設定只保留 [基本資料 + 帳號綁定]，
 * 歷史戰績 / 追蹤列表 / 追蹤對戰成績 搬到新的 PersonalStatsPage（個人戰績頁）。
 *
 * 2026-04-23 Edward 指令：系統設定頁移除登出按鈕，預設不給登出。後端
 * /auth/logout endpoint 保留，未來 admin 用。
 */
const SECTIONS: SectionConfig[] = [
  { id: 'basic',   labelKey: 'settings.basic',   icon: User },
  { id: 'binding', labelKey: 'settings.binding', icon: Link2 },
];

/**
 * #84 訪客判定：Player 型別現已帶 `provider` 欄位（socket.ts auth:success 從
 * session.user.provider 塞進來），所以判斷「是否為訪客」直接看 provider 即可。
 *
 * Regression note: 初版用 name 形如 Guest_NNN 或 avatar 空值作 heuristic，但
 * Discord / Line 綁定的正式使用者有可能沒有 photoURL，會被誤判為訪客 → 綁定後
 * 仍顯示訪客 UI。改用 provider 後，此誤判被修掉。
 *
 * Fallback：若 provider 未定義（legacy state、極早期 bot、或 server 還沒補完
 * 舊 socket 重連事件），就只認 name 形如 Guest_NNN 才當訪客；沒頭像不再視為
 * 訪客指標。
 */
function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  // Legacy fallback — provider 缺值時只認 Guest_NNN 預設名
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function SettingsPage(): JSX.Element {
  const { t } = useTranslation();
  const { setGameState, setCurrentPlayer, currentPlayer, addToast } = useGameStore();

  // 訪客改名 state
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(currentPlayer?.name ?? '');
  const [submittingRename, setSubmittingRename] = useState(false);
  const [renameError, setRenameError] = useState('');

  // 訪客轉正式註冊 state
  const [upgrading, setUpgrading] = useState(false);

  const isGuest = isGuestPlayer(currentPlayer);

  // 2026-04-23 Edward：已綁狀態顯示 + 解綁按鈕 + uuid 複製
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedErr, setLinkedErr] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<LinkProvider | null>(null);
  const [copiedUuid, setCopiedUuid] = useState(false);

  // 載入綁定狀態（只對非訪客）
  useEffect(() => {
    if (isGuest) return;
    const token = getStoredToken();
    if (!token) return;
    setLinkedLoading(true);
    fetchLinkedAccounts(token)
      .then(setLinked)
      .catch(e => setLinkedErr(String((e as Error).message ?? e)))
      .finally(() => setLinkedLoading(false));
  }, [isGuest]);

  const handleUnlink = async (provider: LinkProvider): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    // 防呆：再次確認
    // eslint-disable-next-line no-alert
    if (!window.confirm(t('settings.unlinkConfirm', { provider }))) return;
    setUnlinking(provider);
    try {
      const after = await unlinkAccount(token, provider);
      setLinked(after);
      addToast(t('settings.unlinkSuccess'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : t('settings.unlinkFailed'), 'error');
    } finally {
      setUnlinking(null);
    }
  };

  const handleCopyUuid = async (): Promise<void> => {
    if (!currentPlayer?.id) return;
    try {
      await navigator.clipboard.writeText(currentPlayer.id);
      setCopiedUuid(true);
      setTimeout(() => setCopiedUuid(false), 1500);
    } catch {
      // Clipboard API 在 http (非 localhost) 會失敗；fallback
      const ta = document.createElement('textarea');
      ta.value = currentPlayer.id;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* noop */ }
      document.body.removeChild(ta);
      setCopiedUuid(true);
      setTimeout(() => setCopiedUuid(false), 1500);
    }
  };

  const handleRenameSubmit = async (): Promise<void> => {
    const trimmed = newName.trim();
    if (trimmed.length < 2 || trimmed.length > 20) {
      setRenameError(t('guest.renameLengthError'));
      return;
    }
    if (/^guest_/i.test(trimmed)) {
      setRenameError(t('guest.renameReservedPrefix'));
      return;
    }
    setSubmittingRename(true);
    setRenameError('');
    try {
      const result = await renameGuest(trimmed);
      if (!result.ok) {
        // Map server error codes to i18n keys; fall back to raw error text.
        let message = result.error ?? t('guest.renameFailed');
        if (result.code === 'RESERVED_PREFIX') message = t('guest.renameReservedPrefix');
        // 404 means the /auth/guest/rename endpoint isn't available on the
        // deployed server yet (commit #84 shipped the client before the server
        // build/redeploy caught up). Surface a friendlier message instead of
        // the raw "rename failed: 404" so users don't think their input is bad.
        else if (/rename failed: 404/i.test(message)) {
          message = t('guest.renameUnavailable', {
            defaultValue: '伺服器尚未支援改名，請稍候再試',
          });
        }
        setRenameError(message);
        return;
      }
      // 成功 → 更新 currentPlayer.name（UI 端先更新，之後 Phase 2 server 會
      // broadcast canonical display name）
      if (currentPlayer) {
        setCurrentPlayer({ ...currentPlayer, name: trimmed });
      }
      addToast(t('guest.renameSuccess'), 'success');
      setRenaming(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : t('guest.renameFailed'));
    } finally {
      setSubmittingRename(false);
    }
  };

  // 訪客轉正式帳號 — Google 走 Firebase popup → 後端 /auth/guest/upgrade 建 user
  // row + 簽 google JWT → 前端用 Firebase ID token 重建 socket（provider='google'
  // 於 auth:success 回來）。Discord / Line 仍走 redirect-based OAuth。
  //
  // 2026-04-23 Edward 回報：原本只呼叫 signInWithGoogle() 就結束，socket 因為
  // `socket?.connected` early-return 沒重建 → 身份仍是 guest → 無法改名。修法：
  //   1) popup 登入 Firebase
  //   2) 呼叫 /auth/guest/upgrade 把 user row 建好、拿到 google JWT
  //   3) 用 Firebase ID token 重新 initializeSocket（token 變 → socket.ts 會 tear down
  //      + 重建 → server 以 google 身份簽回 auth:success → setCurrentPlayer
  //      provider='google' → isGuest=false → 改名 / PATCH /api/profile/me 放行）
  const handleUpgrade = async (
    provider: 'google' | 'discord' | 'line',
  ): Promise<void> => {
    setUpgrading(true);
    try {
      if (provider === 'google') {
        if (!hasFirebaseAuthConfigured()) {
          addToast(t('settings.upgradeGoogleUnavailable'), 'error');
          return;
        }
        await signInWithGoogle();
        // Firebase 已登入 → 拿 ID token 傳給 server 做 upgrade merge
        const idToken = await getIdToken();
        const result = await upgradeGuestToRegistered('google', idToken);
        if (!result.ok) {
          addToast(result.error || t('settings.upgradeFailed'), 'error');
          return;
        }
        // 用 Firebase ID token 重建 socket — 新身份會帶 provider='google' 回來
        await initializeSocket(idToken);
        addToast(t('guest.renameSuccess'), 'success');
      } else if (provider === 'discord') {
        // #42 bind-path fix：綁定按鈕必須走 /auth/link/discord，不是登入路徑。
        // 拿 socket 當前 token（訪客 JWT 或 Firebase ID token）一併帶上，
        // 後端 `parseBearerUserId` 會據此判斷當前身份並在 callback 合併戰績。
        const jwt = getStoredToken();
        if (!jwt) {
          addToast(t('settings.upgradeFailed'), 'error');
          return;
        }
        signInWithDiscord('bind', jwt);
      } else if (provider === 'line') {
        const jwt = getStoredToken();
        if (!jwt) {
          addToast(t('settings.upgradeFailed'), 'error');
          return;
        }
        signInWithLine('bind', jwt);
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : t('settings.upgradeFailed'), 'error');
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black p-4 pb-24">
      <div className="max-w-3xl mx-auto">
        {/* Header — #86 IA 整合：右側加 FAQ 入口，大廳 FAQ 按鈕併入設定 */}
        <div className="flex items-center gap-3 mb-6">
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setGameState('home')}
            className="p-2 bg-zinc-900/70 rounded-lg border border-zinc-700 hover:border-white text-zinc-300 hover:text-white transition-colors"
            aria-label={t('nav.back')}
          >
            <ArrowLeft size={20} />
          </motion.button>
          <h1 className="text-2xl font-black text-white flex-1">{t('nav.settings')}</h1>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setGameState('help')}
            data-testid="settings-btn-faq"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title={t('home.faq')}
          >
            <HelpCircle size={14} />
            {t('home.faq')}
          </motion.button>
        </div>

        {/* Sections */}
        <div className="space-y-4">
          {SECTIONS.map(section => {
            const Icon = section.icon;
            return (
              <section
                key={section.id}
                id={`settings-${section.id}`}
                className="bg-zinc-900/60 border border-zinc-700 rounded-xl p-6"
              >
                <div className="flex items-center gap-3 mb-3">
                  <Icon size={18} className="text-white" />
                  <h2 className="text-lg font-bold text-white">
                    {t(section.labelKey)}
                  </h2>
                </div>

                {section.id === 'basic' && (
                  <div className="text-sm text-zinc-400 space-y-3">
                    <p>
                      <span className="text-zinc-500">{t('settings.currentName')}: </span>
                      <span className="text-white font-semibold">
                        {currentPlayer?.name ?? t('auth.guest')}
                      </span>
                    </p>

                    {/* 2026-04-23 Edward：基本資料區加 uuid 顯示 + 複製按鈕 */}
                    {currentPlayer?.id && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-zinc-500">UUID: </span>
                        <code
                          className="text-[11px] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-300 font-mono break-all"
                          data-testid="settings-uuid-value"
                        >
                          {currentPlayer.id}
                        </code>
                        <button
                          type="button"
                          onClick={handleCopyUuid}
                          data-testid="settings-btn-copy-uuid"
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white transition-colors"
                          title={t('settings.copyUuid', { defaultValue: '複製 UUID' })}
                        >
                          {copiedUuid ? <Check size={12} /> : <Copy size={12} />}
                          {copiedUuid
                            ? t('settings.copied', { defaultValue: '已複製' })
                            : t('settings.copy', { defaultValue: '複製' })}
                        </button>
                      </div>
                    )}
                    {isGuest ? (
                      renaming ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={newName}
                            onChange={e => {
                              setNewName(e.target.value);
                              if (renameError) setRenameError('');
                            }}
                            maxLength={20}
                            placeholder={t('guest.renamePlaceholder')}
                            className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-white"
                          />
                          {renameError && (
                            <p className="text-xs text-red-400">{renameError}</p>
                          )}
                          <p className="text-[11px] text-zinc-500">{t('guest.renameLimit')}</p>
                          <div className="flex gap-2">
                            <button
                              onClick={handleRenameSubmit}
                              disabled={submittingRename}
                              className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors"
                            >
                              {submittingRename && <Loader size={14} className="animate-spin" />}
                              {t('action.save')}
                            </button>
                            <button
                              onClick={() => {
                                setRenaming(false);
                                setNewName(currentPlayer?.name ?? '');
                                setRenameError('');
                              }}
                              disabled={submittingRename}
                              className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors border border-zinc-700 disabled:opacity-50"
                            >
                              {t('action.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <button
                            data-testid="settings-btn-rename-or-bind"
                            onClick={() => {
                              // 2026-04-23 Edward 指令：訪客改名按鈕改成「帳號綁訂與改名」，
                              // 點擊同頁展開改名輸入 + 自動滾動到帳號綁定區，提醒先綁帳號
                              // 再改名，避免改完名字又清 cookie 導致資料遺失。
                              setRenaming(true);
                              setNewName(currentPlayer?.name ?? '');
                              // 下一個 tick 滾動到 binding 區塊，讓綁定按鈕進入視野
                              requestAnimationFrame(() => {
                                const bindingEl = document.getElementById('settings-binding');
                                if (bindingEl) {
                                  bindingEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                }
                              });
                            }}
                            className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-1.5 px-3 rounded-lg text-sm transition-colors border border-zinc-700"
                          >
                            <Link2 size={14} />
                            {t('guest.renameOrBind')}
                          </button>
                          <p className="text-[11px] text-zinc-500">{t('guest.renameOrBindHint')}</p>
                        </div>
                      )
                    ) : (
                      <p className="text-zinc-500 text-xs">{t('settings.comingSoon')}</p>
                    )}
                  </div>
                )}

                {section.id === 'binding' && (
                  <div className="text-sm space-y-3">
                    <p className="text-zinc-500">{t('settings.upgradeGuest')}</p>

                    {/* 訪客模式 — 三顆綁定按鈕（原本行為） */}
                    {isGuest && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <button
                          onClick={() => handleUpgrade('google')}
                          disabled={upgrading || !hasFirebaseAuthConfigured()}
                          data-testid="settings-btn-bind-google"
                          className="inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-white font-semibold py-2 px-3 rounded-lg border border-zinc-700 transition-colors"
                          title={hasFirebaseAuthConfigured() ? '' : t('settings.upgradeGoogleUnavailable')}
                        >
                          <Chrome size={16} className="text-blue-400" />
                          {t('settings.upgradeWithGoogle')}
                        </button>
                        <button
                          onClick={() => handleUpgrade('discord')}
                          disabled={upgrading}
                          data-testid="settings-btn-bind-discord"
                          className="inline-flex items-center justify-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.032.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
                          </svg>
                          {t('settings.upgradeWithDiscord')}
                        </button>
                        <button
                          onClick={() => handleUpgrade('line')}
                          disabled={upgrading}
                          data-testid="settings-btn-bind-line"
                          className="inline-flex items-center justify-center gap-2 bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg transition-colors"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M19.365 9.89c.50 0 .907.41.907.91s-.406.91-.907.91h-2.25v1.356h2.25c.5 0 .907.408.907.909s-.406.91-.907.91H16.21a.907.907 0 0 1-.907-.91V9.89c0-.5.407-.91.907-.91h3.155m-9.503 4.995a.907.907 0 0 1-.877.91.9.9 0 0 1-.715-.35l-2.56-3.482V14.8a.907.907 0 1 1-1.815 0V9.89a.907.907 0 0 1 1.59-.602l2.562 3.482V9.89a.907.907 0 0 1 1.815 0v4.996M7.077 9.89a.907.907 0 0 1 0 1.815h-2.25v4.096a.907.907 0 1 1-1.814 0V9.89c0-.5.406-.91.907-.91h3.157M24 10.27C24 4.595 18.627 0 12 0S0 4.594 0 10.27c0 5.076 4.504 9.331 10.59 10.131.413.089.975.272 1.117.624.13.32.083.823.04 1.148l-.182 1.089c-.053.321-.26 1.256 1.1.685 1.363-.572 7.347-4.326 10.025-7.406C23.253 14.672 24 12.563 24 10.27"/>
                          </svg>
                          {t('settings.upgradeWithLine')}
                        </button>
                      </div>
                    )}

                    {/* 2026-04-23 Edward：已綁定時 per-provider 顯「已綁定 @xxx」+ 解綁按鈕 */}
                    {!isGuest && (
                      <div className="space-y-2">
                        {linkedLoading && (
                          <p className="text-xs text-zinc-500 flex items-center gap-1.5">
                            <Loader size={12} className="animate-spin" />
                            {t('settings.loadingBindings', { defaultValue: '載入綁定狀態...' })}
                          </p>
                        )}
                        {linkedErr && !linkedLoading && (
                          <p className="text-xs text-amber-400">{linkedErr}</p>
                        )}
                        {!linkedLoading && !linkedErr && linked.map(acc => (
                          <LinkedProviderRow
                            key={acc.provider}
                            account={acc}
                            busy={unlinking === acc.provider || upgrading}
                            onBind={() => handleUpgrade(acc.provider)}
                            onUnbind={() => handleUnlink(acc.provider)}
                          />
                        ))}
                      </div>
                    )}

                    <p className="text-xs text-zinc-600">{t('settings.upgradeHint')}</p>
                  </div>
                )}

              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Per-provider binding row — 已綁：顯「已綁定 @xxx」+ 解綁；未綁：綁定
// ──────────────────────────────────────────────────────────────

interface LinkedProviderRowProps {
  account:  LinkedAccount;
  busy:     boolean;
  onBind:   () => void;
  onUnbind: () => void;
}

function LinkedProviderRow({ account, busy, onBind, onUnbind }: LinkedProviderRowProps): JSX.Element {
  const { t } = useTranslation();
  const providerLabel = {
    google:  t('settings.upgradeWithGoogle'),
    discord: t('settings.upgradeWithDiscord'),
    line:    t('settings.upgradeWithLine'),
  }[account.provider];

  // 解綁後 primary provider 不能被抽掉（後端 ≤1 檔住），但這邊照樣顯示按鈕，
  // 被後端拒絕時 addToast 顯示錯誤訊息即可。
  return (
    <div
      data-testid={`settings-row-bind-${account.provider}`}
      className={`flex items-center gap-3 bg-zinc-950/40 border rounded-lg px-3 py-2 ${
        account.linked ? 'border-emerald-700/40' : 'border-zinc-800'
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-semibold truncate">{providerLabel}</p>
        {account.linked ? (
          <p className="text-[11px] text-emerald-400 truncate">
            {t('settings.linkedAs', { defaultValue: '已綁定' })} @{account.display_label ?? account.external_id ?? '—'}
            {account.primary && (
              <span className="ml-1 text-amber-400">
                ({t('settings.primaryProvider', { defaultValue: '主帳號' })})
              </span>
            )}
          </p>
        ) : (
          <p className="text-[11px] text-zinc-500">
            {t('settings.notLinked', { defaultValue: '尚未綁定' })}
          </p>
        )}
      </div>
      {account.linked ? (
        <button
          type="button"
          onClick={onUnbind}
          disabled={busy || account.primary}
          data-testid={`settings-btn-unbind-${account.provider}`}
          title={account.primary ? t('settings.cannotUnlinkPrimary', { defaultValue: '主帳號不可解綁' }) : ''}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-800/60 disabled:opacity-40 border border-zinc-700 hover:border-red-500 text-zinc-300 hover:text-white transition-colors"
        >
          {busy ? <Loader size={12} className="animate-spin" /> : <Unlink size={12} />}
          {t('settings.unlink', { defaultValue: '解綁' })}
        </button>
      ) : (
        <button
          type="button"
          onClick={onBind}
          disabled={busy}
          data-testid={`settings-btn-bind-${account.provider}`}
          className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-white hover:bg-zinc-200 disabled:opacity-50 text-black font-semibold transition-colors"
        >
          {busy ? <Loader size={12} className="animate-spin" /> : <Link2 size={12} />}
          {t('settings.bind', { defaultValue: '綁定' })}
        </button>
      )}
    </div>
  );
}
