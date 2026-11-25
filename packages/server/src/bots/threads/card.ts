/**
 * Threads 每日一題（2026-11-25）— 一眼看懂的題目卡與答案卡。
 *
 * 站長 11/25：「關於數據分析跟每日一題 希望能更直觀讓看到的人一目瞭然」。
 * 之前的題目卡把整份牌譜的格子塞在同一張：在手機上（1080 寬的圖縮到約 390）只剩標題看得清楚，
 * 問題是什麼、可以選什麼都要讀貼文才知道。現在分成兩張：
 *
 *   第 1 張・題目卡（這個檔，`<日期>.png`，1080×1350）：最上面一行大字的問題 → 你是誰 → 比數與五局任務 →
 *     大圓桌（你黃圈、你確定的好人藍圈／壞人紅圈、座位旁的方塊＝出過第幾局任務、箭頭＝湖中女神）→
 *     這一局已經派過的隊、湖中女神 → 三個選項 A／B／C（choices.ts）→ 固定的記號說明。
 *     字級照手機看得到的大小排（問題 80、選項 44 以上），內文不超過四十個中文字。
 *   第 2 張・牌譜卡（image.ts 的 buildRecordSvg，`<日期>-grid-1.png`）：原本那張整份牌譜的格子，給想照牌譜細推的人。
 *
 * 答案卡（公布完整答案的那天，`<日期>-answer.png`）：真人選了哪一個（大字，「真人選 B 2450：4 好 0 壞，任務成功」）＋結果，三個選項各有幾個壞人
 * （座位直接塗紅、藍），一句話理由，下面才是角色（紅方在上：刺娜德奧、藍方在下：派梅）和這一局的結果。
 *
 * 圓桌的排法、顏色和站長之前定的一樣：0 在十二點、順時針、5 在六點；你一律黃圈；分不出來的拇指半藍半紅；
 * 中間是阿瓦隆百科的標誌。只畫到出題那一刻（資料來自 sheetRows(pv)）。圖裡只有座位，沒有玩家名字。
 */

import { WEEKLY_CHART_FONT_FILE } from '../stats/weeklyChart';
import { ROLE_ZH } from '../simulation/commands';
import { resultText } from '../simulation/replies';
import { FAILS_REQUIRED, TEAM_SIZES, isRed } from '../simulation/scenario';
import { seatChar, teamDigits } from '../simulation/seats';
import { CHOICE_LETTERS, choiceReveal, choicesFor, otherChoiceLine, type Choices } from './choices';
import { VIEWER_SEP, reasonSentence, scoreOf, viewerLine, type PickView } from './draft';
import {
  C,
  HEADER_H,
  LAKE_LINE,
  W,
  arrowHead,
  assetUri,
  cardLabel,
  fitSize,
  headerBand,
  headerTitle,
  logoDataUri,
  missionTeam,
  rect,
  seatMarks,
  seatRing,
  segs,
  sheetRows,
  svgDoc,
  svgToPng,
  text,
  textWidth,
  type SeatMark,
  type Seg,
  type SheetRow,
} from './image';

/** 題目卡固定 1080×1350（Threads／IG 手機 4:5）。 */
export const CARD_H = 1350;
const X0 = 40;
const INNER = W - 2 * X0;
const GOOD_INK = '#93c5fd';
const BAD_INK = '#fca5a5';

// ─── 問題（最上面一行大字） ───────────────────────────────────────────────────

/** 題目卡最上面的問題（大字）和下面一行白話的背景。 */
export function cardQuestion(pv: Pick<PickView, 'game' | 'pick'>): { big: string; sub: string } {
  if (pv.pick.proposal === null) return { big: '你是刺客：誰是梅林？', sub: '好人拿下三局，刺中梅林壞人就逆轉' };
  const p = pv.game.proposals[pv.pick.proposal];
  const big = `輪到你派 ${TEAM_SIZES[p.round - 1]} 人，派誰？`;
  switch (pv.pick.kind) {
    case 'percival': return { big, sub: '你是派西維爾：兩根拇指，一個梅林、一個莫甘娜' };
    case 'final': return { big, sub: '2 比 2 的最後一局：這一隊任務失敗就輸了' };
    case 'round4': return { big, sub: '第 4 局：要 2 張失敗，任務才算失敗' };
    default:
      return p.attempt === 5
        ? { big, sub: `第 ${p.round} 局前四隊都沒過，這一隊一定出發` }
        : { big, sub: `第 ${p.round} 局第 ${p.attempt} 次派隊` };
  }
}

/** 「你是 5家 忠臣」和夜裡知道的資訊（貼文「你是」那一行的前兩段）。 */
export function identityChips(pv: Pick<PickView, 'game' | 'pick' | 'view'>): [string, string] {
  const [who, info] = viewerLine(pv.game, pv.pick, pv.view.sight).split(VIEWER_SEP);
  return [who, info];
}

// ─── 比數與五局任務 ───────────────────────────────────────────────────────────

const STRIP_H = 146;

function missionStrip(pv: PickView, rows: readonly SheetRow[], y: number): string {
  const parts: string[] = [];
  const gap = 10;
  const cw = (INNER - gap * 5) / 6;
  const score = scoreOf(pv);
  // 比數
  parts.push(rect(X0, y, cw, STRIP_H, C.card, ` rx="14" stroke="${C.line}" stroke-width="2"`));
  parts.push(text(X0 + cw / 2, y + 32, '比數', { size: 24, fill: C.soft, anchor: 'middle' }));
  parts.push(segs(X0 + cw / 2, y + 92, [{ t: String(score.good), fill: C.blue, weight: true }, { t: '：', fill: C.soft }, { t: String(score.evil), fill: C.red, weight: true }], 56, 'middle').replace('<text ', '<text class="score" '));
  parts.push(segs(X0 + cw / 2, y + 128, [{ t: '好人', fill: C.blue }, { t: '　' }, { t: '壞人', fill: C.red }], 22, 'middle'));
  const current = pv.pick.proposal === null ? null : pv.game.proposals[pv.pick.proposal].round;
  for (let r = 1; r <= 5; r++) {
    const x = X0 + (cw + gap) * r;
    const mid = x + cw / 2;
    const q = rows.find((e): e is Extract<SheetRow, { kind: 'quest' }> => e.kind === 'quest' && e.round === r);
    const two = FAILS_REQUIRED[r - 1] > 1;
    if (q) {
      parts.push(rect(x, y, cw, STRIP_H, q.failed ? C.redFill : C.blueFill, ` rx="14" stroke="${q.failed ? C.red : C.blue}" stroke-width="3" class="mission mission-${q.failed ? 'failed' : 'ok'}"`));
      parts.push(text(mid, y + 32, `第 ${r} 局`, { size: 24, fill: C.ink, anchor: 'middle' }));
      parts.push(text(mid, y + 78, q.failed ? '失敗' : '成功', { size: 40, fill: q.failed ? BAD_INK : GOOD_INK, anchor: 'middle', weight: true }));
      parts.push(text(mid, y + 112, teamDigits(missionTeam(rows, r)), { size: 28, fill: C.ink, anchor: 'middle', weight: true }));
      if (q.failCount > 0) parts.push(text(mid, y + 136, `${q.failCount} 張失敗`, { size: 20, fill: BAD_INK, anchor: 'middle' }));
    } else if (r === current) {
      parts.push(rect(x, y, cw, STRIP_H, C.meFill, ` rx="14" stroke="${C.me}" stroke-width="4" class="mission mission-now"`));
      parts.push(text(mid, y + 32, `第 ${r} 局`, { size: 24, fill: C.ink, anchor: 'middle' }));
      parts.push(text(mid, y + 78, '輪到你', { size: 38, fill: C.me, anchor: 'middle', weight: true }));
      parts.push(text(mid, y + 112, `派 ${TEAM_SIZES[r - 1]} 人`, { size: 28, fill: C.ink, anchor: 'middle', weight: true }));
      if (two) parts.push(text(mid, y + 136, '要 2 張失敗', { size: 20, fill: C.soft, anchor: 'middle' }));
    } else {
      parts.push(rect(x, y, cw, STRIP_H, C.seat, ` rx="14" stroke="${C.line}" stroke-width="2"`));
      parts.push(text(mid, y + 32, `第 ${r} 局`, { size: 24, fill: C.faint, anchor: 'middle' }));
      parts.push(text(mid, y + 84, `${TEAM_SIZES[r - 1]} 人`, { size: 30, fill: C.faint, anchor: 'middle' }));
      if (two) parts.push(text(mid, y + 120, '要 2 張失敗', { size: 20, fill: C.faint, anchor: 'middle' }));
    }
  }
  return parts.join('');
}

// ─── 大圓桌 ──────────────────────────────────────────────────────────────────

/** 大圓桌：座位半徑、座位排的圓、座位旁方塊的邊長。 */
export const BIG_SEAT_R = 42;
export const BIG_RING_R = 180;
const PIP = 28;
const PIP_GAP = 3;
/** 圓桌中間標誌的半徑。 */
const BIG_LOGO_R = BIG_RING_R - BIG_SEAT_R - 10;
/** 圓桌那一塊（含兩邊的方塊和標記字）的半寬：左右兩側的座位旁最多一列三個方塊。 */
const TABLE_HALF_W = BIG_RING_R + BIG_SEAT_R + 10 + 3 * (PIP + PIP_GAP);
/** 圓桌上下各要的高度（座位＋一列方塊＋標記字）。 */
const TABLE_HALF_H = BIG_RING_R + BIG_SEAT_R + 8 + PIP + 6 + 26;

/** 座位 seat（1～10，10 = 0家）在大圓桌上的位置：0 在正上方、順時針、5 在正下方（跟牌譜卡的小圓桌一樣）。 */
export function bigSeatPosition(seat: number, cx: number, cy: number): { x: number; y: number; ux: number; uy: number } {
  const a = -Math.PI / 2 + ((seat % 10) * 2 * Math.PI) / 10;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  return { x: cx + BIG_RING_R * ux, y: cy + BIG_RING_R * uy, ux, uy };
}

/** 每個座位出過第幾局的任務、那一局成功還是失敗（只到出題那一刻）。 */
export function seatMissions(rows: readonly SheetRow[]): Map<number, { round: number; failed: boolean }[]> {
  const out = new Map<number, { round: number; failed: boolean }[]>();
  for (const q of rows) {
    if (q.kind !== 'quest') continue;
    for (const seat of missionTeam(rows, q.round)) out.set(seat, [...(out.get(seat) ?? []), { round: q.round, failed: q.failed }]);
  }
  return out;
}

function pip(x: number, y: number, m: { round: number; failed: boolean }): string {
  return (
    rect(x, y, PIP, PIP, m.failed ? '#dc2626' : '#2563eb', ` rx="6" class="pip pip-${m.failed ? 'failed' : 'ok'}"`) +
    text(x + PIP / 2, y + PIP - 7, String(m.round), { size: 21, fill: '#ffffff', anchor: 'middle', weight: true })
  );
}

/** 一列方塊，從 x 開始往右排。 */
function pipRow(x: number, y: number, ms: readonly { round: number; failed: boolean }[]): string {
  return ms.map((m, i) => pip(x + i * (PIP + PIP_GAP), y, m)).join('');
}

const pipsWidth = (n: number): number => (n > 0 ? n * PIP + (n - 1) * PIP_GAP : 0);

/** 湖中線上「好／壞」標籤的半徑，和沿著線可以放的位置（由被驗的那一頭往回試）。 */
const LAKE_LABEL_R = 21;
const LAKE_LABEL_SPOTS = [0.64, 0.46, 0.3, 0.8, 0.55, 0.38, 0.72, 0.22, 0.14, 0.88] as const;

/** 湖中女神的箭頭：拿湖的 → 被驗的，線中間寫他說的結果（好／壞／?）。最新的一次畫粗一點。 */
function bigLakeLines(rows: readonly SheetRow[], cx: number, cy: number): string {
  const lakes = rows.filter((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
  const rim = (seat: number): { x: number; y: number } => {
    const { ux, uy } = bigSeatPosition(seat, cx, cy);
    return { x: cx + BIG_LOGO_R * ux, y: cy + BIG_LOGO_R * uy };
  };
  const out: string[] = [];
  const labels: { x: number; y: number }[] = [];
  lakes.forEach((l, i) => {
    const latest = i === lakes.length - 1;
    const a = rim(l.holderSeat);
    const b = rim(l.targetSeat);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = latest ? 24 : 18;
    out.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${(b.x - Math.cos(ang) * head * 0.8).toFixed(1)}" y2="${(b.y - Math.sin(ang) * head * 0.8).toFixed(1)}" stroke="${LAKE_LINE}" stroke-opacity="${latest ? 1 : 0.65}" stroke-width="${latest ? 6 : 4}" class="lake-line"/>`);
    out.push(arrowHead(b.x, b.y, ang, LAKE_LINE, head));
    // 他說的結果寫在線上靠被驗的那一頭；會跟前面的標籤疊在一起時沿著線換一個位置
    const at = (t: number): { x: number; y: number } => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const room = (p: { x: number; y: number }): number => Math.min(Infinity, ...labels.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
    const spots = LAKE_LABEL_SPOTS.map(at);
    // 第一個不會疊到的位置；都會疊到就挑離別的標籤最遠的
    const spot = spots.find((p) => room(p) >= LAKE_LABEL_R * 2 + 4) ?? spots.reduce((best, p) => (room(p) > room(best) ? p : best));
    labels.push(spot);
    const mx = spot.x;
    const my = spot.y;
    const label = l.claim === 'o' ? { t: '好', fill: GOOD_INK } : l.claim === 'x' ? { t: '壞', fill: BAD_INK } : { t: '?', fill: C.soft };
    out.push(`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${LAKE_LABEL_R}" fill="${C.page}" stroke="${LAKE_LINE}" stroke-width="2" class="lake-claim"/>`);
    out.push(text(mx, my + 10, label.t, { size: 28, fill: label.fill, anchor: 'middle', weight: true }));
  });
  return out.join('');
}

function bigTable(pv: PickView, rows: readonly SheetRow[], cx: number, cy: number): string {
  const uri = logoDataUri();
  const parts: string[] = [];
  if (uri) {
    parts.push(
      `<defs><clipPath id="bt"><circle cx="${cx}" cy="${cy}" r="${BIG_LOGO_R}"/></clipPath></defs>` +
      `<image href="${uri}" x="${cx - BIG_LOGO_R}" y="${cy - BIG_LOGO_R}" width="${2 * BIG_LOGO_R}" height="${2 * BIG_LOGO_R}" opacity="0.3" clip-path="url(#bt)" preserveAspectRatio="xMidYMid slice"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${BIG_LOGO_R}" fill="none" stroke="${C.gold}" stroke-opacity="0.3" stroke-width="2"/>`,
    );
  }
  parts.push(bigLakeLines(rows, cx, cy));
  const marks = seatMarks(pv, rows);
  const missions = seatMissions(rows);
  const R = BIG_SEAT_R;
  for (let seat = 1; seat <= 10; seat++) {
    const { x, y, ux, uy } = bigSeatPosition(seat, cx, cy);
    const m = marks.get(seat);
    const me = seat === pv.pick.seat;
    // 你：黃圈外面再一圈光暈，一眼找到出題的那一家
    if (me) parts.push(`<circle cx="${x}" cy="${y}" r="${R + 12}" fill="${C.me}" fill-opacity="0.22" class="me-glow"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="${R}" fill="${me ? C.meFill : C.seat}"/>`);
    if (m?.side && !me && assetUri(`seat-${m.side}.png`)) {
      parts.push(`<use href="#seat-${m.side}" x="${x - R}" y="${y - R}" width="${2 * R}" height="${2 * R}" opacity="0.42" class="seat-side seat-${m.side}"/>`);
    }
    parts.push(seatRing(x, y, R, m, me ? 7 : 6));
    parts.push(text(x, y + 15, seatChar(seat), { size: 42, anchor: 'middle', weight: true, fill: me ? C.me : C.ink }).replace('<text ', `<text class="big-seat${me ? ' big-seat-me' : ''}" `));
    const ms = missions.get(seat) ?? [];
    const label = m ? { t: m.label, size: me ? 28 : 22, fill: m.color } : null;
    const lw = label ? textWidth(label.t, label.size) : 0;
    if (Math.abs(uy) < 0.45) {
      // 左右兩側的座位：標記字一行、方塊一列最多三個，整塊放在座位外側、上下置中
      const lines = [ms.slice(0, 3), ms.slice(3)].filter((r) => r.length);
      const h = (label ? label.size + 6 : 0) + lines.length * PIP + Math.max(0, lines.length - 1) * PIP_GAP;
      let ty = y - h / 2;
      const right = ux > 0;
      const edge = right ? x + R + 10 : x - R - 10;
      if (label) {
        parts.push(text(edge, ty + label.size * 0.86, label.t, { size: label.size, fill: label.fill, anchor: right ? 'start' : 'end', weight: me }));
        ty += label.size + 6;
      }
      for (const line of lines) {
        parts.push(pipRow(right ? edge : edge - pipsWidth(line.length), ty, line));
        ty += PIP + PIP_GAP;
      }
    } else {
      // 上下的座位：方塊一列貼著座位，標記字在更外面；正上、正下的置中，旁邊的往外側靠
      const up = uy < 0;
      const w = pipsWidth(ms.length);
      // 方塊多到會碰到隔壁座位（四個以上）時，旁邊的座位改成往外側靠
      const centered = Math.abs(ux) < 0.2 || ms.length <= 3;
      const startOf = (width: number): number => (centered ? x - width / 2 : ux > 0 ? x - R / 2 : x + R / 2 - width);
      const py = up ? y - R - 8 - PIP : y + R + 8;
      if (ms.length) parts.push(pipRow(startOf(w), py, ms));
      if (label) {
        const base = ms.length ? (up ? py - 8 : py + PIP + label.size) : up ? y - R - 10 : y + R + label.size + 4;
        parts.push(text(startOf(lw), base, label.t, { size: label.size, fill: label.fill, weight: me }));
      }
    }
  }
  return parts.join('');
}

// ─── 右邊：這一局已經派過的隊、湖中女神 ──────────────────────────────────────

function sideColumn(pv: PickView, rows: readonly SheetRow[], x: number, y0: number, maxW: number): string {
  const parts: string[] = [];
  let y = y0;
  const title = (s: string): void => {
    parts.push(text(x, y + 26, s, { size: 26, fill: C.soft }));
    parts.push(`<line x1="${x}" y1="${y + 38}" x2="${x + maxW}" y2="${y + 38}" stroke="${C.line}" stroke-width="2"/>`);
    y += 50;
  };
  if (pv.pick.proposal !== null) {
    const round = pv.game.proposals[pv.pick.proposal].round;
    const earlier = rows.filter((r): r is Extract<SheetRow, { kind: 'proposal' }> => r.kind === 'proposal' && r.round === round);
    title('這一局已經派過的隊');
    if (earlier.length === 0) {
      parts.push(text(x, y + 30, '還沒有，你第一個派', { size: 30, fill: C.ink }));
      y += 48;
    }
    for (const p of earlier) {
      parts.push(segs(x, y + 34, [
        { t: `${seatChar(p.leaderSeat)}家派 `, fill: C.soft },
        { t: teamDigits(p.team), fill: C.ink, weight: true },
        { t: p.approved ? '' : '　沒過', fill: C.faint },
      ], 32).replace('<text ', '<text class="round-team" '));
      y += 48;
    }
    y += 16;
  }
  const lakes = rows.filter((r): r is Extract<SheetRow, { kind: 'lake' }> => r.kind === 'lake');
  if (lakes.length) {
    title('湖中女神（箭頭）');
    for (const l of lakes) {
      const claim: Seg = l.claim === 'o' ? { t: '說是好人', fill: GOOD_INK, weight: true } : l.claim === 'x' ? { t: '說是壞人', fill: BAD_INK, weight: true } : { t: '沒說結果', fill: C.soft };
      parts.push(segs(x, y + 32, [{ t: `${seatChar(l.holderSeat)}家驗 ${seatChar(l.targetSeat)}家 `, fill: C.ink }, claim], 30).replace('<text ', '<text class="lake-row" '));
      y += 42;
      if (l.seen) {
        parts.push(text(x, y + 22, `你看到的是${l.seen === 'red' ? '壞人' : '好人'}`, { size: 24, fill: l.seen === 'red' ? C.red : C.green }));
        y += 34;
      }
    }
  }
  return parts.join('');
}

// ─── 三個選項 ────────────────────────────────────────────────────────────────

const CHIP_H = 124;

/** 一排座位小圓圈（選項裡的隊）：從 x 開始，回傳 SVG。fill＝每個座位的底色（答案卡用紅／藍）。 */
function seatDots(seats: readonly number[], x: number, cy: number, r: number, step: number, style: (seat: number) => { fill: string; stroke: string; ink: string; width: number }): string {
  return seats.map((s, i) => {
    const st = style(s);
    const sx = x + r + i * step;
    return `<circle cx="${sx}" cy="${cy}" r="${r}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.width}" class="choice-seat"/>` +
      text(sx, cy + r * 0.36, seatChar(s), { size: Math.round(r * 1.05), fill: st.ink, anchor: 'middle', weight: true });
  }).join('');
}

function letterBadge(x: number, y: number, size: number, letter: string): string {
  return rect(x, y, size, size, C.me, ` rx="${Math.round(size / 5)}"`) + text(x + size / 2, y + size * 0.77, letter, { size: Math.round(size * 0.72), fill: '#1c1917', anchor: 'middle', weight: true });
}

function choiceChips(pv: PickView, rows: readonly SheetRow[], choices: Choices, y: number): string {
  const parts: string[] = [];
  const gap = 16;
  const cw = (INNER - gap * 2) / 3;
  const marks = seatMarks(pv, rows);
  choices.items.forEach((c, i) => {
    const x = X0 + i * (cw + gap);
    parts.push(rect(x, y, cw, CHIP_H, C.card, ` rx="18" stroke="${C.me}" stroke-opacity="0.7" stroke-width="3" class="choice choice-${c.letter}"`));
    parts.push(letterBadge(x + 14, y + (CHIP_H - 66) / 2, 66, c.letter));
    const left = x + 14 + 66 + 12;
    const room = x + cw - 10 - left;
    if (choices.kind === 'assassin') {
      parts.push(text(left + room / 2, y + CHIP_H / 2 + 20, `${seatChar(c.seats[0])}家`, { size: 56, fill: C.ink, anchor: 'middle', weight: true }));
      return;
    }
    const step = Math.min(56, Math.floor(room / c.seats.length));
    const r = Math.floor(step / 2) - 2;
    const used = step * (c.seats.length - 1) + 2 * r;
    parts.push(seatDots(c.seats, left + (room - used) / 2, y + CHIP_H / 2, r, step, (s) => {
      const m: SeatMark | undefined = marks.get(s);
      const stroke = s === pv.pick.seat ? C.me : m?.split ? C.soft : m ? m.color : C.line;
      return { fill: s === pv.pick.seat ? C.meFill : C.seat, stroke, ink: C.ink, width: m ? 4 : 2 };
    }));
  });
  return parts.join('');
}

/** 題目卡上的字（不含座位號碼、牌譜數字）：測試用它檢查內文沒有超過四十個中文字左右。 */
export function cardBodyText(pv: PickView): string[] {
  const q = cardQuestion(pv);
  const [who, info] = identityChips(pv);
  return [q.big, q.sub, who, info];
}

/** 題目卡底下固定的記號說明（每天一樣）。 */
export const CARD_LEGEND: readonly string[] = [
  '黃圈＝你｜藍圈、紅圈＝你確定的好人、壞人｜箭頭＝湖中女神驗了誰（好／壞是他說的）',
  '座位旁的方塊＝出過第幾局的任務（藍＝成功、紅＝失敗）｜整份牌譜在下一張（往右滑）',
];

/** 題目卡（輪播第 1 張）的 SVG。weekday 目前不影響內容（標題用題目本身），留著跟其他圖同一個介面。 */
export function buildPuzzleSvg(pv: PickView, weekday: number): string {
  void weekday;
  const rows = sheetRows(pv);
  const parts: string[] = [headerBand(headerTitle(cardLabel(pv), pv.pick.gameId))];
  const q = cardQuestion(pv);
  // 問題：一行大字
  const qSize = fitSize(q.big, 80, INNER, 56);
  parts.push(text(X0, HEADER_H + 94, q.big, { size: qSize, fill: C.ink, weight: true }).replace('<text ', '<text class="question" '));
  parts.push(text(X0, HEADER_H + 146, q.sub, { size: fitSize(q.sub, 34, INNER, 24), fill: C.soft }).replace('<text ', '<text class="question-sub" '));
  // 你是誰（黃框）＋夜裡知道的資訊（灰框）
  const [who, info] = identityChips(pv);
  const pad = 18;
  const chipGap = 14;
  let idSize = 34;
  while (idSize > 22 && textWidth(who, idSize) + textWidth(info, idSize) + pad * 4 + chipGap > INNER) idSize -= 1;
  const iy = HEADER_H + 168;
  const ih = 58;
  const w1 = textWidth(who, idSize) + pad * 2;
  const w2 = textWidth(info, idSize) + pad * 2;
  parts.push(rect(X0, iy, w1, ih, C.meFill, ` rx="12" stroke="${C.me}" stroke-width="3"`));
  parts.push(text(X0 + pad, iy + ih / 2 + idSize * 0.36, who, { size: idSize, fill: C.me, weight: true }).replace('<text ', '<text class="identity" '));
  parts.push(rect(X0 + w1 + chipGap, iy, w2, ih, C.card, ` rx="12" stroke="${C.line}" stroke-width="2"`));
  parts.push(text(X0 + w1 + chipGap + pad, iy + ih / 2 + idSize * 0.36, info, { size: idSize, fill: C.ink }).replace('<text ', '<text class="identity-info" '));
  // 比數與五局任務
  const sy = iy + ih + 16;
  parts.push(missionStrip(pv, rows, sy));
  // 大圓桌（左）與這一局、湖中女神（右）
  const tableTop = sy + STRIP_H + 6;
  const cx = X0 + TABLE_HALF_W;
  const cy = tableTop + TABLE_HALF_H;
  parts.push(bigTable(pv, rows, cx, cy));
  const sx = cx + TABLE_HALF_W + 16;
  parts.push(sideColumn(pv, rows, sx, tableTop + 14, W - X0 - sx));
  // 三個選項
  const choices = choicesFor(pv);
  const chy = cy + TABLE_HALF_H + 8;
  parts.push(choiceChips(pv, rows, choices, chy));
  parts.push(text(W / 2, chy + CHIP_H + 38, otherChoiceLine(choices), { size: 28, fill: C.soft, anchor: 'middle' }));
  // 固定的記號說明
  let y = CARD_H - 82;
  for (const line of CARD_LEGEND) {
    parts.push(text(X0, y, line, { size: 22, fill: C.faint }));
    y += 30;
  }
  parts.push(text(X0, y, '實戰牌譜，只到出題的那一刻｜阿瓦隆百科 avalon-game-platform.web.app', { size: 22, fill: C.faint }));
  return svgDoc(CARD_H, parts.join(''), { watermark: false });
}

// ─── 答案卡 ──────────────────────────────────────────────────────────────────

const SIDE_STYLE = {
  good: { fill: C.blueFill, stroke: C.blue, ink: C.ink, width: 3 },
  evil: { fill: C.redFill, stroke: C.red, ink: C.ink, width: 3 },
} as const;

/** 答案卡最上面那一行（大字）：真人選了哪一個、結果。 */
export function answerHeadline(pv: PickView): Seg[] {
  const c = choicesFor(pv);
  const roles = pv.game.seatRoles;
  const letterOf = (seats: readonly number[]): string => c.items.find((x) => x.seats.join() === [...seats].sort((a, b) => a - b).join())?.letter ?? '';
  if (pv.pick.proposal === null) {
    const merlin = roles.indexOf('merlin') + 1;
    const l = letterOf([merlin]);
    return [{ t: '梅林是 ' }, ...(l ? [{ t: `${l} `, fill: C.me, weight: true }] : []), { t: `${seatChar(merlin)}家`, fill: GOOD_INK, weight: true }];
  }
  const p = pv.game.proposals[pv.pick.proposal];
  const reds = p.teamSeats.filter((s) => isRed(roles[s - 1])).length;
  const q = pv.game.quests.find((x) => x.round === p.round);
  const outcome: Seg = !p.wentOnMission
    ? { t: '，投票沒過', fill: C.soft }
    : q?.failed ? { t: '，任務失敗', fill: BAD_INK, weight: true } : { t: '，任務成功', fill: C.green, weight: true };
  const l = letterOf(p.teamSeats);
  return [
    { t: '真人選 ' },
    { t: l ? `${l} ${teamDigits(p.teamSeats)}` : teamDigits(p.teamSeats), fill: C.me, weight: true },
    { t: '：' },
    { t: `${p.teamSeats.length - reds} 好 ${reds} 壞`, fill: reds ? BAD_INK : GOOD_INK, weight: true },
    outcome,
  ];
}

/** 一題的答案：題目一行、真人選了什麼（大字）、三個選項的真相、一句話理由。brief＝只畫前兩行（一起公布的前一題）。 */
function answerBlock(pv: PickView, y0: number, brief: boolean): { svg: string; bottom: number } {
  const parts: string[] = [];
  let y = y0;
  const [who] = identityChips(pv);
  const caption = pv.pick.proposal === null ? `刺殺題｜${who}` : `${cardLabel(pv)}｜${who}｜${cardQuestion(pv).big}`;
  parts.push(text(X0, y + 30, caption, { size: fitSize(caption, 30, INNER, 22), fill: C.soft }));
  y += 52;
  const head = answerHeadline(pv);
  const headSize = fitSize(head.map((g) => g.t).join(''), brief ? 52 : 68, INNER, 40);
  parts.push(segs(X0, y + headSize * 0.9, head, headSize).replace('<text ', '<text class="answer-head" '));
  y += headSize + 22;
  if (pv.pick.proposal === null && pv.game.assassinTargetSeat) {
    const target = pv.game.assassinTargetSeat;
    const hit = pv.game.seatRoles[target - 1] === 'merlin';
    parts.push(segs(X0, y + 38, [{ t: `真人刺 ${seatChar(target)}家：` }, { t: hit ? '刺中，壞人逆轉' : '沒刺中，好人贏', fill: hit ? BAD_INK : C.green, weight: true }], 42));
    y += 60;
  }
  if (brief) return { svg: parts.join(''), bottom: y };
  const c = choicesFor(pv);
  const roles = pv.game.seatRoles;
  const rowH = 76;
  for (const r of choiceReveal(pv, c)) {
    const merlin = c.kind === 'assassin' && roles[r.seats[0] - 1] === 'merlin';
    const hot = c.kind === 'assassin' ? merlin : r.real;
    parts.push(rect(X0, y, INNER, rowH - 8, hot ? C.meFill : C.card, ` rx="14" stroke="${hot ? C.me : C.line}" stroke-width="${hot ? 3 : 2}" class="answer-choice${r.real ? ' answer-real' : ''}"`));
    parts.push(letterBadge(X0 + 12, y + 8, rowH - 24, r.letter));
    const dx = X0 + 12 + rowH - 24 + 18;
    const mid = y + (rowH - 8) / 2;
    parts.push(seatDots(r.seats, dx, mid, 24, 54, (s) => (isRed(roles[s - 1]) ? SIDE_STYLE.evil : SIDE_STYLE.good)));
    const tx = dx + 54 * 5 + 10;
    const words: Seg[] = c.kind === 'assassin'
      ? [{ t: ROLE_ZH[roles[r.seats[0] - 1]], fill: merlin ? GOOD_INK : C.ink, weight: merlin }]
      : [{ t: r.reds.length ? `${r.seats.length - r.reds.length} 好 ${r.reds.length} 壞` : '全是好人', fill: r.reds.length ? BAD_INK : GOOD_INK, weight: true }];
    parts.push(segs(c.kind === 'assassin' ? dx + 70 : tx, mid + 13, words, 36));
    if (r.real) parts.push(text(W - X0 - 18, mid + 11, c.kind === 'assassin' ? '真人刺這一家' : '真人選這一隊', { size: 30, fill: C.me, anchor: 'end', weight: true }));
    y += rowH;
  }
  const why = reasonSentence(pv);
  if (why) {
    y += 6;
    // 一句話、分號前後各一行（手機上字才夠大）
    for (const line of why.split('；')) {
      const size = fitSize(line, 30, INNER, 22);
      parts.push(text(X0, y + 30, line, { size, fill: C.soft }).replace('<text ', '<text class="answer-why" '));
      y += 40;
    }
  }
  return { svg: parts.join(''), bottom: y };
}

/**
 * 答案卡：昨天那一題真人選了哪一個（大字）＋三個選項的真相＋一句話理由，下面是角色（紅方在上、藍方在下；
 * 站長 11/17「腳色順序應該是 刺娜德奧派梅」）和這一局的結果。earlier＝一起公布的前一題（週三 1-5＋週四 3-5），只畫真人那一行。
 * ids = 這一局這幾天出過的題號（標題用）。
 */
export function buildAnswerSvg(pv: PickView, ids: readonly string[] = [pv.exerciseId], earlier?: PickView): string {
  const roles = pv.game.seatRoles;
  const seatOf = (role: string): number[] => roles.flatMap((r, i) => (r === role ? [i + 1] : []));
  // 這一局這幾天出過的題（週三 1-5＋週四 3-5 一起公布）：「1-5、3-5」；只有一題就用那一題的標題
  const codes = ids.map((id) => (id.startsWith(`${pv.pick.gameId}-`) ? id.slice(pv.pick.gameId.length + 1) : id)).map((c) => (c === 'A' ? '刺殺' : c));
  const label = ids.length > 1 ? codes.join('、') : cardLabel(pv);
  const parts: string[] = [headerBand(headerTitle(label, pv.pick.gameId, '答案'))];
  let y = HEADER_H + 26;
  if (earlier) {
    const b = answerBlock(earlier, y, true);
    parts.push(b.svg);
    y = b.bottom + 8;
    parts.push(`<line x1="${X0}" y1="${y}" x2="${W - X0}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
    y += 20;
  }
  const main = answerBlock(pv, y, false);
  parts.push(main.svg);
  y = main.bottom + 22;
  // 角色：紅方一格在上（刺娜德奧）、藍方一格在下（派梅），一格一行
  const box = (title: string, items: string[], fill: string, ink: string): void => {
    const line = items.join('　');
    const size = fitSize(line, 38, INNER - 150, 26);
    parts.push(rect(X0, y, INNER, 84, fill, ` rx="16" fill-opacity="0.8" stroke="${ink}" stroke-width="2"`));
    parts.push(text(X0 + 24, y + 54, title, { size: 28, fill: ink }));
    parts.push(text(X0 + 126, y + 42 + size * 0.36, line, { size, fill: C.ink, weight: true }).replace('<text ', '<text class="roles" '));
    y += 98;
  };
  const roleItems = (list: readonly string[]): string[] => list.flatMap((r) => seatOf(r).map((s) => `${ROLE_ZH[r as keyof typeof ROLE_ZH]} ${seatChar(s)}家`));
  box('紅方', roleItems(['assassin', 'morgana', 'mordred', 'oberon', 'minion']), C.redFill, C.red);
  box('藍方', roleItems(['percival', 'merlin']), C.blueFill, C.blue);
  y += 40;
  parts.push(text(X0, y, `結果：${resultText(pv.game)}`, { size: 36, fill: C.yellow, weight: true }));
  y += 46;
  parts.push(text(X0, y, '其他座位是忠臣｜紅圈＝壞人、藍圈＝好人｜阿瓦隆百科 avalon-game-platform.web.app', { size: 22, fill: C.faint }));
  y += 30;
  return svgDoc(y, parts.join(''));
}

/** 題目卡 PNG。 */
export function renderPuzzlePng(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer {
  return svgToPng(buildPuzzleSvg(pv, weekday), opts.fontFile ?? WEEKLY_CHART_FONT_FILE);
}

/** 答案圖 PNG（公布完整答案的日子才附）。 */
export function renderAnswerPng(pv: PickView, ids?: readonly string[], opts: { fontFile?: string; earlier?: PickView } = {}): Buffer {
  return svgToPng(buildAnswerSvg(pv, ids, opts.earlier), opts.fontFile ?? WEEKLY_CHART_FONT_FILE);
}

export { CHOICE_LETTERS };
