/**
 * Threads 每日出題（2026-11-17）— 貼文的圖：深色卡片（站長 11/17：「圖可以用你提供的格式 不過最好是深色版本 因為質感
 * 比較好 也有一致性」）。版面同原本的卡片：標題列（阿瓦隆每日一題、主題、題號）、你的視角、座位 1～0（你、拇指、看到的紅、
 * 隊友、自己湖到的）、五局的任務格（人數、結果）、到目前的牌譜、藍色的「輪到你…」、記號說明。
 *
 * 牌譜的記號跟百科的文字牌譜一樣（隊伍 內黑- 外白+，順序同網站 proposalLine），配色借站長以前 IG「每日一派」的：
 * 值得注意的票（+／-）綠色、任務結果黃色；任務失敗紅、成功藍綠。
 *
 * 只畫到出題那一刻：牌譜的列來自 sheetRows(pv)（= pv.shown，決定當下看得到的事件），之後的派票、任務、湖、角色都不在圖裡。
 * 公布完整答案的日子另外一張答案圖（同樣的深色卡片）：昨天那一局的角色，藍方一格、紅方一格（同 IG 答案頁）。
 *
 * 1080 寬（手機一屏），高度照牌譜行數；牌譜超過 22 行改兩欄，一張圖不拆——草稿和自動發文的 `image` 輸出維持一張。
 * SVG 用字型檔（和每週排行圖同一個 Noto Sans TC，assets/fonts/）在 @resvg/resvg-js 轉 PNG，不用瀏覽器也不用系統字型，
 * GitHub Actions 上也能跑。圖裡只有座位和牌譜記號，沒有玩家名字。
 */

import fs from 'fs';
import path from 'path';
import { WEEKLY_CHART_FONT_FAMILY, WEEKLY_CHART_FONT_FILE, escapeXml } from '../stats/weeklyChart';
import { ROLE_ZH } from '../simulation/commands';
import { resultText } from '../simulation/replies';
import { FAILS_REQUIRED, TEAM_SIZES, type PublicEvent } from '../simulation/scenario';
import { seatChar } from '../simulation/seats';
import type { PickView } from './draft';
import { labelFor } from './plan';

const W = 1080;
/** 深色卡片的配色（底色接近網站深色介面與 IG 截圖的黑）。 */
const C = {
  page: '#131316',
  ink: '#f4f4f5',
  soft: '#a1a1aa',
  faint: '#71717a',
  header: '#1f2a44',
  headerInk: '#ffffff',
  headerSoft: '#c9d4ea',
  blue: '#60a5fa', // 你、輪到你
  blueFill: '#1d3a6e',
  red: '#f87171', // 看到的紅、隊友、任務失敗
  redFill: '#5b1a1a',
  green: '#4ade80', // 記號 +／-、湖、任務成功
  greenFill: '#14402a',
  yellow: '#facc15', // 任務結果 ooox
  gold: '#fbbf24', // 拇指
  seat: '#1f1f24',
  line: '#3f3f46',
  card: '#1c1c21',
};

/** 一段一個顏色的文字（tspan）。 */
type Seg = { t: string; fill?: string; weight?: boolean };

function segs(x: number, y: number, parts: readonly Seg[], size: number, anchor: 'start' | 'middle' | 'end' = 'start'): string {
  const a = anchor !== 'start' ? ` text-anchor="${anchor}"` : '';
  const spans = parts.map((p) => {
    const stroke = p.weight ? ` stroke="${p.fill ?? C.ink}" stroke-width="${Math.max(0.7, size / 40)}"` : '';
    return `<tspan fill="${p.fill ?? C.ink}"${stroke}>${escapeXml(p.t)}</tspan>`;
  }).join('');
  return `<text x="${x}" y="${y}" font-size="${size}"${a}>${spans}</text>`;
}

function text(x: number, y: number, s: string, o: { size: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: boolean }): string {
  return segs(x, y, [{ t: s, fill: o.fill, weight: o.weight }], o.size, o.anchor);
}

function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
}

/** 阿瓦隆百科的標誌（packages/web/public/logo.png 的複本）：卡片背景的浮水印與標題列右邊的小圖示。 */
export const THREADS_LOGO_FILE = path.resolve(__dirname, '..', '..', '..', 'assets', 'threads', 'logo.png');
/** 浮水印的不透明度：看得出標誌，但不蓋過牌譜文字。 */
const WATERMARK_OPACITY = 0.1;

let logoUri: string | null | undefined;
function logoDataUri(): string | null {
  if (logoUri === undefined) logoUri = fs.existsSync(THREADS_LOGO_FILE) ? `data:image/png;base64,${fs.readFileSync(THREADS_LOGO_FILE).toString('base64')}` : null;
  return logoUri;
}

function svgDoc(height: number, body: string): string {
  const uri = logoDataUri();
  // 浮水印：大尺寸、置中在標題列以下的區域、圓角裁切，放在所有內容後面（站長 11/17：「我是希望背景帶有我們的"阿瓦隆百科"logo」）。
  const size = Math.min(W - 80, height - 150 - 80);
  const wx = (W - size) / 2;
  const wy = 150 + (height - 150 - size) / 2;
  const watermark = uri && size > 200
    ? `<defs><clipPath id="wm"><rect x="${wx}" y="${wy}" width="${size}" height="${size}" rx="${size / 10}"/></clipPath></defs>` +
      `<image href="${uri}" x="${wx}" y="${wy}" width="${size}" height="${size}" opacity="${WATERMARK_OPACITY}" clip-path="url(#wm)" preserveAspectRatio="xMidYMid slice"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${WEEKLY_CHART_FONT_FAMILY}">` +
    rect(0, 0, W, height, C.page) + watermark + body + '</svg>'
  );
}

/** 標題列：阿瓦隆每日一題、副標、右邊的小標誌與題號。 */
function headerBand(sub: string, id: string): string {
  const uri = logoDataUri();
  const icon = uri
    ? `<defs><clipPath id="hl"><rect x="${W - 40 - 102}" y="24" width="102" height="102" rx="18"/></clipPath></defs>` +
      `<image href="${uri}" x="${W - 40 - 102}" y="24" width="102" height="102" clip-path="url(#hl)"/>`
    : '';
  const idX = uri ? W - 40 - 102 - 24 : W - 40;
  return rect(0, 0, W, 150, C.header) + icon +
    text(40, 64, '阿瓦隆每日一題', { size: 40, fill: C.headerInk, weight: true }) +
    text(40, 118, sub, { size: 32, fill: C.headerSoft }) +
    text(idX, 118, id, { size: 28, fill: C.headerSoft, anchor: 'end' });
}

/** 估一行字的寬度（中文字約一個字級寬，英數約 0.56）。 */
export function textWidth(line: string, size: number): number {
  let w = 0;
  for (const ch of line) w += (ch.codePointAt(0) ?? 0) <= 0x24f ? size * 0.56 : size;
  return w;
}

/** 斷行後第二段的縮排（全形空白）。 */
const INDENT = '　';

/** 太寬的行在「，」或「（」前面斷開，第二段縮排。 */
export function wrapLine(line: string, size: number, max: number): string[] {
  if (textWidth(line, size) <= max) return [line];
  const chars = [...line];
  let cut = -1;
  for (let i = 1; i < chars.length; i++) {
    if ((chars[i] === '，' || chars[i] === '（') && textWidth(chars.slice(0, i + (chars[i] === '，' ? 1 : 0)).join(''), size) <= max) cut = chars[i] === '，' ? i + 1 : i;
  }
  if (cut <= 0) {
    // 沒有標點可斷：照寬度硬斷。
    cut = chars.length;
    while (cut > 1 && textWidth(chars.slice(0, cut).join(''), size) > max) cut--;
  }
  const rest = chars.slice(cut).join('');
  return [chars.slice(0, cut).join(''), ...wrapLine(`${INDENT}${rest}`, size, max)];
}

/** 一行字放不下時縮小字級（最小 min）。 */
function fitSize(line: string, size: number, max: number, min = 14): number {
  let s = size;
  while (s > min && textWidth(line, s) > max) s -= 1;
  return s;
}

// ─── 牌譜的列（純資料，測試直接檢查這裡：只會有出題當下看得到的東西） ──────────────

export type VoteCell = 'approve' | 'reject' | 'none';

export type SheetRow =
  | {
    kind: 'proposal';
    /** proposals[] 的索引。 */
    index: number;
    round: number;
    attempt: number;
    leaderSeat: number;
    team: number[];
    /** 座位 1～10 的票；強制局與票沒記全的提議是 none。 */
    votes: VoteCell[];
    approves: number | null;
    forced: boolean;
    approved: boolean;
    reliable: boolean;
    /** DC 格式：隊伍 內黑- 外白+（例：4789 8- 36+）。 */
    line: string;
  }
  | { kind: 'quest'; round: number; mission: string; failCount: number; failed: boolean }
  /** claim：o = 宣告藍、x = 宣告紅、空字串 = 沒寫宣告（同 DC 牌譜的 0>3 x）。 */
  | { kind: 'lake'; round: number; holderSeat: number; targetSeat: number; claim: 'o' | 'x' | '' }
  | { kind: 'decision'; round: number | null; attempt: number | null; leaderSeat: number; size: number | null; forced: boolean };

function seatsText(seats: readonly number[]): string {
  return seats.map(seatChar).join('');
}

function proposalRow(e: Extract<PublicEvent, { kind: 'proposal' }>): SheetRow {
  const team = new Set(e.teamSeats);
  const plus = new Set(e.plusSeats);
  const minus = new Set(e.minusSeats);
  const reliable = e.votesReliable;
  const votes: VoteCell[] = [];
  let approves = 0;
  for (let seat = 1; seat <= 10; seat++) {
    const yes = team.has(seat) ? !minus.has(seat) : plus.has(seat);
    if (yes) approves++;
    votes.push(e.forced || !reliable ? 'none' : yes ? 'approve' : 'reject');
  }
  const line = [seatsText(e.teamSeats), e.minusSeats.length ? `${seatsText(e.minusSeats)}-` : '', e.plusSeats.length ? `${seatsText(e.plusSeats)}+` : '']
    .filter(Boolean).join(' ');
  return {
    kind: 'proposal', index: e.index, round: e.round, attempt: e.attempt, leaderSeat: e.leaderSeat, team: [...e.teamSeats], votes,
    approves: e.forced || !reliable ? null : approves, forced: e.forced, approved: e.approved, reliable, line,
  };
}

/** 圖上矩陣的列：pv.shown 的每個事件一列，最後加「輪到你」。 */
export function sheetRows(pv: PickView): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const e of pv.shown) {
    if (e.kind === 'proposal') rows.push(proposalRow(e));
    else if (e.kind === 'quest') rows.push({ kind: 'quest', round: e.round, mission: `${'o'.repeat(e.successCount)}${'x'.repeat(e.failCount)}`, failCount: e.failCount, failed: e.failed });
    else rows.push({ kind: 'lake', round: e.round, holderSeat: e.holderSeat, targetSeat: e.targetSeat, claim: e.claim === 'good' ? 'o' : e.claim === 'evil' ? 'x' : '' });
  }
  if (pv.pick.proposal === null) rows.push({ kind: 'decision', round: null, attempt: null, leaderSeat: pv.pick.seat, size: null, forced: false });
  else {
    const p = pv.game.proposals[pv.pick.proposal];
    rows.push({ kind: 'decision', round: p.round, attempt: p.attempt, leaderSeat: pv.pick.seat, size: TEAM_SIZES[p.round - 1], forced: p.attempt === 5 });
  }
  return rows;
}

// ─── 題目卡 ──────────────────────────────────────────────────────────────

/** 每個座位的標記：你、拇指、看到的紅、隊友、自己湖到的。 */
function seatMarks(pv: PickView): Map<number, { label: string; color: string }> {
  const marks = new Map<number, { label: string; color: string }>();
  const s = pv.view.sight;
  if (s.kind === 'percival') s.thumbs.forEach((t) => marks.set(t, { label: '拇指', color: C.gold }));
  if (s.kind === 'merlin') s.seen.forEach((t) => marks.set(t, { label: '紅', color: C.red }));
  if (s.kind === 'evil') s.mates.forEach((t) => marks.set(t, { label: '隊友', color: C.red }));
  // 自己湖到的：已經有標記（隊友、看到的紅、拇指）的座位不蓋掉。
  for (const l of pv.view.ownLakes) {
    if (!marks.has(l.targetSeat)) marks.set(l.targetSeat, { label: l.evil ? '湖到紅' : '湖到好', color: l.evil ? C.red : C.green });
  }
  marks.set(pv.pick.seat, { label: '你', color: C.blue });
  return marks;
}

function missionBoxes(rows: readonly SheetRow[], y: number): string {
  const parts: string[] = [];
  const bw = 180;
  const gap = (W - 80 - bw * 5) / 4;
  for (let r = 1; r <= 5; r++) {
    const x = 40 + (r - 1) * (bw + gap);
    const q = rows.find((e): e is Extract<SheetRow, { kind: 'quest' }> => e.kind === 'quest' && e.round === r);
    const fill = q ? (q.failed ? C.redFill : C.greenFill) : C.seat;
    const stroke = q ? (q.failed ? C.red : C.green) : C.line;
    parts.push(rect(x, y, bw, 96, fill, ` rx="16" stroke="${stroke}" stroke-width="2"`));
    parts.push(text(x + bw / 2, y + 38, `第 ${r} 局・${TEAM_SIZES[r - 1]} 人`, { size: 26, fill: q ? C.ink : C.soft, anchor: 'middle' }));
    if (q) parts.push(text(x + bw / 2, y + 80, q.mission, { size: 30, fill: C.yellow, anchor: 'middle', weight: true }));
    else if (FAILS_REQUIRED[r - 1] > 1) parts.push(text(x + bw / 2, y + 78, '要 2 張失敗', { size: 26, fill: C.faint, anchor: 'middle' }));
  }
  return parts.join('');
}

const CLAIM_LINE: Record<string, string> = { o: '說好人（o）', x: '說壞人（x）', '': '沒說' };

/** 牌譜的一行（跟文字貼文同一種寫法），一段一個顏色：隊長＋隊伍白、記號綠、任務結果黃、湖綠。 */
export function recordLines(rows: readonly SheetRow[]): Seg[][] {
  const out: Seg[][] = [];
  let round = 0;
  for (const r of rows) {
    if (r.kind === 'decision') continue;
    if (r.kind === 'proposal' && r.round !== round) {
      round = r.round;
      out.push([{ t: `第 ${round} 局：`, fill: C.soft, weight: true }]);
    }
    if (r.kind === 'proposal') {
      const [team, ...marks] = r.line.split(' ');
      const line: Seg[] = [{ t: `${seatChar(r.leaderSeat)}家 ${team}` }];
      if (marks.length) line.push({ t: ` ${marks.join(' ')}`, fill: C.green, weight: true });
      if (r.forced) line.push({ t: `（第 ${r.attempt} 次，強制出發）`, fill: C.faint });
      out.push(line);
    } else if (r.kind === 'quest') {
      out.push([
        { t: '任務：' },
        { t: r.mission, fill: C.yellow, weight: true },
        { t: r.failed ? `，${r.failCount} 張失敗 → 任務失敗` : r.failCount ? `，${r.failCount} 張失敗 → 任務成功` : ' → 任務成功', fill: r.failed ? C.red : C.green },
      ]);
    } else {
      out.push([{ t: `湖：${seatChar(r.holderSeat)}家 湖 ${seatChar(r.targetSeat)}家，${CLAIM_LINE[r.claim]}`, fill: C.green }]);
    }
  }
  return out;
}

/** 題目圖的 SVG（weekday = 今天的星期，決定標題）。 */
export function buildPuzzleSvg(pv: PickView, weekday: number): string {
  const role = pv.game.seatRoles[pv.pick.seat - 1];
  const rows = sheetRows(pv);
  const parts: string[] = [headerBand(labelFor(weekday, pv.pick), pv.exerciseId)];
  let y = 150;

  // 你的視角
  y += 64;
  parts.push(text(40, y, `你是 ${seatChar(pv.pick.seat)}家・${ROLE_ZH[role]}`, { size: 38, weight: true }));
  const s = pv.view.sight;
  const info = s.kind === 'percival' ? `拇指 ${s.thumbs.map(seatChar).join(' ')}（梅林、莫甘娜各一）`
    : s.kind === 'merlin' ? `看到的紅 ${s.seen.map(seatChar).join(' ')}（莫德雷德看不到）`
      : s.kind === 'evil' ? `隊友 ${s.mates.map(seatChar).join(' ')}` : s.kind === 'oberon' ? '不知道隊友' : '沒有額外資訊';
  y += 50;
  parts.push(text(40, y, info, { size: 30, fill: C.soft }));

  // 座位
  y += 40;
  const marks = seatMarks(pv);
  const cw = (W - 80) / 10;
  for (let seat = 1; seat <= 10; seat++) {
    const cx = 40 + cw * (seat - 1) + cw / 2;
    const cy = y + 52;
    const m = marks.get(seat);
    const me = seat === pv.pick.seat;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="40" fill="${me ? C.blueFill : C.seat}" stroke="${m ? m.color : C.line}" stroke-width="${m ? 6 : 2}"/>`);
    parts.push(text(cx, cy + 14, seatChar(seat), { size: 40, anchor: 'middle', weight: true }));
    if (m) parts.push(text(cx, cy + 82, m.label, { size: 24, fill: m.color, anchor: 'middle' }));
  }
  y += 150;

  // 任務
  parts.push(missionBoxes(rows, y));
  y += 130;

  // 牌譜
  const raw = recordLines(rows);
  const lines = raw.length ? raw : [[{ t: '第 1 局第一個隊長，前面沒有派票', fill: C.soft }]];
  const twoCols = lines.length > 22;
  const size = twoCols ? 26 : 30;
  const lh = twoCols ? 40 : 44;
  const perCol = twoCols ? Math.ceil(lines.length / 2) : lines.length;
  parts.push(`<line x1="40" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  y += 50;
  lines.forEach((line, i) => {
    const col = twoCols && i >= perCol ? 1 : 0;
    const row = col ? i - perCol : i;
    const width = textWidth(line.map((p) => p.t).join(''), size);
    const max = twoCols ? W / 2 - 60 : W - 80;
    parts.push(segs(40 + col * (W / 2), y + row * lh, line, width > max ? fitSize(line.map((p) => p.t).join(''), size, max) : size));
  });
  y += perCol * lh + 20;

  // 輪到你
  parts.push(`<line x1="40" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  y += 64;
  const last = rows[rows.length - 1];
  const prompt = last.kind === 'decision' && last.round !== null
    ? `輪到你派 ${last.size} 人（第 ${last.round} 局第 ${last.attempt} 次${last.forced ? '，強制出發' : ''}）`
    : '三藍：輪到你刺殺。誰是梅林？';
  parts.push(text(40, y, prompt, { size: 36, fill: C.blue, weight: true }));
  y += 56;
  parts.push(text(40, y, '記號：+ 隊外投贊成、- 隊內投反對；o 成功、x 失敗；0 家寫 0', { size: 24, fill: C.faint }));
  y += 40;
  parts.push(text(40, y, '實戰牌譜｜阿瓦隆百科 avalon-game-platform.web.app', { size: 24, fill: C.faint }));
  y += 40;

  return svgDoc(y, parts.join(''));
}

// ─── 答案卡 ──────────────────────────────────────────────────────────────

/** 答案圖：昨天那一局的角色，藍方（派西維爾、梅林）一格、紅方一格；ids = 這一局這幾天出過的題號。 */
export function buildAnswerSvg(pv: PickView, ids: readonly string[] = [pv.exerciseId]): string {
  const roles = pv.game.seatRoles;
  const seatOf = (role: string): number[] => roles.flatMap((r, i) => (r === role ? [i + 1] : []));
  const blue = (['percival', 'merlin'] as const).flatMap((r) => seatOf(r).map((s) => `${ROLE_ZH[r]}：${seatChar(s)} 家`));
  const red = (['assassin', 'morgana', 'mordred', 'oberon', 'minion'] as const).flatMap((r) => seatOf(r).map((s) => `${ROLE_ZH[r]}：${seatChar(s)} 家`));
  const parts: string[] = [headerBand('昨天的答案', ids.join('、'))];
  let y = 150 + 50;
  const box = (title: string, items: string[], fill: string, ink: string): void => {
    const lh = 70;
    const h = 70 + items.length * lh + 20;
    parts.push(rect(40, y, W - 80, h, fill, ` rx="18" fill-opacity="0.8" stroke="${ink}" stroke-width="2"`));
    parts.push(text(76, y + 54, title, { size: 28, fill: ink }));
    items.forEach((it, i) => parts.push(text(76, y + 70 + lh * (i + 1) - 14, it, { size: 50, fill: C.ink, weight: true })));
    y += h + 30;
  };
  box('藍方', blue, C.blueFill, C.blue);
  box('紅方', red, C.redFill, C.red);
  y += 30;
  parts.push(text(40, y, `結果：${resultText(pv.game)}`, { size: 34, fill: C.yellow, weight: true }));
  y += 56;
  parts.push(text(40, y, '其他座位是忠臣｜實戰牌譜｜阿瓦隆百科 avalon-game-platform.web.app', { size: 24, fill: C.faint }));
  y += 40;
  return svgDoc(y, parts.join(''));
}

/** SVG → PNG（只用內附的字型）。字型檔或原生套件不在時丟錯，呼叫端改成不附圖。 */
function svgToPng(svg: string, fontFile: string): Buffer {
  if (!fs.existsSync(fontFile)) throw new Error(`threads image font missing: ${fontFile}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: WEEKLY_CHART_FONT_FAMILY },
    background: C.page,
  });
  return resvg.render().asPng();
}

/** 題目圖 PNG。 */
export function renderPuzzlePng(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer {
  return svgToPng(buildPuzzleSvg(pv, weekday), opts.fontFile ?? WEEKLY_CHART_FONT_FILE);
}

/** 答案圖 PNG（公布完整答案的日子才附）。 */
export function renderAnswerPng(pv: PickView, ids?: readonly string[], opts: { fontFile?: string } = {}): Buffer {
  return svgToPng(buildAnswerSvg(pv, ids), opts.fontFile ?? WEEKLY_CHART_FONT_FILE);
}
