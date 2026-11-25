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
 * 後面的續圖（後來改成把最早的幾局移到續圖，見 cardSplit；草稿 `gridImages`，只有這時候才有；站長 11/18：「發文如果圖會太長/太大, 就分成多張圖啊」→ 要幾張就分幾張，
 * 每張都在 1350 以內，每張寫「牌譜接下一張（往右滑）｜第幾張／共幾張」）。答案卡紅方在上、藍方在下。
 * 站長 11/18：「小圓桌能不能和阿瓦隆百科的logo結合?」看過樣張選 A（標誌含字、不透明度 0.3），並且「1~5 & 6~0 改成 只圍繞 logo
 * 剩下的資訊呈現在旁邊, 還有湖中女神以箭頭 (0 > 9 + 宣告結果) 呈現」→ 小圓桌只剩十個座位圍著中間的標誌，五局任務格移到右邊
 * 「你的視角」下面，湖中女神畫成座位之間的箭頭（拿湖的 → 被驗的，旁邊寫宣告；自己湖的另外寫看到的）。題目卡不另外鋪大浮水印。
 * 同日第三輪：「湖中線我覺得直接跟著任務結果呈現在右邊 0>1 o, 1>9 o, 9>4 x 這樣就好」「座位不要橢圓 直接圍繞 logo 就好 logo 太小的話可以放大」
 * 「你是 4家 忠臣 放同一行 (不用寫灰色小字了)」→ 座位排正圓、標誌放大；湖改成任務格下面一行；你的視角一行寫完。
 * 每局出任務的座位：站長看過座位下方的 m1／m3×1 標籤後改成寫在右邊任務格裡（結果下面一行座位號碼）。
 *
 * SVG 用字型檔（和每週排行圖同一個 Noto Sans TC，assets/fonts/）在 @resvg/resvg-js 轉 PNG，不用瀏覽器也不用系統字型，
 * GitHub Actions 上也能跑。圖裡只有座位和牌譜記號，沒有玩家名字。
 */

import fs from 'fs';
import path from 'path';
import { WEEKLY_CHART_FONT_FAMILY, WEEKLY_CHART_FONT_FILE, escapeXml } from '../stats/weeklyChart';
import { BLUE_ROLES, FAILS_REQUIRED, TEAM_SIZES, isRed, type PublicEvent } from '../simulation/scenario';
import { seatChar } from '../simulation/seats';
import { viewerLine, type PickView } from './draft';

export const W = 1080;
/** 深色卡片的配色（底色接近網站深色介面與 IG 截圖的黑）。 */
export const C = {
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
  gold: '#fbbf24', // 標誌外框
  me: '#facc15', // 你的座位（站長 11/17：「自己的位置可以是黃色圈圈」，不管你是哪一方）
  meFill: '#3a300a',
  seat: '#1f1f24',
  line: '#3f3f46',
  card: '#1c1c21',
};

/** 一段一個顏色的文字（tspan）。 */
export type Seg = { t: string; fill?: string; weight?: boolean };

export function segs(x: number, y: number, parts: readonly Seg[], size: number, anchor: 'start' | 'middle' | 'end' = 'start'): string {
  const a = anchor !== 'start' ? ` text-anchor="${anchor}"` : '';
  const spans = parts.map((p) => {
    const stroke = p.weight ? ` stroke="${p.fill ?? C.ink}" stroke-width="${Math.max(0.7, size / 40)}"` : '';
    return `<tspan fill="${p.fill ?? C.ink}"${stroke}>${escapeXml(p.t)}</tspan>`;
  }).join('');
  return `<text x="${x}" y="${y}" font-size="${size}"${a}>${spans}</text>`;
}

export function text(x: number, y: number, s: string, o: { size: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: boolean }): string {
  return segs(x, y, [{ t: s, fill: o.fill, weight: o.weight }], o.size, o.anchor);
}

export function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`;
}

/** 阿瓦隆百科的標誌（packages/web/public/logo.png 的複本）：卡片背景的浮水印與標題列左上角的標誌。 */
export const THREADS_LOGO_FILE = path.resolve(__dirname, '..', '..', '..', 'assets', 'threads', 'logo.png');
/** 原圖的邊長（repo 裡最大的一份；網站的 icon-512 比它小）。 */
const THREADS_LOGO_PX = 640;
/** 浮水印的不透明度：看得出標誌，但不蓋過牌譜文字。 */
const WATERMARK_OPACITY = 0.1;

let logoUri: string | null | undefined;
export function logoDataUri(): string | null {
  if (logoUri === undefined) logoUri = fs.existsSync(THREADS_LOGO_FILE) ? `data:image/png;base64,${fs.readFileSync(THREADS_LOGO_FILE).toString('base64')}` : null;
  return logoUri;
}

/**
 * 官方配件圖（站長 11/18：「直接用官方圖 只是可以淡化 像湖中湖到好可以用湖中陣營的圖 中間的圓圈 淡化 盾牌也是」）：
 * 網站 packages/web/public/avalon-assets 的 team-good.jpg／team-evil.jpg 中間的圓，複本放在 assets/threads/
 * （seat-good.png、seat-evil.png）。每張圖只放一次（symbol），用的地方 <use>。格子的盾牌試過官方任務盾牌圖，
 * 站長 11/17「盾牌原本的好像比較好」→ 畫回黃色盾牌。
 */
export const THREADS_ASSET_DIR = path.resolve(__dirname, '..', '..', '..', 'assets', 'threads');
const assetUris = new Map<string, string | null>();
export function assetUri(file: string): string | null {
  if (!assetUris.has(file)) {
    const f = path.join(THREADS_ASSET_DIR, file);
    assetUris.set(file, fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : null);
  }
  return assetUris.get(file) ?? null;
}

/** 文件裡用到的配件圖 symbol（seat-good、seat-evil）。 */
function assetSymbols(body: string): string {
  const defs: string[] = [];
  const add = (id: string, file: string, w: number, h: number): void => {
    if (!body.includes(`#${id}"`)) return;
    const uri = assetUri(file);
    if (uri) defs.push(`<symbol id="${id}" viewBox="0 0 ${w} ${h}"><image href="${uri}" width="${w}" height="${h}"/></symbol>`);
  };
  add('seat-good', 'seat-good.png', 160, 160);
  add('seat-evil', 'seat-evil.png', 160, 160);
  return defs.length ? `<defs>${defs.join('')}</defs>` : '';
}

export function svgDoc(height: number, body: string, opts: { watermark?: boolean } = {}): string {
  const uri = opts.watermark === false ? null : logoDataUri();
  // 浮水印：大尺寸、置中在標題列以下的區域、圓角裁切，放在所有內容後面（站長 11/17：「我是希望背景帶有我們的"阿瓦隆百科"logo」）。
  const size = Math.min(W - 80, height - HEADER_H - 80);
  const wx = (W - size) / 2;
  const wy = HEADER_H + (height - HEADER_H - size) / 2;
  const watermark = uri && size > 200
    ? `<defs><clipPath id="wm"><rect x="${wx}" y="${wy}" width="${size}" height="${size}" rx="${size / 10}"/></clipPath></defs>` +
      `<image href="${uri}" x="${wx}" y="${wy}" width="${size}" height="${size}" opacity="${WATERMARK_OPACITY}" clip-path="url(#wm)" preserveAspectRatio="xMidYMid slice"/>`
    : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${WEEKLY_CHART_FONT_FAMILY}">` +
    assetSymbols(body) + rect(0, 0, W, height, C.page) + watermark + body + '</svg>'
  );
}

/** 標題列的高度（一行）。 */
export const HEADER_H = 84;
const HEADER_FONT = 38;
/** 標題列標誌的邊長是字級的幾倍（站長 11/18：「發文貼圖 左上角logo 可以再大一點點 不然會有點糊掉」；原本＝字級）。 */
export const HEADER_LOGO_SCALE = 1.5;
/** 卡片轉 PNG 的倍率（svgToPng 沒有放大，1 張 SVG 單位＝1 像素）；標誌照這個像素數預先縮好。 */
const RENDER_SCALE = 1;

/**
 * 標題列用的標誌：從 640×640 的原圖（assets/threads/logo.png）先縮成剛好要畫的像素大小，再放進 SVG。
 * resvg 直接把 640 的圖畫成 38 像素時只取樣幾個點（沒有 mipmap），標誌裡的「阿瓦隆百科」會鋸齒、糊掉；
 * 這裡每次縮一半（每一步都是 2:1 的雙三次取樣，等於自己做 mipmap），最後一步縮到目標大小，畫的時候就是 1:1 不再重取樣。
 * resvg 載不到（只組 SVG 的測試）時用原圖。
 */
const headerLogoUris = new Map<number, string | null>();
export function headerLogoUri(px: number): string | null {
  const cached = headerLogoUris.get(px);
  if (cached !== undefined) return cached;
  const src = logoDataUri();
  let out = src;
  if (src) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
      const scaleTo = (uri: string, n: number): string => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}"><image href="${uri}" width="${n}" height="${n}" image-rendering="optimizeQuality"/></svg>`;
        return `data:image/png;base64,${new Resvg(svg).render().asPng().toString('base64')}`;
      };
      let uri = src;
      let cur = THREADS_LOGO_PX;
      while (Math.floor(cur / 2) >= px) {
        cur = Math.floor(cur / 2);
        uri = scaleTo(uri, cur);
      }
      out = cur === px ? uri : scaleTo(uri, px);
    } catch {
      out = src;
    }
  }
  headerLogoUris.set(px, out);
  return out;
}

/**
 * 標題列（站長 11/17：「title 可以寫 [左上角小 Logo 跟title 字體一樣大] 接 {阿瓦隆百科 ‧ 每日一題: 1-5 第一局尾派 [SV1Q8]} 這樣就好」）：
 * 一行，左上角標誌，接「阿瓦隆百科 ‧ 每日一題: <題目> [<局號>]」；續圖、答案卡在後面加「 · 牌譜 2/2」「 · 答案」。
 * 站長 11/18「左上角logo 可以再大一點點 不然會有點糊掉」→ 標誌改成字級的 1.5 倍、和標題字上下置中，用預先縮好的圖（headerLogoUri）。
 */
export function headerTitle(label: string, gameId: string, suffix = ''): string {
  return `阿瓦隆百科 ‧ 每日一題: ${label} [${gameId}]${suffix ? ` · ${suffix}` : ''}`;
}

/** 標題列標誌的邊長（字級 size 時）。 */
export function headerLogoSize(size: number): number {
  return Math.round(size * HEADER_LOGO_SCALE);
}

export function headerBand(title: string): string {
  const hasLogo = logoDataUri() !== null;
  const x0 = 40;
  const gap = 16;
  // 字級跟標誌一起縮：放不下時兩個一起變小
  const size = fitSize(title, HEADER_FONT, W - 40 - x0 - (hasLogo ? headerLogoSize(HEADER_FONT) + gap : 0), 26);
  const top = (HEADER_H - size) / 2;
  const logo = headerLogoSize(size);
  // 整數座標、整數邊長：預先縮好的圖 1:1 落在像素格上，不再被內插
  const ly = Math.round((HEADER_H - logo) / 2);
  const uri = hasLogo ? headerLogoUri(logo * RENDER_SCALE) : null;
  const icon = uri
    ? `<defs><clipPath id="hl"><rect x="${x0}" y="${ly}" width="${logo}" height="${logo}" rx="${Math.round(logo / 6)}"/></clipPath></defs>` +
      `<image href="${uri}" x="${x0}" y="${ly}" width="${logo}" height="${logo}" clip-path="url(#hl)" image-rendering="optimizeQuality" class="header-logo"/>`
    : '';
  const tx = uri ? x0 + logo + gap : x0;
  return rect(0, 0, W, HEADER_H, C.header) + icon + text(tx, top + size * 0.86, title, { size, fill: C.headerInk, weight: true });
}

const ZH_NUM = ['', '一', '二', '三', '四', '五'];

/**
 * 圖上標題的題目（決定點＋一句話）：1-5 第一局尾派、3-4 派西維爾、5-1 第五局第一次、刺殺。
 * 題號的局號部分另外放在 [ ] 裡。
 */
export function cardLabel(pv: PickView): string {
  if (pv.pick.proposal === null) return '刺殺';
  const { round: r, attempt: k } = pv.game.proposals[pv.pick.proposal];
  const code = `${r}-${k}`;
  if (pv.pick.kind === 'percival') return `${code} 派西維爾`;
  if (k === 5) return `${code} 第${ZH_NUM[r]}局尾派`;
  return `${code} 第${ZH_NUM[r]}局第${ZH_NUM[k]}次`;
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
  // 斷點前面要有字（第二段開頭的縮排不算），不然會一直斷出空行
  for (let i = chars[0] === INDENT ? 2 : 1; i < chars.length; i++) {
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
export function fitSize(line: string, size: number, max: number, min = 14): number {
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
/**
 * 從你的視角，湖中女神讓你知道的事（站長 11/18：「湖中呈現到該局狀況下的已知資訊就好 (而且根據湖中鏈還有好人湖中不說謊原則
 * 1湖9好 9湖中資訊1也會同步知道)」）：只看 known 裡的湖（到那一局為止）。
 * - 你自己湖到的（看到好／紅）。
 * - 湖中鏈：你是好人時，你確定是好人的人（你湖到好、或經由湖中鏈確定是好人）宣告的湖一定是真的，所以他湖到的人你也知道；
 *   一直推到沒有新資訊為止。你是紅方時不推。
 * - 派西：一根拇指的陣營知道了，另一根也就知道（一梅一娜）；這也放進推論裡，所以分出來的梅林宣告的湖照樣往下推。
 * 回傳每個知道的座位（via = 誰的湖讓你知道；null＝你自己湖的；thumb＝由另一根拇指推出來的，via 是那根拇指）與湖中鏈推出的每一步。
 */
export function lakeKnowledge(pv: PickView, known: readonly SheetRow[]): {
  seats: Map<number, { evil: boolean; via: number | null; thumb?: true }>;
  chain: { holder: number; target: number; evil: boolean }[];
} {
  const seats = new Map<number, { evil: boolean; via: number | null; thumb?: true }>();
  const chain: { holder: number; target: number; evil: boolean }[] = [];
  const lakes = known.filter((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
  for (const l of lakes) if (l.seen && !seats.has(l.targetSeat)) seats.set(l.targetSeat, { evil: l.seen === 'red', via: null });
  const viewerGood = BLUE_ROLES.includes(pv.game.seatRoles[pv.pick.seat - 1]);
  if (!viewerGood) return { seats, chain };
  const isGood = (seat: number): boolean => seat === pv.pick.seat || seats.get(seat)?.evil === false;
  const thumbs = pv.view.sight.kind === 'percival' ? pv.view.sight.thumbs : [];
  for (let changed = true; changed; ) {
    changed = false;
    // 派西：拇指一根知道了 → 另一根是相反陣營（紅的那根是莫甘娜 → 另一根是梅林、好人；反過來也一樣）
    if (thumbs.length === 2) {
      for (const [i, t] of thumbs.entries()) {
        const k = seats.get(t);
        const other = thumbs[1 - i];
        if (!k || seats.has(other) || other === pv.pick.seat) continue;
        seats.set(other, { evil: !k.evil, via: t, thumb: true });
        changed = true;
      }
    }
    for (const l of lakes) {
      if (l.holderSeat === pv.pick.seat || !isGood(l.holderSeat) || !l.claim || seats.has(l.targetSeat) || l.targetSeat === pv.pick.seat) continue;
      const evil = l.claim === 'x';
      seats.set(l.targetSeat, { evil, via: l.holderSeat });
      chain.push({ holder: l.holderSeat, target: l.targetSeat, evil });
      changed = true;
    }
  }
  return { seats, chain };
}

/** 兩根拇指（一梅一娜）其中一根的陣營知道了：好的那根是梅林、另一根是莫甘娜（反過來也一樣）。還分不出來回 null。 */
export function resolveThumbs(thumbs: readonly number[], seats: ReadonlyMap<number, { evil: boolean }>): { merlin: number; morgana: number } | null {
  if (thumbs.length !== 2) return null;
  for (const [i, t] of thumbs.entries()) {
    const k = seats.get(t);
    if (!k) continue;
    const other = thumbs[1 - i];
    return k.evil ? { merlin: other, morgana: t } : { merlin: t, morgana: other };
  }
  return null;
}

/** 卡片上標「隊友」的座位：刺殺題的紅方＝其他紅方全部（含奧伯倫），其他題照夜裡的知識（sight.mates）。 */
export function teammateSeats(pv: Pick<PickView, 'game' | 'pick' | 'view'>): number[] {
  if (pv.pick.proposal === null && isRed(pv.game.seatRoles[pv.pick.seat - 1])) {
    return pv.game.seatRoles.flatMap((r, i) => (i + 1 !== pv.pick.seat && isRed(r) ? [i + 1] : []));
  }
  return pv.view.sight.kind === 'evil' ? pv.view.sight.mates : [];
}

/** 每個座位的標記；known＝到那一刻為止看得到的列（題目卡算到出題那一刻）。 */
export type SeatMark = { label: string; color: string; side?: 'good' | 'evil'; /** 還分不出來的拇指：半圈藍半圈紅 */ split?: boolean };
export function seatMarks(pv: PickView, known: readonly SheetRow[]): Map<number, SeatMark> {
  const marks = new Map<number, SeatMark>();
  const s = pv.view.sight;
  // 圈的顏色：知道陣營的座位一律好人藍、壞人紅（站長 11/18：「湖中鏈可知的陣營也全都一起改座位圈圈顏色」）；
  // 分不出來的拇指半圈藍半圈紅、打問號（站長 11/17：「派西維爾看到的姆指可以是半圈藍半圈紅 然後打問號」）。
  if (s.kind === 'percival') s.thumbs.forEach((t) => marks.set(t, { label: '拇指?', color: C.ink, split: true }));
  if (s.kind === 'merlin') s.seen.forEach((t) => marks.set(t, { label: '紅', color: C.red, side: 'evil' }));
  // 隊友：提議題照夜裡的知識（看不到奧伯倫）；刺殺題四位紅方開牌討論，其他紅方全部標隊友（含奧伯倫；站長 11/18：「規則上 刺殺階段只有刺客可以開牌
  // 但只有邪惡方可以發言討論 奧伯倫屬於邪惡方 所以其實等同四位邪惡方開牌討論」，和「你是」那一行的 assassinationMates 一致）。
  for (const t of teammateSeats(pv)) marks.set(t, { label: '隊友', color: C.red, side: 'evil' });
  // 自己湖到的、湖中鏈推出的：已經有標記（隊友、看到的紅、拇指）的座位不蓋掉（夜裡已經知道的不重複）。
  const knowledge = lakeKnowledge(pv, known);
  for (const [seat, k] of knowledge.seats) {
    if (marks.has(seat)) continue;
    const label = k.via === null ? (k.evil ? '湖到紅' : '湖到好') : k.evil ? '湖鏈：紅' : '湖鏈：好';
    marks.set(seat, { label, color: k.evil ? C.red : C.blue, side: k.evil ? 'evil' : 'good' });
  }
  // 派西：一根拇指的陣營知道了（自己湖、或湖中鏈），兩根拇指就分得出來（站長 11/18：「拇指湖到好直接寫梅林, 另一根拇指改成莫甘娜,
  // 圓圈也改成藍色/紅色」）。這條蓋過原本的「拇指」標記。
  const resolved = s.kind === 'percival' ? resolveThumbs(s.thumbs, knowledge.seats) : null;
  if (resolved) {
    marks.set(resolved.merlin, { label: '梅林', color: C.blue, side: 'good' });
    marks.set(resolved.morgana, { label: '莫甘娜', color: C.red, side: 'evil' });
  }
  // 你：黃圈，不看陣營（站長 11/17：「自己的角色(刺客) 不應該是藍色」）
  marks.set(pv.pick.seat, { label: '你', color: C.me });
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
/** 圓桌中間標誌的不透明度（站長 11/18 選 A：0.3）：看得出是阿瓦隆百科，但不搶座位標記。 */
const TABLE_LOGO_OPACITY = 0.3;
/** 站長 11/17「圓桌好像可以再小一點點」：座位 30→27、圓 160→140（約小 12%），空出來的給右邊和牌譜。 */
const SEAT_R = 27;
/** 座位排成正圓（站長 11/18：「座位不要橢圓 直接圍繞 logo 就好 logo 太小的話可以放大」）。 */
const RING_R = 140;
/** 座位上方與下方（標記字）留的空間。 */
const TABLE_TOP_PAD = 28;
const TABLE_BOTTOM_PAD = 36;
/** 小圓桌那一塊的寬高（含座位外側的標記字、座位下方出過的任務）。 */
const TABLE_BOX_W = 2 * (RING_R + SEAT_R + 64);
const TABLE_BOX_H = 2 * (RING_R + SEAT_R) + TABLE_TOP_PAD + TABLE_BOTTOM_PAD;

/** 座位 seat（1～10，10 = 0 家）在圓桌上的位置：0 在正上方、順時針，5 在正下方。 */
export function seatPosition(seat: number, cx: number, cy: number): { x: number; y: number; ux: number; uy: number } {
  const k = seat % 10;
  const a = -Math.PI / 2 + (k * 2 * Math.PI) / 10;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  return { x: cx + RING_R * ux, y: cy + RING_R * uy, ux, uy };
}

/**
 * 五局任務格（人數、已出的任務結果、出任務的座位、第 4 局要 2 張失敗），放在題目卡右邊「你的視角」下面（站長 11/18：任務格移出圓桌；
 * 「改成在右邊 任務的部分 直接顯示每局參與的人&結果吧 (就是目前顯示的下方 加入參與任務的座位號碼就可以了)」）。
 * 從 (x0, y0) 往右排，寬度不夠就換行；回傳 SVG 與佔的高度。
 */
/** 一局的任務格：站長 11/18 的格式 [任務N]（結果）{出任務的座位}；還沒出的任務只寫 任務N（灰）。 */
function missionChip(rows: readonly SheetRow[], r: number, x: number, y: number, bw: number, bh: number): string {
  const parts: string[] = [];
  const q = rows.find((e): e is Extract<SheetRow, { kind: 'quest' }> => e.kind === 'quest' && e.round === r);
  const fill = q ? (q.failed ? C.redFill : C.blueFill) : C.seat;
  const stroke = q ? (q.failed ? C.red : C.blue) : C.line;
  parts.push(rect(x, y, bw, bh, fill, ` rx="10" stroke="${stroke}" stroke-width="2"`));
  parts.push(text(x + bw / 2, y + 27, `任務${r}`, { size: 18, fill: q ? C.ink : C.faint, anchor: 'middle', weight: !!q }));
  if (q) {
    parts.push(text(x + bw / 2, y + 55, q.mission, { size: q.mission.length > 4 ? 17 : 20, fill: C.yellow, anchor: 'middle', weight: true }));
    // 出這次任務的座位（那一局過了的提議；第 10 家寫 0）
    const team = missionTeam(rows, r);
    if (team.length) parts.push(text(x + bw / 2, y + 82, seatsText(team), { size: 18, fill: C.ink, anchor: 'middle', weight: true }));
  }
  return parts.join('');
}

export function missionChips(rows: readonly SheetRow[], x0: number, y0: number, maxW: number): { svg: string; height: number; xs: number[]; ys: number[]; bw: number } {
  const parts: string[] = [];
  const bw = 78;
  const bh = 94;
  const gap = 8;
  const perRow = Math.max(1, Math.min(5, Math.floor((maxW + gap) / (bw + gap))));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let r = 1; r <= 5; r++) {
    const i = r - 1;
    const x = x0 + (i % perRow) * (bw + gap);
    const y = y0 + Math.floor(i / perRow) * (bh + gap);
    xs.push(x);
    ys.push(y);
    parts.push(missionChip(rows, r, x, y, bw, bh));
  }
  const lines = Math.ceil(5 / perRow);
  return { svg: parts.join(''), height: lines * bh + (lines - 1) * gap, xs, ys, bw };
}

/**
 * 湖中女神寫成一行，放在任務格下面、對齊第 2～4 局的任務（站長 11/18：「湖中線我覺得直接跟著任務結果呈現在右邊 0>1 o, 1>9 o, 9>4 x 這樣就好」，
 * 之後定的格式「0 > 5 o | 5 > 9 o | 9 > 8 o」）：
 * 拿湖的>被驗的＋宣告（o 藍、x 紅、沒說），你自己湖的另外寫你看到的。只到出題那一刻（rows 來自 sheetRows）。
 */
export function lakeLine(rows: readonly SheetRow[]): Seg[] {
  const out: Seg[] = [];
  for (const e of lakeEntries(rows)) {
    if (out.length) out.push({ t: ' | ', fill: C.faint });
    out.push(...e.segs);
  }
  return out;
}

/**
 * 湖的每一筆：「0 > 1 o」（o 藍、x 紅、沒說）與它下面的註記（站長 11/18：「(看到好) 放湖中下方 不要放旁邊」）：
 * 你自己湖的寫（看到好／紅）；湖中鏈讓你知道的寫「9 是好人 → 4 是紅」。chain 來自 lakeKnowledge。
 */
export function lakeEntries(
  rows: readonly SheetRow[],
  chain: readonly { holder: number; target: number; evil: boolean }[] = [],
  opts: { thumbs?: readonly number[]; known?: readonly SheetRow[] } = {},
): { segs: Seg[]; notes: Seg[] }[] {
  const out: { segs: Seg[]; notes: Seg[] }[] = [];
  // 派西：第一次讓拇指分出梅林／莫甘娜的那一筆湖（known＝到那時候為止的列，預設就是 rows）
  let reveal: { holder: number; target: number; round: number; line: string } | null = null;
  if (opts.thumbs?.length === 2) {
    for (const l of opts.known ?? rows) {
      if (l.kind !== 'lake' || !opts.thumbs.includes(l.targetSeat)) continue;
      const c = chain.find((x) => x.holder === l.holderSeat && x.target === l.targetSeat);
      const evil = l.seen ? l.seen === 'red' : c ? c.evil : null;
      if (evil === null) continue;
      const t = l.targetSeat;
      const other = opts.thumbs[opts.thumbs[0] === t ? 1 : 0];
      const [merlin, morgana] = evil ? [other, t] : [t, other];
      reveal = { holder: l.holderSeat, target: t, round: l.round, line: `${seatChar(t)} 是${evil ? '紅' : '好人'} → ${seatChar(merlin)} 是梅林、${seatChar(morgana)} 是莫甘娜` };
      break;
    }
  }
  for (const r of rows) {
    if (r.kind !== 'lake') continue;
    const segsL: Seg[] = [
      { t: `${seatChar(r.holderSeat)} > ${seatChar(r.targetSeat)} `, fill: C.ink },
      r.claim === 'o' ? { t: 'o', fill: '#93c5fd', weight: true } : r.claim === 'x' ? { t: 'x', fill: C.red, weight: true } : { t: '沒說', fill: C.soft },
    ];
    const notes: Seg[] = [];
    const c = chain.find((x) => x.holder === r.holderSeat && x.target === r.targetSeat);
    if (r.seen) notes.push({ t: `（看到${r.seen === 'red' ? '紅' : '好'}）`, fill: r.seen === 'red' ? C.red : C.green });
    else if (c) notes.push({ t: `${seatChar(c.holder)} 是好人 → ${seatChar(c.target)} 是${c.evil ? '紅' : '好人'}`, fill: c.evil ? C.red : C.green });
    if (reveal && reveal.holder === r.holderSeat && reveal.target === r.targetSeat && reveal.round === r.round) notes.push({ t: reveal.line, fill: '#93c5fd' });
    out.push({ segs: segsL, notes });
  }
  return out;
}

/** 湖那一段：第一行是每一筆（用 | 隔開），註記放在各自那一筆的正下方（疊到就往下一行）。回傳 SVG 與高度。 */
export function lakeBlock(entries: readonly { segs: Seg[]; notes: Seg[] }[], x: number, y: number, size: number, prefix: Seg[] = []): { svg: string; height: number } {
  if (entries.length === 0) return { svg: '', height: 0 };
  const line: Seg[] = [...prefix];
  const starts: number[] = [];
  const width = (gs: readonly Seg[]): number => textWidth(gs.map((g) => g.t).join(''), size);
  entries.forEach((e, i) => {
    if (i > 0) line.push({ t: ' | ', fill: C.faint });
    starts.push(x + width(line));
    line.push(...e.segs);
  });
  const parts = [segs(x, y, line, size)];
  const noteSize = Math.max(16, size - 4);
  const rows: number[] = []; // 每一行註記目前的右邊界
  entries.forEach((e, i) => {
    let below = -1; // 同一筆的第二個註記一定在第一個下面
    for (const note of e.notes) {
      const nx = Math.min(starts[i], W - 40 - textWidth(note.t, noteSize));
      let k = rows.findIndex((right, j) => j > below && nx > right + 10);
      if (k < 0) {
        rows.push(-Infinity);
        k = rows.length - 1;
      }
      rows[k] = Math.max(rows[k], nx + textWidth(note.t, noteSize));
      below = k;
      parts.push(segs(nx, y + (k + 1) * (noteSize + 10), [note], noteSize));
    }
  });
  return { svg: parts.join(''), height: rows.length * (noteSize + 10) };
}

/** 第 round 局出任務的座位（那一局過了的提議的隊伍）；還沒出任務是 []。 */
export function missionTeam(rows: readonly SheetRow[], round: number): number[] {
  if (!rows.some((q) => q.kind === 'quest' && q.round === round)) return [];
  const team = rows.find((p): p is Extract<SheetRow, { kind: 'proposal' }> => p.kind === 'proposal' && p.round === round && p.approved);
  return team ? [...team.team] : [];
}

/** 圓桌中間標誌的半徑（座位圈內側再留一點空隙）。 */
const TABLE_LOGO_R = RING_R - SEAT_R - 10;

/** 座位 seat 對著圓心那一側、在標誌圓邊上的點（座位和標誌的切點）。 */
export function logoRimPoint(seat: number, cx: number, cy: number): { x: number; y: number } {
  const { ux, uy } = seatPosition(seat, cx, cy);
  return { x: cx + TABLE_LOGO_R * ux, y: cy + TABLE_LOGO_R * uy };
}

export const LAKE_LINE = '#22d3ee';

/** 箭頭頭（三角形）：尖端在 (x, y)、指向 angle（弧度）。 */
export function arrowHead(x: number, y: number, angle: number, fill: string, size: number): string {
  const back = (d: number, side: number): string => {
    const bx = x - Math.cos(angle) * d - Math.sin(angle) * side;
    const by = y - Math.sin(angle) * d + Math.cos(angle) * side;
    return `${bx.toFixed(1)} ${by.toFixed(1)}`;
  };
  return `<path d="M${x.toFixed(1)} ${y.toFixed(1)} L${back(size, size * 0.55)} L${back(size, -size * 0.55)} Z" fill="${fill}" class="lake-head"/>`;
}

/**
 * 圓桌上的湖中線（站長 11/18：「覺得派票的實虛線其實沒有很清楚 直接改成湖中線就好 宣告也可以寫在線上」）：
 * 拿湖的人 → 被驗的人，端點在座位與標誌的切點，線中間寫宣告（o 藍、x 紅、沒說 ?）。最新的一次湖畫粗一點。
 * lakes 是到那一刻為止的湖（題目卡＝出題那一刻）。
 */
export function lakeLines(known: readonly SheetRow[], cx: number, cy: number): string {
  const lakes = known.filter((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
  const out: string[] = [];
  lakes.forEach((l, i) => {
    const latest = i === lakes.length - 1;
    const a = logoRimPoint(l.holderSeat, cx, cy);
    const b = logoRimPoint(l.targetSeat, cx, cy);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = latest ? 18 : 14;
    const ex = b.x - Math.cos(ang) * head * 0.8;
    const ey = b.y - Math.sin(ang) * head * 0.8;
    out.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${LAKE_LINE}" stroke-opacity="${latest ? 1 : 0.65}" stroke-width="${latest ? 4 : 2.5}" class="lake-line"/>`);
    out.push(arrowHead(b.x, b.y, ang, LAKE_LINE, head));
    // 宣告寫在線的中間（底色擋一下線）
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const label = l.claim === 'o' ? { t: 'o', fill: '#93c5fd' } : l.claim === 'x' ? { t: 'x', fill: C.red } : { t: '?', fill: C.soft };
    out.push(`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="15" fill="${C.page}" stroke="${LAKE_LINE}" stroke-opacity="0.6" stroke-width="1.5"/>`);
    out.push(text(mx, my + 8, label.t, { size: 24, fill: label.fill, anchor: 'middle', weight: true }));
  });
  return out.join('');
}

/**
 * 小圓桌：十個座位排成正圓、圍著中間放大的阿瓦隆百科標誌（站長 11/18 選 A：標誌含字、不透明度 0.3；「座位不要橢圓 直接圍繞 logo」）。
 * 座位標記（你、拇指、看到的紅、隊友、湖到的）在座位外側。每局出任務的座位寫在右邊的任務格裡，湖也寫在右邊。
 */
/** 座位的圈：一般一種顏色；還分不出來的拇指左半圈藍、右半圈紅。 */
export function seatRing(x: number, y: number, r: number, m: SeatMark | undefined, width: number): string {
  if (m?.split) {
    const arc = (from: number, to: number, color: string): string =>
      `<path d="M${x} ${y + from * r} A${r} ${r} 0 0 1 ${x} ${y + to * r}" fill="none" stroke="${color}" stroke-width="${width}" class="thumb-ring"/>`;
    return arc(1, -1, C.blue) + arc(-1, 1, C.red); // 下→左→上 藍；上→右→下 紅
  }
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${m ? m.color : C.line}" stroke-width="${m ? width : 2}"/>`;
}

function roundTable(pv: PickView, cx: number, cy: number, known: readonly SheetRow[]): string {
  const uri = logoDataUri();
  const r = TABLE_LOGO_R;
  const logo = uri
    ? `<defs><clipPath id="tl"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>` +
      `<image href="${uri}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" opacity="${TABLE_LOGO_OPACITY}" clip-path="url(#tl)" preserveAspectRatio="xMidYMid slice"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.gold}" stroke-opacity="0.3" stroke-width="2"/>`
    : '';
  // 湖中線畫在標誌上面、座位下面
  const parts: string[] = [logo, lakeLines(known, cx, cy)];
  const marks = seatMarks(pv, known);
  for (let seat = 1; seat <= 10; seat++) {
    const { x, y, ux, uy } = seatPosition(seat, cx, cy);
    const m = marks.get(seat);
    const me = seat === pv.pick.seat;
    parts.push(`<circle cx="${x}" cy="${y}" r="${SEAT_R}" fill="${me ? C.meFill : C.seat}"/>`);
    // 知道陣營的座位：圈裡放官方陣營圖中間的圓（淡化），數字照樣看得清楚
    if (m?.side && !me && assetUri(`seat-${m.side}.png`)) {
      parts.push(`<use href="#seat-${m.side}" x="${x - SEAT_R}" y="${y - SEAT_R}" width="${2 * SEAT_R}" height="${2 * SEAT_R}" opacity="0.42" class="seat-side seat-${m.side}"/>`);
    }
    parts.push(seatRing(x, y, SEAT_R, m, 5));
    parts.push(text(x, y + 9, seatChar(seat), { size: 26, anchor: 'middle', weight: true }));
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
  // 站長 11/17：「盾牌原本的好像比較好」→ 畫回黃色盾牌（不用官方任務盾牌圖）
  const k = size / 24;
  const tx = cx - 12 * k;
  const ty = cy - 12 * k;
  return `<path transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(3)})" d="M12 2 L20 5 V11 C20 16.5 16.5 20.5 12 22 C7.5 20.5 4 16.5 4 11 V5 Z" fill="#facc15" stroke="#1c1917" stroke-width="1.2" class="team-shield"/>`;
}

/** 圖的高度上限（Threads 手機 4:5）。 */
export const GRID_TARGET_H = 1350;
/**
 * 格子的列高範圍：精縮版（站長 11/18 貼的派票紀錄表：一次提議一窄列，整局約 450px），放不下時先縮列高，
 * 縮到最小還放不下才把後面的列移到第二張圖。
 */
export const GRID_ROW_MAX = 26;
export const GRID_ROW_MIN = 19;

const GX0 = 40;
const LEAD_W = 60;
const RES_W = 96;
const TEXT_W = 214;
const SEAT_W = (W - 80 - LEAD_W - RES_W - TEXT_W) / 10;
const seatX = (seat: number): number => GX0 + LEAD_W + SEAT_W * (seat - 1);
const RES_X = GX0 + LEAD_W + SEAT_W * 10;
const TEXT_X = RES_X + RES_W;
const GRID_HEAD_H = 42;

/** 格子的欄名：隊長、1～0（你藍、拇指金、看到的紅／隊友紅）、結果、文字紀錄。 */
function gridHead(pv: PickView, y: number, known: readonly SheetRow[] = sheetRows(pv)): string {
  const parts: string[] = [];
  const marks = seatMarks(pv, known);
  const hy = y + 28;
  parts.push(text(GX0 + LEAD_W / 2, hy, '隊長', { size: 20, fill: C.faint, anchor: 'middle' }));
  for (let seat = 1; seat <= 10; seat++) {
    const m = marks.get(seat);
    const cx = seatX(seat) + SEAT_W / 2;
    if (m && seat === pv.pick.seat) parts.push(`<circle cx="${cx}" cy="${hy - 8}" r="20" fill="${C.meFill}"/>`);
    if (m) parts.push(seatRing(cx, hy - 8, 20, m, 3));
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
      // 盾牌在 24 格裡佔 2～22 高：放到列高允許的最大（上下各留 1.5px）
      if (r.team.includes(seat)) parts.push(shield(seatX(seat) + SEAT_W / 2, y + rh / 2, Math.min(SEAT_W, ((rh - 3) * 24) / 20)));
    }
    const res = r.forced ? '強制' : r.approves === null ? '—' : `${r.approves}票${r.approved ? '過' : ''}`;
    parts.push(text(RES_X + RES_W / 2, mid, res, { size: fs - 2, fill: r.forced ? '#fcd34d' : r.approved ? '#6ee7b7' : C.faint, anchor: 'middle' }));
    // 文字紀錄：隊長、隊伍、值得注意的票（站長的表：「1 1347 47-」）
    const [team, ...rest] = r.line.split(' ');
    const seg: Seg[] = [{ t: `${seatChar(r.leaderSeat)} `, fill: '#facc15', weight: true }, { t: team }];
    if (rest.length) seg.push({ t: ` ${rest.join(' ')}`, fill: C.green, weight: true });
    parts.push(segs(TEXT_X + 12, mid, seg, fitSize(`${seatChar(r.leaderSeat)} ${r.line}`, fs, TEXT_W - 16)));
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
    // 站長 11/17：「圖裡面不要寫 (第3局第5次，強制出發)」→ 只留短短的「輪到你」
    parts.push(text(seatX(1) + 12, mid, r.round !== null ? '輪到你' : '三藍：輪到你刺殺', { size: fs, fill: C.ink, weight: true }));
  }
  return parts.join('');
}

// ─── 題目卡（小圓桌＋牌譜格子＋題目，同一張） ─────────────────────────────────

/** 題目卡上方那一塊（標題列＋小圓桌與你的視角）的高度。 */
const CARD_TOP_H = HEADER_H + TABLE_BOX_H + 10;
/** 題目卡下方（題目那一行＋說明＋網址）的高度。 */
// 題目那一行（56）＋說明（36）＋網址（36）＋下緣（20）：跟 buildPuzzleSvg 底下實際用的一樣，不多留空
/** 題目卡底下：記號說明、網址（題目那一行移到右邊「你是…」下面了）。 */
const CARD_FOOT_H = 30 + 21 + 36 + 20;

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
export function cardLayout(rowCount: number, top = CARD_TOP_H): CardLayout {
  const free = GRID_TARGET_H - top - GRID_HEAD_H - CARD_FOOT_H;
  const rh = Math.min(GRID_ROW_MAX, Math.floor(free / Math.max(1, rowCount)));
  if (rh >= GRID_ROW_MIN) return { cardRows: rowCount, rowH: rh, overflow: false, height: top + GRID_HEAD_H + rh * rowCount + CARD_FOOT_H };
  const fit = Math.floor(free / GRID_ROW_MIN);
  return { cardRows: fit, rowH: GRID_ROW_MIN, overflow: true, height: top + GRID_HEAD_H + GRID_ROW_MIN * fit + CARD_FOOT_H };
}

/** 牌譜放不下題目卡時，題目卡從第幾列開始畫（前面的列——最早的幾局——在續圖）；放得下回傳 null。 */
export function gridOverflowStart(pv: PickView): number | null {
  const start = cardSplit(pv).cardStart;
  return start > 0 ? start : null;
}

/** 續圖一張最多幾列（列高用最小值，整張 ≤ GRID_TARGET_H）。 */
const GRID_PAGE_FREE = GRID_TARGET_H - HEADER_H - 20 - GRID_HEAD_H - 110;
export const GRID_PAGE_ROWS = Math.floor(GRID_PAGE_FREE / GRID_ROW_MIN);

/** 每一列是第幾局（輪到你那一列算出題那一局；刺殺題算最後一局之後）。 */
export function rowRound(r: SheetRow): number {
  return r.kind === 'decision' ? r.round ?? 6 : r.round;
}

/**
 * 題目卡和續圖怎麼分（站長 11/18：「那個精簡版 是不是就可以把全部的牌譜+所有任務結果+湖中資訊全部一次呈現?」）：
 * 放得下（列高最小 GRID_ROW_MIN）就整份牌譜都在題目卡；放不下時把最早的幾局（整局，不拆開）移到續圖，
 * 題目卡留後面的局到「輪到你」。續圖一張最多 GRID_PAGE_ROWS 列，也是整局整局放（一局本身太長才拆）。
 */
export function cardSplit(pv: PickView): { cardStart: number; pages: { start: number; end: number }[] } {
  const rows = sheetRows(pv);
  const n = rows.length;
  const top = cardTop(pv);
  if (!cardLayout(n, top).overflow) return { cardStart: 0, pages: [] };
  const bounds = rows.map((r, i) => (i === 0 || rowRound(r) !== rowRound(rows[i - 1]) ? i : -1)).filter((i) => i >= 0);
  let cardStart = bounds.find((i) => i > 0 && !cardLayout(n - i, top).overflow) ?? -1;
  if (cardStart < 0) cardStart = n - cardLayout(n, top).cardRows; // 出題那一局本身就放不下：只好拆
  const pages: { start: number; end: number }[] = [];
  let start = 0;
  while (start < cardStart) {
    let end = start;
    for (const b of [...bounds.filter((i) => i > start && i <= cardStart), cardStart]) {
      if (b - start <= GRID_PAGE_ROWS) end = b;
      else break;
    }
    if (end === start) end = Math.min(cardStart, start + GRID_PAGE_ROWS);
    pages.push({ start, end });
    start = end;
  }
  return { cardStart, pages };
}

/** 續圖（最早的幾局）：每張的 [start, end)。放得下回傳 []。 */
export function gridPages(pv: PickView): { start: number; end: number }[] {
  return cardSplit(pv).pages;
}

/** 「牌譜接下一張」的提示：k = 這是第幾張圖（題目卡是第 1 張），total = 牌譜一共幾張圖。 */
function nextHint(k: number, total: number): string {
  return `牌譜接下一張（往右滑）｜${k}/${total}`;
}

/**
 * 你的視角，一行（站長 11/18：「你是 {#}家 {身分} | {內建資訊} | {要做的決策}」，和貼文同一行，見 draft.viewerLine）：
 * 例：「你是 5家 忠臣 | 無其他資訊 | 派 3 人」「你是 0家 派西維爾 | 看到 4家 & 9家 | 派 4 人」「你是 3家 刺客 | 隊友 5家莫甘娜 & 8家莫德雷德 & 7家奧伯倫 | 刺殺梅林」。
 */
export function identityText(pv: Pick<PickView, 'game' | 'pick' | 'view'>): string {
  return viewerLine(pv.game, pv.pick, pv.view.sight);
}

/** 「你是」那一行的字級：平常 34，放不下就一級一級縮，最小 20（約 60%）。 */
export const IDENTITY_FONT = 34;
export const IDENTITY_FONT_MIN = 20;
/** 右欄（圓桌右邊）的左緣與寬度。 */
const RIGHT_X = 40 + TABLE_BOX_W + 24;
const RIGHT_MAX = W - 40 - RIGHT_X;
/** 整列寫的時候（圓桌上面）的寬度與這一條的高度。 */
const WIDE_MAX = W - 80;
const WIDE_BAND_PAD = 30;

/**
 * 你的視角排版：永遠一行、不換行（站長 11/18：「紅方資訊好像有點多 看能不能縮小字體之類的 不要換行」）。
 * 先放在圓桌右邊，字級 34 一級一級縮到 20；縮到 20 還放不下（例如刺殺題列出三個隊友和角色），
 * 就改成整列寫在標題列下面、圓桌上面（寬 1000，字級同樣從 34 縮），圓桌與右欄往下移 band 的高度。
 */
export function identityLayout(pv: Pick<PickView, 'game' | 'pick' | 'view'>): { line: string; size: number; wide: boolean; band: number } {
  const line = identityText(pv);
  const size = fitSize(line, IDENTITY_FONT, RIGHT_MAX, IDENTITY_FONT_MIN);
  if (textWidth(line, size) <= RIGHT_MAX) return { line, size, wide: false, band: 0 };
  const wide = fitSize(line, IDENTITY_FONT, WIDE_MAX, IDENTITY_FONT_MIN);
  return { line, size: wide, wide: true, band: wide + WIDE_BAND_PAD };
}

/** 題目卡的格子：整份牌譜到「輪到你」（放不下時從 cardSplit 的 cardStart 開始，前面的局在續圖）。 */
export function cardSheetRows(pv: PickView): SheetRow[] {
  return sheetRows(pv).slice(cardSplit(pv).cardStart);
}

/**
 * 題目卡右上：你的視角、題目（白字）、五局任務格、湖。回傳 SVG 與最下面的 y（題目卡的牌譜從圓桌和這一欄都畫完的地方開始）。
 */
function rightColumn(pv: PickView, rows: readonly SheetRow[]): { svg: string; bottom: number } {
  const parts: string[] = [];
  const id = identityLayout(pv);
  const top = HEADER_H + id.band;
  const rx = RIGHT_X;
  const rmax = RIGHT_MAX;
  // 你的視角＋要做的決策，一行（站長 11/18：「你是 {#}家 {身分} | {內建資訊} | {要做的決策}」；原本另一行白字的「輪到你派 N 人」併進來）。
  // 不換行：太長就縮字，再放不下就整列寫在圓桌上面（identityLayout）。
  let ty: number;
  if (id.wide) {
    parts.push(text(40, HEADER_H + 14 + id.size * 0.86 + 4, id.line, { size: id.size, weight: true, fill: C.ink }).replace('<text ', '<text class="viewer-line viewer-line-wide" '));
    ty = top + 40;
  } else {
    ty = top + 60;
    parts.push(text(rx, ty, id.line, { size: id.size, weight: true, fill: C.ink }).replace('<text ', '<text class="viewer-line" '));
    ty += id.size + 18;
  }
  // 任務格：你的視角下面（站長 11/18：從圓桌移到旁邊），寬度不夠就換行
  const chips = missionChips(rows, rx, ty - 10, rmax);
  parts.push(chips.svg);
  ty += chips.height + 30;
  // 湖：任務格下面一行，從第一次湖的那一局（第 2 局）的任務格下面開始（0 > 5 o | 5 > 9 o | 9 > 8 o）；
  // 註記（看到好、湖中鏈）放在各自那一筆的下面
  const thumbs = pv.view.sight.kind === 'percival' ? pv.view.sight.thumbs : undefined;
  const entries = lakeEntries(rows, lakeKnowledge(pv, rows).chain, { thumbs });
  if (entries.length) {
    const firstLake = rows.find((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
    const i = Math.max(0, Math.min(4, (firstLake?.round ?? 2) - 1));
    const lx = chips.ys[i] === chips.ys[0] ? chips.xs[i] : rx;
    const label = lakeLine(rows).map((g) => g.t).join('');
    const avail = W - 40 - lx;
    const size = Math.max(18, Math.min(24, Math.floor((24 * avail) / Math.max(1, textWidth(label, 24)))));
    const lb = lakeBlock(entries, lx, ty, size);
    parts.push(lb.svg);
    ty += lb.height;
  }

  return { svg: parts.join(''), bottom: ty };
}

/** 題目卡的牌譜從哪裡開始：圓桌那一塊和右邊那一欄比較低的那個下面。 */
export function cardTop(pv: PickView): number {
  return Math.max(CARD_TOP_H + identityLayout(pv).band, Math.ceil(rightColumn(pv, sheetRows(pv)).bottom) + 10);
}

/**
 * 牌譜卡（輪播第 2 張，2026-11-25 以前是題目卡）：小圓桌＋你的視角、整份牌譜（精簡表格）到「輪到你」。
 * 站長 11/25：「希望能更直觀讓看到的人一目瞭然」→ 第 1 張改成大字的題目卡（card.ts），這一張留給想照牌譜細推的人，內容不變。
 */
export function buildRecordSvg(pv: PickView, weekday: number): string {
  const rows = sheetRows(pv);
  // 站長 11/18：精縮版的派票紀錄表——整份牌譜、任務結果、湖一次放在題目卡；放不下才把最早的幾局移到續圖
  const cardRows = cardSheetRows(pv);
  const pagesN = gridPages(pv).length;
  const layout = cardLayout(cardRows.length, cardTop(pv));
  const parts: string[] = [headerBand(headerTitle(cardLabel(pv), pv.pick.gameId))];

  // 左：小圓桌；右：你的視角（你的視角整列寫的時候，圓桌往下移）
  const top = HEADER_H + identityLayout(pv).band;
  const cx = 40 + TABLE_BOX_W / 2;
  const cy = top + TABLE_TOP_PAD + RING_R + SEAT_R;
  parts.push(roundTable(pv, cx, cy, rows));
  const right = rightColumn(pv, rows);
  parts.push(right.svg);

  // 牌譜格子（只到出題那一刻；太長的話最早的幾局在後面的續圖）
  let y = cardTop(pv);
  parts.push(gridHead(pv, y, rows));
  y += GRID_HEAD_H;
  for (const r of cardRows.slice(0, layout.cardRows)) {
    parts.push(gridRow(r, y, layout.rowH));
    y += layout.rowH;
  }

  y += 30 + 21;
  const hint = pagesN ? `前面幾局的牌譜在後面的圖（往右滑）｜1/${pagesN + 1}` : voteLegend(cardRows);
  parts.push(text(40, y, hint, { size: 21, fill: C.faint }));
  y += 36;
  parts.push(text(40, y, '實戰牌譜，只到出題的那一刻｜阿瓦隆百科 avalon-game-platform.web.app', { size: 21, fill: C.faint }));
  y += 20;
  // 標誌已經在小圓桌中間：題目卡不再鋪大浮水印。
  return svgDoc(y, parts.join(''), { watermark: false });
}

/**
 * 牌譜續圖：題目卡放不下時最早的幾局（整局），要幾張就分幾張（gridPages），同樣的格子（欄名照畫）。放得下時回傳 []。
 * 標題寫第幾張／共幾張（題目卡是第 1 張）；不是最後一張的寫「牌譜接下一張（往右滑）」，最後一張寫記號說明。
 */
export function buildGridSvgs(pv: PickView, weekday: number): string[] {
  const rows = sheetRows(pv);
  const pages = gridPages(pv);
  const total = pages.length + 1;
  return pages.map(({ start, end }, i) => {
    const part = rows.slice(start, end);
    const k = i + 2;
    const rh = Math.max(GRID_ROW_MIN, Math.min(GRID_ROW_MAX, Math.floor(GRID_PAGE_FREE / Math.max(1, part.length))));
    const parts: string[] = [headerBand(headerTitle(cardLabel(pv), pv.pick.gameId, `牌譜 ${k}/${total}`))];
    let y = HEADER_H + 20;
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


/** 牌譜的圖一共幾張：牌譜卡＋放不下時的續圖（發文時這幾張要一張不少）。 */
export function recordImageCount(pv: PickView): number {
  return 1 + gridPages(pv).length;
}

/** 牌譜的圖，照順序：牌譜卡、（放不下時）續圖。 */
export function buildRecordSvgs(pv: PickView, weekday: number): string[] {
  return [buildRecordSvg(pv, weekday), ...buildGridSvgs(pv, weekday)];
}

/** SVG → PNG（只用內附的字型）。字型檔或原生套件不在時丟錯，呼叫端改成不附圖。 */
export function svgToPng(svg: string, fontFile: string): Buffer {
  if (!fs.existsSync(fontFile)) throw new Error(`threads image font missing: ${fontFile}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: WEEKLY_CHART_FONT_FAMILY },
    background: C.page,
  });
  return resvg.render().asPng();
}

/**
 * 牌譜的圖 PNG，照順序（檔名 <日期>-grid-<n>.png）：第 1 張是牌譜卡（一定有），後面是放不下時的續圖。
 * 題目卡（<日期>.png）和答案卡在 card.ts。
 */
export function renderGridPngs(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer[] {
  return buildRecordSvgs(pv, weekday).map((svg) => svgToPng(svg, opts.fontFile ?? WEEKLY_CHART_FONT_FILE));
}
