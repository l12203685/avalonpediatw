/**
 * BindingField — Phase 3 inline binding block for create/join flows.
 *
 * Design SSoT: staging/subagent_results/design_pregame_binding_2026-04-24.md §C
 * Task:        hineko_20260424_1045_ux_phase3_lobby_chat
 *
 * Replaces the raw "你的名字" text input in HomePage's create / join panels
 * with a unified 登入/綁定 block that:
 *   - Guest, collapsed: three OAuth buttons + "以訪客繼續 ▼"
 *   - Guest, expanded:  same + name input (for naming this guest session)
 *   - Authed (locked):  🔒 @display_label · 已綁定 {{provider}} · [切換帳號]
 *
 * pendingAction localStorage hop:
 *   Before redirecting away for Discord / LINE OAuth (or doing the Google
 *   popup), we persist `pendingAction` ('create' | 'join') and
 *   `pendingRoomCode` so HomePage can restore the mode after the reload.
 *   This is a different key space from Phase 2's `pendingGateTarget`, so
 *   the two flows don't clobber each other.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chrome, Loader, Lock, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  signInWithDiscord,
  signInWithLine,
  hasFirebaseAuthConfigured,
  quickLoginWithGoogle,
  stashLinkedProviderToken,
} from '../services/auth';
import { getStoredToken } from '../services/socket';
import { fetchLinkedAccounts, LinkedAccount } from '../services/api';

export type BindingMode = 'create' | 'join';

interface BindingFieldProps {
  mode: BindingMode;
  playerName: string;
  onPlayerNameChange: (name: string) => void;
  roomCode?: string; // passed through to pendingRoomCode for join flow
}

function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function BindingField({
  mode,
  playerName,
  onPlayerNameChange,
  roomCode,
}: BindingFieldProps): JSX.Element {
  const { t } = useTranslation();
  const { currentPlayer, addToast, setGameState } = useGameStore();
  const [busy, setBusy] = useState<'google' | 'discord' | 'line' | null>(null);
  const [showGuestInput, setShowGuestInput] = useState(false);
  const [linked, setLinked] = useState<LinkedAccount[]>([]);

  const guest = isGuestPlayer(currentPlayer);

  // Fetch linked accounts for the "locked" state display (primary provider label).
  useEffect(() => {
    if (guest) return;
    const token = getStoredToken();
    if (!token) return;
    fetchLinkedAccounts(token)
      .then(setLinked)
      .catch(() => { /* fallback: render without label */ });
  }, [guest]);

  const persistPending = (): void => {
    localStorage.setItem('pendingAction', mode);
    if (mode === 'join' && roomCode) {
      localStorage.setItem('pendingRoomCode', roomCode);
    }
  };

  async function handleGoogle(): Promise<void> {
    if (!hasFirebaseAuthConfigured()) {
      addToast(t('settings.upgradeGoogleUnavailable', { defaultValue: '此環境未設定 Google 登入' }), 'error');
      return;
    }
    setBusy('google');
    persistPending();
    try {
      const result = await quickLoginWithGoogle();
      if (result && result.token) {
        stashLinkedProviderToken(result.token);
        window.location.reload();
        return;
      }
      addToast(t('binding.errorFailed', { defaultValue: '綁定失敗，請再試一次' }), 'error');
    } catch (err) {
      addToast(err instanceof Error ? err.message : t('binding.errorFailed', { defaultValue: '綁定失敗' }), 'error');
    } finally {
      setBusy(null);
    }
  }

  function handleDiscord(): void {
    const jwt = getStoredToken();
    if (!jwt) return;
    setBusy('discord');
    persistPending();
    signInWithDiscord('bind', jwt);
  }

  function handleLine(): void {
    const jwt = getStoredToken();
    if (!jwt) return;
    setBusy('line');
    persistPending();
    signInWithLine('bind', jwt);
  }

  // ── Authed (locked) state ─────────────────────────────────────────────────
  if (!guest) {
    const primary = linked.find((a) => a.primary && a.linked) ?? null;
    const displayLabel = primary?.display_label ?? currentPlayer?.name ?? '';
    const providerName = primary?.provider ?? (currentPlayer as { provider?: string }).provider ?? 'account';
    return (
      <div
        data-testid={`binding-field-locked-${mode}`}
        className="bg-zinc-900/80 border border-emerald-700/40 rounded-lg p-4 space-y-2"
      >
        <div className="text-xs text-zinc-400 font-semibold">
          {t('binding.title', { defaultValue: '登入 / 綁定' })}
        </div>
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-emerald-400" />
          <span className="text-sm font-semibold text-white truncate flex-1">
            @{displayLabel}
          </span>
          <button
            type="button"
            onClick={() => setGameState('settings')}
            data-testid={`binding-field-switch-${mode}`}
            className="text-[11px] text-zinc-400 hover:text-white underline-offset-2 hover:underline"
          >
            {t('binding.switchAccount', { defaultValue: '切換帳號' })}
          </button>
        </div>
        <p className="text-[11px] text-emerald-400/80">
          {t('binding.lockedAs', { defaultValue: '已綁定 {{provider}} · 戰績自動保存', provider: providerName })}
        </p>
      </div>
    );
  }

  // ── Guest state ───────────────────────────────────────────────────────────
  return (
    <div
      data-testid={`binding-field-guest-${mode}`}
      className="bg-zinc-900/80 border border-zinc-700 rounded-lg p-4 space-y-3"
    >
      <div>
        <div className="text-xs text-zinc-400 font-semibold mb-1">
          {t('binding.title', { defaultValue: '登入 / 綁定' })}
        </div>
        <p className="text-[11px] text-zinc-500">
          {t('binding.hint', { defaultValue: '綁定後戰績自動保存，下次登入繼承' })}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => { void handleGoogle(); }}
          disabled={busy !== null || !hasFirebaseAuthConfigured()}
          data-testid={`binding-field-google-${mode}`}
          className="inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-white text-sm font-semibold py-2 px-3 rounded border border-zinc-700 transition-colors"
        >
          {busy === 'google' ? <Loader size={14} className="animate-spin" /> : <Chrome size={14} className="text-blue-400" />}
          Google
        </button>
        <button
          type="button"
          onClick={handleDiscord}
          disabled={busy !== null}
          data-testid={`binding-field-discord-${mode}`}
          className="inline-flex items-center justify-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] disabled:opacity-50 text-white text-sm font-semibold py-2 px-3 rounded transition-colors"
        >
          {busy === 'discord' ? <Loader size={14} className="animate-spin" /> : null}
          Discord
        </button>
        <button
          type="button"
          onClick={handleLine}
          disabled={busy !== null}
          data-testid={`binding-field-line-${mode}`}
          className="inline-flex items-center justify-center gap-2 bg-[#00B900] hover:bg-[#009900] disabled:opacity-50 text-white text-sm font-semibold py-2 px-3 rounded transition-colors"
        >
          {busy === 'line' ? <Loader size={14} className="animate-spin" /> : null}
          LINE
        </button>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <div className="flex-1 h-px bg-zinc-800" />
        <span className="text-[10px] text-zinc-600 uppercase">
          {t('binding.or', { defaultValue: '或' })}
        </span>
        <div className="flex-1 h-px bg-zinc-800" />
      </div>

      <button
        type="button"
        onClick={() => setShowGuestInput(v => !v)}
        data-testid={`binding-field-guest-toggle-${mode}`}
        className="w-full inline-flex items-center justify-center gap-2 bg-transparent hover:bg-zinc-800/60 text-zinc-300 text-xs py-1.5 px-3 rounded border border-zinc-700 transition-colors"
      >
        {showGuestInput ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {t('binding.continueAsGuestExpand', { defaultValue: '以訪客繼續' })}
      </button>

      {showGuestInput && (
        <div className="pt-1 space-y-1.5">
          <label className="text-[11px] text-zinc-400 font-semibold flex items-center gap-1">
            <RotateCcw size={11} />
            {t('binding.guestNameLabel', { defaultValue: '你的名稱' })}
          </label>
          <input
            type="text"
            value={playerName}
            onChange={(e) => onPlayerNameChange(e.target.value)}
            placeholder={t('home.yourName', { defaultValue: '你的名字' })}
            data-testid={`binding-field-guest-name-${mode}`}
            className="w-full bg-black border border-zinc-700 rounded px-3 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-white"
          />
          <p className="text-[10px] text-zinc-500">
            {t('binding.guestReminder', { defaultValue: '小提醒：訪客模式戰績只保存在本裝置' })}
          </p>
        </div>
      )}
    </div>
  );
}
