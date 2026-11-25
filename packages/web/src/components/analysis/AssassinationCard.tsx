import { motion } from 'framer-motion';
import { Loader, AlertCircle, Crosshair } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks } from '../../services/api';
import { chiSquareIndependence, type ChiSquareResult } from '../../utils/chiSquare';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';
import {
  Advanced, GlanceLegend, InfoTip, KeyNumber, MeterBar, MetricBlocks, RankRow, SplitBar, StatTable, Takeaway, Term, VerdictText,
  OUTCOME_COLORS, formatInt, formatRate,
  type MetricBlockRow, type StatColumn,
} from './ui';
import { killDetailGlance, pctText, seatHalvesSentence, seatKillGlance, type SeatKillGlance, type Share } from './core/glance';
import { hitLegend, hitSegments, sampleText, sentenceText } from './core/glanceView';
import { useMinCellGames } from './OutcomeBlocksTable';
import { seatDisplay } from './seatRoleBlocks';

/**
 * 刺殺結算卡 (docs/stats/two_stage_outcome.md)：只算三藍局 —
 * 三藍死 = 刺中、三藍活 = 沒刺中。資料用 overview.assassinationStage；
 * 舊快取沒有時以 merlinKillRate (三藍局刺中率) 推算，並標明。
 *
 * (2026-10-14 Edward：三塊結果、條件機率附 n、一頁一屏)
 *   - 卡片下面加 MetricBlocks：全部局從紅方、藍方看的 任務結果 / 刺殺結果 / 遊戲結果，
 *     刺殺那一塊的分母是三藍局 (n 跟上面的卡片一樣)，用 @avalon/shared 的 outcomeBlocks 算。
 *   - AssassinationSeatTable (刺殺分頁的「座位與刺殺」)：梅林、刺客坐在各位置時，三藍局的刺中率
 *     (三藍死 ÷ 三藍局，附三藍局數)，資料是 overview.seatPositionWinRates[].roles[].outcomes；
 *     舊快取沒有各位置的角色結果時顯示「下次每日更新後提供」。
 *
 * (2026-11-25 站長：「希望能更直觀讓看到的人一目瞭然」，第二批)
 *   - 刺殺結算：一句話＋一個大數字（梅林被刺中的比例，整數）＋一條「刺中梅林｜沒刺中」比例條＋小字局數；
 *     從紅方、藍方看的三塊結果表收進「進階」。刺中＝紅方贏，全站改用紅色系（原本是琥珀）。
 *   - 座位與刺殺：梅林、刺客各一欄，十個座位各一條刺中率長條（數字直接寫在旁邊、白線＝全體），最高／最低有標記；
 *     句子裡的「n=」拿掉，樣本數寫成小字「樣本 N」；原本的表格收進「進階」。
 *   算法沒有改：刺中率＝三藍死 ÷（三藍死＋三藍活），句子、長條都出自 core/glance.ts 的同一個結果。
 */
export default function AssassinationCard(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  const min = useMinCellGames();

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error || !overview) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const stages = deriveStages(overview);
  const legacy = !overview.assassinationStage;
  const killPct = legacy && typeof overview.merlinKillRate === 'number'
    ? overview.merlinKillRate
    : stages.assassination.killPct;
  const { games, merlinKilled, merlinSurvived } = stages.assassination;

  const ob = overview.outcomeBreakdown;
  const blockRows: MetricBlockRow[] = ob
    ? (['red', 'blue'] as const).map(faction => {
      const b = outcomeBlocks(ob, faction);
      return {
        key: faction,
        label: t(`analytics.ui.blocks.${faction}`),
        tone: faction,
        mission: b.mission,
        assassination: b.assassination,
        final: b.final,
      };
    })
    : [];

  const glance = killDetailGlance({ games, killPct, merlinKilled, merlinSurvived });
  const g = 'analytics.glance.kill';

  return (
    <div className="space-y-2">
      {glance && <Takeaway><p>{sentenceText(t, glance.sentence)}</p></Takeaway>}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
        data-testid="kill-glance"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <Crosshair size={15} className="shrink-0 text-zinc-400" aria-hidden />
            <h3 className="text-xs font-semibold text-zinc-300">{t(`${g}.title`)}</h3>
            {/* 2026-10-30：副標與規則收進 ⓘ */}
            <InfoTip title={t('analytics.deep.assassination.title')}>
              <p>{t('analytics.deep.assassination.sub')}</p>
              <p>{t('analytics.deep.assassination.rule')}</p>
            </InfoTip>
          </div>
          <GlanceLegend items={hitLegend(t)} />
        </div>
        {glance ? (
          <div className="grid items-center gap-x-6 gap-y-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <KeyNumber value={pctText(glance.hit.pct)} label={<Term term="killRate">{t(`${g}.key`)}</Term>} tone="red" />
            <div className="min-w-0">
              <SplitBar size="lg" showNames segments={hitSegments(t, glance.hit)} sample={t(`${g}.sample`, { n: formatInt(glance.hit.n) })} />
              <p className="mt-1 text-[11px] tabular-nums text-zinc-500">
                {t(`${g}.sample`, { n: formatInt(glance.hit.n) })}
                {' · '}
                {t(`${g}.counts`, { killed: formatInt(glance.killed), survived: formatInt(glance.survived) })}
              </p>
            </div>
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-zinc-500">{t('analytics.ui.table.empty')}</p>
        )}
        {legacy && (
          <p className="mt-2 text-[10px] text-zinc-600">{t('analytics.deep.assassination.legacy')}</p>
        )}
      </motion.section>

      {blockRows.length > 0 && (
        <Advanced title={t(`${g}.advanced`)} testId="kill-advanced">
          {() => (
            <MetricBlocks
              caption={<span className="text-xs">{t('analytics.r6.tabsa.assassination.blocksCaption')}</span>}
              rows={blockRows}
              lowSample={min}
              groupLabel={t('analytics.r6.tabsa.assassination.side')}
            />
          )}
        </Advanced>
      )}
    </div>
  );
}

interface KillCell {
  /** 三藍死 (刺中)。 */
  dead: number;
  /** 三藍局數。 */
  n: number;
  /** 刺中率 0–100；n = 0 時 null。 */
  rate: number | null;
}

interface SeatKillRow {
  key: string;
  label: string;
  /** 'all' = 全部三藍局；'group' = 1～5 家／6～0 家合計。 */
  kind?: 'all' | 'group';
  seat?: string;
  merlin: KillCell | null;
  assassin: KillCell | null;
}

type SeatRole = 'merlin' | 'assassin';
const SEAT_ROLE_NAME: Record<SeatRole, string> = { merlin: '梅林', assassin: '刺客' };

function killCell(o: { threeBlueDead?: number; threeBlueAlive?: number } | null | undefined): KillCell | null {
  if (!o) return null;
  const dead = Number.isFinite(o.threeBlueDead) ? Math.max(0, o.threeBlueDead as number) : 0;
  const alive = Number.isFinite(o.threeBlueAlive) ? Math.max(0, o.threeBlueAlive as number) : 0;
  const n = dead + alive;
  return { dead, n, rate: n > 0 ? (dead / n) * 100 : null };
}

function sumCells(cells: Array<KillCell | null>): KillCell | null {
  const live = cells.filter((c): c is KillCell => c !== null);
  if (live.length === 0) return null;
  const dead = live.reduce((s, c) => s + c.dead, 0);
  const n = live.reduce((s, c) => s + c.n, 0);
  return { dead, n, rate: n > 0 ? (dead / n) * 100 : null };
}

/** 刺中率長條：0–100%，白線 = 全部三藍局的刺中率 (高於／低於平均一眼看得出來)；n 固定寬度，長條才對齊 (手機省略 n，移上去看)。 */
function KillBar({ cell, refRate, min }: { cell: KillCell | null; refRate: number | null; min: number }): JSX.Element {
  const { t } = useTranslation('common');
  const rate = cell?.rate ?? null;
  const low = cell !== null && cell.n < min;
  return (
    <span
      className={`inline-flex items-center gap-2 ${low ? 'opacity-50' : ''}`}
      title={low ? t('analytics.ui.table.lowSample', { min }) : cell ? t('analytics.ui.table.nTitle', { n: cell.n }) : undefined}
    >
      <span aria-hidden className="relative inline-block h-2.5 w-12 overflow-hidden rounded-sm bg-zinc-800 sm:w-44">
        {rate !== null && (
          <span className="absolute inset-y-0 left-0 rounded-sm" style={{ width: `${Math.min(100, rate)}%`, backgroundColor: OUTCOME_COLORS.三藍死 }} />
        )}
        {refRate !== null && <span className="absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${Math.min(100, refRate)}%` }} />}
      </span>
      <span className="w-10 text-right sm:w-11">{formatRate(rate)}</span>
      <span className="hidden w-12 text-left text-[10px] font-normal text-zinc-500 sm:inline">{cell ? t('analytics.ui.table.n', { n: cell.n }) : ''}</span>
    </span>
  );
}

/**
 * 刺殺 › 座位與刺殺 (Edward 2026-10-28：「刺客座位有影響嗎? 梅林座位影響比較大吧」)。
 *  - 最上面一句話：梅林坐的位置、刺客坐的位置各做一次卡方檢定 (10 個座位 × 刺中／沒刺中，只算三藍局)
 *    →「差異明顯」或「差異可能只是運氣」附 p，再寫最高／最低的座位與 1～5 家、6～0 家合計 (全部當下從資料算)。
 *  - 表：梅林欄在前；每格一條刺中率長條，白線 = 全部三藍局的刺中率；最後兩列 = 1～5 家、6～0 家合計（座位資料鍵 "10" 顯示成 0）。
 *  資料：overview.seatPositionWinRates[].roles[].outcomes (跟著篩選)；舊快取沒有時顯示「下次每日更新後提供」。
 */
export function AssassinationSeatTable(): JSX.Element {
  const { t } = useTranslation('common');
  const { overview, loading, error } = useAnalysisOverview();
  const min = useMinCellGames();
  const k = 'analytics.r6.tabsa.assassination';
  const k7 = 'analytics.r7.seatKill';

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-gray-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error || !overview) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-red-400">
        <AlertCircle size={14} /> {error || t('analytics.deep.loadFailed')}
      </div>
    );
  }

  const seats = [...(overview.seatPositionWinRates ?? [])].sort((a, b) => Number(a.seat) - Number(b.seat));
  const seatRows: SeatKillRow[] = seats.map(s => ({
    key: s.seat,
    seat: s.seat,
    label: t(`${k}.seatLabel`, { seat: seatDisplay(s.seat) }),
    merlin: killCell(s.roles?.find(r => r.role === SEAT_ROLE_NAME.merlin)?.outcomes),
    assassin: killCell(s.roles?.find(r => r.role === SEAT_ROLE_NAME.assassin)?.outcomes),
  }));
  if (!seatRows.some(r => r.merlin && r.merlin.n > 0)) {
    return (
      <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-xs text-zinc-500">
        {t(`${k}.seatMissing`)}
      </p>
    );
  }
  const overall = killCell(overview.outcomeBreakdown);
  const front = seatRows.filter(r => Number(r.seat) >= 1 && Number(r.seat) <= 5);
  const back = seatRows.filter(r => Number(r.seat) >= 6 && Number(r.seat) <= 10);
  const groupRow = (key: string, list: SeatKillRow[], label: string): SeatKillRow => ({
    key, kind: 'group', label, merlin: sumCells(list.map(r => r.merlin)), assassin: sumCells(list.map(r => r.assassin)),
  });
  const groups = [groupRow('front', front, t(`${k7}.front`)), groupRow('back', back, t(`${k7}.back`))];
  const rows: SeatKillRow[] = [
    ...(overall ? [{ key: 'all', kind: 'all' as const, label: t(`${k}.allThreeBlue`), merlin: overall, assassin: overall }] : []),
    ...seatRows,
    ...groups,
  ];

  const test = (role: SeatRole): ChiSquareResult | null =>
    chiSquareIndependence(seatRows.map(r => [r[role]?.dead ?? 0, (r[role]?.n ?? 0) - (r[role]?.dead ?? 0)]));
  const g = 'analytics.glance.seatKill';
  const toShare = (c: KillCell | null): Share | null => (c && c.rate !== null && c.n > 0 ? { pct: c.rate, n: c.n } : null);
  const glanceOf = (role: SeatRole): SeatKillGlance => seatKillGlance(
    seatRows.map(r => ({ seat: seatDisplay(r.seat ?? ''), dead: r[role]?.dead ?? 0, n: r[role]?.n ?? 0 })), role, min,
  );
  const glances: Record<SeatRole, SeatKillGlance> = { merlin: glanceOf('merlin'), assassin: glanceOf('assassin') };
  const halves = seatHalvesSentence(toShare(groups[0].merlin), toShare(groups[1].merlin));
  const line = (role: SeatRole): JSX.Element | null => {
    const sentence = glances[role].sentence;
    if (!sentence) return null;
    return (
      <p>
        {sentenceText(t, sentence)}
        <VerdictText result={test(role)} />
        {t(`${g}.end`)}
        {role === 'merlin' && sentenceText(t, halves)}
      </p>
    );
  };
  const seatBar = (key: string, label: string, share: Share | null, tag?: string): JSX.Element | null => (share ? (
    <RankRow key={key} label={label} tag={tag} sample={sampleText(t, share.n, 'plain')} thin={share.n < min ? t('analytics.glance.thin') : undefined}>
      <MeterBar
        pct={share.pct}
        text={pctText(share.pct)}
        tone="red"
        refPct={overall?.rate ?? null}
        label={`${label} ${pctText(share.pct)}（${sampleText(t, share.n, 'plain')}）`}
      />
    </RankRow>
  ) : null);
  const column = (role: SeatRole): JSX.Element => {
    const gl = glances[role];
    return (
      <div className="min-w-0 space-y-1.5" data-testid={`seat-kill-${role}`}>
        <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.${role}Title`)}</h4>
        {gl.rows.map(r => seatBar(
          r.seat,
          t(`${k}.seatLabel`, { seat: r.seat }),
          r.share,
          r.seat === gl.hi ? t(`${g}.hi`) : r.seat === gl.lo ? t(`${g}.lo`) : undefined,
        ))}
        <div className="space-y-1.5 border-t border-zinc-800 pt-1.5">
          {groups.map(gr => seatBar(gr.key, gr.label, toShare(gr[role])))}
        </div>
      </div>
    );
  };

  const killColumn = (key: SeatRole): StatColumn<SeatKillRow> => ({
    key,
    label: (
      <span className="inline-flex flex-col items-end gap-0.5">
        <span className="text-[11px] font-semibold text-zinc-300">{t(`${k}.${key}Seat`)}</span>
        <span className="text-[10px] font-normal text-zinc-500"><Term term="killRate">{t(`${k7}.rateLabel`)}</Term></span>
      </span>
    ),
    title: t(`${k}.${key}SeatTitle`),
    align: 'right',
    format: (_v, row): JSX.Element => <KillBar cell={row[key]} refRate={overall?.rate ?? null} min={min} />,
    value: r => r[key]?.rate,
    tone: 'kill',
    emphasis: key === 'merlin',
  });

  const fullTable = (
    <StatTable
      caption={t(`${k}.seatCaption`)}
      columns={[
        { key: 'label', label: t(`${k}.seat`), value: r => r.label },
        killColumn('merlin'),
        killColumn('assassin'),
      ]}
      rows={rows}
      rowKey={r => r.key}
      highlightRow={r => r.kind !== undefined}
      footnote={<>{t(`${k7}.note`)} {t('analytics.r6.tabsa.outcomeTable.lowSample', { min })}</>}
    />
  );

  return (
    <div className="space-y-2">
      {(glances.merlin.sentence || glances.assassin.sentence) && (
        <Takeaway>
          {line('merlin')}
          {line('assassin')}
        </Takeaway>
      )}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="seat-kill-glance">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="text-xs font-semibold text-zinc-300"><Term term="killRate">{t(`${g}.title`)}</Term></h3>
          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
            <span className="inline-block h-3 w-0.5 bg-white/80" aria-hidden />
            {t(`${g}.refLegend`, { rate: overall && overall.rate !== null ? pctText(overall.rate) : '—' })}
          </span>
        </div>
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          {column('merlin')}
          {column('assassin')}
        </div>
      </section>
      <Advanced title={t(`${g}.advanced`)} testId="seat-kill-advanced">{() => fullTable}</Advanced>
    </div>
  );
}
