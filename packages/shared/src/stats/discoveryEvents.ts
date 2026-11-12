/**
 * 自動發現的事件單位（Edward 2026-11-11「自動發現能不能也找出這些新資料的差異、跟它們暗示的策略」）：把兩紅之後的派隊
 * （twoRed.ts）、關鍵外白／內黑（decisiveVotes.ts）與全部投票拆成列，交給 discovery.ts 的同一套掃描。
 *
 *   twoRed    兩紅之後藍方隊長的一次提議（twoRedProposals）：全好、全沒拇指但派到莫德雷德、派到拇指（第 3、5 局）、
 *             只含一拇指／最多一紅（第 4 局；含兩壞以上 = 100% − 最多一紅，同一個檢定不重複列）。每次提議 = 1 個分母。
 *   decisive  一局裡一個藍方座位在第 3～5 局某一局的關鍵票（同一局、同一座位、同一局數的關鍵票合成一列）：關鍵票正確率、
 *             四組（場內白／內黑／外白／場外黑）對率、八格（四組 × 對／錯）各佔非中性關鍵票的比例。
 *   blueVote  同上但每一張藍方票（全部投票）：正確率與四組對率。
 * 只用第 3～5 局（數據排行「關鍵外白／內黑」的兩個範圍：第 3～5 局、兩紅之後；第 1～2 局一律投黑就比平均準，不比）。
 *
 * 維度：做事的人的分組（強者 vs 新手，cohort.ts 的 PR 切點）、桌的分組（高端 vs 歡樂，S 切點）、角色、座位、第幾局、
 * 第幾次提議（兩紅派隊）、局勢（之前任務的順序，例：紅藍紅）、紅方是否已兩勝（投票）。切點跟著網站上調的值。
 * 角色、座位、第幾局、第幾次、局勢、紅方已兩勝都標成 structural：預設不列（角色是定義上的資訊差，其他是規則與局勢），
 * 也不給策略（discoveryStrategy.ts）。
 *
 * 一局有好幾列、同一位玩家出現在很多局，列彼此不獨立：每列帶 cluster（局、玩家），discovery.ts 用叢集穩健的變異數
 * （局與玩家兩個方向）做檢定，不會把差異說得太確定。每列也帶 stratum = 做事的人的角色，用來檢查差異是不是角色本身造成的
 * （例：梅林看得到拇指，所以梅林的隊比較常全好）。
 */
import { SEATS } from './constants';
import type { Game } from './dataset';
import type { Facts } from './strength';
import { TWO_RED_R4_SAFE, twoRedProposals } from './twoRed';
import { DECISIVE_COHORT_ORDER, DECISIVE_GROUPS, decisiveGroup, decisiveOutcome, scanDecisiveVotes, type DecisiveGroup } from './decisiveVotes';
import { DEFAULT_COHORT_CUTS, PLAYER_TIER_LABELS, TABLE_TIER_LABELS, playerTier, tableTier, type CohortCuts } from './cohort';

export const EVENT_UNITS = ['twoRed', 'decisive', 'blueVote'] as const;
export type EventUnit = (typeof EVENT_UNITS)[number];

/** 一列：維度的值、指標的 [分子, 分母]；事件單位另有叢集鍵與角色。 */
export interface DiscoveryRow {
  dims: Record<string, number | string | null>;
  metrics: Facts;
  /** 同一局（game）、同一位玩家（player；沒寫名字 = 那一局那個座位自己一個）的列彼此相關。 */
  cluster?: { game: number; player: string };
  /** 做事的人的角色（「是不是角色造成的」檢查）。 */
  stratum?: string;
}

/** 兩組直接比（不是「某一類 vs 其他」）：分組維度比兩端（強者 vs 新手、高端 vs 歡樂）。 */
export const PLAYER_TIER_PAIR: readonly [string, string] = [PLAYER_TIER_LABELS.strong, PLAYER_TIER_LABELS.novice];
export const TABLE_TIER_PAIR: readonly [string, string] = [TABLE_TIER_LABELS.high, TABLE_TIER_LABELS.casual];
export const TWO_RED_STATE_PAIR: readonly [string, string] = ['紅方已兩勝', '紅方還沒兩勝'];

/** 指標的意思（自動發現的策略範本用）：share = 某種做法佔多少；accuracy = 做對的比例。 */
export type EventMetricKind = 'share' | 'accuracy';

export interface EventDimensionDef {
  id: string;
  unit: EventUnit;
  label: string;
  help: string;
  pair?: readonly [string, string];
  structural?: boolean;
  /** 做事的人的分組（強者 vs 新手）：差異可以變成「照強者做」的策略。 */
  skill?: boolean;
  /** 角色：差異多半來自角色本身的資訊差，不給策略。 */
  role?: boolean;
}

export interface EventMetricDef {
  id: string;
  unit: EventUnit;
  label: string;
  help: string;
}

const dimsFor = (unit: EventUnit, actor: string): EventDimensionDef[] => [
  { id: 'playerTier', unit, label: `${actor}分組`, help: `${actor}那一局開打前的 PR：強者（PR ≥ 上切點）對新手（PR < 下切點），切點同分組九宮格`, pair: PLAYER_TIER_PAIR, skill: true },
  { id: 'tableTier', unit, label: '桌的分組', help: '那一局的 S：高端（S ≥ 上切點）對歡樂（S < 下切點），切點同分組九宮格', pair: TABLE_TIER_PAIR },
  // 角色的差異多半是定義上的資訊差（梅林看得到拇指），預設跟結構性維度一起收起來，可以打開
  { id: 'role', unit, label: `${actor}角色`, help: `${actor}的角色（梅林／派西維爾／忠臣）；角色本身的資訊差，預設不列`, role: true, structural: true },
  { id: 'seat', unit, label: `${actor}座位`, help: `${actor}坐幾號位`, structural: true },
  { id: 'round', unit, label: '第幾局', help: '第幾個任務', structural: true },
  { id: 'sequence', unit, label: '局勢（任務順序）', help: '這一局開始前各任務的結果，照順序（例：紅藍紅）', structural: true },
];

export const EVENT_DIMENSIONS: readonly EventDimensionDef[] = [
  ...dimsFor('twoRed', '隊長'),
  { id: 'slot', unit: 'twoRed', label: '第幾次提議', help: '這一局的第幾次提議（第 5 次 = 尾派，強制出發）', structural: true },
  ...dimsFor('decisive', '投票的人'),
  { id: 'twoRedState', unit: 'decisive', label: '紅方已兩勝', help: '投票當下紅方是不是剛好已經拿下兩個任務（紅方已兩勝 vs 還沒）', pair: TWO_RED_STATE_PAIR, structural: true },
  ...dimsFor('blueVote', '投票的人'),
  { id: 'twoRedState', unit: 'blueVote', label: '紅方已兩勝', help: '投票當下紅方是不是剛好已經拿下兩個任務（紅方已兩勝 vs 還沒）', pair: TWO_RED_STATE_PAIR, structural: true },
];

const GROUP_LABEL: Record<DecisiveGroup, string> = { onYes: '場內白', onNo: '內黑', offYes: '外白', offNo: '場外黑' };
const GROUP_HELP: Record<DecisiveGroup, string> = {
  onYes: '自己在隊上投贊成', onNo: '自己在隊上投反對', offYes: '不在隊上投贊成', offNo: '不在隊上投反對',
};

export const EVENT_METRICS: readonly EventMetricDef[] = [
  { id: 'allGood', unit: 'twoRed', label: '兩紅後派全好', help: '兩紅之後藍方隊長的提議裡，隊上沒有紅方的比例' },
  { id: 'mordred', unit: 'twoRed', label: '兩紅後派到莫德雷德（沒拇指）', help: '隊上沒有拇指、但莫德雷德在隊上的比例（第 4 局：唯一的紅方是莫德雷德）' },
  { id: 'thumb', unit: 'twoRed', label: '兩紅後派到拇指（第 3、5 局）', help: '第 3、5 局隊上至少一個拇指（梅林看得到的紅方：刺客、莫甘娜、奧伯倫）的比例' },
  { id: 'oneThumb', unit: 'twoRed', label: '兩紅後第 4 局只含一拇指', help: '第 4 局隊上剛好一個紅方、而且是拇指的比例' },
  // 含兩壞以上 = 100% − 最多一紅：同一個檢定，只列最多一紅（說明裡寫兩個數字的關係）
  { id: 'r4Safe', unit: 'twoRed', label: '兩紅後第 4 局最多一紅', help: '第 4 局隊上最多一個紅方（= 全好 + 只有莫德雷德 + 只含一拇指；兩張失敗才紅，出任務一定成功）的比例；含兩壞以上 = 100% − 這個' },
  { id: 'acc', unit: 'decisive', label: '決定性票正確率', help: '決定性的藍方票（翻過來結果就改變）裡，放行全好、擋下會失敗的比例（第 4 局單紅的中性票不算）' },
  ...DECISIVE_GROUPS.map((g): EventMetricDef => ({
    id: g, unit: 'decisive', label: `決定性${GROUP_LABEL[g]}對率`, help: `決定性票裡${GROUP_HELP[g]}的那些，做對的比例`,
  })),
  ...DECISIVE_GROUPS.flatMap((g) => (['right', 'wrong'] as const).map((o): EventMetricDef => ({
    id: `${g}${o === 'right' ? 'Right' : 'Wrong'}`, unit: 'decisive',
    label: `決定性${GROUP_LABEL[g]}${o === 'right' ? '對' : '錯'}（佔決定性票）`,
    help: `非中性的決定性票裡，${GROUP_HELP[g]}而且${o === 'right' ? '做對' : '做錯'}的比例（八格之一）`,
  }))),
  { id: 'acc', unit: 'blueVote', label: '全部投票正確率', help: '每一張藍方票（第 1～4 次提議）裡，放行全好、擋下會失敗的比例（中性不算）' },
  ...DECISIVE_GROUPS.map((g): EventMetricDef => ({
    id: g, unit: 'blueVote', label: `${GROUP_LABEL[g]}對率（全部投票）`, help: `全部藍方票裡${GROUP_HELP[g]}的那些，做對的比例`,
  })),
];

function facts(entries: Array<[string, number, number] | null>): Facts {
  const m: Facts = new Map();
  for (const e of entries) if (e && e[2] > 0) m.set(e[0], [e[1], e[2]]);
  return m;
}

const seatName = (s: string): string => `${s === '0' ? 10 : s} 號`;

/** 第 round 局開始前的任務順序（例：紅藍紅）；之前有任務沒結果 = null。 */
export function sequenceBefore(g: Pick<Game, 'rounds'>, round: number): string | null {
  let out = '';
  for (let i = 0; i < round - 1; i += 1) {
    const r = g.rounds[i];
    if (r !== '紅' && r !== '藍') return null;
    out += r;
  }
  return out || '（開局）';
}

const tierLabel = (pr: number | null, cuts: CohortCuts): string | null => {
  const t = playerTier(pr, cuts);
  return t === 'unrated' ? null : PLAYER_TIER_LABELS[t];
};
const tableLabel = (s: number | null, cuts: CohortCuts): string | null => {
  const t = tableTier(s, cuts);
  return t === 'unrated' ? null : TABLE_TIER_LABELS[t];
};

/** 12 格（DECISIVE_COHORT_ORDER：四組 × 對、錯、中性）→ 指標。 */
function gridFacts(counts: readonly number[], cells: boolean): Facts {
  const at = (group: DecisiveGroup, outcome: 'right' | 'wrong'): number =>
    counts[DECISIVE_COHORT_ORDER.findIndex((c) => c.group === group && c.outcome === outcome)] ?? 0;
  let right = 0;
  let wrong = 0;
  for (const g of DECISIVE_GROUPS) { right += at(g, 'right'); wrong += at(g, 'wrong'); }
  const n = right + wrong;
  const entries: Array<[string, number, number]> = [['acc', right, n]];
  for (const g of DECISIVE_GROUPS) entries.push([g, at(g, 'right'), at(g, 'right') + at(g, 'wrong')]);
  if (cells) {
    for (const g of DECISIVE_GROUPS) {
      entries.push([`${g}Right`, at(g, 'right'), n]);
      entries.push([`${g}Wrong`, at(g, 'wrong'), n]);
    }
  }
  return facts(entries);
}

const playerKey = (g: Game, seat: string): string => {
  const i = (SEATS as readonly string[]).indexOf(seat);
  const name = i >= 0 ? g.seatPlayers[i] : null;
  return name ?? `#${g.seq}|${seat}`;
};

/** 一局 → 三種事件單位的列。 */
export function eventUnits(g: Game, cuts: CohortCuts = DEFAULT_COHORT_CUTS): Record<EventUnit, DiscoveryRow[]> {
  const out: Record<EventUnit, DiscoveryRow[]> = { twoRed: [], decisive: [], blueVote: [] };

  for (const p of twoRedProposals([g]).proposals) {
    const r4 = p.round === 4;
    out.twoRed.push({
      dims: {
        playerTier: tierLabel(p.pr, cuts), tableTier: tableLabel(p.s, cuts), role: p.role, seat: seatName(p.seat),
        round: `第 ${p.round} 局`, slot: p.slot === 5 ? '尾派' : `第 ${p.slot} 次`, sequence: sequenceBefore(g, p.round),
      },
      metrics: facts([
        ['allGood', p.category === 'allGood' ? 1 : 0, 1],
        ['mordred', p.category === 'mordred' ? 1 : 0, 1],
        r4 ? null : ['thumb', p.category === 'thumb' ? 1 : 0, 1],
        r4 ? ['oneThumb', p.category === 'oneThumb' ? 1 : 0, 1] : null,
        r4 ? ['r4Safe', TWO_RED_R4_SAFE.includes(p.category) ? 1 : 0, 1] : null,
      ]),
      cluster: { game: g.seq, player: p.player ?? `#${g.seq}|${p.seat}` },
      stratum: p.role,
    });
  }

  const scan = scanDecisiveVotes([g], { allVotes: true, byRound: true });
  const dimsOf = (seat: string, role: string, round: number, pr: number | null, s: number | null, twoRed: boolean): DiscoveryRow['dims'] => ({
    playerTier: tierLabel(pr, cuts), tableTier: tableLabel(s, cuts), role, seat: seatName(seat),
    round: `第 ${round} 局`, sequence: sequenceBefore(g, round), twoRedState: twoRed ? TWO_RED_STATE_PAIR[0] : TWO_RED_STATE_PAIR[1],
  });
  // 關鍵票：同一座位、同一局合成一列
  const decisive = new Map<string, { seat: string; round: number; role: string; pr: number | null; s: number | null; twoRed: boolean; counts: number[] }>();
  for (const v of scan.votes) {
    if (v.scope !== 'r35') continue;
    const key = `${v.seat}|${v.round}`;
    let rec = decisive.get(key);
    if (!rec) {
      rec = { seat: v.seat, round: v.round, role: v.role, pr: v.pr, s: v.s, twoRed: v.twoRed, counts: new Array<number>(12).fill(0) };
      decisive.set(key, rec);
    }
    const group = decisiveGroup(v.on, v.approve);
    const outcome = decisiveOutcome(v.approve, v.quality);
    rec.counts[DECISIVE_COHORT_ORDER.findIndex((c) => c.group === group && c.outcome === outcome)] += 1;
  }
  for (const rec of decisive.values()) {
    const metrics = gridFacts(rec.counts, true);
    if (metrics.size === 0) continue;
    out.decisive.push({
      dims: dimsOf(rec.seat, rec.role, rec.round, rec.pr, rec.s, rec.twoRed),
      metrics,
      cluster: { game: g.seq, player: playerKey(g, rec.seat) },
      stratum: rec.role,
    });
  }
  for (const rec of scan.allVotes ?? []) {
    if (rec.scope !== 'r35' || rec.round === undefined || rec.seat === undefined) continue;
    const metrics = gridFacts(rec.counts, false);
    if (metrics.size === 0) continue;
    out.blueVote.push({
      dims: dimsOf(rec.seat, rec.role, rec.round, rec.pr, rec.s, rec.twoRed),
      metrics,
      cluster: { game: g.seq, player: playerKey(g, rec.seat) },
      stratum: rec.role,
    });
  }
  return out;
}
