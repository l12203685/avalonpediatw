/**
 * Stats replies — pure text formatting shared by the Discord and LINE bots.
 *
 * Owner decision 2026-10-10: games are played on signage-cloud, results keep
 * being recorded in the owner's Google Sheet (→ analysis_cache.json), and the
 * community looks stats up from Discord / the LINE group. This module turns
 * cache data into short Traditional Chinese plain-text replies (no markdown,
 * because LINE does not render it). Nothing here touches the file system,
 * the clock or the network; data comes in as arguments (see statsQueries.ts).
 *
 * Length budget: every reply is clamped to STATS_REPLY_MAX_CHARS (1800),
 * well under Discord's 2000 and LINE's 5000 characters per message.
 */

import type {
  ArchetypeAxes,
  ArchetypePlayerData,
  ChemistryData,
  ChemistryMatrix,
  LeaderboardBoard,
  LeaderboardSection,
  OverviewData,
  PlayerStats,
  PlaystyleData,
  PlaystylePlayerData,
  StrengthPlayerData,
} from '../../services/sheetsAnalysis';
import { rnd1 } from '../../services/sheetsAnalysis';

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * Public web app. The SPA has no URL router (pages are switched by in-memory
 * `gameState`), so there is no per-player stats URL to deep-link — replies
 * link the site and name the page (首頁 →「數據分析」) instead.
 */
export const STATS_SITE_URL = 'https://avalon-game-platform.web.app';

/** Hard cap per reply — Discord allows 2000, LINE 5000 characters. */
export const STATS_REPLY_MAX_CHARS = 1800;

export const LEADERBOARD_SIZE = 10;

/**
 * Only used when the cache has no `leaderboard` section (pre-contract cache):
 * the all-time ranking is rebuilt from the player list with the generator's
 * MIN_GAMES_THRESHOLD (30) — by excess win rate when the players carry it,
 * else by the legacy roleTheory.
 */
export const LEADERBOARD_FALLBACK_MIN_GAMES = 30;

/**
 * generate_cache.py LEADERBOARD_CONFIG.shrinkK: every excess ranking is ordered
 * by excess × games / (games + K) so a short hot streak does not top the board.
 * The cache boards and topPlayersByExcess come pre-sorted; only the all-time
 * fallback built from the player list sorts here (the section's config.shrinkK
 * wins when the cache carries one).
 */
export const LEADERBOARD_SHRINK_K = 20;

/** Rows of the "近 90 天" board appended to the Monday digest. */
export const DIGEST_RECENT_SIZE = 5;

/** Max candidates listed when a name matches several players. */
export const MAX_NAME_CANDIDATES = 5;

/** User input echoed back is cut to this many characters. */
const QUERY_ECHO_MAX = 20;

export type StatsPlatform = 'line' | 'discord';

/** Command syntax as typed — identical on LINE and Discord (CJK slash commands). */
export const STATS_COMMAND_USAGE = {
  player: '/戰績 名字',
  leaderboard: '/排行',
  chemistry: '/默契 名字1 名字2',
  /** Handled by bots/feedback (owner inbox); listed here so every help text advertises it. */
  feedback: '/意見 文字',
} as const;

const SITE_FOOTER = `🔗 完整圖表：${STATS_SITE_URL}（首頁 →「數據分析」）`;

// ─── Small helpers ───────────────────────────────────────────────────────

/** One decimal place, e.g. 59 → "59.0%". Non-finite → "—". */
export function pct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function num(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

/** Signed one-decimal delta: 6.3 → "+6.3", -2.05 → "-2.1", 0 → "0.0". Non-finite / null → "—". */
export function signed(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const r = Math.round(value * 10) / 10;
  if (r === 0) return '0.0';
  return r > 0 ? `+${r.toFixed(1)}` : r.toFixed(1);
}

/** Trim, collapse whitespace and cap user input before echoing it back. */
export function echoQuery(raw: string): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s.length > QUERY_ECHO_MAX ? `${s.slice(0, QUERY_ECHO_MAX)}…` : s;
}

/**
 * Cap a reply at `max` characters. Cuts at the last line break that fits so
 * a line is never chopped mid-way, then appends "…".
 */
export function clampReply(text: string, max: number = STATS_REPLY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 2);
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > room / 2 ? cut.slice(0, lastBreak) : cut;
  return `${body}\n…`;
}

// ─── Name matching ───────────────────────────────────────────────────────

/** NFKC folds full-width letters (ＨＡＯ → HAO); then case-fold. */
export function normalizeName(s: string): string {
  return (s ?? '').normalize('NFKC').trim().toLowerCase();
}

export type NameMatch =
  | {
      kind: 'found';
      name: string;
      /** Other names that differ only by case (the sheet has e.g. Sin / SIN / sin). */
      caseVariants: string[];
    }
  | { kind: 'ambiguous'; query: string; candidates: string[]; total: number }
  | { kind: 'none'; query: string };

/**
 * Resolve a typed name against `names` (given in priority order — e.g. most
 * games first; candidate lists keep that order).
 *
 *   1. exact match
 *   2. case-insensitive (NFKC) match — one hit wins, several are ambiguous
 *   3. substring match — one hit wins, several are ambiguous
 *   4. otherwise none
 */
export function matchPlayerName(query: string, names: readonly string[]): NameMatch {
  const q = (query ?? '').trim();
  if (!q) return { kind: 'none', query: '' };
  const nq = normalizeName(q);

  const sameCase = (name: string): string[] =>
    names.filter((n) => n !== name && normalizeName(n) === normalizeName(name));

  if (names.includes(q)) {
    return { kind: 'found', name: q, caseVariants: sameCase(q) };
  }

  const ci = names.filter((n) => normalizeName(n) === nq);
  if (ci.length === 1) return { kind: 'found', name: ci[0], caseVariants: [] };
  if (ci.length > 1) {
    return { kind: 'ambiguous', query: q, candidates: ci.slice(0, MAX_NAME_CANDIDATES), total: ci.length };
  }

  const sub = names.filter((n) => normalizeName(n).includes(nq));
  if (sub.length === 1) return { kind: 'found', name: sub[0], caseVariants: [] };
  if (sub.length > 1) {
    return { kind: 'ambiguous', query: q, candidates: sub.slice(0, MAX_NAME_CANDIDATES), total: sub.length };
  }
  return { kind: 'none', query: q };
}

/** Reply for an ambiguous / unknown name. */
export function formatNameProblem(
  match: Exclude<NameMatch, { kind: 'found' }>,
  opts: { usage?: string; scopeNote?: string } = {},
): string {
  const usage = opts.usage ?? STATS_COMMAND_USAGE.player;
  if (match.kind === 'ambiguous') {
    const more = match.total > match.candidates.length ? ` 等 ${match.total} 位` : '';
    return clampReply(
      [
        `🔎 「${echoQuery(match.query)}」符合 ${match.total} 位玩家，請打完整名字：`,
        `${match.candidates.join('、')}${more}`,
      ].join('\n'),
    );
  }
  const lines = [
    match.query
      ? `❓ 找不到玩家「${echoQuery(match.query)}」。`
      : '❓ 請輸入玩家名字。',
  ];
  if (opts.scopeNote) lines.push(opts.scopeNote);
  lines.push(`可用「${usage}」查詢（名字打一部分也可以）。`);
  return clampReply(lines.join('\n'));
}

// ─── Player card ─────────────────────────────────────────────────────────

export interface PlayerCardInput {
  player: PlayerStats;
  /** `axisLabels` is the cache's label map (string values, e.g. honesty → 誠實度). */
  archetype?: { data: ArchetypePlayerData; axisLabels?: Record<string, unknown> | null } | null;
  strength?: StrengthPlayerData | null;
  playstyle?: { data: PlaystylePlayerData; labels: PlaystyleData['labels'] } | null;
  /** Names that differ only by case, shown as a hint. */
  caseVariants?: string[];
}

const ARCHETYPE_AXES: Array<keyof ArchetypeAxes> = ['honesty', 'consistency', 'stickiness', 'flip'];
const ARCHETYPE_FALLBACK_LABELS: Record<keyof ArchetypeAxes, string> = {
  honesty: '誠實度',
  consistency: '一致度',
  stickiness: '專精度',
  flip: '浮動度',
};

function strengthLine(strength: StrengthPlayerData | null | undefined): string | null {
  if (!strength?.hasData || !Array.isArray(strength.roles)) return null;
  const describe = (role: string): string => {
    const entry = strength.roles.find((r) => r.role === role);
    if (!entry || entry.winRate === null) return role;
    return `${role} ${pct(entry.winRate)}（${entry.sampleSize} 場）`;
  };
  const top = (strength.topRoles ?? []).map(describe);
  if (top.length === 0) return null;
  const bottom = (strength.bottomRoles ?? []).map(describe);
  return `💪 擅長角色：${top.join('、')}${bottom.length ? `；較弱：${bottom.join('、')}` : ''}`;
}

function archetypeLine(arch: PlayerCardInput['archetype']): string | null {
  if (!arch?.data?.hasData) return null;
  const { axes, percentiles } = arch.data;
  const parts = ARCHETYPE_AXES.filter((k) => typeof axes?.[k] === 'number').map((k) => {
    const given = arch.axisLabels?.[k];
    const label = typeof given === 'string' && given ? given : ARCHETYPE_FALLBACK_LABELS[k];
    const pr = percentiles?.[k];
    return `${label} ${num(axes[k])}${typeof pr === 'number' ? `（PR${Math.round(pr)}）` : ''}`;
  });
  if (parts.length === 0) return null;
  return `🧭 風格：${parts.join('、')}`;
}

function playstyleLine(ps: PlayerCardInput['playstyle']): string | null {
  if (!ps?.data?.hasData) return null;
  const { data, labels } = ps;
  const parts: string[] = [];
  if (data.r3RejectRate?.red !== null && data.r3RejectRate?.red !== undefined) {
    parts.push(`${labels?.r3RejectRedLabel || '紅角 R3+ 強硬度'} ${pct(data.r3RejectRate.red)}`);
  }
  if (data.r3RejectRate?.blue !== null && data.r3RejectRate?.blue !== undefined) {
    parts.push(`${labels?.r3RejectBlueLabel || '藍角 R3+ 強硬度'} ${pct(data.r3RejectRate.blue)}`);
  }
  if (Array.isArray(data.assassinTopSeats) && data.assassinTopSeats.length > 0) {
    parts.push(`${labels?.assassinTargetLabel || '刺客目標座位偏好'} ${data.assassinTopSeats.join('、')} 號`);
  }
  if (typeof data.captainStickiness === 'number') {
    parts.push(`${labels?.captainStickinessLabel || '隊長 stickiness'} ${pct(data.captainStickiness)}`);
  }
  if (parts.length === 0) return null;
  return `🎯 對戰風格：${parts.join('、')}`;
}

/** 紅方三藍局刺中率 (%): raw counts when the cache has them, else from the per-side percentages. null = never reached 三藍 as red. */
function redKillRate(p: PlayerStats): number | null {
  if (typeof p.rawRedMerlinDead === 'number' && typeof p.rawRedMerlinAlive === 'number') {
    const reached = p.rawRedMerlinDead + p.rawRedMerlinAlive;
    return reached > 0 ? (p.rawRedMerlinDead / reached) * 100 : null;
  }
  if (typeof p.redMerlinDead === 'number' && typeof p.redMerlinAlive === 'number') {
    const reached = p.redMerlinDead + p.redMerlinAlive;
    return reached > 0 ? (p.redMerlinDead / reached) * 100 : null;
  }
  return null;
}

/** 藍方三藍局存活率 (%): the contract's merlinSurvivalRate, else from the per-side percentages. null = never reached 三藍 as blue. */
function blueSurvivalRate(p: PlayerStats): number | null {
  if (typeof p.merlinSurvivalRate === 'number' && p.rawBlueThreeBlue !== 0) return p.merlinSurvivalRate;
  if (typeof p.blueMerlinDead === 'number' && typeof p.blueMerlinAlive === 'number') {
    const reached = p.blueMerlinDead + p.blueMerlinAlive;
    return reached > 0 ? (p.blueMerlinAlive / reached) * 100 : null;
  }
  return null;
}

/**
 * Player card. Win rates follow docs/stats/two_stage_outcome.md: the headline
 * is the FINAL win rate (藍勝 = 三藍且梅林活) with the excess over the
 * role-expected rate ("—" when the cache cannot provide it); the second line
 * walks 任務結算 → 刺殺結算 → 最終; the third gives the per-side final rates.
 * `missionWinRate` falls back to the legacy `winRate`, which has the same
 * 任務結算 meaning. The old "角色理論勝率" is no longer shown.
 */
export function formatPlayerCard(input: PlayerCardInput): string {
  const p = input.player;
  const lines: string[] = [
    `📊 ${p.name} 的戰績`,
    `場次 ${p.totalGames}｜最終勝率 ${pct(p.finalWinRate)}｜超額 ${signed(p.excessWinRate)}`,
  ];
  const kill = redKillRate(p);
  const survive = blueSurvivalRate(p);
  const stageParts = [
    kill === null ? null : `紅方刺中 ${pct(kill)}`,
    survive === null ? null : `藍方存活 ${pct(survive)}`,
  ].filter((s): s is string => s !== null);
  const stage = stageParts.length > 0 ? `刺殺結算（三藍局：${stageParts.join('／')}）→` : '刺殺結算 →';
  lines.push(`任務結算 ${pct(p.missionWinRate ?? p.winRate)} → ${stage} 最終 ${pct(p.finalWinRate)}`);
  const redGames = typeof p.rawRedGames === 'number' ? `（${p.rawRedGames} 場）` : '';
  const blueGames = typeof p.rawBlueGames === 'number' ? `（${p.rawBlueGames} 場）` : '';
  lines.push(`🔴 紅方最終勝率 ${pct(p.finalRedWinRate)}${redGames}｜🔵 藍方最終勝率 ${pct(p.finalBlueWinRate)}${blueGames}`);

  for (const extra of [strengthLine(input.strength), archetypeLine(input.archetype), playstyleLine(input.playstyle)]) {
    if (extra) lines.push(extra);
  }
  if (input.caseVariants && input.caseVariants.length > 0) {
    lines.push(`ℹ️ 另有大小寫不同的玩家：${input.caseVariants.slice(0, MAX_NAME_CANDIDATES).join('、')}`);
  }
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────
//
// Owner decision 2026-10-12 (docs/stats/two_stage_outcome.md, HAO's feedback
// on the old digest): rank by EXCESS win rate (final win rate minus the
// role-expected rate), one number per row plus the final win rate and the
// games in the period, with the period in the title. Boards come precomputed
// from the cache's `leaderboard` section; older caches fall back to an
// all-time ranking built here.

/** One printed ranking row. `kind` on the view says what `value` / `winRate` mean. */
export interface LeaderboardLine {
  rank: number;
  name: string;
  /** excess: 超額勝率 (unshrunk, percentage points, signed); theory: 角色理論勝率 (%). */
  value: number;
  /** excess: 最終勝率; theory: legacy 任務結算 win rate. null when unknown. */
  winRate: number | null;
  games: number;
}

export interface LeaderboardView {
  kind: 'excess' | 'theory';
  /** First line of the board, e.g. "🏆 超額勝率排行 Top 10（2025-10-13 ～ 2026-10-12，近 90 天內有出賽、期間至少 20 場）". */
  title: string;
  rows: LeaderboardLine[];
}

/** The board with that id, or null when it is absent or has no rows (the generator omits boards it cannot build). */
export function findBoard(
  leaderboard: Pick<LeaderboardSection, 'boards'> | null | undefined,
  id: string,
): LeaderboardBoard | null {
  const board = leaderboard?.boards?.find((b) => b.id === id);
  return board && Array.isArray(board.rows) && board.rows.length > 0 ? board : null;
}

/**
 * The note's first clause only: the generator appends the excess legend
 * (超額勝率 = …；排序用縮減值 …) after a "；", which is for the site's
 * caption, not for a title in brackets.
 */
function noteQualifier(note: unknown): string {
  return typeof note === 'string' ? note.split('；')[0].trim() : '';
}

function boardTitle(board: LeaderboardBoard, size: number, emoji: string): string {
  const qualifier = [board.period, noteQualifier(board.note)].filter((s): s is string => typeof s === 'string' && s.length > 0).join('，');
  return `${emoji} ${board.title} Top ${size}${qualifier ? `（${qualifier}）` : ''}`;
}

/** generate_cache.py shrunk_excess: excess × games / (games + K), one decimal (ties to even, like the generator). */
export function shrunkExcess(excess: number, games: number, k: number = LEADERBOARD_SHRINK_K): number {
  return games + k > 0 ? rnd1((excess * games) / (games + k)) : 0;
}

/** A cache board (main / online / recent …) as a printable view, top `size` rows. */
export function boardView(board: LeaderboardBoard, size: number = LEADERBOARD_SIZE, emoji = '🏆'): LeaderboardView {
  return {
    kind: 'excess',
    title: boardTitle(board, size, emoji),
    rows: board.rows.slice(0, size).map((r, i) => ({
      rank: typeof r.rank === 'number' ? r.rank : i + 1,
      name: r.name,
      // The rows are sorted by the shrunk `value`; the number people compare
      // with /戰績 and the site is the unshrunk `excessWinRate` (contract).
      value: typeof r.excessWinRate === 'number' ? r.excessWinRate : r.value,
      winRate: typeof r.finalWinRate === 'number' ? r.finalWinRate : null,
      games: r.games,
    })),
  };
}

/**
 * The ranking /排行 and the Monday digest lead with, in order of preference:
 *   1. the cache's `leaderboard` main board (windowed, active players only);
 *   2. `overview.topPlayersByExcess`, else the player list among players with
 *      ≥ LEADERBOARD_FALLBACK_MIN_GAMES games, ordered like the generator
 *      (shrunk excess, then games, then name) and showing the plain excess —
 *      titled "全期";
 *   3. the pre-contract roleTheory ranking (`overview.topPlayersByTheory`,
 *      then the player list) when the cache has no excess fields at all.
 */
export function selectLeaderboard(
  leaderboard: (Pick<LeaderboardSection, 'boards'> & Partial<Pick<LeaderboardSection, 'config'>>) | null | undefined,
  overview: Pick<OverviewData, 'topPlayersByTheory' | 'topPlayersByExcess'> | null | undefined,
  players: readonly PlayerStats[] = [],
  size: number = LEADERBOARD_SIZE,
): LeaderboardView {
  const main = findBoard(leaderboard, 'main');
  if (main) return boardView(main, size, '🏆');

  const allTimeTitle = `🏆 超額勝率排行 Top ${size}（全期，至少 ${LEADERBOARD_FALLBACK_MIN_GAMES} 場）`;
  const byExcess = overview?.topPlayersByExcess;
  if (Array.isArray(byExcess) && byExcess.length > 0) {
    return {
      kind: 'excess',
      title: allTimeTitle,
      rows: byExcess
        .slice(0, size)
        .map((r, i) => ({ rank: i + 1, name: r.name, value: r.excessWinRate, winRate: r.finalWinRate, games: r.games })),
    };
  }
  const withExcess = players
    .map((p) => ({ p, excess: p.excessWinRate }))
    .filter((x): x is { p: PlayerStats; excess: number } => typeof x.excess === 'number' && x.p.totalGames >= LEADERBOARD_FALLBACK_MIN_GAMES);
  if (withExcess.length > 0) {
    const k = typeof leaderboard?.config?.shrinkK === 'number' ? leaderboard.config.shrinkK : LEADERBOARD_SHRINK_K;
    return {
      kind: 'excess',
      title: allTimeTitle,
      rows: withExcess
        .map((x) => ({ ...x, shrunk: shrunkExcess(x.excess, x.p.totalGames, k) }))
        .sort((a, b) => b.shrunk - a.shrunk || b.p.totalGames - a.p.totalGames || (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0))
        .slice(0, size)
        .map((x, i) => ({ rank: i + 1, name: x.p.name, value: x.excess, winRate: x.p.finalWinRate ?? null, games: x.p.totalGames })),
    };
  }

  const theoryTitle = `🏆 理論勝率排行 Top ${size}`;
  const top = overview?.topPlayersByTheory;
  if (Array.isArray(top) && top.length > 0) {
    return {
      kind: 'theory',
      title: theoryTitle,
      rows: top.slice(0, size).map((r, i) => ({ rank: i + 1, name: r.name, value: r.roleTheory, winRate: r.winRate, games: r.games })),
    };
  }
  return {
    kind: 'theory',
    title: theoryTitle,
    rows: players
      .filter((p) => p.totalGames >= LEADERBOARD_FALLBACK_MIN_GAMES)
      .slice()
      .sort((a, b) => b.roleTheory - a.roleTheory || b.totalGames - a.totalGames)
      .slice(0, size)
      .map((p, i) => ({ rank: i + 1, name: p.name, value: p.roleTheory, winRate: p.winRate, games: p.totalGames })),
  };
}

const MEDALS = ['🥇', '🥈', '🥉'];

function rankLabel(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

/** Title line + one line per row ("（目前沒有排行資料）" when empty). */
export function leaderboardLines(view: LeaderboardView): string[] {
  const lines = [view.title];
  if (view.rows.length === 0) lines.push('（目前沒有排行資料）');
  for (const r of view.rows) {
    lines.push(
      view.kind === 'excess'
        ? `${rankLabel(r.rank)} ${r.name}\u3000超額 ${signed(r.value)}｜最終 ${pct(r.winRate)}｜${r.games} 場`
        : `${rankLabel(r.rank)} ${r.name}\u3000${pct(r.value)}（勝率 ${pct(r.winRate)}・${r.games} 場）`,
    );
  }
  return lines;
}

/** "🎖️ 上月角色稱號（2026-09）：刺客 HAO（70.0%・8 場）、…" from the `roleTitles` board, or null when absent. */
export function roleTitlesLine(board: LeaderboardBoard | null | undefined): string | null {
  if (!board || !Array.isArray(board.rows) || board.rows.length === 0) return null;
  const parts = board.rows.map((r) => `${r.role ? `${r.role} ` : ''}${r.name}（${pct(r.value)}・${r.games} 場）`);
  const period = board.period ? `（${board.period}）` : '';
  return `🎖️ ${board.title}${period}：${parts.join('、')}`;
}

/** The overview fields the totals line reads; the two-stage sections are optional (older caches). */
export type OverviewTotals = Pick<OverviewData, 'totalGames' | 'totalPlayers' | 'redWinRate' | 'blueWinRate' | 'merlinKillRate' | 'outcomeBreakdown'> &
  Partial<Pick<OverviewData, 'missionStage' | 'assassinationStage' | 'final'>>;

/** Final red / blue share: the contract's `final` section, else derived from the three-outcome counts. */
function finalShares(o: OverviewTotals): { red: number | null; blue: number | null } {
  if (o.final && typeof o.final.redPct === 'number' && typeof o.final.bluePct === 'number') {
    return { red: o.final.redPct, blue: o.final.bluePct };
  }
  const b = o.outcomeBreakdown;
  if (!b) return { red: null, blue: null };
  const threeRed = b.threeRed ?? 0;
  const dead = b.threeBlueDead ?? 0;
  const alive = b.threeBlueAlive ?? 0;
  const total = threeRed + dead + alive;
  if (!(total > 0)) return { red: null, blue: null };
  return { red: ((threeRed + dead) / total) * 100, blue: (alive / total) * 100 };
}

/**
 * "📈 總計 N 場｜M 位玩家｜最終紅勝 x%／藍勝 y%（任務結算 紅 a%／藍 b%，三藍局刺中 c%）".
 * The legacy redWinRate / blueWinRate / merlinKillRate already carry the
 * 任務結算 / 刺殺結算 meaning, so they are the fallback for older caches.
 */
export function overviewTotalsLine(o: OverviewTotals): string {
  const final = finalShares(o);
  const missionRed = o.missionStage?.redPct ?? o.redWinRate;
  const missionBlue = o.missionStage?.bluePct ?? o.blueWinRate;
  const kill = o.assassinationStage?.killPct ?? o.merlinKillRate;
  return (
    `📈 總計 ${o.totalGames} 場｜${o.totalPlayers} 位玩家｜最終紅勝 ${pct(final.red)}／藍勝 ${pct(final.blue)}` +
    `（任務結算 紅 ${pct(missionRed)}／藍 ${pct(missionBlue)}，三藍局刺中 ${pct(kill)}）`
  );
}

/**
 * Full /排行 or digest text: optional header, the main board, extra sections
 * (the digest's "近 90 天" board and role titles — dropped from the back, one
 * at a time, while the text would exceed STATS_REPLY_MAX_CHARS), the totals
 * line, footer lines and the site link.
 */
export function formatLeaderboard(
  overview: OverviewTotals,
  main: LeaderboardView,
  opts: { header?: string; sections?: readonly (readonly string[])[]; footerLines?: string[] } = {},
): string {
  const head = [...(opts.header ? [opts.header] : []), ...leaderboardLines(main)];
  const tail = [overviewTotalsLine(overview), ...(opts.footerLines ?? []), SITE_FOOTER];
  const sections = (opts.sections ?? []).filter((s) => s.length > 0);
  for (;;) {
    const middle: string[] = [];
    for (const s of sections) middle.push(...s);
    const text = [...head, ...middle, ...tail].join('\n');
    if (text.length <= STATS_REPLY_MAX_CHARS || sections.length === 0) return clampReply(text);
    sections.pop();
  }
}

// ─── Pair chemistry ──────────────────────────────────────────────────────

/** Names in the chemistry matrix (column labels), in sheet order. */
export function chemistryRoster(chemistry: Pick<ChemistryData, 'coWin'> | null | undefined): string[] {
  return chemistry?.coWin?.players ? [...chemistry.coWin.players] : [];
}

function cell(matrix: ChemistryMatrix | undefined, a: string, b: string): number | null {
  if (!matrix || !Array.isArray(matrix.values)) return null;
  const rows = matrix.rowLabels ?? matrix.players;
  const read = (r: string, c: string): number | null => {
    const ri = rows.indexOf(r);
    const ci = matrix.players.indexOf(c);
    if (ri < 0 || ci < 0) return null;
    const v = matrix.values[ri]?.[ci];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return read(a, b) ?? read(b, a);
}

/**
 * Same-team record of two roster labels. In the sheet, coWin = games the two
 * won together and coLose = games they lost together; both only happen when
 * they are on the same team, so together = coWin + coLose. The cache has no
 * opposite-team (對戰) matrix.
 */
export function lookupPair(
  chemistry: Pick<ChemistryData, 'coWin' | 'coLose'>,
  a: string,
  b: string,
): { coWin: number | null; coLose: number | null } {
  return { coWin: cell(chemistry.coWin, a, b), coLose: cell(chemistry.coLose, a, b) };
}

export interface ChemistryPlayerRef {
  /** Display name (player-list spelling, e.g. "Sin" for matrix label "SIN"). */
  name: string;
  /** Overall win rate for context; omitted when unknown. */
  winRate?: number | null;
}

export function formatChemistry(
  a: ChemistryPlayerRef,
  b: ChemistryPlayerRef,
  pair: { coWin: number | null; coLose: number | null },
  rosterSize: number,
): string {
  const lines = [`🤝 ${a.name} × ${b.name} 默契`];
  const { coWin, coLose } = pair;
  if (coWin === null || coLose === null) {
    lines.push('默契矩陣裡沒有這兩位的同隊紀錄。');
  } else {
    const together = coWin + coLose;
    if (together === 0) {
      lines.push('兩人還沒同隊過。');
    } else {
      lines.push(`同隊 ${together} 場：一起贏 ${coWin}、一起輸 ${coLose}`);
      lines.push(`同隊勝率 ${pct((coWin / together) * 100)}`);
    }
  }
  const context = [a, b]
    .filter((p) => typeof p.winRate === 'number')
    .map((p) => `${p.name} ${pct(p.winRate)}`);
  if (context.length > 0) lines.push(`（個人勝率：${context.join('、')}）`);
  lines.push(`※ 默契矩陣收錄場次最多的 ${rosterSize} 位玩家；對戰（不同隊）紀錄目前沒有統計。`);
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
}

/** The player exists but is not one of the chemistry matrix's regulars. */
export function formatNotInChemistry(name: string, rosterSize: number): string {
  return clampReply(
    [
      `ℹ️ 「${name}」不在默契矩陣裡（只收錄場次最多的 ${rosterSize} 位玩家）。`,
      `個人戰績可用「/戰績 ${name}」查詢。`,
    ].join('\n'),
  );
}

// ─── Help / errors ───────────────────────────────────────────────────────

export function formatStatsHelp(platform: StatsPlatform): string {
  const lines = [
    '📖 阿瓦隆戰績指令',
    `${STATS_COMMAND_USAGE.player}\u3000個人戰績（名字可打一部分）`,
    `${STATS_COMMAND_USAGE.leaderboard}\u3000超額勝率排行 Top 10`,
    `${STATS_COMMAND_USAGE.chemistry}\u3000兩人同隊默契`,
    `${STATS_COMMAND_USAGE.feedback}\u3000給管理者的建議或回報問題`,
  ];
  if (platform === 'line') lines.push('/指令\u3000顯示這份說明');
  lines.push('每週一 12:00 會自動貼出本週排行。');
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
}

export function formatStatsUnavailable(): string {
  return '⚠️ 戰績資料暫時讀不到，請稍後再試。';
}
