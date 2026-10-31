import { countStrongSeats } from '@avalon/shared/stats';
import { lineupTier } from '../../utils/lineupFilter';
import {
  RECORD_MISTAKE_TAGS,
  mistakeDetails,
  mistakeTags,
  postLineup,
  postRoleStrength,
  type RecordPost,
} from '../../utils/records';

/**
 * 牌譜紀錄的陣容強度與失誤標籤（Edward 2026-10-31）。
 * - LineupBadge：清單上的「S 67.5」（≥65 高強度、≥55 偏強各一種顏色）；讀得懂但沒評分的局顯示「未評分」。
 * - MistakeChips：可證明的失誤標籤；滑鼠提示是說明加每次發生的輪次與座位號（不寫名字）。
 * - LineupSummary：整局畫面的一行摘要（S、PR ≥ 70 的人數、玩家池人數）。
 */

const TIER_STYLE = {
  high: 'border-amber-400/70 bg-amber-400/20 text-amber-200',
  strong: 'border-amber-700/70 bg-amber-900/30 text-amber-100',
  normal: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
} as const;

export function LineupBadge({ post }: { post: RecordPost }): JSX.Element {
  const lineup = postLineup(post);
  if (!lineup) {
    return (
      <span className="rounded border border-zinc-700 px-1.5 py-px text-[11px] text-zinc-500" title="玩家池太小或名字對不到人，沒有陣容強度" data-testid="records-unscored">
        未評分
      </span>
    );
  }
  return (
    <span
      className={`rounded border px-1.5 py-px font-mono text-[11px] font-semibold ${TIER_STYLE[lineupTier(lineup.s)]}`}
      title={`陣容強度 S ${lineup.s.toFixed(1)}：開打前 10 人 PR 的平均（玩家池 ${lineup.pool} 人）；PR ≥ 70 有 ${countStrongSeats(lineup, 70)} 人`}
      data-testid="records-lineup-badge"
    >
      S {lineup.s.toFixed(1)}
    </span>
  );
}

export function MistakeChips({ post, size = 'sm' }: { post: RecordPost; size?: 'sm' | 'md' }): JSX.Element | null {
  const tags = mistakeTags(post);
  if (tags.length === 0) return null;
  const text = size === 'md' ? 'text-xs' : 'text-[11px]';
  return (
    <>
      {tags.map((tag) => {
        const info = RECORD_MISTAKE_TAGS.find((m) => m.tag === tag);
        const details = mistakeDetails(post, tag);
        return (
          <span
            key={tag}
            title={[info?.help, ...details].filter(Boolean).join('\n')}
            data-testid="records-mistake"
            className={`rounded border px-1.5 py-px ${text} ${
              info?.serious ? 'border-red-500/60 bg-red-500/15 text-red-200' : 'border-zinc-600 text-zinc-300'
            }`}
          >
            {tag}
          </span>
        );
      })}
    </>
  );
}

function fmtGroup(g: { mean: number; max: number; min: number } | null): string {
  return g ? `${Math.round(g.mean)}／${g.max}／${g.min}` : '—';
}

/**
 * 角色的 PR（Edward 2026-10-31「當局的紅方／忠臣各自的最高／最低 ELO & PR，以及派西／梅林的 ELO & PR」）：
 * 只在「顯示角色」打開時出現（關掉時哪個座位是什麼角色都不透露）。
 */
export function RoleStrengthLine({ post }: { post: RecordPost }): JSX.Element | null {
  const st = postRoleStrength(post);
  if (!st) return null;
  const one = (v: number | null): string => (v === null ? '—' : String(v));
  return (
    <div
      className="text-[11px] text-zinc-400"
      data-testid="records-role-strength"
      title="開打前 PR：紅方／忠臣是 平均／最高／最低；沒寫名字的座位所屬的那組不算"
    >
      <span className="text-red-300">紅方</span> {fmtGroup(st.pr.red)} · <span className="text-sky-300">忠臣</span> {fmtGroup(st.pr.loyal)}
      {' · '}<span className="text-blue-300">派西</span> {one(st.pr.percival)} · <span className="text-blue-300">梅林</span> {one(st.pr.merlin)}
    </div>
  );
}

export function LineupSummary({ post, showRoles = false }: { post: RecordPost; showRoles?: boolean }): JSX.Element {
  const lineup = postLineup(post);
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-zinc-400" data-testid="records-lineup-summary">
      <span title="開打前每個座位在「生涯已 ≥30 場」的玩家池裡的 PR（矩陣表頭座位號下方）；S = 10 人平均">陣容強度</span>
      <LineupBadge post={post} />
      {lineup && (
        <span>PR ≥ 70 有 {countStrongSeats(lineup, 70)} 人 · 玩家池 {lineup.pool} 人</span>
      )}
      <MistakeChips post={post} />
      {showRoles && <div className="basis-full"><RoleStrengthLine post={post} /></div>}
    </div>
  );
}
