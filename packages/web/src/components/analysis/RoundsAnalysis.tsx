import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Advanced, GlanceLegend, MeterBar, PathChips, RankRow, SplitBar, Takeaway, Term, VerdictText, type StatColumn,
} from './ui';
import { firstTeamGlance, pathsGlance, shareText, type Share } from './core/glance';
import { sampleText, sentenceText, winLegend, winSegments } from './core/glanceView';
import { outcomeChiSquare } from './outcomeTest';
import type { RoundsAnalysisData } from '../../services/api';
import { useRoundsData } from './teams/useTeamsData';
import TeamsLoadState from './teams/TeamsLoadState';
import { topPathShare } from './roundsPaths';
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
 *   - section='progression' (任務進程)：2026-11-17 起沒有地方用 (各任務成功率、任務 1 之後併進「任務結果 › 任務」，
 *     完整任務路徑變成 section='paths')；元件 2026-11-25 第三批刪掉。
 *   三塊的算法與舊快取 (沒有 outcomes) 的退路見 teams/OutcomeBlocksTable。
 * (2026-10-28 Edward：結果更直觀、名詞白話) 兩個小分頁最上面各一句話 (Takeaway)，數字都從資料當下算：
 *   1-1：有／沒有梅林、紅方 0–3 人時紅方最終勝率，加卡方檢定 (三種結局比例的差異明顯或可能只是運氣)；
 *   任務進程：任務 1 成功／失敗之後紅方最終勝率、最難成功的任務、最常見的路徑。表頭可點開看定義 (Term)。
 * (2026-11-25 站長：「希望能更直觀讓看到的人一目瞭然」，第二批) section='paths' (任務結果 › 任務路徑)：
 *   一句話 (最常見的走法佔幾成；藍方做完三個任務的走法裡哪一種藍方贏最多／最少) ＋ 兩欄排行長條：
 *   「藍方做完三個任務」每種走法一條藍方贏｜紅方贏、「三個任務失敗」每種走法一條佔全部局的比例；
 *   百分比整數、樣本寫「共 N 局」；三塊結果的表收進「進階」。算法沒有改 (core/glance.ts pathsGlance 只分組、排序)。
 */

export type RoundsSection = 'firstVote' | 'paths';

const FV = 'analytics.r6.teams.firstVote';
const PG = 'analytics.r6.teams.progression';

interface FirstVoteRow extends OutcomeGroupRow {
  mission1PassRate: number | null;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
    label: <BlockHeader name={t(`${FV}.m1Pass`)} sub={<Term term="missionSuccessRate">{t(`${FV}.m1PassSub`)}</Term>} />,
    title: t(`${FV}.m1PassHint`),
    align: 'center',
    format: 'pct',
    value: row => row.mission1PassRate,
    n: row => row.n,
    lowSample,
    tone: 'blue',
  };

  const merlinIn = visionRows.find(r => r.key === 'merlinIn');
  const merlinOut = visionRows.find(r => r.key === 'merlinOut');
  const merlinTest = merlinIn?.outcomes && merlinOut?.outcomes ? outcomeChiSquare([merlinIn.outcomes, merlinOut.outcomes]) : null;
  const redTest = redRows.every(r => r.outcomes) ? outcomeChiSquare(redRows.map(r => r.outcomes)) : null;
  const k7 = 'analytics.r7.firstVote';

  const g = 'analytics.glance.firstTeam';
  const glance = firstTeamGlance(data.visionStats, data.redInR11, lowSample ?? 0);
  const thin = (n: number): string | undefined => (lowSample !== undefined && n < lowSample ? t('analytics.glance.thin') : undefined);
  const winRow = (key: string, label: string, share: Share | null): JSX.Element | null => (share ? (
    <RankRow key={key} wide label={label} sample={sampleText(t, share.n)} thin={thin(share.n)}>
      <SplitBar segments={winSegments(t, share)} sample={sampleText(t, share.n)} />
    </RankRow>
  ) : null);
  const tables = (
    <div className="space-y-3">
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <OutcomeBlocksTable
          caption={t(`${FV}.visionCaption`)}
          groupLabel={t(`${FV}.team`)}
          rows={visionRows}
          leadColumns={[m1Column]}
          lowSample={lowSample}
          footnote={<><Term term="firstProposal">1-1</Term>{t(`${k7}.introRest`)}</>}
        />
        <OutcomeBlocksTable
          caption={t(`${FV}.redCountCaption`)}
          groupLabel={t(`${FV}.redCount`)}
          rows={redRows}
          leadColumns={[m1Column]}
          lowSample={lowSample}
          footnote={<><Term term="firstProposal">1-1</Term>{t(`${k7}.introRest`)}</>}
        />
      </div>
      <OutcomeBlocksNote pending={lacksOutcomes(visionRows, redRows)} />
    </div>
  );
  const hasBars = !!(glance.merlinIn || glance.percivalIn || glance.redCounts.length > 0);
  if (!hasBars) return tables;

  return (
    <div className="space-y-2">
      {(glance.merlinSentence || glance.redSentence) && (
        <Takeaway>
          {glance.merlinSentence && (
            <p>
              {sentenceText(t, glance.merlinSentence)}
              <VerdictText result={merlinTest} />
              {t(`${k7}.end`)}
            </p>
          )}
          {glance.redSentence && (
            <p>
              {sentenceText(t, glance.redSentence)}
              <VerdictText result={redTest} />
              {t(`${k7}.end`)}
            </p>
          )}
        </Takeaway>
      )}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="first-team-glance">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h4 className="text-xs font-semibold text-zinc-300"><Term term="firstProposal">{t(`${g}.title`)}</Term></h4>
          <GlanceLegend items={winLegend(t)} />
        </div>
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2" data-testid="first-team-who">
            <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.whoTitle`)}</h4>
            {winRow('merlinIn', t(`${FV}.merlinIn`), glance.merlinIn)}
            {winRow('merlinOut', t(`${FV}.merlinOut`), glance.merlinOut)}
            {winRow('percivalIn', t(`${FV}.percivalIn`), glance.percivalIn)}
            {winRow('percivalOut', t(`${FV}.percivalOut`), glance.percivalOut)}
          </div>
          {glance.redCounts.length > 0 && (
            <div className="min-w-0 space-y-2" data-testid="first-team-reds">
              <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.redsTitle`)}</h4>
              {glance.redCounts.map(r => winRow(String(r.count), t(`${g}.redCount`, { count: r.count }), r.share))}
            </div>
          )}
        </div>
      </section>
      <Advanced title={t(`${g}.advanced`)} testId="first-team-advanced">{() => tables}</Advanced>
    </div>
  );
}

/**
 * 完整任務路徑（2026-11-17 數據頁改版：舊「派隊 › 任務進程」的各任務成功率、任務 1 成功／失敗之後跟「任務結果 › 任務」
 * 重複，併掉；只剩這張表是別處沒有的，放到任務結果的一個小分頁）。
 */
function PathsSection({ data, lowSample }: { data: RoundsAnalysisData; lowSample?: number }): JSX.Element {
  const { t } = useTranslation('common');
  const min = lowSample ?? 0;
  const g = 'analytics.glance.paths';
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
  // 分母 = 全部有路徑的局（任務 1 分支），不是表上前 20 種路徑的加總（roundsPaths.ts）
  const topPath = topPathShare(data);
  const glance = useMemo(() => pathsGlance(data.gameStates, topPath?.total ?? 0, min), [data, topPath?.total, min]);
  const chips = (path: string): JSX.Element => <PathChips path={path} label={t(`${PG}.pathAria`, { path })} />;
  const thin = (n: number): string | undefined => (n < min ? t('analytics.glance.thin') : undefined);
  // 佔全部局的長條：最常見的那條當滿格，短的才看得出差別
  const maxShare = Math.max(1, ...glance.redPaths.map(p => p.ofAll));
  const fullTable = (
    <OutcomeBlocksTable
      caption={t(`${PG}.pathCaption`)}
      groupLabel={<Term term="missionPath">{t(`${PG}.path`)}</Term>}
      rows={pathRows}
      renderLabel={row => chips(row.path)}
      lowSample={lowSample}
      maxHeight={420}
      footnote={t(`${PG}.pathNote`, { count: pathRows.length })}
    />
  );
  if (!glance.top) {
    return (
      <div className="space-y-3">
        {fullTable}
        <OutcomeBlocksNote pending={lacksOutcomes(pathRows)} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Takeaway>
        <p>{sentenceText(t, glance.sentence)}</p>
        {glance.killSentence && <p>{sentenceText(t, glance.killSentence)}</p>}
      </Takeaway>
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="paths-glance">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="text-xs font-semibold text-zinc-300"><Term term="missionPath">{t(`${g}.legend`)}</Term></h3>
          <GlanceLegend items={[{ name: t(`${g}.passed`), tone: 'blue' }, { name: t(`${g}.failed`), tone: 'red' }]} />
        </div>
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
          {glance.bluePaths.length > 0 && (
            <div className="min-w-0 space-y-2" data-testid="paths-blue">
              <div>
                <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.blueTitle`)}</h4>
                <div className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-zinc-500">
                  <span>{t(`${g}.blueSub`)}</span>
                  <GlanceLegend items={winLegend(t)} />
                </div>
              </div>
              {glance.bluePaths.map(p => (
                <RankRow
                  key={p.path}
                  wide
                  label={chips(p.path)}
                  tag={p.path === glance.best ? t(`${g}.best`) : p.path === glance.worst ? t(`${g}.worst`) : undefined}
                  sample={`${t(`${g}.ofAll`, { share: shareText(p.ofAll) })} · ${sampleText(t, p.games)}`}
                  thin={thin(p.games)}
                >
                  {p.blue && <SplitBar segments={winSegments(t, p.blue)} sample={sampleText(t, p.games)} />}
                </RankRow>
              ))}
            </div>
          )}
          {glance.redPaths.length > 0 && (
            <div className="min-w-0 space-y-2" data-testid="paths-red">
              <div>
                <h4 className="text-xs font-bold text-zinc-100">{t(`${g}.redTitle`)}</h4>
                <p className="text-[11px] text-zinc-500">{t(`${g}.redSub`)}</p>
              </div>
              {glance.redPaths.map(p => (
                <RankRow
                  key={p.path}
                  wide
                  label={chips(p.path)}
                  tag={p.path === glance.top?.path ? t(`${g}.common`) : undefined}
                  sample={sampleText(t, p.games)}
                  thin={thin(p.games)}
                >
                  <MeterBar pct={p.ofAll} max={maxShare} text={shareText(p.ofAll)} tone="red" label={`${p.path} ${shareText(p.ofAll)}（${sampleText(t, p.games)}）`} />
                </RankRow>
              ))}
            </div>
          )}
        </div>
      </section>
      <Advanced title={t(`${g}.advanced`)} testId="paths-advanced">{() => fullTable}</Advanced>
      <OutcomeBlocksNote pending={lacksOutcomes(pathRows)} />
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
          : <PathsSection data={data} lowSample={lowSample} />
        : null)}
    </TeamsLoadState>
  );
}
