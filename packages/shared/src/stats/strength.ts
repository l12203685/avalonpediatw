/**
 * 數據分析「陣容強度」（Edward 2026-10-31：「我要你做到網站內呀，加到數據分析裡面。理論上你應該可以再針對不同組成、
 * 不同強度去分析遊戲過程跟內容吧（包含策略、任務組合、黑白球、湖中女神等等的）」「當局的紅方／忠臣各自的最高／
 * 最低 ELO & PR，以及派西／梅林的 ELO & PR，也可以是分析維度或標籤」）。
 *
 * 輸入是篩選後的局（games_cache 解碼），全部在瀏覽器的統計 Worker 裡算（約 2,000 局，幾十毫秒）：
 *  - points：每局一點（日期、結果、S、桌上 Elo 最低／中位／平均／最高），給時間散點圖；
 *  - heatmap：季 × S 區間的三種結果；
 *  - tiers：S 分層的局數與結果；
 *  - comparison：依選的分組方式（S 分層、PR X 以上至少 Y 人、梅林／派西 PR、梅林對刺客、紅藍平均 PR 差、
 *    最弱紅方／忠臣）把局分組，每組算同一批過程指標（結果、派隊、投票、紅方出牌、湖中女神、失誤標籤），
 *    跟「全部」並排。
 * 指標的定義寫在每列的 help（網站滑鼠提示原文）。
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, OUTCOME_THREE_RED, RED_ROLES, SEATS } from './constants';
import { countStrongSeats, type Game } from './dataset';
import { gameSeats, redBlueGap, roleStrength, type RoleStrength } from './lineup';
import { MISTAKE_TAGS, deriveLeaderSeats, gameMistakes } from './mistakes';

// ── 分層 ───────────────────────────────────────────────

export const S_TIERS = [
  { id: 'high', label: '高強度', range: 'S ≥ 65', min: 65, max: Infinity },
  { id: 'strong', label: '偏強', range: '55 ≤ S < 65', min: 55, max: 65 },
  { id: 'normal', label: '一般', range: '38 ≤ S < 55', min: 38, max: 55 },
  { id: 'weak', label: '偏弱', range: 'S < 38', min: -Infinity, max: 38 },
] as const;

/** 熱度圖的 S 區間（由低到高）。 */
export const S_BINS = [
  { id: 'lt38', label: '< 38', min: -Infinity, max: 38 },
  { id: '38-45', label: '38–45', min: 38, max: 45 },
  { id: '45-55', label: '45–55', min: 45, max: 55 },
  { id: '55-65', label: '55–65', min: 55, max: 65 },
  { id: 'ge65', label: '≥ 65', min: 65, max: Infinity },
] as const;

export type StrengthGrouping =
  | { kind: 'tier' }
  | { kind: 'count'; pr: number; count: number }
  | { kind: 'merlin' }
  | { kind: 'percival' }
  | { kind: 'merlinVsAssassin' }
  | { kind: 'gap' }
  | { kind: 'weakRed'; pr: number }
  | { kind: 'weakLoyal'; pr: number }
  /** 任一維度（STRENGTH_DIMENSIONS）依兩個切點分三組：後 1/3（< lo）、中間、前 1/3（≥ hi）。自動發現的連結用。 */
  | { kind: 'tertile'; dim: string; lo?: number; hi?: number };

export interface StrengthGroupDef {
  id: string;
  label: string;
  help: string;
}

interface GameCtx {
  g: Game;
  strength: RoleStrength | null;
  dims?: Record<string, number | null>;
}

interface GroupingDef {
  groups: StrengthGroupDef[];
  /** 這局屬於哪一組（index）；算不出來 = -1。 */
  classify: (c: GameCtx) => number;
}

const PR_TIERS = (who: string): StrengthGroupDef[] => [
  { id: 'hi', label: `${who} PR ≥ 70`, help: `${who}的開打前 PR 至少 70` },
  { id: 'mid', label: `${who} PR 40–70`, help: `${who}的開打前 PR 在 40（含）到 70 之間` },
  { id: 'lo', label: `${who} PR < 40`, help: `${who}的開打前 PR 低於 40（暫定玩家最高算 50）` },
];

function prTier(v: number | null | undefined): number {
  if (typeof v !== 'number') return -1;
  return v >= 70 ? 0 : v >= 40 ? 1 : 2;
}

export function groupingDef(grouping: StrengthGrouping): GroupingDef {
  switch (grouping.kind) {
    case 'tier':
      return {
        groups: S_TIERS.map((t) => ({ id: t.id, label: t.label, help: `${t.range}（S = 桌上 10 人開打前 PR 的平均）` })),
        classify: ({ g }) => (g.lineup ? S_TIERS.findIndex((t) => g.lineup!.s >= t.min && g.lineup!.s < t.max) : -1),
      };
    case 'count':
      return {
        groups: [
          { id: 'yes', label: `PR ${grouping.pr}+ ≥ ${grouping.count} 人`, help: `開打前 PR 至少 ${grouping.pr} 的座位有 ${grouping.count} 個以上（暫定不算）` },
          { id: 'no', label: '其他', help: `開打前 PR 至少 ${grouping.pr} 的座位不到 ${grouping.count} 個` },
        ],
        classify: ({ g }) => (g.lineup ? (countStrongSeats(g.lineup, grouping.pr) >= grouping.count ? 0 : 1) : -1),
      };
    case 'merlin':
      return { groups: PR_TIERS('梅林'), classify: ({ strength }) => prTier(strength?.pr.merlin) };
    case 'percival':
      return { groups: PR_TIERS('派西'), classify: ({ strength }) => prTier(strength?.pr.percival) };
    case 'merlinVsAssassin':
      return {
        groups: [
          { id: 'merlin', label: '梅林強 ≥ 20', help: '梅林 PR − 刺客 PR ≥ 20' },
          { id: 'even', label: '相差 < 20', help: '梅林與刺客的 PR 相差不到 20' },
          { id: 'assassin', label: '刺客強 ≥ 20', help: '刺客 PR − 梅林 PR ≥ 20' },
        ],
        classify: ({ strength }) => {
          const m = strength?.pr.merlin;
          const a = strength?.pr.assassin;
          if (typeof m !== 'number' || typeof a !== 'number') return -1;
          return m - a >= 20 ? 0 : a - m >= 20 ? 2 : 1;
        },
      };
    case 'gap':
      return {
        groups: [
          { id: 'red', label: '紅方強 ≥ 10', help: '紅方 4 人平均 PR − 藍方 6 人平均 PR ≥ 10' },
          { id: 'even', label: '相差 < 10', help: '紅方與藍方的平均 PR 相差不到 10' },
          { id: 'blue', label: '藍方強 ≥ 10', help: '藍方 6 人平均 PR − 紅方 4 人平均 PR ≥ 10' },
        ],
        classify: ({ strength }) => {
          const gap = strength ? redBlueGap(strength) : null;
          if (gap === null) return -1;
          return gap >= 10 ? 0 : gap <= -10 ? 2 : 1;
        },
      };
    case 'weakRed':
    case 'weakLoyal': {
      const who = grouping.kind === 'weakRed' ? '紅方' : '忠臣';
      return {
        groups: [
          { id: 'lo', label: `最弱${who} < ${grouping.pr}`, help: `${who}裡 PR 最低的那位低於 ${grouping.pr}` },
          { id: 'hi', label: `最弱${who} ≥ ${grouping.pr}`, help: `${who}每一位的 PR 都至少 ${grouping.pr}` },
        ],
        classify: ({ strength }) => {
          const v = grouping.kind === 'weakRed' ? strength?.pr.red?.min : strength?.pr.loyal?.min;
          return typeof v !== 'number' ? -1 : v < grouping.pr ? 0 : 1;
        },
      };
    }
    case 'tertile': {
      const lo = grouping.lo ?? 0;
      const hi = grouping.hi ?? 0;
      const dim = STRENGTH_DIMENSIONS.find((d) => d.id === grouping.dim);
      const name = dim?.label ?? grouping.dim;
      const f = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
      return {
        groups: [
          { id: 'top', label: `${name} 前 1/3`, help: `${name} ≥ ${f(hi)}` },
          { id: 'mid', label: '中間 1/3', help: `${f(lo)} ≤ ${name} < ${f(hi)}` },
          { id: 'bottom', label: `${name} 後 1/3`, help: `${name} < ${f(lo)}` },
        ],
        classify: ({ dims }) => {
          const v = dims?.[grouping.dim];
          if (typeof v !== 'number') return -1;
          return v >= hi ? 0 : v < lo ? 2 : 1;
        },
      };
    }
    default: {
      const never: never = grouping;
      throw new Error(`unknown grouping ${(never as { kind: string }).kind}`);
    }
  }
}

// ── 強度維度（自動發現與「維度三分位」分組）────────────────

export interface DimensionCtx {
  g: Game;
  strength: RoleStrength | null;
  /** 每次提議的隊長座位（依輪替推算；推算不出來 = null）。 */
  leaders: string[] | null;
}

export interface StrengthDimensionDef {
  id: string;
  label: string;
  help: string;
  /** 群組：桌、紅方、藍方、角色、座位。 */
  group: string;
  value: (c: DimensionCtx) => number | null;
}

function seatPr(c: DimensionCtx, seat: string | undefined | null): number | null {
  if (!seat || !c.g.lineup) return null;
  const i = (SEATS as readonly string[]).indexOf(seat);
  return i >= 0 && c.g.seatPlayers[i] ? c.g.lineup.prs[i] : null;
}

function rolePr(role: string): (c: DimensionCtx) => number | null {
  return (c) => {
    const seats = SEATS.filter((s) => c.g.seatRoles.get(s) === role);
    return seats.length === 1 ? seatPr(c, seats[0]) : null;
  };
}

export const STRENGTH_DIMENSIONS: readonly StrengthDimensionDef[] = [
  { id: 's', group: '桌', label: '桌上 S', help: '桌上 10 人開打前 PR 的平均', value: (c) => c.g.lineup?.s ?? null },
  { id: 'redMean', group: '紅方', label: '紅方平均 PR', help: '紅方 4 人開打前 PR 的平均', value: (c) => c.strength?.pr.red?.mean ?? null },
  { id: 'redMin', group: '紅方', label: '紅方最低 PR', help: '紅方 4 人裡 PR 最低的那位', value: (c) => c.strength?.pr.red?.min ?? null },
  { id: 'redMax', group: '紅方', label: '紅方最高 PR', help: '紅方 4 人裡 PR 最高的那位', value: (c) => c.strength?.pr.red?.max ?? null },
  { id: 'loyalMean', group: '藍方', label: '忠臣平均 PR', help: '4 位忠臣開打前 PR 的平均', value: (c) => c.strength?.pr.loyal?.mean ?? null },
  { id: 'loyalMin', group: '藍方', label: '忠臣最低 PR', help: '4 位忠臣裡 PR 最低的那位', value: (c) => c.strength?.pr.loyal?.min ?? null },
  { id: 'loyalMax', group: '藍方', label: '忠臣最高 PR', help: '4 位忠臣裡 PR 最高的那位', value: (c) => c.strength?.pr.loyal?.max ?? null },
  { id: 'blueMean', group: '藍方', label: '藍方平均 PR', help: '藍方 6 人（忠臣、派西、梅林）開打前 PR 的平均', value: (c) => c.strength?.pr.blue?.mean ?? null },
  {
    id: 'gap', group: '桌', label: '紅藍平均 PR 差', help: '紅方平均 PR − 藍方平均 PR（正 = 紅方較強）',
    value: (c) => (c.strength ? redBlueGap(c.strength) : null),
  },
  { id: 'merlin', group: '角色', label: '梅林 PR', help: '梅林的開打前 PR', value: rolePr('梅林') },
  { id: 'percival', group: '角色', label: '派西 PR', help: '派西維爾的開打前 PR', value: rolePr('派西維爾') },
  { id: 'assassin', group: '角色', label: '刺客 PR', help: '刺客的開打前 PR', value: rolePr('刺客') },
  { id: 'morgana', group: '角色', label: '莫甘娜 PR', help: '莫甘娜的開打前 PR', value: rolePr('莫甘娜') },
  { id: 'mordred', group: '角色', label: '莫德雷德 PR', help: '莫德雷德的開打前 PR', value: rolePr('莫德雷德') },
  { id: 'oberon', group: '角色', label: '奧伯倫 PR', help: '奧伯倫的開打前 PR', value: rolePr('奧伯倫') },
  { id: 'firstLeader', group: '座位', label: '首家 PR', help: '第一次提議的隊長（依輪替推算）的開打前 PR', value: (c) => seatPr(c, c.leaders?.[0]) },
  { id: 'r1Tail', group: '座位', label: '第 1 輪尾家 PR', help: '第 1 輪第 5 次提議（強制局）的隊長的開打前 PR', value: (c) => seatPr(c, c.leaders?.[4]) },
  { id: 'seat1', group: '座位', label: '1 號位 PR', help: '坐 1 號位的玩家的開打前 PR', value: (c) => seatPr(c, '1') },
  { id: 'seat10', group: '座位', label: '10 號位 PR', help: '坐 10 號位（牌譜的 0）的玩家的開打前 PR', value: (c) => seatPr(c, '0') },
  {
    id: 'sentLeaders', group: '座位', label: '出任務隊長平均 PR', help: '每輪實際出任務那一隊的隊長（依輪替推算）PR 的平均',
    value: (c) => {
      if (!c.leaders) return null;
      const byRound = new Map<number, number>();
      c.g.votingProposals.forEach(([round], k) => byRound.set(round, k));
      const prs = [...byRound.entries()]
        .filter(([round]) => c.g.roundResults[round - 1])
        .map(([, k]) => seatPr(c, c.leaders?.[k]))
        .filter((v): v is number => v !== null);
      return prs.length ? prs.reduce((a, b) => a + b, 0) / prs.length : null;
    },
  },
];

// ── 過程指標 ───────────────────────────────────────────

export type MetricKind = 'rate' | 'avg';

export interface StrengthMetricDef {
  id: string;
  section: string;
  label: string;
  help: string;
  kind: MetricKind;
}

const ROLE_ROWS = ['梅林', '派西維爾', '忠臣', '刺客', '莫甘娜', '莫德雷德', '奧伯倫'] as const;
const ROLE_SHORT: Record<string, string> = { 派西維爾: '派西', 莫德雷德: '莫德' };

export const METRIC_SECTIONS = ['陣容', '結果', '派隊與任務', '投票', '紅方出牌', '湖中女神', '角色決策', '失誤標籤'] as const;

export const STRENGTH_METRICS: readonly StrengthMetricDef[] = [
  { id: 's', section: '陣容', label: '平均 S', help: '桌上 10 人開打前 PR 的平均', kind: 'avg' },
  { id: 'redPr', section: '陣容', label: '紅方平均 PR', help: '紅方 4 人開打前 PR 的平均（有人沒寫名字的局不算）', kind: 'avg' },
  { id: 'bluePr', section: '陣容', label: '藍方平均 PR', help: '藍方 6 人（忠臣、派西、梅林）開打前 PR 的平均', kind: 'avg' },
  { id: 'merlinPr', section: '陣容', label: '梅林 PR', help: '梅林的開打前 PR', kind: 'avg' },
  { id: 'percivalPr', section: '陣容', label: '派西 PR', help: '派西維爾的開打前 PR', kind: 'avg' },
  { id: 'assassinPr', section: '陣容', label: '刺客 PR', help: '刺客的開打前 PR', kind: 'avg' },
  { id: 'threeRed', section: '結果', label: '三紅率', help: '紅方拿下三次任務的局 ÷ 全部局', kind: 'rate' },
  { id: 'blueDead', section: '結果', label: '三藍被刀率', help: '藍方拿下三次任務、但梅林被刺中的局 ÷ 全部局', kind: 'rate' },
  { id: 'blueAlive', section: '結果', label: '三藍躲刺率', help: '藍方拿下三次任務、梅林沒被刺中的局 ÷ 全部局', kind: 'rate' },
  { id: 'hit', section: '結果', label: '刺中率', help: '三藍的局裡，刺客刺中梅林的比例', kind: 'rate' },
  { id: 'leaderOnR1', section: '派隊與任務', label: '第 1 輪隊長自己上車', help: '第 1 輪的提議裡，隊長把自己排進隊伍的比例（隊長依輪替推算，推算不出來的局不算）', kind: 'rate' },
  { id: 'threePlusOne', section: '派隊與任務', label: '首輪成功後三加一', help: '第 1 輪任務成功的局裡，第 2 輪出任務的 4 人隊包含第 1 輪那 3 人的比例（其餘是拆車）。成功的隊下一輪沿用是局勢使然的常態，不是失誤', kind: 'rate' },
  { id: 'proposalsPerRound', section: '派隊與任務', label: '每輪提議次數', help: '每個打過的任務輪平均提了幾次隊（含強制局）', kind: 'avg' },
  { id: 'forced', section: '派隊與任務', label: '走到強制局的輪', help: '任務輪裡走到第 5 次提議（尾家強制、不投票）的比例', kind: 'rate' },
  { id: 'r3SentRed', section: '派隊與任務', label: '第 3 輪起出任務的隊有紅', help: '第 3 輪起實際出任務的隊伍裡至少有一個紅方的比例', kind: 'rate' },
  { id: 'abnormal', section: '投票', label: '每局異常票', help: '外白（不在隊上卻贊成）＋內黑（在隊上卻反對）的張數；只算每次非強制提議的票數都對得上結果的局', kind: 'avg' },
  { id: 'outerWhiteRed', section: '投票', label: '紅方外白／局', help: '紅方不在隊上卻投贊成的張數（同上，只算票完整的局）', kind: 'avg' },
  { id: 'outerWhiteBlue', section: '投票', label: '藍方外白／局', help: '藍方不在隊上卻投贊成的張數', kind: 'avg' },
  { id: 'innerBlackRed', section: '投票', label: '紅方內黑／局', help: '紅方在隊上卻投反對的張數', kind: 'avg' },
  { id: 'innerBlackBlue', section: '投票', label: '藍方內黑／局', help: '藍方在隊上卻投反對的張數', kind: 'avg' },
  { id: 'onApproveBlue', section: '投票', label: '藍方在隊上贊成率', help: '非強制、票數對得上結果的提議裡，藍方在隊上時投贊成的比例', kind: 'rate' },
  { id: 'onApproveRed', section: '投票', label: '紅方在隊上贊成率', help: '同上，紅方', kind: 'rate' },
  { id: 'offApproveBlue', section: '投票', label: '藍方不在隊上贊成率', help: '藍方不在隊上時投贊成（外白）的比例', kind: 'rate' },
  { id: 'offApproveRed', section: '投票', label: '紅方不在隊上贊成率', help: '紅方不在隊上時投贊成（外白）的比例', kind: 'rate' },
  ...ROLE_ROWS.map((r) => ({
    id: `outerWhite:${r}`, section: '投票', label: `外白率：${ROLE_SHORT[r] ?? r}`,
    help: `${r}不在隊上時投贊成的比例`, kind: 'rate' as const,
  })),
  ...ROLE_ROWS.map((r) => ({
    id: `innerBlack:${r}`, section: '投票', label: `內黑率：${ROLE_SHORT[r] ?? r}`,
    help: `${r}在隊上時投反對的比例`, kind: 'rate' as const,
  })),
  { id: 'loneRedFail', section: '紅方出牌', label: '單紅上任務出失敗', help: '出任務的隊上只有 1 個紅方時，他出失敗的比例（第 4 輪要兩張失敗，不算）', kind: 'rate' },
  { id: 'multiRedOverfail', section: '紅方出牌', label: '兩紅以上同車多爆', help: '隊上有 2 個以上紅方時出了 2 張以上失敗（撞牌）的比例（第 4 輪不算）', kind: 'rate' },
  { id: 'multiRedHide', section: '紅方出牌', label: '兩紅以上同車全藏', help: '隊上有 2 個以上紅方時一張失敗都沒出的比例（第 4 輪不算）', kind: 'rate' },
  { id: 'r4Double', section: '紅方出牌', label: '第 4 輪兩紅以上雙失敗', help: '第 4 輪隊上有 2 個以上紅方時，出了 2 張以上失敗（第 4 輪要兩張才算紅）的比例', kind: 'rate' },
  { id: 'blueLakeRed', section: '湖中女神', label: '藍方持湖驗到紅', help: '藍方拿湖時，驗的人是紅方的比例', kind: 'rate' },
  { id: 'redLakeMate', section: '湖中女神', label: '紅方持湖驗隊友', help: '紅方拿湖時驗自己隊友的比例（奧伯倫和隊友互不相認，不算）', kind: 'rate' },
  { id: 'lakeFailed', section: '湖中女神', label: '驗失敗任務的隊員', help: '湖中驗的人，之前待過失敗的任務隊伍的比例', kind: 'rate' },
  { id: 'lakeMerlin', section: '湖中女神', label: '被驗的是梅林', help: '湖中驗到梅林的比例', kind: 'rate' },
  { id: 'blueTruth', section: '湖中女神', label: '藍方宣告與事實相符', help: '藍方持湖、有寫宣告時，宣告的陣營跟被驗者真實陣營相同的比例', kind: 'rate' },
  { id: 'redTruth', section: '湖中女神', label: '紅方宣告與事實相符', help: '紅方持湖、有寫宣告時，宣告跟真實陣營相同（說實話）的比例', kind: 'rate' },
  { id: 'merlinOffSeenApprove', section: '角色決策', label: '梅林隊外贊成看得到紅的隊', help: '梅林不在隊上、隊上有他看得到的紅方（莫德雷德看不到）時投贊成的比例（非強制、票數對得上的提議）', kind: 'rate' },
  { id: 'merlinOnSeenApprove', section: '角色決策', label: '梅林隊上贊成看得到紅的隊', help: '梅林在隊上、隊上有他看得到的紅方時仍投贊成的比例', kind: 'rate' },
  { id: 'merlinLeadSeen', section: '角色決策', label: '梅林當隊長派進看得到的紅', help: '梅林當隊長（依輪替推算）時，隊伍裡有他看得到的紅方的比例', kind: 'rate' },
  { id: 'percivalThumb', section: '角色決策', label: '派西前兩輪派拇指', help: '派西第 1、2 輪當隊長（非強制）時，隊上有梅林或莫甘娜（拇指）的比例', kind: 'rate' },
  { id: 'loyalLeadRed', section: '角色決策', label: '忠臣第 3 輪起派到紅', help: '忠臣第 3 輪起當隊長時，提出的隊伍有紅方的比例', kind: 'rate' },
  { id: 'redLeadStack', section: '角色決策', label: '紅方隊長派 2 個以上相認紅', help: '刺客／莫甘娜／莫德雷德當隊長時，隊上有 2 個以上互相認識的紅方（含自己；奧伯倫不算）的比例', kind: 'rate' },
  { id: 'killPercival', section: '角色決策', label: '刺客刺到派西', help: '三藍、有刺殺紀錄的局裡，刺客刺的是派西維爾的比例', kind: 'rate' },
  ...MISTAKE_TAGS.map((tag) => ({
    id: `mistake:${tag}`, section: '失誤標籤', label: tag,
    help: `有「${tag}」的局 ÷ 全部局（定義同牌譜紀錄的失誤標籤）`, kind: 'rate' as const,
  })),
];

/** 指標 id → [分子, 分母]。 */
export type Facts = Map<string, [number, number]>;

function add(f: Facts, id: string, num: number, den = 1): void {
  const v = f.get(id) ?? [0, 0];
  v[0] += num;
  v[1] += den;
  f.set(id, v);
}

const FAILS_NEEDED = [1, 1, 1, 2, 1];

/** 一局對每個指標的貢獻。 */
export function gameFacts(g: Game, strength: RoleStrength | null): Facts {
  const f: Facts = new Map();
  if (g.lineup) add(f, 's', g.lineup.s);
  if (strength) {
    if (strength.pr.red) add(f, 'redPr', strength.pr.red.mean);
    if (strength.pr.blue) add(f, 'bluePr', strength.pr.blue.mean);
    if (strength.pr.merlin !== null) add(f, 'merlinPr', strength.pr.merlin);
    if (strength.pr.percival !== null) add(f, 'percivalPr', strength.pr.percival);
    if (strength.pr.assassin !== null) add(f, 'assassinPr', strength.pr.assassin);
  }
  const decided = g.outcome === OUTCOME_THREE_RED || g.outcome === OUTCOME_BLUE_DEAD || g.outcome === OUTCOME_BLUE_ALIVE;
  if (decided) {
    add(f, 'threeRed', g.outcome === OUTCOME_THREE_RED ? 1 : 0);
    add(f, 'blueDead', g.outcome === OUTCOME_BLUE_DEAD ? 1 : 0);
    add(f, 'blueAlive', g.outcome === OUTCOME_BLUE_ALIVE ? 1 : 0);
    if (g.outcome !== OUTCOME_THREE_RED) add(f, 'hit', g.outcome === OUTCOME_BLUE_DEAD ? 1 : 0);
  }
  const rolesKnown = /^[0-9]{6}$/.test(g.config);
  const roleOf = (s: string): string => g.seatRoles.get(s) ?? '忠臣';
  const isRed = (s: string): boolean => RED_ROLES.has(roleOf(s));

  // 提議與任務
  const byRound = new Map<number, Array<{ k: number; attempt: number; team: string; approved: string }>>();
  g.votingProposals.forEach(([round, attempt, team, approved], k) => {
    byRound.set(round, [...(byRound.get(round) ?? []), { k, attempt, team, approved }]);
  });
  const leaders = deriveLeaderSeats(g.votingProposals.map((p) => p[2]));
  const sentTeam = (round: number): string | null => {
    const props = byRound.get(round);
    return props && g.roundResults[round - 1] ? props[props.length - 1].team : null;
  };
  let voteComplete = g.votingProposals.length > 0;
  const voteCounts = { abnormal: 0, owRed: 0, owBlue: 0, ibRed: 0, ibBlue: 0 };
  for (const [round, props] of byRound) {
    const cell = g.roundResults[round - 1] ?? '';
    if (!cell) continue;
    add(f, 'proposalsPerRound', props.length);
    add(f, 'forced', props.some((p) => p.attempt >= 5) ? 1 : 0);
    if (round === 1 && leaders) {
      for (const p of props) add(f, 'leaderOnR1', p.team.includes(leaders[p.k]) ? 1 : 0);
    }
    props.forEach((p, idx) => {
      if (p.attempt >= 5) return;
      const went = idx === props.length - 1;
      const yes = new Set(p.approved);
      if ((yes.size > 5) !== went) {
        voteComplete = false;
        return;
      }
      if (!rolesKnown) return;
      for (const s of SEATS) {
        const on = p.team.includes(s);
        const approve = yes.has(s);
        const red = isRed(s);
        const role = roleOf(s);
        if (on) {
          add(f, red ? 'onApproveRed' : 'onApproveBlue', approve ? 1 : 0);
          add(f, `innerBlack:${role}`, approve ? 0 : 1);
          if (!approve) {
            voteCounts.abnormal += 1;
            if (red) voteCounts.ibRed += 1; else voteCounts.ibBlue += 1;
          }
        } else {
          add(f, red ? 'offApproveRed' : 'offApproveBlue', approve ? 1 : 0);
          add(f, `outerWhite:${role}`, approve ? 1 : 0);
          if (approve) {
            voteCounts.abnormal += 1;
            if (red) voteCounts.owRed += 1; else voteCounts.owBlue += 1;
          }
        }
      }
    });
    if (rolesKnown && round >= 3) {
      const team = sentTeam(round);
      if (team) add(f, 'r3SentRed', [...team].some(isRed) ? 1 : 0);
    }
    if (rolesKnown) {
      const team = sentTeam(round);
      if (team && team.length === cell.length) {
        const reds = [...team].filter(isRed).length;
        const fails = [...cell].filter((c) => c === 'x').length;
        if (round !== 4 && reds === 1) add(f, 'loneRedFail', fails >= 1 ? 1 : 0);
        if (round !== 4 && reds >= 2) {
          add(f, 'multiRedOverfail', fails >= 2 ? 1 : 0);
          add(f, 'multiRedHide', fails === 0 ? 1 : 0);
        }
        if (round === 4 && reds >= 2) add(f, 'r4Double', fails >= 2 ? 1 : 0);
      }
    }
  }
  if (voteComplete && rolesKnown) {
    add(f, 'abnormal', voteCounts.abnormal);
    add(f, 'outerWhiteRed', voteCounts.owRed);
    add(f, 'outerWhiteBlue', voteCounts.owBlue);
    add(f, 'innerBlackRed', voteCounts.ibRed);
    add(f, 'innerBlackBlue', voteCounts.ibBlue);
  }
  const r1 = sentTeam(1);
  const r2 = sentTeam(2);
  if (r1 && r2 && FAILS_NEEDED[0] > [...(g.roundResults[0] ?? '')].filter((c) => c === 'x').length) {
    add(f, 'threePlusOne', [...r1].every((s) => r2.includes(s)) ? 1 : 0);
  }

  // 湖中女神
  if (rolesKnown) {
    g.lakes.forEach((lake, i) => {
      if (!lake || !/^[0-9]$/.test(lake.holder) || !/^[0-9]$/.test(lake.target)) return;
      const after = i + 2;
      const holderRed = isRed(lake.holder);
      const targetRed = isRed(lake.target);
      if (holderRed) {
        const oberon = roleOf(lake.holder) === '奧伯倫' || roleOf(lake.target) === '奧伯倫';
        add(f, 'redLakeMate', targetRed && !oberon ? 1 : 0);
      } else {
        add(f, 'blueLakeRed', targetRed ? 1 : 0);
      }
      add(f, 'lakeMerlin', roleOf(lake.target) === '梅林' ? 1 : 0);
      let onFailed = false;
      for (let r = 1; r <= after; r++) {
        const cell = g.roundResults[r - 1] ?? '';
        const team = sentTeam(r);
        if (team && cell && [...cell].filter((c) => c === 'x').length >= FAILS_NEEDED[r - 1] && team.includes(lake.target)) onFailed = true;
      }
      add(f, 'lakeFailed', onFailed ? 1 : 0);
      const claim = g.claims.find((c) => c.holder === lake.holder && c.target === lake.target)?.claim;
      if (claim === '紅' || claim === '藍') add(f, holderRed ? 'redTruth' : 'blueTruth', (claim === '紅') === targetRed ? 1 : 0);
    });
  }

  // 角色決策
  if (rolesKnown) {
    const seenByMerlin = (s: string): boolean => isRed(s) && roleOf(s) !== '莫德雷德';
    const merlin = SEATS.find((s) => roleOf(s) === '梅林');
    const mateOf = (a: string, b: string): boolean => isRed(a) && isRed(b) && roleOf(a) !== '奧伯倫' && roleOf(b) !== '奧伯倫';
    for (const [round, props] of byRound) {
      const cell = g.roundResults[round - 1] ?? '';
      props.forEach((p, idx) => {
        const forced = p.attempt >= 5;
        const seen = [...p.team].some(seenByMerlin);
        const went = Boolean(cell) && idx === props.length - 1;
        if (merlin && !forced && seen && (new Set(p.approved).size > 5) === went) {
          add(f, p.team.includes(merlin) ? 'merlinOnSeenApprove' : 'merlinOffSeenApprove', p.approved.includes(merlin) ? 1 : 0);
        }
        const leader = leaders?.[p.k];
        if (!leader) return;
        const role = roleOf(leader);
        if (role === '梅林') add(f, 'merlinLeadSeen', seen ? 1 : 0);
        if (role === '派西維爾' && round <= 2 && !forced) {
          add(f, 'percivalThumb', [...p.team].some((s) => s !== leader && (roleOf(s) === '梅林' || roleOf(s) === '莫甘娜')) ? 1 : 0);
        }
        if (role === '忠臣' && round >= 3) add(f, 'loyalLeadRed', [...p.team].some(isRed) ? 1 : 0);
        if (isRed(leader) && role !== '奧伯倫') {
          add(f, 'redLeadStack', [...p.team].filter((s) => s === leader || mateOf(leader, s)).length >= 2 ? 1 : 0);
        }
      });
    }
    if ((g.outcome === OUTCOME_BLUE_DEAD || g.outcome === OUTCOME_BLUE_ALIVE) && /^[0-9]$/.test(g.kill)) {
      add(f, 'killPercival', roleOf(g.kill) === '派西維爾' ? 1 : 0);
    }
  }

  // 失誤標籤
  if (rolesKnown && decided) {
    const tags = new Set(gameMistakes(g).map((m) => m[0]));
    for (const tag of MISTAKE_TAGS) add(f, `mistake:${tag}`, tags.has(tag) ? 1 : 0);
  }
  return f;
}

// ── 報告 ───────────────────────────────────────────────

/** 桌上 10 個座位的分布：最低、第 1 四分位、中位、平均、第 3 四分位、最高。 */
export interface SeatSpread {
  min: number;
  q1: number;
  median: number;
  mean: number;
  q3: number;
  max: number;
}

export interface StrengthPoint {
  id: string;
  date: string;
  outcome: string;
  s: number;
  /** 桌上 10 人開打前 PR 的分布（平均 = S）。 */
  pr: SeatSpread;
  /** 桌上 10 人賽前 Elo 的分布；沒有座位 Elo 的舊資料 = null。 */
  elo: SeatSpread | null;
}

export interface OutcomeTally {
  n: number;
  threeRed: number;
  blueDead: number;
  blueAlive: number;
}

export interface HeatCell extends OutcomeTally {
  /** 半年：2024 H1。 */
  period: string;
  bin: string;
}

/** 比率與 95% 信賴區間（Wilson），0–100。 */
export interface RateCi {
  rate: number;
  lo: number;
  hi: number;
}

/** 依 S 等量分箱的結果曲線的一箱。 */
export interface SCurveBin {
  lo: number;
  hi: number;
  /** 箱內 S 的平均（畫在橫軸上的位置）。 */
  mid: number;
  n: number;
  threeRed: RateCi;
  blueDead: RateCi;
  blueAlive: RateCi;
}

export interface StrengthMetricValue {
  value: number | null;
  n: number;
}

export interface StrengthComparison {
  groups: Array<StrengthGroupDef & { games: number }>;
  /** 分不進任何一組的局（沒評分、需要的角色沒寫名字…）。 */
  excluded: number;
  metrics: Array<StrengthMetricDef & { values: StrengthMetricValue[]; all: StrengthMetricValue }>;
}

export interface StrengthReport {
  games: number;
  scored: number;
  points: StrengthPoint[];
  periods: string[];
  heatmap: HeatCell[];
  /** 結果比率 vs S（約 8 個等量的箱）。 */
  sCurve: SCurveBin[];
  overall: OutcomeTally;
  tiers: Array<{ id: string; label: string; range: string } & OutcomeTally>;
  comparison: StrengthComparison;
}

function tally(games: readonly Game[]): OutcomeTally {
  const t: OutcomeTally = { n: 0, threeRed: 0, blueDead: 0, blueAlive: 0 };
  for (const g of games) {
    if (g.outcome === OUTCOME_THREE_RED) t.threeRed += 1;
    else if (g.outcome === OUTCOME_BLUE_DEAD) t.blueDead += 1;
    else if (g.outcome === OUTCOME_BLUE_ALIVE) t.blueAlive += 1;
    else continue;
    t.n += 1;
  }
  return t;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 依日期排好的值 → 每點前後各 half 點的中位數（頭尾不足時用有的）。 */
export function rollingMedian(values: readonly number[], half = 30): number[] {
  return values.map((_, i) => median(values.slice(Math.max(0, i - half), i + half + 1)));
}

/** YYYY-MM-DD → 2024 H2（半年）。 */
export function halfYearOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y} H${m <= 6 ? 1 : 2}`;
}

/** 排好序的值的分位數（線性內插，同試算表 PERCENTILE）。 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function seatSpread(values: readonly number[]): SeatSpread {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0], q1: quantileSorted(s, 0.25), median: quantileSorted(s, 0.5),
    mean: s.reduce((a, b) => a + b, 0) / s.length, q3: quantileSorted(s, 0.75), max: s[s.length - 1],
  };
}

/** Wilson 95% 信賴區間（0–100）。 */
export function wilson(k: number, n: number, z = 1.96): RateCi {
  if (n === 0) return { rate: NaN, lo: NaN, hi: NaN };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { rate: 100 * p, lo: 100 * Math.max(0, center - half), hi: 100 * Math.min(1, center + half) };
}

/**
 * 經驗貝氏收縮：k／n 往整體比率 p0 拉，先驗強度 m 局（局數少的格子幾乎等於整體，局數多的才看得出差別）。
 * 回傳 0–100。
 */
export function shrinkRate(k: number, n: number, p0: number, m = 20): number {
  return (100 * (k + m * p0)) / (n + m);
}

/** 依 S 把局分成約 bins 個等量的箱（同分的局放同一箱），每箱的三種結果比率與 95% 信賴區間。 */
export function outcomeByS(games: readonly Game[], bins = 8): SCurveBin[] {
  const list = games
    .filter((g) => g.lineup && (g.outcome === OUTCOME_THREE_RED || g.outcome === OUTCOME_BLUE_DEAD || g.outcome === OUTCOME_BLUE_ALIVE))
    .sort((a, b) => a.lineup!.s - b.lineup!.s);
  const out: SCurveBin[] = [];
  let start = 0;
  for (let b = 1; b <= bins && start < list.length; b++) {
    let end = Math.round((list.length * b) / bins);
    while (end < list.length && end > 0 && list[end].lineup!.s === list[end - 1].lineup!.s) end += 1;
    if (end <= start) continue;
    const chunk = list.slice(start, end);
    const t = tally(chunk);
    out.push({
      lo: chunk[0].lineup!.s,
      hi: chunk[chunk.length - 1].lineup!.s,
      mid: chunk.reduce((a, g) => a + g.lineup!.s, 0) / chunk.length,
      n: t.n,
      threeRed: wilson(t.threeRed, t.n),
      blueDead: wilson(t.blueDead, t.n),
      blueAlive: wilson(t.blueAlive, t.n),
    });
    start = end;
  }
  return out;
}

export interface RiverPoint extends SeatSpread {
  /** 這一點的日期（毫秒）與字串。 */
  t: number;
  date: string;
  /** 視窗裡的局數。 */
  n: number;
  /** 視窗裡 S 的中位數。 */
  s: number;
  /** 視窗裡三種結果的比例（0–100）。 */
  threeRed: number;
  blueDead: number;
  blueAlive: number;
}

/**
 * 河流圖的資料（Edward 2026-10-31「ELO 最低／最高／中位／平均可以同時呈現在圖上吧？變成有點像河流區間那樣」）：
 * 依日期排好的局，每點取前後各 half 局的視窗，桌上分布的每一項（最低、第 1 四分位、中位、平均、第 3 四分位、最高）
 * 取視窗內的中位數，另附視窗的 S 中位數與三種結果比例。最多 maxPoints 點（等距抽樣），圖不會太密。
 */
export function riverSeries(points: readonly StrengthPoint[], key: 'elo' | 'pr', half = 30, maxPoints = 240): RiverPoint[] {
  const usable = points.filter((p) => (key === 'elo' ? p.elo : p.pr));
  const step = Math.max(1, Math.ceil(usable.length / maxPoints));
  const out: RiverPoint[] = [];
  const pick = (w: readonly StrengthPoint[], f: keyof SeatSpread): number =>
    median(w.map((p) => (key === 'elo' ? p.elo! : p.pr)[f]));
  for (let i = 0; i < usable.length; i += step) {
    const w = usable.slice(Math.max(0, i - half), i + half + 1);
    const share = (o: string): number => (100 * w.filter((p) => p.outcome === o).length) / w.length;
    out.push({
      t: Date.parse(`${usable[i].date}T00:00:00Z`),
      date: usable[i].date,
      n: w.length,
      min: pick(w, 'min'), q1: pick(w, 'q1'), median: pick(w, 'median'), mean: pick(w, 'mean'), q3: pick(w, 'q3'), max: pick(w, 'max'),
      s: median(w.map((p) => p.s)),
      threeRed: share(OUTCOME_THREE_RED), blueDead: share(OUTCOME_BLUE_DEAD), blueAlive: share(OUTCOME_BLUE_ALIVE),
    });
  }
  return out;
}

/** 每局的角色強度與指標貢獻跟分組方式無關：同一份解碼的局換分組時不用重算（失誤偵測最花時間）。 */
export interface GameInfo {
  strength: RoleStrength | null;
  facts: Facts;
  dims: Record<string, number | null>;
}

const perGame = new WeakMap<Game, GameInfo>();

/** 一局的角色強度、各指標的 [分子, 分母] 與各強度維度的值（快取）。 */
export function gameInfo(g: Game): GameInfo {
  let hit = perGame.get(g);
  if (!hit) {
    const strength = g.lineup ? roleStrength(g.lineup, gameSeats(g)) : null;
    const leaders = deriveLeaderSeats(g.votingProposals.map((p) => p[2]));
    const ctx: DimensionCtx = { g, strength, leaders };
    const dims = Object.fromEntries(STRENGTH_DIMENSIONS.map((d) => [d.id, d.value(ctx)]));
    hit = { strength, facts: gameFacts(g, strength), dims };
    perGame.set(g, hit);
  }
  return hit;
}

export function computeStrengthReport(games: readonly Game[], grouping: StrengthGrouping = { kind: 'tier' }): StrengthReport {
  const scored = games.filter((g) => g.lineup);
  const decided = (g: Game): boolean => g.outcome === OUTCOME_THREE_RED || g.outcome === OUTCOME_BLUE_DEAD || g.outcome === OUTCOME_BLUE_ALIVE;
  const points: StrengthPoint[] = scored
    .filter((g) => g.timelineDate && decided(g))
    .map((g) => {
      const elos = g.lineup!.elos;
      return {
        id: g.id,
        date: g.timelineDate,
        outcome: g.outcome,
        s: g.lineup!.s,
        pr: seatSpread(g.lineup!.prs),
        elo: elos ? seatSpread(elos) : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const cells = new Map<string, Game[]>();
  const periods = new Set<string>();
  for (const g of scored) {
    if (!g.timelineDate || !decided(g)) continue;
    const period = halfYearOf(g.timelineDate);
    const bin = S_BINS.find((b) => g.lineup!.s >= b.min && g.lineup!.s < b.max)!;
    periods.add(period);
    const key = `${period}|${bin.id}`;
    cells.set(key, [...(cells.get(key) ?? []), g]);
  }
  const heatmap: HeatCell[] = [...cells.entries()].map(([key, list]) => {
    const [period, bin] = key.split('|');
    return { period, bin, ...tally(list) };
  });

  const tiers = S_TIERS.map((t) => ({
    id: t.id, label: t.label, range: t.range,
    ...tally(scored.filter((g) => g.lineup!.s >= t.min && g.lineup!.s < t.max)),
  }));

  // 分組比較（維度三分位沒給切點時，用這批局的 1/3、2/3 分位數）
  if (grouping.kind === 'tertile' && (grouping.lo === undefined || grouping.hi === undefined)) {
    const dim = grouping.dim;
    const vals = games.map((g) => gameInfo(g).dims[dim]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    grouping = { kind: 'tertile', dim, lo: quantileSorted(vals, 1 / 3), hi: quantileSorted(vals, 2 / 3) };
  }
  const def = groupingDef(grouping);
  const sums: Facts[] = def.groups.map(() => new Map());
  const all: Facts = new Map();
  const counts = def.groups.map(() => 0);
  let excluded = 0;
  for (const g of games) {
    const { strength, facts, dims } = gameInfo(g);
    const i = def.classify({ g, strength, dims });
    if (i < 0) {
      excluded += 1;
      continue;
    }
    counts[i] += 1;
    for (const [id, [num, den]] of facts) {
      add(sums[i], id, num, den);
      add(all, id, num, den);
    }
  }
  const value = (facts: Facts, m: StrengthMetricDef): StrengthMetricValue => {
    const v = facts.get(m.id);
    if (!v || v[1] === 0) return { value: null, n: 0 };
    return { value: m.kind === 'rate' ? (100 * v[0]) / v[1] : v[0] / v[1], n: v[1] };
  };
  return {
    games: games.length,
    scored: scored.length,
    points,
    periods: [...periods].sort(),
    heatmap,
    sCurve: outcomeByS(scored),
    overall: tally(scored),
    tiers,
    comparison: {
      groups: def.groups.map((gr, i) => ({ ...gr, games: counts[i] })),
      excluded,
      metrics: STRENGTH_METRICS.map((m) => ({ ...m, values: sums.map((s) => value(s, m)), all: value(all, m) })),
    },
  };
}
