/**
 * 網站「與機器人練習」— setup card (PracticePage: 導覽列「與機器人練習」按鈕 / #practice).
 * Picks a seat, an optional role and which AI騎士 sits at each of the 9 bot seats (「一隻一隻召喚」, with
 * 「全部同一位」/「隨機混搭」 as quick fills; 站長 2026-11-26), then creates + starts the practice room.
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
import PracticeLineupPicker, { emptyLineup, LINEUP_SIZE, type Lineup, type LineupFill } from './PracticeLineupPicker';

/** 上次的設定 → 陣容（舊版只存了一位 `knight`：全部那一位；`random-mix`：全空、隨機補）。 */
function initialLineup(last: { knight?: string; lineup?: Lineup }): Lineup {
  if (last.lineup) return Array.from({ length: LINEUP_SIZE }, (_, i) => last.lineup?.[i] ?? null);
  if (last.knight && last.knight !== KNIGHT_MIX_ID && last.knight !== DEFAULT_KNIGHT_ID) return Array.from({ length: LINEUP_SIZE }, () => last.knight!);
  return emptyLineup();
}

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
  const [lineup, setLineup] = useState<Lineup>(() => initialLineup(last));
  const [fill, setFill] = useState<LineupFill>(last.fill ?? (last.knight === KNIGHT_MIX_ID && !last.lineup ? 'random' : 'baike'));
  const [busy, setBusy] = useState(false);
  const { knights, ready: knightsReady } = useKnights(ready);

  const handleStart = async (): Promise<void> => {
    if (busy || !ready) return;
    setBusy(true);
    // 名冊裡已經沒有的騎士（或名冊還沒讀到）：那一格當成沒指定。
    const clean = lineup.map((id) => (id && knights.some((k) => k.id === id) ? id : null));
    // 舊版伺服器只認 `knight`：9 格同一位 → 那一位；全空＋隨機 → 隨機混搭；其他 → 百科。
    const same = clean.every((id) => id !== null && id === clean[0]) ? clean[0]! : null;
    const legacy = same ?? (clean.every((id) => id === null) && fill === 'random' ? KNIGHT_MIX_ID : DEFAULT_KNIGHT_ID);
    const ok = await startPractice({ seat, role, knight: legacy, lineup: clean, fill }, (error) => t('createFailed', { error }));
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

      <PracticeLineupPicker
        knights={knights}
        lineup={lineup}
        fill={fill}
        playerSeat={seat}
        onChange={setLineup}
        onFill={setFill}
        loading={!knightsReady && ready}
      />

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
