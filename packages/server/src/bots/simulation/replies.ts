/**
 * 模擬瓦（2026-10-14）— 回覆文字，純函式（不讀檔、不看時鐘、不連網）。
 *
 * 一則回覆最多 SIM_REPLY_MAX_CHARS（1800）字，跟戰績一樣；超過就從最不重要的段落開始省略。
 * 純文字繁體中文；第十個座位寫 `0`（`0家`）；沒有任何名字（只有 /公布 在座位那一行下面列 1～0 家是誰，2026-11-20）。
 * 只有 Discord 把派票那一段包在 code block 裡（LINE 不支援 markdown）。
 *
 * Edward 2026-10-14 審查修正（手機上讀得完、講社群的話）：
 *   - /派 的回覆先講 ④（你的派票放出什麼，每次作答都不一樣），③ 邏輯每個決定點只完整印一次；
 *   - 合讀的結果寫成區間，不是「剩 N 種」；
 *   - ③ 的區間照結構分（拇指、失敗的任務隊…），派票解讀用固定規則的標籤（騎牆、打對邊、回選、拆車）；
 *   - /區間 不再印百分比（純邏輯只檢查有沒有矛盾，不判斷像不像）；
 *   - 票沒記全的派票標出來，不把重建的票當事實。
 *
 * 2026-10-22 第一批真人玩過之後的白話版（資訊一樣多，講法換成一般玩家聽得懂的）：
 *   - 每一段（①②③④）第一行先講一句白話結論，細節在後面；
 *   - 術語（打對邊、騎牆、回選、延伸、部分、全好讀法、區間、都對、不能都對、只剩紅、拆車…）
 *     在同一則回覆裡第一次出現時括號解釋一次（gloss()，拼回覆時才決定哪一次是第一次）；
 *   - 區間寫成句子（「2 3 5 7 8 有 4 紅」），不寫符號串（「2 3 5 7 8 *4」）；
 *   - 開題的回覆先講這題要做什麼、/派 和 /區間 各給一個例子（區間 = 哪幾個座位裡有幾個紅），
 *     最後一行提 /模擬 說明；
 *   - 幫別人開的題目作答（代答）時第一行標「代答」，不寫任何名字。
 *
 * 2026-10-22 審查修正：
 *   - 大家都看得到回覆的聊天室（`shared`）裡，開題回覆和 /派 的最後一行說「別人也能幫忙答、誰打 /公布 或
 *     /結束 都會結束這題」（題主不會被嚇到）；/公布 列出的派票裡，代答派的標「（代答）」；代答寫的區間，
 *     題主之後的回覆寫「這題目前的區間」；
 *   - /模擬 說明 分 LINE 版和 Discord 版（Discord 照 slash 的選項名寫）；
 *   - ④「兩次不能都對」沒有超過 6 人時寫原因（跟任務結果矛盾）；開題時還沒有派票（第 1 局第一個隊長）的題目，
 *     /下一步 第一次印出派票時附「怎麼讀」；② 寫「第 1 局」（有空格）；「只剩紅」兩組以上時解釋成「這幾組之一」。
 *
 * 2026-11-16 精簡（Edward：「/派 之後直接顯示結果就好（派到幾好幾壞這樣）」「完整區間解讀可以用另一個指令來呼叫，
 * 只是很多重複的說明跟廢話類型的就不用打了（比如什麼派了 258 代表 1346790 有四壞這種），開題、/下一步、/公布」
 * 「給牌局連結就好」）：
 *   - /派 只回「你派 469：2 好 1 壞」；完整解讀（①④③②）改成 /分析；
 *   - 解讀裡不再寫全好讀法的補集（「4 6 9 是好人，其他 7 人有 4 紅」），兩兩合讀只留「只剩紅」和「不能都對」；
 *     術語不再在回覆裡括號解釋（解釋放在 /模擬 說明）；
 *   - 開題、/下一步、/區間 拿掉「怎麼讀」、例子和重複的提醒（群組代答提醒只在開題時講一次）；
 *   - /公布：角色代碼、你的答案、結果，加網站上這一局牌譜的連結（沒有那一篇就附文字牌譜）。
 */

import type { Role } from '@avalon/shared';
import { COMMANDS, SIM_OPTIONS } from '../discord/config';
import { ROLE_ZH, formatIntervalGroup, type IntervalGroup } from './commands';
import { SIM_HUMAN_SMALL_SAMPLE, SIM_REPLY_MAX_CHARS } from './config';
import { hasHits, type Camp, type CampShare, type HumanAgg, type ProposalFeatures } from './human';
import { RED_COUNT, type SimBeliefModel } from './logic';
import {
  freeCount,
  type ClaimReading,
  type IntervalEval,
  type LogicPanel,
  type ProposalEvent,
  type ProposalTags,
  type ReleasePanel,
  type SeatGroup,
  type SightReason,
  type WorldSummary,
} from './reading';
import { serialiseRecord } from './bankCodec';
import type { ReplayGame } from '../../ai/benchmark/sheetsReplay';
import { FAILS_REQUIRED, isRed, type PublicEvent, type Sight, type SimGame } from './scenario';
import { maskDigits, seatChar, seatList, seatsOfMask, sortSeats, teamDigits } from './seats';
import type { EndedReason } from './session';
import type { AiPicks, AiReading } from './aiRead';
import { originalResult } from './recordImage';

export type SimPlatform = 'line' | 'discord';

// ─── 小工具 ───────────────────────────────────────────────────────────────

export function seatLabel(seat: number): string {
  return `${seatChar(seat)}家`;
}

/** 百分比：1% 以上取整數，0 和 1% 以下（非 0）留一位小數。 */
export function pct(x: number): string {
  const v = x * 100;
  if (!Number.isFinite(v)) return '—';
  if (v > 0 && v < 1) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

export function frac(w: number, total: number): string {
  return `${w}/${total}（${pct(total > 0 ? w / total : 0)}）`;
}

/** 角色的簡稱（回覆裡和座位放一起）。 */
export function roleShort(role: Role): string {
  return role === 'percival' ? '派西' : ROLE_ZH[role];
}

/** 百科的角色代碼字（「刺7娜5莫3奧9派2梅1」）。 */
const ROLE_CODE: Readonly<Record<Role, string>> = {
  merlin: '梅', percival: '派', loyal: '忠', assassin: '刺', morgana: '娜', mordred: '莫', oberon: '奧', minion: '爪',
};

/** 紅數：`2 紅`、`1-3 紅`。 */
function redCount(min: number, max: number): string {
  return min === max ? `${min} 紅` : `${min}-${max} 紅`;
}

// ─── 術語解釋（同一則回覆只解釋一次）────────────────────────────────────────

/** 術語的白話；`sayMany` = 細節列了兩組以上（用「、」分開）時的說法。 */
interface GlossSpec {
  say: string;
  sayMany?: string;
  after?: boolean;
}

/**
 * 術語第一次出現時的白話。`after` 的術語把細節寫在術語後面、解釋放最後
 * （`只剩紅 1258（紅方就只能是這幾個）`、`回選 1（把前面的隊長派進隊裡）`），
 * 其他的把解釋和細節放同一個括號（`延伸（有 2 人以上一樣：4 6）`，之後 `延伸（4 6）`）。
 */
export const GLOSSES = {
  全好讀法: { say: '把隊長和隊員全當好人' },
  延伸: { say: '有 2 人以上一樣' },
  部分: { say: '只有 1 人一樣' },
  打對邊: { say: '完全沒有一樣的人' },
  騎牆: { say: '兩邊各挑了人' },
  回選: { say: '把前面的隊長派進隊裡', after: true },
  區間: { say: '哪幾個座位裡有幾個紅' },
  都對: { say: '兩次派票的人全是好人' },
  不能都對: { say: '兩次派票不可能同時全是好人' },
  只剩紅: { say: '紅方就只能是這幾個', sayMany: '紅方只能是這幾組之一', after: true },
  拆車: { say: '上一局任務隊只留一部分' },
  全換: { say: '上一局任務隊全部換掉' },
  外撒: { say: '上一局任務隊加別人' },
  原隊: { say: '照上一局任務隊再派' },
} as const satisfies Record<string, GlossSpec>;

export type GlossTerm = keyof typeof GLOSSES;

// 私用區的三個字元（U+E000–E002）：回覆文字裡不會出現，拼完回覆一定換掉。
const G0 = String.fromCharCode(0xe000);
const G1 = String.fromCharCode(0xe001);
const G2 = String.fromCharCode(0xe002);
const GLOSS_RE = new RegExp(`${G0}([^${G1}]*)${G1}([^${G2}]*)${G2}`, 'gu');

/** 術語（＋細節）的記號；拼回覆時 resolveGlosses() 換成文字。 */
export function gloss(term: GlossTerm, detail = ''): string {
  return `${G0}${term}${G1}${detail}${G2}`;
}

/**
 * 把 gloss() 的記號換成文字：術語（＋細節）。2026-11-16 起回覆裡不再括號解釋術語（Edward：重複的說明不用打），
 * 白話解釋只在 /模擬 說明（HELP_GLOSSARY）。`after` 的術語把細節接在後面（`只剩紅 1258`、`回選 1`），
 * 其他的放括號（`延伸（4 6）`）；括號後面接箭頭時不留空白（`延伸（4 6）→`）。
 */
export function resolveGlosses(text: string): string {
  const closed = String.fromCharCode(0xe003);
  return text
    .replace(GLOSS_RE, (_m, term: string, detail: string) => {
      const g = (GLOSSES as Record<string, GlossSpec>)[term];
      if (g?.after) return `${term}${detail ? ` ${detail}` : ''}`;
      return detail ? `${term}（${detail}）${closed}` : term;
    })
    .replace(new RegExp(`${closed} →`, 'gu'), '→')
    .replace(new RegExp(closed, 'gu'), '');
}

/** 接在中文後面的片語：開頭是數字才空一格（`時 2 3 5 有 4 紅`、`時只剩紅 1258`）。 */
function sp(tail: string): string {
  return /^[0-9]/u.test(tail) ? ` ${tail}` : tail;
}

/**
 * 拼回覆：每一段是一行或幾行；`optional` 的段落在超過上限時從 `priority` 大的開始拿掉。
 * `soft`（/派 用：手機上讀得完的長度）比上限小時，超過 soft 就開始拿掉 optional 的段落。
 * 術語的解釋在這裡才放進去（留下來的段落裡第一次出現的那個），所以省略段落不會把解釋一起省掉。
 * 最後仍超過上限就在行尾截斷（不會切到一半的行）。
 */
export interface ReplyPart {
  text: string;
  optional?: boolean;
  /** 數字越大越先拿掉。 */
  priority?: number;
}

export function assembleReply(parts: readonly ReplyPart[], max: number = SIM_REPLY_MAX_CHARS, soft: number = max): string {
  const kept = parts.filter((p) => p.text !== '');
  const join = (ps: readonly ReplyPart[]): string => resolveGlosses(ps.map((p) => p.text).join('\n'));
  let text = join(kept);
  const budget = Math.min(max, soft);
  if (text.length <= budget) return text;
  const order = kept
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.optional)
    .sort((a, b) => (b.p.priority ?? 0) - (a.p.priority ?? 0) || b.i - a.i);
  const dropped = new Set<number>();
  for (const { i } of order) {
    dropped.add(i);
    text = join(kept.filter((_, k) => !dropped.has(k)));
    if (text.length <= budget) return text;
  }
  return clampLines(text, max);
}

function clampLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 2);
  const cut = text.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > room / 2 ? cut.slice(0, lastBreak) : cut}\n…`;
}

function codeBlock(lines: readonly string[], platform: SimPlatform): string {
  if (lines.length === 0) return '';
  return platform === 'discord' ? ['```', ...lines, '```'].join('\n') : lines.join('\n');
}

/** 幫別人開的題目作答時，回覆的第一行（沒有任何名字）。 */
export const CO_ANSWER_MARK = '（代答：這題是別人開的，你幫忙回答）';

/** /公布 列出的派票、區間裡，代答寫的那一個後面的標記（沒有名字）。 */
export const CO_ANSWER_TAG = '（代答）';

export function withCoAnswerMark(text: string, coAnswer: boolean | undefined): string {
  return coAnswer ? `${CO_ANSWER_MARK}\n${text}` : text;
}

// ─── 身分與事件 ────────────────────────────────────────────────────────────

/** 「你是 4家・忠臣」「你是 2家・派西維爾，拇指 1 5」等（角色規則本身的說明在 /模擬 說明）。 */
export function identityLine(seat: number, role: Role, sight: Sight): string {
  const who = `你是 ${seatLabel(seat)}・${ROLE_ZH[role]}`;
  switch (sight.kind) {
    case 'loyal':
      return who;
    case 'percival':
      return `${who}，拇指 ${seatList(sight.thumbs)}`;
    case 'merlin':
      return `${who}，看到的紅 ${seatList(sight.seen)}`;
    case 'evil':
      return `${who}，隊友 ${seatList(sight.mates)}`;
    case 'oberon':
      return `${who}（不知道隊友）`;
  }
}

function anomalyTokens(p: Pick<ProposalEvent, 'plusSeats' | 'minusSeats'>): string {
  let s = '';
  if (p.minusSeats.length) s += ` ${teamDigits(p.minusSeats)}-`;
  if (p.plusSeats.length) s += ` ${teamDigits(p.plusSeats)}+`;
  return s;
}

/** 票的特例寫成句子：`，隊外 2 0家 投贊成`、`，隊內 1家 投反對`。 */
function anomalyWords(p: Pick<ProposalEvent, 'plusSeats' | 'minusSeats'>): string {
  const bits: string[] = [];
  if (p.plusSeats.length) bits.push(`隊外 ${seatList(p.plusSeats)}家 投贊成`);
  if (p.minusSeats.length) bits.push(`隊內 ${seatList(p.minusSeats)}家 投反對`);
  return bits.length ? `，${bits.join('、')}` : '';
}

/** 票的記號跟結果對不上（舊紀錄沒記全）時的標記。 */
export const VOTES_UNRELIABLE_MARK = '（票沒記全）';

/** 一次派票的牌譜寫法：`1家 460 1+`。 */
export function proposalLine(p: ProposalEvent, opts: { showOutcome: boolean }): string {
  let line = `${seatLabel(p.leaderSeat)} ${teamDigits(p.teamSeats)}${anomalyTokens(p)}`;
  if (!p.votesReliable) line += VOTES_UNRELIABLE_MARK;
  if (p.forced) line += '（第 5 次，強制出發）';
  else if (opts.showOutcome && p.approved) line += ' → 出發';
  return line;
}

export function questLine(e: Extract<PublicEvent, { kind: 'quest' }>): string {
  const cards = 'o'.repeat(e.successCount) + 'x'.repeat(e.failCount);
  let tail: string;
  if (e.failed) tail = `${e.failCount} 張失敗 → 任務失敗`;
  else if (e.failCount > 0) tail = `${e.failCount} 張失敗（第 ${e.round} 局要 ${FAILS_REQUIRED[e.round - 1]} 張，任務成功）`;
  else tail = '任務成功';
  return `任務 ${teamDigits(e.teamSeats)}：${cards}，${tail}`;
}

export function lakeLine(e: Extract<PublicEvent, { kind: 'lake' }>, viewerSeat: number, game: SimGame): string {
  const said = e.claim === 'evil' ? '說紅（x）' : e.claim === 'good' ? '說好人（o）' : '沒有宣告';
  let line = `湖：${seatLabel(e.holderSeat)} 湖 ${seatLabel(e.targetSeat)}，${said}`;
  if (e.holderSeat === viewerSeat) line += `（你看到的：${isRed(game.seatRoles[e.targetSeat - 1]) ? '紅' : '好人'}）`;
  return line;
}

/**
 * 事件清單 → 行（每一局開頭一行「第 N 局：」）。
 */
export function eventLines(events: readonly PublicEvent[], viewerSeat: number, game: SimGame, opts: { startRound?: number } = {}): string[] {
  const lines: string[] = [];
  let round = opts.startRound ?? 0;
  for (const e of events) {
    if (e.kind === 'proposal' && e.round !== round) {
      round = e.round;
      lines.push(`第 ${round} 局：`);
    }
    if (e.kind === 'proposal') lines.push(proposalLine(e, { showOutcome: true }));
    else if (e.kind === 'quest') lines.push(questLine(e));
    else lines.push(lakeLine(e, viewerSeat, game));
  }
  return lines;
}

/**
 * 精簡牌譜（Edward 2026-11-17）：一行一次派票、不寫「第 N 局」「N家」「（第 5 次，強制出發）」；出發的那次後面
 * 單獨一行任務牌（ooo／ooox）；湖寫成 `0>9 x`（持湖>被湖 宣告 o／x）。開題、刺殺題都用這個。
 *
 *   257 1+
 *   159
 *   ooo
 *   0>9 x
 */
export function compactProposalLine(p: ProposalEvent): string {
  return `${teamDigits(p.teamSeats)}${anomalyTokens(p)}${p.votesReliable ? '' : VOTES_UNRELIABLE_MARK}`;
}

export function compactQuestLine(e: Extract<PublicEvent, { kind: 'quest' }>): string {
  return 'o'.repeat(e.successCount) + 'x'.repeat(e.failCount);
}

export function compactLakeLine(e: Extract<PublicEvent, { kind: 'lake' }>, viewerSeat: number, game: SimGame): string {
  const said = e.claim === 'evil' ? 'x' : e.claim === 'good' ? 'o' : '?';
  let line = `${seatChar(e.holderSeat)}>${seatChar(e.targetSeat)} ${said}`;
  if (e.holderSeat === viewerSeat) line += `（你看到：${isRed(game.seatRoles[e.targetSeat - 1]) ? '紅' : '好人'}）`;
  return line;
}

export function compactEventLines(events: readonly PublicEvent[], viewerSeat: number, game: SimGame): string[] {
  return events.map((e) =>
    e.kind === 'proposal' ? compactProposalLine(e) : e.kind === 'quest' ? compactQuestLine(e) : compactLakeLine(e, viewerSeat, game),
  );
}

export const HELP_HINT = '/help 模擬';

/**
 * 大家都看得到回覆的聊天室（LINE 群組、公開的 Discord 頻道）：開題回覆的最後一行
 * （題主知道別人可以代答、/公布 /結束 是對整題的）。2026-11-16 起只在開題講一次。
 */
export function sharedNote(platform: SimPlatform): string {
  return `${platform === 'discord' ? '頻道' : '群組'}裡沒開題的人也能幫忙答；誰打 /公布 或 /結束 都會結束這題`;
}
/**
 * 大家都看得到回覆的聊天室，作答那一行的括號（2026-11-21：作答的結果不在群組裡馬上公開）。
 * `resultsPrivate`：回覆只有本人看得到（Discord 公開頻道）；沒有（LINE 群組）= 只回收到，結果 /公布 時一起看。
 */
function sharedAnswerNote(shared?: boolean, resultsPrivate?: boolean): string {
  if (!shared) return '';
  return resultsPrivate ? ' (沒開題的人也能作答，結果只有自己看得到)' : ' (沒開題的人也能作答，結果 /公布 時一起看)';
}

/**
 * 輪到你派票時的指令列（開題；Edward 2026-11-17 的格式：一行一個、/結束 不列，/公布 就會結束這題；/下一步 同日拿掉）。
 * 大家都看得到回覆的聊天室加「（沒開題的人也能作答…）」。
 */
export function answerFooter(shared?: boolean, resultsPrivate?: boolean): string {
  return [`/派 座位 作答${sharedAnswerNote(shared, resultsPrivate)}`, '/區間 (百科AI 怎麼讀)', HELP_HINT, '/公布 (結束這題)'].join('\n');
}
export const ANSWER_FOOTER = answerFooter(false);

/** 一句「確定資訊」的任務事實（只有出過失敗牌的任務有資訊：成功不代表全好）。 */
export function missionFact(e: Extract<PublicEvent, { kind: 'quest' }>): string {
  return `第 ${e.round} 局任務隊 ${seatList(e.teamSeats)} 裡至少 ${e.failCount} 紅${e.failed ? '' : `（${e.failCount} 張失敗、任務仍成功）`}`;
}

// ─── 開題 ─────────────────────────────────────────────────────────────────

export interface StartInput {
  exerciseId: string;
  game: SimGame;
  seat: number;
  sight: Sight;
  /** 決定當下之前的事件。 */
  shown: PublicEvent[];
  decision: ProposalEvent;
  platform: SimPlatform;
  /** 取代了上一題時的提醒。 */
  replacedId?: string;
  /** 大家都看得到回覆的聊天室（作答那一行加「沒開題的人也能作答」）。 */
  shared?: boolean;
  /** 跟 shared 一起：作答的結果只有本人看得到（Discord）；沒有 = 結果 /公布 時一起看（LINE 群組）。 */
  resultsPrivate?: boolean;
  /** 今天的主題（/模擬 今天）。 */
  theme?: string;
  /** 自動選 spot：同一局另外值得想的題（最後一行前加一行）。 */
  alsoWorth?: { exerciseId: string; label: string }[];
}

const START_FIRST = '第 1 局第一個隊長，前面沒有派票';

export function formatStart(input: StartInput): string {
  const { game, seat, sight, shown, platform } = input;
  const role = game.seatRoles[seat - 1];
  const parts: ReplyPart[] = [];
  if (input.replacedId) parts.push({ text: `（上一題 ${input.replacedId} 已結束，換這一題）` });
  parts.push({ text: `【模擬瓦 ${input.exerciseId}】${identityLine(seat, role, sight)}` });
  if (input.theme) parts.push({ text: `（今天${input.theme}）` });
  if (!shown.some((e) => e.kind === 'proposal')) parts.push({ text: START_FIRST });
  else parts.push({ text: codeBlock(compactEventLines(shown, seat, game), platform) });
  if (input.alsoWorth?.length) parts.push({ text: alsoWorthLine(input.alsoWorth) });
  parts.push({ text: `\n${answerFooter(input.shared, input.resultsPrivate)}` });
  return assembleReply(parts);
}

// ─── 刺殺題 ───────────────────────────────────────────────────────────────

/** 刺殺題的指令列（同開題的格式）。 */
export function assassinFooter(shared?: boolean, resultsPrivate?: boolean): string {
  return [`/刺 座位 作答${sharedAnswerNote(shared, resultsPrivate)}`, HELP_HINT, '/公布 (結束這題)'].join('\n');
}
export const ASSASSIN_FOOTER = assassinFooter(false);

/**
 * 刺殺題的開題（Threads 週一「刺殺梅林」）：你是刺客，看得到紅方隊友（奧伯倫除外）和整局的公開紀錄，三藍之後輪到你刺。
 */
export function formatAssassinStart(input: Omit<StartInput, 'decision'>): string {
  const { game, seat, sight, shown, platform } = input;
  const parts: ReplyPart[] = [];
  if (input.replacedId) parts.push({ text: `（上一題 ${input.replacedId} 已結束，換這一題）` });
  parts.push({ text: `【模擬瓦 ${input.exerciseId}】${identityLine(seat, game.seatRoles[seat - 1], sight)}` });
  if (input.theme) parts.push({ text: `（今天${input.theme}）` });
  parts.push({ text: codeBlock(compactEventLines(shown, seat, game), platform) });
  parts.push({ text: '三藍，輪到你刺' });
  if (input.alsoWorth?.length) parts.push({ text: alsoWorthLine(input.alsoWorth) });
  parts.push({ text: `\n${assassinFooter(input.shared, input.resultsPrivate)}` });
  return assembleReply(parts);
}

/** 公開頻道裡只有本人看得到的回覆（Discord）多的一句。 */
export const PRIVATE_REPLY_NOTE = '（只有你看得到；/公布 時會列出大家的答案）';

/** /刺 的回覆：記下答案（結果在 /公布）。 */
export function formatKillAnswer(exerciseId: string, target: number, coAnswer?: boolean, privateNote?: boolean): string {
  return withCoAnswerMark(`【${exerciseId}】你刺 ${seatLabel(target)}（可以再刺一次改答案）${privateNote ? `\n${PRIVATE_REPLY_NOTE}` : ''}\n/公布 看結果｜/結束`, coAnswer);
}

/**
 * 群組裡的 /派、/刺（2026-11-21，群組玩家回報：第一個人作答就暴雷）：LINE 群組不能只回給本人，
 * 所以只回收到第幾位，答案和幾好幾壞都等 /公布 一起列。`nth` = 這個人在這題的第幾次作答。
 */
export function formatAnswerAck(exerciseId: string, ordinal: number, nth: number, coAnswer?: boolean): string {
  const again = nth > 1 ? `，第 ${nth} 次作答，最後一次算數` : '';
  return withCoAnswerMark(`【${exerciseId}】收到（第 ${ordinal} 位作答${again}）\n結果 /公布 時一起看`, coAnswer);
}

/** 群組裡的 /分析：公布前不給（裡面有真人怎麼派、幾好幾壞），1 對 1 照舊。 */
export function analysisHiddenText(exerciseId: string): string {
  return `【${exerciseId}】群組裡 /公布 前不顯示分析（不暴雷）。想看完整解讀：私訊機器人 /模擬 題 ${exerciseId}`;
}

export function assassinOnlyText(exerciseId: string): string {
  return `${exerciseId} 是刺殺題：用 /刺 座位 作答，/公布 看結果`;
}

export function notAssassinText(exerciseId: string): string {
  return `${exerciseId} 不是刺殺題：用 /派 座位 作答（刺殺題：/模擬 刺殺）`;
}

export function killTeammateText(target: number, self: boolean): string {
  return self ? '你就是刺客，換一個座位。' : `${seatLabel(target)} 是你的隊友，換一個座位。`;
}

// ─── /派 之後 ─────────────────────────────────────────────────────────────

export interface ProposeInput {
  exerciseId: string;
  game: SimGame;
  seat: number;
  decision: ProposalEvent;
  team: number[];
  /** 這一題這一次真人實際的派票、任務（出發時）。 */
  realQuest?: Extract<PublicEvent, { kind: 'quest' }>;
  human: { agg: HumanAgg; mine: ProposalFeatures; prev?: ProposalEvent; camps?: CampShare[] };
  logic: LogicPanel;
  release: ReleasePanel;
  platform: SimPlatform;
  /**
   * 這題有 /區間：照區間留下幾種、你的隊伍全好的有幾種。`yours` = 你自己寫的（寫「你寫的區間」）；
   * 代答寫的、或這次是代答，寫「這題目前的區間」。
   */
  ownInterval?: { worlds: number; clean: number; yours?: boolean };
  /** 幫別人開的題目作答：第一行標代答（算在長度裡）。 */
  coAnswer?: boolean;
}

function sameTeam(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && sortSeats(a).every((s, i) => s === sortSeats(b)[i]);
}

/** ① 當時坐這個位置的真人怎麼派、結果如何（一行）。 */
function realPlayerLine(input: ProposeInput): string {
  const { decision: d, team } = input;
  const shared = d.teamSeats.filter((s) => team.includes(s)).length;
  const compare = sameTeam(d.teamSeats, team) ? '跟你一樣' : `跟你重疊 ${shared} 人`;
  let outcome: string;
  if (d.forced) outcome = '第 5 次強制出發';
  else outcome = d.approved ? '通過出發' : '被否決';
  if (input.realQuest) outcome += `，任務牌 ${'o'.repeat(input.realQuest.successCount)}${'x'.repeat(input.realQuest.failCount)}`;
  const unreliable = d.votesReliable ? '' : VOTES_UNRELIABLE_MARK;
  return `① 真人：${seatLabel(d.leaderSeat)} 派 ${teamDigits(d.teamSeats)}${anomalyWords(d)}${unreliable}（${compare}）→ ${outcome}`;
}

/** 分布：只印出現過的格子和你那一格。 */
function distLine(prefix: string, counts: readonly number[], n: number, unit: string, mine: number): string {
  const cells: string[] = [];
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] > 0 || k === mine) cells.push(`${k} ${unit} ${pct(n > 0 ? counts[k] / n : 0)}`);
  }
  return `${prefix}${cells.join('｜')}（你 ${mine} ${unit}）`;
}

const CAMP_LABEL: Readonly<Record<Camp, string>> = { merlin: '梅林', good: '其他好人', red: '紅方' };
const LEAK_PREFIX = '\u3000跟你同樣派法';
/** 三方比例最多差不到這麼多倍就算差不多。 */
const LEAK_RATIO = 1.5;

/** 派法的白話（human.ts 的 shape）。 */
function shapeText(shape: string): string {
  const [self, relation] = shape.split('|');
  const parts = [self === '1' ? '含自己' : '不含自己'];
  const rel: Record<string, string> = {
    延伸: `跟上一次${gloss('延伸')}`, 部分: `跟上一次${gloss('部分')}`, 打對邊: `跟上一次${gloss('打對邊')}`,
    'N+1': '上一局任務隊加自己', 外撒: gloss('外撒'), 拆車: gloss('拆車'), 全換: gloss('全換'), 原隊: gloss('原隊'),
  };
  if (rel[relation]) parts.push(rel[relation]);
  return parts.join('・');
}

/**
 * 「這樣派會不會漏角色」（Avalon.md 的 r1/r2/r3 平衡）：同樣處境的梅林／其他好人／紅方，
 * 各有多少比例派出跟你同一個派法。三方差不多 → 不漏；差很多 → 會被往那一方讀。
 */
export function campLine(shape: string, camps: readonly CampShare[]): string | null {
  const shown = camps.filter((c) => c.n > 0);
  if (shown.length < 2) return null;
  const cells = shown.map((c) => `${CAMP_LABEL[c.camp]} ${pct(c.same / c.n)}${c.n < SIM_HUMAN_SMALL_SAMPLE ? '（樣本少）' : ''}`);
  const solid = shown.filter((c) => c.n >= SIM_HUMAN_SMALL_SAMPLE);
  let verdict = '';
  if (solid.length >= 2) {
    // 看到這種派法時，各方的可能性差幾倍（似然比）；+1 平滑，次數很少時不會冒出誇張的倍數。
    const shares = solid.map((c) => ({ c, s: (c.same + 1) / (c.n + 2) })).sort((a, b) => b.s - a.s);
    const most = shares[0];
    const least = shares[shares.length - 1];
    const ratio = most.s / least.s;
    if (ratio < LEAK_RATIO) verdict = ' → 看不出你是哪一方';
    else verdict = ` → 容易被當成${CAMP_LABEL[most.c.camp]}（${CAMP_LABEL[least.c.camp]}的 ${ratio.toFixed(1)} 倍）`;
  }
  return `${LEAK_PREFIX}（${shapeText(shape)}）：${cells.join('｜')}${verdict}`;
}

export function humanLines(input: ProposeInput): string[] {
  const { agg, mine, prev, camps } = input.human;
  const d = input.decision;
  const role = input.game.seatRoles[d.leaderSeat - 1];
  const where = d.round <= 2 ? `第 ${d.round} 局 ${seatLabel(d.leaderSeat)}${roleShort(role)}` : `第 ${d.round} 局 ${roleShort(role)}`;
  if (agg.n <= 0) return [`② 同位置真人（${where}）：題庫裡沒有同樣處境的局`];
  const small = agg.n < SIM_HUMAN_SMALL_SAMPLE ? '，樣本少' : '';
  const lines = [`② 同位置真人（${where}，${agg.n} 次${small}）：派自己 ${pct(agg.self / agg.n)}（你：${mine.self ? '有' : '沒有'}）`];
  if (hasHits(role) && agg.hitsN > 0 && mine.hits !== null) {
    const [label, unit] = role === 'merlin' ? ['派到看到的紅 ', '個'] : role === 'percival' ? ['派到拇指 ', '根'] : ['派到隊友 ', '個'];
    lines.push(distLine(`\u3000${label}`, agg.hits, agg.hitsN, unit, mine.hits));
  }
  if (prev && agg.prevN > 0 && mine.prevOverlap !== null) {
    lines.push(distLine(`\u3000跟上一次 ${seatLabel(prev.leaderSeat)} ${teamDigits(prev.teamSeats)} 重疊 `, agg.prev, agg.prevN, '人', mine.prevOverlap));
  }
  if (agg.missionN > 0 && mine.missionOverlap !== null) {
    lines.push(distLine('\u3000跟上一局任務隊重疊 ', agg.mission, agg.missionN, '人', mine.missionOverlap));
  }
  if (agg.failedN > 0 && mine.failedMember !== null) {
    lines.push(`\u3000派到失敗任務的人 ${pct(agg.failed / agg.failedN)}（你：${mine.failedMember ? '有' : '沒有'}）`);
  }
  const leak = camps ? campLine(mine.shape, camps) : null;
  if (leak) lines.push(leak);
  return lines;
}

function groupText(g: SeatGroup): string {
  const seats = seatList(g.seats);
  switch (g.kind) {
    case 'seen': return `${seats} 是紅（你看到的）`;
    case 'mates': return `${seats} 是紅（隊友）`;
    case 'thumbs': {
      const odds = g.odds ?? [];
      const likelier = odds[0] >= odds[1] ? 0 : 1;
      let note = '';
      if (odds.length === 2 && Math.abs(odds[0] - 0.5) > 1e-9) {
        const t = seatChar(g.seats[likelier]);
        note = odds[likelier] >= 1 ? `，${t} 是娜` : `，${t} 是娜 ${pct(odds[likelier])}`;
      }
      return `${seats} 有 1 紅（一梅一娜${note}）`;
    }
    case 'lake': return `${seats} 是${g.min > 0 ? '紅' : '好人'}（你湖的）`;
    case 'mission': return `${seats} 有 ${redCount(g.min, g.max)}（第 ${g.round} 局任務）`;
    case 'forced': return `${seats} 是${g.min > 0 ? '紅' : '好人'}（邏輯確定）`;
    case 'rest': return `${seats} 有 ${redCount(g.min, g.max)}`;
  }
}

/** ③ 的區間值不值得印（只有視角本來就講過的那幾組時不印）。 */
function groupsWorthShowing(groups: readonly SeatGroup[]): boolean {
  return groups.some((g) => g.kind === 'mission' || g.kind === 'lake' || g.kind === 'forced'
    || (g.kind === 'thumbs' && (g.odds ?? []).some((o) => Math.abs(o - 0.5) > 1e-9)));
}

function claimLabel(c: Pick<ClaimReading, 'proposal'>): string {
  return `${seatLabel(c.proposal.leaderSeat)} ${teamDigits(c.proposal.teamSeats)}`;
}

function reasonText(r: SightReason | undefined, seat: number): string {
  if (!r) return '跟你看到的資訊矛盾';
  switch (r.kind) {
    case 'known-red': return `隊上有你知道的紅 ${seatList(r.seats)}`;
    case 'thumbs': return `兩根拇指 ${seatList(r.seats)} 都在隊上（其中一個是莫甘娜）`;
    case 'good-count': {
      const lake = r.extra.filter((s) => s !== seat);
      const who = r.extra.includes(seat) ? (lake.length ? `你和你湖到的 ${seatList(lake)}` : '你') : lake.length ? `你湖到的 ${seatList(lake)}` : '';
      return who ? `連${who}在內會有 ${r.goods} 個好人，超過 6 個` : `會有 ${r.goods} 個好人，超過 6 個`;
    }
    case 'thumb-count': return `連你在內已經 ${r.goods} 個好人，再加一根拇指（梅林）就超過 6 個`;
    case 'other': return '跟你看到的資訊矛盾';
  }
}

/** 好幾個讀法不成立併成一行時的短原因。 */
function shortReason(r: SightReason | undefined): string {
  if (!r) return '跟你的資訊矛盾';
  switch (r.kind) {
    case 'known-red': return `有紅 ${seatList(r.seats)}`;
    case 'thumbs': return '兩根拇指都在';
    case 'good-count': return `${r.goods} 個好人＞6`;
    case 'thumb-count': return '加一根拇指就超過 6 個好人';
    case 'other': return '跟你的資訊矛盾';
  }
}

function missionRelationText(t: NonNullable<ProposalTags['mission']>): string {
  switch (t.relation) {
    case 'same': return gloss('原隊');
    case 'plus-self': return `上一局任務隊加自己（${t.team.length}+1）`;
    case 'spread': return gloss('外撒');
    case 'split': return gloss('拆車', `留 ${seatList(t.kept)}`);
    case 'swap': return gloss('全換');
  }
}

/** 派票解讀：每一次派票的行為標籤（沒有標籤的不印）。 */
function tagItems(tags: readonly ProposalTags[], viewerSeat: number, round: number): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t.proposal.leaderSeat === viewerSeat) continue;
    const parts: string[] = [];
    if (t.straddle) {
      const s = t.straddle;
      parts.push(gloss('騎牆', `挑 ${seatLabel(s.a.leaderSeat)} 的 ${seatList(s.fromA)}、${seatLabel(s.b.leaderSeat)} 的 ${seatList(s.fromB)}`));
    } else if (t.opposite.length) {
      parts.push(`跟 ${t.opposite.map((p) => seatLabel(p.leaderSeat)).join('、')} ${gloss('打對邊')}`);
    }
    // 騎牆已經講了挑誰；回選只講騎牆沒提到的隊長。
    const picked = new Set([...(t.straddle?.fromA ?? []), ...(t.straddle?.fromB ?? [])]);
    const recall = t.recall.filter((p) => !picked.has(p.leaderSeat));
    if (recall.length) parts.push(gloss('回選', recall.map((p) => seatChar(p.leaderSeat)).join(' ')));
    // 拆車是第 2 局起最常見的派法：只標這一局的（你正在回應的那幾次）；原隊、N+1、外撒、全換都標。
    if (t.mission && (t.mission.relation !== 'split' || t.proposal.round === round)) parts.push(missionRelationText(t.mission));
    if (parts.length) out.push(`${claimLabel(t)} ${parts.join('，')}`);
  }
  return out;
}

function summaryText(s: WorldSummary): string {
  if (s.count === 0) return '不可能';
  const reds = s.reds.length ? `${seatList(s.reds)} 是紅` : '';
  const rest = s.rest.length ? `${seatList(s.rest)} 有 ${redCount(s.min, s.max)}` : '';
  return `${[reds, rest].filter(Boolean).join('、')}（${s.count} 種）`;
}

/** 只剩幾組紅方組合：`只剩紅 1258`（第一次附解釋）、`只剩紅 1370、3570`。 */
function onlyReds(sets: readonly string[]): string {
  return gloss('只剩紅', sets.join('、'));
}

/** ③ 邏輯面板的各行：第一行是白話結論（你知道什麼、幾種組合、分不分得出），細節在後面。 */
export function logicLines(panel: LogicPanel, sight: Sight, seat: number, shown: readonly PublicEvent[], role: Role, round: number): ReplyPart[] {
  const a = panel.analysis;
  const parts: ReplyPart[] = [];
  const trivial = !groupsWorthShowing(panel.groups);
  // 2026-11-16：第一行只講還剩幾種（你的身分、看到的人開題時已經講過）。
  parts.push({ text: `③ 邏輯（只用確定資訊）：紅方剩 ${a.count} 種組合` });
  if (!trivial) parts.push({ text: `・${gloss('區間')}：${panel.groups.map(groupText).join('｜')}` });

  // 全好讀法：每個都一樣多種時沒有資訊（第 1 局常見），只印不一樣的和不成立的。
  const possible = panel.claims.filter((c) => c.weight > 0);
  if (possible.length > 1 && !possible.every((c) => c.weight === possible[0].weight)) {
    parts.push({ text: `・各自全好時剩幾種：${possible.map((c) => `${claimLabel(c)} ${c.weight} 種`).join('｜')}`, optional: true, priority: 5 });
  }
  const impossible = panel.claims.filter((x) => x.weight === 0);
  if (impossible.length === 1) {
    const c = impossible[0];
    const why = c.impossible === 'sight' ? reasonText(c.reason, seat) : '跟任務結果矛盾';
    parts.push({ text: `・${claimLabel(c)} 不可能全好：${why}` });
  } else if (impossible.length > 1) {
    // 紅方視角時常常好幾次都含隊友：併成一行。
    const items = impossible.map((c) => `${claimLabel(c)}（${c.impossible === 'sight' ? shortReason(c.reason) : '跟任務矛盾'}）`);
    parts.push({ text: `・不可能全好的：${items.join('、')}` });
  }

  const tags = tagItems(panel.tags, seat, round);
  if (tags.length) parts.push({ text: `・派票解讀：${tags.join('｜')}` });

  // 兩兩合讀：不能都對（超過 6 人或跟確定資訊矛盾）、都對時只剩幾種。
  const cannot: string[] = [];
  const both: string[] = [];
  for (const p of panel.pairs) {
    const A = panel.claims[p.a].proposal;
    const B = panel.claims[p.b].proposal;
    const names = `${seatLabel(A.leaderSeat)}＋${seatLabel(B.leaderSeat)}`;
    if (p.tooMany) cannot.push(`${names}（加起來 ${p.unionSize} 人＞6）`);
    else if (p.weight === 0) cannot.push(`${names}（跟確定資訊矛盾）`);
    else if (p.worlds) both.push(`${names} ${onlyReds(p.worlds.map(maskDigits))}`);
  }
  if (cannot.length === 1) {
    const p = panel.pairs.find((x) => x.tooMany || x.weight === 0);
    const A = p ? panel.claims[p.a].proposal.leaderSeat : 0;
    const B = p ? panel.claims[p.b].proposal.leaderSeat : 0;
    parts.push({ text: `・${gloss('不能都對')}：${cannot[0]}→ ${seatLabel(A)}、${seatLabel(B)} 至少一個錯`, optional: true, priority: 3 });
  } else if (cannot.length > 1) {
    parts.push({ text: `・${gloss('不能都對')}：${cannot.slice(0, 4).join('、')}${cannot.length > 4 ? '…' : ''}`, optional: true, priority: 4 });
  }
  if (both.length) parts.push({ text: `・兩個${gloss('都對')}時：${both.slice(0, 4).join('；')}`, optional: true, priority: 4 });

  // 角色分支。
  for (const b of panel.thumbs) {
    const items: string[] = [];
    if (b.merlinRead) {
      const s = b.merlinRead.summary;
      items.push(`${claimLabel(b.merlinRead)} 全好 → ${s.count === 0 ? '不可能（隊上有紅：梅林只會漏莫德雷德）' : summaryText(s)}`);
    }
    if (b.morganaRead) {
      const team = b.morganaRead.proposal.teamSeats.filter((x) => x !== b.morgana);
      items.push(`${claimLabel(b.morganaRead)} 是娜派的 → ${seatList(team)} 有 ${redCount(b.morganaRead.min, b.morganaRead.max)}`);
    }
    parts.push({ text: `・若 ${seatChar(b.merlin)} 是梅林（${seatChar(b.morgana)} 是娜）：${items.join('；')}`, optional: true, priority: 2 });
  }
  if (panel.hunt.length) {
    const cells = panel.hunt
      .filter((h) => !h.ours)
      .map((h) => `${claimLabel(h)} ${h.hits.length ? `有 ${seatList(h.hits)}` : '全避開'}`);
    if (cells.length) {
      const note = role === 'mordred' ? '（梅林看不到你，只算隊友）' : '（梅林看得到的你方紅）';
      const avoided = panel.hunt.some((h) => !h.ours && h.hits.length === 0);
      parts.push({ text: `・找梅林${note}：${cells.join('｜')}${avoided ? ' → 全避開的隊長像梅林' : ''}`, optional: true, priority: 2 });
    }
  }
  if (role === 'morgana') parts.push({ text: '・派西的兩根拇指是你和梅林：你的派票會被派西拿來跟梅林比', optional: true, priority: 6 });

  for (const l of panel.lakes) {
    const target = l.targetSeat === seat ? '你' : `${seatLabel(l.targetSeat)} `;
    const said = `${target}是${l.claimEvil ? '紅' : '好人'}`;
    parts.push({
      text: l.weight > 0
        ? `・湖讀法：若 ${seatLabel(l.holderSeat)} 是好人說實話，${said} → 剩 ${l.weight} 種`
        : `・湖讀法：${seatLabel(l.holderSeat)} 說${said}，跟確定資訊矛盾 → ${seatLabel(l.holderSeat)} 不是說實話的好人`,
      optional: true,
      priority: 6,
    });
  }
  return parts;
}

function oddsText(p: number): string {
  if (Math.abs(p - 0.5) < 1e-9) return '一半機率是莫甘娜';
  if (p >= 1) return '依目前邏輯一定是莫甘娜';
  if (p <= 0) return '依目前邏輯一定是梅林（不是紅）';
  return `依目前邏輯 ${pct(p)} 是莫甘娜`;
}

/**
 * 兩次（或你和隊員）都是好人時，紅方「只剩」哪幾組；剩很多種時是 null（2026-11-16：補集的說法
 * 「其他 7 人有 4 紅」是廢話，不再寫，只留真的縮到幾組的）。
 */
export function onlyRedSets(union: number, weight: number, worlds?: readonly number[]): string[] | null {
  if (weight === 0) return null;
  const rest = seatsOfMask(~union & 0x3ff);
  if (rest.length === RED_COUNT) return [teamDigits(rest)];
  if (worlds && worlds.length === weight && weight <= 3 && weight < freeCount(union)) return worlds.map(maskDigits);
  return null;
}

/** ④ 你的派票放出的資訊：第一行是結論（你等於在否定誰），細節在後面。 */
export function releaseLines(r: ReleasePanel, seat: number, ownInterval?: { worlds: number; clean: number; yours?: boolean }): ReplyPart[] {
  const parts: ReplyPart[] = [];
  const claim = seatList(seatsOfMask(r.claimMask));
  const who = (p: ProposalEvent): string => (p.leaderSeat === seat ? `你上一次的 ${teamDigits(p.teamSeats)}` : `${seatLabel(p.leaderSeat)} ${teamDigits(p.teamSeats)}`);
  const pair = (x: { a: ProposalEvent; b: ProposalEvent }): string => `${seatLabel(x.a.leaderSeat)}、${seatLabel(x.b.leaderSeat)}`;
  if (r.weight === 0) {
    parts.push({ text: `④ 你放出的資訊：${claim}（你和隊員）不可能全是好人，跟任務結果矛盾` });
  } else {
    let verdict: string;
    if (r.rejectCommon !== undefined) verdict = `等於在說 ${seatLabel(r.rejectCommon)} 的派票不是好人派的`;
    else if (r.rejects.length) verdict = `等於在說 ${r.rejects.slice(0, 3).map(pair).join('／')} 至少一個錯`;
    else verdict = '沒有否定前面任何一次派票';
    const own = onlyRedSets(r.claimMask, r.weight);
    parts.push({ text: `④ 你放出的資訊：${verdict}${own ? `；你和隊員全好時${sp(onlyReds(own))}` : ''}` });
    // 都對不可能的有兩次以上（後面幾局五人隊伍很常見）就併成一行，不然一次一行。
    const impossible = r.vs.filter((v) => v.weight === 0);
    const lines = impossible.length >= 2 ? r.vs.filter((v) => v.weight > 0) : r.vs;
    for (const v of lines) {
      const label = gloss(v.label, v.shared.length ? seatList(v.shared) : '');
      const recall = v.recall ? `，${gloss('回選', seatChar(v.proposal.leaderSeat))}` : '';
      const n = popcountMask(v.union);
      // 不能都對：超過 6 人，或（後面的人只看公開資訊）跟任務結果矛盾。都對時只寫「只剩紅」（真的縮到幾組時）。
      let tail = '';
      if (v.weight === 0) tail = ` → ${gloss('不能都對', n > 6 ? `加起來 ${n} 人＞6` : '跟任務結果矛盾')}`;
      else {
        const sets = onlyRedSets(v.union, v.weight, v.worlds);
        if (sets) tail = ` → 都對時${sp(onlyReds(sets))}`;
      }
      parts.push({ text: `・跟 ${who(v.proposal)}：${label}${recall}${tail}`, optional: true, priority: 2 });
    }
    if (impossible.length >= 2) {
      const opposite = impossible.filter((v) => v.label === '打對邊').map((v) => seatLabel(v.proposal.leaderSeat));
      parts.push({
        text: `・跟 ${impossible.map((v) => who(v.proposal)).join('、')} 都${gloss('不能都對', '合起來超過 6 人或跟任務矛盾')}${opposite.length ? `；跟 ${opposite.join('、')} 是${gloss('打對邊')}` : ''}`,
        optional: true,
        priority: 2,
      });
    }
  }
  if (ownInterval) {
    const whose = intervalOwnerWords(ownInterval.yours !== false);
    parts.push({
      text: ownInterval.worlds === 0
        ? `・最後檢查：${whose}合起來不可能，先改 /區間`
        : `・照${whose}（${ownInterval.worlds} 種）：${teamDigits(r.team)} 全好 ${ownInterval.clean} 種（${pct(ownInterval.clean / ownInterval.worlds)}）`,
    });
  }
  for (const st of r.thumbStances) {
    const p = `拇指 ${seatChar(st.thumb)} 的 ${teamDigits(st.proposal.teamSeats)}`;
    const text = st.label === '延伸'
      ? `・你的派票跟${p} 是${gloss('延伸')} → 後面的人會讀成你信 ${seatChar(st.thumb)} 是梅林`
      : st.label === '打對邊'
        ? `・你的派票跟${p} ${gloss('打對邊')} → 後面的人會讀成你信 ${seatChar(st.thumb)} 是娜（莫甘娜）`
        : `・你的派票跟${p} 只有 1 人一樣 → 看不出你信誰`;
    parts.push({ text });
  }
  const pc = r.privateCheck;
  if (pc.kind === 'merlin') {
    parts.push({ text: pc.seenOnTeam.length ? `・你派了看到的紅 ${seatList(pc.seenOnTeam)}：讀你全好的人會把 ${seatList(pc.seenOnTeam)} 當好人（故意的話就是在演）` : '・沒有派到你看到的紅' });
  } else if (pc.kind === 'percival') {
    if (pc.thumbsOnTeam.length === 2) parts.push({ text: '・兩根拇指都派了：隊上一定有一紅（莫甘娜）' });
    else if (pc.thumbsOnTeam.length === 1) parts.push({ text: `・你派了拇指 ${seatList(pc.thumbsOnTeam)}：${oddsText(pc.odds[0])}` });
  } else if (pc.kind === 'evil') {
    if (pc.matesOnTeam.length) parts.push({ text: `・你派了隊友 ${seatList(pc.matesOnTeam)}：讀你全好的人會把 ${seatList(pc.matesOnTeam)} 當好人（包隊友）` });
    else parts.push({ text: '・沒有派隊友' });
  }
  const contrastSets = r.contrast && r.weight > 0 ? onlyRedSets(r.contrast.union, r.contrast.weight, r.contrast.worlds) : null;
  if (r.contrast && contrastSets) {
    const c = r.contrast;
    parts.push({
      text: `・對照：改派 ${teamDigits(c.alternative)} 跟 ${seatLabel(c.proposal.leaderSeat)} ${teamDigits(c.proposal.teamSeats)} ${gloss('打對邊')} → 都對時${sp(onlyReds(contrastSets))}`,
      optional: true,
      priority: 4,
    });
  }
  return parts;
}

/** 「你寫的區間」（自己寫的）或「這題目前的區間」（代答寫的、或這次是代答）。 */
export function intervalOwnerWords(yours: boolean): string {
  return yours ? '你寫的區間' : '這題目前的區間';
}

function popcountMask(m: number): number {
  return seatsOfMask(m).length;
}

/** /派 之後的指令列。 */
export const PROPOSE_FOOTER = '/分析 看完整解讀｜/區間 百科AI 怎麼讀｜/公布';
/** /分析 之後的指令列。 */
export const ANALYSIS_FOOTER = '/派 再派一次比較｜/區間 百科AI 怎麼讀｜/公布';

export interface ProposeResultInput {
  exerciseId: string;
  team: number[];
  /** 隊上的好人、紅數（真相）。 */
  goods: number;
  reds: number;
  coAnswer?: boolean;
  /** 公開頻道裡只有本人看得到（Discord，2026-11-21）：多一句說明。 */
  privateNote?: boolean;
}

/** /派 的回覆（Edward 2026-11-16：「/派 之後直接顯示結果就好（派到幾好幾壞這樣）」）。 */
export function formatProposeResult(input: ProposeResultInput): string {
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${input.exerciseId}】你派 ${teamDigits(input.team)}：${input.goods} 好 ${input.reds} 壞` });
  if (input.privateNote) parts.push({ text: PRIVATE_REPLY_NOTE });
  parts.push({ text: PROPOSE_FOOTER });
  return assembleReply(parts);
}

/** /分析 還沒有 /派 可以分析時。 */
export function noAnalysisText(exerciseId: string): string {
  return `${exerciseId}：這一次還沒 /派，先派再 /分析`;
}

/** /分析：這個決定點最後一次 /派 的完整解讀（①④③②，2026-11-16 以前是 /派 的回覆）。 */
export function formatAnalysis(input: ProposeInput, extras: { sight: Sight; shown: PublicEvent[]; ownLakes?: { targetSeat: number; evil: boolean }[] }): string {
  const role = input.game.seatRoles[input.seat - 1];
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${input.exerciseId} 分析】你派 ${teamDigits(input.team)}` });
  parts.push({ text: realPlayerLine(input) });
  parts.push(...releaseLines(input.release, input.seat, input.ownInterval));
  parts.push(...logicLines(input.logic, extras.sight, input.seat, extras.shown, role, input.decision.round));
  // ② 的分布先省略（priority 7）；「跟你同樣派法」三方比較留久一點（priority 3）。
  humanLines(input).forEach((t, i) => parts.push({ text: t, optional: i > 0, priority: t.startsWith(LEAK_PREFIX) ? 3 : 7 }));
  parts.push({ text: ANALYSIS_FOOTER });
  return assembleReply(parts);
}

// ─── /區間 ────────────────────────────────────────────────────────────────

/** 一組區間的白話：`7 8 9 裡有 2 紅`、`4 6 都是好人`（/模擬 說明、測試用）。 */
export function intervalGroupWords(g: IntervalGroup): string {
  const seats = seatList(g.seats);
  if (g.min === 0 && g.max === 0) return `${seats} 都是好人`;
  if (g.min === g.seats.length && g.max === g.seats.length) return `${seats} 都是紅`;
  return `${seats} 裡有 ${redCount(g.min, g.max)}`;
}

/**
 * /區間 的回覆（2026-11-16 精簡：拿掉「怎麼讀」和每組的白話重述）。純邏輯只檢查有沒有矛盾、留下幾種，
 * 不判斷像不像（說明在 /模擬 說明）。
 */
export function formatInterval(exerciseId: string, ev: IntervalEval, model: SimBeliefModel, seat: number, coAnswer = false): string {
  void model;
  const verdictOf = (g: IntervalEval['groups'][number]): string => {
    if (g.self && g.seats.length === 0) {
      return `只寫了你自己（${seatLabel(seat)}）→ ${g.contradiction ? '跟你的身分矛盾' : '一定成立'}`;
    }
    const self = g.self ? `扣掉你等於 ${formatIntervalGroup({ seats: g.seats, min: g.min, max: g.max })}，` : '';
    if (g.contradiction === 'self') return '跟你自己的身分矛盾';
    if (g.contradiction === 'sight') return `${self}不可能（跟你看到的矛盾）`;
    if (g.contradiction === 'mission') return `${self}不可能（跟任務結果矛盾）`;
    return `${self}可能（${g.weight}/${ev.total} 種）`;
  };
  const parts: ReplyPart[] = [];
  if (coAnswer) parts.push({ text: CO_ANSWER_MARK });
  if (ev.groups.length >= 2) {
    let conclusion: string;
    if (ev.jointWeight > 0) {
      const list = ev.jointWorlds.length <= 3 ? `（紅方只能是 ${ev.jointWorlds.map(maskDigits).join('、')}）` : '';
      conclusion = `沒有矛盾，${ev.total} 種縮到 ${ev.jointWeight} 種${list}`;
    } else {
      conclusion = ev.groups.some((g) => g.contradiction) ? '有一組不可能，先改那一組' : '每一組單看都可能，但合起來互相矛盾';
    }
    parts.push({ text: `【${exerciseId} 區間】${conclusion}` });
    for (const g of ev.groups) parts.push({ text: `・${formatIntervalGroup(g.group)}：${verdictOf(g)}` });
  } else if (ev.groups.length === 1) {
    parts.push({ text: `【${exerciseId} 區間】${formatIntervalGroup(ev.groups[0].group)}：${verdictOf(ev.groups[0])}` });
  }
  parts.push({ text: '/派｜/區間 百科AI 怎麼讀｜/公布' });
  return assembleReply(parts);
}

// ─── /區間（不帶內容）：百科AI 怎麼讀 ───────────────────────────────────────

/** /區間 不帶內容（Edward 2026-11-17：想看百科AI 從目前派票讀出來的區間、會選哪些組合）。 */
export function formatAiRead(exerciseId: string, seat: number, read: AiReading, coAnswer = false): string {
  const parts: ReplyPart[] = [];
  if (coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${exerciseId} 百科AI 怎麼讀】` });
  const others = read.redShare.filter((r) => r.seat !== seat).sort((a, b) => b.p - a.p || a.seat - b.seat);
  parts.push({ text: `紅機率：${others.map((r) => `${seatChar(r.seat)} ${pct(r.p)}`).join('・')}` });
  if (read.topWorlds.length) {
    parts.push({ text: `最可能的紅方：${read.topWorlds.map((w) => `${teamDigits(w.seats)} ${pct(w.p)}`).join('｜')}` });
  }
  const safeWord = read.twoFails ? '不會出 2 張失敗' : '全好';
  const [chosen, ...alts] = read.teams;
  if (chosen) {
    const why = chosen.safe === null ? '百科AI 的紅方派法' : `${safeWord} ${pct(chosen.safe)}`;
    parts.push({ text: `百科AI 會派：${teamDigits(chosen.seats)}（${why}）` });
  }
  if (alts.length) {
    parts.push({ text: `${safeWord}機率最高的其他隊：${alts.map((t) => `${teamDigits(t.seats)} ${pct(t.safe ?? 0)}`).join('｜')}` });
  }
  parts.push({ text: '/派｜/公布' });
  return assembleReply(parts);
}

/** 拿掉的指令（/下一步，2026-11-17）。 */
export function removedCommandText(command: string): string {
  return `/${command} 已經拿掉了。直接 /派 作答；想看百科AI 怎麼讀打 /區間，看答案打 /公布`;
}

// ─── /公布 ────────────────────────────────────────────────────────────────

export interface RevealInput {
  exerciseId: string;
  game: SimGame;
  seat: number;
  /** 每個決定點（照時間）這題派過的隊伍（照順序）；`coAnswer` = 代答派的（標「（代答）」）。 */
  answers: { decision: ProposalEvent; teams: { team: number[]; coAnswer: boolean }[] }[];
  interval?: IntervalGroup[];
  /** 區間在最後一次 /區間 時留下的世界。 */
  intervalWorlds?: number[];
  /** 看的人是區間的作者（沒給 = 是）；否則寫「這題目前的區間」。 */
  intervalYours?: boolean;
  /** 區間是代答寫的：區間那一行標「（代答）」（跟上面分開：題主看代答寫的要標，代答者看題主寫的不標）。 */
  intervalByCoAnswer?: boolean;
  /** 網站上這一局牌譜的連結（recordsIndex.ts）；沒有就附文字牌譜。 */
  recordUrl?: string;
  /** 1～0 家的名字（seatNames.ts，網站戰績的寫法；沒有名字是 ''）；沒給就不印名字那一行。 */
  seatNames?: readonly string[];
  /** 刺殺題：你刺的座位（沒刺就是 null）。 */
  kill?: { target: number | null; coAnswer?: boolean };
  /**
   * 大家都看得到的聊天室（2026-11-21）：每一位的答案（照第一次作答的順序，不寫名字）。有給就列「作答」那幾行，
   * 刺殺題的「你刺 N家」那一行改成每一位刺誰。
   */
  everyone?: EveryoneAnswer[];
  /** 百科AI 在這題那一刻會派（刺）的前幾種（aiRead.aiPicks，站長 2026-11-26）；沒給就不印那一行。 */
  aiPicks?: AiPicks | null;
  platform: SimPlatform;
  coAnswer?: boolean;
}

/** 一位作答者的答案：派票題每一次 /派 的幾好幾壞（＝真人：跟真人那一次派的一樣），刺殺題最後一次 /刺。 */
export interface EveryoneAnswer {
  teams?: { team: number[]; goods: number; reds: number; sameAsReal: boolean }[];
  kill?: { target: number; hit: boolean };
}

/** /公布 的「作答」那幾行：`第1位：469 2好1壞｜468 3好0壞＝真人`、`第2位：刺 2家 ✗`。沒有人作答 → 一行說明。 */
export function everyoneLines(list: readonly EveryoneAnswer[]): string[] {
  if (list.length === 0) return ['作答：沒有人作答'];
  return [
    `作答（${list.length} 位）：`,
    ...list.map((a, i) => {
      const body = a.kill
        ? `刺 ${seatLabel(a.kill.target)} ${a.kill.hit ? '✓ 刺中梅林' : '✗'}`
        : (a.teams ?? []).map((t) => `${teamDigits(t.team)} ${t.goods}好${t.reds}壞${t.sameAsReal ? '＝真人' : ''}`).join('｜');
      return `第${i + 1}位：${body}`;
    }),
  ];
}

/**
 * 「百科AI 會派：135（約 60%）、136（25%）、145（15%）」（站長 2026-11-26）：正式機器人在這題那一刻會派的前三種。
 * 只有一種（每次都派同一隊，或其他都不到 5%）就只寫那一隊、不寫百分比；沒列的加起來 ≥ 5% 時補「其他 N%」。
 * 刺殺題寫「百科AI 會刺：7家（約 70%）、3家（30%）」。沒有結果 → ''（不印這一行）。
 */
export function aiPicksLine(ai: AiPicks | null | undefined): string {
  if (!ai || ai.picks.length === 0) return '';
  const label = ai.kind === 'assassinate' ? '百科AI 會刺' : '百科AI 會派';
  const name = (seats: readonly number[]): string => (ai.kind === 'assassinate' ? seatLabel(seats[0]) : teamDigits(seats));
  const others = Math.round(ai.others * 100);
  if (ai.picks.length === 1 && others < 5) return `${label}：${name(ai.picks[0].seats)}`;
  const cells = ai.picks.map((c, i) => `${name(c.seats)}（${i === 0 ? '約 ' : ''}${Math.round(c.p * 100)}%）`);
  if (others >= 5) cells.push(`其他 ${others}%`);
  return `${label}：${cells.join('、')}`;
}

/** 百科的代碼順序：刺 娜 莫 奧 派 梅。 */
const CODE_ORDER: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin'];

export function roleCode(game: Pick<SimGame, 'seatRoles'>): string {
  return CODE_ORDER.map((r) => {
    const i = game.seatRoles.indexOf(r);
    return i < 0 ? '' : `${ROLE_CODE[r]}${seatChar(i + 1)}`;
  }).join('');
}

/** 這局結果：三紅／三藍死（刺 N家，刺中梅林）／三藍活（刺 N家，沒刺中）。 */
export function resultText(g: SimGame): string {
  const fails = g.quests.filter((q) => q.failed).length;
  if (fails >= 3) return '三紅';
  if (g.winner === 'evil') return g.assassinTargetSeat ? `三藍死（刺 ${seatLabel(g.assassinTargetSeat)}，刺中梅林）` : '三藍死';
  return g.assassinTargetSeat ? `三藍活（刺 ${seatLabel(g.assassinTargetSeat)}，沒刺中）` : '三藍活';
}

/** 「1梅 2派 3莫 4忠 5娜 6忠 7刺 8忠 9奧 0忠」：1～0 家各是什麼角色（Edward 2026-11-19）。 */
export function seatRolesLine(game: Pick<SimGame, 'seatRoles'>): string {
  return game.seatRoles.map((r, i) => `${seatChar(i + 1)}${ROLE_CODE[r] ?? '?'}`).join(' ');
}

/** Discord 的 markdown 字元前面加反斜線（名字照原樣顯示，`_小明_` 不會變斜體）。 */
function escapeDiscord(text: string): string {
  return text.replace(/[\\`*_~|>#[\]()<:-]/gu, (c) => `\\${c}`);
}

/**
 * 「1.小明 2.阿華 … 0.阿福」：1～0 家各是誰（Edward 2026-11-20：「模擬瓦公布我說了要把ID 也一起列在座位下方」）。
 * 沒有名字的座位只寫座位（`5.`）；一個名字都沒有 → ''（不印這一行）。
 */
export function seatNamesLine(names: readonly string[] | undefined, platform: SimPlatform): string {
  if (!names || !names.some((n) => n && n.trim())) return '';
  return names
    .slice(0, 10)
    .map((n, i) => `${seatChar(i + 1)}.${platform === 'discord' ? escapeDiscord(n ?? '') : n ?? ''}`)
    .join(' ');
}

/**
 * /公布（Edward 2026-11-16：「給牌局連結就好」）：角色代碼、你的答案（幾好幾壞）、區間對答案、結果，
 * 加網站上這一局牌譜的連結；網站上沒有這一局（試算表裡比 DC 論壇早、或沒貼到論壇）就附文字牌譜。
 */
export function formatReveal(input: RevealInput): string {
  // Edward 2026-11-17：公布只要三行（配置、原始結果、完整牌譜），整局牌譜圖另外附（recordImage.ts）。
  const g = input.game;
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  const seats = CODE_ORDER.map((r) => {
    const i = g.seatRoles.indexOf(r);
    return i < 0 ? '?' : seatChar(i + 1);
  }).join('');
  parts.push({ text: `【${input.exerciseId} 公布】配置: 刺娜莫奧派梅 ${seats}` });
  // Edward 2026-11-19：公布時把 1～0 家各是什麼角色也列出來。
  parts.push({ text: seatRolesLine(g) });
  // Edward 2026-11-20：座位下面再列 1～0 家是誰（名字從網站的牌譜紀錄對來，對不到就不印）。
  parts.push({ text: seatNamesLine(input.seatNames, input.platform) });
  if (input.everyone) {
    // 大家都看得到的聊天室（2026-11-21）：作答時不公開結果，這裡一起列。
    for (const line of everyoneLines(input.everyone)) parts.push({ text: line });
  } else if (input.kill) {
    // 刺殺題：只多這一行（不然看不出刺中沒有）。
    const merlin = g.seatRoles.indexOf('merlin') + 1;
    const t = input.kill.target;
    const who = input.coAnswer || input.kill.coAnswer ? '這題' : '你';
    parts.push({ text: t === null ? `${who}沒有刺` : `${who}刺 ${seatLabel(t)}${input.kill.coAnswer ? CO_ANSWER_TAG : ''}：${t === merlin ? '刺中梅林 ✓' : '沒刺中 ✗'}` });
  }
  // 站長 2026-11-26：現行百科AI 在這題那一刻會派的組合（前三種；只有一種就一種）。
  parts.push({ text: aiPicksLine(input.aiPicks) });
  parts.push({ text: `原始結果: ${originalResult(g)}` });
  if (input.recordUrl) {
    parts.push({ text: `完整牌譜: ${input.recordUrl}` });
  } else {
    parts.push({ text: '完整牌譜（網站上沒有這一局）:' });
    parts.push({ text: codeBlock(serialiseRecord(g as ReplayGame).split('\n'), input.platform) });
  }
  return assembleReply(parts);
}

// ─── 固定短句 ─────────────────────────────────────────────────────────────

export const NO_SESSION_TEXT = '你目前沒有進行中的模擬（有人 /公布 或 /結束、開了別的題或伺服器重新啟動都會結束）。輸入 /模擬 開一題，/help 模擬 看全部指令';
/** 有存檔時（persist.ts）：重啟不會結束題目，所以不提重啟。 */
export const NO_SESSION_KEPT_TEXT = '你目前沒有進行中的模擬（有人 /公布 或 /結束、或開了別的題都會結束）。輸入 /模擬 開一題，/help 模擬 看全部指令';
/** 伺服器剛重啟、進行中的題目還在讀回來。 */
export const RESTORING_TEXT = '伺服器剛更新完，正在把進行中的題目讀回來，請過幾秒再打一次。';

/** 台北時間的「月/日 時:分」（例 11/25 16:30）。 */
function taipeiStamp(at: number): string {
  const d = new Date(at + 8 * 60 * 60 * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/**
 * 重啟前的題目沒能讀回來（存檔不在、讀不到或格式不同），而這個人現在沒有題目：講明伺服器更新過、題目沒留下來、怎麼重開。
 * 不知道他原本是哪一題，所以請他照題目第一行的題號重開。
 */
export function restartLostText(restartedAt: number): string {
  return `你目前沒有進行中的模擬。伺服器在 ${taipeiStamp(restartedAt)} 更新過，那之前還沒公布的題目這次沒能留下來。原本有題目的話，打 /模擬 題號 重開同一題（題號在題目的第一行，例：/模擬 K7Q2M-4），或 /模擬 開新的一題`;
}
export const BANK_NOT_READY_TEXT = '模擬瓦題庫還沒準備好，請稍後再試。';
export const RATE_LIMITED_TEXT = '模擬指令太頻繁了，10 分鐘後再試。';
export const START_USAGE = '用法：/模擬｜/模擬 角色 座位（例：/模擬 派西 2、/模擬 梅林、/模擬 7、/模擬 紅）｜/模擬 1-5～4-5、/模擬 4局、/模擬 5局（可以加角色）｜/模擬 刺殺｜/模擬 今天｜/模擬 題號（例：/模擬 K7Q2M 3-5、/模擬 K7Q2M 4家、/模擬 K7Q2M）｜/help 模擬';
export const PROPOSE_USAGE = '用法：/派 加座位，例如 /派 469 = 派 4、6、9家（0 家寫 0；4 6 9、4,6,9 也可以）';
export const ASSASSINATE_USAGE = '用法：/刺 座位，例如 /刺 3（0 家寫 0）';
export const INTERVAL_USAGE = '用法：/區間 789=2 460=1 = 7 8 9 裡有 2 紅、4 6 0 裡有 1 紅（也可以 7 8 9 *2、12=1-2、1 5 9 *1+、3 紅、5=好；各組可以重疊）';

/** 說明的第一行（兩個平台一樣）。 */
const HELP_TITLE = '🧩 模擬瓦指令（真人對局停在某一家要派票的當下，換你來派，看你的派票放出什麼資訊）';
const HELP_PROPOSE_WORDS = '作答：派 4、6、9家（0 家寫 0；人數要對，可以派好幾次比較）';
const HELP_AI_READ_WORDS = '百科AI 怎麼讀這個局面：各家紅機率、最可能的紅方、百科AI 這時會派的隊（藍方附全好機率）';
const HELP_INTERVAL_WORDS = '（選填）檢查你自己的區間（7 8 9 裡 2 紅、4 6 0 裡 1 紅），只用確定的資訊看跟局面合不合、還剩幾種可能';
const HELP_END = '/結束\u3000不公布，直接結束';
const HELP_ANALYSIS_WORDS = '剛剛那次 /派 的完整解讀（真人怎麼派、你放出的資訊、邏輯、同位置真人）';
const HELP_MID_WORDS = '從那一局第 5 次（尾派）或第 5 局開始，坐那次的隊長（2-5、3-5 有篩；4局＝第 4 局忠臣當隊長的任何一次；可以加角色、座位）';
/** 什麼都沒指定的 /模擬（2026-11-19：抽一局，從最值得想的 spot 開始，見 spotValue.ts）。 */
const HELP_RANDOM_WORDS = '抽一局，從這局最值得想的地方開始（附同一局另外值得想的題號）';
const HELP_KILL_WORDS = '刺殺題：你是刺客，看完整局後 /刺 座位';
const HELP_TODAY_WORDS = '每週主題：一刺殺 二派西 三1-5 四3-5 五2-5 六第4局忠臣 日第5局';

/** 牌譜怎麼讀和術語（2026-11-16 起回覆裡不再重複解釋，集中在說明）。 */
const HELP_GLOSSARY = [
  '牌譜：「1家 460 1+」= 1家派 4、6、0家；+ 隊外投贊成、- 隊內投反對，其他照隊內贊成隊外反對；任務 o 成功 x 失敗；（票沒記全）= 票記號跟結果對不上',
  '術語：區間＝哪幾個座位裡有幾個紅（例 789=2：7 8 9 裡 2 紅）｜都對＝兩次派票的人全是好人｜不能都對＝兩次不可能同時全好｜只剩紅＝紅方只能是這幾個'
    + '｜延伸＝有 2 人以上一樣｜部分＝只有 1 人一樣｜打對邊＝完全沒有一樣｜騎牆＝兩邊各挑人｜回選＝把前面的隊長派進隊'
    + '｜拆車＝上一局任務隊只留一部分｜全換＝全部換掉｜外撒＝上一局任務隊加別人｜原隊＝照上一局任務隊再派',
  '牌譜精簡寫法：「257 1+」= 派 2 5 7、1家隊外投贊成（- 隊內投反對）；單獨一行 ooo／ooox = 上一次派票出發的任務牌；「0>9 x」= 0家湖 9家、說紅（o 說好人）',
];

/**
 * LINE 的 /模擬 說明（/模擬 幫助、/模擬 指令、/模擬 ?）和只回模擬的 LINE 練習群（SIM_LINE_GROUP_IDS）裡的 /指令：
 * 全部指令，每個一行白話。
 */
export const SIM_HELP_TEXT = [
  HELP_TITLE,
  `/模擬\u3000${HELP_RANDOM_WORDS}`,
  '/模擬 角色 座位\u3000指定角色或座位，例：/模擬 派西 2、/模擬 梅林、/模擬 7、/模擬 紅',
  `/模擬 1-5～4-5、/模擬 4局、/模擬 5局\u3000${HELP_MID_WORDS}`,
  `/模擬 刺殺\u3000${HELP_KILL_WORDS}（/刺 3）`,
  `/模擬 今天\u3000${HELP_TODAY_WORDS}`,
  '/模擬 題 題號\u3000指定題目（大家做同一題，「題」可省）：K7Q2M 3-5、K7Q2M 4家、K7Q2M 刺殺、K7Q2M（這局最值得想的）',
  `/派 469\u3000${HELP_PROPOSE_WORDS}；回幾好幾壞（群組只回收到）`,
  `/分析\u3000${HELP_ANALYSIS_WORDS}`,
  `/區間\u3000${HELP_AI_READ_WORDS}`,
  `/區間 789=2 460=1\u3000${HELP_INTERVAL_WORDS}`,
  '/公布\u3000公布角色、對答案、附這一局的完整牌譜，這題結束（也可以打 /解答）',
  HELP_END,
  '/help 模擬\u3000這份說明（/模擬 說明 也可以）',
  '群組裡自己沒開題的人也可以幫忙答群組裡最新開的一題（/派 /分析 /區間 /公布 /結束），回覆會標「代答」；'
    + '誰打 /公布 或 /結束 都會結束那一題。群組裡作答結果 /公布 才一起列。1 對 1 聊天沒有代答。',
  ...HELP_GLOSSARY,
].join('\n');

/** Discord 的 /模擬 說明:True：跟 slash 指令的選項名一樣（角色、座位、題號、隊伍、內容）；Discord 沒有 /解答。 */
export const SIM_HELP_TEXT_DISCORD = [
  HELP_TITLE,
  `/${COMMANDS.SIM}\u3000${HELP_RANDOM_WORDS}`,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.ROLE}:派西維爾 ${SIM_OPTIONS.SEAT}:2\u3000指定角色或座位（可以只選一個；${SIM_OPTIONS.ROLE}選 紅／藍 = 隨機紅方／藍方角色）`,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.STAGE}:3-5\u3000${HELP_MID_WORDS}；局面:刺殺 = ${HELP_KILL_WORDS}（/${COMMANDS.SIM_ASSASSINATE} ${SIM_OPTIONS.SEAT}:3）；局面:今天 = ${HELP_TODAY_WORDS}`,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.ID}:K7Q2M 3-5\u3000指定題目（大家做同一題）：K7Q2M 3-5、K7Q2M 4家、K7Q2M 刺殺、K7Q2M（這局最值得想的）`,
  `/${COMMANDS.SIM_PROPOSE} ${SIM_OPTIONS.TEAM}:469\u3000${HELP_PROPOSE_WORDS}；回幾好幾壞`,
  `/${COMMANDS.SIM_ANALYSIS}\u3000${HELP_ANALYSIS_WORDS}`,
  `/${COMMANDS.SIM_INTERVAL}\u3000${HELP_AI_READ_WORDS}`,
  `/${COMMANDS.SIM_INTERVAL} ${SIM_OPTIONS.CONTENT}:789=2 460=1\u3000${HELP_INTERVAL_WORDS}`,
  `/${COMMANDS.SIM_REVEAL}\u3000公布角色、對答案、附這一局的完整牌譜，這題結束`,
  HELP_END,
  `/${COMMANDS.HELP} 主題:模擬\u3000這份說明（/${COMMANDS.SIM} ${SIM_OPTIONS.HELP}:True 也可以）`,
  '回覆公開的頻道裡，自己沒開題的人也可以幫忙答頻道裡最新開的一題（/派 /分析 /區間 /公布 /結束），回覆會標「代答」；'
    + '誰打 /公布 或 /結束 都會結束那一題。公開頻道的 /派 /刺 /分析 只回給自己，/公布 列出大家的答案。只有自己看得到回覆的頻道沒有代答。',
  ...HELP_GLOSSARY,
].join('\n');

/** 這個平台的 /模擬 說明。 */
export function simHelpText(platform: SimPlatform): string {
  return platform === 'discord' ? SIM_HELP_TEXT_DISCORD : SIM_HELP_TEXT;
}

export function usageText(command: 'start' | 'propose' | 'interval' | 'assassinate', problem?: string): string {
  const usage = command === 'start' ? START_USAGE : command === 'propose' ? PROPOSE_USAGE : command === 'assassinate' ? ASSASSINATE_USAGE : INTERVAL_USAGE;
  return problem ? `${problem}\n${usage}` : usage;
}

export function wrongSizeText(size: number, got: number): string {
  return `這次要派 ${size} 人，你寫了 ${got} 人。\n${PROPOSE_USAGE}`;
}

export function noMoreDecisionsText(exerciseId: string): string {
  return `${exerciseId}：你在這局已經沒有下一次派票了。/公布 看角色和你的答案｜/結束`;
}

export function endedText(exerciseId: string): string {
  return `已結束 ${exerciseId}（沒有公布）。再來一題：/模擬`;
}

/** 題目過期或被擠掉之後，本人再打指令時的說明。 */
export function endedNoticeText(exerciseId: string, reason: EndedReason): string {
  if (reason === 'lost') {
    return `你的模擬 ${exerciseId} 在伺服器更新後沒能接回來（這一局可能已經從題庫拿掉）。/模擬 題 ${exerciseId} 重開試試，或 /模擬 開新的一題`;
  }
  const why = reason === 'expired' ? '太久沒動作' : '同時開的題目太多，最久沒動的先結束';
  return `你的模擬 ${exerciseId} 已經結束（${why}）。/模擬 題 ${exerciseId} 從頭再做一次，或 /模擬 開新的一題`;
}

export function thinPoolText(role: Role, seat: number, n: number, available: readonly number[]): string {
  const where = available.length ? `這個角色題目夠的座位：${seatList(available)}` : '這個角色目前沒有題目夠的座位';
  return `${ROLE_ZH[role]}在 ${seatLabel(seat)} 只有 ${n} 題（少於 20 題先不出）。${where}`;
}

export function unknownIdText(): string {
  return '找不到這個題號。題號 = 局號＋位置：K7Q2M 3-5（第 3 局第 5 次）、K7Q2M 4家（4家第一次派票，舊寫法 K7Q2M-4）、K7Q2M 刺殺；只打 K7Q2M = 這局最值得想的地方。';
}

/** 指定的題號（局-次）那一局沒有那一次派票。 */
export function noStageText(round: number, attempt: number): string {
  return `這一局沒有第 ${round} 局第 ${attempt} 次派票，換一題吧。`;
}

/** /模擬 1-5～4-5、4局、5局 找不到符合的題目。 */
export function noMidText(round: number, anyAttempt?: boolean): string {
  const what = round === 5 ? '第 5 局' : anyAttempt ? `第 ${round} 局` : `${round}-5`;
  const why = round === 3 && !anyAttempt
    ? '（3-5 只出第 2 局任務失敗的局）'
    : round === 2 && !anyAttempt
      ? '（2-5 只出第 1 局失敗、或 2-1～2-4 至少兩人不是派三加一的局）'
      : '';
  return `題庫裡沒有符合的${what}題目${why}，換個角色或座位試試。`;
}

/**
 * 正式題號 → 「局號 位置」的打法（2026-11-21：玩家想跳到同一局的別的時間點，`K7Q2M-5 1-1`、`K7Q2M 3-5` 都回用法）：
 * `K7Q2M-3-5` → `K7Q2M 3-5`、`K7Q2M-4` → `K7Q2M 4家`、`K7Q2M-A` → `K7Q2M 刺殺`。看不懂就照原樣。
 */
export function spacedExerciseId(exerciseId: string): string {
  const m = /^([0-9A-Z]+)-(.+)$/.exec(exerciseId);
  if (!m) return exerciseId;
  const pos = m[2] === 'A' ? '刺殺' : /^[0-9]$/.test(m[2]) ? `${m[2]}家` : m[2];
  return `${m[1]} ${pos}`;
}

/** 自動選 spot 時同一局另外值得想的題（一行，照打就能開：/模擬 K7Q2M 刺殺）。 */
export function alsoWorthLine(items: readonly { exerciseId: string; label: string }[]): string {
  return `這局也值得想：${items.map((i) => {
    const typed = spacedExerciseId(i.exerciseId);
    return typed.endsWith(` ${i.label}`) ? `/模擬 ${typed}` : `/模擬 ${typed}（${i.label}）`;
  }).join('、')}`;
}

export function noAssassinText(): string {
  return '這一局沒有刺殺（不是三藍、或沒記刺殺），換一題吧。';
}

export function noDecisionText(seat: number): string {
  return `這一局 ${seatLabel(seat)} 沒有${seat <= 5 ? '第 1 局' : '第 2 局'}的派票（那一局提早出發），換一題吧。`;
}
