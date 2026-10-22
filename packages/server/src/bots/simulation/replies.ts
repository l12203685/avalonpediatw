/**
 * 模擬瓦（2026-10-14）— 回覆文字，純函式（不讀檔、不看時鐘、不連網）。
 *
 * 一則回覆最多 SIM_REPLY_MAX_CHARS（1800）字，跟戰績一樣；超過就從最不重要的段落開始省略。
 * 純文字繁體中文；第 10 家寫 `0`（`0家`）；沒有任何名字。
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
 */

import type { Role } from '@avalon/shared';
import { COMMANDS, SIM_OPTIONS } from '../discord/config';
import { ROLE_ZH, formatIntervalGroup, type IntervalGroup } from './commands';
import { SIM_HUMAN_SMALL_SAMPLE, SIM_PROPOSE_SOFT_MAX_CHARS, SIM_REPLY_MAX_CHARS } from './config';
import { hasHits, type Camp, type CampShare, type HumanAgg, type ProposalFeatures } from './human';
import { RED_COUNT, type SimBeliefModel } from './logic';
import {
  freeCount,
  intervalGroupTrue,
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
import { FAILS_REQUIRED, TEAM_SIZES, isRed, type PublicEvent, type Sight, type SimGame } from './scenario';
import { maskDigits, maskOf, seatChar, seatList, seatsOfMask, sortSeats, teamDigits } from './seats';
import type { EndedReason } from './session';

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

/** 術語（＋細節）的記號；拼回覆時 resolveGlosses() 才決定要不要附解釋（每則回覆第一次才附）。 */
export function gloss(term: GlossTerm, detail = ''): string {
  return `${G0}${term}${G1}${detail}${G2}`;
}

/**
 * 把 gloss() 的記號換成文字：同一個術語第一次附白話解釋，之後只寫術語（＋細節）。
 * 解釋的括號後面接箭頭時不留空白（`延伸（4 6）→`，跟中文排版一樣）；其他地方的文字不動。
 */
export function resolveGlosses(text: string): string {
  const said = new Set<string>();
  const closed = String.fromCharCode(0xe003);
  return text
    .replace(GLOSS_RE, (_m, term: string, detail: string) => {
      const g = (GLOSSES as Record<string, GlossSpec>)[term];
      const first = !said.has(term);
      said.add(term);
      const say = first && g ? (g.sayMany && detail.includes('、') ? g.sayMany : g.say) : '';
      let out: string;
      if (g?.after) out = `${term}${detail ? ` ${detail}` : ''}${say ? `（${say}）` : ''}`;
      else {
        const inner = [say, detail].filter(Boolean).join('：');
        out = inner ? `${term}（${inner}）` : term;
      }
      return out.endsWith('）') ? `${out}${closed}` : out;
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

/** 「你是 4家・忠臣（沒有額外資訊）」等。 */
export function identityLine(seat: number, role: Role, sight: Sight): string {
  const who = `你是 ${seatLabel(seat)}・${ROLE_ZH[role]}`;
  switch (sight.kind) {
    case 'loyal':
      return `${who}（沒有額外資訊）`;
    case 'percival':
      return `${who}。拇指：${seatList(sight.thumbs)}（一個是梅林、一個是莫甘娜，不知道誰是誰）`;
    case 'merlin':
      return `${who}。你看到的紅：${seatList(sight.seen)}；莫德雷德看不到，所以還有 ${RED_COUNT - sight.seen.length} 紅在其他人裡`;
    case 'evil':
      return role === 'mordred'
        ? `${who}。隊友：${seatList(sight.mates)}（奧伯倫不認隊友；梅林看不到你）`
        : `${who}。隊友：${seatList(sight.mates)}（奧伯倫不認隊友）`;
    case 'oberon':
      return `${who}。你不知道隊友，隊友也不知道你；梅林看得到你`;
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
 * 牌譜怎麼讀（用看得到的第一次派票當例子）。
 * 「1家 460 1+」= 1家派 4、6、0家（0 = 10家）；+ 是隊外的人投贊成、- 是隊內的人投反對，其他人都是隊內贊成、隊外反對。
 */
export function notationNote(first: ProposalEvent, opts: { quests: boolean }): string {
  const seats = sortSeats(first.teamSeats).map(seatChar).join('、');
  const quest = opts.quests ? '；任務的 o = 成功牌、x = 失敗牌' : '';
  return `怎麼讀：「${seatLabel(first.leaderSeat)} ${teamDigits(first.teamSeats)}」= ${seatLabel(first.leaderSeat)}派 ${seats}家（0 = 10家）；`
    + `座位後面的 + 是隊外的人投贊成、- 是隊內的人投反對，其他人都是隊內贊成、隊外反對${quest}`;
}

/** 開題時，前面有票沒記全的派票才多講一句。 */
const UNRELIABLE_NOTE = `${VOTES_UNRELIABLE_MARK} = 記號跟結果對不上，那一次的票不能照上面的規則讀`;

function decisionPrompt(p: ProposalEvent): string {
  const size = TEAM_SIZES[p.round - 1];
  const forced = p.attempt === 5 ? '，這次強制出發' : '';
  return `輪到你派 ${size} 人（第 ${p.round} 局第 ${p.attempt} 次${forced}）。`;
}

/** /派 的例子（照這次的人數）：`/派 469 = 派 4、6、9家`。 */
const PROPOSE_EXAMPLES: Readonly<Record<number, string>> = { 3: '469', 4: '2469', 5: '24690' };

export function proposeExample(size: number): string {
  const digits = PROPOSE_EXAMPLES[size] ?? '12345'.slice(0, size);
  const seats = [...digits].join('、');
  return `/派 ${digits} = 派 ${seats}家${digits.includes('0') ? '（0 = 10家）' : ''}`;
}

export const INTERVAL_EXAMPLE = '/區間 789=2 460=1 = 7 8 9 裡有 2 紅、4 6 0 裡有 1 紅';

function answerHint(p: ProposalEvent): string[] {
  return [
    `作答：/派 加座位，例：${proposeExample(TEAM_SIZES[p.round - 1])}`,
    `選填：先寫區間（你覺得哪幾個座位裡有幾個紅），例：${INTERVAL_EXAMPLE}`,
  ];
}

export const HELP_HINT = '/模擬 說明 看全部指令';

/**
 * 大家都看得到回覆的聊天室（LINE 群組、公開的 Discord 頻道）：開題回覆和 /派 的最後一行
 * （題主知道別人可以代答、/公布 /結束 是對整題的）。
 */
export function sharedNote(platform: SimPlatform): string {
  return `${platform === 'discord' ? '頻道' : '群組'}裡沒開題的人也能幫忙答（標「代答」）；誰打 /公布 或 /結束 都會結束這題`;
}
export const ANSWER_FOOTER = `/下一步 跳過這次｜/公布 看角色｜/結束｜${HELP_HINT}`;

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
  /** 大家都看得到回覆的聊天室（最後加一行 sharedNote）。 */
  shared?: boolean;
}

export const START_TASK_LINE = '這題要做的事：看完前面的派票，想想紅方可能在哪，然後換你派一次隊，看你的派票會放出什麼資訊。';
const START_TASK_FIRST = '你是第 1 局第一個隊長，前面沒有派票：這題練「釋放」（你的派票會放出什麼資訊給後面的人）。';

export function formatStart(input: StartInput): string {
  const { game, seat, sight, shown, decision, platform } = input;
  const role = game.seatRoles[seat - 1];
  const onlyR1 = shown.every((e) => e.kind === 'proposal' && e.round === 1);
  const parts: ReplyPart[] = [];
  if (input.replacedId) parts.push({ text: `（上一題 ${input.replacedId} 已結束，換這一題）` });
  parts.push({ text: `【模擬瓦 ${input.exerciseId}】${identityLine(seat, role, sight)}` });
  const firstProposal = shown.find((e): e is ProposalEvent => e.kind === 'proposal');
  if (shown.length === 0 || !firstProposal) {
    parts.push({ text: START_TASK_FIRST });
  } else {
    parts.push({ text: START_TASK_LINE });
    if (onlyR1) {
      parts.push({ text: '第 1 局到目前的派票（照隊長順序）：' });
      parts.push({ text: codeBlock(shown.map((e) => proposalLine(e as ProposalEvent, { showOutcome: false })), platform) });
    } else {
      parts.push({ text: '目前為止（照隊長順序）：' });
      parts.push({ text: codeBlock(eventLines(shown, seat, game), platform) });
    }
    parts.push({ text: notationNote(firstProposal, { quests: shown.some((e) => e.kind === 'quest') }) });
  }
  if (shown.some((e) => e.kind === 'proposal' && !e.votesReliable)) parts.push({ text: UNRELIABLE_NOTE, optional: true, priority: 1 });
  parts.push({ text: decisionPrompt(decision) });
  for (const line of answerHint(decision)) parts.push({ text: line });
  parts.push({ text: ANSWER_FOOTER });
  if (input.shared) parts.push({ text: sharedNote(platform) });
  return assembleReply(parts);
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
  /** 這個決定點第一次 /派：③ 完整印；之後一行帶過。 */
  showLogic?: boolean;
  /**
   * 這題有 /區間：照區間留下幾種、你的隊伍全好的有幾種。`yours` = 你自己寫的（寫「你寫的區間」）；
   * 代答寫的、或這次是代答，寫「這題目前的區間」。
   */
  ownInterval?: { worlds: number; clean: number; yours?: boolean };
  /** 幫別人開的題目作答：第一行標代答（算在長度裡）。 */
  coAnswer?: boolean;
  /** 大家都看得到回覆的聊天室（最後加一行 sharedNote）。 */
  shared?: boolean;
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
  return `① 當時真人怎麼派：${seatLabel(d.leaderSeat)} 派 ${teamDigits(d.teamSeats)}${anomalyWords(d)}${unreliable}（${compare}）→ ${outcome}`;
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
    if (ratio < LEAK_RATIO) verdict = ' → 三方差不多，看不出你是哪一方（不太漏角色）';
    else verdict = ` → ${CAMP_LABEL[most.c.camp]}最常這樣派（${CAMP_LABEL[least.c.camp]}的 ${ratio.toFixed(1)} 倍），容易被當成${CAMP_LABEL[most.c.camp]}`;
  }
  return `${LEAK_PREFIX}（${shapeText(shape)}）的比例：${cells.join('｜')}${verdict}`;
}

export function humanLines(input: ProposeInput): string[] {
  const { agg, mine, prev, camps } = input.human;
  const d = input.decision;
  const role = input.game.seatRoles[d.leaderSeat - 1];
  const where = d.round <= 2 ? `第 ${d.round} 局 ${seatLabel(d.leaderSeat)}${roleShort(role)}` : `第 ${d.round} 局 ${roleShort(role)}`;
  if (agg.n <= 0) return [`② 同位置的真人怎麼派（${where}）：題庫裡沒有其他同樣處境的局`];
  const small = agg.n < SIM_HUMAN_SMALL_SAMPLE ? '，樣本少' : '';
  const lines = [`② 同位置的真人怎麼派（題庫裡${where}，${agg.n} 次${small}）：有派自己的佔 ${pct(agg.self / agg.n)}（你：${mine.self ? '有' : '沒有'}）`];
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

/** ③ 第一行的白話結論：你知道什麼、紅方可能的組合有幾種。 */
function campIntro(sight: Sight, seat: number, count: number): string {
  const n = `（${count} 種組合）`;
  switch (sight.kind) {
    case 'loyal': return `你是好人，${RED_COUNT} 紅在其他 9 人裡${n}`;
    case 'percival': return `你是好人；拇指 ${seatList(sight.thumbs)} 裡剛好 1 紅，就是莫甘娜${n}`;
    case 'merlin': return `你看到 ${seatList(sight.seen)} 是紅，還有 ${RED_COUNT - sight.seen.length} 紅（莫德雷德）在其他人裡${n}`;
    case 'evil': return `你和隊友 ${seatList(sight.mates)} 是紅，奧伯倫在其他人裡${n}`;
    case 'oberon': return `你（${seatLabel(seat)}）是紅，另外 ${RED_COUNT - 1} 紅在其他 9 人裡${n}`;
  }
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
  const behaviour = panel.model.weighsBehaviour ? '' : '，還沒算派票行為';
  const quests = shown.filter((e) => e.kind === 'quest');
  const trivial = !groupsWorthShowing(panel.groups);
  const blind = quests.length === 0 && trivial && (sight.kind === 'loyal' || sight.kind === 'oberon');
  const blindNote = blind ? `。任務前純邏輯分不出誰是紅，${gloss('區間')}要靠讀派票` : '';
  parts.push({ text: `③ 邏輯上確定的（${panel.model.label}：只用確定資訊${behaviour}）：${campIntro(sight, seat, a.count)}${blindNote}` });
  if (!trivial) parts.push({ text: `・${gloss('區間')}：${panel.groups.map(groupText).join('｜')}` });

  // 全好讀法：每個都一樣多種時沒有資訊（第 1 局常見），只印不一樣的和不成立的。
  const possible = panel.claims.filter((c) => c.weight > 0);
  if (possible.length > 1 && !possible.every((c) => c.weight === possible[0].weight)) {
    parts.push({ text: `・${gloss('全好讀法')}各剩幾種：${possible.map((c) => `${claimLabel(c)} ${c.weight} 種`).join('｜')}`, optional: true, priority: 5 });
  }
  const impossible = panel.claims.filter((x) => x.weight === 0);
  if (impossible.length === 1) {
    const c = impossible[0];
    const why = c.impossible === 'sight' ? reasonText(c.reason, seat) : '跟任務結果矛盾';
    parts.push({ text: `・${claimLabel(c)} 的${gloss('全好讀法')}不成立：${why}` });
  } else if (impossible.length > 1) {
    // 紅方視角時常常好幾次都含隊友：併成一行。
    const items = impossible.map((c) => `${claimLabel(c)}（${c.impossible === 'sight' ? shortReason(c.reason) : '跟任務矛盾'}）`);
    parts.push({ text: `・${gloss('全好讀法')}不成立的：${items.join('、')}` });
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

/**
 * 「都好」的人是 `union` 時，其他人的寫法：`2 3 5 7 8 有 4 紅`；剛好 4 人 → 只剩紅；
 * 任務結果讓組合變少時加「（N 種）」，剩 3 種以內列出來。
 */
export function restText(union: number, weight: number, worlds?: readonly number[]): string {
  if (weight === 0) return '不可能';
  const rest = seatsOfMask(~union & 0x3ff);
  if (rest.length === RED_COUNT) return onlyReds([teamDigits(rest)]);
  const free = freeCount(union);
  if (worlds && worlds.length === weight && weight <= 3 && weight < free) return onlyReds(worlds.map(maskDigits));
  return `${seatList(rest)} 有 ${RED_COUNT} 紅${weight < free ? `（${weight} 種）` : ''}`;
}

function oddsText(p: number): string {
  if (Math.abs(p - 0.5) < 1e-9) return '一半機率是莫甘娜';
  if (p >= 1) return '依目前邏輯一定是莫甘娜';
  if (p <= 0) return '依目前邏輯一定是梅林（不是紅）';
  return `依目前邏輯 ${pct(p)} 是莫甘娜`;
}

/** ④ 你的派票放出的資訊：第一行是白話結論（後面的人會讀成什麼），細節在後面。 */
export function releaseLines(r: ReleasePanel, seat: number, ownInterval?: { worlds: number; clean: number; yours?: boolean }): ReplyPart[] {
  const parts: ReplyPart[] = [];
  const claim = seatList(seatsOfMask(r.claimMask));
  const who = (p: ProposalEvent): string => (p.leaderSeat === seat ? `你上一次的 ${teamDigits(p.teamSeats)}` : `${seatLabel(p.leaderSeat)} ${teamDigits(p.teamSeats)}`);
  const pair = (x: { a: ProposalEvent; b: ProposalEvent }): string => `${seatLabel(x.a.leaderSeat)}、${seatLabel(x.b.leaderSeat)}`;
  if (r.weight === 0) {
    parts.push({ text: `④ 你這樣派放出的資訊：後面的人沒辦法把 ${claim}（你和隊員）全當好人，因為跟任務結果矛盾；跟前面的派票也合不起來` });
  } else {
    let verdict = '';
    if (r.rejectCommon !== undefined) verdict = `；你等於在說 ${seatLabel(r.rejectCommon)} 的派票不是好人派的`;
    else if (r.rejects.length) verdict = `；你等於在說 ${r.rejects.slice(0, 3).map(pair).join('／')} 至少一個錯`;
    parts.push({
      text: `④ 你這樣派放出的資訊：後面的人用${gloss('全好讀法')}看你的派票 → ${claim} 是好人，${restText(r.claimMask, r.weight)}${verdict}`,
    });
    // 都對不可能的有兩次以上（後面幾局五人隊伍很常見）就併成一行，不然一次一行。
    const impossible = r.vs.filter((v) => v.weight === 0);
    const lines = impossible.length >= 2 ? r.vs.filter((v) => v.weight > 0) : r.vs;
    for (const v of lines) {
      const label = gloss(v.label, v.shared.length ? seatList(v.shared) : '');
      const recall = v.recall ? `，${gloss('回選', seatChar(v.proposal.leaderSeat))}` : '';
      const n = popcountMask(v.union);
      // 不能都對：超過 6 人，或（後面的人只看公開資訊）跟任務結果矛盾。
      const tail = v.weight === 0
        ? `兩次${gloss('不能都對', n > 6 ? `加起來 ${n} 人＞6` : '跟任務結果矛盾')}`
        : `兩次${gloss('都對')}時${sp(restText(v.union, v.weight, v.worlds))}`;
      parts.push({ text: `・跟 ${who(v.proposal)} 比：${label}${recall} → ${tail}`, optional: true, priority: 2 });
    }
    if (impossible.length >= 2) {
      const opposite = impossible.filter((v) => v.label === '打對邊').map((v) => seatLabel(v.proposal.leaderSeat));
      parts.push({
        text: `・跟 ${impossible.map((v) => who(v.proposal)).join('、')} 都${gloss('不能都對', '合起來超過 6 人或跟任務矛盾')}${opposite.length ? `；跟 ${opposite.join('、')} 是${gloss('打對邊')}` : ''}`,
        optional: true,
        priority: 2,
      });
    }
    if (r.rejects.length) {
      const items = r.rejects.slice(0, 3).map((x) => `${pair(x)} 至少一個錯`);
      const common = r.rejectCommon !== undefined ? ` → 共同點是 ${seatLabel(r.rejectCommon)}，等於在說 ${seatLabel(r.rejectCommon)} 的派票不是好人派的` : '';
      parts.push({ text: `・你在說：${items.join('；')}${common}`, optional: true, priority: 3 });
    }
  }
  if (ownInterval) {
    const whose = intervalOwnerWords(ownInterval.yours !== false);
    parts.push({
      text: ownInterval.worlds === 0
        ? `・最後檢查：${whose}合起來不可能，先改 /區間`
        : `・最後檢查（照${whose}，剩 ${ownInterval.worlds} 種）：${teamDigits(r.team)} 全好的有 ${ownInterval.clean} 種（${pct(ownInterval.clean / ownInterval.worlds)}）`,
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
  if (r.contrast && r.weight > 0) {
    const c = r.contrast;
    parts.push({
      text: `・對照：改派 ${teamDigits(c.alternative)} 會跟 ${seatLabel(c.proposal.leaderSeat)} ${teamDigits(c.proposal.teamSeats)} ${gloss('打對邊')} → 兩次${gloss('都對')}時${sp(restText(c.union, c.weight, c.worlds))}（派 ${teamDigits(r.team)} 則是${sp(restText(c.yourUnion, c.yourWeight))}）`,
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

export const PROPOSE_FOOTER = '/區間 寫你的區間｜/下一步｜/公布｜/結束｜/模擬 說明';
export const LOGIC_SEEN_LINE = '③ 邏輯與派票解讀跟這一題第一次 /派 的回覆一樣（還是同一個決定點）';

export function formatProposeFeedback(input: ProposeInput, extras: { sight: Sight; shown: PublicEvent[]; ownLakes?: { targetSeat: number; evil: boolean }[] }): string {
  const role = input.game.seatRoles[input.seat - 1];
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${input.exerciseId}・${seatLabel(input.seat)}${roleShort(role)}】你派 ${teamDigits(input.team)}` });
  parts.push({ text: realPlayerLine(input) });
  parts.push(...releaseLines(input.release, input.seat, input.ownInterval));
  if (input.showLogic === false) parts.push({ text: LOGIC_SEEN_LINE });
  else parts.push(...logicLines(input.logic, extras.sight, input.seat, extras.shown, role, input.decision.round));
  // ② 的分布先省略（priority 7）；「跟你同樣派法」三方比較留久一點（priority 3）。
  humanLines(input).forEach((t, i) => parts.push({ text: t, optional: i > 0, priority: t.startsWith(LEAK_PREFIX) ? 3 : 7 }));
  parts.push({ text: PROPOSE_FOOTER });
  if (input.shared) parts.push({ text: sharedNote(input.platform) });
  return assembleReply(parts, SIM_REPLY_MAX_CHARS, SIM_PROPOSE_SOFT_MAX_CHARS);
}

// ─── /區間 ────────────────────────────────────────────────────────────────

export const INTERVAL_HEAD_NOTE = '這裡只用確定的資訊檢查有沒有矛盾，不判斷像不像（像不像要靠你讀派票，/公布 對答案）';

/** 一組區間的白話：`7 8 9 裡有 2 紅`、`4 6 都是好人`。 */
export function intervalGroupWords(g: IntervalGroup): string {
  const seats = seatList(g.seats);
  if (g.min === 0 && g.max === 0) return `${seats} 都是好人`;
  if (g.min === g.seats.length && g.max === g.seats.length) return `${seats} 都是紅`;
  return `${seats} 裡有 ${redCount(g.min, g.max)}`;
}

export function formatInterval(exerciseId: string, ev: IntervalEval, model: SimBeliefModel, seat: number, coAnswer = false): string {
  const lines: string[] = [];
  let single = '';
  for (const g of ev.groups) {
    const name = formatIntervalGroup(g.group);
    const head = `${name}（${intervalGroupWords(g.group)}）`;
    let verdict: string;
    if (g.self && g.seats.length === 0) {
      const you = g.self === 'good' ? '你是好人' : '你是紅';
      verdict = `只寫了你自己（${seatLabel(seat)}，${you}）→ ${g.contradiction ? '跟你的身分矛盾' : '一定成立，沒有縮小範圍'}`;
    } else {
      let self = '';
      if (g.self === 'good') self = `你是好人，所以等於 ${seatList(g.seats)} 裡有 ${redCount(g.min, g.max)} → `;
      if (g.self === 'red') self = `你是紅，所以等於 ${seatList(g.seats)} 裡有 ${redCount(g.min, g.max)} → `;
      if (g.contradiction === 'self') verdict = '跟你自己的身分矛盾';
      else if (g.contradiction === 'sight') verdict = `${self}不可能（跟你看到的資訊矛盾）`;
      else if (g.contradiction === 'mission') verdict = `${self}不可能（跟任務結果矛盾）`;
      else verdict = `${self}可能，${ev.total} 種裡有 ${g.weight} 種符合`;
    }
    lines.push(`・${head}：${verdict}`);
    single = `${name} ${verdict.replace(/^.*→ /u, '')}`;
  }
  let conclusion: string;
  if (ev.groups.length >= 2) {
    const anyBad = ev.groups.some((g) => g.contradiction);
    if (ev.jointWeight > 0) {
      const list = ev.jointWorlds.length <= 3 ? `（紅方只能是 ${ev.jointWorlds.map(maskDigits).join('、')}）` : '';
      conclusion = `你寫的區間沒有矛盾，紅方可能的組合從 ${ev.total} 種縮到 ${ev.jointWeight} 種${list}`;
      lines.push(`・全部一起：${ev.total} 種縮到 ${ev.jointWeight} 種${list}`);
    } else {
      conclusion = anyBad ? '有一組不可能，先改那一組' : '每一組單看都可能，但合起來互相矛盾';
      lines.push(`・全部一起：不可能${anyBad ? '' : '（各組合起來互相矛盾）'}`);
    }
  } else {
    conclusion = single;
  }
  const parts: ReplyPart[] = [];
  if (coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${exerciseId} 區間】結論：${conclusion}` });
  parts.push({ text: `怎麼讀：${gloss('區間')}是你自己的判斷。${model.weighsBehaviour ? model.label : INTERVAL_HEAD_NOTE}` });
  for (const l of lines) parts.push({ text: l });
  parts.push({ text: '/派 作答（會照你的區間做最後檢查）｜/下一步｜/公布' });
  return assembleReply(parts);
}

// ─── /下一步 ──────────────────────────────────────────────────────────────

export const REPLAY_NOTE = '（之後照實際對局進行，你的答案不改變後面發生的事）';

export interface NextInput {
  exerciseId: string;
  game: SimGame;
  seat: number;
  /** 這次新顯示的事件。 */
  events: PublicEvent[];
  /** 下一次輪到你；null = 你沒有下一次派票了。 */
  next: ProposalEvent | null;
  /** 到下一次為止看得到的全部事件（算事實用）。 */
  shownAll: PublicEvent[];
  showNote: boolean;
  platform: SimPlatform;
  coAnswer?: boolean;
}

export function formatNext(input: NextInput): string {
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${input.exerciseId} 下一步】${input.showNote ? REPLAY_NOTE : ''}` });
  parts.push({ text: codeBlock(eventLines(input.events, input.seat, input.game), input.platform) });
  // 開題時還沒有派票（第 1 局第一個隊長）：第一次印出派票時講怎麼讀（+ -、任務的 o x）。
  const before = input.shownAll.slice(0, input.shownAll.length - input.events.length);
  const firstShown = input.events.find((e): e is ProposalEvent => e.kind === 'proposal');
  if (firstShown && !before.some((e) => e.kind === 'proposal')) {
    parts.push({ text: notationNote(firstShown, { quests: input.events.some((e) => e.kind === 'quest') }) });
  }
  if (input.events.some((e) => e.kind === 'proposal' && !e.votesReliable)) parts.push({ text: UNRELIABLE_NOTE, optional: true, priority: 2 });
  if (input.next) {
    parts.push({ text: decisionPrompt(input.next) });
    // 只有出過失敗牌的任務有確定資訊（成功不代表全好）。
    const facts = input.shownAll.filter((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest' && e.failCount > 0);
    if (facts.length > 0) parts.push({ text: `・確定的事：${facts.map(missionFact).join('；')}`, optional: true, priority: 1 });
    for (const line of answerHint(input.next)) parts.push({ text: line });
    parts.push({ text: ANSWER_FOOTER });
  } else {
    const fails = input.shownAll.filter((e) => e.kind === 'quest' && e.failed).length;
    parts.push({ text: fails >= 3 ? '三紅：任務失敗三次，對局結束。' : '三藍：任務成功三次，接著是刺殺（誰被刺、結果在 /公布；v1 還不能練刺殺）。' });
    parts.push({ text: '你在這局沒有下一次派票了。/公布 看角色和你的答案｜/結束' });
  }
  return assembleReply(parts);
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
  /** 區間是你自己寫的（沒給 = 是）；否則寫「這題目前的區間」、區間那一行標「（代答）」。 */
  intervalYours?: boolean;
  /** 從開局到你最後一個決定點，看過的每一次派票。 */
  proposals: ProposalEvent[];
  coAnswer?: boolean;
}

const ROLE_ORDER: Role[] = ['merlin', 'percival', 'mordred', 'morgana', 'assassin', 'oberon'];
/** 百科的代碼順序：刺 娜 莫 奧 派 梅。 */
const CODE_ORDER: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin'];

export function roleCode(game: Pick<SimGame, 'seatRoles'>): string {
  return CODE_ORDER.map((r) => {
    const i = game.seatRoles.indexOf(r);
    return i < 0 ? '' : `${ROLE_CODE[r]}${seatChar(i + 1)}`;
  }).join('');
}

function proposalVerdict(p: ProposalEvent, g: SimGame): string {
  const role = g.seatRoles[p.leaderSeat - 1];
  const reds = p.teamSeats.filter((s) => isRed(g.seatRoles[s - 1]));
  const leaderRed = isRed(role);
  let note: string;
  if (reds.length === 0) note = leaderRed ? '0紅（隊長紅）' : '全好';
  else note = `${reds.length}紅${leaderRed && p.teamSeats.includes(p.leaderSeat) ? '（含自己）' : ''}`;
  return `${seatChar(p.leaderSeat)}${ROLE_CODE[role]} ${teamDigits(p.teamSeats)} ${note}`;
}

export function formatReveal(input: RevealInput): string {
  const g = input.game;
  const redMask = maskOf(g.seatRoles.map((r, i) => (isRed(r) ? i + 1 : 0)).filter(Boolean));
  const roleSeat = (r: Role): number => g.seatRoles.indexOf(r) + 1;
  const parts: ReplyPart[] = [];
  if (input.coAnswer) parts.push({ text: CO_ANSWER_MARK });
  parts.push({ text: `【${input.exerciseId} 公布】你是 ${seatLabel(input.seat)}・${ROLE_ZH[g.seatRoles[input.seat - 1]]}` });
  const loyal = g.seatRoles.map((r, i) => (r === 'loyal' ? i + 1 : 0)).filter(Boolean);
  parts.push({ text: `角色：${ROLE_ORDER.map((r) => `${ROLE_ZH[r]}${seatChar(roleSeat(r))}`).join(' ')}；忠臣 ${seatList(loyal)}（${roleCode(g)}）` });
  parts.push({ text: `紅：${seatList(seatsOfMask(redMask))}` });

  const viewerRed = isRed(g.seatRoles[input.seat - 1]);
  // 有代答派的（或這次是代答）就寫「這題的派票」：不全是看這則回覆的人派的。
  const mixed = input.coAnswer || input.answers.some((a) => a.teams.some((t) => t.coAnswer));
  if (input.answers.length > 0) {
    const items = input.answers.map(({ decision, teams }) => {
      const label = input.answers.length > 1 ? `第 ${decision.round} 局 ` : '';
      const each = teams.map(({ team, coAnswer }) => {
        const reds = team.filter((s) => isRed(g.seatRoles[s - 1]));
        const mark = viewerRed ? '' : reds.length === 0 ? '✓' : '✗';
        return `${teamDigits(team)}${coAnswer ? CO_ANSWER_TAG : ''}：${reds.length} 紅${reds.length ? `（${seatList(reds)}）` : ''}${mark}`;
      });
      return `${label}${each.join('、')}`;
    });
    parts.push({ text: `${mixed ? '這題的派票' : '你的派票'}：${items.join('；')}` });
  } else {
    parts.push({ text: input.coAnswer ? '這題沒有人作答。' : '你這題沒有作答。' });
  }
  if (input.interval && input.interval.length > 0) {
    const yours = input.intervalYours !== false;
    const items = input.interval.map((grp) => {
      const reds = grp.seats.filter((s) => isRed(g.seatRoles[s - 1]));
      return `${formatIntervalGroup(grp)} ${intervalGroupTrue(grp, redMask) ? '✓' : '✗'}（${reds.length ? `紅 ${seatList(reds)}` : '0 紅'}）`;
    });
    parts.push({ text: `區間${yours ? '' : CO_ANSWER_TAG}：${items.join('、')}` });
    if (input.intervalWorlds) {
      const kept = input.intervalWorlds.includes(redMask);
      const whose = yours ? '你的區間' : intervalOwnerWords(false);
      parts.push({ text: kept ? `・真正的紅方在${whose}留下的 ${input.intervalWorlds.length} 種裡 ✓` : `・真正的紅方不在${whose}留下的組合裡 ✗` });
    }
  }
  if (input.proposals.length > 0) {
    parts.push({ text: '派票對答案（座位＋角色、隊伍、隊上幾紅）：', optional: true, priority: 1 });
    const rounds = [...new Set(input.proposals.map((p) => p.round))];
    for (const r of rounds) {
      const items = input.proposals.filter((p) => p.round === r).map((p) => proposalVerdict(p, g));
      parts.push({ text: `第 ${r} 局：${items.join('、')}`, optional: true, priority: 1 });
    }
  }
  const fails = g.quests.filter((q) => q.failed).length;
  let result: string;
  if (fails >= 3) result = '三紅';
  else if (g.winner === 'evil') result = g.assassinTargetSeat ? `三藍死（刺 ${seatLabel(g.assassinTargetSeat)}，刺中梅林）` : '三藍死';
  else result = g.assassinTargetSeat ? `三藍活（刺 ${seatLabel(g.assassinTargetSeat)}，沒刺中）` : '三藍活';
  parts.push({ text: `這局結果：${result}` });
  parts.push({ text: '再來一題：/模擬' });
  return assembleReply(parts);
}

// ─── 固定短句 ─────────────────────────────────────────────────────────────

export const NO_SESSION_TEXT = '你目前沒有進行中的模擬（太久沒動作、開了別的題或伺服器重新啟動都會結束）。輸入 /模擬 開一題，/模擬 說明 看全部指令';
export const BANK_NOT_READY_TEXT = '模擬瓦題庫還沒準備好，請稍後再試。';
export const RATE_LIMITED_TEXT = '模擬指令太頻繁了，10 分鐘後再試。';
export const START_USAGE = '用法：/模擬｜/模擬 角色 座位（例：/模擬 派西 2、/模擬 梅林、/模擬 7、/模擬 紅）｜/模擬 題 題號｜/模擬 說明';
export const PROPOSE_USAGE = '用法：/派 加座位，例如 /派 469 = 派 4、6、9家（0 = 10家；4 6 9、4,6,9 也可以）';
export const INTERVAL_USAGE = '用法：/區間 789=2 460=1 = 7 8 9 裡有 2 紅、4 6 0 裡有 1 紅（也可以 7 8 9 *2、12=1-2、1 5 9 *1+、3 紅、5=好；各組可以重疊）';

/** 說明的第一行（兩個平台一樣）。 */
const HELP_TITLE = '🧩 模擬瓦指令（真人對局停在某一家要派票的當下，換你來派，看你的派票放出什麼資訊）';
const HELP_PROPOSE_WORDS = '作答：派 4、6、9家（0 = 10家；人數要對，可以派好幾次比較）';
const HELP_INTERVAL_WORDS = '（選填）寫你覺得哪幾個座位裡有幾個紅：7 8 9 裡 2 紅、4 6 0 裡 1 紅';
const HELP_NEXT = '/下一步\u3000照實際對局走到你下一次派票（還沒作答也可以跳過）';
const HELP_END = '/結束\u3000不公布，直接結束';

/**
 * LINE 的 /模擬 說明（/模擬 幫助、/模擬 指令、/模擬 ?）和只回模擬的 LINE 練習群（SIM_LINE_GROUP_IDS）裡的 /指令：
 * 全部指令，每個一行白話。
 */
export const SIM_HELP_TEXT = [
  HELP_TITLE,
  '/模擬\u3000隨機開一題（第 1 局、2～5 家、任何角色）',
  '/模擬 角色 座位\u3000指定角色或座位，例：/模擬 派西 2、/模擬 梅林、/模擬 7、/模擬 紅',
  '/模擬 題 題號\u3000做指定的題目，例：/模擬 題 K7Q2M-4（大家可以做同一題）',
  `/派 469\u3000${HELP_PROPOSE_WORDS}`,
  `/區間 789=2 460=1\u3000${HELP_INTERVAL_WORDS}`,
  HELP_NEXT,
  '/公布\u3000公布角色、對答案，這題結束（也可以打 /解答）',
  HELP_END,
  '/模擬 說明\u3000這份說明（/模擬 幫助、/模擬 指令、/模擬 ? 也可以）',
  '群組裡自己沒開題的人也可以幫忙答群組裡最新開的一題（/派 /區間 /下一步 /公布 /結束），回覆會標「代答」；'
    + '誰打 /公布 或 /結束 都會結束那一題。1 對 1 聊天沒有代答。',
].join('\n');

/** Discord 的 /模擬 說明:True：跟 slash 指令的選項名一樣（角色、座位、題號、隊伍、內容）；Discord 沒有 /解答。 */
export const SIM_HELP_TEXT_DISCORD = [
  HELP_TITLE,
  `/${COMMANDS.SIM}\u3000隨機開一題（第 1 局、2～5 家、任何角色）`,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.ROLE}:派西維爾 ${SIM_OPTIONS.SEAT}:2\u3000指定角色或座位（可以只選一個；${SIM_OPTIONS.ROLE}選 紅／藍 = 隨機紅方／藍方角色）`,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.ID}:K7Q2M-4\u3000做指定的題目（大家可以做同一題）`,
  `/${COMMANDS.SIM_PROPOSE} ${SIM_OPTIONS.TEAM}:469\u3000${HELP_PROPOSE_WORDS}`,
  `/${COMMANDS.SIM_INTERVAL} ${SIM_OPTIONS.CONTENT}:789=2 460=1\u3000${HELP_INTERVAL_WORDS}`,
  HELP_NEXT,
  `/${COMMANDS.SIM_REVEAL}\u3000公布角色、對答案，這題結束`,
  HELP_END,
  `/${COMMANDS.SIM} ${SIM_OPTIONS.HELP}:True\u3000這份說明`,
  '回覆公開的頻道裡，自己沒開題的人也可以幫忙答頻道裡最新開的一題（/派 /區間 /下一步 /公布 /結束），回覆會標「代答」；'
    + '誰打 /公布 或 /結束 都會結束那一題。只有自己看得到回覆的頻道沒有代答。',
].join('\n');

/** 這個平台的 /模擬 說明。 */
export function simHelpText(platform: SimPlatform): string {
  return platform === 'discord' ? SIM_HELP_TEXT_DISCORD : SIM_HELP_TEXT;
}

export function usageText(command: 'start' | 'propose' | 'interval', problem?: string): string {
  const usage = command === 'start' ? START_USAGE : command === 'propose' ? PROPOSE_USAGE : INTERVAL_USAGE;
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
  const why = reason === 'expired' ? '太久沒動作' : '同時開的題目太多，最久沒動的先結束';
  return `你的模擬 ${exerciseId} 已經結束（${why}）。/模擬 題 ${exerciseId} 從頭再做一次，或 /模擬 開新的一題`;
}

export function thinPoolText(role: Role, seat: number, n: number, available: readonly number[]): string {
  const where = available.length ? `這個角色題目夠的座位：${seatList(available)}` : '這個角色目前沒有題目夠的座位';
  return `${ROLE_ZH[role]}在 ${seatLabel(seat)} 只有 ${n} 題（少於 20 題先不出）。${where}`;
}

export function unknownIdText(): string {
  return '找不到這個題號。題號長得像 K7Q2M-4（題庫代號-座位）。';
}

export function noDecisionText(seat: number): string {
  return `這一局 ${seatLabel(seat)} 沒有${seat <= 5 ? '第 1 局' : '第 2 局'}的派票（那一局提早出發），換一題吧。`;
}
