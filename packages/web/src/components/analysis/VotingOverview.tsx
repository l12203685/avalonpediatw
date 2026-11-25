import { useMemo } from 'react';
import { AlertCircle, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Advanced, GlanceLegend, GlanceRow, SplitBar, StatTable, Takeaway, Term, type StatColumn, type StatTermKey, type Tone } from './ui';
import { votersGlance, votesGlance, type VotesGlance } from './core/glance';
import { sampleText, sentenceText, voteLegend, voteSegments } from './core/glanceView';
import { useAnalysisPlayerRows, type PlayerWithSeatStats } from './seatRoleBlocks';

/**
 * 投票 › 投票概況 (Edward 2026-10-28：「投票…應該可以呈現更直觀的結果 一樣需要名詞解釋跟定義還有計算方法」)。
 *
 * 以前投票分頁只有 L136 (改隊後翻票) 一張研究卡。每位玩家的 players[].voting 早就有票數
 * (packages/shared/src/stats/voting.ts：每一局第 1–4 次提議的每一票，第 5 次強制出發不投票不算)，
 * 這裡把全部玩家的票加起來 (hits ÷ votes，每一票算一次)，回答兩個問題：
 *   看隊伍：隊伍裡有紅方時大家多常投反對、全是藍方時多常投贊成 (全部任務／第 3 個任務起)。
 *   看投票的人：第 3 個任務起，忠臣與紅方各多常投反對。
 * 一句話結論的數字都從資料當下算。同一位玩家的很多票彼此不獨立，所以不做卡方檢定、不附區間，只列票數。
 * 篩選時瀏覽器引擎重算 players 列，這裡跟著變。
 *
 * (2026-11-25 站長：「希望能更直觀讓看到的人一目瞭然」，第二批) 兩張表改成黑白球比例條（深灰＝反對、白＝贊成，跟總覽的卡片同一種畫法）：
 *   全部任務、第 3 個任務起各兩條（隊上有紅方／全是藍方），再加第 3 個任務起忠臣、紅方各一條；小字是票數。
 *   最上面的卡片已經講了全部任務的那一句，這裡的一句話講第 3 個任務起和投票的人；原本的表收進「進階」。
 *   比例是原本表上的同一個數字（全藍的隊原本列「贊成」，反對那一段用 100 減），算法沒有改。
 */

type VotingPath =
  | ['teamComposition', 'all' | 'r3Plus', 'evilTeamReject' | 'goodTeamApprove']
  | ['r3Reject', 'loyal' | 'red'];

interface VoteRow {
  key: string;
  label: string;
  group: 'team' | 'voter';
  term: StatTermKey;
  tone: Tone;
  hits: number;
  votes: number;
  rate: number | null;
}

const DEFS: ReadonlyArray<{ key: string; path: VotingPath; group: VoteRow['group']; term: StatTermKey; tone: Tone }> = [
  { key: 'evilAll', path: ['teamComposition', 'all', 'evilTeamReject'], group: 'team', term: 'evilTeamReject', tone: 'red' },
  { key: 'goodAll', path: ['teamComposition', 'all', 'goodTeamApprove'], group: 'team', term: 'goodTeamApprove', tone: 'blue' },
  { key: 'evilR3', path: ['teamComposition', 'r3Plus', 'evilTeamReject'], group: 'team', term: 'evilTeamReject', tone: 'red' },
  { key: 'goodR3', path: ['teamComposition', 'r3Plus', 'goodTeamApprove'], group: 'team', term: 'goodTeamApprove', tone: 'blue' },
  { key: 'loyalR3', path: ['r3Reject', 'loyal'], group: 'voter', term: 'r3Reject', tone: 'blue' },
  { key: 'redR3', path: ['r3Reject', 'red'], group: 'voter', term: 'r3Reject', tone: 'red' },
];

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function cellOf(p: PlayerWithSeatStats, path: VotingPath): { hits?: number; votes?: number } | undefined {
  const v = p.voting;
  if (!v) return undefined;
  if (path[0] === 'r3Reject') return v.r3Reject?.[path[1]];
  return v.teamComposition?.[path[1]]?.[path[2]];
}

/** 全部玩家的票加總；沒有任何 voting 欄位時 null (舊快取)。 */
export function poolVoting(players: readonly PlayerWithSeatStats[]): Record<string, { hits: number; votes: number; rate: number | null }> | null {
  if (!players.some(p => p.voting)) return null;
  const out: Record<string, { hits: number; votes: number; rate: number | null }> = {};
  for (const def of DEFS) {
    let hits = 0;
    let votes = 0;
    for (const p of players) {
      const c = cellOf(p, def.path);
      hits += num(c?.hits);
      votes += num(c?.votes);
    }
    out[def.key] = { hits, votes, rate: votes > 0 ? (hits / votes) * 100 : null };
  }
  return out;
}

export default function VotingOverview(): JSX.Element {
  const { t } = useTranslation('common');
  const { players, loading, error } = useAnalysisPlayerRows();
  const k = 'analytics.r7.votes';
  const pooled = useMemo(() => (players ? poolVoting(players) : null), [players]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
        <Loader size={14} className="animate-spin" /> {t('analytics.deep.loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-red-400">
        <AlertCircle size={14} /> {error}
      </div>
    );
  }
  if (!pooled) {
    return <p className="rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-6 text-center text-xs text-zinc-500">{t(`${k}.missing`)}</p>;
  }

  const rows: VoteRow[] = DEFS.map(def => ({
    key: def.key, label: t(`${k}.rows.${def.key}`), group: def.group, term: def.term, tone: def.tone, ...pooled[def.key],
  }));
  const columns = (group: VoteRow['group']): StatColumn<VoteRow>[] => [
    {
      key: 'label', label: t(`${k}.col.${group}`),
      format: (_v, row) => <Term term={row.term}>{row.label}</Term>,
    },
    {
      key: 'rate', label: t(`${k}.col.rate`), format: 'pct', emphasis: true,
      tone: row => row.tone, bar: { max: 100, placement: 'after' },
    },
    { key: 'votes', label: t(`${k}.col.votes`), format: 'int', className: 'text-zinc-400' },
  ];

  const g = 'analytics.glance';
  const all = votesGlance(pooled);
  const late = votesGlance(pooled, 'evilR3', 'goodR3', 'votesR3');
  const voters = votersGlance(pooled);
  const votes = (n: number): string => sampleText(t, n, 'votes');
  const teamRows = (label: string, gl: VotesGlance | null, testId: string): JSX.Element | null => (gl ? (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="text-xs font-bold text-zinc-100">{label}</div>
      <GlanceRow label={<Term term="evilTeamReject">{t(`${g}.votes.withRedRow`)}</Term>} sample={votes(gl.withRed.n)}>
        <SplitBar segments={voteSegments(t, gl.withRed, 'reject')} sample={votes(gl.withRed.n)} />
      </GlanceRow>
      <GlanceRow label={<Term term="goodTeamApprove">{t(`${g}.votes.allBlueRow`)}</Term>} sample={votes(gl.allBlueApprove.n)}>
        <SplitBar segments={voteSegments(t, gl.allBlueApprove, 'approve')} sample={votes(gl.allBlueApprove.n)} />
      </GlanceRow>
    </div>
  ) : null);
  const tables = (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      {(['team', 'voter'] as const).map(group => (
        <StatTable
          key={group}
          caption={t(`${k}.caption.${group}`)}
          columns={columns(group)}
          rows={rows.filter(x => x.group === group)}
          rowKey={x => x.key}
          footnote={t(`${k}.note`)}
        />
      ))}
    </div>
  );
  if (!all && !late && !voters) return tables;

  return (
    <div className="space-y-2">
      {(late || voters) && (
        <Takeaway>
          {late && <p>{sentenceText(t, late.sentence)}</p>}
          {voters && <p>{sentenceText(t, voters.sentence)}</p>}
        </Takeaway>
      )}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3" data-testid="votes-glance">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h4 className="text-xs font-semibold text-zinc-300">{t(`${g}.votesPage.title`)}</h4>
          <GlanceLegend items={voteLegend(t)} />
        </div>
        <div className="grid gap-x-8 gap-y-4 lg:grid-cols-3">
          {teamRows(t(`${g}.votesPage.allMissions`), all, 'votes-all')}
          {teamRows(t(`${g}.votesPage.fromThree`), late, 'votes-late')}
          {voters && (
            <div className="space-y-1.5" data-testid="votes-voters">
              <div className="text-xs font-bold text-zinc-100"><Term term="r3Reject">{t(`${g}.votesPage.voters`)}</Term></div>
              <GlanceRow label={t(`${g}.votesPage.loyal`)} sample={votes(voters.loyal.n)}>
                <SplitBar segments={voteSegments(t, voters.loyal, 'reject')} sample={votes(voters.loyal.n)} />
              </GlanceRow>
              <GlanceRow label={t(`${g}.votesPage.red`)} sample={votes(voters.red.n)}>
                <SplitBar segments={voteSegments(t, voters.red, 'reject')} sample={votes(voters.red.n)} />
              </GlanceRow>
            </div>
          )}
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">{t(`${g}.votesPage.note`)}</p>
      </section>
      <Advanced title={t(`${g}.votesPage.advanced`)} testId="votes-advanced">{() => tables}</Advanced>
    </div>
  );
}
