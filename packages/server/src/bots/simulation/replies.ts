/**
 * 模擬瓦（2026-10-14）— 回覆文字，純函式（不讀檔、不看時鐘、不連網）。
 *
 * 一則回覆最多 SIM_REPLY_MAX_CHARS（1800）字，跟戰績一樣；超過就從最不重要的段落開始省略。
 * 純文字繁體中文，用社群看得懂的牌譜寫法；第 10 家寫 `0`（`0家`）；沒有任何名字。
 * 只有 Discord 把派票那一段包在 code block 裡（LINE 不支援 markdown）。
 */

import type { Role } from '@avalon/shared';
import { ROLE_ZH, formatIntervalGroup, type IntervalGroup } from './commands';
import { SIM_HUMAN_SMALL_SAMPLE, SIM_REPLY_MAX_CHARS } from './config';
import { hasHits, type HumanAgg, type ProposalFeatures } from './human';
import { RED_COUNT, type SimBeliefModel } from './logic';
import {
  intervalGroupTrue,
  type ClaimReading,
  type IntervalEval,
  type LogicPanel,
  type ProposalEvent,
  type ReleasePanel,
  type SeatGroup,
} from './reading';
import { FAILS_REQUIRED, TEAM_SIZES, isRed, type PublicEvent, type Sight, type SimGame } from './scenario';
import { maskDigits, maskOf, seatChar, seatList, seatsOfMask, sortSeats, teamDigits } from './seats';

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

function bits(count: number): string {
  return count > 0 ? Math.log2(count).toFixed(1) : '0.0';
}

/** 角色的簡稱（回覆裡和座位放一起）。 */
export function roleShort(role: Role): string {
  return role === 'percival' ? '派西' : ROLE_ZH[role];
}

/**
 * 拼回覆：每一段是一行或幾行；`optional` 的段落在超過上限時從 `priority` 大的開始拿掉。
 * 最後仍超過就在行尾截斷（不會切到一半的行）。
 */
export interface ReplyPart {
  text: string;
  optional?: boolean;
  /** 數字越大越先拿掉。 */
  priority?: number;
}

export function assembleReply(parts: readonly ReplyPart[], max: number = SIM_REPLY_MAX_CHARS): string {
  const kept = parts.filter((p) => p.text !== '');
  const join = (ps: readonly ReplyPart[]): string => ps.map((p) => p.text).join('\n');
  let text = join(kept);
  if (text.length <= max) return text;
  const order = kept
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.optional)
    .sort((a, b) => (b.p.priority ?? 0) - (a.p.priority ?? 0) || b.i - a.i);
  const dropped = new Set<number>();
  for (const { i } of order) {
    dropped.add(i);
    text = join(kept.filter((_, k) => !dropped.has(k)));
    if (text.length <= max) return text;
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

// ─── 身分與事件 ────────────────────────────────────────────────────────────

/** 「你是 4家・忠臣（沒有額外資訊）」等。 */
export function identityLine(seat: number, role: Role, sight: Sight): string {
  const who = `你是 ${seatLabel(seat)}・${ROLE_ZH[role]}`;
  switch (sight.kind) {
    case 'loyal':
      return `${who}（沒有額外資訊）`;
    case 'percival':
      return `${who}。拇指：${seatList(sight.thumbs)}（一梅林一莫甘娜，不知道誰是誰）`;
    case 'merlin':
      return `${who}。拇指（看到的紅）：${seatList(sight.seen)}；莫德雷德看不到，還有 ${RED_COUNT - sight.seen.length} 紅`;
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

/** 一次派票的牌譜寫法：`1家 460 1+`。 */
export function proposalLine(p: ProposalEvent, opts: { showOutcome: boolean }): string {
  let line = `${seatLabel(p.leaderSeat)} ${teamDigits(p.teamSeats)}${anomalyTokens(p)}`;
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
 * 事件清單 → 行（每一局開頭一行「第 N 局：」）。`roundHeaders` 為 false 時不印局號
 * （開題只有第 1 局時用百科的樣子）。
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

export const NOTATION_NOTE = '（隊長依序；X+ 隊外贊成、X- 隊內反對，其他人照「隊內贊成、隊外反對」）';

function decisionPrompt(p: ProposalEvent): string {
  const size = TEAM_SIZES[p.round - 1];
  const forced = p.attempt === 5 ? '，這次強制出發' : '';
  return `輪到你派 ${size} 人（第 ${p.round} 局第 ${p.attempt} 次${forced}）。`;
}

function answerHint(p: ProposalEvent): string {
  const example = '12345'.slice(0, TEAM_SIZES[p.round - 1]);
  return `作答：/派 + 座位（例：/派 ${example}，0 = 10家）\u3000區間（選填）：/區間 789=2 460=1`;
}

export const ANSWER_FOOTER = '/下一步 跳過｜/公布 看角色｜/結束';

/** 一句「確定資訊」的任務事實。 */
export function missionFact(e: Extract<PublicEvent, { kind: 'quest' }>): string {
  const team = seatList(e.teamSeats);
  if (e.failCount === 0) return `第 ${e.round} 局 ${team} 全成功（不代表全好）`;
  if (!e.failed) return `第 ${e.round} 局 ${team} 出 ${e.failCount} 張失敗（要 ${FAILS_REQUIRED[e.round - 1]} 張才算失敗）→ 至少 ${e.failCount} 紅`;
  return `第 ${e.round} 局 ${team} 出 ${e.failCount} 失敗 → 至少 ${e.failCount} 紅`;
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
}

export function formatStart(input: StartInput): string {
  const { game, seat, sight, shown, decision, platform } = input;
  const role = game.seatRoles[seat - 1];
  const onlyR1 = shown.every((e) => e.kind === 'proposal' && e.round === 1);
  const parts: ReplyPart[] = [];
  if (input.replacedId) parts.push({ text: `（上一題 ${input.replacedId} 已結束，換這一題）` });
  parts.push({ text: `【模擬瓦 ${input.exerciseId}】${identityLine(seat, role, sight)}` });
  if (shown.length === 0) {
    parts.push({ text: '你是第 1 局第一個隊長，前面沒有派票：這題練「釋放」。' });
  } else if (onlyR1) {
    parts.push({ text: `第 1 局派票${NOTATION_NOTE}：` });
    parts.push({ text: codeBlock(shown.map((e) => proposalLine(e as ProposalEvent, { showOutcome: false })), platform) });
  } else {
    parts.push({ text: `目前為止${NOTATION_NOTE}：` });
    parts.push({ text: codeBlock(eventLines(shown, seat, game), platform) });
  }
  parts.push({ text: decisionPrompt(decision) });
  parts.push({ text: answerHint(decision) });
  parts.push({ text: ANSWER_FOOTER });
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
  human: { agg: HumanAgg; mine: ProposalFeatures; prev?: ProposalEvent };
  logic: LogicPanel;
  release: ReleasePanel;
  platform: SimPlatform;
}

function sameTeam(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && sortSeats(a).every((s, i) => s === sortSeats(b)[i]);
}

function realPlayerLine(input: ProposeInput): string {
  const { decision: d, team } = input;
  const shared = d.teamSeats.filter((s) => team.includes(s)).length;
  const compare = sameTeam(d.teamSeats, team) ? '跟你一樣' : `跟你重疊 ${shared} 人`;
  let outcome: string;
  if (d.forced) outcome = '強制出發';
  else outcome = d.approved ? '通過' : '否決';
  if (input.realQuest) outcome += `，任務 ${'o'.repeat(input.realQuest.successCount)}${'x'.repeat(input.realQuest.failCount)}`;
  return `① 實際這位 ${seatLabel(d.leaderSeat)}派：${teamDigits(d.teamSeats)}${anomalyTokens(d)}（${compare}）→ ${outcome}`;
}

function distLine(prefix: string, counts: readonly number[], n: number, unit: string, mine: number, mineUnit: string, labels?: string[]): string {
  const maxK = Math.max(mine, counts.reduce((m, c, k) => (c > 0 ? k : m), 0));
  const cells: string[] = [];
  for (let k = 0; k <= Math.min(maxK, counts.length - 1); k++) {
    cells.push(`${labels?.[k] ?? `${k} ${unit}`} ${pct(n > 0 ? counts[k] / n : 0)}`);
  }
  return `${prefix}${cells.join('｜')}（你 ${mineUnit}）`;
}

export function humanLines(input: ProposeInput): string[] {
  const { agg, mine, prev } = input.human;
  const d = input.decision;
  const role = input.game.seatRoles[d.leaderSeat - 1];
  const where = d.round <= 2 ? `第${d.round}局 ${seatLabel(d.leaderSeat)}${roleShort(role)}` : `第${d.round}局 ${roleShort(role)}`;
  if (agg.n <= 0) return [`② 同位置真人（${where}）：題庫裡沒有其他同樣處境的局`];
  const small = agg.n < SIM_HUMAN_SMALL_SAMPLE ? '，樣本少' : '';
  const lines = [`② 同位置真人（${where}，${agg.n} 次${small}）：含自己 ${pct(agg.self / agg.n)}（你${mine.self ? '✓' : '✗'}）`];
  if (hasHits(role) && agg.hitsN > 0 && mine.hits !== null) {
    const [label, unit] = role === 'merlin' ? ['派到看到的紅 ', '個'] : role === 'percival' ? ['派到拇指 ', '根'] : ['派到隊友 ', '個'];
    lines.push(distLine(`\u3000${label}`, agg.hits, agg.hitsN, unit, mine.hits, `${mine.hits} ${unit}`));
  }
  if (prev && agg.prevN > 0 && mine.prevOverlap !== null) {
    lines.push(distLine(`\u3000跟上一次 ${seatLabel(prev.leaderSeat)} ${teamDigits(prev.teamSeats)} 重疊 `, agg.prev, agg.prevN, '人', Math.min(mine.prevOverlap, 2), `${mine.prevOverlap} 人`, ['0 人', '1 人', '2 人以上']));
  }
  if (agg.missionN > 0 && mine.missionOverlap !== null) {
    lines.push(distLine('\u3000跟上一局任務隊重疊 ', agg.mission, agg.missionN, '人', Math.min(mine.missionOverlap, 2), `${mine.missionOverlap} 人`, ['0 人', '1 人', '2 人以上']));
  }
  if (agg.failedN > 0 && mine.failedMember !== null) {
    lines.push(`\u3000派到失敗任務的人 ${pct(agg.failed / agg.failedN)}（你${mine.failedMember ? '✓' : '✗'}）`);
  }
  return lines;
}

function campLine(sight: Sight, seat: number): string {
  switch (sight.kind) {
    case 'loyal': return `你是好人，${RED_COUNT} 紅在其他 9 人`;
    case 'percival': return `你是好人；拇指 ${seatList(sight.thumbs)} 剛好一紅（莫甘娜）`;
    case 'merlin': return `你看到 ${seatList(sight.seen)} 是紅，還有 ${RED_COUNT - sight.seen.length} 紅（莫德雷德）在其他人`;
    case 'evil': return `你和隊友 ${seatList(sight.mates)} 是紅，奧伯倫在其他人`;
    case 'oberon': return `你（${seatLabel(seat)}）是紅，另外 ${RED_COUNT - 1} 紅在其他 9 人`;
  }
}

function groupText(g: SeatGroup, sight: Sight): string {
  const seats = seatList(g.seats);
  const within = (list: readonly number[]): boolean => g.seats.every((s) => list.includes(s));
  if (g.marginal >= 1) {
    if (sight.kind === 'merlin' && within(sight.seen)) return `${seats} 紅（拇指）`;
    if (sight.kind === 'evil' && within(sight.mates)) return `${seats} 紅（隊友）`;
    return `${seats} 紅`;
  }
  if (g.marginal <= 0) return `${seats} 好`;
  const count = g.min === g.max ? `*${g.min}` : `*${g.min}-${g.max}`;
  if (sight.kind === 'percival' && sameTeam(g.seats, sight.thumbs) && g.min === 1 && g.max === 1) return `${seats} *1（一梅一娜）`;
  return `${seats} ${count}（各 ${pct(g.marginal)}）`;
}

function claimLabel(c: ClaimReading): string {
  return `${seatLabel(c.proposal.leaderSeat)} ${maskDigits(c.mask)}`;
}

/** ③ 邏輯面板的各行。 */
export function logicLines(panel: LogicPanel, sight: Sight, seat: number, shown: readonly PublicEvent[], ownLakes: { targetSeat: number; evil: boolean }[]): ReplyPart[] {
  const a = panel.analysis;
  const parts: ReplyPart[] = [];
  const behaviour = panel.model.weighsBehaviour ? '' : '，還沒算派票行為';
  parts.push({ text: `③ 邏輯（${panel.model.label}：只用確定資訊${behaviour}）` });
  parts.push({ text: `・${campLine(sight, seat)}：剩 ${a.count} 種紅方組合（${bits(a.count)} bits）` });
  const quests = shown.filter((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest');
  for (const q of quests) parts.push({ text: `・${missionFact(q)}`, optional: true, priority: 3 });
  for (const l of ownLakes) parts.push({ text: `・你湖 ${seatLabel(l.targetSeat)}：${l.evil ? '紅' : '好人'}（真相）` });
  if (panel.groups.length === 1) {
    const g = panel.groups[0];
    const note = quests.length === 0 ? '——任務前純邏輯沒有區間，區間全部來自派票解讀' : '';
    parts.push({ text: `・區間：其他 ${g.seats.length} 人各 ${pct(g.marginal)}（*${g.min === g.max ? g.min : `${g.min}-${g.max}`}）${note}` });
  } else {
    parts.push({ text: `・區間：${panel.groups.map((g) => groupText(g, sight)).join('｜')}` });
  }

  // 全好讀法
  const possible = panel.claims.filter((c) => c.weight > 0);
  if (possible.length > 0) {
    const allSame = possible.every((c) => c.weight === possible[0].weight);
    const body = allSame && possible.length > 1
      ? `${possible.map(claimLabel).join('、')} 各 ${possible[0].weight}/${a.total}`
      : possible.map((c) => `${claimLabel(c)} ${c.weight}/${a.total}`).join('｜');
    parts.push({ text: `・全好讀法（隊長＋隊員都好）：${body}` });
  }
  for (const c of panel.claims.filter((x) => x.weight === 0)) {
    let why: string;
    if (c.impossible === 'sight' && sight.kind === 'percival' && (c.sightSeats ?? []).length === 2) why = `含兩根拇指 ${seatList(c.sightSeats ?? [])}`;
    else if (c.impossible === 'sight') why = `含你知道的紅 ${seatList(c.sightSeats ?? [])}`;
    else why = '跟任務結果矛盾';
    parts.push({ text: `・${claimLabel(c)}：${why} → 這個讀法不成立` });
  }
  // 兩兩合讀：超過 6 人（一定不可能都對）、跟確定資訊矛盾、只剩幾種。後面幾局五人隊伍時
  // 「超過 6 人」很常見，多於一對就併成一行。
  const tooMany: string[] = [];
  const contradict: string[] = [];
  const pairItems: string[] = [];
  for (const p of panel.pairs) {
    const A = panel.claims[p.a].proposal;
    const B = panel.claims[p.b].proposal;
    const names = `${seatLabel(A.leaderSeat)}＋${seatLabel(B.leaderSeat)}`;
    if (p.tooMany) {
      tooMany.push(tooMany.length === 0 && panel.pairs.filter((x) => x.tooMany).length === 1
        ? `${names} 合起來 ${p.unionSize} 人＞6 好人 → 不可能都對（${seatChar(A.leaderSeat)}、${seatChar(B.leaderSeat)} 至少一個錯）`
        : names);
    } else if (p.weight === 0) {
      contradict.push(names);
    } else if (p.worlds) {
      pairItems.push(`${names} 只剩紅 ${p.worlds.map(maskDigits).join('、')}`);
    }
  }
  if (tooMany.length === 1) parts.push({ text: `・${tooMany[0]}`, optional: true, priority: 1 });
  else if (tooMany.length > 1) parts.push({ text: `・合起來超過 6 人、不可能都對：${tooMany.join('、')}`, optional: true, priority: 1 });
  if (contradict.length > 0) parts.push({ text: `・合起來跟確定資訊矛盾、不可能都對：${contradict.join('、')}`, optional: true, priority: 1 });
  if (pairItems.length > 0) parts.push({ text: `・${pairItems.slice(0, 4).join('；')}`, optional: true, priority: 1 });
  for (const l of panel.lakes) {
    const target = l.targetSeat === seat ? '你' : `${seatLabel(l.targetSeat)} `;
    const said = `${target}是${l.claimEvil ? '紅' : '好人'}`;
    parts.push({
      text: l.weight > 0
        ? `・湖讀法：若 ${seatLabel(l.holderSeat)} 是好人說實話，${said} → 剩 ${l.weight} 種`
        : `・湖讀法：${seatLabel(l.holderSeat)} 說${said}，跟確定資訊矛盾 → ${seatLabel(l.holderSeat)} 不是說實話的好人`,
      optional: true,
      priority: 2,
    });
  }
  return parts;
}

/** ④ 你的派票放出的資訊。 */
export function releaseLines(r: ReleasePanel, humanMerlinShare?: number): ReplyPart[] {
  const parts: ReplyPart[] = [];
  const claimSeats = seatsOfMask(r.claimMask);
  const rest = seatsOfMask(~r.claimMask & 0x3ff);
  const head = `④ ${teamDigits(r.team)} 放出的資訊（後面的人只看得到公開資訊）：${seatList(claimSeats)} 好`;
  parts.push({
    text: r.weight > 0 ? `${head} → ${seatList(rest)} 有 ${RED_COUNT} 紅（${r.weight} 種）` : `${head} → 跟任務結果矛盾，後面的人不會把你讀成全好`,
  });
  for (const v of r.vs) {
    const base = `・對 ${seatLabel(v.proposal.leaderSeat)} ${teamDigits(v.proposal.teamSeats)}：${v.label}${v.shared.length ? `（${seatList(v.shared)}）` : ''}`;
    let tail: string;
    if (v.weight === 0) tail = '，都對不可能';
    else if (v.worlds && v.worlds.length === 1) tail = `，都對只剩紅 ${maskDigits(v.worlds[0])}`;
    else tail = `，都對剩 ${v.weight} 種`;
    parts.push({ text: base + tail, optional: true, priority: 2 });
  }
  for (const rej of r.rejects.slice(0, 2)) {
    parts.push({
      text: `・不能和「${seatLabel(rej.a.leaderSeat)}＋${seatLabel(rej.b.leaderSeat)}」同時成立 → 你在說 ${seatChar(rej.a.leaderSeat)}、${seatChar(rej.b.leaderSeat)} 至少一個錯`,
      optional: true,
      priority: 3,
    });
  }
  const pc = r.privateCheck;
  if (pc.kind === 'merlin') {
    const share = humanMerlinShare !== undefined ? `（同位置真人梅林這樣派 ${pct(humanMerlinShare)}）` : '';
    parts.push({ text: pc.seenOnTeam.length ? `・你派了看到的紅 ${seatList(pc.seenOnTeam)}：故意的話就是在演${share}` : '・沒有派到你看到的紅' });
  } else if (pc.kind === 'percival') {
    if (pc.thumbsOnTeam.length === 2) parts.push({ text: '・兩根拇指都派：隊上一定有一紅（莫甘娜）' });
    else if (pc.thumbsOnTeam.length === 1) parts.push({ text: `・你派了拇指 ${seatList(pc.thumbsOnTeam)}：一半機率是莫甘娜` });
  } else if (pc.kind === 'evil') {
    if (pc.matesOnTeam.length) parts.push({ text: `・你派了隊友 ${seatList(pc.matesOnTeam)}：讀你全好的人會把 ${seatList(pc.matesOnTeam)} 當好人（包隊友）` });
    else parts.push({ text: '・沒有派隊友' });
  }
  if (r.contrast) {
    const c = r.contrast;
    const alt = c.worlds && c.worlds.length === 1 ? `都對只剩紅 ${maskDigits(c.worlds[0])}` : c.weight === 0 ? '都對不可能' : `都對剩 ${c.weight} 種`;
    parts.push({
      text: `・對照：派 ${teamDigits(c.alternative)} 會跟 ${seatLabel(c.proposal.leaderSeat)} ${teamDigits(c.proposal.teamSeats)} 打對邊，${alt}（派 ${teamDigits(r.team)} 還有 ${c.yourWeight} 種）`,
      optional: true,
      priority: 4,
    });
  }
  return parts;
}

export const PROPOSE_FOOTER = '/區間 寫下你的區間｜/下一步｜/公布｜/結束';

export function formatProposeFeedback(input: ProposeInput, extras: { sight: Sight; shown: PublicEvent[]; ownLakes: { targetSeat: number; evil: boolean }[]; humanMerlinShare?: number }): string {
  const role = input.game.seatRoles[input.seat - 1];
  const parts: ReplyPart[] = [];
  parts.push({ text: `【${input.exerciseId}・${seatLabel(input.seat)}${roleShort(role)}】你派 ${teamDigits(input.team)}` });
  parts.push({ text: realPlayerLine(input) });
  humanLines(input).forEach((t, i) => parts.push({ text: t, optional: i > 0, priority: 5 }));
  parts.push(...logicLines(input.logic, extras.sight, input.seat, extras.shown, extras.ownLakes));
  parts.push(...releaseLines(input.release, extras.humanMerlinShare));
  parts.push({ text: PROPOSE_FOOTER });
  return assembleReply(parts);
}

// ─── /區間 ────────────────────────────────────────────────────────────────

export function formatInterval(exerciseId: string, ev: IntervalEval, model: SimBeliefModel): string {
  const behaviour = model.weighsBehaviour ? '' : '，還沒算派票';
  const parts: ReplyPart[] = [{ text: `【${exerciseId} 區間】（${model.label}${behaviour}）` }];
  for (const g of ev.groups) {
    const name = formatIntervalGroup(g.group);
    const range = g.min === g.max ? `${g.min}` : `${g.min}-${g.max}`;
    let self = '';
    if (g.self === 'good') self = `你是好人 → ${seatList(g.seats)} 有 ${range} 紅，`;
    if (g.self === 'red') self = `你是紅 → ${seatList(g.seats)} 有 ${range} 紅，`;
    if (g.contradiction === 'self') parts.push({ text: `・${name}：跟你自己的身分矛盾` });
    else if (g.contradiction === 'sight') parts.push({ text: `・${name}：${self}與確定資訊矛盾（你看到的資訊）` });
    else if (g.contradiction === 'mission') parts.push({ text: `・${name}：${self}與確定資訊矛盾（任務結果）` });
    else parts.push({ text: `・${name}：${self}${frac(g.weight, ev.total)}` });
  }
  if (ev.groups.length >= 2) {
    const label = ev.groups.length === 2 ? '兩個都成立' : '全部成立';
    const list = ev.jointWorlds.length > 0 && ev.jointWorlds.length <= 3 ? `（紅 ${ev.jointWorlds.map(maskDigits).join('、')}）` : '';
    parts.push({ text: `・${label}：${frac(ev.jointWeight, ev.total)}${list}` });
  }
  parts.push({ text: '/公布 後會對答案｜/派 作答｜/下一步' });
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
}

export function formatNext(input: NextInput): string {
  const parts: ReplyPart[] = [{ text: `【${input.exerciseId} 下一步】${input.showNote ? REPLAY_NOTE : ''}` }];
  parts.push({ text: codeBlock(eventLines(input.events, input.seat, input.game), input.platform) });
  if (input.next) {
    parts.push({ text: decisionPrompt(input.next) });
    const quests = input.shownAll.filter((e): e is Extract<PublicEvent, { kind: 'quest' }> => e.kind === 'quest');
    if (quests.length > 0) parts.push({ text: `・${quests.map(missionFact).join('；')}`, optional: true, priority: 1 });
    parts.push({ text: answerHint(input.next) });
    parts.push({ text: ANSWER_FOOTER });
  } else {
    const fails = input.shownAll.filter((e) => e.kind === 'quest' && e.failed).length;
    parts.push({ text: fails >= 3 ? '三紅：任務失敗三次，對局結束。' : '三藍：任務成功三次，接著是刺殺（誰被刺、結果在 /公布）。' });
    parts.push({ text: '你在這局沒有下一次派票了。/公布 看角色和你的答案｜/結束' });
  }
  return assembleReply(parts);
}

// ─── /公布 ────────────────────────────────────────────────────────────────

export interface RevealInput {
  exerciseId: string;
  game: SimGame;
  seat: number;
  /** 決定（proposals 的索引）→ 你派的隊伍，照時間。 */
  answers: { decision: ProposalEvent; team: number[] }[];
  interval?: IntervalGroup[];
  /** 你的區間在最後一次 /區間 時留下的世界。 */
  intervalWorlds?: number[];
  /** 最後一個決定點前讀的派票。 */
  readable: ProposalEvent[];
}

const ROLE_ORDER: Role[] = ['merlin', 'percival', 'mordred', 'morgana', 'assassin', 'oberon'];

export function formatReveal(input: RevealInput): string {
  const g = input.game;
  const redMask = maskOf(g.seatRoles.map((r, i) => (isRed(r) ? i + 1 : 0)).filter(Boolean));
  const roleSeat = (r: Role): number => g.seatRoles.indexOf(r) + 1;
  const parts: ReplyPart[] = [{ text: `【${input.exerciseId} 公布】你是 ${seatLabel(input.seat)}・${ROLE_ZH[g.seatRoles[input.seat - 1]]}` }];
  const loyal = g.seatRoles.map((r, i) => (r === 'loyal' ? i + 1 : 0)).filter(Boolean);
  parts.push({ text: `角色：${ROLE_ORDER.map((r) => `${ROLE_ZH[r]}${seatChar(roleSeat(r))}`).join(' ')}；忠臣 ${seatList(loyal)}` });
  parts.push({ text: `紅：${seatList(seatsOfMask(redMask))}` });

  const viewerRed = isRed(g.seatRoles[input.seat - 1]);
  if (input.answers.length > 0) {
    const items = input.answers.map(({ decision, team }) => {
      const reds = team.filter((s) => isRed(g.seatRoles[s - 1]));
      const mark = viewerRed ? '' : reds.length === 0 ? '✓' : '✗';
      const label = input.answers.length > 1 ? `第 ${decision.round} 局 ` : '';
      return `${label}${teamDigits(team)}：${reds.length} 紅${reds.length ? `（${seatList(reds)}）` : ''}${mark}`;
    });
    parts.push({ text: `你的派票：${items.join('；')}` });
  } else {
    parts.push({ text: '你這題沒有作答。' });
  }
  if (input.interval && input.interval.length > 0) {
    const items = input.interval.map((grp) => {
      const reds = grp.seats.filter((s) => isRed(g.seatRoles[s - 1]));
      return `${formatIntervalGroup(grp)} ${intervalGroupTrue(grp, redMask) ? '✓' : '✗'}（${reds.length ? `紅 ${seatList(reds)}` : '0 紅'}）`;
    });
    parts.push({ text: `區間：${items.join('、')}` });
    if (input.intervalWorlds) {
      const kept = input.intervalWorlds.includes(redMask);
      parts.push({ text: kept ? `・真正的紅方在你的區間留下的 ${input.intervalWorlds.length} 種裡 ✓` : '・真正的紅方不在你的區間留下的組合裡 ✗' });
    }
  }
  if (input.readable.length > 0) {
    const items = input.readable.map((p) => {
      const role = g.seatRoles[p.leaderSeat - 1];
      const reds = p.teamSeats.filter((s) => isRed(g.seatRoles[s - 1]));
      const leaderRed = isRed(role);
      let note: string;
      if (reds.length === 0 && !leaderRed) note = '全好';
      else if (reds.length === 0) note = '隊上 0 紅（隊長自己是紅）';
      else note = `有 ${reds.length} 紅${leaderRed && p.teamSeats.includes(p.leaderSeat) ? '（含自己）' : ''}`;
      return `${seatLabel(p.leaderSeat)} ${roleShort(role)} ${teamDigits(p.teamSeats)} ${note}`;
    });
    parts.push({ text: `前面派票：${items.join('；')}`, optional: true, priority: 1 });
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

export const NO_SESSION_TEXT = '你目前沒有進行中的模擬，輸入 /模擬 開一題（30 分鐘沒動作會自動結束）';
export const BANK_NOT_READY_TEXT = '模擬瓦題庫還沒準備好，請稍後再試。';
export const RATE_LIMITED_TEXT = '模擬指令太頻繁了，10 分鐘後再試。';
export const START_USAGE = '用法：/模擬｜/模擬 角色 座位（例：/模擬 派西 2、/模擬 梅林、/模擬 7、/模擬 紅）｜/模擬 題 題號';
export const PROPOSE_USAGE = '用法：/派 + 座位，例如 /派 123（0 = 10家；4 6 9、4,6,9 也可以）';
export const INTERVAL_USAGE = '用法：/區間 789=2 460=1（也可以 7 8 9 *2、12=1-2、3=紅、5=好；各組不能重疊）';

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

