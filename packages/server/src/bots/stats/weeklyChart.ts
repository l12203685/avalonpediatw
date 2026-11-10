/**
 * Weekly ranking chart (2026-11-10) — the Monday digest as ONE PNG instead of
 * a text block (owner: 「每週排行能不能做成圖像式結果 不要用文字」「做成一張圖表」).
 *
 * Pure: `buildWeeklyChartSvg()` turns the digest data (statsQueries.weeklyChartData,
 * the same boards the text digest prints) into an SVG string; `renderWeeklyChartPng()`
 * rasterises it with @resvg/resvg-js (prebuilt binaries, no system libraries).
 *
 * Layout: one tall 1080-px card for a phone screen in Discord / LINE — a dark
 * dated header, three Top 10 boards as horizontal bars (rank, name, bar, %):
 * 角色理論, 位置理論 and 整體理論 (each its own colour; added 2026-11-10 at the
 * owner's request), then panels for 進步榜 Top 5, 角色王 and 新人榜 when the
 * cache has them, and a footer with the stats page link. Bars start at 0 (the
 * number is printed at the end of each bar), with a dashed 50% line. The same
 * image answers /排行 (title 「排行榜」, statsQueries.leaderboardChart).
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
  /** Bar length (main / 新人榜: 角色理論 %, 進步榜: the difference in points); null → no bar, "—". */
  value: number | null;
  /** Printed at the end of the bar, e.g. "55.0%" or "+10.4". */
  valueLabel: string;
  /** Muted text on the right, e.g. "40.0% → 50.0%" or "13 場"; optional. */
  detail?: string;
}

export interface WeeklyChartBarPanel {
  title: string;
  /** The board's qualifier (period, who qualifies), shown under the title. */
  note: string | null;
  rows: WeeklyChartBarRow[];
  /** Shown instead of bars when `rows` is empty. */
  emptyNote?: string;
}

export interface WeeklyChartRoleKing {
  role: string;
  /** Every holder (ties 各給), in the cache's order; the cell shows what fits, then 「等 N 人」. */
  names: string[];
  valueLabel: string;
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
  cell: '#f3f5f9',
  text: '#0b0b0b',
  muted: '#52514e',
  grid: '#d9dce3',
  main: '#2a78d6',
  position: '#eb6834',
  overall: '#6250d6',
  improved: '#0f8f62',
  newcomers: '#c2477a',
  link: '#1f5fae',
  medal: ['#d99a00', '#8c8f96', '#b0652b'],
  rankText: '#ffffff',
} as const;

const W = WEEKLY_CHART_WIDTH;
const PAGE_PAD = 40;
const CARD_X = PAGE_PAD;
const CARD_W = W - PAGE_PAD * 2;
const CARD_PAD = 32;
const INNER_X = CARD_X + CARD_PAD;
const INNER_R = CARD_X + CARD_W - CARD_PAD;
const PANEL_GAP = 22;

const FS = { title: 64, date: 64, subtitle: 26, panelTitle: 40, note: 24, name: 32, value: 32, detail: 26, small: 22, footer: 24 };

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

// ─── Panels ──────────────────────────────────────────────────────────────

interface Drawn {
  svg: string;
  height: number;
}

/** Card background + title + wrapped note; returns the y where the body starts. */
function panelHead(y: number, title: string, note: string | null): { svg: string[]; bodyY: number } {
  const svg: string[] = [];
  let cy = y + CARD_PAD + FS.panelTitle * 0.85;
  svg.push(text(INNER_X, cy, fitText(title, FS.panelTitle, INNER_R - INNER_X), { size: FS.panelTitle, fill: C.text, bold: true }));
  if (note) {
    for (const line of wrapText(note, FS.note, INNER_R - INNER_X, 2)) {
      cy += FS.note * 1.45;
      svg.push(text(INNER_X, cy, line, { size: FS.note, fill: C.muted }));
    }
  }
  return { svg, bodyY: cy + 24 };
}

function rankBadge(cx: number, cy: number, rank: number, medals: boolean): string {
  const medal = medals ? C.medal[rank - 1] : undefined;
  if (medal) {
    return (
      `<circle cx="${r(cx)}" cy="${r(cy)}" r="21" fill="${medal}"/>` +
      text(cx, cy + 10, String(rank), { size: 28, fill: C.rankText, anchor: 'middle', bold: true })
    );
  }
  return (
    `<circle cx="${r(cx)}" cy="${r(cy)}" r="20" fill="none" stroke="${C.grid}" stroke-width="2"/>` +
    text(cx, cy + 10, String(rank), { size: 28, fill: C.muted, anchor: 'middle' })
  );
}

/**
 * A board as horizontal bars from 0: rank badge, name, bar, value label at the
 * bar's end, optional muted detail on the right. `refLine` draws a dashed line
 * at that value (50% for win rates) when it is inside the axis.
 */
function barPanel(
  y: number,
  panel: WeeklyChartBarPanel,
  opts: { color: string; rowH: number; nameW: number; detailW: number; medals: boolean; refLine?: number; percentAxis?: boolean },
): Drawn {
  const head = panelHead(y, panel.title, panel.note);
  const svg = head.svg;
  let cy = head.bodyY;

  if (panel.rows.length === 0) {
    for (const line of wrapText(panel.emptyNote ?? '（目前沒有排行資料）', FS.detail, INNER_R - INNER_X, 3)) {
      cy += FS.detail * 1.5;
      svg.push(text(INNER_X, cy, line, { size: FS.detail, fill: C.muted }));
    }
    const height = cy + CARD_PAD - y;
    return { svg: rect(CARD_X, y, CARD_W, height, C.card, 24) + svg.join(''), height };
  }

  const badgeX = INNER_X + 24;
  const nameX = INNER_X + 62;
  const barX = nameX + opts.nameW + 16;
  const valueW = 112;
  const barMaxEnd = INNER_R - opts.detailW - valueW;
  const barSpan = Math.max(40, barMaxEnd - barX);
  const values = panel.rows.map((row) => (typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : 0));
  const maxValue = Math.max(0, ...values);
  const axisMax = opts.percentAxis ? Math.min(100, Math.max(10, Math.ceil(maxValue / 10) * 10)) : Math.max(maxValue, 1e-9);
  const scale = (v: number): number => (Math.max(0, Math.min(v, axisMax)) / axisMax) * barSpan;

  const top = cy;
  const bottom = cy + panel.rows.length * opts.rowH;
  if (opts.refLine !== undefined && opts.refLine > 0 && opts.refLine <= axisMax) {
    const rx = barX + scale(opts.refLine);
    svg.push(`<line x1="${r(rx)}" y1="${r(top - 4)}" x2="${r(rx)}" y2="${r(bottom)}" stroke="${C.grid}" stroke-width="2" stroke-dasharray="6 6"/>`);
    svg.push(text(rx, top - 10, `${opts.refLine}%`, { size: FS.small, fill: C.muted, anchor: 'middle' }));
  }
  // Baseline at 0.
  svg.push(`<line x1="${r(barX)}" y1="${r(top - 4)}" x2="${r(barX)}" y2="${r(bottom)}" stroke="${C.grid}" stroke-width="2"/>`);

  panel.rows.forEach((row, i) => {
    const rowTop = top + i * opts.rowH;
    const mid = rowTop + opts.rowH / 2;
    svg.push(rankBadge(badgeX, mid, row.rank, opts.medals));
    svg.push(text(nameX, mid + FS.name * 0.36, fitText(row.name, FS.name, opts.nameW), { size: FS.name, fill: C.text }));
    const barH = Math.min(36, opts.rowH - 28);
    const w = typeof row.value === 'number' && Number.isFinite(row.value) ? scale(row.value) : 0;
    if (w > 0) svg.push(rect(barX, mid - barH / 2, Math.max(w, 6), barH, opts.color, 6));
    svg.push(text(barX + Math.max(w, 0) + 12, mid + FS.value * 0.36, row.valueLabel, { size: FS.value, fill: C.text, bold: true }));
    if (row.detail) {
      svg.push(text(INNER_R, mid + FS.detail * 0.36, fitText(row.detail, FS.detail, opts.detailW - 8), { size: FS.detail, fill: C.muted, anchor: 'end' }));
    }
  });

  const height = bottom + CARD_PAD - 8 - y;
  return { svg: rect(CARD_X, y, CARD_W, height, C.card, 24) + svg.join(''), height };
}

/** Holders shown in a 角色王 cell before 「等 N 人」, however wide the cell. */
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

/** 角色王: a two-column grid of cells — role (muted), holders, rate. */
function roleKingsPanel(y: number, panel: NonNullable<WeeklyChartData['roleKings']>): Drawn {
  const head = panelHead(y, panel.title, panel.note);
  const svg = head.svg;
  const cols = 2;
  const gap = 16;
  const cellW = (INNER_R - INNER_X - gap * (cols - 1)) / cols;
  const cellH = 92;
  const top = head.bodyY - 4;
  panel.entries.forEach((e, i) => {
    const x = INNER_X + (i % cols) * (cellW + gap);
    const cy = top + Math.floor(i / cols) * (cellH + gap);
    svg.push(rect(x, cy, cellW, cellH, C.cell, 16));
    svg.push(text(x + 22, cy + 34, fitText(e.role || '—', FS.detail, cellW - 150), { size: FS.detail, fill: C.muted }));
    svg.push(text(x + cellW - 22, cy + 36, e.valueLabel, { size: FS.value, fill: C.text, anchor: 'end', bold: true }));
    svg.push(text(x + 22, cy + 76, fitNames(e.names, FS.name, cellW - 44), { size: FS.name, fill: C.text }));
  });
  const rows = Math.ceil(panel.entries.length / cols);
  const bottom = top + rows * cellH + Math.max(0, rows - 1) * gap;
  const height = bottom + CARD_PAD - y;
  return { svg: rect(CARD_X, y, CARD_W, height, C.card, 24) + svg.join(''), height };
}

// ─── Whole chart ─────────────────────────────────────────────────────────

/** The digest as one SVG document (WEEKLY_CHART_WIDTH wide, height as needed). */
export function buildWeeklyChartSvg(data: WeeklyChartData): string {
  const parts: string[] = [];

  // Header band.
  const headerH = data.subtitle ? 190 : 150;
  parts.push(rect(0, 0, W, headerH, C.header));
  const titleY = 98;
  const title = data.title || '每週排行';
  parts.push(text(PAGE_PAD + 8, titleY, title, { size: FS.title, fill: C.headerText, bold: true }));
  parts.push(
    text(PAGE_PAD + 8 + textWidth(title, FS.title) + 24, titleY, data.dateLabel, { size: FS.date, fill: C.accent, bold: true }),
  );
  if (data.subtitle) {
    parts.push(text(PAGE_PAD + 8, titleY + 54, fitText(data.subtitle, FS.subtitle, W - PAGE_PAD * 2 - 16), { size: FS.subtitle, fill: C.headerMuted }));
  }

  let y = headerH + PAGE_PAD - 8;
  const add = (d: Drawn): void => {
    parts.push(d.svg);
    y += d.height + PANEL_GAP;
  };

  // Order (owner 2026-11-10): 角色理論 → 位置理論 → 整體理論 → 進步榜 → 角色王 → 新人榜.
  const theory = { rowH: 62, nameW: 300, detailW: 0, medals: true, refLine: 50, percentAxis: true } as const;
  add(barPanel(y, data.main, { ...theory, color: C.main }));
  if (data.position && data.position.rows.length > 0) add(barPanel(y, data.position, { ...theory, color: C.position }));
  if (data.overall && data.overall.rows.length > 0) add(barPanel(y, data.overall, { ...theory, color: C.overall }));
  if (data.improved && data.improved.rows.length > 0) {
    add(barPanel(y, data.improved, { color: C.improved, rowH: 60, nameW: 260, detailW: 210, medals: false }));
  }
  if (data.roleKings && data.roleKings.entries.length > 0) add(roleKingsPanel(y, data.roleKings));
  if (data.newcomers && data.newcomers.rows.length > 0) {
    add(barPanel(y, data.newcomers, { color: C.newcomers, rowH: 60, nameW: 260, detailW: 130, medals: false, refLine: 50, percentAxis: true }));
  }

  // Footer.
  y += 4;
  for (const line of data.footerLines) {
    y += FS.footer * 1.2;
    parts.push(text(W / 2, y, fitText(line, FS.footer, W - PAGE_PAD * 2), { size: FS.footer, fill: C.muted, anchor: 'middle' }));
    y += 10;
  }
  y += FS.footer * 1.3;
  parts.push(text(W / 2, y, fitText(data.url, FS.footer + 2, W - PAGE_PAD * 2), { size: FS.footer + 2, fill: C.link, anchor: 'middle', bold: true }));
  const height = Math.ceil(y + PAGE_PAD);

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
