/**
 * 練習台「一隻一隻召喚」（站長 2026-11-26：「如果要跟某幾個特定風格的AI騎士打練習局 可以在玩之前讓玩家自己設定好嗎 就像是一隻一隻召喚這樣」）。
 *
 * 9 個機器人座位各選一位 AI騎士（同一位可以選好幾次，座位名照座位順序 _01、_02）；沒選的座位用「百科」或「隨機」補。
 * 「全部同一位」「隨機混搭」是把 9 格一次填好的快捷鍵，填完還能一格一格改。角色照樣隨機發。
 */
import { useTranslation } from 'react-i18next';
import { Eraser, Shuffle } from 'lucide-react';
import { PRACTICE_NS } from '../../i18n/practice';
import { DEFAULT_KNIGHT_ID, knightBlurb, type KnightSummary } from '../../services/knights';

export const LINEUP_SIZE = 9;
export type Lineup = Array<string | null>;
export type LineupFill = 'baike' | 'random';

export function emptyLineup(): Lineup {
  return Array.from({ length: LINEUP_SIZE }, () => null);
}

/** 9 格各抽一位（不重複，名冊不夠再重來）。 */
export function randomLineup(knights: readonly KnightSummary[], rand: () => number = Math.random): Lineup {
  const out: Lineup = [];
  let pool: string[] = [];
  while (out.length < LINEUP_SIZE && knights.length > 0) {
    if (pool.length === 0) {
      pool = knights.map((k) => k.id);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
    out.push(pool.pop()!);
  }
  while (out.length < LINEUP_SIZE) out.push(null);
  return out;
}

/** 這 9 格實際坐哪幾家：玩家選了座位 → 其他 9 個座位（照順序）；隨機 → null（只顯示「第 N 位」）。 */
export function botSeatNumbers(playerSeat: number | null): number[] | null {
  if (playerSeat === null) return null;
  return Array.from({ length: 10 }, (_, i) => i + 1).filter((n) => n !== playerSeat);
}

/** 每一格的座位名（AI騎士_ED_01、同一位第二格 _02）；沒選 → null。 */
export function lineupSeatNames(lineup: Lineup, knights: readonly KnightSummary[]): Array<string | null> {
  const count = new Map<string, number>();
  return lineup.map((id) => {
    const k = id ? knights.find((x) => x.id === id) : undefined;
    if (!k) return null;
    const n = (count.get(k.id) ?? 0) + 1;
    count.set(k.id, n);
    return `${k.name}_${n < 10 ? `0${n}` : n}`;
  });
}

interface Props {
  knights: readonly KnightSummary[];
  lineup: Lineup;
  fill: LineupFill;
  playerSeat: number | null;
  onChange: (lineup: Lineup) => void;
  onFill: (fill: LineupFill) => void;
  loading?: boolean;
}

const SELECT = 'w-full min-w-0 bg-black border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-white';

export default function PracticeLineupPicker({ knights, lineup, fill, playerSeat, onChange, onFill, loading }: Props): JSX.Element {
  const { t } = useTranslation(PRACTICE_NS);
  const seats = botSeatNumbers(playerSeat);
  const names = lineupSeatNames(lineup, knights);
  const label = (k: KnightSummary): string => (k.tag ? `${k.name}（${k.tag}）` : k.name);
  const seatText = (n: number): string => (n === 10 ? t('seatTen') : t('seatOption', { seat: n }));
  const setSlot = (i: number, id: string | null): void => {
    const next = [...lineup];
    next[i] = id;
    onChange(next);
  };

  return (
    <fieldset data-testid="practice-lineup" className="space-y-2 rounded-lg border border-zinc-700/80 bg-black/30 p-2.5 sm:p-3">
      <legend className="px-1 text-xs font-semibold text-zinc-300">{t('lineupTitle')}</legend>
      <p className="text-[11px] leading-relaxed text-zinc-500" data-testid="practice-lineup-roles-note">{t('lineupRolesNote')}</p>

      {/* 快捷鍵：一次填滿 9 格（填完還能一格一格改） */}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          data-testid="practice-lineup-all"
          value=""
          onChange={(e) => { if (e.target.value) onChange(Array.from({ length: LINEUP_SIZE }, () => e.target.value)); }}
          className={`${SELECT} flex-1 basis-40`}
          aria-label={t('presetAll')}
        >
          <option value="">{t('presetAll')}</option>
          {knights.map((k) => <option key={k.id} value={k.id}>{label(k)}</option>)}
        </select>
        <button
          type="button"
          data-testid="practice-lineup-mix"
          onClick={() => onChange(randomLineup(knights))}
          disabled={knights.length < 2}
          className="inline-flex items-center gap-1 rounded-lg border border-emerald-700 bg-emerald-950/50 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-900/50 disabled:opacity-50"
        >
          <Shuffle size={13} />{t('presetMix')}
        </button>
        <button
          type="button"
          data-testid="practice-lineup-clear"
          onClick={() => onChange(emptyLineup())}
          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-800"
        >
          <Eraser size={13} />{t('presetClear')}
        </button>
      </div>

      {seats === null && <p className="text-[11px] leading-relaxed text-zinc-500">{t('lineupRandomSeat')}</p>}

      <ol className="space-y-1.5">
        {lineup.map((id, i) => {
          const k = id ? knights.find((x) => x.id === id) : undefined;
          return (
            <li key={i} className="grid grid-cols-[3.25rem_1fr] items-start gap-x-2" data-testid={`practice-lineup-slot-${i}`}>
              <span className="pt-1.5 text-xs font-semibold text-zinc-400 tabular-nums">
                {seats ? seatText(seats[i]) : t('botSlot', { n: i + 1 })}
              </span>
              <div className="min-w-0 space-y-0.5">
                <select
                  value={k ? k.id : ''}
                  onChange={(e) => setSlot(i, e.target.value || null)}
                  className={SELECT}
                  aria-label={seats ? seatText(seats[i]) : t('botSlot', { n: i + 1 })}
                >
                  <option value="">{fill === 'random' ? t('slotEmptyRandom') : t('slotEmptyBaike')}</option>
                  {knights.map((x) => <option key={x.id} value={x.id}>{label(x)}</option>)}
                </select>
                {k && (
                  <p className="truncate text-[11px] text-zinc-400" title={k.style}>
                    <span className="text-emerald-200/90">{names[i]}</span>
                    {k.id !== DEFAULT_KNIGHT_ID ? ` · ${knightBlurb(k.style)}` : ''}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2 pt-0.5" role="radiogroup" aria-label={t('fillLabel')}>
        <span className="text-xs font-semibold text-zinc-400">{t('fillLabel')}</span>
        {(['baike', 'random'] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={fill === f}
            data-testid={`practice-lineup-fill-${f}`}
            onClick={() => onFill(f)}
            className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
              fill === f ? 'border-white bg-white text-black' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {f === 'baike' ? t('fillBaike') : t('fillRandom')}
          </button>
        ))}
      </div>
      {loading && <p className="text-[11px] text-zinc-500">{t('knightLoading')}</p>}
    </fieldset>
  );
}
