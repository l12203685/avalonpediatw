/**
 * 網站「與機器人練習」— setup card (PracticePage: 導覽列「與機器人練習」按鈕 / #practice).
 * Picks a seat, an optional role and which AI騎士 the 9 bots are (one knight for all, or a random mix;
 * 站長 2026-11-26「練習台想呼叫AI騎士_ED」), then creates + starts the practice room.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, Play } from 'lucide-react';
import '../../i18n/practice';
import { PRACTICE_NS } from '../../i18n/practice';
import { usePracticeStore } from '../../store/practiceStore';
import {
  PRACTICE_ROLE_CHOICES,
  startPractice,
  type PracticeRoleChoice,
} from '../../services/practice';
import { DEFAULT_KNIGHT_ID, KNIGHT_MIX_ID, useKnights } from '../../services/knights';

interface Props {
  onBack: () => void;
  /** False while the server / session is not connected yet: start is disabled. */
  ready?: boolean;
  /** Connection state / identity line shown above the start button. */
  status?: ReactNode;
}

export default function PracticeSetupPanel({ onBack, ready = true, status }: Props): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const last = usePracticeStore((s) => s.lastOptions);
  const [seat, setSeat] = useState<number | null>(last.seat);
  const [role, setRole] = useState<PracticeRoleChoice | null>(last.role);
  const [knight, setKnight] = useState<string>(last.knight ?? DEFAULT_KNIGHT_ID);
  const [busy, setBusy] = useState(false);
  const { knights, ready: knightsReady } = useKnights(ready);
  // 上次選的騎士已經不在名冊裡（或名冊還沒讀到）：選單顯示百科，送出也送百科。
  const knightKnown = knight === KNIGHT_MIX_ID || knights.some((k) => k.id === knight);
  const knightValue = knightKnown ? knight : DEFAULT_KNIGHT_ID;
  const picked = knights.find((k) => k.id === knightValue);

  const handleStart = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true);
    const ok = await startPractice({ seat, role, knight: knightValue }, (error) => t('createFailed', { error }));
    if (!ok) setBusy(false);
  };

  return (
    <div
      data-testid="practice-setup"
      className="space-y-4 bg-zinc-900/80 p-4 sm:p-6 rounded-lg border border-emerald-700/60 text-left"
    >
      <h2 className="flex items-center justify-center gap-2 text-xl sm:text-2xl font-bold text-white">
        <Bot size={22} className="text-emerald-300" />
        {t('setupTitle')}
      </h2>

      <div className="space-y-1.5 text-xs sm:text-sm leading-relaxed text-zinc-300">
        <p>{t('setupIntro')}</p>
        <p className="text-amber-200/90">{t('setupNotRecorded')}</p>
        <p>{t('setupReview')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="space-y-1 block">
          <span className="text-xs font-semibold text-zinc-400">{t('seatLabel')}</span>
          <select
            data-testid="practice-seat"
            value={seat === null ? 'random' : String(seat)}
            onChange={(e) => setSeat(e.target.value === 'random' ? null : Number(e.target.value))}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-white"
          >
            <option value="random">{t('random')}</option>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={String(n)}>
                {n === 10 ? t('seatTen') : t('seatOption', { seat: n })}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 block">
          <span className="text-xs font-semibold text-zinc-400">{t('roleLabel')}</span>
          <select
            data-testid="practice-role"
            value={role ?? 'random'}
            onChange={(e) => setRole(e.target.value === 'random' ? null : (e.target.value as PracticeRoleChoice))}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-white"
          >
            <option value="random">{t('random')}</option>
            {PRACTICE_ROLE_CHOICES.map((r) => (
              <option key={r} value={r}>{t(`role.${r}`)}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 block sm:col-span-2">
          <span className="text-xs font-semibold text-zinc-400">{t('knightLabel')}</span>
          <select
            data-testid="practice-knight"
            value={knightValue}
            onChange={(e) => setKnight(e.target.value)}
            className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-white"
          >
            {knights.map((k) => (
              <option key={k.id} value={k.id}>
                {k.id === DEFAULT_KNIGHT_ID ? t('knightDefault', { name: k.name }) : k.tag ? `${k.name}（${k.tag}）` : k.name}
              </option>
            ))}
            {knights.length > 1 && <option value={KNIGHT_MIX_ID}>{t('knightMix')}</option>}
          </select>
          <span className="block text-[11px] leading-relaxed text-zinc-400" data-testid="practice-knight-style">
            {knightValue === KNIGHT_MIX_ID ? t('knightMixHint') : picked?.style ?? ''}
            {!knightsReady && ready ? ` ${t('knightLoading')}` : ''}
          </span>
        </label>
      </div>

      <div className="space-y-2">
        {status}
        <button
          type="button"
          onClick={() => { void handleStart(); }}
          disabled={busy || !ready}
          data-testid="practice-start"
          className="w-full inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-black font-bold py-2.5 px-4 rounded-lg transition-colors"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {busy ? t('starting') : ready ? t('start') : t('waitingServer')}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="w-full bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-2 px-4 rounded-lg transition-colors border border-zinc-700"
        >
          {t('back')}
        </button>
      </div>
    </div>
  );
}
