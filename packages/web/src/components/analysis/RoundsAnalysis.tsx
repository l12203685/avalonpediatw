import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatTable, type StatColumn } from './ui';
import type { RoundsAnalysisData } from '../../services/api';
import { useRoundsData } from './teams/useTeamsData';
import TeamsLoadState from './teams/TeamsLoadState';
import OutcomeBlocksTable, {
  BlockHeader, OutcomeBlocksNote, lacksOutcomes,
  type OutcomeGroupRow, type OutcomeGroupRowWithBlocks,
} from './teams/OutcomeBlocksTable';

/**
 * 回合分析 — 派隊分頁的「1-1 派票」與「任務進程」兩個小分頁 (同一份 /rounds 資料)
 *
 * Edward 2026-04-26 spec：1-1 隊伍組成、紅方人數、任務 1 分歧、常見局勢都要看到三種結果，
 * 才分得出低紅勝率是來自三藍活還是三藍死。
 *
 * (2026-10-14 Edward：派隊太散 → 依主題合併；能用表格數字就不用圖；結果比率用條件機率並附 n；一頁一屏)
 *   - section='firstVote' (1-1 派票)：「1-1 隊裡有誰」四張卡 + 「1-1 紅方人數」四條堆疊條 → 兩張同欄位的表
 *     (任務 1 成功率 + 三塊條件結果)，並排比較。
 *   - section='progression' (任務進程)：各任務成功率 (原本的堆疊長條圖 → 表，n = 打到那個任務的場數)、
 *     任務 1 成功／失敗之後 (原「任務 1 分歧」)、完整任務路徑 (原「常見局勢」：不再只挑 20 場以上且非全紅／全藍，
 *     快取存的路徑全列在可捲動的表裡，樣本少的變淡)。
 *   三塊的算法與舊快取 (沒有 outcomes) 的退路見 teams/OutcomeBlocksTable。
 */

export type RoundsSection = 'firstVote' | 'progression';

/** roundProgression 的鍵 (generate_cache.py round_labels)；不認得的鍵照原樣顯示。 */
const ROUND_KEYS = ['第一局', '第二局', '第三局', '第四局', '第五局'];

const FV = 'analytics.r6.teams.firstVote';
const PG = 'analytics.r6.teams.progression';

interface RoundRow {
  key: string;
  label: string;
  pass: number;
  fail: number;
  total: number;
}

interface FirstVoteRow extends OutcomeGroupRow {
  mission1PassRate: number | null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 路徑 (例「紅紅藍藍藍」) 畫成一排色塊：紅 = 任務失敗、藍 = 任務成功。 */
function PathChips({ path, label }: { path: string; label: string }): JSX.Element {
  return (
    <span role="img" className="inline-flex items-center gap-0.5" title={path} aria-label={label}>
      {Array.from(path).map((c, i) => (
        <span
          key={i}
          aria-hidden
          className={`inline-block h-3 w-3 rounded-[3px] ${
            c === '紅' ? 'bg-red-500' : c === '藍' ? 'bg-blue-500' : 'bg-zinc-600'
          }`}
        />
      ))}
    </span>
  );
}

function FirstVoteSection({ data, lowSample }: { data: RoundsAnalysisData; lowSample?: number }): JSX.Element {
  const { t } = useTranslation('common');

  const visionRows = useMemo<FirstVoteRow[]>(() => {
    const v = data.visionStats;
    const defs = [
      { key: 'merlinIn', entry: v?.merlinInTeam },
      { key: 'merlinOut', entry: v?.merlinNotInTeam },
      { key: 'percivalIn', entry: v?.percivalInTeam },
      { key: 'percivalOut', entry: v?.percivalNotInTeam },
    ];
    return defs.flatMap(({ key, entry }) => (entry
      ? [{
        key,
        label: t(`${FV}.${key}`),
        n: entry.games,
        outcomes: entry.outcomes ?? null,
        missionRedRate: finite(entry.redWinRate),
        mission1PassRate: finite(entry.mission1PassRate),
      }]
      : []));
  }, [data, t]);

  const redRows = useMemo<FirstVoteRow[]>(
    () => (data.redInR11 ?? []).map(r => ({
      key: String(r.redCount),
      label: t(`${FV}.redCountLabel`, { count: r.redCount }),
      n: r.games,
      outcomes: r.outcomes ?? null,
      missionRedRate: finite(r.redWinRate),
      mission1PassRate: finite(r.mission1PassRate),
    })),
    [data, t],
  );

  const m1Column: StatColumn<OutcomeGroupRowWithBlocks<FirstVoteRow>> = {
    key: 'm1',
    label: <BlockHeader name={t(`${FV}.m1Pass`)} sub={t(`${FV}.m1PassSub`)} />,
    title: t(`${FV}.m1PassHint`),
    align: 'center',
    format: 'pct',
    value: row => row.mission1PassRate,
    n: row => row.n,
    lowSample,
    tone: 'blue',
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400 leading-relaxed">{t(`${FV}.intro`)}</p>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <OutcomeBlocksTable
          caption={t(`${FV}.visionCaption`)}
          groupLabel={t(`${FV}.team`)}
          rows={visionRows}
          leadColumns={[m1Column]}
          lowSample={lowSample}
        />
        <OutcomeBlocksTable
          caption={t(`${FV}.redCountCaption`)}
          groupLabel={t(`${FV}.redCount`)}
          rows={redRows}
          leadColumns={[m1Column]}
          lowSample={lowSample}
        />
      </div>
      <OutcomeBlocksNote lowSample={lowSample} pending={lacksOutcomes(visionRows, redRows)} />
    </div>
  );
}

function ProgressionSection({ data, lowSample }: { data: RoundsAnalysisData; lowSample?: number }): JSX.Element {
  const { t } = useTranslation('common');

  const roundRows = useMemo<RoundRow[]>(
    () => Object.entries(data.roundProgression ?? {}).map(([key, v]) => {
      const idx = ROUND_KEYS.indexOf(key);
      return {
        key,
        label: idx >= 0 ? t(`${PG}.roundN`, { n: idx + 1 }) : key,
        pass: v.bluePct,
        fail: v.redPct,
        total: v.total,
      };
    }),
    [data, t],
  );

  const branchRows = useMemo<OutcomeGroupRow[]>(
    () => (data.mission1Branch ?? []).map(b => ({
      key: b.passed ? 'passed' : 'failed',
      label: t(b.passed ? `${PG}.branchPassed` : `${PG}.branchFailed`),
      tone: b.passed ? 'blue' : 'red',
      n: b.games,
      outcomes: b.outcomes ?? null,
      missionRedRate: finite(b.redWinRate),
    })),
    [data, t],
  );

  const pathRows = useMemo<(OutcomeGroupRow & { path: string })[]>(
    () => (data.gameStates ?? []).map(s => ({
      key: s.state,
      label: s.state,
      path: s.state,
      n: s.games,
      outcomes: s.outcomes ?? null,
      missionRedRate: finite(s.redWinRate),
      title: s.state,
    })),
    [data],
  );

  const roundColumns: StatColumn<RoundRow>[] = [
    { key: 'label', label: t(`${PG}.round`) },
    {
      key: 'pass', label: t(`${PG}.pass`), title: t(`${PG}.roundHint`),
      format: 'pct', tone: 'blue', n: 'total', lowSample, bar: { max: 100 }, emphasis: true,
    },
    { key: 'fail', label: t(`${PG}.fail`), title: t(`${PG}.roundHint`), format: 'pct', tone: 'red' },
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400 leading-relaxed">{t(`${PG}.intro`)}</p>
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-3">
          <StatTable
            caption={t(`${PG}.roundCaption`)}
            columns={roundColumns}
            rows={roundRows}
            rowKey={row => row.key}
          />
          <OutcomeBlocksTable
            caption={t(`${PG}.branchCaption`)}
            groupLabel={t(`${PG}.branchGroup`)}
            rows={branchRows}
            lowSample={lowSample}
          />
        </div>
        <OutcomeBlocksTable
          caption={t(`${PG}.pathCaption`)}
          groupLabel={t(`${PG}.path`)}
          rows={pathRows}
          renderLabel={row => <PathChips path={row.path} label={t(`${PG}.pathAria`, { path: row.path })} />}
          lowSample={lowSample}
          // 約與左欄 (各任務成功率 + 任務 1 之後) 同高，1280×800 一屏放得下；其餘路徑在表格自己的容器裡捲
          maxHeight={300}
        />
      </div>
      <OutcomeBlocksNote
        lowSample={lowSample}
        pending={lacksOutcomes(branchRows, pathRows)}
        extra={t(`${PG}.pathNote`, { count: pathRows.length })}
      />
    </div>
  );
}

export default function RoundsAnalysis({ section, lowSample }: { section: RoundsSection; lowSample?: number }): JSX.Element {
  const { data, loading, error, notGenerated } = useRoundsData();
  return (
    <TeamsLoadState loading={loading} error={error} notGenerated={notGenerated} empty={!data}>
      {() => (data
        ? section === 'firstVote'
          ? <FirstVoteSection data={data} lowSample={lowSample} />
          : <ProgressionSection data={data} lowSample={lowSample} />
        : null)}
    </TeamsLoadState>
  );
}
