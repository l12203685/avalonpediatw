/**
 * 網站「與機器人練習」— setup card on the home page (also opened by #practice).
 * Picks a seat and an optional role, then creates + starts the practice room.
 */
import { useState } from 'react';
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

interface Props {
  onBack: () => void;
}

export default function PracticeSetupPanel({ onBack }: Props): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const last = usePracticeStore((s) => s.lastOptions);
  const [seat, setSeat] = useState<number | null>(last.seat);
  const [role, setRole] = useState<PracticeRoleChoice | null>(last.role);
  const [busy, setBusy] = useState(false);

  const handleStart = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const ok = await startPractice({ seat, role }, (error) => t('createFailed', { error }));
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
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => { void handleStart(); }}
          disabled={busy}
          data-testid="practice-start"
          className="w-full inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-black font-bold py-2.5 px-4 rounded-lg transition-colors"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {busy ? t('starting') : t('start')}
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
