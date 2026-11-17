/**
 * Threads 每日出題（2026-11-17）— 一天的草稿：新貼文 A（今天的題目＋昨天的答案）、第一則留言的空位，純函式。
 *
 * Edward 2026-11-11 定案的格式（取代較早的「答案另外串在昨天底下」）：
 *   每天一篇新貼文 A，引用昨天的貼文 B；B = 問題 1＋解答 0，A = 問題 2＋解答 1。
 *   第一則留言＝跟這題相關的數據冷知識／觀念＋文章網址（ChatGPT 寫稿，Issue #37；這裡只留空位與建議的文章）。
 *   不另外在昨天底下串答案。不用私訊對答案、不當天公布。
 * 週四、週六延續同一局時，A 裡的昨天答案只講真人派了什麼、之後公開的事（任務結果）和純邏輯的理由，
 * 不講幾好幾壞和角色（同一局還在打）；完整答案在隔天（週五、週日）的 A 一起公布（Edward 11/17「照現在這樣」）。
 * A 的 500 字同時包含題目和答案：先縮題目的牌譜（前面幾局只留任務與湖 → 「完整局面看圖」），
 * 再縮答案（拿掉理由）；牌譜連結一定留。
 *
 * 發文：站長加好權杖、打開 THREADS_PUBLISH 之後由自動發佈的工作流程每天發（publish/、.github/workflows/threads-publish.yml）；
 * 站長也可以照草稿手動發。
 */

import type { Role } from '@avalon/shared';
import { STATS_SITE_URL } from '../stats/statsReplies';
import { ROLE_ZH } from '../simulation/commands';
import { logicModel } from '../simulation/logic';
import { recordUrl } from '../simulation/recordsIndex';
import { eventLines, identityLine, questLine, resultText, roleCode, seatLabel, pct } from '../simulation/replies';
import { TEAM_SIZES, eventIndexOfProposal, isRed, publicEvents, viewAt, type PublicEvent, type SimGame, type SimView } from '../simulation/scenario';
import { maskOf, seatList, seatsOfMask, teamDigits } from '../simulation/seats';
import { exerciseIdOfPick, labelFor, weekdayOf, type ThreadsPick } from './plan';

/** Threads 一則貼文的字數上限。 */
export const THREADS_MAX_CHARS = 500;
/** 每篇新貼文最後一行的主題標籤（Edward 2026-11-17「加 #阿瓦隆」）。 */
export const THREADS_TOPIC_TAG = '#阿瓦隆';

/** 每個主題建議的百科文章（第一則留言附網址；ChatGPT 可以換）。id 對 wiki_data.json。 */
export const THREADS_ARTICLES: Readonly<Record<string, readonly string[]>> = {
  assassin: ['wiki-12', 'wiki-56', 'wiki-175'],
  percival: ['wiki-176', 'wiki-165'],
  'tail-1': ['wiki-205', 'wiki-206', 'wiki-57'],
  'tail-2': ['wiki-205', 'wiki-206'],
  'tail-3': ['wiki-206', 'wiki-24', 'wiki-18'],
  'tail-4': ['wiki-206', 'wiki-207'],
  final: ['wiki-207', 'wiki-206'],
  round4: ['wiki-207', 'wiki-24'],
  lake: ['wiki-147'],
};

/** 百科文章的分享網址（有 Open Graph 預覽，Threads 會顯示卡片）。 */
export function wikiShareUrl(id: string): string {
  return `${STATS_SITE_URL}/w/${encodeURIComponent(id)}/`;
}

function articleKey(pick: ThreadsPick): string {
  if (pick.kind === 'tail') return `tail-${pick.round}`;
  return pick.kind;
}

// ─── 視角 ─────────────────────────────────────────────────────────────────

export interface PickView {
  game: SimGame;
  pick: ThreadsPick;
  exerciseId: string;
  view: SimView;
  /** 決定當下看得到的事件。 */
  shown: PublicEvent[];
}

export function pickView(game: SimGame, pick: ThreadsPick): PickView {
  const events = publicEvents(game);
  const cursor = pick.proposal === null ? events.length : eventIndexOfProposal(events, pick.proposal);
  const view = viewAt(game, pick.seat, cursor, events);
  return { game, pick, exerciseId: exerciseIdOfPick(pick, game), view, shown: view.events };
}

function decisionWords(game: SimGame, pick: ThreadsPick): string {
  if (pick.proposal === null) return '三藍：輪到你刺殺。誰是梅林？';
  const p = game.proposals[pick.proposal];
  const size = TEAM_SIZES[p.round - 1];
  const forced = p.attempt === 5 ? '，強制出發' : '';
  return `輪到你派 ${size} 人（第 ${p.round} 局第 ${p.attempt} 次${forced}）。你會派誰？`;
}

/** 事件行太長時的縮短版：前面幾局只留任務結果和湖，當下這一局的派票全留。 */
function compactLines(pv: PickView): string[] {
  const round = pv.pick.proposal === null ? 6 : pv.game.proposals[pv.pick.proposal].round;
  const lines: string[] = [];
  for (const e of pv.shown) {
    if (e.kind === 'proposal') {
      if (e.round < round) continue;
      if (!lines.includes(`第 ${e.round} 局：`)) lines.push(`第 ${e.round} 局：`);
      lines.push(eventLines([e], pv.pick.seat, pv.game, { startRound: e.round })[0]);
    } else if (e.kind === 'quest') lines.push(`第 ${e.round} 局 ${questLine(e)}`);
    else lines.push(eventLines([e], pv.pick.seat, pv.game, { startRound: e.round })[0]);
  }
  return lines;
}

function continuesLine(from: { exerciseId: string; seat: number }, seat: number): string {
  return from.seat === seat
    ? `接昨天那一局（${from.exerciseId}），同一家又輪到尾派：`
    : `接昨天那一局（${from.exerciseId}），這次換 ${seatLabel(seat)}的視角：`;
}

/** 牌譜縮到最短時的那一行：貼文的牌譜要靠圖才完整（沒有圖就不能自動發）。 */
export const SEE_IMAGE_LINE = '（完整局面看圖）';

/** 題目的部分：開頭（身分）、牌譜的三種長度（完整 → 縮短 → 看圖）、結尾（輪到你、怎麼作答）。 */
export function questionParts(pv: PickView, opts: { continuesFrom?: { exerciseId: string; seat: number } } = {}): { head: string[]; bodies: string[][]; tail: string[] } {
  const role = pv.game.seatRoles[pv.pick.seat - 1];
  const head = [
    ...(opts.continuesFrom ? [continuesLine(opts.continuesFrom, pv.pick.seat)] : []),
    identityLine(pv.pick.seat, role, pv.view.sight),
  ];
  const noPrior = !pv.shown.some((e) => e.kind === 'proposal');
  const bodies: string[][] = noPrior
    ? [['第 1 局第一個隊長，前面沒有派票']]
    : [eventLines(pv.shown, pv.pick.seat, pv.game), compactLines(pv), [SEE_IMAGE_LINE]];
  // 站長 11/17：「文字部分則是主題 & 牌譜」——題目只留身分、牌譜、輪到你；作答方式不另寫一行（完整局面在圖裡）。
  return { head, bodies, tail: [decisionWords(pv.game, pv.pick)] };
}

/** A 的最後兩行：題號與主題標籤。 */
function footerLines(pv: PickView): string[] {
  return [`題號 ${pv.exerciseId}`, THREADS_TOPIC_TAG];
}

/**
 * 新貼文 A：標題、今天的題目、昨天的答案、題號、主題標籤（≤ 500 字）。
 * 答案先用完整版、題目從完整牌譜縮到看圖；都放不下再換短的答案。
 */
export function postText(pv: PickView, opts: { weekday: number; continuesFrom?: { exerciseId: string; seat: number }; answers?: string[][] }): string {
  const title = `【阿瓦隆每日一題｜${labelFor(opts.weekday, pv.pick)}】`;
  const q = questionParts(pv, opts);
  const answers = opts.answers && opts.answers.length > 0 ? opts.answers : [[]];
  let last = '';
  for (const ans of answers) {
    for (const body of q.bodies) {
      last = [title, ...q.head, ...body, ...q.tail, ...ans, ...footerLines(pv)].join('\n');
      if ([...last].length <= THREADS_MAX_CHARS) return last;
    }
  }
  return last;
}

// ─── 純邏輯的理由 ─────────────────────────────────────────────────────────

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let s = start; s <= n; s++) {
      cur.push(s);
      rec(s + 1);
      cur.pop();
    }
  };
  rec(1);
  return out;
}

export interface LogicReason {
  /** 這個視角（純邏輯，只用看得到的資訊）還可能的紅方組合數。 */
  worlds: number;
  /** 真人派的隊在幾種裡全好。 */
  teamClean: number;
  /** 全好組合最多的隊（同分的都列）與種數。百分比＝紅方可能組合中全好的比例（每種組合算一樣多），不是勝率。 */
  best: { teams: number[][]; clean: number };
}

export function logicReason(pv: PickView): LogicReason | null {
  if (pv.pick.proposal === null) return null;
  const p = pv.game.proposals[pv.pick.proposal];
  const worlds = logicModel.worlds(pv.view).map((w) => w.redMask);
  if (worlds.length === 0) return null;
  const clean = (team: readonly number[]): number => {
    const m = maskOf(team);
    return worlds.filter((w) => (w & m) === 0).length;
  };
  let best = { teams: [] as number[][], clean: -1 };
  for (const team of combinations(10, TEAM_SIZES[p.round - 1])) {
    const c = clean(team);
    if (c > best.clean) best = { teams: [team], clean: c };
    else if (c === best.clean) best.teams.push(team);
  }
  return { worlds: worlds.length, teamClean: clean(p.teamSeats), best };
}

// ─── 昨天的答案（放在 A 裡）──────────────────────────────────────────────

function teamGoodBad(game: SimGame, team: readonly number[]): string {
  const reds = team.filter((s) => isRed(game.seatRoles[s - 1])).length;
  return `${team.length - reds} 好 ${reds} 壞`;
}

function missionWords(game: SimGame, round: number): string {
  const q = game.quests.find((x) => x.round === round);
  if (!q) return '出發';
  return `${'o'.repeat(q.successCount)}${'x'.repeat(q.failCount)} 任務${q.failed ? '失敗' : '成功'}`;
}

function realDecisionLine(pv: PickView, withTruth: boolean): string {
  const p = pv.game.proposals[pv.pick.proposal as number];
  const role: Role = pv.game.seatRoles[p.leaderSeat - 1];
  const who = withTruth ? `${seatLabel(p.leaderSeat)}・${ROLE_ZH[role]}` : seatLabel(p.leaderSeat);
  let line = `真人（${who}）派 ${teamDigits(p.teamSeats)}`;
  if (withTruth) line += `：${teamGoodBad(pv.game, p.teamSeats)}`;
  line += p.wentOnMission ? `，${missionWords(pv.game, p.round)}` : '，沒有出發';
  return line;
}

/** 一行的純邏輯理由（只用那一家當下看得到的資訊）。 */
function reasonLine(pv: PickView): string | null {
  const r = logicReason(pv);
  if (!r) return null;
  const share = (n: number): string => pct(n / r.worlds);
  const bestTeams = r.best.teams.slice(0, 2).map(teamDigits).join('、') + (r.best.teams.length > 2 ? ` 等 ${r.best.teams.length} 隊` : '');
  return `理由（純邏輯）：紅方還有 ${r.worlds} 種可能，這隊 ${r.teamClean} 種全好（${share(r.teamClean)}）；全好組合最多：${bestTeams}（${share(r.best.clean)}）`;
}

function revealLines(game: SimGame, recordId: string | undefined): string[] {
  const reds = seatsOfMask(maskOf(game.seatRoles.map((r, i) => (isRed(r) ? i + 1 : 0)).filter(Boolean)));
  return [
    `角色 ${roleCode(game)}（紅 ${seatList(reds)}）｜${resultText(game)}`,
    recordId ? `牌譜：${recordUrl(recordId)}` : '（網站上還沒有這一局的牌譜頁）',
  ];
}

export interface AnswerInput {
  /** 昨天的題目。 */
  yesterday: PickView;
  /** 昨天延續的那一題（週四延續週三）：完整公布時一起公布。 */
  earlier?: PickView;
  /** 今天延續昨天同一局：不公布幾好幾壞和角色。 */
  todayContinues: boolean;
  recordId?: string;
}

/**
 * 昨天的答案（放進今天的 A）：長到短的幾個版本，第一個最完整，之後拿掉理由。
 * 延續的日子不公布幾好幾壞和角色；隔天兩題一起完整公布。
 */
export function answerVariants(input: AnswerInput): string[][] {
  const y = input.yesterday;
  const head = `── 昨天 ${y.exerciseId} 的答案 ──`;
  if (y.pick.kind === 'assassin') {
    const merlin = y.game.seatRoles.indexOf('merlin') + 1;
    const target = y.game.assassinTargetSeat;
    const line = `梅林是 ${seatLabel(merlin)}${target ? `；真人刺 ${seatLabel(target)}（${target === merlin ? '刺中' : '沒刺中'}）` : ''}`;
    return [[head, line, ...revealLines(y.game, input.recordId)]];
  }
  const why = reasonLine(y);
  if (input.todayContinues) {
    const base = [head, realDecisionLine(y, false)];
    const note = '幾好幾壞和角色明天公布（今天同一局接著打）';
    return why ? [[...base, why, note], [...base, note]] : [[...base, note]];
  }
  const earlier = input.earlier ? [`前一題 ${input.earlier.exerciseId}：${realDecisionLine(input.earlier, true)}`] : [];
  const base = [head, ...earlier, realDecisionLine(y, true)];
  const reveal = revealLines(y.game, input.recordId);
  return why ? [[...base, why, ...reveal], [...base, ...reveal]] : [[...base, ...reveal]];
}

/** 最完整的那一版（測試、預覽用）。 */
export function answerText(input: AnswerInput): string {
  return answerVariants(input)[0].join('\n');
}

// ─── 一天的草稿 ───────────────────────────────────────────────────────────

export interface FirstCommentSlot {
  /** ChatGPT 填（Issue #37）：一則跟今天題目有關的數據冷知識或觀念，結尾附一篇文章網址。沒填是 null。 */
  text: string | null;
  /** 給 ChatGPT 的提示。 */
  brief: string;
  /** 建議的文章（id、標題、分享網址），第一篇最相關。 */
  articles: { id: string; title: string; url: string }[];
  /** 這題的關鍵字（挑冷知識用）。 */
  tags: string[];
}

export interface ThreadsDraft {
  date: string;
  weekday: number;
  theme: string;
  exerciseId: string;
  /** 存下來給隔天的答案用（題庫代號不會變）。 */
  pick: ThreadsPick;
  recordId?: string;
  /** 新貼文 A（今天的題目＋昨天的答案）。 */
  /**
   * 輪播的圖，依序：image = 題目卡（只能發一張時發它）；gridImage = 牌譜圖（網站牌譜頁的格子，只到出題那一刻）；
   * answerImage = 公布完整答案的日子另附的答案卡（昨天那一局的角色，紅方在上）。
   */
  post: { text: string; chars: number; image?: string; gridImage?: string; answerImage?: string };
  /** A 要引用昨天的貼文 B 發（有昨天的題目就是 true）。 */
  quoteYesterday: boolean;
  /** 今天延續昨天同一局（週四、週六）：A 裡的昨天答案不公布幾好幾壞和角色。 */
  continuesYesterday: boolean;
  /** A 裡的「昨天的答案」那一段（實際放進 A 的版本）；第一天沒有。 */
  answerToYesterday: { date: string; exerciseId: string; text: string } | null;
  firstComment: FirstCommentSlot;
}

function tagsOf(pv: PickView): string[] {
  const tags: string[] = [];
  const kind = pv.pick.kind;
  if (kind === 'assassin') tags.push('刺殺', '找梅林');
  if (kind === 'percival') tags.push('派西維爾', '拇指');
  if (kind === 'tail') tags.push('尾家', `${pv.pick.round}-5`, '強制出發');
  if (kind === 'final') tags.push('第五局', '決勝局');
  if (kind === 'round4') tags.push('第四局', '忠臣派隊', '要 2 張失敗');
  if (pv.shown.some((e) => e.kind === 'lake')) tags.push('湖中女神');
  if (pv.shown.some((e) => e.kind === 'quest' && e.failCount > 0)) tags.push('任務失敗的解讀');
  const role = pv.game.seatRoles[pv.pick.seat - 1];
  if (kind !== 'assassin') tags.push(ROLE_ZH[role]);
  return tags;
}

export function firstCommentSlot(pv: PickView, titles: ReadonlyMap<string, string>): FirstCommentSlot {
  const ids = [...(THREADS_ARTICLES[articleKey(pv.pick)] ?? [])];
  if (pv.shown.some((e) => e.kind === 'lake')) ids.push(...THREADS_ARTICLES.lake);
  const articles = [...new Set(ids)].filter((id) => titles.has(id)).map((id) => ({ id, title: titles.get(id) as string, url: wikiShareUrl(id) }));
  return {
    text: null,
    brief: '一則跟今天題目有關的數據冷知識或觀念（≤ 300 字，白話、不劇透今天的答案），結尾附一篇文章網址（從 articles 挑，或換更適合的百科文章）。',
    articles,
    tags: tagsOf(pv),
  };
}

export interface DraftInput {
  date: string;
  today: PickView;
  todayRecordId?: string;
  /** 昨天的題目（沒有就 null：例如第一天）。 */
  yesterday: { date: string; pv: PickView; earlier?: PickView; recordId?: string } | null;
  /** 百科文章 id → 標題。 */
  titles: ReadonlyMap<string, string>;
  image?: string;
}

export function buildDraft(input: DraftInput): ThreadsDraft {
  const weekday = weekdayOf(input.date);
  const continues = !!input.today.pick.continues && !!input.yesterday && input.yesterday.pv.pick.gameId === input.today.pick.gameId;
  const from = continues && input.yesterday ? { exerciseId: input.yesterday.pv.exerciseId, seat: input.yesterday.pv.pick.seat } : undefined;
  const answers = input.yesterday
    ? answerVariants({ yesterday: input.yesterday.pv, earlier: input.yesterday.earlier, todayContinues: continues, recordId: input.yesterday.recordId })
    : [];
  const text = postText(input.today, { weekday, ...(from ? { continuesFrom: from } : {}), answers });
  // 實際放進 A 的是哪一版答案（找第一個整段出現在 A 裡的）。
  const used = answers.find((a) => text.includes(a.join('\n'))) ?? null;
  return {
    date: input.date,
    weekday,
    theme: labelFor(weekday, input.today.pick),
    exerciseId: input.today.exerciseId,
    pick: input.today.pick,
    ...(input.todayRecordId ? { recordId: input.todayRecordId } : {}),
    post: { text, chars: [...text].length, ...(input.image ? { image: input.image } : {}) },
    quoteYesterday: !!input.yesterday,
    continuesYesterday: continues,
    answerToYesterday: input.yesterday && used ? { date: input.yesterday.date, exerciseId: input.yesterday.pv.exerciseId, text: used.join('\n') } : null,
    firstComment: firstCommentSlot(input.today, input.titles),
  };
}

/** 給 Edward 複製貼上的 Markdown。 */
export function draftMarkdown(d: ThreadsDraft): string {
  const out = [`# Threads 草稿 ${d.date}（${d.theme}）`, '', `題號 ${d.exerciseId}${d.recordId ? `｜牌譜 ${recordUrl(d.recordId)}` : ''}`, ''];
  const how = d.answerToYesterday ? `用「引用」昨天（${d.answerToYesterday.date}）的貼文發這篇` : '第一天：直接發（沒有昨天的貼文可以引用）';
  out.push(`## ① 新貼文 A：今天的題目＋昨天的答案（${d.post.chars} 字）`, '', `${how}，附圖。`, '', '```', d.post.text, '```', '');
  if (d.post.image) {
    const imgs = [`${d.post.image}（題目）`, ...(d.post.gridImage ? [`${d.post.gridImage}（牌譜）`] : []), ...(d.post.answerImage ? [`${d.post.answerImage}（昨天的答案）`] : [])];
    out.push(`圖（依序發成輪播）：${imgs.join('、')}`, '');
  }
  out.push('## ② A 的第一則留言（ChatGPT 填）', '');
  out.push(d.firstComment.text ? ['```', d.firstComment.text, '```'].join('\n') : '（還沒填）');
  out.push('', `建議文章：${d.firstComment.articles.map((a) => `${a.title} ${a.url}`).join('；') || '（無）'}`, `關鍵字：${d.firstComment.tags.join('、')}`, '');
  out.push('不用另外在昨天的貼文底下串答案：答案已經在 A 裡。', '');
  return out.join('\n');
}
