/**
 * Threads 每日出題（2026-11-17）— 題目的圖：座位、你的視角、任務進度、到目前的牌譜、輪到你做什麼。
 *
 * SVG 用字型檔（和每週排行圖同一個 Noto Sans TC，assets/fonts/）在 @resvg/resvg-js 轉 PNG，不用系統字型。
 * 1080 寬（手機一屏），高度照牌譜行數；牌譜超過 22 行改兩欄。
 * 圖裡只有座位和牌譜記號，沒有玩家名字。
 */

import fs from 'fs';
import { WEEKLY_CHART_FONT_FAMILY, WEEKLY_CHART_FONT_FILE, escapeXml } from '../stats/weeklyChart';
import { ROLE_ZH } from '../simulation/commands';
import { eventLines } from '../simulation/replies';
import { FAILS_REQUIRED, TEAM_SIZES, type PublicEvent } from '../simulation/scenario';
import { seatChar } from '../simulation/seats';
import type { PickView } from './draft';
import { labelFor } from './plan';

const W = 1080;
const C = {
  page: '#f7f5f0',
  ink: '#1f2328',
  soft: '#5b6470',
  header: '#1f2a44',
  headerInk: '#ffffff',
  blue: '#2f6fd1',
  red: '#c8453b',
  gold: '#c79a2b',
  seat: '#ffffff',
  line: '#d9d4c7',
};

function text(x: number, y: number, s: string, o: { size: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: boolean }): string {
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  const stroke = o.weight ? ` stroke="${o.fill ?? C.ink}" stroke-width="0.8"` : '';
  return `<text x="${x}" y="${y}" font-size="${o.size}" fill="${o.fill ?? C.ink}"${anchor}${stroke}>${escapeXml(s)}</text>`;
}

/** 每個座位的標記：你、拇指、看到的紅、隊友、自己湖到的。 */
function seatMarks(pv: PickView): Map<number, { label: string; color: string }> {
  const marks = new Map<number, { label: string; color: string }>();
  const s = pv.view.sight;
  if (s.kind === 'percival') s.thumbs.forEach((t) => marks.set(t, { label: '拇指', color: C.gold }));
  if (s.kind === 'merlin') s.seen.forEach((t) => marks.set(t, { label: '紅', color: C.red }));
  if (s.kind === 'evil') s.mates.forEach((t) => marks.set(t, { label: '隊友', color: C.red }));
  // 自己湖到的：已經有標記（隊友、看到的紅、拇指）的座位不蓋掉。
  for (const l of pv.view.ownLakes) {
    if (!marks.has(l.targetSeat)) marks.set(l.targetSeat, { label: l.evil ? '湖到紅' : '湖到好', color: l.evil ? C.red : C.blue });
  }
  marks.set(pv.pick.seat, { label: '你', color: C.blue });
  return marks;
}

/** 估一行字的寬度（中文字約一個字級寬，英數約 0.56）。 */
export function textWidth(line: string, size: number): number {
  let w = 0;
  for (const ch of line) w += (ch.codePointAt(0) ?? 0) <= 0x24f ? size * 0.56 : size;
  return w;
}

/** 斷行後第二段的縮排（全形空白）。 */
const INDENT = '\u3000';

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

function missionBoxes(shown: readonly PublicEvent[], y: number): string {
  const parts: string[] = [];
  const bw = 180;
  const gap = (W - 80 - bw * 5) / 4;
  for (let r = 1; r <= 5; r++) {
    const x = 40 + (r - 1) * (bw + gap);
    const q = shown.find((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest' && e.round === r);
    const fill = q ? (q.failed ? C.red : C.blue) : C.seat;
    const ink = q ? '#ffffff' : C.soft;
    parts.push(`<rect x="${x}" y="${y}" width="${bw}" height="96" rx="16" fill="${fill}" stroke="${C.line}" stroke-width="2"/>`);
    parts.push(text(x + bw / 2, y + 38, `第 ${r} 局・${TEAM_SIZES[r - 1]} 人`, { size: 26, fill: ink, anchor: 'middle' }));
    const sub = q ? `${'o'.repeat(q.successCount)}${'x'.repeat(q.failCount)}` : FAILS_REQUIRED[r - 1] > 1 ? '要 2 張失敗' : '';
    parts.push(text(x + bw / 2, y + 78, sub, { size: 28, fill: ink, anchor: 'middle', weight: !!q }));
  }
  return parts.join('');
}

/** 題目圖的 SVG（weekday = 今天的星期，決定標題）。 */
export function buildPuzzleSvg(pv: PickView, weekday: number): string {
  const role = pv.game.seatRoles[pv.pick.seat - 1];
  const parts: string[] = [];
  let y = 0;

  // 標題列
  parts.push(`<rect x="0" y="0" width="${W}" height="150" fill="${C.header}"/>`);
  parts.push(text(40, 64, '阿瓦隆每日一題', { size: 40, fill: C.headerInk, weight: true }));
  parts.push(text(40, 118, labelFor(weekday, pv.pick), { size: 32, fill: '#c9d4ea' }));
  parts.push(text(W - 40, 118, pv.exerciseId, { size: 28, fill: '#c9d4ea', anchor: 'end' }));
  y = 150;

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
    parts.push(`<circle cx="${cx}" cy="${cy}" r="40" fill="${C.seat}" stroke="${m ? m.color : C.line}" stroke-width="${m ? 6 : 2}"/>`);
    parts.push(text(cx, cy + 14, seatChar(seat), { size: 40, anchor: 'middle', weight: true }));
    if (m) parts.push(text(cx, cy + 82, m.label, { size: 24, fill: m.color, anchor: 'middle' }));
  }
  y += 150;

  // 任務
  parts.push(missionBoxes(pv.shown, y));
  y += 130;

  // 牌譜
  const noPrior = !pv.shown.some((e) => e.kind === 'proposal');
  const raw = noPrior ? ['第 1 局第一個隊長，前面沒有派票'] : eventLines(pv.shown, pv.pick.seat, pv.game);
  const twoCols = raw.length > 22;
  const size = twoCols ? 26 : 30;
  const lh = twoCols ? 40 : 44;
  const lines = raw.flatMap((l) => wrapLine(l, size, twoCols ? W / 2 - 60 : W - 80));
  const perCol = twoCols ? Math.ceil(lines.length / 2) : lines.length;
  parts.push(`<line x1="40" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  y += 50;
  lines.forEach((line, i) => {
    const col = twoCols && i >= perCol ? 1 : 0;
    const row = col ? i - perCol : i;
    const isHeader = /^第 \d 局：$/.test(line);
    parts.push(text(40 + col * (W / 2), y + row * lh, line, { size, fill: isHeader ? C.soft : C.ink, weight: isHeader }));
  });
  y += perCol * lh + 20;

  // 輪到你
  parts.push(`<line x1="40" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);
  y += 64;
  let prompt: string;
  if (pv.pick.proposal === null) prompt = '三藍：輪到你刺殺。誰是梅林？';
  else {
    const p = pv.game.proposals[pv.pick.proposal];
    prompt = `輪到你派 ${TEAM_SIZES[p.round - 1]} 人（第 ${p.round} 局第 ${p.attempt} 次${p.attempt === 5 ? '，強制出發' : ''}）`;
  }
  parts.push(text(40, y, prompt, { size: 36, fill: C.blue, weight: true }));
  y += 56;
  parts.push(text(40, y, '記號：+ 隊外投贊成、- 隊內投反對；o 成功、x 失敗；0 家寫 0', { size: 24, fill: C.soft }));
  y += 40;
  parts.push(text(40, y, '實戰牌譜｜阿瓦隆百科 avalon-game-platform.web.app', { size: 24, fill: C.soft }));
  y += 40;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${WEEKLY_CHART_FONT_FAMILY}">` +
    `<rect x="0" y="0" width="${W}" height="${y}" fill="${C.page}"/>` +
    parts.join('') +
    '</svg>'
  );
}

/** SVG → PNG（只用內附的字型）。字型檔或原生套件不在時丟錯，呼叫端改成不附圖。 */
export function renderPuzzlePng(pv: PickView, weekday: number, opts: { fontFile?: string } = {}): Buffer {
  const fontFile = opts.fontFile ?? WEEKLY_CHART_FONT_FILE;
  if (!fs.existsSync(fontFile)) throw new Error(`threads image font missing: ${fontFile}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  const resvg = new Resvg(buildPuzzleSvg(pv, weekday), {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: WEEKLY_CHART_FONT_FAMILY },
    background: C.page,
  });
  return resvg.render().asPng();
}
