/**
 * 模擬瓦（2026-10-14）— 派票的解讀與釋放：把世界模型算成各面板要的數字，純函式。
 *
 * 百科模擬題的幾個動作，這裡各有一個機械版本（v1 純邏輯）：
 *   - 區間（「7 8 9 *2」「2 5 *1｜1 5 9 *1+」）：照結構分組（看到的紅、隊友、拇指、自己湖的、
 *     失敗的任務隊、其他人），每組在目前的世界裡有幾紅 → logicPanel().groups；
 *   - 讀前面的派票（「3 的派票不是好人派票」）：全好讀法 = 隊長＋隊員都是好人，
 *     兩兩合起來還剩幾種（「12 *1-2，因為 12 派票不同邊」）→ claims / pairs；
 *     固定規則的行為標籤（騎牆、打對邊、回選、拆車…）→ readings；
 *   - 角色分支：派西「信 1 梅林／信 1 娜娜」→ thumbBranches；紅方「誰避開了我們（找梅林）」→ hunt；
 *   - 派完的最後檢查（「傳遞的資訊是什麼?」「派469較468好，因為468變成跟279打對邊」）
 *     → releasePanel()：用後面的人看得到的公開資訊算；
 *   - 你寫的區間 → evaluateInterval()。
 * 別人湖的宣告當「湖讀法」：若湖的人是好人說實話 → 剩幾種。
 *
 * Edward 2026-10-14 審查修正：派票的「延伸／部分／打對邊」一律用全好讀法（隊長＋隊員）比，
 * 跟面板其他地方一致——回選前面的隊長、或前面的隊伍有你，都算共同的人。
 */

import type { IntervalGroup } from './commands';
import { analyze, enumerateWorlds, logicModel, publicConstraints, viewerConstraints, type Analysis, type SimBeliefModel, type SimWorld, type WorldConstraints } from './logic';
import { isRed, type PublicEvent, type SimView } from './scenario';
import { ALL_SEATS, maskOf, seatBit, seatsOfMask } from './seats';
import { popcount } from '../../ai/worlds';

/** 好人總數（10 人 4 紅）。 */
export const GOOD_COUNT = 6;
export const RED_TOTAL = 4;
/** 兩兩合讀、你的派票對照時，剩下幾種以內就把紅方組合列出來。 */
export const LIST_WORLDS_MAX = 3;
/** 讀前面幾次派票（最近的 5 次）。 */
export const READ_PROPOSALS_MAX = 5;

export type ProposalEvent = Extract<PublicEvent, { kind: 'proposal' }>;
type QuestEvent = Extract<PublicEvent, { kind: 'quest' }>;

/** 全好讀法的集合：隊長＋隊員。 */
export function claimMaskOf(p: Pick<ProposalEvent, 'leaderSeat' | 'teamSeats'>): number {
  return maskOf(p.teamSeats) | seatBit(p.leaderSeat);
}

/** 決定當下要讀的派票：之前最近的 5 次（照時間）。 */
export function readableProposals(view: Pick<SimView, 'events'>): ProposalEvent[] {
  const props = view.events.filter((e): e is ProposalEvent => e.kind === 'proposal');
  return props.slice(-READ_PROPOSALS_MAX);
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** 「這些人都好」時其他人有 4 紅、沒有別的條件時的組合數（區間寫法省略種數用）。 */
export function freeCount(goodMask: number): number {
  return binom(10 - popcount(goodMask), RED_TOTAL);
}

// ─── 讀法不成立的原因 ──────────────────────────────────────────────────────

/**
 * 全好讀法因為你自己的資訊而不成立的原因（任務結果造成的另外講）：
 *   known-red   讀法裡有你知道的紅（自己是紅、看到的紅、隊友、湖到紅）；
 *   thumbs      派西：兩根拇指都在讀法裡（一定有一根是莫甘娜）；
 *   good-count  讀法＋你（＋你湖到的好人）超過 6 個好人；
 *   thumb-count 派西：再加上一根拇指（兩根裡的梅林）就超過 6 個好人；
 *   other       以上都不是（幾個條件合起來）。
 */
export type SightReason =
  | { kind: 'known-red'; seats: number[] }
  | { kind: 'thumbs'; seats: number[] }
  | { kind: 'good-count'; goods: number; extra: number[] }
  | { kind: 'thumb-count'; goods: number }
  | { kind: 'other' };

export function sightReasonFor(view: SimView, mask: number): SightReason {
  const c = viewerConstraints(view);
  const reds = seatsOfMask(mask & c.red);
  if (reds.length > 0) return { kind: 'known-red', seats: reds };
  const thumbs = view.sight.kind === 'percival' ? view.sight.thumbs : [];
  if (thumbs.length === 2 && thumbs.every((t) => (mask & seatBit(t)) !== 0)) return { kind: 'thumbs', seats: [...thumbs] };
  const goodMask = mask | c.good;
  const goods = popcount(goodMask);
  if (goods > GOOD_COUNT) return { kind: 'good-count', goods, extra: seatsOfMask(c.good & ~mask) };
  if (thumbs.length === 2 && thumbs.every((t) => (goodMask & seatBit(t)) === 0) && goods + 1 > GOOD_COUNT) {
    return { kind: 'thumb-count', goods };
  }
  return { kind: 'other' };
}

/** 讀法不成立的原因：你自己看到的資訊（拇指／隊友／自己是紅／湖）或任務結果。 */
export type Impossible = 'sight' | 'mission';

export interface ClaimReading {
  proposal: ProposalEvent;
  mask: number;
  weight: number;
  /** weight = 0 時的原因。 */
  impossible?: Impossible;
  /** 原因是視角時的細節。 */
  reason?: SightReason;
}

export interface PairReading {
  a: number;
  b: number;
  unionSize: number;
  weight: number;
  /** 合起來超過 6 人：不可能都是好人。 */
  tooMany: boolean;
  /** 剩 LIST_WORLDS_MAX 種以內時列出紅方組合。 */
  worlds?: number[];
}

export interface LakeReading {
  holderSeat: number;
  targetSeat: number;
  claimEvil: boolean;
  weight: number;
}

// ─── 區間（結構分組）────────────────────────────────────────────────────────

export type GroupKind = 'seen' | 'mates' | 'thumbs' | 'lake' | 'mission' | 'forced' | 'rest';

/** 一組座位和它在目前世界裡的紅數範圍。組可以重疊（失敗的任務隊和拇指）。 */
export interface SeatGroup {
  seats: number[];
  min: number;
  max: number;
  kind: GroupKind;
  /** mission：哪一局。 */
  round?: number;
  /** thumbs：各拇指是紅（莫甘娜）的機率，照 seats 的順序。 */
  odds?: number[];
}

function minMax(counts: readonly number[]): { min: number; max: number } {
  let min = -1;
  let max = -1;
  counts.forEach((w, k) => {
    if (w > 0) {
      if (min < 0) min = k;
      max = k;
    }
  });
  return { min: Math.max(0, min), max: Math.max(0, max) };
}

/**
 * 玩家會寫的區間：看到的紅／隊友／拇指／自己湖的人、每一個出過失敗牌的任務隊（不含你），
 * 邏輯上確定紅或確定好的人，最後是其他人。每組的紅數範圍照目前的世界算。
 */
export function structuralGroups(view: SimView, analysis: Analysis): SeatGroup[] {
  const out: SeatGroup[] = [];
  const covered = new Set<number>([view.seat]);
  const range = (seats: readonly number[]): { min: number; max: number } => minMax(analysis.countWeights(maskOf(seats)));
  const add = (g: SeatGroup): void => {
    out.push(g);
    for (const s of g.seats) covered.add(s);
  };
  const sight = view.sight;
  if (sight.kind === 'merlin' && sight.seen.length) add({ seats: [...sight.seen], ...range(sight.seen), kind: 'seen' });
  if (sight.kind === 'evil' && sight.mates.length) add({ seats: [...sight.mates], ...range(sight.mates), kind: 'mates' });
  if (sight.kind === 'percival' && sight.thumbs.length === 2) {
    add({ seats: [...sight.thumbs], ...range(sight.thumbs), kind: 'thumbs', odds: sight.thumbs.map((t) => analysis.marginal(t)) });
  }
  for (const l of view.ownLakes) {
    if (!covered.has(l.targetSeat)) add({ seats: [l.targetSeat], min: l.evil ? 1 : 0, max: l.evil ? 1 : 0, kind: 'lake' });
  }
  const seenTeams = new Set<number>();
  for (const e of view.events) {
    if (e.kind !== 'quest' || e.failCount === 0) continue;
    const seats = e.teamSeats.filter((s) => s !== view.seat);
    const m = maskOf(seats);
    if (seats.length === 0 || seenTeams.has(m)) continue;
    seenTeams.add(m);
    add({ seats, ...range(seats), kind: 'mission', round: e.round });
  }
  const free = ALL_SEATS.filter((s) => !covered.has(s));
  const forcedRed = free.filter((s) => analysis.total > 0 && analysis.redWeight(s) === analysis.total);
  const forcedGood = free.filter((s) => analysis.total > 0 && analysis.redWeight(s) === 0);
  if (forcedRed.length) add({ seats: forcedRed, min: forcedRed.length, max: forcedRed.length, kind: 'forced' });
  if (forcedGood.length) add({ seats: forcedGood, min: 0, max: 0, kind: 'forced' });
  const rest = ALL_SEATS.filter((s) => !covered.has(s));
  if (rest.length) add({ seats: rest, ...range(rest), kind: 'rest' });
  return out;
}

// ─── 派票的行為標籤（固定規則，不是機率）──────────────────────────────────────

export type MissionRelation =
  /** 上一局任務隊原封不動。 */
  | 'same'
  /** 任務隊＋自己（3+1、4+1）。 */
  | 'plus-self'
  /** 任務隊＋別人（外撒）。 */
  | 'spread'
  /** 留一部分、換掉一部分（拆車）。 */
  | 'split'
  /** 一個都不留。 */
  | 'swap';

export interface ProposalTags {
  proposal: ProposalEvent;
  /** 騎牆：兩次不能都對的派票，各挑了人（「3 能力各挑一個 12 派的人」）。 */
  straddle?: { a: ProposalEvent; b: ProposalEvent; fromA: number[]; fromB: number[] };
  /** 打對邊：跟前面這幾次的全好讀法完全沒有共同的人。 */
  opposite: ProposalEvent[];
  /** 回選：隊伍裡有前面這幾次的隊長。 */
  recall: ProposalEvent[];
  /** 第 2 局起：跟上一局任務隊的關係。 */
  mission?: { relation: MissionRelation; team: number[]; kept: number[] };
}

/** 兩個全好讀法在公開資訊下能不能都對（超過 6 人或跟任務結果矛盾 → 不能）。 */
function compatible(a: number, b: number, pub: Analysis): boolean {
  const u = a | b;
  return popcount(u) <= GOOD_COUNT && pub.claimWeight(u) > 0;
}

export function missionRelation(team: readonly number[], leader: number, missionTeam: readonly number[]): { relation: MissionRelation; kept: number[] } {
  const kept = missionTeam.filter((s) => team.includes(s));
  if (kept.length === missionTeam.length) {
    const extra = team.filter((s) => !missionTeam.includes(s));
    if (extra.length === 0) return { relation: 'same', kept };
    return { relation: extra.length === 1 && extra[0] === leader ? 'plus-self' : 'spread', kept };
  }
  return { relation: kept.length > 0 ? 'split' : 'swap', kept };
}

/**
 * 前面每一次派票（最近 5 次）跟它之前的派票的關係。只用公開資訊：後面的人看得到的就是這些。
 */
export function proposalTags(view: Pick<SimView, 'events'>, pub: Analysis): ProposalTags[] {
  const readable = readableProposals(view);
  const lastMission = new Map<number, QuestEvent>();
  let quest: QuestEvent | undefined;
  for (const e of view.events) {
    if (e.kind === 'quest') quest = e;
    else if (e.kind === 'proposal' && quest) lastMission.set(e.index, quest);
  }
  return readable.map((p, k) => {
    const claim = claimMaskOf(p);
    const picks = p.teamSeats.filter((s) => s !== p.leaderSeat);
    const earlier = readable.slice(0, k);
    const tags: ProposalTags = { proposal: p, opposite: [], recall: [] };
    for (let i = 0; i < earlier.length && !tags.straddle; i++) {
      for (let j = i + 1; j < earlier.length && !tags.straddle; j++) {
        const ci = claimMaskOf(earlier[i]);
        const cj = claimMaskOf(earlier[j]);
        if (compatible(ci, cj, pub)) continue;
        const fromA = picks.filter((s) => (ci & seatBit(s)) !== 0 && (cj & seatBit(s)) === 0);
        const fromB = picks.filter((s) => (cj & seatBit(s)) !== 0 && (ci & seatBit(s)) === 0);
        if (fromA.length > 0 && fromB.length > 0) tags.straddle = { a: earlier[i], b: earlier[j], fromA, fromB };
      }
    }
    for (const q of earlier) {
      if (q.leaderSeat === p.leaderSeat) continue;
      if ((claimMaskOf(q) & claim) === 0) tags.opposite.push(q);
      if (p.teamSeats.includes(q.leaderSeat)) tags.recall.push(q);
    }
    const m = lastMission.get(p.index);
    if (m) tags.mission = { ...missionRelation(p.teamSeats, p.leaderSeat, m.teamSeats), team: [...m.teamSeats] };
    return tags;
  });
}

// ─── 角色分支 ─────────────────────────────────────────────────────────────

/** 一堆世界的區間寫法：每個世界都紅的、每個世界都好的、其他人有幾紅。 */
export interface WorldSummary {
  count: number;
  reds: number[];
  rest: number[];
  min: number;
  max: number;
}

export function summarizeWorlds(worlds: readonly SimWorld[], exclude: ReadonlySet<number>): WorldSummary {
  const live = worlds.filter((w) => w.weight > 0);
  const seats = ALL_SEATS.filter((s) => !exclude.has(s));
  const reds = seats.filter((s) => live.length > 0 && live.every((w) => (w.redMask & seatBit(s)) !== 0));
  const goods = seats.filter((s) => live.every((w) => (w.redMask & seatBit(s)) === 0));
  const rest = seats.filter((s) => !reds.includes(s) && !goods.includes(s));
  const restMask = maskOf(rest);
  let min = Infinity;
  let max = -Infinity;
  for (const w of live) {
    const k = popcount(w.redMask & restMask);
    min = Math.min(min, k);
    max = Math.max(max, k);
  }
  return { count: live.length, reds, rest, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
}

/**
 * 派西的分支（百科「信1梅林／信1娜娜」）：假設 `merlin` 那根是梅林（另一根就是莫甘娜），
 * 梅林那根的派票讀全好、莫甘娜那根的派票看隊上幾紅。
 */
export interface ThumbBranch {
  merlin: number;
  morgana: number;
  weight: number;
  merlinRead?: { proposal: ProposalEvent; summary: WorldSummary };
  morganaRead?: { proposal: ProposalEvent; min: number; max: number };
}

function lastProposalBy(readable: readonly ProposalEvent[], seat: number): ProposalEvent | undefined {
  return [...readable].reverse().find((p) => p.leaderSeat === seat);
}

export function thumbBranches(view: SimView, analysis: Analysis): ThumbBranch[] {
  if (view.sight.kind !== 'percival' || view.sight.thumbs.length !== 2) return [];
  const readable = readableProposals(view);
  const [t1, t2] = view.sight.thumbs;
  const out: ThumbBranch[] = [];
  for (const [merlin, morgana] of [[t1, t2], [t2, t1]]) {
    const worlds = analysis.worlds.filter((w) => (w.redMask & seatBit(merlin)) === 0);
    const branch: ThumbBranch = { merlin, morgana, weight: worlds.reduce((s, w) => s + w.weight, 0) };
    const mp = lastProposalBy(readable, merlin);
    if (mp) {
      const claim = claimMaskOf(mp);
      const read = worlds.filter((w) => (w.redMask & claim) === 0);
      branch.merlinRead = { proposal: mp, summary: summarizeWorlds(read, new Set([view.seat, ...seatsOfMask(claim)])) };
    }
    const np = lastProposalBy(readable, morgana);
    if (np) {
      const team = np.teamSeats.filter((s) => s !== morgana);
      const counts = analyze(worlds).countWeights(maskOf(team));
      branch.morganaRead = { proposal: np, ...minMax(counts) };
    }
    if (branch.merlinRead || branch.morganaRead) out.push(branch);
  }
  return out;
}

/** 紅方找梅林：前面的派票有沒有碰到你們（梅林看得到的紅）。 */
export interface HuntReading {
  proposal: ProposalEvent;
  /** 隊伍裡梅林看得到的你方紅。 */
  hits: number[];
  /** 隊長是你方的人。 */
  ours: boolean;
}

export function huntReadings(view: SimView): HuntReading[] {
  if (view.sight.kind !== 'evil') return [];
  const ours = new Set([view.seat, ...view.sight.mates]);
  // 梅林看不到莫德雷德：你是莫德雷德時只看隊友（你看不出隊友誰是莫德雷德，就都算）。
  const visible = view.role === 'mordred' ? new Set(view.sight.mates) : ours;
  return readableProposals(view).map((p) => ({
    proposal: p,
    hits: p.teamSeats.filter((s) => visible.has(s)),
    ours: ours.has(p.leaderSeat),
  }));
}

// ─── ③ 邏輯面板 ───────────────────────────────────────────────────────────

export interface LogicPanel {
  model: SimBeliefModel;
  analysis: Analysis;
  groups: SeatGroup[];
  claims: ClaimReading[];
  pairs: PairReading[];
  lakes: LakeReading[];
  tags: ProposalTags[];
  thumbs: ThumbBranch[];
  hunt: HuntReading[];
}

/** 你自己知道一定是紅的座位（自己是紅、看到的紅、隊友、湖到紅）。 */
export function knownRedSeats(view: SimView): number[] {
  const c = viewerConstraints(view);
  return seatsOfMask(c.red);
}

/** 只用視角（沒有任務結果）時的世界：判斷「不成立」是視角造成還是任務造成。 */
function sightOnly(view: SimView): WorldConstraints {
  return { ...viewerConstraints(view), missions: [] };
}

function weightUnder(c: WorldConstraints, mask: number): number {
  return enumerateWorlds(c).filter((w) => (w.redMask & mask) === 0).reduce((s, w) => s + w.weight, 0);
}

export function logicPanel(view: SimView, model: SimBeliefModel): LogicPanel {
  const analysis = analyze(model.worlds(view));
  const pub = analyze(enumerateWorlds(publicConstraints(view)));
  const readable = readableProposals(view);
  const sightC = sightOnly(view);
  const claims: ClaimReading[] = readable.map((p) => {
    const mask = claimMaskOf(p);
    const weight = analysis.claimWeight(mask);
    if (weight > 0) return { proposal: p, mask, weight };
    if (weightUnder(sightC, mask) === 0) return { proposal: p, mask, weight, impossible: 'sight', reason: sightReasonFor(view, mask) };
    return { proposal: p, mask, weight, impossible: 'mission' };
  });

  const pairs: PairReading[] = [];
  for (let a = 0; a < claims.length; a++) {
    for (let b = a + 1; b < claims.length; b++) {
      if (claims[a].weight === 0 || claims[b].weight === 0) continue;
      const union = claims[a].mask | claims[b].mask;
      const worlds = analysis.claimWorlds(union);
      const weight = worlds.reduce((s, w) => s + w.weight, 0);
      pairs.push({
        a,
        b,
        unionSize: popcount(union),
        weight,
        tooMany: popcount(union) > GOOD_COUNT,
        ...(weight > 0 && worlds.length <= LIST_WORLDS_MAX ? { worlds: worlds.map((w) => w.redMask) } : {}),
      });
    }
  }

  const lakes: LakeReading[] = [];
  const viewerGood = !isRed(view.role);
  for (const e of view.events) {
    if (e.kind !== 'lake' || e.claim === null || e.holderSeat === view.seat) continue;
    const claimEvil = e.claim === 'evil';
    // 好人被說「好人」：說實話的好人本來就會這樣說，這句什麼都沒驗證到。
    if (e.targetSeat === view.seat && viewerGood && !claimEvil) continue;
    const holderGood = seatBit(e.holderSeat);
    const target = seatBit(e.targetSeat);
    const weight = analysis.worlds
      .filter((w) => (w.redMask & holderGood) === 0 && ((w.redMask & target) !== 0) === claimEvil)
      .reduce((s, w) => s + w.weight, 0);
    lakes.push({ holderSeat: e.holderSeat, targetSeat: e.targetSeat, claimEvil, weight });
  }

  return {
    model,
    analysis,
    groups: structuralGroups(view, analysis),
    claims,
    pairs,
    lakes,
    tags: proposalTags(view, pub),
    thumbs: thumbBranches(view, analysis),
    hunt: huntReadings(view),
  };
}

// ─── 你的派票放出的資訊 ─────────────────────────────────────────────────────

export type OverlapLabel = '延伸' | '部分' | '打對邊';

export function overlapLabel(shared: number): OverlapLabel {
  return shared >= 2 ? '延伸' : shared === 1 ? '部分' : '打對邊';
}

export interface ReleaseVs {
  proposal: ProposalEvent;
  /** 兩個全好讀法（隊長＋隊員）共同的人，可能含你、含對方隊長。 */
  shared: number[];
  label: OverlapLabel;
  /** 你的隊伍有對方的隊長（回選）。 */
  recall: boolean;
  /** 兩個讀法合起來（都好的人）。 */
  union: number;
  weight: number;
  worlds?: number[];
}

export interface ReleaseContrast {
  alternative: number[];
  proposal: ProposalEvent;
  /** 換人之後的讀法跟那次派票合起來（都好的人）。 */
  union: number;
  weight: number;
  worlds?: number[];
  /** 你的隊伍跟同一次派票合讀的權重（對照用）。 */
  yourWeight: number;
  /** 你的隊伍跟同一次派票合起來（都好的人）。 */
  yourUnion: number;
}

export type PrivateCheck =
  | { kind: 'merlin'; seenOnTeam: number[] }
  /** odds：各拇指（照 thumbsOnTeam）依目前邏輯是莫甘娜的機率。 */
  | { kind: 'percival'; thumbsOnTeam: number[]; odds: number[] }
  | { kind: 'evil'; matesOnTeam: number[]; selfOnTeam: boolean }
  | { kind: 'oberon'; selfOnTeam: boolean }
  | { kind: 'none' };

/** 派西：你的派票對拇指派票的立場（延伸 → 讀成你信他是梅林；打對邊 → 信他是娜）。 */
export interface ThumbStance {
  thumb: number;
  proposal: ProposalEvent;
  label: OverlapLabel;
}

export interface ReleasePanel {
  team: number[];
  /** 讀你全好的集合：隊員＋你。 */
  claimMask: number;
  /** 後面的人（只有公開資訊）的世界數與你全好時剩幾種。 */
  publicTotal: number;
  weight: number;
  vs: ReleaseVs[];
  /** 各自跟你相容、兩個本身也相容，但跟你合起來不可能的兩次派票。 */
  rejects: { a: ProposalEvent; b: ProposalEvent }[];
  /** 兩組以上 rejects 都有的那個隊長（「共同點」：你其實在說他的讀法錯）。 */
  rejectCommon?: number;
  privateCheck: PrivateCheck;
  thumbStances: ThumbStance[];
  contrast?: ReleaseContrast;
}

function listIfFew(worlds: { redMask: number }[]): number[] | undefined {
  return worlds.length > 0 && worlds.length <= LIST_WORLDS_MAX ? worlds.map((w) => w.redMask) : undefined;
}

/**
 * `team` 是你派的隊伍。用公開資訊（後面的人看得到的：任務結果）算「讀你全好」會留下什麼，
 * 跟前面每一次派票合起來還剩幾種，以及換一個人會不會變成打對邊（對照）。
 * `analysis` 是你自己的世界（派西的拇指機率用）；沒給就用純邏輯重算。
 */
export function releasePanel(view: SimView, team: readonly number[], analysis: Analysis = analyze(logicModel.worlds(view))): ReleasePanel {
  const pub = analyze(enumerateWorlds(publicConstraints(view)));
  const claimMask = maskOf(team) | seatBit(view.seat);
  const readable = readableProposals(view);

  const vs: ReleaseVs[] = readable.map((p) => {
    const pClaim = claimMaskOf(p);
    const shared = seatsOfMask(pClaim & claimMask);
    const union = claimMask | pClaim;
    const worlds = pub.claimWorlds(union);
    return {
      proposal: p,
      shared,
      label: overlapLabel(shared.length),
      recall: p.leaderSeat !== view.seat && team.includes(p.leaderSeat),
      union,
      weight: worlds.length,
      worlds: listIfFew(worlds),
    };
  });

  // 「你在說 i、j 至少一個錯」：i、j 各自跟你相容、兩個本身也相容，三個合起來卻不可能。
  // （i、j 本身就互斥的話，誰派都一樣，不算你的派票放出的資訊。）
  const rejects: ReleasePanel['rejects'] = [];
  for (let a = 0; a < readable.length; a++) {
    for (let b = a + 1; b < readable.length; b++) {
      if (vs[a].weight === 0 || vs[b].weight === 0) continue;
      const pair = claimMaskOf(readable[a]) | claimMaskOf(readable[b]);
      if (pub.claimWeight(pair) === 0) continue;
      if (pub.claimWeight(claimMask | pair) === 0) rejects.push({ a: readable[a], b: readable[b] });
    }
  }
  let rejectCommon: number | undefined;
  if (rejects.length >= 2) {
    const common = ALL_SEATS.filter((s) => s !== view.seat && rejects.every((r) => r.a.leaderSeat === s || r.b.leaderSeat === s));
    if (common.length === 1) rejectCommon = common[0];
  }

  const thumbStances: ThumbStance[] = [];
  if (view.sight.kind === 'percival') {
    for (const t of view.sight.thumbs) {
      const p = lastProposalBy(readable, t);
      const v = p ? vs.find((x) => x.proposal === p) : undefined;
      if (p && v) thumbStances.push({ thumb: t, proposal: p, label: v.label });
    }
  }

  return {
    team: [...team],
    claimMask,
    publicTotal: pub.total,
    weight: pub.claimWeight(claimMask),
    vs,
    rejects,
    ...(rejectCommon !== undefined ? { rejectCommon } : {}),
    privateCheck: privateCheckFor(view, team, analysis),
    thumbStances,
    contrast: contrastFor(view, team, readable, pub),
  };
}

function privateCheckFor(view: SimView, team: readonly number[], analysis: Analysis): PrivateCheck {
  const on = (seats: readonly number[]): number[] => seats.filter((s) => team.includes(s));
  switch (view.sight.kind) {
    case 'merlin': return { kind: 'merlin', seenOnTeam: on(view.sight.seen) };
    case 'percival': {
      const thumbsOnTeam = on(view.sight.thumbs);
      return { kind: 'percival', thumbsOnTeam, odds: thumbsOnTeam.map((t) => analysis.marginal(t)) };
    }
    case 'evil': return { kind: 'evil', matesOnTeam: on(view.sight.mates), selfOnTeam: team.includes(view.seat) };
    case 'oberon': return { kind: 'oberon', selfOnTeam: team.includes(view.seat) };
    default: return { kind: 'none' };
  }
}

/**
 * 「派469較468好，因為468變成跟279打對邊」的機械版：你的全好讀法跟前面某次派票的全好讀法
 * 只共用 1 人（部分，那個人不是你）時，把那 1 人換掉（可能是對方的隊長）就變成打對邊，
 * 看合起來剩幾種。換誰：前面的讀法裡最少出現的人，同樣少就挑順時針離你最遠的（還沒派過票的人）。
 */
function contrastFor(view: SimView, team: readonly number[], readable: readonly ProposalEvent[], pub: Analysis): ReleaseContrast | undefined {
  const teamSet = new Set(team);
  const yourClaim = maskOf(team) | seatBit(view.seat);
  const appearances = new Array<number>(11).fill(0);
  for (const p of readable) for (const s of seatsOfMask(claimMaskOf(p))) appearances[s]++;
  for (const p of readable) {
    const pClaim = claimMaskOf(p);
    const shared = seatsOfMask(pClaim & yourClaim);
    if (shared.length !== 1 || shared[0] === view.seat || !teamSet.has(shared[0])) continue;
    const candidates = ALL_SEATS.filter((y) => !teamSet.has(y) && (pClaim & seatBit(y)) === 0 && y !== view.seat);
    if (candidates.length === 0) continue;
    candidates.sort((x, y) => appearances[x] - appearances[y] || ((y - view.seat + 10) % 10) - ((x - view.seat + 10) % 10));
    const alternative = team.map((s) => (s === shared[0] ? candidates[0] : s)).sort((a, b) => a - b);
    const altClaim = maskOf(alternative) | seatBit(view.seat);
    if ((altClaim & pClaim) !== 0) continue;
    const worlds = pub.claimWorlds(altClaim | pClaim);
    const yourUnion = yourClaim | pClaim;
    const yourWeight = pub.claimWeight(yourUnion);
    if (worlds.length >= yourWeight) continue;
    return { alternative, proposal: p, union: altClaim | pClaim, weight: worlds.length, worlds: listIfFew(worlds), yourWeight, yourUnion };
  }
  return undefined;
}

// ─── 你的區間 ─────────────────────────────────────────────────────────────

export interface IntervalGroupEval {
  group: IntervalGroup;
  /** 拿掉你自己之後的座位與紅數（好人：紅數不變；紅方：減 1）。 */
  seats: number[];
  min: number;
  max: number;
  self?: 'good' | 'red';
  weight: number;
  contradiction?: 'sight' | 'mission' | 'self';
}

export interface IntervalEval {
  total: number;
  groups: IntervalGroupEval[];
  /** 全部組都成立的世界。 */
  jointWorlds: number[];
  jointWeight: number;
}

function groupHolds(mask: number, seats: readonly number[], min: number, max: number): boolean {
  const k = popcount(mask & maskOf(seats));
  return k >= min && k <= max;
}

/** 各組可以重疊（百科：「1 2 *1-2」「2 3 7 *2」）；全部一起 = 每一組都成立。 */
export function evaluateInterval(view: SimView, groups: readonly IntervalGroup[], model: SimBeliefModel): IntervalEval {
  const analysis = analyze(model.worlds(view));
  const sightWorlds = enumerateWorlds(sightOnly(view));
  const viewerRed = isRed(view.role);
  const evals: IntervalGroupEval[] = groups.map((g) => {
    let seats = [...g.seats];
    let min = g.min;
    let max = g.max;
    let self: IntervalGroupEval['self'];
    if (seats.includes(view.seat)) {
      seats = seats.filter((s) => s !== view.seat);
      if (viewerRed) { min -= 1; max -= 1; self = 'red'; } else self = 'good';
    }
    if (max < 0 || min > seats.length) return { group: g, seats, min, max, self, weight: 0, contradiction: 'self' };
    min = Math.max(0, min);
    max = Math.min(max, seats.length);
    const weight = analysis.worlds.filter((w) => groupHolds(w.redMask, seats, min, max)).reduce((s, w) => s + w.weight, 0);
    if (weight > 0) return { group: g, seats, min, max, self, weight };
    const bySight = sightWorlds.some((w) => groupHolds(w.redMask, seats, min, max));
    return { group: g, seats, min, max, self, weight, contradiction: bySight ? 'mission' : 'sight' };
  });
  const joint = analysis.worlds.filter((w) => evals.every((e) => e.contradiction === undefined && groupHolds(w.redMask, e.seats, e.min, e.max)));
  return {
    total: analysis.total,
    groups: evals,
    jointWorlds: joint.map((w) => w.redMask),
    jointWeight: joint.reduce((s, w) => s + w.weight, 0),
  };
}

/** 公布時：這一組對不對（用原本寫的座位和紅數，對真正的紅方）。 */
export function intervalGroupTrue(group: IntervalGroup, redMask: number): boolean {
  return groupHolds(redMask, group.seats, group.min, group.max);
}

/** 「派票完的最後檢查」：照你寫的區間（留下的世界），你的隊伍全好的有幾種。 */
export function teamCleanUnder(worlds: readonly number[], team: readonly number[]): number {
  const m = maskOf(team);
  return worlds.filter((w) => (w & m) === 0).length;
}
