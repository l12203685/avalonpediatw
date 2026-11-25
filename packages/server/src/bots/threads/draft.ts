/**
 * Threads 每日出題（2026-11-17）— 一天的草稿：新貼文 A（今天的題目＋昨天的答案）、第一則留言的空位，純函式。
 *
 * Edward 2026-11-11 定案的格式（取代較早的「答案另外串在昨天底下」）：
 *   每天一篇新貼文 A，引用昨天的貼文 B；B = 問題 1＋解答 0，A = 問題 2＋解答 1。
 *   第一則留言＝跟這題相關的數據冷知識／觀念＋文章網址（ChatGPT 寫稿，Issue #37；這裡只留空位與建議的文章）。
 *   不另外在昨天底下串答案。不用私訊對答案、不當天公布。
 * 週四、週六延續同一局時，A 裡的昨天答案只講真人派了什麼、之後公開的事（任務結果）和純邏輯的理由，
 * 不講幾好幾壞和角色（同一局還在打）；完整答案在隔天（週五、週日）的 A 一起公布（Edward 11/17「照現在這樣」）。
 * A 的 500 字同時包含題目和答案：先縮答案（拿掉理由、三個選項那一行），再把題目的局面縮成「完整局面看圖」；
 * 牌譜連結一定留。（2026-11-25 以前貼文放整份牌譜、先縮題目；現在整份牌譜在圖的第 2 張，貼文只放精簡的局面。）
 *
 * 貼文的格式（2026-11-18）：站長在主控台改一次「貼文格式（每天共用）」，每天只換題目的內容；
 * 這裡算每個佔位符的內容（postParts），template.ts 套範本（預設的內建格式跟之前一字不差）。
 *
 * 發文：站長加好權杖、打開 THREADS_PUBLISH 之後由自動發佈的工作流程每天發（publish/、.github/workflows/threads-publish.yml）；
 * 站長也可以照草稿手動發。
 */

import type { Role } from '@avalon/shared';
import { STATS_SITE_URL } from '../stats/statsReplies';
import { ROLE_ZH } from '../simulation/commands';
import { logicModel } from '../simulation/logic';
import { recordUrl } from '../simulation/recordsIndex';
import { eventLines, resultText, roleCode, seatLabel, pct } from '../simulation/replies';
import { TEAM_SIZES, eventIndexOfProposal, isRed, publicEvents, viewAt, type PublicEvent, type SimGame, type SimView } from '../simulation/scenario';
import { maskOf, seatList, seatsOfMask, teamDigits } from '../simulation/seats';
import { exerciseIdOfPick, labelFor, weekdayOf, type ThreadsKind, type ThreadsPick } from './plan';
import { choiceLines, choiceReveal, choicesFor, realLetter } from './choices';
import { DEFAULT_POST_TEMPLATE, LEGACY_POST_TEMPLATE, normalizeTemplate, renderTemplate, typeOf, validateTemplate, type PostParts } from './template';

/** 草稿 JSON 的 parts：每個佔位符這天的內容，加上這天的題型（主控台照題型挑格式；type 不是佔位符）。 */
export type DraftParts = PostParts & { type: { kind: ThreadsKind; name: string } };

/** Threads 一則貼文的字數上限。 */
export const THREADS_MAX_CHARS = 500;
/** 每篇新貼文最後一行的主題標籤（Edward 2026-11-17「加 #阿瓦隆」；同日站長改 11/18 的草稿時換成這四個）。 */
export const THREADS_TOPIC_TAG = '#阿瓦隆 #梅林 #派西維爾 #亞瑟的忠臣';

const WEEKDAY_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/**
 * 一句話的問題（站長 11/25：「希望能更直觀讓看到的人一目瞭然」）：不用認得「1-5 尾派」這種寫法也看得懂在問什麼。
 * 只看題型和第幾局，所以沒有那一局的資料也算得出來（自動發佈靠它認昨天那一篇）。
 */
export function hookQuestion(pick: Pick<ThreadsPick, 'kind' | 'round'>): string {
  switch (pick.kind) {
    case 'assassin': return '好人拿下三局，你是刺客：誰是梅林？';
    case 'percival': return '你是派西維爾，兩根拇指分不出誰是梅林，這一隊派誰？';
    case 'round4': return '第 4 局要 2 張失敗才算失敗，輪到你派 5 人，派誰？';
    case 'final': return '2 比 2 的最後一局，輪到你派 5 人，派誰？';
    case 'tail': return `第 ${pick.round ?? 1} 局前四隊都沒過，最後一隊輪到你派，派誰？`;
  }
}

/**
 * 貼文第一行（標題）＝系列名＋星期＋一句話的問題，例「【阿瓦隆每日一題｜週三】第 1 局前四隊都沒過，最後一隊輪到你派，派誰？」。
 * 滑過去的人第一行就看到在問什麼。自動發佈也用它在最近的貼文裡認出這一天的那一篇（貼文裡沒有題號）。
 */
export function postTitle(weekday: number, pick: Pick<ThreadsPick, 'kind' | 'round' | 'continues'>): string {
  return `【阿瓦隆每日一題｜${WEEKDAY_ZH[((weekday % 7) + 7) % 7]}】${hookQuestion(pick)}`;
}

/** 2026-11-25 以前的標題（「【阿瓦隆每日一題｜週三・1-5 尾派】」）：認舊貼文用（站長之前手動發的那幾天）。 */
export function legacyPostTitle(weekday: number, pick: Pick<ThreadsPick, 'kind' | 'round' | 'continues'>): string {
  return `【阿瓦隆每日一題｜${labelFor(weekday, pick)}】`;
}

/** 牌譜裡每一局的開頭（站長 11/17 改的草稿：「[第 1 局]」）。 */
export function roundHeader(round: number): string {
  return `[第 ${round} 局]`;
}

/** 共用的事件行（「第 N 局：」開頭）換成貼文的寫法「[第 N 局]」。 */
function bracketRounds(lines: readonly string[]): string[] {
  return lines.map((l) => {
    const m = /^第 (\d+) 局：$/.exec(l);
    return m ? roundHeader(Number(m[1])) : l;
  });
}

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

/** 「你是」那一行的三段之間、座位之間的分隔（站長 11/18：「格式改成 "你是 {#}家 {身分} | {內建資訊} | {要做的決策}"」）。 */
export const VIEWER_SEP = ' | ';
export const VIEWER_SEAT_SEP = ' & ';

/** 夜裡知道的資訊（照 sightFor 的知識模型：紅方看到的隊友不含奧伯倫、也不知道隊友的角色；梅林看不到莫德雷德）。 */
export function nightInfo(sight: SimView['sight']): string {
  const seats = (xs: readonly number[]): string => xs.map(seatLabel).join(VIEWER_SEAT_SEP);
  switch (sight.kind) {
    case 'loyal': return '無其他資訊';
    case 'percival': return `看到 ${seats(sight.thumbs)}`;
    case 'merlin': return sight.seen.length ? `看到紅方 ${seats(sight.seen)}` : '沒看到紅方';
    case 'evil': return sight.mates.length ? `隊友 ${seats(sight.mates)}` : '看不到隊友';
    case 'oberon': return '不知道隊友';
  }
}

/** 要做的決策：提議題「派 N 人」、刺殺題「刺殺梅林」（題目只有這兩種）。 */
export function decisionPhrase(game: SimGame, pick: Pick<ThreadsPick, 'proposal'>): string {
  if (pick.proposal === null) return '刺殺梅林';
  return `派 ${TEAM_SIZES[game.proposals[pick.proposal].round - 1]} 人`;
}

/** 刺殺階段的隊友順序（站長的例子：莫甘娜、莫德雷德、奧伯倫）。 */
const ASSASSINATION_MATE_ORDER: readonly Role[] = ['morgana', 'mordred', 'oberon', 'minion', 'assassin'];

/**
 * 刺殺階段刺客知道的隊友：其他紅方全部，含奧伯倫，帶角色。站長 11/18：「規則上 刺殺階段只有刺客可以開牌 但只有邪惡方可以發言討論
 * 奧伯倫屬於邪惡方 所以其實等同四位邪惡方開牌討論」。只用在刺殺題（決策＝刺殺梅林）；提議題照夜裡的知識（nightInfo）。
 */
export function assassinationMates(game: SimGame, seat: number): string {
  const mates = game.seatRoles
    .map((role, i) => ({ role, seat: i + 1 }))
    .filter((m) => m.seat !== seat && isRed(m.role))
    .sort((a, b) => ASSASSINATION_MATE_ORDER.indexOf(a.role) - ASSASSINATION_MATE_ORDER.indexOf(b.role) || a.seat - b.seat);
  return mates.length ? `隊友 ${mates.map((m) => `${seatLabel(m.seat)}${ROLE_ZH[m.role]}`).join(VIEWER_SEAT_SEP)}` : '沒有隊友';
}

/**
 * 「你是」那一行，貼文與題目卡共用（站長 11/18：「文字顯示 "你是 {#}家 {身分}, {內建資訊}, {要做的決策}" 像是 "你是 5家 忠臣, 無其他資訊, 派 3 人"
 * "你是 0家 派西維爾, 看到 4家 & 9家, 派 4 人" "你是 3家 刺客, 隊友 5家莫甘娜 & 8家莫德雷得 & 7家奧伯倫, 刺殺梅林"」，同日再改「格式改成
 * "你是 {#}家 {身分} | {內建資訊} | {要做的決策}"」）：例「你是 0家 派西維爾 | 看到 4家 & 9家 | 派 4 人」。
 * 內建資訊：提議題是夜裡的知識（nightInfo）；刺殺題的紅方是刺殺階段四位紅方開牌討論後的隊友（assassinationMates）。
 */
export function viewerLine(game: SimGame, pick: Pick<ThreadsPick, 'seat' | 'proposal'>, sight: SimView['sight']): string {
  const role = game.seatRoles[pick.seat - 1];
  const info = pick.proposal === null && isRed(role) ? assassinationMates(game, pick.seat) : nightInfo(sight);
  return [`你是 ${seatLabel(pick.seat)} ${ROLE_ZH[role]}`, info, decisionPhrase(game, pick)].join(VIEWER_SEP);
}

/**
 * 結尾那一行：只留問題（站長 11/18 把座位、角色、派幾人移到開頭的「你是」那一行，原本的「輪到你 5家 忠臣 派 3 人，你會派誰？」就重複了）。
 * 刺殺題留「三藍」（局面，開頭那一行沒有）。
 */
function decisionWords(pick: ThreadsPick): string {
  return pick.proposal === null ? '三藍，誰是梅林？' : '你會派誰？';
}

/** 出題那一刻的比數：好人（任務成功）幾局、壞人（任務失敗）幾局。 */
export function scoreOf(pv: Pick<PickView, 'shown'>): { good: number; evil: number } {
  const quests = pv.shown.filter((e) => e.kind === 'quest');
  const evil = quests.filter((e) => e.kind === 'quest' && e.failed).length;
  return { good: quests.length - evil, evil };
}

/**
 * 貼文裡的局面（2026-11-25 起貼文只放這個精簡版，整份牌譜在圖的第 2 張）：比數、前面幾局只留任務結果和湖、
 * 當下這一局的派票全留。
 */
function compactLines(pv: PickView): string[] {
  const round = pv.pick.proposal === null ? 6 : pv.game.proposals[pv.pick.proposal].round;
  const score = scoreOf(pv);
  const lines: string[] = score.good + score.evil > 0 ? [`比數 好人 ${score.good}：${score.evil} 壞人`] : [];
  for (const e of pv.shown) {
    if (e.kind === 'proposal') {
      if (e.round < round) continue;
      if (!lines.includes(roundHeader(e.round))) lines.push(roundHeader(e.round));
      lines.push(eventLines([e], pv.pick.seat, pv.game, { startRound: e.round })[0]);
    } else if (e.kind === 'quest') {
      // 前面的局一局一行白話：哪一隊出任務、成功還是失敗、幾張失敗（不用認得 oox 的寫法）
      lines.push(`${roundHeader(e.round)} ${teamDigits(e.teamSeats)} 任務${e.failed ? '失敗' : '成功'}${e.failCount > 0 ? `（${e.failCount} 張失敗）` : ''}`);
    } else {
      // 湖接在那一局的任務後面；自己拿湖的那一次照樣寫你看到的（只有你知道）
      const said = e.claim === 'evil' ? '說壞人' : e.claim === 'good' ? '說好人' : '沒說結果';
      const own = e.holderSeat === pv.pick.seat ? pv.view.ownLakes.find((l) => l.targetSeat === e.targetSeat) : undefined;
      const lake = `湖：${seatLabel(e.holderSeat)}驗 ${seatLabel(e.targetSeat)}，${said}${own ? `（你看到的：${own.evil ? '壞人' : '好人'}）` : ''}`;
      const last = lines.length - 1;
      if (last >= 0 && lines[last].startsWith(`${roundHeader(e.round)} `)) lines[last] += `｜${lake}`;
      else lines.push(lake);
    }
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
  const head = [
    ...(opts.continuesFrom ? [continuesLine(opts.continuesFrom, pv.pick.seat)] : []),
    viewerLine(pv.game, pv.pick, pv.view.sight),
  ];
  const noPrior = !pv.shown.some((e) => e.kind === 'proposal');
  const bodies: string[][] = noPrior
    ? [[`${roundHeader(1)} 第一個隊長，前面沒有派票`]]
    : [compactLines(pv), [SEE_IMAGE_LINE]];
  // 站長 11/17：「文字部分則是主題 & 牌譜」；11/25「希望能更直觀讓看到的人一目瞭然」→ 貼文只留精簡的局面，
  // 整份牌譜（每一次提議和票）在圖的第 2 張（牌譜卡）。
  return { head, bodies, tail: [decisionWords(pv.pick)] };
}

/** 整份牌譜的文字版（[第 N 局] 起每一次提議、任務、湖）：貼文不再放，留給要對照的人和測試。 */
export function fullRecordLines(pv: PickView): string[] {
  return bracketRounds(eventLines(pv.shown, pv.pick.seat, pv.game));
}

/**
 * 新貼文 A 的內容（每個佔位符換成什麼，template.ts）：標題、今天的題目（接續、你是、派票紀錄、提問）、昨天的答案、主題標籤。
 * 派票紀錄和昨天答案是這次放進 A 的版本（renderPost 從長到短挑）。
 */
export function postParts(
  pv: PickView,
  opts: { weekday: number; continuesFrom?: { exerciseId: string; seat: number } },
  body: readonly string[],
  answer: readonly string[],
): PostParts {
  return {
    標題: postTitle(opts.weekday, pv.pick),
    主題: labelFor(opts.weekday, pv.pick),
    題號: pv.exerciseId,
    接續: opts.continuesFrom ? continuesLine(opts.continuesFrom, pv.pick.seat) : '',
    你是: viewerLine(pv.game, pv.pick, pv.view.sight),
    選項: choiceLines(choicesFor(pv)).join('\n'),
    派票紀錄: body.join('\n'),
    提問: decisionWords(pv.pick),
    昨天答案: answer.join('\n'),
    標籤: THREADS_TOPIC_TAG,
  };
}

export interface RenderedPost {
  text: string;
  /** 實際用的內容（主控台預覽、草稿 JSON 的 parts）。 */
  parts: PostParts;
  /** 用了第幾版的昨天答案（answers 的索引；沒有答案是 -1）。 */
  answerIndex: number;
  /** 站長的格式套進今天的內容放不下 500 字、改用內建格式時的說明。 */
  warning?: string;
}

/**
 * 新貼文 A（≤ 500 字）：用範本（預設＝內建格式 DEFAULT_POST_TEMPLATE）套今天的內容。
 * 放不下時先換短的答案（拿掉理由、再拿掉三個選項那一行），還是放不下才把今天的局面縮成「完整局面看圖」。
 * 站長的範本怎麼縮都放不下，這天改用內建格式。
 */
export function renderPost(
  pv: PickView,
  opts: { weekday: number; continuesFrom?: { exerciseId: string; seat: number }; answers?: string[][]; template?: string },
): RenderedPost {
  const q = questionParts(pv, opts);
  const answers = opts.answers && opts.answers.length > 0 ? opts.answers : [[]];
  const fit = (template: string): RenderedPost & { fits: boolean } => {
    let last: RenderedPost | null = null;
    // 2026-11-25 起先縮昨天的答案（理由、三個選項那一行；答案卡上都有），今天的局面留到最後才縮成「看圖」。
    for (const body of q.bodies) {
      for (let a = 0; a < answers.length; a++) {
        const parts = postParts(pv, opts, body, answers[a]);
        const text = renderTemplate(template, parts);
        last = { text, parts, answerIndex: answers[a].length ? a : -1 };
        if ([...text].length <= THREADS_MAX_CHARS) return { ...last, fits: true };
      }
    }
    return { ...(last as RenderedPost), fits: false };
  };
  // 站長沒改過的格式（跟現在或 11/25 以前的內建格式一字不差）＝用現在的內建格式。
  const same = opts.template === undefined ? DEFAULT_POST_TEMPLATE : normalizeTemplate(opts.template);
  const wanted = opts.template !== undefined && same !== DEFAULT_POST_TEMPLATE && same !== LEGACY_POST_TEMPLATE ? opts.template : null;
  // 範本檔讀進來時已經檢查過；這裡再擋一次（直接傳字串進來的呼叫端）。
  const invalid = wanted !== null ? validateTemplate('post', wanted) : [];
  const custom = wanted !== null && invalid.length === 0 ? fit(wanted) : null;
  if (custom?.fits) return { text: custom.text, parts: custom.parts, answerIndex: custom.answerIndex };
  const def = fit(DEFAULT_POST_TEMPLATE);
  const out: RenderedPost = { text: def.text, parts: def.parts, answerIndex: def.answerIndex };
  if (invalid.length) out.warning = `站長的貼文格式不合格（${invalid.join('；')}），這天用內建格式`;
  else if (custom) out.warning = `站長的貼文格式套進這天的內容最短也有 ${[...custom.text].length} 字，超過 ${THREADS_MAX_CHARS}，這天改用內建格式`;
  return out;
}

/** 新貼文 A 的文字（renderPost 的 text）。 */
export function postText(pv: PickView, opts: { weekday: number; continuesFrom?: { exerciseId: string; seat: number }; answers?: string[][]; template?: string }): string {
  return renderPost(pv, opts).text;
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
  // 題目給的三個選項裡真人選的那一個（字母）
  const letter = realLetter(choicesFor(pv));
  let line = `真人（${who}）派 ${letter ? `${letter} ` : ''}${teamDigits(p.teamSeats)}`;
  if (withTruth) line += `：${teamGoodBad(pv.game, p.teamSeats)}`;
  line += p.wentOnMission ? `，${missionWords(pv.game, p.round)}` : '，沒有出發';
  return line;
}

/**
 * 答案卡上的一句話理由（只用那一家當下看得到的資訊；百分比＝紅方可能組合中全好的比例，不是勝率），分號前後各一行：
 * 「只看當時的資訊：這隊在 9% 的可能裡全是好人；最高的隊（1345 等 20 隊）是 14%」。刺殺題沒有。
 */
export function reasonSentence(pv: PickView): string | null {
  const r = logicReason(pv);
  if (!r) return null;
  const share = (n: number): string => pct(n / r.worlds);
  const head = `只看當時的資訊：這隊在 ${share(r.teamClean)} 的可能裡全是好人`;
  if (r.teamClean >= r.best.clean) return `${head}；已經是最高的`;
  const best = teamDigits(r.best.teams[0]) + (r.best.teams.length > 1 ? ` 等 ${r.best.teams.length} 隊` : '');
  return `${head}；最高的隊（${best}）是 ${share(r.best.clean)}`;
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
  const head = `[昨天 ${y.exerciseId} 的答案]`;
  // 題目給的三個選項，各自的真相（完整公布的那天才講）
  const options = `三個選項：${choiceReveal(y).map((c) => c.text).join('｜')}`;
  if (y.pick.kind === 'assassin') {
    const merlin = y.game.seatRoles.indexOf('merlin') + 1;
    const target = y.game.assassinTargetSeat;
    const letterOf = (seat: number): string => {
      const c = choicesFor(y).items.find((x) => x.seats[0] === seat);
      return c ? `${c.letter} ` : '';
    };
    const line = `梅林是 ${letterOf(merlin)}${seatLabel(merlin)}${target ? `；真人刺 ${letterOf(target)}${seatLabel(target)}（${target === merlin ? '刺中' : '沒刺中'}）` : ''}`;
    const reveal = revealLines(y.game, input.recordId);
    return [[head, line, options, ...reveal], [head, line, ...reveal]];
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
  // 放不下時先拿掉理由，再拿掉三個選項那一行
  return [...(why ? [[...base, options, why, ...reveal]] : []), [...base, options, ...reveal], [...base, ...reveal]];
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
   * 輪播的圖，依序：image = 題目卡（大字的問題、圓桌、三個選項；只能發一張時發它）；gridImages = 牌譜的圖
   * （第 1 張是牌譜卡：網站牌譜頁的格子，只到出題那一刻；放不下時後面接續圖）；
   * answerImage = 公布完整答案的日子另附的答案卡（真人選了哪一個、三個選項的真相、昨天那一局的角色）。
   */
  post: { text: string; chars: number; image?: string; gridImages?: string[]; /** 舊的草稿（只有一張續圖）。 */ gridImage?: string; answerImage?: string };
  /** A 要引用昨天的貼文 B 發（有昨天的題目就是 true）。 */
  quoteYesterday: boolean;
  /** 今天延續昨天同一局（週四、週六）：A 裡的昨天答案不公布幾好幾壞和角色。 */
  continuesYesterday: boolean;
  /** A 裡的「昨天的答案」那一段（實際放進 A 的版本）；第一天沒有。 */
  answerToYesterday: { date: string; exerciseId: string; text: string } | null;
  firstComment: FirstCommentSlot;
  /** 貼文 A 每個佔位符這天換成什麼（template.ts；主控台的格式編輯器拿它預覽）。 */
  parts?: DraftParts;
  /** 站長的貼文格式這天放不下、改用內建格式時的說明。 */
  templateWarning?: string;
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
  /** 貼文 A 的範本（threads_template.json 的 post；不給＝內建格式）。 */
  template?: string;
}

export function buildDraft(input: DraftInput): ThreadsDraft {
  const weekday = weekdayOf(input.date);
  const continues = !!input.today.pick.continues && !!input.yesterday && input.yesterday.pv.pick.gameId === input.today.pick.gameId;
  const from = continues && input.yesterday ? { exerciseId: input.yesterday.pv.exerciseId, seat: input.yesterday.pv.pick.seat } : undefined;
  const answers = input.yesterday
    ? answerVariants({ yesterday: input.yesterday.pv, earlier: input.yesterday.earlier, todayContinues: continues, recordId: input.yesterday.recordId })
    : [];
  const r = renderPost(input.today, { weekday, ...(from ? { continuesFrom: from } : {}), answers, ...(input.template !== undefined ? { template: input.template } : {}) });
  const text = r.text;
  // 實際放進 A 的是哪一版答案（範本沒有 {昨天答案} 的話就沒有放進去）。
  const picked = r.answerIndex >= 0 ? answers[r.answerIndex] : null;
  const used = picked && text.includes(picked.join('\n')) ? picked : null;
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
    parts: { ...r.parts, type: { kind: input.today.pick.kind, name: typeOf(input.today.pick.kind).name } },
    ...(r.warning ? { templateWarning: r.warning } : {}),
  };
}

/** 給 Edward 複製貼上的 Markdown。 */
export function draftMarkdown(d: ThreadsDraft): string {
  const out = [`# Threads 草稿 ${d.date}（${d.theme}）`, '', `題號 ${d.exerciseId}${d.recordId ? `｜牌譜 ${recordUrl(d.recordId)}` : ''}`, ''];
  const how = d.answerToYesterday ? `用「引用」昨天（${d.answerToYesterday.date}）的貼文發這篇` : '第一天：直接發（沒有昨天的貼文可以引用）';
  out.push(`## ① 新貼文 A：今天的題目＋昨天的答案（${d.post.chars} 字）`, '', `${how}，附圖。`, '', '```', d.post.text, '```', '');
  if (d.post.image) {
    const grids = d.post.gridImages ?? (d.post.gridImage ? [d.post.gridImage] : []);
    const imgs = [
      `${d.post.image}（題目）`,
      ...grids.map((g, i) => `${g}（牌譜 ${i + 1}/${grids.length}）`),
      ...(d.post.answerImage ? [`${d.post.answerImage}（昨天的答案）`] : []),
    ];
    out.push(`圖（依序發成輪播）：${imgs.join('、')}`, '');
  }
  out.push('## ② A 的第一則留言（ChatGPT 填）', '');
  out.push(d.firstComment.text ? ['```', d.firstComment.text, '```'].join('\n') : '（還沒填）');
  out.push('', `建議文章：${d.firstComment.articles.map((a) => `${a.title} ${a.url}`).join('；') || '（無）'}`, `關鍵字：${d.firstComment.tags.join('、')}`, '');
  out.push('不用另外在昨天的貼文底下串答案：答案已經在 A 裡。', '');
  return out.join('\n');
}
