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
 * 站長 11/17 第二輪：「我希望順便呈現牌譜的視覺化版本」「拇指金圈圈蠻好的 只是我希望能夠像圍著圈圈 (圓桌武士) 的方式呈現 座位」
 * 「腳色順序應該是 刺娜德奧派梅」；第三輪（看過圓桌的樣張）：「我希望 5/0 在六點鐘跟十二點鐘方向 然後縮小一點 跟題目在同一張圖
 * 一起出現」→ 題目卡 = 標題列＋左上小圓桌（0 在十二點、順時針、5 在六點；桌面中間五局任務格）＋右上你的視角＋網站牌譜頁的格子
 * （列 = 每次提議、欄 = 座位 1～0、金色盾牌 = 上隊、白／黑格 = 贊成／反對、任務列、湖中列、右邊結果與文字紀錄，文字裡值得注意的票
 * 綠色）＋題目那一行，同一張，一般局 ≤ 1080×1350（Threads 手機 4:5）。牌譜太長時先縮列高（最小 30），還放不下才把後面的列畫在
 * 後面的續圖（草稿 `gridImages`，只有這時候才有；站長 11/18：「發文如果圖會太長/太大, 就分成多張圖啊」→ 要幾張就分幾張，
 * 每張都在 1350 以內，每張寫「牌譜接下一張（往右滑）｜第幾張／共幾張」）。答案卡紅方在上、藍方在下。
 * 站長 11/18：「小圓桌能不能和阿瓦隆百科的logo結合?」看過樣張選 A（標誌含字、不透明度 0.3），並且「1~5 & 6~0 改成 只圍繞 logo
 * 剩下的資訊呈現在旁邊, 還有湖中女神以箭頭 (0 > 9 + 宣告結果) 呈現」→ 小圓桌只剩十個座位圍著中間的標誌，五局任務格移到右邊
 * 「你的視角」下面，湖中女神畫成座位之間的箭頭（拿湖的 → 被驗的，旁邊寫宣告；自己湖的另外寫看到的）。題目卡不另外鋪大浮水印。
 *
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

function svgDoc(height: number, body: string, opts: { watermark?: boolean } = {}): string {
  const uri = opts.watermark === false ? null : logoDataUri();
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

/** none = 強制局（不投票）；unknown = 票沒記錄或記得不可靠（跟強制局分開畫，圖例另列）。 */
export type VoteCell = 'approve' | 'reject' | 'none' | 'unknown';

export type SheetRow =
  | {
    kind: 'proposal';
    /** proposals[] 的索引。 */
    index: number;
    round: number;
    attempt: number;
    leaderSeat: number;
    team: number[];
    /** 座位 1～10 的票；強制局是 none，票沒記全的提議是 unknown。 */
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
  /** seen：只有出題的人自己拿湖時才有，是他私下看到的結果（紅／好人）；別人的湖不放。 */
  | { kind: 'lake'; round: number; holderSeat: number; targetSeat: number; claim: 'o' | 'x' | ''; seen?: 'red' | 'good' }
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
    votes.push(e.forced ? 'none' : !reliable ? 'unknown' : yes ? 'approve' : 'reject');
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
    else {
      const claim = e.claim === 'good' ? 'o' : e.claim === 'evil' ? 'x' : '';
      // 你自己湖的：你私下看到的結果照畫（不管那個座位有沒有拇指、隊友、看到的紅的標記）。
      const own = e.holderSeat === pv.pick.seat ? pv.view.ownLakes.find((l) => l.targetSeat === e.targetSeat) : undefined;
      rows.push({ kind: 'lake', round: e.round, holderSeat: e.holderSeat, targetSeat: e.targetSeat, claim, ...(own ? { seen: own.evil ? 'red' : 'good' } : {}) });
    }
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

const CLAIM_LINE: Record<string, string> = { o: '說好人（o）', x: '說壞人（x）', '': '沒說' };
const SEEN_ZH = { red: '紅', good: '好人' } as const;

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
      out.push([{ t: `湖：${seatChar(r.holderSeat)}家 湖 ${seatChar(r.targetSeat)}家，${CLAIM_LINE[r.claim]}${r.seen ? `（你看到的：${SEEN_ZH[r.seen]}）` : ''}`, fill: C.green }]);
    }
  }
  return out;
}

// ─── 小圓桌（題目卡左上） ────────────────────────────────────────────────────

/**
 * 座位圍著圓桌（站長 11/17「像圍著圈圈 (圓桌武士) 的方式呈現 座位」；第二輪「我希望 5/0 在六點鐘跟十二點鐘方向 然後縮小一點
 * 跟題目在同一張圖一起出現」）：0 在正上方（十二點）、順時針 1 2 3 4 沿右邊往下、5 在正下方（六點）、6 7 8 9 沿左邊往上。
 */
const TABLE_RX = 178;
/** 圓桌中間標誌的不透明度（站長 11/18 選 A：0.3）：看得出是阿瓦隆百科，但不搶湖的箭頭和座位標記。 */
const TABLE_LOGO_OPACITY = 0.3;
const TABLE_RY = 98;
const SEAT_R = 30;
const RING_RX = TABLE_RX + 54;
const RING_RY = TABLE_RY + 50;
/** 小圓桌那一塊的寬高（含座位外側的標記字）。 */
const TABLE_BOX_W = 2 * (RING_RX + SEAT_R) + 20;
const TABLE_BOX_H = 2 * (RING_RY + SEAT_R) + 52;

/** 座位 seat（1～10，10 = 0 家）在圓桌上的位置：0 在正上方、順時針，5 在正下方。 */
export function seatPosition(seat: number, cx: number, cy: number): { x: number; y: number; ux: number; uy: number } {
  const k = seat % 10;
  const a = -Math.PI / 2 + (k * 2 * Math.PI) / 10;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  return { x: cx + RING_RX * ux, y: cy + RING_RY * uy, ux, uy };
}

/**
 * 五局任務格（人數、已出的任務結果、第 4 局要 2 張失敗），放在題目卡右邊「你的視角」下面（站長 11/18：任務格移出圓桌）。
 * 從 (x0, y0) 往右排，寬度不夠就換行；回傳 SVG 與佔的高度。
 */
export function missionChips(rows: readonly SheetRow[], x0: number, y0: number, maxW: number): { svg: string; height: number } {
  const parts: string[] = [];
  const bw = 78;
  const bh = 70;
  const gap = 8;
  const perRow = Math.max(1, Math.min(5, Math.floor((maxW + gap) / (bw + gap))));
  for (let r = 1; r <= 5; r++) {
    const i = r - 1;
    const x = x0 + (i % perRow) * (bw + gap);
    const y = y0 + Math.floor(i / perRow) * (bh + gap);
    const q = rows.find((e): e is Extract<SheetRow, { kind: 'quest' }> => e.kind === 'quest' && e.round === r);
    const fill = q ? (q.failed ? C.redFill : C.blueFill) : C.seat;
    const stroke = q ? (q.failed ? C.red : C.blue) : C.line;
    parts.push(rect(x, y, bw, bh, fill, ` rx="10" stroke="${stroke}" stroke-width="2"`));
    parts.push(text(x + bw / 2, y + 27, `${r}・${TEAM_SIZES[r - 1]}`, { size: 19, fill: q ? C.ink : C.soft, anchor: 'middle' }));
    if (q) parts.push(text(x + bw / 2, y + 57, q.mission, { size: q.mission.length > 4 ? 17 : 20, fill: C.yellow, anchor: 'middle', weight: true }));
    else if (FAILS_REQUIRED[r - 1] > 1) parts.push(text(x + bw / 2, y + 55, '2失敗', { size: 15, fill: C.faint, anchor: 'middle' }));
  }
  const lines = Math.ceil(5 / perRow);
  return { svg: parts.join(''), height: lines * bh + (lines - 1) * gap };
}

const LAKE_COLOR = '#22d3ee';
const CIRCLED = ['①', '②', '③', '④', '⑤'];

/**
 * 湖中女神畫成座位之間的箭頭（站長 11/18：「湖中女神以箭頭 (0 > 9 + 宣告結果) 呈現」）：拿湖的人 → 被驗的人，
 * 往圓心彎的弧線（不壓到座位外側的標記字），箭頭旁寫宣告（o 藍、x 紅、沒說）；你自己湖的另外寫你看到的。
 * 好幾次湖就好幾支箭頭，彎的程度錯開、標上 ① ② ③。只畫出題那一刻以前的湖（rows 來自 sheetRows）。
 */
export function lakeArrows(rows: readonly SheetRow[], cx: number, cy: number): string {
  const lakes = rows.filter((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
  if (lakes.length === 0) return '';
  const parts: string[] = [
    `<defs><marker id="la" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${LAKE_COLOR}"/></marker></defs>`,
  ];
  const norm = (dx: number, dy: number): [number, number] => {
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const placed: { x: number; y: number; w: number }[] = [];
  lakes.forEach((l, i) => {
    const a = seatPosition(l.holderSeat, cx, cy);
    const b = seatPosition(l.targetSeat, cx, cy);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // 控制點往圓心拉；幾乎對穿圓心的就往旁邊推，好幾支箭頭錯開
    // 相鄰的座位弦很短：往圓心拉深一點，弧線才看得出來
    const pull = Math.min(0.95, (Math.hypot(b.x - a.x, b.y - a.y) < 220 ? 0.85 : 0.6) + 0.08 * i);
    let qx = mx + (cx - mx) * pull;
    let qy = my + (cy - my) * pull;
    const [px, py] = norm(-(b.y - a.y), b.x - a.x);
    const side = Math.hypot(cx - mx, cy - my) < 30 ? 40 + 26 * i : 14 * i;
    qx += px * side;
    qy += py * side;
    const [sx, sy] = norm(qx - a.x, qy - a.y);
    const [ex, ey] = norm(qx - b.x, qy - b.y);
    const x1 = a.x + sx * (SEAT_R + 4);
    const y1 = a.y + sy * (SEAT_R + 4);
    const x2 = b.x + ex * (SEAT_R + 9);
    const y2 = b.y + ey * (SEAT_R + 9);
    parts.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${LAKE_COLOR}" stroke-width="3" stroke-opacity="0.9" marker-end="url(#la)" class="lake-arrow"/>`);
    const claim: Seg = l.claim === 'o' ? { t: 'o', fill: '#93c5fd', weight: true } : l.claim === 'x' ? { t: 'x', fill: C.red, weight: true } : { t: '沒說', fill: C.soft };
    const segsL: Seg[] = [...(lakes.length > 1 ? [{ t: CIRCLED[i] ?? `${i + 1}.`, fill: LAKE_COLOR }] : []), claim];
    if (l.seen) segsL.push({ t: `（看到${l.seen === 'red' ? '紅' : '好'}）`, fill: l.seen === 'red' ? C.red : C.green });
    const label = segsL.map((g) => g.t).join('');
    const w = textWidth(label, 20) + 12;
    // 標籤放在弧線上靠箭頭那一端（宣告結果寫在箭頭旁），跟前面的標籤疊到就沿著弧線挪
    const at = (t: number): [number, number] => [(1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * qx + t * t * x2, (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * qy + t * t * y2];
    const overlaps = (x: number, y: number): boolean => placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < 32);
    let [lx, ly] = at(0.78);
    for (const t of [0.78, 0.62, 0.5, 0.88, 0.38]) {
      const [x, y] = at(t);
      if (!overlaps(x, y)) {
        [lx, ly] = [x, y];
        break;
      }
    }
    placed.push({ x: lx, y: ly, w });
    parts.push(rect(lx - w / 2, ly - 15, w, 28, C.page, ' rx="8" fill-opacity="0.85"'));
    parts.push(segs(lx, ly + 7, segsL, 20, 'middle'));
  });
  return parts.join('');
}

/**
 * 小圓桌：十個座位圍著中間的阿瓦隆百科標誌（站長 11/18 選 A：標誌含字、不透明度 0.3；「1~5 & 6~0 改成 只圍繞 logo」），
 * 湖中女神的箭頭畫在座位之間，座位標記（你、拇指、看到的紅、隊友、湖到的）在座位外側。任務格在右邊。
 */
function roundTable(pv: PickView, rows: readonly SheetRow[], cx: number, cy: number): string {
  const uri = logoDataUri();
  const r = RING_RY - SEAT_R - 14;
  const logo = uri
    ? `<defs><clipPath id="tl"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>` +
      `<image href="${uri}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" opacity="${TABLE_LOGO_OPACITY}" clip-path="url(#tl)" preserveAspectRatio="xMidYMid slice"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.gold}" stroke-opacity="0.3" stroke-width="2"/>`
    : '';
  const parts: string[] = [
    // 座位排成的圈（淡淡的導引線）
    `<ellipse cx="${cx}" cy="${cy}" rx="${RING_RX}" ry="${RING_RY}" fill="none" stroke="${C.gold}" stroke-opacity="0.18" stroke-width="2"/>`,
    logo,
    lakeArrows(rows, cx, cy),
  ];
  const marks = seatMarks(pv);
  for (let seat = 1; seat <= 10; seat++) {
    const { x, y, ux, uy } = seatPosition(seat, cx, cy);
    const m = marks.get(seat);
    const me = seat === pv.pick.seat;
    parts.push(`<circle cx="${x}" cy="${y}" r="${SEAT_R}" fill="${me ? C.blueFill : C.seat}" stroke="${m ? m.color : C.line}" stroke-width="${m ? 5 : 2}"/>`);
    parts.push(text(x, y + 10, seatChar(seat), { size: 28, anchor: 'middle', weight: true }));
    if (m) {
      // 標記字放在座位外側：上半圈在上面、下半圈在下面、左右兩邊在外側。
      const side = Math.abs(uy) < 0.45;
      const lx = side ? x + ux * (SEAT_R + 30) : x;
      const ly = side ? y + 7 : uy < 0 ? y - SEAT_R - 8 : y + SEAT_R + 22;
      parts.push(text(lx, ly, m.label, { size: 18, fill: m.color, anchor: 'middle' }));
    }
  }
  return parts.join('');
}

// ─── 牌譜格子（網站牌譜頁） ──────────────────────────────────────────────────

/** 盾牌（上隊）：24×24 的路徑，跟網站的 ShieldIcon 同一種形狀。 */
function shield(cx: number, cy: number, size: number): string {
  const k = size / 24;
  const tx = cx - 12 * k;
  const ty = cy - 12 * k;
  return `<path transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(3)})" d="M12 2 L20 5 V11 C20 16.5 16.5 20.5 12 22 C7.5 20.5 4 16.5 4 11 V5 Z" fill="#facc15" stroke="#1c1917" stroke-width="1.2"/>`;
}

/** 圖的高度上限（Threads 手機 4:5）。 */
export const GRID_TARGET_H = 1350;
/** 格子的列高範圍：放不下時先縮列高，縮到最小還放不下才把後面的列移到第二張圖。 */
export const GRID_ROW_MAX = 52;
export const GRID_ROW_MIN = 30;

const GX0 = 40;
const LEAD_W = 60;
const RES_W = 96;
const TEXT_W = 214;
const SEAT_W = (W - 80 - LEAD_W - RES_W - TEXT_W) / 10;
const seatX = (seat: number): number => GX0 + LEAD_W + SEAT_W * (seat - 1);
const RES_X = GX0 + LEAD_W + SEAT_W * 10;
const TEXT_X = RES_X + RES_W;
const GRID_HEAD_H = 50;

/** 格子的欄名：隊長、1～0（你藍、拇指金、看到的紅／隊友紅）、結果、文字紀錄。 */
function gridHead(pv: PickView, y: number): string {
  const parts: string[] = [];
  const marks = seatMarks(pv);
  const hy = y + 32;
  parts.push(text(GX0 + LEAD_W / 2, hy, '隊長', { size: 20, fill: C.faint, anchor: 'middle' }));
  for (let seat = 1; seat <= 10; seat++) {
    const m = marks.get(seat);
    const cx = seatX(seat) + SEAT_W / 2;
    if (m) parts.push(`<circle cx="${cx}" cy="${hy - 8}" r="20" fill="${seat === pv.pick.seat ? C.blueFill : 'none'}" stroke="${m.color}" stroke-width="3"/>`);
    parts.push(text(cx, hy, seatChar(seat), { size: 24, fill: m ? m.color : C.ink, anchor: 'middle', weight: true }));
  }
  parts.push(text(RES_X + RES_W / 2, hy, '結果', { size: 20, fill: C.faint, anchor: 'middle' }));
  parts.push(text(TEXT_X + 12, hy, '文字紀錄', { size: 20, fill: C.faint }));
  parts.push(`<line x1="${GX0}" y1="${y + GRID_HEAD_H}" x2="${W - 40}" y2="${y + GRID_HEAD_H}" stroke="${C.line}" stroke-width="2"/>`);
  return parts.join('');
}

/** 格子的一列（提議、任務、湖、輪到你）。 */
function gridRow(r: SheetRow, y: number, rh: number): string {
  const parts: string[] = [];
  const fs = Math.max(16, Math.min(24, Math.round(rh * 0.52)));
  const mid = y + rh / 2 + fs * 0.36;
  if (r.kind === 'proposal') {
    parts.push(rect(GX0, y, LEAD_W, rh, '#09090b'));
    parts.push(text(GX0 + LEAD_W / 2, mid, seatChar(r.leaderSeat), { size: fs, fill: '#facc15', anchor: 'middle', weight: true }));
    for (let seat = 1; seat <= 10; seat++) {
      const v = r.votes[seat - 1];
      const fill = v === 'approve' ? '#ffffff' : v === 'reject' ? '#000000' : v === 'unknown' ? UNKNOWN_VOTE_FILL : '#18181b';
      parts.push(rect(seatX(seat), y, SEAT_W, rh, fill, ' stroke="#27272a" stroke-width="1"'));
      if (v === 'unknown' && !r.team.includes(seat)) parts.push(text(seatX(seat) + SEAT_W / 2, mid, '？', { size: fs - 2, fill: '#d4d4d8', anchor: 'middle' }));
      if (r.team.includes(seat)) parts.push(shield(seatX(seat) + SEAT_W / 2, y + rh / 2, Math.min(SEAT_W, rh) - 6));
    }
    const res = r.forced ? '強制' : r.approves === null ? '—' : `${r.approves}票${r.approved ? '過' : ''}`;
    parts.push(text(RES_X + RES_W / 2, mid, res, { size: fs - 2, fill: r.forced ? '#fcd34d' : r.approved ? '#6ee7b7' : C.faint, anchor: 'middle' }));
    const [team, ...rest] = r.line.split(' ');
    const seg: Seg[] = [{ t: team }];
    if (rest.length) seg.push({ t: ` ${rest.join(' ')}`, fill: C.green, weight: true });
    parts.push(segs(TEXT_X + 12, mid, seg, fitSize(r.line, fs, TEXT_W - 16)));
  } else if (r.kind === 'quest') {
    parts.push(rect(GX0, y, W - 80, rh, '#422006', ' fill-opacity="0.75"'));
    parts.push(rect(GX0, y, LEAD_W, rh, '#713f12'));
    parts.push(text(GX0 + LEAD_W / 2, mid, '任務', { size: fs - 4, fill: '#fef08a', anchor: 'middle', weight: true }));
    const dots = [...r.mission].map((c) => (c === 'x' ? { t: '●', fill: '#ef4444' } : { t: '●', fill: '#3b82f6' }));
    const verdict = r.failed ? `失敗（${r.failCount} 張）` : r.failCount ? `成功（${r.failCount} 張失敗）` : '成功';
    parts.push(segs(seatX(1) + SEAT_W * 5, mid, [{ t: `第 ${r.round} 輪任務 `, fill: '#fef9c3', weight: true }, ...dots, { t: ` ${verdict}`, fill: r.failed ? '#fca5a5' : '#93c5fd', weight: true }], fs - 2, 'middle'));
    parts.push(rect(RES_X + 6, y + 4, RES_W - 12, rh - 8, r.failed ? '#dc2626' : '#2563eb', ' rx="6"'));
    parts.push(text(RES_X + RES_W / 2, mid, r.mission, { size: fs - 2, fill: '#ffffff', anchor: 'middle', weight: true }));
    parts.push(text(TEXT_X + 12, mid, r.mission, { size: fs, fill: r.failed ? '#fca5a5' : '#93c5fd', weight: true }));
  } else if (r.kind === 'lake') {
    parts.push(rect(GX0, y, W - 80, rh, '#083344', ' fill-opacity="0.8"'));
    parts.push(rect(GX0, y, LEAD_W, rh, '#164e63'));
    parts.push(text(GX0 + LEAD_W / 2, mid, '湖中', { size: fs - 4, fill: '#a5f3fc', anchor: 'middle', weight: true }));
    const claim = r.claim === 'o' ? { t: '宣告藍', fill: '#bfdbfe' } : r.claim === 'x' ? { t: '宣告紅', fill: '#fca5a5' } : { t: '沒說', fill: C.soft };
    const seen: Seg[] = r.seen ? [{ t: `（你看到：${SEEN_ZH[r.seen]}）`, fill: r.seen === 'red' ? C.red : C.green, weight: true }] : [];
    parts.push(segs(seatX(1) + SEAT_W * 5, mid, [{ t: `${seatChar(r.holderSeat)} 家 驗 ${seatChar(r.targetSeat)} 家 → `, fill: '#ecfeff' }, { ...claim, weight: true }, ...seen], fs - 2, 'middle'));
    const ll = `${seatChar(r.holderSeat)}>${seatChar(r.targetSeat)}${r.claim ? ` ${r.claim}` : ''}`;
    parts.push(rect(RES_X + 6, y + 4, RES_W - 12, rh - 8, '#0891b2', ' rx="6"'));
    parts.push(text(RES_X + RES_W / 2, mid, ll, { size: fs - 2, fill: '#ffffff', anchor: 'middle', weight: true }));
    parts.push(text(TEXT_X + 12, mid, ll, { size: fs, fill: '#a5f3fc' }));
  } else {
    parts.push(rect(GX0, y, W - 80, rh, C.blueFill, ` stroke="${C.blue}" stroke-width="2"`));
    parts.push(text(GX0 + LEAD_W / 2, mid, seatChar(r.leaderSeat), { size: fs, fill: C.blue, anchor: 'middle', weight: true }));
    parts.push(text(seatX(1) + 12, mid, r.round !== null ? `第 ${r.round} 局第 ${r.attempt} 次：輪到你` : '三藍：輪到你刺殺', { size: fs, fill: C.ink, weight: true }));
  }
  return parts.join('');
}

// ─── 題目卡（小圓桌＋牌譜格子＋題目，同一張） ─────────────────────────────────

/** 題目卡上方那一塊（標題列＋小圓桌與你的視角）的高度。 */
const CARD_TOP_H = 150 + TABLE_BOX_H + 10;
/** 題目卡下方（題目那一行＋說明＋網址）的高度。 */
const CARD_FOOT_H = 30 + 56 + 36 + 36 + 20;

export interface CardLayout {
  /** 題目卡上的格子列數（sheetRows 的前幾列）。 */
  cardRows: number;
  rowH: number;
  /** 放不下時第二張牌譜圖接著畫的列（沒有 = 一張就放得下）。 */
  overflow: boolean;
  height: number;
}

/** 票沒記錄的格子（比強制局的灰亮，沒上隊的格子再寫「？」）。 */
const UNKNOWN_VOTE_FILL = '#52525b';

/** 格子下面的圖例；有票沒記錄的提議才多列「？ = 票沒記錄」（跟強制局不投票分開）。 */
export function voteLegend(rows: readonly SheetRow[]): string {
  const unknown = rows.some((r) => r.kind === 'proposal' && r.votes.includes('unknown'));
  return `盾牌 = 上隊｜白 = 贊成、黑 = 反對、灰 = 強制局不投票${unknown ? '、？ = 票沒記錄' : ''}｜文字 +／- 綠色`;
}

/** 題目卡版面：一般局整份牌譜跟圓桌、題目放同一張 ≤ 1350；放不下先縮列高，最小列高還放不下就把後面的列移到第二張。 */
export function cardLayout(rowCount: number): CardLayout {
  const free = GRID_TARGET_H - CARD_TOP_H - GRID_HEAD_H - CARD_FOOT_H;
  const rh = Math.min(GRID_ROW_MAX, Math.floor(free / Math.max(1, rowCount)));
  if (rh >= GRID_ROW_MIN) return { cardRows: rowCount, rowH: rh, overflow: false, height: CARD_TOP_H + GRID_HEAD_H + rh * rowCount + CARD_FOOT_H };
  const fit = Math.floor(free / GRID_ROW_MIN);
  return { cardRows: fit, rowH: GRID_ROW_MIN, overflow: true, height: CARD_TOP_H + GRID_HEAD_H + GRID_ROW_MIN * fit + CARD_FOOT_H };
}

/** 牌譜放不下題目卡時，第二張圖要畫的列（從第幾列開始）；放得下回傳 null。 */
export function gridOverflowStart(pv: PickView): number | null {
  const layout = cardLayout(sheetRows(pv).length);
  return layout.overflow ? layout.cardRows : null;
}

/** 續圖一張最多幾列（列高用最小值，整張 ≤ GRID_TARGET_H）。 */
const GRID_PAGE_FREE = GRID_TARGET_H - 150 - 20 - GRID_HEAD_H - 110;
export const GRID_PAGE_ROWS = Math.floor(GRID_PAGE_FREE / GRID_ROW_MIN);

/** 題目卡放不下的列分成幾張續圖（每張平均分、都 ≤ GRID_PAGE_ROWS 列）：每張的 [start, end)。放得下回傳 []。 */
export function gridPages(pv: PickView): { start: number; end: number }[] {
  const rows = sheetRows(pv);
  const layout = cardLayout(rows.length);
  if (!layout.overflow) return [];
  const rest = rows.length - layout.cardRows;
  const n = Math.ceil(rest / GRID_PAGE_ROWS);
  const per = Math.ceil(rest / n);
  const pages: { start: number; end: number }[] = [];
  for (let start = layout.cardRows; start < rows.length; start += per) pages.push({ start, end: Math.min(rows.length, start + per) });
  return pages;
}

/** 「牌譜接下一張」的提示：k = 這是第幾張圖（題目卡是第 1 張），total = 牌譜一共幾張圖。 */
function nextHint(k: number, total: number): string {
  return `牌譜接下一張（往右滑）｜${k}/${total}`;
}

/** 題目圖的 SVG（weekday = 今天的星期，決定標題）：小圓桌＋你的視角、到目前的牌譜格子、題目。 */
export function buildPuzzleSvg(pv: PickView, weekday: number): string {
  const role = pv.game.seatRoles[pv.pick.seat - 1];
  const rows = sheetRows(pv);
  const layout = cardLayout(rows.length);
  const parts: string[] = [headerBand(labelFor(weekday, pv.pick), pv.exerciseId)];

  // 左：小圓桌；右：你的視角
  const top = 150;
  const cx = 40 + TABLE_BOX_W / 2;
  const cy = top + TABLE_BOX_H / 2 + 6;
  parts.push(roundTable(pv, rows, cx, cy));
  const rx = 40 + TABLE_BOX_W + 24;
  const rmax = W - 40 - rx;
  const s = pv.view.sight;
  const info = s.kind === 'percival' ? `拇指 ${s.thumbs.map(seatChar).join(' ')}（梅林、莫甘娜各一）`
    : s.kind === 'merlin' ? `看到的紅 ${s.seen.map(seatChar).join(' ')}（莫德雷德看不到）`
      : s.kind === 'evil' ? `隊友 ${s.mates.map(seatChar).join(' ')}` : s.kind === 'oberon' ? '不知道隊友' : '沒有額外資訊';
  let ty = top + 90;
  parts.push(text(rx, ty, `你是 ${seatChar(pv.pick.seat)}家`, { size: 40, weight: true }));
  ty += 54;
  parts.push(text(rx, ty, ROLE_ZH[role], { size: 40, weight: true }));
  for (const line of wrapLine(info, 26, rmax)) {
    ty += 44;
    parts.push(text(rx, ty, line, { size: 26, fill: C.soft }));
  }
  // 任務格：你的視角下面（站長 11/18：從圓桌移到旁邊），寬度不夠就換行
  parts.push(missionChips(rows, rx, ty + 30, rmax).svg);

  // 牌譜格子（只到出題那一刻；太長的話後面的列在第二張）
  let y = CARD_TOP_H;
  parts.push(gridHead(pv, y));
  y += GRID_HEAD_H;
  for (const r of rows.slice(0, layout.cardRows)) {
    parts.push(gridRow(r, y, layout.rowH));
    y += layout.rowH;
  }

  // 題目
  y += 30 + 26;
  const last = rows[rows.length - 1];
  const prompt = last.kind === 'decision' && last.round !== null
    ? `輪到你派 ${last.size} 人（第 ${last.round} 局第 ${last.attempt} 次${last.forced ? '，強制出發' : ''}）`
    : '三藍：輪到你刺殺。誰是梅林？';
  parts.push(text(40, y, prompt, { size: 36, fill: C.blue, weight: true }));
  y += 36;
  parts.push(text(40, y, layout.overflow ? nextHint(1, gridPages(pv).length + 1) : voteLegend(rows), { size: 21, fill: C.faint }));
  y += 36;
  parts.push(text(40, y, '實戰牌譜，只到出題的那一刻｜阿瓦隆百科 avalon-game-platform.web.app', { size: 21, fill: C.faint }));
  y += 20;
  // 標誌已經在小圓桌中間：題目卡不再鋪大浮水印。
  return svgDoc(y, parts.join(''), { watermark: false });
}

/**
 * 牌譜續圖：題目卡放不下的列，要幾張就分幾張（gridPages），同樣的格子（欄名照畫）。放得下時回傳 []。
 * 標題寫第幾張／共幾張；不是最後一張的寫「牌譜接下一張（往右滑）」，最後一張寫記號說明。
 */
export function buildGridSvgs(pv: PickView, weekday: number): string[] {
  const rows = sheetRows(pv);
  const pages = gridPages(pv);
  const total = pages.length + 1;
  return pages.map(({ start, end }, i) => {
    const part = rows.slice(start, end);
    const k = i + 2;
    const rh = Math.max(GRID_ROW_MIN, Math.min(GRID_ROW_MAX, Math.floor(GRID_PAGE_FREE / Math.max(1, part.length))));
    const parts: string[] = [headerBand(`${labelFor(weekday, pv.pick)}・牌譜 ${k}/${total}`, pv.exerciseId)];
    let y = 150 + 20;
    parts.push(gridHead(pv, y));
    y += GRID_HEAD_H;
    for (const r of part) {
      parts.push(gridRow(r, y, rh));
      y += rh;
    }
    y += 50;
    parts.push(text(40, y, k < total ? nextHint(k, total) : voteLegend(rows), { size: 21, fill: C.faint }));
    y += 36;
    parts.push(text(40, y, '實戰牌譜，只到出題的那一刻｜阿瓦隆百科 avalon-game-platform.web.app', { size: 21, fill: C.faint }));
    y += 24;
    return svgDoc(Math.max(y, 600), parts.join(''));
  });
}

/** 第一張續圖（放得下時 null）；要全部的續圖用 buildGridSvgs。 */
export function buildGridSvg(pv: PickView, weekday: number): string | null {
  return buildGridSvgs(pv, weekday)[0] ?? null;
}

// ─── 答案卡 ──────────────────────────────────────────────────────────────

/** 答案圖：昨天那一局的角色，紅方一格在上、藍方一格在下（站長 11/17「腳色順序應該是 刺娜德奧派梅」）；ids = 這一局這幾天出過的題號。 */
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
  box('紅方', red, C.redFill, C.red);
  box('藍方', blue, C.blueFill, C.blue);
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

/** 牌譜續圖 PNG，照順序（要幾張就幾張）；牌譜放得進題目卡時回傳 []。 */
export function renderGridPngs(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer[] {
  return buildGridSvgs(pv, weekday).map((svg) => svgToPng(svg, opts.fontFile ?? WEEKLY_CHART_FONT_FILE));
}

/** 第一張續圖 PNG（放得下時 null）；要全部的續圖用 renderGridPngs。 */
export function renderGridPng(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer | null {
  return renderGridPngs(pv, weekday, opts)[0] ?? null;
}

/** 答案圖 PNG（公布完整答案的日子才附）。 */
export function renderAnswerPng(pv: PickView, ids?: readonly string[], opts: { fontFile?: string } = {}): Buffer {
  return svgToPng(buildAnswerSvg(pv, ids), opts.fontFile ?? WEEKLY_CHART_FONT_FILE);
}
