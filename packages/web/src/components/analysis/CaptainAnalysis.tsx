import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatTable, Takeaway, formatRate, type StatColumn } from './ui';
import type { CaptainAnalysisData } from '../../services/api';
import { useCaptainData } from './teams/useTeamsData';
import TeamsLoadState from './teams/TeamsLoadState';
import OutcomeBlocksTable, {
  BlockHeader, OutcomeBlocksNote, lacksOutcomes,
  type OutcomeGroupRow, type OutcomeGroupRowWithBlocks,
} from './teams/OutcomeBlocksTable';

/**
 * 隊長分析 — 派隊分頁的「隊長」小分頁
 *
 * Edward 2026-04-26 spec：隊長陣營 × 任務結果的整局結果不再只給紅勝／藍勝兩個數字，要分出
 * 三藍是梅林活著還是被刺中。
 *
 * (2026-10-14 Edward：派隊「分析很好但太散」、能用表格數字就不用圖、結果比率用條件機率並附 n、一頁一屏)
 *   - 各任務隊長陣營：長條圖 + 表 → 只留表，比率背後的淡色長條就看得出紅方隊長越來越少。
 *   - 「隊長陣營 vs 任務結果」兩張卡 + 「× 任務結果 → 三種結果」四條堆疊條 → 合成一張表：
 *     每列一種 隊長陣營 × 任務結果，先是這個結果佔該陣營隊長任務的比例 (n = 該陣營隊長的任務數)，
 *     再接三塊條件結果 (任務結果、到三藍時的刺殺結果、遊戲結果，各附 n；見 teams/OutcomeBlocksTable)。
 *   這裡的單位是「任務」：一局有好幾個任務，每個任務各算一次 (n = 任務數)。
 * (2026-10-28 Edward：結果要更直觀、名詞要白話) 最上面一句話：紅方／藍方隊長的任務各失敗幾成、紅方當隊長的
 *   比例從任務 1 到最後一個任務怎麼變 (數字都從表上的資料當下算)；表頭可點開看定義 (Term)。
 *   以任務為單位，同一局會算好幾次，所以這裡不做卡方檢定。
 */

type Faction = '紅方' | '藍方';

interface PerMissionRow {
  key: string;
  label: string;
  red: number;
  blue: number;
  games: number;
}

interface CaptainRow extends OutcomeGroupRow {
  faction: Faction;
  passed: boolean;
  /** 這個結果佔該陣營隊長任務的比例 (0–100)。 */
  share: number | null;
  /** 該陣營隊長的任務數 (share 的分母)。 */
  factionTotal: number;
}

const FACTIONS: readonly Faction[] = ['紅方', '藍方'];
const RESULTS: readonly ('pass' | 'fail')[] = ['pass', 'fail'];

function buildCaptainRows(data: CaptainAnalysisData): CaptainRow[] {
  const rows: CaptainRow[] = [];
  for (const faction of FACTIONS) {
    const vsRows = data.captainFactionVsOutcome.filter(r => r.captainFaction === faction);
    const factionTotal = vsRows.reduce((sum, r) => sum + (Number.isFinite(r.count) ? r.count : 0), 0);
    for (const result of RESULTS) {
      const vs = vsRows.find(r => r.missionResult === result);
      const wr = data.captainMissionGameWinRates.find(r => r.captainFaction === faction && r.missionResult === result);
      if (!vs && !wr) continue;
      rows.push({
        key: `${faction}-${result}`,
        label: `${faction}-${result}`,
        faction,
        passed: result === 'pass',
        n: wr?.totalMissions ?? vs?.count ?? 0,
        outcomes: wr?.outcomes ?? null,
        // captainMissionGameWinRates.redGameWinRate 是任務結算口徑 (= 三紅率)；只在沒有 outcomes 時用。
        missionRedRate: wr?.redGameWinRate ?? null,
        share: typeof vs?.percentage === 'number' ? vs.percentage : null,
        factionTotal,
      });
    }
  }
  return rows;
}

export default function CaptainAnalysis({ lowSample }: { lowSample?: number }): JSX.Element {
  const { t } = useTranslation('common');
  const { data, loading, error, notGenerated } = useCaptainData();

  const perMissionRows = useMemo<PerMissionRow[]>(
    () => (data?.perMission ?? []).map(m => ({
      key: String(m.mission),
      label: t('analytics.r6.teams.captain.missionN', { n: m.mission }),
      red: m.redCaptainRate,
      blue: m.blueCaptainRate,
      games: m.games,
    })),
    [data, t],
  );
  const captainRows = useMemo(() => (data ? buildCaptainRows(data) : []), [data]);

  const perMissionColumns: StatColumn<PerMissionRow>[] = [
    { key: 'label', label: t('analytics.r6.teams.captain.mission') },
    {
      key: 'red', label: t('analytics.r6.teams.captain.redCaptain'), term: 'captainFaction',
      format: 'pct', tone: 'red', bar: { max: 100 }, emphasis: true,
    },
    { key: 'blue', label: t('analytics.r6.teams.captain.blueCaptain'), format: 'pct', tone: 'blue' },
    { key: 'games', label: t('analytics.r6.teams.captain.games'), format: 'int' },
  ];

  const shareColumn: StatColumn<OutcomeGroupRowWithBlocks<CaptainRow>> = {
    key: 'share',
    label: <BlockHeader name={t('analytics.r6.teams.captain.share')} sub={t('analytics.r6.teams.captain.shareSub')} />,
    title: t('analytics.r6.teams.captain.shareHint'),
    align: 'center',
    format: 'pct',
    value: row => row.share,
    n: row => row.factionTotal,
    lowSample,
    tone: row => (row.passed ? 'blue' : 'red'),
  };

  const renderLabel = (row: CaptainRow): JSX.Element => (
    <span className="inline-flex items-baseline gap-1">
      <span className={row.faction === '紅方' ? 'text-red-300' : 'text-blue-300'}>
        {t(row.faction === '紅方' ? 'analytics.r6.teams.captain.redShort' : 'analytics.r6.teams.captain.blueShort')}
      </span>
      <span className="text-zinc-600">·</span>
      <span className={row.passed ? 'text-blue-300' : 'text-red-300'}>
        {t(row.passed ? 'analytics.r6.teams.captain.pass' : 'analytics.r6.teams.captain.fail')}
      </span>
    </span>
  );

  const failShare = (faction: Faction): CaptainRow | undefined => captainRows.find(r => r.faction === faction && !r.passed);
  const redFail = failShare('紅方');
  const blueFail = failShare('藍方');
  const firstMission = perMissionRows[0];
  const lastMission = perMissionRows[perMissionRows.length - 1];

  return (
    <TeamsLoadState
      loading={loading}
      error={error}
      notGenerated={notGenerated}
      empty={!data || data.perMission.length === 0}
    >
      {() => (
        <div className="space-y-3">
          {redFail && blueFail && firstMission && lastMission && (
            <Takeaway>
              <p>
                {t('analytics.r7.captain.takeaway', {
                  red: formatRate(redFail.share), redN: redFail.factionTotal,
                  blue: formatRate(blueFail.share), blueN: blueFail.factionTotal,
                })}
                {perMissionRows.length > 1 && t('analytics.r7.captain.trend', {
                  first: formatRate(firstMission.red), last: formatRate(lastMission.red), lastMission: lastMission.key,
                })}
              </p>
            </Takeaway>
          )}
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <StatTable
              caption={t('analytics.r6.teams.captain.perMissionCaption')}
              columns={perMissionColumns}
              rows={perMissionRows}
              rowKey={row => row.key}
              footnote={t('analytics.r6.teams.captain.intro', { count: perMissionRows[0]?.games ?? 0 })}
            />
            <OutcomeBlocksTable
              caption={t('analytics.r6.teams.captain.resultCaption')}
              groupLabel={t('analytics.r6.teams.captain.group')}
              rows={captainRows}
              renderLabel={renderLabel}
              leadColumns={[shareColumn]}
              lowSample={lowSample}
              footnote={t('analytics.r6.teams.captain.nNote')}
            />
          </div>
          <OutcomeBlocksNote pending={lacksOutcomes(captainRows)} />
        </div>
      )}
    </TeamsLoadState>
  );
}
