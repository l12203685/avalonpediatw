/**
 * 牌譜更正指令 /更正（Edward 2026-11-17：玩家要能對有問題的牌譜送出更正；claude.ai 頁面外人只能看，所以走機器人）——
 * LINE 文字指令與 Discord 斜線指令共用的解析與回覆文字。
 *
 *   LINE    /更正 局號              → 這局的 DC 牌譜文字、1家…0家、檢查出來的問題、網站連結、怎麼送更正
 *           /更正 局號 內容…        → 送出更正（可以多行：整份改好的牌譜，或「第一局是 158」）
 *   Discord /更正 局號:… 內容:…     （內容不填＝查這局）
 *
 * 送出跟 /回報 同一條路（services/communityReports.submitReport，類型 correction）：貼到 DC 同步閒聊＋LINE 群組，
 * 「【百科回報・牌譜更正】#R… [更正] 局號」＋內容＋（來自 LINE／DC・送出的人），每日例行作業
 * scripts/listCommunityReports.ts 讀得到（kind: correction）。站長確認後才改總庫。
 * 跟 /回報 一樣：指令那句不同步、回覆不同步到另一邊（貼出去的那則 bot 已經直接貼到兩邊）。
 */

import { lookupRecord, normaliseRecordId, type LookupGame, type RecordLookup } from '../../services/recordLookup';
import { FEEDBACK_MESSAGE_MAX, reportMessageFits, submitReport, type FeedbackReport, type ReportSource, type SyncDeps } from '../../services/communityReports';
import { recordUrl } from '../simulation/recordsIndex';
import { SUBMIT_REDELIVERY_TEXT, submitResultText, type ReportPlatform } from '../reports/commands';
import { parseCorrectionText, type CorrectionCommand } from './parse';

export { parseCorrectionText, isCorrectionCommandText, type CorrectionCommand } from './parse';

export const CORRECTION_USAGE: Record<ReportPlatform, string> = {
  line: '/更正 局號 [更正內容]',
  discord: '/更正 局號 [內容]',
};
export const CORRECTION_HELP_TEXT = '查一局牌譜（含檢查出來的問題），或送出更正給站長';
export const CORRECTION_RECEIVED_TEXT = '收到，站長確認後才會改';
export const CORRECTION_RATE_LIMITED_TEXT = '查得太頻繁了，請過幾分鐘再試。';
/** 送出的內容最多幾字（同 /回報）。 */
export const CORRECTION_MAX = FEEDBACK_MESSAGE_MAX;

/** 查詢的頻率限制：每個人 10 分鐘 20 次（送出另有 /回報 的限制）。 */
export const LOOKUP_LIMITS = { perUser: 20, windowMs: 10 * 60_000 } as const;
const lookups = new Map<string, number[]>();

function allowLookup(userKey: string | undefined, now: number): boolean {
  if (!userKey) return true;
  const mine = (lookups.get(userKey) ?? []).filter((t) => now - t < LOOKUP_LIMITS.windowMs);
  if (mine.length >= LOOKUP_LIMITS.perUser) { lookups.set(userKey, mine); return false; }
  mine.push(now);
  lookups.set(userKey, mine);
  if (lookups.size > 5000) lookups.delete(lookups.keys().next().value as string);
  return true;
}

/** 測試用：查詢的頻率限制歸零。 */
export function __resetCorrectionLimitsForTests(): void {
  lookups.clear();
}

// ─── 牌譜文字（同網站的「DC 牌譜格式（文字）」，web/src/utils/records.ts recordsText） ──────────────────

const SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
const CONFIG_ROLES = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'] as const;

/** 1 家…0 家的寫法（站長的用語：「0家」不寫「10家」）。 */
export function seatName(seat: string): string {
  return `${seat}家`;
}

function proposalLine(team: string, votes: readonly string[], attemptIndex: number): string {
  if (attemptIndex === 4 && votes.length === 0) return team; // 強制局
  const marks = new Map<string, '+' | '-'>();
  for (const token of votes) {
    for (const m of token.matchAll(/([0-9]+)([+-])/g)) for (const s of m[1]) marks.set(s, m[2] as '+' | '-');
  }
  const vote = (s: string): '+' | '-' => marks.get(s) ?? (team.includes(s) ? '+' : '-');
  const black = SEATS.filter((s) => team.includes(s) && vote(s) === '-').join('');
  const white = SEATS.filter((s) => !team.includes(s) && vote(s) === '+').join('');
  return [team, black && `${black}-`, white && `${white}+`].filter(Boolean).join(' ');
}

/** 牌譜各行 → 六碼 → 刺客刺殺:X（網站 recordsText 的前半段；暱稱另外放在座位那一行）。 */
export function recordLines(game: LookupGame): string[] {
  const lakes = new Map(game.lakes.map((l) => [l.after, l]));
  const lines: string[] = [];
  game.rounds.forEach((round, i) => {
    round.proposals.forEach((p, a) => lines.push(proposalLine(p.team, p.votes, a)));
    if (round.mission) lines.push(round.mission);
    const lake = lakes.get(i + 1);
    if (lake) lines.push(`${lake.holder}>${lake.target}${lake.claim ? ` ${lake.claim}` : ''}`);
  });
  lines.push(game.config);
  lines.push(`刺客刺殺:${game.outcome === '三紅' ? '' : game.assassination}`);
  return lines;
}

/** 座位那一行：「1家 暱稱｜2家 暱稱｜…｜0家 暱稱」；沒有暱稱時寫角色（配置推得出來的）。 */
export function seatLine(r: Pick<RecordLookup, 'names' | 'game'>): string | null {
  if (r.names) return SEATS.map((s, i) => `${seatName(s)} ${r.names?.[i] || '？'}`).join('｜');
  const config = r.game?.config ?? '';
  if (!/^[0-9]{6}$/.test(config)) return null;
  return SEATS.map((s) => {
    const i = config.indexOf(s);
    return `${seatName(s)} ${i >= 0 ? CONFIG_ROLES[i] : '忠臣'}`;
  }).join('｜');
}

const KIND_LABEL: Record<RecordLookup['kind'], string> = { real: '實戰', sim: '模擬', external: '外部', '': '' };
const MAX_CHARS: Record<ReportPlatform, number> = { line: 5000, discord: 2000 };
const MAX_PROBLEMS = 8;

function escapeDiscord(text: string): string {
  return text.replace(/([\\`*_~|[\]<])/g, '\\$1');
}

export function usageText(platform: ReportPlatform): string {
  const example = platform === 'line' ? '/更正 S1794、/更正 S1794 第一局是 158' : '/更正 局號:S1794、/更正 局號:S1794 內容:第一局是 158';
  return `用法：${CORRECTION_USAGE[platform]}，例如 ${example}。局號在網站牌譜頁的網址 #records= 後面（S…、M…、或 DC 貼文 id）。只打局號是查這局；後面加內容是送更正給站長。`;
}

export function unknownIdText(raw: string): string {
  const id = normaliseRecordId(raw);
  return `找不到局號「${id || raw.slice(0, 40)}」。局號在網站牌譜頁的網址 #records= 後面，例如 S1794、M536，或 DC 貼文 id。`;
}

/** 查詢的回覆：標頭、牌譜文字、座位、問題、網站連結、送更正的寫法。 */
export function formatRecordReply(r: RecordLookup, platform: ReportPlatform): string {
  const show = platform === 'discord' ? escapeDiscord : (s: string): string => s;
  const head = [`【${r.id}】`, [KIND_LABEL[r.kind], r.venue, r.date].filter(Boolean).join('・')].join('');
  const parts: string[] = [head];
  if (r.game) {
    const lines = recordLines(r.game);
    parts.push(platform === 'discord' ? ['```', ...lines, '```'].join('\n') : lines.join('\n'));
  } else {
    parts.push('（這局的牌譜讀不懂，沒有文字牌譜；可以直接送整份改好的牌譜）');
  }
  const seats = seatLine(r);
  if (seats) parts.push(show(seats));
  if (r.problems.length) {
    const shown = r.problems.slice(0, MAX_PROBLEMS).map((p) => `・${show(p)}`);
    if (r.problems.length > MAX_PROBLEMS) shown.push(`…還有 ${r.problems.length - MAX_PROBLEMS} 項`);
    parts.push(['問題：', ...shown].join('\n'));
  } else {
    parts.push('問題：檢查沒有找到問題');
  }
  parts.push(r.onSite ? `網站牌譜：${recordUrl(r.siteId || r.id)}` : '網站牌譜：（網站上沒有這一局）');
  const hint = platform === 'line' ? `要更正：/更正 ${r.id} 正確的內容（可以多行，例：第一局是 158）` : `要更正：/更正 局號:${r.id} 內容:正確的內容（例：第一局是 158）`;
  const tail = show(hint);
  let text = [...parts, tail].join('\n');
  const max = MAX_CHARS[platform];
  if (text.length > max) {
    // 太長（問題很多或牌譜很長）：問題只留前 3 項。
    const short = parts.map((p) => (p.startsWith('問題：') ? p.split('\n').slice(0, 4).join('\n') : p));
    text = [...short, tail].join('\n');
    if (text.length > max) text = `${text.slice(0, max - tail.length - 2)}…\n${tail}`;
  }
  return text;
}

export interface CorrectionContext {
  platform: ReportPlatform;
  /** 平台上的使用者 id（頻率限制用，不貼出去、不寫 log）。 */
  userId?: string;
  /** 送出的人（貼出去的那則寫「來自 LINE・名字」）；拿不到就不寫。只在送出時才叫。 */
  submitterName?: () => Promise<string>;
  /** LINE 重送了這個程序處理過的事件：查詢照答，送出不再送一次。 */
  redelivery?: boolean;
  deps?: SyncDeps;
  now?: () => number;
}

/** 送出更正的訊息內容：「[更正] 局號」一行，接著原樣的內容（不截斷；太長在送出前就擋下）。 */
export function correctionMessage(id: string, content: string): string {
  return `${correctionHeader(id)}${content}`;
}

function correctionHeader(id: string): string {
  return `[更正] ${id}\n`;
}

/** 這個局號的更正內容最多幾字（/回報 的上限扣掉「[更正] 局號」那一行）。 */
export function correctionContentMax(id: string): number {
  return CORRECTION_MAX - correctionHeader(id).length;
}

/** 太長的回覆：說上限，請縮短或分次送（從不默默截斷）。 */
export function correctionTooLongText(id: string, length: number): string {
  return `更正內容太長（${length} 字），這一局最多 ${correctionContentMax(id)} 字。請縮短，或分成幾次送（每次寫明是哪一局的哪裡）。`;
}

/** /更正 的回覆。 */
export async function answerCorrection(cmd: CorrectionCommand, ctx: CorrectionContext): Promise<string> {
  if (!cmd.id) return usageText(ctx.platform);
  const userKey = ctx.userId ? `${ctx.platform}:${ctx.userId}` : undefined;
  if (!cmd.content && !allowLookup(userKey, (ctx.now ?? Date.now)())) return CORRECTION_RATE_LIMITED_TEXT;
  const record = lookupRecord(cmd.id);
  if (!record) return unknownIdText(cmd.id);
  if (!cmd.content) return formatRecordReply(record, ctx.platform);
  if (ctx.redelivery) return SUBMIT_REDELIVERY_TEXT;
  let name = '';
  try {
    name = ctx.submitterName ? (await ctx.submitterName()).trim() : '';
  } catch {
    name = '';
  }
  const source: ReportSource = ctx.platform;
  const report: FeedbackReport = { kind: 'correction', message: correctionMessage(record.id, cmd.content), source, ...(name ? { name } : {}) };
  if (cmd.content.length > correctionContentMax(record.id) || !reportMessageFits(report)) {
    return correctionTooLongText(record.id, cmd.content.length);
  }
  const result = await submitReport(report, { ...ctx.deps, userKey });
  return submitResultText(result, `${CORRECTION_RECEIVED_TEXT}（${record.id}）`);
}

/** 打字的 /更正 → 回覆文字；不是這個指令時 null。 */
export async function answerCorrectionTextCommand(text: string, ctx: CorrectionContext): Promise<string | null> {
  const cmd = parseCorrectionText(text);
  if (!cmd) return null;
  return answerCorrection(cmd, ctx);
}
