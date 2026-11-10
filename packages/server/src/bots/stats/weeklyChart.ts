/**
 * Weekly ranking chart (2026-11-10) — the Monday digest as ONE PNG instead of
 * a text block (owner: 「每週排行能不能做成圖像式結果 不要用文字」「做成一張圖表」).
 *
 * Pure: `buildWeeklyChartSvg()` turns the digest data (statsQueries.weeklyChartData,
 * the same boards the text digest prints, plus 位置理論 / 整體理論) into an SVG string;
 * `renderWeeklyChartPng()` rasterises it with @resvg/resvg-js (prebuilt binaries, no
 * system libraries). The same image answers /排行 (title 「排行榜」, statsQueries.leaderboardChart).
 *
 * Layout (owner's third pass, 2026-11-10): one 1080-px card for a phone screen —
 *   1. a dark dated header;
 *   2. 角色理論 / 位置理論 / 整體理論 Top 10 side by side, three columns, each its own
 *      colour: rank badge, name (cut with …), a short bar from 0 and the whole %;
 *   3. 進步榜 and 新人榜 side by side;
 *   4. 角色王 at the bottom: Top 3 per role (ties share a line, 「等 N 人」), cards
 *      tinted red (刺客 莫甘娜 莫德雷德 奧伯倫) or blue (梅林 派西維爾 忠臣);
 *   5. a footer with the stats page link.
 * Each bar column draws a dashed baseline at the population average of its metric
 * (labelled 「平均 46%」; statsQueries.populationTheoryAverages) instead of 50%.
 * Every percentage is a whole number (roundHalfUp); the order is the cache's.
 * Smallest text is 22 px at 1080 px wide.
 *
 * Font: the bundled Noto Sans TC Medium (SIL OFL 1.1, assets/fonts/), loaded
 * explicitly — system fonts are never used, so the output is the same on a
 * laptop and in Render's Alpine container. One weight only; headings get a
 * thin same-colour stroke instead of a second 7 MB bold file. Characters the
 * font lacks (Hangul, simplified-only hanzi, emoji) are skipped by the
 * rasteriser; every current player name is covered.
 *
 * Player names come from the cache and are escaped for XML here (never
 * trusted as markup); control characters are dropped.
 */

import fs from 'fs';
import path from 'path';

// ─── Data ────────────────────────────────────────────────────────────────

export interface WeeklyChartBarRow {
  rank: number;
  name: string;
  /** Bar length (theory boards / 新人榜: the rate in %, 進步榜: the difference in points); null → no bar, "—". */
  value: number | null;
  /** Printed after the bar, e.g. "55%" or "+10". */
  valueLabel: string;
  /** Muted text on the right, e.g. "41% → 53%" or "13 場"; optional. */
  detail?: string;
}

export interface WeeklyChartBarPanel {
  /** Column heading, e.g. "角色理論勝率 Top 10". */
  title: string;
  /** The board's qualifier (period, who qualifies), a small caption under the heading. */
  note: string | null;
  rows: WeeklyChartBarRow[];
  /** Shown instead of bars when `rows` is empty. */
  emptyNote?: string;
  /** Population average of the metric (%): the dashed baseline, labelled 「平均 N%」; absent → no line. */
  average?: number | null;
}

/** One rank of a role: the holders sharing it (ties 各給) and their rate. */
export interface WeeklyChartRoleRank {
  rank: number;
  /** In the cache's order; the card shows what fits, then 「等 N 人」. */
  names: string[];
  valueLabel: string;
}

export interface WeeklyChartRoleKing {
  role: string;
  /** Card tint: red / blue side; null → neutral. */
  side: 'red' | 'blue' | null;
  /** Top 3 (ranks ≤ 3) from roleTitles.roleTop; an older cache: the #1 holders only. */
  ranks: WeeklyChartRoleRank[];
}

export interface WeeklyChartData {
  /** Header title; default 「每週排行」 (the /排行 command uses 「排行榜」). */
  title?: string;
  /** "11/9" — the +08 date of the post (/排行: the date the boards were computed for). */
  dateLabel: string;
  /** One muted line under the title, e.g. "資料至 2026-11-08｜總計 2228 場・221 位玩家". */
  subtitle: string | null;
  main: WeeklyChartBarPanel;
  /** 位置理論勝率 Top 10 (the cache's `position` board); null when absent. */
  position?: WeeklyChartBarPanel | null;
  /** 整體理論勝率 Top 10 (the cache's `overall` board, career); null when absent. */
  overall?: WeeklyChartBarPanel | null;
  improved: WeeklyChartBarPanel | null;
  roleKings: { title: string; note: string | null; entries: WeeklyChartRoleKing[] } | null;
  newcomers: WeeklyChartBarPanel | null;
  /** Footer lines (muted), e.g. the how-to-look-up line. */
  footerLines: string[];
  /** The stats page, printed last (accent colour). */
  url: string;
}

// ─── Numbers ─────────────────────────────────────────────────────────────
//
// Owner 2026-11-10: no decimal points anywhere on the image — the windows are 10 / 40 / 100 games,
// so the rates are whole percents anyway (角色理論 = 4/10 × k/40 + 1/10 × Σ j/10 = an integer / 100).
// Rounded half up for display only; the order stays the cache's (never re-sorted after rounding).
// The text replies keep statsReplies.pct (one decimal).

/** Half up (x.5 → x+1, −2.5 → −2), with a little slack for binary floats (62.49999999999999, i.e. 62.5, → 63). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5 + 1e-9);
}

/** 63.4 → "63%"; null / non-finite → "—". */
export function chartPct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${roundHalfUp(value)}%`;
}

/** Whole-point delta: 12.4 → "+12", -2.6 → "-3", 0.3 → "0"; null / non-finite → "—". */
export function chartSigned(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const n = roundHalfUp(value);
  return n > 0 ? `+${n}` : String(n === 0 ? 0 : n);
}

// ─── Look ────────────────────────────────────────────────────────────────

export const WEEKLY_CHART_WIDTH = 1080;
export const WEEKLY_CHART_FONT_FAMILY = 'Noto Sans TC';
/** packages/server/assets/fonts — the same three levels up from src/bots/stats and dist/bots/stats. */
export const WEEKLY_CHART_FONT_FILE = path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts', 'NotoSansTC-Medium.ttf');

const C = {
  page: '#eef0f4',
  header: '#16213a',
  headerText: '#ffffff',
  headerMuted: '#c3cad8',
  accent: '#ffc53d',
  card: '#ffffff',
  text: '#0b0b0b',
  muted: '#52514e',
  grid: '#d9dce3',
  baseline: '#6b6a66',
  main: '#2a78d6',
  position: '#eb6834',
  overall: '#6250d6',
  improved: '#0f8f62',
  newcomers: '#c2477a',
  link: '#1f5fae',
  medal: ['#d99a00', '#8c8f96', '#b0652b'],
  rankText: '#ffffff',
  redCard: '#fdeceb',
  redLabel: '#b42318',
  blueCard: '#e9f1fd',
  blueLabel: '#1f5fae',
  neutralCard: '#f3f5f9',
} as const;

const W = WEEKLY_CHART_WIDTH;
const PAGE_PAD = 24;
const CARD_X = PAGE_PAD;
const CARD_W = W - PAGE_PAD * 2;
const CARD_PAD = 20;
const INNER_X = CARD_X + CARD_PAD;
const INNER_R = CARD_X + CARD_W - CARD_PAD;
const INNER_W = INNER_R - INNER_X;
const COL_GAP = 18;
const SECTION_GAP = 18;

/** Font sizes (px at 1080 wide); nothing below 22. */
const FS = { title: 56, subtitle: 24, section: 32, colTitle: 27, caption: 22, name: 24, value: 24, detail: 22, badge: 22, footer: 22 };

// ─── Text helpers ────────────────────────────────────────────────────────

/** XML-escape text content / attribute values; drops characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return String(text)
    // eslint-disable-next-line no-control-regex -- removing the control characters XML 1.0 forbids is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Drop a leading emoji (🏆 / 🚀 …) — the bundled font has none; titles read the same without it. */
export function stripLeadingEmoji(text: string): string {
  return text.replace(/^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F|\u200D|\s)+/u, '').trim();
}

/** Approximate advance of one character in em (Noto Sans TC): CJK / full-width 1, Latin narrower. */
function charEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x2e80) return 1;
  if (ch === ' ') return 0.25;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[A-Z]/.test(ch)) return 0.64;
  if (/[a-z]/.test(ch)) return 0.54;
  if (ch === '%') return 0.85;
  if (cp >= 0x2190 && cp <= 0x21ff) return 1; // arrows (→)
  if (cp < 0x80) return 0.36;
  return 0.62;
}

/** Estimated rendered width in px (deliberately a little generous so nothing overflows). */
export function textWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size;
}

/** `text` cut to fit `maxWidth` px, with "…" when cut. */
export function fitText(text: string, size: number, maxWidth: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = textWidth('…', size);
  let out = '';
  let w = 0;
  for (const ch of chars) {
    const cw = charEm(ch) * size;
    if (w + cw + ellipsis > maxWidth) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}…`;
}

/** Break `text` into at most `maxLines` lines of `maxWidth` px (any character may break; CJK has no spaces). */
export function wrapText(text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  let w = 0;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const cw = charEm(ch) * size;
    if (w + cw > maxWidth && line) {
      if (lines.length === maxLines - 1) {
        lines.push(fitText(line + chars.slice(i).join(''), size, maxWidth));
        return lines;
      }
      lines.push(line);
      line = '';
      w = 0;
      if (ch === ' ') continue;
    }
    line += ch;
    w += cw;
  }
  if (line) lines.push(line);
  return lines;
}

interface TextOpts {
  size: number;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  bold?: boolean;
}

function text(x: number, y: number, content: string, o: TextOpts): string {
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  // One weight is bundled: "bold" is a thin outline in the same colour.
  const bold = o.bold ? ` stroke="${o.fill}" stroke-width="${(o.size / 32).toFixed(2)}" stroke-linejoin="round"` : '';
  return `<text x="${r(x)}" y="${r(y)}" font-size="${o.size}" fill="${o.fill}"${anchor}${bold}>${escapeXml(content)}</text>`;
}

function r(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function rect(x: number, y: number, w: number, h: number, fill: string, rx = 0): string {
  return `<rect x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}" rx="${rx}" fill="${fill}"/>`;
}

interface Drawn {
  svg: string;
  height: number;
}

// ─── Sections ────────────────────────────────────────────────────────────

function card(y: number, height: number): string {
  return rect(CARD_X, y, CARD_W, height, C.card, 20);
}

function rankBadge(cx: number, cy: number, rank: number, medals: boolean): string {
  const medal = medals ? C.medal[rank - 1] : undefined;
  const label = rank > 99 ? '…' : String(rank);
  if (medal) {
    return (
      `<circle cx="${r(cx)}" cy="${r(cy)}" r="15" fill="${medal}"/>` +
      text(cx, cy + 8, label, { size: FS.badge, fill: C.rankText, anchor: 'middle', bold: true })
    );
  }
  return (
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="14" fill="none" stroke="${C.grid}" stroke-width="2"/>` +
    text(cx, cy + 8, label, { size: FS.badge, fill: C.muted, anchor: 'middle' })
  );
}

/** A bar column's look: where things go inside its width, and its colour. */
interface ColumnSpec {
  color: string;
  rowH: number;
  nameW: number;
  /** Right-hand muted detail ("41% → 53%", "13 場"); 0 = none. */
  detailW: number;
  medals: boolean;
  /** Bars run from 0 to this value (shared by the columns of a section, so lengths compare). */
  axisMax: number;
}

const VALUE_W = 58;
const CAPTION_LINES = 3;

/** Heading (colour tick + title) and the wrapped caption; returns the svg and its height. */
function columnHead(x: number, y: number, w: number, panel: WeeklyChartBarPanel, color: string): Drawn {
  const svg: string[] = [rect(x, y, 40, 6, color, 3)];
  let cy = y + 6 + FS.colTitle + 6;
  svg.push(text(x, cy, fitText(panel.title, FS.colTitle, w), { size: FS.colTitle, fill: C.text, bold: true }));
  if (panel.note) {
    for (const line of wrapText(panel.note, FS.caption, w, CAPTION_LINES)) {
      cy += FS.caption * 1.36;
      svg.push(text(x, cy, line, { size: FS.caption, fill: C.muted }));
    }
  }
  return { svg: svg.join(''), height: cy - y };
}

/** The rows of a bar column from `top` (already aligned with its neighbours); returns the svg and the bottom y. */
function columnRows(x: number, top: number, w: number, panel: WeeklyChartBarPanel, spec: ColumnSpec, withAvgLabel: boolean): Drawn {
  const svg: string[] = [];
  const right = x + w;
  const nameX = x + 38;
  const barX = nameX + spec.nameW + 8;
  const valueRight = right - spec.detailW;
  const barSpan = Math.max(24, valueRight - VALUE_W - 6 - barX);
  const scale = (v: number): number => (Math.max(0, Math.min(v, spec.axisMax)) / spec.axisMax) * barSpan;
  const rowsTop = top + (withAvgLabel ? 30 : 0);

  if (panel.rows.length === 0) {
    let cy = rowsTop;
    for (const line of wrapText(panel.emptyNote ?? '（目前沒有排行資料）', FS.detail, w, 4)) {
      cy += FS.detail * 1.45;
      svg.push(text(x, cy, line, { size: FS.detail, fill: C.muted }));
    }
    return { svg: svg.join(''), height: cy + 8 - top };
  }

  const bottom = rowsTop + panel.rows.length * spec.rowH;
  svg.push(`<line x1="${r(barX)}" y1="${r(rowsTop)}" x2="${r(barX)}" y2="${r(bottom)}" stroke="${C.grid}" stroke-width="2"/>`);
  panel.rows.forEach((row, i) => {
    const mid = rowsTop + i * spec.rowH + spec.rowH / 2;
    svg.push(rankBadge(x + 16, mid, row.rank, spec.medals));
    svg.push(text(nameX, mid + FS.name * 0.36, fitText(row.name, FS.name, spec.nameW), { size: FS.name, fill: C.text }));
    const bw = typeof row.value === 'number' && Number.isFinite(row.value) ? scale(row.value) : 0;
    if (bw > 0) svg.push(rect(barX, mid - 11, Math.max(bw, 4), 22, spec.color, 4));
    svg.push(text(valueRight, mid + FS.value * 0.36, row.valueLabel, { size: FS.value, fill: C.text, anchor: 'end', bold: true }));
    if (row.detail && spec.detailW > 0) {
      svg.push(text(right, mid + FS.detail * 0.36, fitText(row.detail, FS.detail, spec.detailW - 10), { size: FS.detail, fill: C.muted, anchor: 'end' }));
    }
  });

  // Population average of the metric: a dashed line through the rows, labelled above them.
  const avg = panel.average;
  if (typeof avg === 'number' && Number.isFinite(avg) && avg > 0 && avg <= spec.axisMax) {
    const lx = barX + scale(avg);
    svg.push(`<line x1="${r(lx)}" y1="${r(rowsTop - 4)}" x2="${r(lx)}" y2="${r(bottom)}" stroke="${C.baseline}" stroke-width="2" stroke-dasharray="5 5"/>`);
    if (withAvgLabel) {
      const label = `平均 ${chartPct(avg)}`;
      const lw = textWidth(label, FS.caption);
      const cx = Math.min(Math.max(lx, x + lw / 2), right - lw / 2);
      svg.push(text(cx, rowsTop - 8, label, { size: FS.caption, fill: C.baseline, anchor: 'middle' }));
    }
  }
  return { svg: svg.join(''), height: bottom + 6 - top };
}

/** Columns side by side in one card: headings aligned, rows aligned. */
function columnsSection(y: number, cols: Array<{ panel: WeeklyChartBarPanel; spec: ColumnSpec }>): Drawn {
  const n = cols.length;
  const w = (INNER_W - COL_GAP * (n - 1)) / n;
  const top = y + CARD_PAD;
  const heads = cols.map((c, i) => columnHead(INNER_X + i * (w + COL_GAP), top, w, c.panel, c.spec.color));
  const headH = Math.max(...heads.map((h) => h.height));
  const withAvg = cols.some((c) => typeof c.panel.average === 'number' && c.panel.rows.length > 0);
  const rowsTop = top + headH + 14;
  const bodies = cols.map((c, i) => columnRows(INNER_X + i * (w + COL_GAP), rowsTop, w, c.panel, c.spec, withAvg));
  const height = rowsTop + Math.max(...bodies.map((b) => b.height)) + CARD_PAD - 6 - y;
  return { svg: card(y, height) + heads.map((h) => h.svg).join('') + bodies.map((b) => b.svg).join(''), height };
}

/** Bars from 0 to a round 10 above the largest value (at most 100). */
function percentAxis(...panels: Array<WeeklyChartBarPanel | null | undefined>): number {
  const values = panels.flatMap((p) => (p ? [...p.rows.map((row) => row.value), p.average ?? null] : []));
  const max = Math.max(0, ...values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  return Math.min(100, Math.max(10, Math.ceil(max / 10) * 10));
}

/** Holders shown on one rank line before 「等 N 人」, however wide the card. */
export const ROLE_KING_NAMES_MAX = 3;

/**
 * Tied holders in one line: as many whole names as fit (at most ROLE_KING_NAMES_MAX), then
 * 「等 N 人」 (N = all holders); a single name that does not fit is cut with "…" before the suffix.
 */
export function fitNames(names: readonly string[], size: number, maxWidth: number): string {
  if (names.length === 0) return '—';
  const suffix = (k: number): string => (k < names.length ? ` 等 ${names.length} 人` : '');
  for (let k = Math.min(names.length, ROLE_KING_NAMES_MAX); k >= 1; k -= 1) {
    const label = names.slice(0, k).join('／') + suffix(k);
    if (textWidth(label, size) <= maxWidth) return label;
  }
  const tail = suffix(1);
  return fitText(names[0], size, maxWidth - textWidth(tail, size)) + tail;
}

const ROLE_RANK_LINES = 3;
const ROLE_CARD_GAP = 12;
const ROLE_LINE_H = 38;
const ROLE_LABEL_W = 122;

/** One role card: the role (side colour) on the left, then up to three rank lines. */
function roleCard(x: number, y: number, w: number, h: number, e: WeeklyChartRoleKing): string {
  const fill = e.side === 'red' ? C.redCard : e.side === 'blue' ? C.blueCard : C.neutralCard;
  const label = e.side === 'red' ? C.redLabel : e.side === 'blue' ? C.blueLabel : C.muted;
  const svg: string[] = [rect(x, y, w, h, fill, 14)];
  const first = y + 12 + ROLE_LINE_H / 2;
  svg.push(text(x + 16, first + FS.name * 0.36, fitText(e.role || '—', FS.name, ROLE_LABEL_W - 20), { size: FS.name, fill: label, bold: true }));
  const badgeX = x + ROLE_LABEL_W + 16;
  const namesX = badgeX + 24;
  const valueRight = x + w - 16;
  e.ranks.slice(0, ROLE_RANK_LINES).forEach((rk, i) => {
    const mid = first + i * ROLE_LINE_H;
    svg.push(rankBadge(badgeX, mid, rk.rank, true));
    svg.push(text(valueRight, mid + FS.value * 0.36, rk.valueLabel, { size: FS.value, fill: C.text, anchor: 'end', bold: true }));
    svg.push(text(namesX, mid + FS.name * 0.36, fitNames(rk.names, FS.name, valueRight - VALUE_W - 10 - namesX), { size: FS.name, fill: C.text }));
  });
  return svg.join('');
}

/**
 * 角色王: section title, then two columns of role cards — the red side on the left (刺客 莫甘娜
 * 莫德雷德 奧伯倫), the blue side on the right (梅林 派西維爾 忠臣); any other role joins the shorter column.
 */
function roleKingsSection(y: number, panel: NonNullable<WeeklyChartData['roleKings']>): Drawn {
  const svg: string[] = [];
  let cy = y + CARD_PAD + FS.section * 0.9;
  svg.push(text(INNER_X, cy, panel.title, { size: FS.section, fill: C.text, bold: true }));
  if (panel.note) {
    const noteX = INNER_X + textWidth(panel.title, FS.section) + 16;
    svg.push(text(noteX, cy, fitText(panel.note, FS.caption, INNER_R - noteX), { size: FS.caption, fill: C.muted }));
  }
  cy += 18;
  const left = panel.entries.filter((e) => e.side === 'red');
  const right = panel.entries.filter((e) => e.side === 'blue');
  for (const e of panel.entries.filter((x) => x.side !== 'red' && x.side !== 'blue')) (left.length <= right.length ? left : right).push(e);
  const lines = Math.max(1, ...panel.entries.map((e) => Math.min(ROLE_RANK_LINES, e.ranks.length)));
  const cardH = 24 + lines * ROLE_LINE_H - 6;
  const cw = (INNER_W - COL_GAP) / 2;
  [left, right].forEach((col, c) => {
    col.forEach((e, i) => svg.push(roleCard(INNER_X + c * (cw + COL_GAP), cy + i * (cardH + ROLE_CARD_GAP), cw, cardH, e)));
  });
  const rows = Math.max(left.length, right.length);
  const height = cy + rows * cardH + Math.max(0, rows - 1) * ROLE_CARD_GAP + CARD_PAD - y;
  return { svg: card(y, height) + svg.join(''), height };
}

// ─── Whole chart ─────────────────────────────────────────────────────────

/** The digest as one SVG document (WEEKLY_CHART_WIDTH wide, height as needed). */
export function buildWeeklyChartSvg(data: WeeklyChartData): string {
  const parts: string[] = [];

  // Header band.
  const headerH = data.subtitle ? 140 : 108;
  parts.push(rect(0, 0, W, headerH, C.header));
  const titleY = 74;
  const title = data.title || '每週排行';
  parts.push(text(PAGE_PAD + 8, titleY, title, { size: FS.title, fill: C.headerText, bold: true }));
  parts.push(text(PAGE_PAD + 8 + textWidth(title, FS.title) + 22, titleY, data.dateLabel, { size: FS.title, fill: C.accent, bold: true }));
  if (data.subtitle) {
    parts.push(text(PAGE_PAD + 8, titleY + 44, fitText(data.subtitle, FS.subtitle, W - PAGE_PAD * 2 - 16), { size: FS.subtitle, fill: C.headerMuted }));
  }

  let y = headerH + SECTION_GAP;
  const add = (d: Drawn): void => {
    parts.push(d.svg);
    y += d.height + SECTION_GAP;
  };

  // 1. The three theory boards side by side (one shared 0–axis so bar lengths compare).
  const theoryAxis = percentAxis(data.main, data.position, data.overall);
  const theory = { rowH: 46, nameW: 124, detailW: 0, medals: true, axisMax: theoryAxis };
  const theoryCols: Array<{ panel: WeeklyChartBarPanel; spec: ColumnSpec }> = [{ panel: data.main, spec: { ...theory, color: C.main } }];
  if (data.position && data.position.rows.length > 0) theoryCols.push({ panel: data.position, spec: { ...theory, color: C.position } });
  if (data.overall && data.overall.rows.length > 0) theoryCols.push({ panel: data.overall, spec: { ...theory, color: C.overall } });
  add(columnsSection(y, theoryCols));

  // 2. 進步榜 and 新人榜 side by side.
  const pair: Array<{ panel: WeeklyChartBarPanel; spec: ColumnSpec }> = [];
  if (data.improved && data.improved.rows.length > 0) {
    const maxDelta = Math.max(1, ...data.improved.rows.map((row) => (typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : 0)));
    pair.push({ panel: data.improved, spec: { color: C.improved, rowH: 48, nameW: 150, detailW: 150, medals: false, axisMax: maxDelta } });
  }
  if (data.newcomers && data.newcomers.rows.length > 0) {
    pair.push({ panel: data.newcomers, spec: { color: C.newcomers, rowH: 48, nameW: 150, detailW: 80, medals: false, axisMax: percentAxis(data.newcomers) } });
  }
  if (pair.length > 0) add(columnsSection(y, pair));

  // 3. 角色王 at the bottom.
  if (data.roleKings && data.roleKings.entries.length > 0) add(roleKingsSection(y, data.roleKings));

  // Footer.
  y += 4;
  for (const line of data.footerLines) {
    y += FS.footer * 1.1;
    parts.push(text(W / 2, y, fitText(line, FS.footer, W - PAGE_PAD * 2), { size: FS.footer, fill: C.muted, anchor: 'middle' }));
    y += 8;
  }
  y += FS.footer * 1.3;
  parts.push(text(W / 2, y, fitText(data.url, FS.footer + 2, W - PAGE_PAD * 2), { size: FS.footer + 2, fill: C.link, anchor: 'middle', bold: true }));
  const height = Math.ceil(y + PAGE_PAD + 4);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${WEEKLY_CHART_FONT_FAMILY}">` +
    rect(0, 0, W, height, C.page) +
    parts.join('') +
    '</svg>'
  );
}

let fontChecked = false;

/**
 * Rasterise the chart to PNG with the bundled font only (loadSystemFonts off).
 * Throws when the font file or the native renderer is missing — the caller
 * falls back to the text digest.
 */
export function renderWeeklyChartPng(data: WeeklyChartData, opts: { fontFile?: string } = {}): Buffer {
  const fontFile = opts.fontFile ?? WEEKLY_CHART_FONT_FILE;
  if (!fontChecked || opts.fontFile) {
    if (!fs.existsSync(fontFile)) throw new Error(`weekly chart font missing: ${fontFile}`);
    if (!opts.fontFile) fontChecked = true;
  }
  // Required lazily: a missing native binary must only cost the picture, never the module graph.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  const svg = buildWeeklyChartSvg(data);
  const resvg = new Resvg(svg, {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: WEEKLY_CHART_FONT_FAMILY },
    background: C.page,
  });
  return resvg.render().asPng();
}
