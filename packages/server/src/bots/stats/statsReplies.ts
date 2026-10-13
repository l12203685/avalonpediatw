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
  PlayerTheoryWindow,
  PlaystyleData,
  PlaystylePlayerData,
  StrengthPlayerData,
} from '../../services/sheetsAnalysis';
import { isTheoryBoard, playerNameKey, theoryLastWindows } from '../../services/sheetsAnalysis';

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

/** Rows of the 進步榜 / 新人榜 appended to the Monday digest. */
export const DIGEST_IMPROVED_SIZE = 5;
export const DIGEST_NEWCOMERS_SIZE = 3;

/**
 * generate_cache.py LEADERBOARD_CONFIG.theoryMinCellGames: a role / seat with
 * fewer games in the window is topped up to this many at the population rate.
 * The card's footnote uses the cache's value when it carries one.
 */
export const THEORY_MIN_CELL_GAMES = 3;

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

/**
 * A name as the stats compare it: case, full-/half-width (ＨＡＯ → hao), zero-width
 * characters and extra spaces do not matter (sheetsAnalysis.playerNameKey, the same rule
 * generate_cache.py merges players by).
 */
export function normalizeName(s: string): string {
  return playerNameKey(s);
}

export type NameMatch =
  | {
      kind: 'found';
      name: string;
      /**
       * Other rows of the same player spelled differently (Nova / NOVA / nova). Only a cache
       * written before generate_cache.py merged such names has them.
       */
      caseVariants: string[];
    }
  | { kind: 'ambiguous'; query: string; candidates: string[]; total: number }
  | { kind: 'none'; query: string };

/**
 * Resolve a typed name against `names` (given in priority order — e.g. most
 * games first; candidate lists keep that order).
 *
 *   1. exact match
 *   2. the same name ignoring case / width (normalizeName) — the first such name wins
 *      (an old cache may still list one player as Nova / NOVA / nova: the one with the
 *      most games when `names` is ordered so; the others are its caseVariants)
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
  if (ci.length > 0) return { kind: 'found', name: ci[0], caseVariants: ci.slice(1) };

  // One candidate per player: other spellings of a listed player are not separate candidates.
  const sub = names.filter((n) => normalizeName(n).includes(nq));
  const seen = new Set<string>();
  const players: string[] = [];
  for (const n of sub) {
    const key = normalizeName(n);
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(n);
  }
  if (players.length === 1) return { kind: 'found', name: players[0], caseVariants: sameCase(players[0]) };
  if (players.length > 1) {
    return { kind: 'ambiguous', query: q, candidates: players.slice(0, MAX_NAME_CANDIDATES), total: players.length };
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
  /** Other rows of the same player spelled differently (old caches only), shown as a hint. */
  caseVariants?: string[];
  /** leaderboard.config.theoryMinCellGames of the cache (for the footnote); default 3. */
  minCellGames?: number;
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

/** "※ 角色理論 = …" — how the card's theory numbers are made (top-up clause only when it is on). */
export function theoryFootnote(minCellGames: number = THEORY_MIN_CELL_GAMES): string {
  const topUp = minCellGames > 0 ? `；不到 ${minCellGames} 場的角色或位置用全體勝率補到 ${minCellGames} 場` : '';
  return `※ 角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他各 1/10）× 該角色最終勝率；位置理論 = Σ 1/10 × 該位置最終勝率${topUp}`;
}

function theoryLine(label: string, w: PlayerTheoryWindow): string {
  return `${label}｜角色理論 ${pct(w.roleTheory)}｜位置理論 ${pct(w.positionTheory)}｜最終 ${pct(w.finalWinRate)}`;
}

/**
 * "近 100 場｜角色理論 …", "近 50 場｜…", "生涯 N 場｜…" from `player.theory`
 * (schemaVersion 3; whatever last-N windows the cache has, largest first). A
 * last-N line is printed only when the player has more than N games (otherwise
 * it is the career line again). null on an older cache.
 */
export function theoryLines(p: Pick<PlayerStats, 'theory'>): string[] | null {
  const career = p.theory?.career;
  if (!career || typeof career.games !== 'number') return null;
  const lines: string[] = [];
  for (const w of theoryLastWindows(p.theory)) {
    if (career.games > w.window) {
      lines.push(theoryLine(`近 ${w.window} 場`, w));
    }
  }
  lines.push(theoryLine(`生涯 ${career.games} 場`, career));
  return lines;
}

/**
 * Player card (Edward 2026-10-13): the theory win rates first — 近 100 場、近 50 場
 * and 生涯, each with 角色理論／位置理論／最終勝率 — then the 任務結算 → 刺殺結算 →
 * 最終 walk and the per-side final rates (docs/stats/two_stage_outcome.md).
 * `missionWinRate` falls back to the legacy `winRate`, which has the same 任務結算
 * meaning. The excess win rate and the legacy roleTheory are not shown; on a
 * cache without `theory` the card says the theory rates come with the next refresh.
 */
export function formatPlayerCard(input: PlayerCardInput): string {
  const p = input.player;
  const lines: string[] = [`📊 ${p.name} 的戰績`];
  const theory = theoryLines(p);
  if (theory) {
    lines.push(...theory);
  } else {
    lines.push(`場次 ${p.totalGames}｜最終勝率 ${pct(p.finalWinRate)}`);
    lines.push('（角色理論／位置理論勝率：下次每日更新資料後提供）');
  }
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
    lines.push(`ℹ️ 大小寫不同的寫法目前另列：${input.caseVariants.slice(0, MAX_NAME_CANDIDATES).join('、')}（同一人，戰績更新後會合併）`);
  }
  if (theory) lines.push(theoryFootnote(input.minCellGames ?? THEORY_MIN_CELL_GAMES));
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
}

// ─── Leaderboard ─────────────────────────────────────────────────────────
//
// Owner decision 2026-10-13 (docs/stats/two_stage_outcome.md): rank by the
// 角色理論勝率 of each player's own last 100 games (players active in the last
// 90 days with ≥ 100 career games) and print 角色理論／位置理論／最終勝率 and the
// games of that window — "條件篩選可以是近期，但資料篩選不能少場". Boards come
// precomputed from the cache's `leaderboard` section. A cache written before
// that (excess-win-rate boards without `metric`) is never printed as excess:
// /排行 falls back to overview.topPlayersByRoleTheory, else says the new
// ranking comes with the next daily refresh.

/** One printed ranking row (all numbers over the board's window of the player's games). */
export interface LeaderboardLine {
  rank: number;
  name: string;
  roleTheory: number | null;
  positionTheory: number | null;
  finalWinRate: number | null;
  games: number;
}

export interface LeaderboardView {
  /** First line, e.g. "🏆 角色理論勝率排行 Top 10（各人最近 100 場，近 90 天內有出賽、生涯至少 100 場）". */
  title: string;
  rows: LeaderboardLine[];
  /** Printed instead of rows when there are none. */
  emptyNote?: string;
}

/**
 * Shown on a cache written before the theory rates. Such a cache carries none of the new
 * settings, so this names the generator's defaults (LEADERBOARD_CONFIG.mainGames = 100).
 */
export const LEADERBOARD_PENDING_NOTE = '（排行改版中：下次每日更新資料後，會改用「各人最近 100 場」的角色理論勝率排行）';

/**
 * A setting of the generator: leaderboard.config[key], else overview.theoryConfig[key], else
 * `fallback` (the generator's default), so the text never contradicts the numbers.
 */
function theorySetting(
  key: 'mainGames' | 'activeDays',
  fallback: number,
  ...sources: Array<Record<string, unknown> | null | undefined>
): number {
  for (const src of sources) {
    const v = src?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return fallback;
}

/** The board with that id, or null when it is absent or has no rows (the generator omits boards it cannot build). */
export function findBoard(
  leaderboard: Pick<LeaderboardSection, 'boards'> | null | undefined,
  id: string,
): LeaderboardBoard | null {
  const board = leaderboard?.boards?.find((b) => b.id === id);
  return board && Array.isArray(board.rows) && board.rows.length > 0 ? board : null;
}

/** findBoard, but only a board written by the theory generator (it carries `metric`). */
export function findTheoryBoard(
  leaderboard: Pick<LeaderboardSection, 'boards'> | null | undefined,
  id: string,
): LeaderboardBoard | null {
  const board = findBoard(leaderboard, id);
  return board && isTheoryBoard(board) ? board : null;
}

/**
 * The note's first clause only: the generator appends the legend (角色理論 = …)
 * after a "；", which is for the site's caption, not for a title in brackets.
 */
function noteQualifier(note: unknown): string {
  return typeof note === 'string' ? note.split('；')[0].trim() : '';
}

function boardTitle(board: LeaderboardBoard, size: number | null, emoji: string): string {
  const qualifier = [board.period, noteQualifier(board.note)].filter((s): s is string => typeof s === 'string' && s.length > 0).join('，');
  return `${emoji} ${board.title}${size === null ? '' : ` Top ${size}`}${qualifier ? `（${qualifier}）` : ''}`;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A theory board (main / last50 / newcomers) as a printable view, top `size` rows. */
export function boardView(board: LeaderboardBoard, size: number = LEADERBOARD_SIZE, emoji = '🏆'): LeaderboardView {
  return {
    title: boardTitle(board, size, emoji),
    rows: board.rows.slice(0, size).map((r, i) => ({
      rank: typeof r.rank === 'number' ? r.rank : i + 1,
      name: r.name,
      roleTheory: numOrNull(r.roleTheory) ?? numOrNull(r.value),
      positionTheory: numOrNull(r.positionTheory),
      finalWinRate: numOrNull(r.finalWinRate),
      games: r.games,
    })),
  };
}

/**
 * The ranking /排行 and the Monday digest lead with, in order of preference:
 *   1. the cache's `leaderboard` main board (each active player's last 100 games);
 *   2. `overview.topPlayersByRoleTheory` (same window, ≥ 100 career games, any
 *      activity) — e.g. when nobody qualified for the main board;
 *   3. an empty view: "nobody qualifies" on a current cache, or the pending
 *      note on a cache written before the theory rates.
 */
export function selectLeaderboard(
  leaderboard: (Pick<LeaderboardSection, 'boards'> & Partial<Pick<LeaderboardSection, 'config'>>) | null | undefined,
  overview: Pick<OverviewData, 'topPlayersByRoleTheory' | 'schemaVersion' | 'theoryConfig'> | null | undefined,
  size: number = LEADERBOARD_SIZE,
): LeaderboardView {
  const main = findTheoryBoard(leaderboard, 'main');
  if (main) return boardView(main, size, '🏆');

  // The window / thresholds the generator used (a pre-theory leaderboard.config has none of these keys).
  const settings = [leaderboard?.config, overview?.theoryConfig as Record<string, unknown> | undefined];
  const mainGames = theorySetting('mainGames', 100, ...settings);
  const activeDays = theorySetting('activeDays', 90, ...settings);
  const top = overview?.topPlayersByRoleTheory;
  if (Array.isArray(top) && top.length > 0) {
    return {
      title: `🏆 角色理論勝率排行 Top ${size}（各人最近 ${mainGames} 場，生涯至少 ${mainGames} 場，不限近期出賽）`,
      rows: top.slice(0, size).map((r, i) => ({
        rank: i + 1,
        name: r.name,
        roleTheory: numOrNull(r.roleTheory),
        positionTheory: numOrNull(r.positionTheory),
        finalWinRate: numOrNull(r.finalWinRate),
        games: r.games,
      })),
    };
  }
  const current = Array.isArray(top) || (typeof overview?.schemaVersion === 'number' && overview.schemaVersion >= 3);
  return {
    title: '🏆 角色理論勝率排行',
    rows: [],
    emptyNote: current ? `（目前沒有符合條件的玩家：近 ${activeDays} 天內有出賽、生涯至少 ${mainGames} 場）` : LEADERBOARD_PENDING_NOTE,
  };
}

const MEDALS = ['🥇', '🥈', '🥉'];

function rankLabel(rank: number): string {
  return MEDALS[rank - 1] ?? `${rank}.`;
}

/** Title line + one line per row: rank, name, 角色理論、位置理論、最終勝率 and games of the window. */
export function leaderboardLines(view: LeaderboardView): string[] {
  const lines = [view.title];
  if (view.rows.length === 0) lines.push(view.emptyNote ?? '（目前沒有排行資料）');
  for (const r of view.rows) {
    lines.push(
      `${rankLabel(r.rank)} ${r.name}\u3000角色理論 ${pct(r.roleTheory)}｜位置理論 ${pct(r.positionTheory)}｜最終 ${pct(r.finalWinRate)}｜${r.games} 場`,
    );
  }
  return lines;
}

/** "🚀 進步榜 Top 5（…）" + "1. 甲 +10.4（角色理論 45.0% ← 34.6%）" from the `improved` board. */
export function improvedLines(board: LeaderboardBoard | null | undefined, size: number = DIGEST_IMPROVED_SIZE): string[] {
  if (!board || !isTheoryBoard(board) || !Array.isArray(board.rows) || board.rows.length === 0) return [];
  const rows = board.rows.slice(0, size);
  return [
    boardTitle(board, rows.length, '🚀'),
    ...rows.map((r, i) => `${typeof r.rank === 'number' ? r.rank : i + 1}. ${r.name}\u3000${signed(r.value)}（角色理論 ${pct(r.recentRoleTheory)} ← ${pct(r.priorRoleTheory)}）`),
  ];
}

/** "👑 角色王（各人該角色最近 20 場）：刺客 HAO 90.0%、…" from the `roleTitles` board, or null when absent. */
export function roleTitlesLine(board: LeaderboardBoard | null | undefined): string | null {
  if (!board || !isTheoryBoard(board) || !Array.isArray(board.rows) || board.rows.length === 0) return null;
  const parts = board.rows.map((r) => `${r.role ? `${r.role} ` : ''}${r.name} ${pct(r.value)}`);
  return `👑 ${board.title}${board.period ? `（${board.period}）` : ''}：${parts.join('、')}`;
}

/** "🌱 新人榜（…，全部場次）：甲 角色理論 47.0%（13 場）、…" from the `newcomers` board, or null. */
export function newcomersLine(board: LeaderboardBoard | null | undefined, size: number = DIGEST_NEWCOMERS_SIZE): string | null {
  if (!board || !isTheoryBoard(board) || !Array.isArray(board.rows) || board.rows.length === 0) return null;
  const parts = board.rows.slice(0, size).map((r) => `${r.name} 角色理論 ${pct(numOrNull(r.roleTheory) ?? r.value)}（${r.games} 場）`);
  return `🌱 ${board.title}（${board.period}，新人例外：看全部場次）：${parts.join('、')}`;
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
 * (the digest's 進步榜, 角色王 and 新人榜 — dropped from the back, one at a time,
 * while the text would exceed STATS_REPLY_MAX_CHARS), the totals line, footer
 * lines and the site link.
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
    `${STATS_COMMAND_USAGE.leaderboard}\u3000角色理論勝率排行 Top 10（各人最近 100 場）`,
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
