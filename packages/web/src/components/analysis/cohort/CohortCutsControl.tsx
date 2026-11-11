import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import {
  COHORT_CUT_LIMITS, DEFAULT_COHORT_CUTS, histogramSplit, histogramTerciles, isDefaultCohortCuts, validCohortCuts,
  type CohortCuts, type CohortHistogram,
} from '@avalon/shared/stats';
import { useCohortCuts } from '../../../stats/cohortCuts';
import { InfoTip } from '../ui';
import { K, cohortPct } from './cohortFormat';

/**
 * 分組的四個切點（Edward 2026-11-11「為什麼是 55 跟 38? 這個也可以做成參數可調整嗎?」）：玩家 PR 的上／下切點、桌 S 的
 * 上／下切點，各一個數字框（離開欄位或按 Enter 才套用；上 ≤ 下、超出 1–99、PR 不是整數、S 超過一位小數時不套用並標紅），
 * 「預設」按鈕回到 80／20、55／38。切點全站一份、每位訪客自己記住、跟著分享連結（stats/cohortCuts.ts）。
 * 說明裡即時算目前篩選下每一組佔多少（座位、玩家、局），並列出三等分的切點給對照（histogram = Worker 算好的分布）。
 */

type Field = keyof CohortCuts;
const FIELDS: readonly Field[] = ['prHi', 'prLo', 'sHi', 'sLo'];

function toDraft(c: CohortCuts): Record<Field, string> {
  return { prHi: String(c.prHi), prLo: String(c.prLo), sHi: String(c.sHi), sLo: String(c.sLo) };
}

/** 一份次數表依切點的三份比例（「22% / 56% / 22%」）。 */
function splitText(hist: readonly number[], hi: number, lo: number, scale: number): string {
  const s = histogramSplit(hist, hi, lo, scale);
  return [s.hi, s.mid, s.lo].map((x) => cohortPct(x, s.total)).join(' / ');
}

export function CohortDistribution({ histogram, cuts }: { histogram: CohortHistogram; cuts: CohortCuts }): JSX.Element {
  const { t } = useTranslation('common');
  const d = DEFAULT_COHORT_CUTS;
  const seatT = histogramTerciles(histogram.seatPr, 1);
  const gameT = histogramTerciles(histogram.gameS, 10);
  const seatRated = histogram.seatPr.reduce((a, b) => a + b, 0);
  const playerRated = histogram.playerPr.reduce((a, b) => a + b, 0);
  const gameRated = histogram.gameS.reduce((a, b) => a + b, 0);
  return (
    <>
      <p>
        {t(`${K}.dist.seats`, {
          cur: splitText(histogram.seatPr, cuts.prHi, cuts.prLo, 1), hi: cuts.prHi, lo: cuts.prLo,
          def: splitText(histogram.seatPr, d.prHi, d.prLo, 1),
          rated: seatRated, unrated: histogram.seatUnrated, unratedPct: cohortPct(histogram.seatUnrated, seatRated + histogram.seatUnrated),
        })}
      </p>
      <p>
        {t(`${K}.dist.players`, {
          cur: splitText(histogram.playerPr, cuts.prHi, cuts.prLo, 1), rated: playerRated, unrated: histogram.playerUnrated,
        })}
      </p>
      <p>
        {t(`${K}.dist.games`, {
          cur: splitText(histogram.gameS, cuts.sHi, cuts.sLo, 10), hi: cuts.sHi, lo: cuts.sLo,
          def: splitText(histogram.gameS, d.sHi, d.sLo, 10),
          rated: gameRated, unrated: histogram.gameUnrated,
        })}
      </p>
      {seatT && gameT && (
        <p>{t(`${K}.dist.terciles`, { prHi: seatT.hi, prLo: seatT.lo, sHi: gameT.hi, sLo: gameT.lo })}</p>
      )}
    </>
  );
}

export default function CohortCutsControl({ histogram = null }: { histogram?: CohortHistogram | null }): JSX.Element {
  const { t } = useTranslation('common');
  const cuts = useCohortCuts((s) => s.cuts);
  const setCuts = useCohortCuts((s) => s.setCuts);
  const reset = useCohortCuts((s) => s.reset);
  const [draft, setDraft] = useState<Record<Field, string>>(() => toDraft(cuts));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(toDraft(cuts)); setInvalid(false); }, [cuts]);

  const commit = (): void => {
    const next = Object.fromEntries(FIELDS.map((f) => [f, Number(draft[f])])) as unknown as CohortCuts;
    if (FIELDS.some((f) => draft[f].trim() === '') || !validCohortCuts(next)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next.prHi !== cuts.prHi || next.prLo !== cuts.prLo || next.sHi !== cuts.sHi || next.sLo !== cuts.sLo) setCuts(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { setDraft(toDraft(cuts)); setInvalid(false); }
  };
  const input = (f: Field): JSX.Element => (
    <input
      type="number"
      inputMode="decimal"
      min={COHORT_CUT_LIMITS.min}
      max={COHORT_CUT_LIMITS.max}
      step={f.startsWith('pr') ? 1 : 0.5}
      value={draft[f]}
      onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
      onBlur={commit}
      onKeyDown={onKey}
      aria-label={t(`${K}.cuts.${f}`)}
      aria-invalid={invalid || undefined}
      className={`w-12 rounded border bg-zinc-900 px-1 py-0.5 text-right text-xs text-zinc-100 tabular-nums ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
      data-testid={`cohort-cut-${f}`}
    />
  );

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400" data-testid="cohort-cuts">
      <span className="inline-flex items-center gap-1">
        <span className="text-zinc-300">{t(`${K}.cuts.player`)}</span>
        {t(`${K}.player.strong`)} ≥ {input('prHi')}
        <span className="text-zinc-600">·</span>
        {t(`${K}.player.novice`)} &lt; {input('prLo')}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-zinc-300">{t(`${K}.cuts.table`)}</span>
        {t(`${K}.table.high`)} ≥ {input('sHi')}
        <span className="text-zinc-600">·</span>
        {t(`${K}.table.casual`)} &lt; {input('sLo')}
      </span>
      <button
        type="button"
        onClick={reset}
        disabled={isDefaultCohortCuts(cuts)}
        className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:text-white disabled:opacity-40"
        data-testid="cohort-cuts-reset"
      >
        <RotateCcw size={11} /> {t(`${K}.cuts.reset`)}
      </button>
      <InfoTip title={t(`${K}.cuts.title`)} testId="cohort-cuts-info">
        <p>{t(`${K}.cuts.help.player`)}</p>
        <p>{t(`${K}.cuts.help.table`)}</p>
        <p>{t(`${K}.cuts.help.why`)}</p>
        {histogram && <CohortDistribution histogram={histogram} cuts={cuts} />}
        <p>{t(`${K}.cuts.help.adjust`)}</p>
      </InfoTip>
      {invalid && <span className="text-red-400" role="alert">{t(`${K}.cuts.invalid`)}</span>}
    </div>
  );
}
