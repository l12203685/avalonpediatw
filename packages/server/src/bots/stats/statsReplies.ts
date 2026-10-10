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
  OverviewData,
  PlayerStats,
  PlaystyleData,
  PlaystylePlayerData,
  StrengthPlayerData,
} from '../../services/sheetsAnalysis';

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
 * Only used when the cache has no `overview.topPlayersByTheory` (older or
 * partial cache): rebuild the same ranking the generator uses — roleTheory
 * desc among players with at least MIN_GAMES_THRESHOLD (30) games.
 */
export const LEADERBOARD_FALLBACK_MIN_GAMES = 30;

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

export function formatPlayerCard(input: PlayerCardInput): string {
  const p = input.player;
  const lines: string[] = [
    `📊 ${p.name} 的戰績`,
    `場次 ${p.totalGames}｜勝率 ${pct(p.winRate)}｜角色理論勝率 ${pct(p.roleTheory)}`,
  ];
  const redGames = typeof p.rawRedGames === 'number' ? `（${p.rawRedGames} 場）` : '';
  const blueGames = typeof p.rawBlueGames === 'number' ? `（${p.rawBlueGames} 場）` : '';
  lines.push(`🔴 紅方勝率 ${pct(p.redWin)}${redGames}｜🔵 藍方勝率 ${pct(p.blueWin)}${blueGames}`);

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

export interface LeaderboardRow {
  name: string;
  roleTheory: number;
  winRate: number;
  games: number;
}

/**
 * Same ranking the website's 數據分析 → 總覽「理論勝率排行」shows: the cache's
 * precomputed `overview.topPlayersByTheory` (the min-games threshold is
 * applied by the cache generator, not by the site). Falls back to rebuilding
 * it from the player list only when that field is missing or empty.
 */
export function selectLeaderboard(
  overview: Pick<OverviewData, 'topPlayersByTheory'> | null | undefined,
  players: readonly PlayerStats[] = [],
  size: number = LEADERBOARD_SIZE,
): LeaderboardRow[] {
  const top = overview?.topPlayersByTheory;
  if (Array.isArray(top) && top.length > 0) {
    return top.slice(0, size).map((r) => ({ name: r.name, roleTheory: r.roleTheory, winRate: r.winRate, games: r.games }));
  }
  return players
    .filter((p) => p.totalGames >= LEADERBOARD_FALLBACK_MIN_GAMES)
    .slice()
    .sort((a, b) => b.roleTheory - a.roleTheory || b.totalGames - a.totalGames)
    .slice(0, size)
    .map((p) => ({ name: p.name, roleTheory: p.roleTheory, winRate: p.winRate, games: p.totalGames }));
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function formatLeaderboard(
  overview: Pick<OverviewData, 'totalGames' | 'totalPlayers' | 'redWinRate' | 'blueWinRate'>,
  rows: readonly LeaderboardRow[],
  opts: { title?: string; footerLines?: string[] } = {},
): string {
  const lines: string[] = [opts.title ?? '🏆 理論勝率排行 Top 10'];
  if (rows.length === 0) {
    lines.push('（目前沒有排行資料）');
  }
  rows.forEach((r, i) => {
    const rank = MEDALS[i] ?? `${i + 1}.`;
    lines.push(`${rank} ${r.name}\u3000${pct(r.roleTheory)}（勝率 ${pct(r.winRate)}・${r.games} 場）`);
  });
  lines.push(
    `📈 總計 ${overview.totalGames} 場｜${overview.totalPlayers} 位玩家｜紅方勝率 ${pct(overview.redWinRate)}｜藍方勝率 ${pct(overview.blueWinRate)}`,
  );
  for (const extra of opts.footerLines ?? []) lines.push(extra);
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
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
    `${STATS_COMMAND_USAGE.leaderboard}\u3000理論勝率排行 Top 10`,
    `${STATS_COMMAND_USAGE.chemistry}\u3000兩人同隊默契`,
  ];
  if (platform === 'line') lines.push('/指令\u3000顯示這份說明');
  lines.push('每週一 12:00 會自動貼出本週排行。');
  lines.push(SITE_FOOTER);
  return clampReply(lines.join('\n'));
}

export function formatStatsUnavailable(): string {
  return '⚠️ 戰績資料暫時讀不到，請稍後再試。';
}
