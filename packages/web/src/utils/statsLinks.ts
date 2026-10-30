/**
 * Stats pages anyone can open without logging in (2026-10-13 players' report:
 * some thought the stats needed a login, one could not reach the leaderboard).
 *
 *  - PUBLIC_STATS_STATES: the gameStates App renders even when there is no
 *    session (guest mint / socket failed) and while the session is starting.
 *  - Deep links (the SPA has no router; the bots link these):
 *      #stats  (#analytics, #leaderboard, #rank) → 數據分析
 *      #player=<名字>                             → 數據分析 → 玩家雷達, that player
 *      #stats?f=1.<base64url>                     → 數據分析，套用分享的篩選 (stats/statsFilter.ts；
 *        hash 留在網址列，跟著篩選更新)；#stats?preset=online 等短碼 = 預設集 (機器人用)
 *      #study=<loopId> (例 #study=l141)            → 數據分析 + 那項特徵研究的完整研究
 *        (2026-10-14 Edward：「查看完整研究」大多點不開。這個 hash 在研究打開時留在網址列，
 *        可以複製分享；關閉時由 FeatureStudyReport 清掉，App 不會像 #stats 那樣先清掉它)
 */
import type { GameState } from '../store/gameStore';
import { parseStatsQuery } from '../stats/statsFilter';

export const PUBLIC_STATS_STATES: ReadonlySet<GameState> = new Set<GameState>([
  'analytics', 'analysis', 'leaderboard', 'wiki', 'help',
  // 'home' = 進站（沒有首頁了，直接開數據排行／百科攻略；Edward 2026-10-30）
  'home',
]);

export type StatsLink =
  | { kind: 'stats'; filter?: string; preset?: string }
  | { kind: 'player'; name: string }
  | { kind: 'study'; loopId: string };

const STATS_HASHES = new Set(['stats', 'analytics', 'leaderboard', 'rank']);

/** 特徵研究的 id：'l141' / 'L141' / '141' → 'L141'；不是研究 id 時 null。 */
export function normalizeStudyId(raw: string | null | undefined): string | null {
  const m = /^l?(\d{1,4})$/i.exec((raw ?? '').trim());
  return m ? `L${m[1]}` : null;
}

/** 完整研究的 hash (#study=l141)。 */
export function studyHash(loopId: string): string {
  return `#study=${(normalizeStudyId(loopId) ?? loopId).toLowerCase()}`;
}

/** #study=l141 → 'L141'；其他 hash → null。 */
export function parseStudyHash(hash: string | null | undefined): string | null {
  const m = /^study[=/](.+)$/i.exec((hash ?? '').replace(/^#/, '').trim());
  return m ? normalizeStudyId(m[1]) : null;
}

/** Parse a location.hash; null when it is not a stats link (e.g. #practice). */
export function parseStatsHash(hash: string | null | undefined): StatsLink | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (!raw) return null;
  const study = parseStudyHash(raw);
  if (study) return { kind: 'study', loopId: study };
  const m = /^player[=/](.+)$/i.exec(raw);
  if (m) {
    let name = m[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // a lone "%" — keep the text as typed
    }
    name = name.trim();
    return name ? { kind: 'player', name } : { kind: 'stats' };
  }
  const q = raw.indexOf('?');
  if (q >= 0 && STATS_HASHES.has(raw.slice(0, q).toLowerCase())) {
    const params = parseStatsQuery(raw.slice(q + 1));
    return { kind: 'stats', ...params };
  }
  return STATS_HASHES.has(raw.toLowerCase()) ? { kind: 'stats' } : null;
}
