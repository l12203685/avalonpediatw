import { motion } from 'framer-motion';
import { Loader, AlertCircle, Crosshair } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { outcomeBlocks } from '../../services/api';
import { chiSquareIndependence, type ChiSquareResult } from '../../utils/chiSquare';
import { useAnalysisOverview, deriveStages } from './useAnalysisOverview';
import {
  MetricBlocks, StatTable, Takeaway, Term, VerdictText, OUTCOME_COLORS, formatRate,
  type MetricBlockRow, type StatColumn,
} from './ui';
import { useMinCellGames } from './OutcomeBlocksTable';

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
  const survivePct = legacy && typeof overview.merlinKillRate === 'number'
    ? Math.round((100 - overview.merlinKillRate) * 10) / 10
    : stages.assassination.survivePct;
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

  return (
    <div className="space-y-3">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-avalon-card/30 border border-gray-700 rounded-xl p-4"
      >
        <div className="flex items-center gap-2 mb-1">
          <Crosshair size={16} className="text-amber-300" />
          <h3 className="text-sm font-bold text-gray-300">{t('analytics.deep.assassination.title')}</h3>
        </div>
        <p className="text-[10px] text-gray-500 mb-3">{t('analytics.deep.assassination.sub')}</p>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-white">{games.toLocaleString()}</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.threeBlueGames')}</p>
          </div>
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-amber-300">{killPct}%</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.killRate')}</p>
            {games > 0 && (
              <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.killedCount', { count: merlinKilled })}</p>
            )}
          </div>
          <div className="bg-gray-800/40 rounded-lg px-3 py-2">
            <p className="text-xl font-black text-blue-300">{survivePct}%</p>
            <p className="text-[10px] text-gray-500">{t('analytics.deep.assassination.surviveRate')}</p>
            {games > 0 && (
              <p className="text-[10px] text-gray-600">{t('analytics.deep.assassination.survivedCount', { count: merlinSurvived })}</p>
            )}
          </div>
        </div>

        <div className="h-2 w-full rounded-full overflow-hidden flex bg-gray-800">
          <div className="h-full bg-amber-500" style={{ width: `${Math.max(0, Math.min(100, killPct))}%` }} />
          <div className="h-full bg-blue-500" style={{ width: `${Math.max(0, Math.min(100, survivePct))}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-1">
          <span className="text-amber-300">{t('analytics.deep.outcomes.threeBlueDead')}</span>
          <span className="text-blue-300">{t('analytics.deep.outcomes.threeBlueAlive')}</span>
        </div>

        <p className="text-[10px] text-gray-600 mt-2">{t('analytics.deep.assassination.rule')}</p>
        {legacy && (
          <p className="text-[10px] text-gray-600 mt-0.5">{t('analytics.deep.assassination.legacy')}</p>
        )}
      </motion.div>

      {blockRows.length > 0 && (
        <MetricBlocks
          caption={<span className="text-xs">{t('analytics.r6.tabsa.assassination.blocksCaption')}</span>}
          rows={blockRows}
          lowSample={min}
          groupLabel={t('analytics.r6.tabsa.assassination.side')}
        />
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
  /** 'all' = 全部三藍局；'group' = 1–5 號／6–10 號合計。 */
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

/** 最高、最低刺中率的座位 (只看 n ≥ min 的座位；都不夠時看全部)。 */
function extremes(rows: SeatKillRow[], role: SeatRole, min: number): { hi: SeatKillRow; lo: SeatKillRow } | null {
  const withRate = rows.filter(r => r[role]?.rate !== null && r[role] !== null);
  const pool = withRate.filter(r => (r[role]?.n ?? 0) >= min);
  const list = pool.length >= 2 ? pool : withRate;
  if (list.length < 2) return null;
  const sorted = [...list].sort((a, b) => (b[role]?.rate ?? 0) - (a[role]?.rate ?? 0));
  return { hi: sorted[0], lo: sorted[sorted.length - 1] };
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
 *    →「差異明顯」或「差異可能只是運氣」附 p，再寫最高／最低的座位與 1–5 號、6–10 號合計 (全部當下從資料算)。
 *  - 表：梅林欄在前；每格一條刺中率長條，白線 = 全部三藍局的刺中率；最後兩列 = 1–5 號、6–10 號合計。
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
    label: t(`${k}.seatLabel`, { seat: s.seat }),
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
  const line = (role: SeatRole): JSX.Element => {
    const ex = extremes(seatRows, role, min);
    return (
      <p>
        <span className="font-semibold text-white">{t(`${k7}.${role}Lead`)}</span>
        <VerdictText result={test(role)} />
        {ex && t(`${k7}.${role}Rest`, {
          hiSeat: ex.hi.seat, hi: formatRate(ex.hi[role]?.rate), hiN: ex.hi[role]?.n,
          loSeat: ex.lo.seat, lo: formatRate(ex.lo[role]?.rate), loN: ex.lo[role]?.n,
        })}
        {role === 'merlin' && groups[0].merlin && groups[1].merlin && t(`${k7}.groups`, {
          front: formatRate(groups[0].merlin.rate), frontN: groups[0].merlin.n,
          back: formatRate(groups[1].merlin.rate), backN: groups[1].merlin.n,
        })}
      </p>
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
    format: (_v, row) => <KillBar cell={row[key]} refRate={overall?.rate ?? null} min={min} />,
    value: r => r[key]?.rate,
    tone: 'amber',
    emphasis: key === 'merlin',
  });

  return (
    <div className="space-y-2">
      <Takeaway>
        {line('merlin')}
        {line('assassin')}
      </Takeaway>
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
    </div>
  );
}
