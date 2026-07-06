/**
 * IdentityBadge — lobby-wide "who am I right now" pill.
 *
 * Design SSoT: staging/subagent_results/design_pregame_binding_2026-04-24.md
 * Task:        hineko_20260424_1040_ux_phase2_modal_badge
 *
 * Three states:
 *   - guest → grey pill, shows the guest display name
 *   - authed w/ primary email → gold pill with the email + provider icon
 *   - authed w/o any linked account (edge case) → gold pill with just the name
 *
 * Reads linked-account info lazily (first mount fetches, re-renders when
 * `currentPlayer.provider` flips guest → registered). Keeps a non-blocking
 * fallback so the pill always renders *something* even if the API fails.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck, UserCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/gameStore';
import { fetchLinkedAccounts, LinkedAccount } from '../services/api';
import { getStoredToken } from '../services/socket';

function isGuestPlayer(player: { name?: string; provider?: string } | null | undefined): boolean {
  if (!player) return true;
  if (player.provider) return player.provider === 'guest';
  return /^Guest_\d{3,}$/i.test(player.name ?? '');
}

export default function IdentityBadge(): JSX.Element | null {
  const { t } = useTranslation();
  const { currentPlayer } = useGameStore();
  const [linked, setLinked] = useState<LinkedAccount[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const guest = isGuestPlayer(currentPlayer);
  const playerId = currentPlayer?.id ?? null;

  useEffect(() => {
    if (guest || !playerId) {
      setLinked([]);
      setLoadedFor(null);
      return;
    }
    if (loadedFor === playerId) return;
    const token = getStoredToken();
    if (!token) return;
    fetchLinkedAccounts(token)
      .then((accounts) => {
        setLinked(accounts);
        setLoadedFor(playerId);
      })
      .catch(() => { /* keep the fallback (just-a-name) pill */ });
  }, [guest, playerId, loadedFor]);

  if (!currentPlayer) return null;

  if (guest) {
    return (
      <div
        data-testid="identity-badge-guest"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800/70 border border-zinc-700 text-zinc-300 text-[11px]"
        title={t('badge.guestHint', { defaultValue: '訪客模式 · 點大廳按鈕綁定保留戰績' })}
      >
        <UserCircle2 size={12} className="text-zinc-400" />
        <span className="font-semibold">{t('badge.guest', { defaultValue: '訪客' })}</span>
        <span className="text-zinc-500">·</span>
        <span className="truncate max-w-[9rem]">{currentPlayer.name}</span>
      </div>
    );
  }

  const primary = linked.find((a) => a.primary && a.linked) ?? null;
  const primaryLabel = primary?.display_label ?? currentPlayer.name;
  const providerName = primary?.provider ?? (currentPlayer as { provider?: string }).provider ?? 'account';

  return (
    <div
      data-testid="identity-badge-verified"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/40 border border-amber-700/50 text-amber-200 text-[11px]"
      title={t('badge.primaryProvider', {
        defaultValue: '以 {{provider}} 為主',
        provider: providerName,
      })}
    >
      <ShieldCheck size={12} className="text-amber-300" />
      <span className="truncate max-w-[9rem] font-semibold">{primaryLabel}</span>
    </div>
  );
}
