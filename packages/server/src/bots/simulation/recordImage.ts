/**
 * 模擬瓦 /公布 附的整局牌譜圖（Edward 2026-11-17：公布只要三行文字，再附網站牌譜格子風格的整局牌譜圖）。
 *
 * 跟 Threads 的牌譜圖（bots/threads/image.ts 的 buildGridSvg，PR #52）同一種畫法：深色卡片、阿瓦隆百科浮水印、
 * 網站牌譜頁的格子（隊長｜座位 1～0｜結果｜文字紀錄），盾牌 = 上隊，白／黑格 = 贊成／反對，任務列、湖中列。
 * 不同的是這裡畫**整局**（/公布 之後，沒有不能看的）、欄名寫每一家的角色（紅方紅字）；只寫座位和角色，不寫玩家名字。
 * 純函式出 SVG；PNG 用專案內附的字型（resvg），字型或原生套件不在時丟錯，呼叫端改成不附圖。
 */
import fs from 'fs';
import path from 'path';
import { WEEKLY_CHART_FONT_FAMILY, WEEKLY_CHART_FONT_FILE, escapeXml } from '../stats/weeklyChart';
import { publicEvents, isRed, type SimGame } from './scenario';
import { seatChar, teamDigits } from './seats';

const W = 1080;
const C = {
  page: '#131316',
  ink: '#f4f4f5',
  soft: '#a1a1aa',
  faint: '#71717a',
  header: '#1f2a44',
  headerInk: '#ffffff',
  headerSoft: '#c9d4ea',
  red: '#f87171',
  green: '#4ade80',
  line: '#3f3f46',
};

/** 欄名的角色字（刺娜莫奧派梅忠）。 */
const ROLE_CHAR: Record<string, string> = {
  assassin: '刺', morgana: '娜', mordred: '莫', oberon: '奧', percival: '派', merlin: '梅', loyal: '忠',
};

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

/** 阿瓦隆百科的標誌（packages/web/public/logo.png 的複本，跟 Threads 共用同一個檔）。 */
export const SIM_LOGO_FILE = path.resolve(__dirname, '..', '..', '..', 'assets', 'threads', 'logo.png');

let logoUri: string | null | undefined;
function logoDataUri(): string | null {
  if (logoUri === undefined) logoUri = fs.existsSync(SIM_LOGO_FILE) ? `data:image/png;base64,${fs.readFileSync(SIM_LOGO_FILE).toString('base64')}` : null;
  return logoUri;
}

function shield(cx: number, cy: number, size: number): string {
  const k = size / 24;
  const tx = cx - 12 * k;
  const ty = cy - 12 * k;
  return `<path transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(3)})" d="M12 2 L20 5 V11 C20 16.5 16.5 20.5 12 22 C7.5 20.5 4 16.5 4 11 V5 Z" fill="#facc15" stroke="#1c1917" stroke-width="1.2"/>`;
}

/** 這局的結果：三紅／三藍死／三藍活（照紀錄）。 */
export function originalResult(game: SimGame): string {
  const fails = game.quests.filter((q) => q.failed).length;
  if (fails >= 3) return '三紅';
  return game.winner === 'evil' ? '三藍死' : '三藍活';
}

/** 整局牌譜圖的 SVG。`title` = 題號（標題列右邊）。 */
export function buildRecordSvg(game: SimGame, title: string): string {
  const events = publicEvents(game);
  const rows = events.length;
  const rh = Math.max(34, Math.min(56, Math.floor((1350 - 150 - 90 - 110) / Math.max(1, rows))));
  const fs = Math.max(18, Math.min(26, Math.round(rh * 0.5)));
  const x0 = 40;
  const leadW = 64;
  const resW = 100;
  const textW = 220;
  const seatW = (W - 80 - leadW - resW - textW) / 10;
  const seatX = (seat: number): number => x0 + leadW + seatW * (seat - 1);
  const resX = x0 + leadW + seatW * 10;
  const textX = resX + resW;
  const uri = logoDataUri();
  const parts: string[] = [];

  // 標題列
  parts.push(rect(0, 0, W, 150, C.header));
  if (uri) {
    parts.push(`<defs><clipPath id="hl"><rect x="${W - 142}" y="24" width="102" height="102" rx="18"/></clipPath></defs>`);
    parts.push(`<image href="${uri}" x="${W - 142}" y="24" width="102" height="102" clip-path="url(#hl)"/>`);
  }
  parts.push(text(40, 64, '模擬瓦・完整牌譜', { size: 40, fill: C.headerInk, weight: true }));
  parts.push(text(40, 118, `${originalResult(game)}｜${title}`, { size: 30, fill: C.headerSoft }));

  // 欄名：座位＋角色
  let y = 150 + 12;
  const hy = y + 30;
  parts.push(text(x0 + leadW / 2, hy + 14, '隊長', { size: 22, fill: C.faint, anchor: 'middle' }));
  for (let seat = 1; seat <= 10; seat++) {
    const role = game.seatRoles[seat - 1];
    const red = isRed(role);
    const cx = seatX(seat) + seatW / 2;
    parts.push(text(cx, hy, seatChar(seat), { size: 26, fill: C.ink, anchor: 'middle', weight: true }));
    parts.push(text(cx, hy + 32, ROLE_CHAR[role] ?? '', { size: 24, fill: red ? C.red : '#93c5fd', anchor: 'middle', weight: true }));
  }
  parts.push(text(resX + resW / 2, hy + 14, '結果', { size: 22, fill: C.faint, anchor: 'middle' }));
  parts.push(text(textX + 12, hy + 14, '文字紀錄', { size: 22, fill: C.faint }));
  y += 76;
  parts.push(`<line x1="${x0}" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.line}" stroke-width="2"/>`);

  for (const e of events) {
    const mid = y + rh / 2 + fs * 0.36;
    if (e.kind === 'proposal') {
      parts.push(rect(x0, y, leadW, rh, '#09090b'));
      parts.push(text(x0 + leadW / 2, mid, seatChar(e.leaderSeat), { size: fs, fill: '#facc15', anchor: 'middle', weight: true }));
      let approves = 0;
      for (let seat = 1; seat <= 10; seat++) {
        const on = e.teamSeats.includes(seat);
        const approve = e.forced ? null : on ? !e.minusSeats.includes(seat) : e.plusSeats.includes(seat);
        if (approve) approves += 1;
        const fill = approve === null ? '#18181b' : approve ? '#ffffff' : '#000000';
        parts.push(rect(seatX(seat), y, seatW, rh, fill, ` stroke="#27272a" stroke-width="1"${e.votesReliable || e.forced ? '' : ' fill-opacity="0.6"'}`));
        if (on) parts.push(shield(seatX(seat) + seatW / 2, y + rh / 2, Math.min(seatW, rh) - 6));
      }
      const res = e.forced ? '強制' : `${approves}票${e.approved ? '過' : ''}`;
      parts.push(text(resX + resW / 2, mid, res, { size: fs - 2, fill: e.forced ? '#fcd34d' : e.approved ? '#6ee7b7' : C.faint, anchor: 'middle' }));
      const marks = [e.minusSeats.length ? `${teamDigits(e.minusSeats)}-` : '', e.plusSeats.length ? `${teamDigits(e.plusSeats)}+` : ''].filter(Boolean).join(' ');
      const seg: Seg[] = [{ t: teamDigits(e.teamSeats) }];
      if (marks) seg.push({ t: ` ${marks}`, fill: C.green, weight: true });
      parts.push(segs(textX + 12, mid, seg, fs));
    } else if (e.kind === 'quest') {
      const mission = 'o'.repeat(e.successCount) + 'x'.repeat(e.failCount);
      parts.push(rect(x0, y, W - 80, rh, '#422006', ' fill-opacity="0.75"'));
      parts.push(rect(x0, y, leadW, rh, '#713f12'));
      parts.push(text(x0 + leadW / 2, mid, '任務', { size: fs - 4, fill: '#fef08a', anchor: 'middle', weight: true }));
      const dots = [...mission].map((c) => (c === 'x' ? { t: '●', fill: '#ef4444' } : { t: '●', fill: '#3b82f6' }));
      const verdict = e.failed ? `失敗（${e.failCount} 張）` : e.failCount ? `成功（${e.failCount} 張失敗）` : '成功';
      parts.push(segs(seatX(1) + seatW * 5, mid, [{ t: `第 ${e.round} 輪任務 `, fill: '#fef9c3', weight: true }, ...dots, { t: ` ${verdict}`, fill: e.failed ? '#fca5a5' : '#93c5fd', weight: true }], fs - 2, 'middle'));
      parts.push(rect(resX + 6, y + 4, resW - 12, rh - 8, e.failed ? '#dc2626' : '#2563eb', ' rx="6"'));
      parts.push(text(resX + resW / 2, mid, mission, { size: fs - 2, fill: '#ffffff', anchor: 'middle', weight: true }));
      parts.push(text(textX + 12, mid, mission, { size: fs, fill: e.failed ? '#fca5a5' : '#93c5fd', weight: true }));
    } else {
      parts.push(rect(x0, y, W - 80, rh, '#083344', ' fill-opacity="0.8"'));
      parts.push(rect(x0, y, leadW, rh, '#164e63'));
      parts.push(text(x0 + leadW / 2, mid, '湖中', { size: fs - 4, fill: '#a5f3fc', anchor: 'middle', weight: true }));
      const claim = e.claim === 'good' ? { t: '宣告藍', fill: '#bfdbfe' } : e.claim === 'evil' ? { t: '宣告紅', fill: '#fca5a5' } : { t: '沒說', fill: C.soft };
      parts.push(segs(seatX(1) + seatW * 5, mid, [{ t: `${seatChar(e.holderSeat)} 家 驗 ${seatChar(e.targetSeat)} 家 → `, fill: '#ecfeff' }, { ...claim, weight: true }], fs - 2, 'middle'));
      const ll = `${seatChar(e.holderSeat)}>${seatChar(e.targetSeat)}${e.claim === 'good' ? ' o' : e.claim === 'evil' ? ' x' : ''}`;
      parts.push(rect(resX + 6, y + 4, resW - 12, rh - 8, '#0891b2', ' rx="6"'));
      parts.push(text(resX + resW / 2, mid, ll, { size: fs - 2, fill: '#ffffff', anchor: 'middle', weight: true }));
      parts.push(text(textX + 12, mid, ll, { size: fs, fill: '#a5f3fc' }));
    }
    y += rh;
  }
  if (game.assassinTargetSeat) {
    y += 12;
    parts.push(text(x0, y + 28, `刺殺：刺 ${seatChar(game.assassinTargetSeat)} 家（${game.winner === 'evil' ? '刺中梅林' : '沒刺中'}）`, { size: 26, fill: C.ink, weight: true }));
    y += 40;
  }
  y += 34;
  parts.push(text(x0, y, '盾牌 = 上隊｜白 = 贊成、黑 = 反對、灰 = 強制局不投票｜文字：+ 隊外贊成、- 隊內反對', { size: 22, fill: C.faint }));
  y += 34;
  parts.push(text(x0, y, '實戰牌譜｜阿瓦隆百科 avalon-game-platform.web.app', { size: 22, fill: C.faint }));
  y += 30;
  const height = Math.max(y, 600);
  const size = Math.min(W - 80, height - 150 - 80);
  const wx = (W - size) / 2;
  const wy = 150 + (height - 150 - size) / 2;
  const watermark = uri && size > 200
    ? `<defs><clipPath id="wm"><rect x="${wx}" y="${wy}" width="${size}" height="${size}" rx="${size / 10}"/></clipPath></defs>`
      + `<image href="${uri}" x="${wx}" y="${wy}" width="${size}" height="${size}" opacity="0.1" clip-path="url(#wm)" preserveAspectRatio="xMidYMid slice"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${WEEKLY_CHART_FONT_FAMILY}">`
    + rect(0, 0, W, height, C.page) + watermark + parts.join('') + '</svg>';
}

const pngCache = new Map<string, Buffer>();

/** 整局牌譜圖 PNG（同一局快取，最多 64 張）。 */
export function renderRecordPng(game: SimGame, title: string, opts: { fontFile?: string } = {}): Buffer {
  const key = `${game.id}|${title}`;
  const hit = pngCache.get(key);
  if (hit) return hit;
  const fontFile = opts.fontFile ?? WEEKLY_CHART_FONT_FILE;
  if (!fs.existsSync(fontFile)) throw new Error(`sim record image font missing: ${fontFile}`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js') as typeof import('@resvg/resvg-js');
  const png = new Resvg(buildRecordSvg(game, title), {
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: WEEKLY_CHART_FONT_FAMILY },
    background: C.page,
  }).render().asPng();
  if (pngCache.size >= 64) pngCache.delete(pngCache.keys().next().value as string);
  pngCache.set(key, png);
  return png;
}
