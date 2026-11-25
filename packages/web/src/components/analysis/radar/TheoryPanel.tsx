import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtTheoryPct, roleFaction } from '../../../services/api';
import type { AnalysisTheorySettings } from '../../../services/api';
import { Advanced, StatTable, Takeaway, type StatColumn } from '../ui';
import { theoryGlance } from '../core/glance';
import { sentenceText } from '../core/glanceView';
import { useMediaQuery, WIDE_BOARD_QUERY } from '../../../hooks/useMediaQuery';
import {
  orderedRoles, roleCellStatus, roleWindowSizes, roleWindowsFinal,
  type PlayerRadarModel, type RoleCellStatus,
} from './radarModel';

/**
 * 玩家雷達 > 理論勝率 (2026-10-14 Edward：近 50 場太少 —
 *   角色理論 = Σ 抽到該角色的機率 × 本人該角色最近 K 場的最終勝率 (各角色近 10 場、忠臣近 40 場)
 *   位置理論 = 近 100 場
 *   整體理論 = 生涯全部場次的角色理論，生涯滿 250 場才列；2026-10-28 起 = 生涯的位置 × 角色 (70 格)，
 *   舊快取沒有 career.overallTheory 時仍顯示生涯角色理論)。
 *
 * 左表：三種理論勝率 + 用到的場數 / 視窗、是否打滿、補值格數、同一段場次實際的最終勝率。
 * 右表：角色理論每個角色用到的場次 (勝／場、視窗、進總和的勝率、打滿／未打滿／補值／沒打過)。
 * 視窗與門檻全讀 theorySettings() (overview.theoryConfig)，不寫死；舊快取 (schemaVersion < 4) 沒有
 * roleWindows → 角色理論那一列與右表顯示「下次每日更新後提供」，位置理論讀 last100、整體理論讀 career。
 * (2026-11-25 站長「一目瞭然」，第四批) 最上面一句話：照角色算預期贏多少、同一段場次實際贏多少（表上同一列的兩個數字）；
 * 手機上左表（六欄，很寬）收進「進階」，換成三行「理論名稱：數字」。
 */

type TheoryKey = 'role' | 'position' | 'overall';

interface TheoryRow {
  key: TheoryKey;
  /** 理論勝率；null 時顯示 note。 */
  rate: number | null;
  note: string;
  n: number | null;
  range: string;
  games: string;
  /** 補值格數；不知道為 null。 */
  topUp: number | null;
  final: number | null;
  finalN: number | null;
}

interface RoleRow {
  role: string;
  games: number;
  wins: number;
  window: number;
  rate: number;
  status: RoleCellStatus;
}

const STATUS_CLASS: Record<RoleCellStatus, string> = {
  full: 'text-zinc-300',
  partial: 'text-zinc-400',
  topUp: 'text-amber-300',
  none: 'text-amber-300/80',
};

export default function TheoryPanel({
  model, settings,
}: { model: PlayerRadarModel; settings: AnalysisTheorySettings }): JSX.Element {
  const { t } = useTranslation('common');
  const { roleWindows: rw, positionWindow: pw, career } = model;
  const { special, loyal } = roleWindowSizes(settings);
  const minCell = settings.theoryMinCellGames;
  const pending = t('analytics.r6.radar.pending');
  const full = (ok: boolean): string => t(ok ? 'analytics.r6.radar.theory.full' : 'analytics.r6.radar.theory.notFull');

  const rwFinal = rw ? roleWindowsFinal(rw) : null;
  const rwWindow = rw ? Object.values(rw.roles).reduce((s, c) => s + (typeof c?.window === 'number' ? c.window : 0), 0) : 0;
  const overallOk = career !== null && career.games >= settings.overallMinGames;

  const rows: TheoryRow[] = [
    {
      key: 'role',
      rate: rw?.roleTheory ?? null,
      note: pending,
      n: rw?.games ?? null,
      range: t('analytics.r6.radar.theory.windowRole', { special, loyal }),
      games: rw ? `${rw.games} / ${rwWindow} · ${full(rw.fullWindows)}` : '—',
      topUp: rw?.sparseRoles ?? null,
      final: rwFinal?.rate ?? null,
      finalN: rwFinal?.n ?? null,
    },
    {
      key: 'position',
      rate: pw?.positionTheory ?? null,
      note: pending,
      n: pw?.games ?? null,
      range: t('analytics.r6.radar.theory.windowPosition', { count: settings.positionGames }),
      games: pw ? `${pw.games} / ${settings.positionGames} · ${full(pw.games >= settings.positionGames)}` : '—',
      topUp: pw?.sparseSeats ?? null,
      final: pw?.finalWinRate ?? null,
      finalN: pw?.games ?? null,
    },
    {
      key: 'overall',
      rate: overallOk ? (career.overallTheory ?? career.roleTheory) : null,
      note: career ? t('analytics.r6.radar.theory.overallLocked', { min: settings.overallMinGames }) : pending,
      n: overallOk ? career.games : null,
      range: t('analytics.r6.radar.theory.windowCareer'),
      games: career ? t('analytics.r6.radar.theory.careerGames', { count: career.games }) : '—',
      topUp: overallOk ? (career.sparseCells ?? career.sparseRoles) : null,
      final: career?.finalWinRate ?? null,
      finalN: career?.games ?? null,
    },
  ];

  const muted = (text: ReactNode): JSX.Element => <span className="font-normal text-zinc-500">{text}</span>;
  const wide = useMediaQuery(WIDE_BOARD_QUERY);
  const lead = sentenceText(t, theoryGlance(
    { rate: rows[0].rate, actual: rows[0].final },
    { rate: rows[1].rate, actual: rows[1].final },
    model.player.name,
  ));

  const theoryColumns: StatColumn<TheoryRow>[] = [
    {
      key: 'label',
      label: t('analytics.r6.radar.theory.colTheory'),
      value: row => t(`analytics.r6.radar.theory.${row.key}`),
    },
    {
      key: 'rate',
      label: t('analytics.r6.radar.theory.colRate'),
      align: 'right',
      format: (_v, row) => (row.rate === null ? muted(row.note) : fmtTheoryPct(row.rate)),
      n: row => (row.rate === null ? null : row.n),
      tone: 'amber',
      emphasis: true,
    },
    {
      key: 'range',
      label: t('analytics.r6.radar.theory.colRange'),
      // 格子本身是 nowrap；長的說明 (英文) 包在有寬度上限的 block 裡才會換行，表格不會撐出容器。
      format: v => <span className="block min-w-[7.5rem] max-w-[10.5rem] whitespace-normal text-[11px] leading-snug">{String(v)}</span>,
    },
    { key: 'games', label: t('analytics.r6.radar.theory.colGames'), title: t('analytics.r6.radar.theory.colGamesHint') },
    {
      key: 'topUp',
      label: t('analytics.r6.radar.theory.colTopUp'),
      title: t('analytics.r6.radar.theory.colTopUpHint', { n: minCell }),
      align: 'right',
      format: v => (typeof v === 'number' ? t('analytics.r6.radar.theory.cells', { count: v }) : '—'),
    },
    {
      key: 'final',
      label: t('analytics.r6.radar.theory.colFinal'),
      title: t('analytics.r6.radar.theory.colFinalHint'),
      align: 'right',
      format: 'pct',
      n: 'finalN',
    },
  ];

  const roleRows: RoleRow[] = rw
    ? orderedRoles(Object.keys(rw.roles)).flatMap(role => {
      const c = rw.roles[role];
      if (!c || typeof c.games !== 'number') return [];
      return [{
        role, games: c.games, wins: c.wins, window: c.window, rate: c.rate,
        status: roleCellStatus(c.games, c.window, minCell),
      }];
    })
    : [];

  const roleColumns: StatColumn<RoleRow>[] = [
    { key: 'role', label: t('analytics.r6.radar.theory.colRole'), tone: row => roleFaction(row.role) },
    {
      key: 'wins',
      label: t('analytics.r6.radar.theory.colWins'),
      align: 'right',
      format: (_v, row) => `${row.wins} / ${row.games}`,
    },
    { key: 'window', label: t('analytics.r6.radar.theory.colWindow'), align: 'right', format: 'int' },
    {
      key: 'rate',
      label: t('analytics.r6.radar.theory.colCellRate'),
      title: t('analytics.r6.radar.theory.colCellRateHint'),
      align: 'right',
      format: 'pct',
      n: 'games',
      lowSample: minCell > 0 ? minCell : undefined,
      emphasis: true,
    },
    {
      key: 'status',
      label: t('analytics.r6.radar.theory.colStatus'),
      format: (_v, row) => (
        <span className={STATUS_CLASS[row.status]}>{t(`analytics.r6.radar.theory.status.${row.status}`, { n: minCell })}</span>
      ),
    },
  ];

  const summaryTable = (
    <StatTable
      caption={t('analytics.r6.radar.theory.summaryCaption')}
      columns={theoryColumns}
      rows={rows}
      rowKey={row => row.key}
      footnote={
        <>
          {t('analytics.r6.radar.theory.note', {
            special, loyal, position: settings.positionGames, overall: settings.overallMinGames,
          })}
          {minCell > 0 && <> {t('analytics.r6.radar.theory.noteTopUp', { n: minCell })}</>}
        </>
      }
    />
  );
  // 手機：三行「理論：數字（範圍）」，完整的表收進進階
  const phoneSummary = (
    <div className="min-w-0 space-y-2">
      <div className="text-sm font-bold text-zinc-200">{t('analytics.r6.radar.theory.summaryCaption')}</div>
      <ul className="space-y-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs" data-testid="theory-phone-rows">
        {rows.map(row => (
          <li key={row.key} className="flex items-baseline gap-2">
            <span className="w-20 shrink-0 font-semibold text-zinc-200">{t(`analytics.r6.radar.theory.${row.key}`)}</span>
            <b className={`tabular-nums ${row.rate === null ? 'font-normal text-zinc-500' : 'text-amber-300'}`}>{row.rate === null ? row.note : fmtTheoryPct(row.rate)}</b>
            <span className="min-w-0 text-[11px] text-zinc-500">{row.range}</span>
          </li>
        ))}
      </ul>
      <Advanced title={t('analytics.glance.board.fullTable')} testId="theory-advanced">{() => summaryTable}</Advanced>
    </div>
  );

  return (
    <div className="space-y-3">
      {lead && (
        <Takeaway>
          <p className="text-sm font-semibold text-white sm:text-[15px]" data-testid="theory-lead">{lead}</p>
        </Takeaway>
      )}
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      {wide ? summaryTable : phoneSummary}
      {rw ? (
        <StatTable
          caption={t('analytics.r6.radar.theory.rolesCaption')}
          columns={roleColumns}
          rows={roleRows}
          rowKey={row => row.role}
          footnote={t('analytics.r6.radar.theory.rolesNote')}
        />
      ) : (
        <div className="min-w-0">
          <div className="mb-1.5 text-sm font-bold text-zinc-400">{t('analytics.r6.radar.theory.rolesCaption')}</div>
          <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-6 text-center text-xs text-zinc-500">
            {t('analytics.r6.radar.theory.rolesPending')}
          </p>
        </div>
      )}
    </div>
    </div>
  );
}
