/**
 * 自動發現（Edward 2026-10-31：「陣容強度那邊有沒有辦法根據你切分出來的結果，直接找出有意義的區別」「不只是 ELO，
 * 我覺得所有數據分析頁面，不管從派隊／投票／任務／湖女／位置，對上不同維度，都應該要有辦法做到」）。
 *
 * 做法：把篩選後的局拆成五種分析單位，每種單位有自己的「維度」（分組依據）與「指標」（要比較的數字）：
 *   game      一局：陣容強度（STRENGTH_DIMENSIONS）、分類、年份、梅林座位、刺客在梅林後第幾位、首隊幾紅
 *             × 結果、派隊、投票、紅方出牌、湖中女神、角色決策、失誤標籤（STRENGTH_METRICS，陣容那類除外）
 *   proposal  一次提議：第幾輪、第幾次、隊長陣營／角色／座位、比分、隊上有沒有拇指、隊長 PR、桌上 S
 *             × 有沒有通過、隊上有紅、隊長上車、隊外紅／藍贊成率、隊上紅／藍反對率、異常票
 *   mission   一次任務：第幾輪、比分、第幾次提議才出發、隊長陣營、桌上 S × 任務失敗、多爆、單紅出失敗
 *   lake      一次湖中女神：第幾輪後、持湖陣營／角色、比分、持湖 PR、桌上 S × 驗到紅、宣告真實、宣告紅、驗到梅林
 *   seat      一局的一個座位：座位、角色、陣營、是不是首家／第 1 輪尾家、這位的 PR、桌上 S × 最後贏、任務階段贏
 * 每個維度 × 指標比較兩組：數值維度是前 1/3 對後 1/3，類別維度是某一類對其他。比率用兩比例 z 檢定、平均用 Welch
 * 檢定（樣本都 ≥ 30，用常態近似），全部檢定一起做 Benjamini–Hochberg 控制錯誤發現率，q ≤ 0.05 才列，依效果量
 * （比率 Cohen's h、平均 Cohen's d）排序。陣容維度另外算跟桌上 S 的相關，並在 S 三分層內再比一次（控制 S 後的差）。
 * 定義上就會相關的組合（例：隊長是紅方 × 隊上有紅）列在 EXCLUDED_PAIRS 不比。是相關，不是因果。
 *
 * 新資料（Edward 2026-11-11，discoveryEvents.ts）：再加三種事件單位 twoRed（兩紅之後藍方隊長的提議）、decisive（關鍵票）、
 * blueVote（全部藍方票），只看第 3～5 局。維度有做事的人的分組（強者 vs 新手）、桌的分組（高端 vs 歡樂；切點 = options.cuts，
 * 網站上跟著分組九宮格）、角色、座位、第幾局、第幾次、局勢、紅方已兩勝。一局有好幾列、同一位玩家在很多局，所以這三種用
 * 叢集穩健的兩比例檢定（局、玩家兩個方向，ClusterAcc），每組另外要至少 minGames 局、minPlayers 位有名字的玩家；跟其他檢定
 * 放在同一次 Benjamini–Hochberg（檢定數變多，q 值自動跟著變嚴）。每項另算依角色分層的差（withinRole），並用
 * discoveryStrategy.ts 的範本寫「可能的策略」（假設；差距小、角色造成的不給）。
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, OUTCOME_THREE_RED, RED_ROLES, SEATS, isFinalWin } from './constants';
import type { Game } from './dataset';
import { deriveLeaderSeats } from './mistakes';
import { DEFAULT_COHORT_CUTS, encodeCohortCuts, type CohortCuts } from './cohort';
import {
  EVENT_DIMENSIONS, EVENT_METRICS, EVENT_UNITS, eventUnits, type DiscoveryRow, type EventUnit,
} from './discoveryEvents';
import { buildStrategy, type DiscoveryStrategy } from './discoveryStrategy';
import {
  STRENGTH_DIMENSIONS, STRENGTH_METRICS, gameInfo, quantileSorted, type Facts, type StrengthGrouping,
} from './strength';

export type DiscoveryUnit = 'game' | 'proposal' | 'mission' | 'lake' | 'seat' | EventUnit;
export type DiscoveryPage = 'overview' | 'teams' | 'votes' | 'missions' | 'lake' | 'assassination' | 'position' | 'roles' | 'strength';

export const UNIT_LABELS: Record<DiscoveryUnit, string> = {
  game: '局', proposal: '提議', mission: '任務', lake: '湖中女神', seat: '座位',
  twoRed: '兩紅後的提議', decisive: '關鍵票（座位 × 局）', blueVote: '藍方投票（座位 × 局）',
};

/** 事件單位（discoveryEvents.ts）：列帶叢集鍵，用叢集穩健的檢定。 */
export const isEventUnit = (u: DiscoveryUnit): u is EventUnit => (EVENT_UNITS as readonly string[]).includes(u);

/** 數字所在的分頁（自動發現的卡片「看數字」）：兩紅派隊分組（陣容強度）、數據排行「關鍵外白／內黑」（關鍵票或全部投票）。 */
export type DiscoveryLink = 'twoRedCohort' | 'decisiveBoard' | 'decisiveBoardAll';

export interface DiscoveryDimension {
  id: string;
  unit: DiscoveryUnit;
  label: string;
  help: string;
  kind: 'numeric' | 'category';
  /** 陣容強度的維度（陣容強度分頁會列、可以連到組成比較）。 */
  lineup?: boolean;
  /**
   * 遊戲結構本身的維度（第幾輪、比分、第幾次提議、隊長座位）：差異很大但大多是規則與局勢造成的（例：第 5 輪大家都
   * 比較敢投反對），畫面預設不列，可以打開。
   */
  structural?: boolean;
  /** 直接比這兩類（例：強者 vs 新手），不是「某一類 vs 其他」。 */
  pair?: readonly [string, string];
  /** 做事的人的分組（強者 vs 新手）：策略寫成「照強者做」。 */
  skill?: boolean;
  /** 角色：差異多半來自角色本身的資訊差，不給策略。 */
  role?: boolean;
}

export interface DiscoveryMetric {
  id: string;
  unit: DiscoveryUnit;
  label: string;
  help: string;
  kind: 'rate' | 'avg';
  pages: DiscoveryPage[];
  /** 數字所在的分頁（新資料：兩紅派隊分組、關鍵外白／內黑）。 */
  link?: DiscoveryLink;
}

type Row = DiscoveryRow;

// ── 維度與指標的定義 ─────────────────────────────────────

const SECTION_PAGES: Record<string, DiscoveryPage[]> = {
  結果: ['overview', 'strength'],
  派隊與任務: ['teams', 'missions', 'strength'],
  投票: ['votes', 'strength'],
  紅方出牌: ['missions', 'strength'],
  湖中女神: ['lake', 'strength'],
  角色決策: ['roles', 'strength'],
  失誤標籤: ['overview', 'strength'],
};

const NUM = 'numeric' as const;
const CAT = 'category' as const;

export const DISCOVERY_DIMENSIONS: readonly DiscoveryDimension[] = [
  ...STRENGTH_DIMENSIONS.map((d) => ({ id: d.id, unit: 'game' as const, label: d.label, help: d.help, kind: NUM, lineup: true })),
  { id: 'category', unit: 'game', label: '分類', help: '線瓦／面瓦／娛樂', kind: CAT },
  { id: 'year', unit: 'game', label: '年份', help: '對局日期的年份', kind: CAT },
  { id: 'merlinSeat', unit: 'game', label: '梅林座位', help: '梅林坐幾號位', kind: CAT },
  { id: 'assassinAfterMerlin', unit: 'game', label: '刺客在梅林後第幾位', help: '從梅林順時針數到刺客是第幾個座位', kind: CAT },
  { id: 'firstTeamRed', unit: 'game', label: '首隊紅方人數', help: '第 1 輪第 1 次提議的隊伍裡有幾個紅方', kind: CAT },
  { id: 'round', unit: 'proposal', label: '第幾輪', help: '提議在第幾個任務輪', kind: CAT, structural: true },
  { id: 'attempt', unit: 'proposal', label: '第幾次提議', help: '這一輪的第幾次提議（第 5 次是強制局，不投票，不列）', kind: CAT, structural: true },
  { id: 'leaderCamp', unit: 'proposal', label: '隊長陣營', help: '提議的隊長（依輪替推算）是紅方還是藍方', kind: CAT },
  { id: 'leaderRole', unit: 'proposal', label: '隊長角色', help: '提議的隊長（依輪替推算）的角色', kind: CAT },
  { id: 'leaderSeat', unit: 'proposal', label: '隊長座位', help: '提議的隊長坐幾號位', kind: CAT, structural: true },
  { id: 'sequence', unit: 'proposal', label: '局勢（任務順序）', help: '這一輪開始前各任務的結果，照順序（例：藍紅紅）。同樣 2：2，紅藍藍紅跟藍紅紅藍是不同的局勢', kind: CAT, structural: true },
  { id: 'seqLake', unit: 'proposal', label: '局勢＋湖中宣告', help: '任務順序再加上目前為止湖中女神的宣告（例：藍紅｜湖宣告紅）', kind: CAT, structural: true },
  { id: 'score', unit: 'proposal', label: '比分', help: '這一輪開始前的任務比分（藍：紅；不看順序）', kind: CAT, structural: true },
  { id: 'teamThumb', unit: 'proposal', label: '隊上有拇指', help: '隊伍裡有梅林或莫甘娜（派西看到的兩個拇指）', kind: CAT },
  { id: 'leaderPr', unit: 'proposal', label: '隊長 PR', help: '這次提議的隊長的開打前 PR', kind: NUM, lineup: true },
  { id: 'sTable', unit: 'proposal', label: '桌上 S', help: '這局的桌上 S', kind: NUM, lineup: true },
  { id: 'round', unit: 'mission', label: '第幾輪', help: '第幾個任務', kind: CAT, structural: true },
  { id: 'sequence', unit: 'mission', label: '局勢（任務順序）', help: '這一輪開始前各任務的結果，照順序（例：藍紅紅）。同樣 2：2，紅藍藍紅跟藍紅紅藍是不同的局勢', kind: CAT, structural: true },
  { id: 'seqLake', unit: 'mission', label: '局勢＋湖中宣告', help: '任務順序再加上目前為止湖中女神的宣告（例：藍紅｜湖宣告紅）', kind: CAT, structural: true },
  { id: 'score', unit: 'mission', label: '比分', help: '這一輪開始前的任務比分（藍：紅；不看順序）', kind: CAT, structural: true },
  { id: 'attempt', unit: 'mission', label: '第幾次提議出發', help: '出任務的隊伍是這一輪的第幾次提議', kind: CAT, structural: true },
  { id: 'leaderCamp', unit: 'mission', label: '隊長陣營', help: '出任務那一隊的隊長陣營（依輪替推算）', kind: CAT },
  { id: 'sTable', unit: 'mission', label: '桌上 S', help: '這局的桌上 S', kind: NUM, lineup: true },
  { id: 'after', unit: 'lake', label: '第幾輪後', help: '湖中女神在第幾個任務之後', kind: CAT, structural: true },
  { id: 'holderCamp', unit: 'lake', label: '持湖陣營', help: '拿湖的人是紅方還是藍方', kind: CAT },
  { id: 'holderRole', unit: 'lake', label: '持湖角色', help: '拿湖的人的角色', kind: CAT },
  { id: 'sequence', unit: 'lake', label: '局勢（任務順序）', help: '用湖時各任務的結果，照順序', kind: CAT, structural: true },
  { id: 'seqLake', unit: 'lake', label: '局勢＋之前的湖中宣告', help: '任務順序再加上這次之前湖中女神的宣告', kind: CAT, structural: true },
  { id: 'score', unit: 'lake', label: '比分', help: '用湖時的任務比分（藍：紅；不看順序）', kind: CAT, structural: true },
  { id: 'holderPr', unit: 'lake', label: '持湖 PR', help: '拿湖的人的開打前 PR', kind: NUM, lineup: true },
  { id: 'sTable', unit: 'lake', label: '桌上 S', help: '這局的桌上 S', kind: NUM, lineup: true },
  { id: 'seat', unit: 'seat', label: '座位', help: '幾號位', kind: CAT },
  { id: 'role', unit: 'seat', label: '角色', help: '這個座位的角色', kind: CAT },
  { id: 'firstLeader', unit: 'seat', label: '首家', help: '這個座位是不是第一次提議的隊長（依輪替推算）', kind: CAT },
  { id: 'r1Tail', unit: 'seat', label: '第 1 輪尾家', help: '這個座位是不是第 1 輪第 5 次提議（強制局）的隊長', kind: CAT },
  { id: 'seatPr', unit: 'seat', label: '這位的 PR', help: '坐這個座位的玩家的開打前 PR', kind: NUM, lineup: true },
  ...EVENT_DIMENSIONS.map((d): DiscoveryDimension => ({ ...d, kind: CAT })),
];

export const DISCOVERY_METRICS: readonly DiscoveryMetric[] = [
  ...STRENGTH_METRICS.filter((m) => m.section !== '陣容').map((m) => ({
    id: m.id, unit: 'game' as const, label: m.label, help: m.help, kind: m.kind,
    pages: m.id === 'hit' || m.id === 'killPercival' ? ['assassination', 'strength'] as DiscoveryPage[] : SECTION_PAGES[m.section] ?? ['strength'],
  })),
  { id: 'passed', unit: 'proposal', label: '提議通過', help: '非強制提議裡，這一隊就是出任務那一隊的比例', kind: 'rate', pages: ['teams', 'votes'] },
  { id: 'teamRed', unit: 'proposal', label: '隊上有紅', help: '提議的隊伍裡至少有一個紅方的比例', kind: 'rate', pages: ['teams'] },
  { id: 'leaderOnTeam', unit: 'proposal', label: '隊長自己上車', help: '隊長（依輪替推算）把自己排進隊伍的比例', kind: 'rate', pages: ['teams'] },
  { id: 'offApproveRed', unit: 'proposal', label: '紅方隊外贊成率', help: '紅方不在隊上時投贊成（外白）的比例（票數對得上結果的提議）', kind: 'rate', pages: ['votes'] },
  { id: 'offApproveBlue', unit: 'proposal', label: '藍方隊外贊成率', help: '藍方不在隊上時投贊成（外白）的比例', kind: 'rate', pages: ['votes'] },
  { id: 'onRejectRed', unit: 'proposal', label: '紅方隊上反對率', help: '紅方在隊上卻投反對（內黑）的比例', kind: 'rate', pages: ['votes'] },
  { id: 'onRejectBlue', unit: 'proposal', label: '藍方隊上反對率', help: '藍方在隊上卻投反對（內黑）的比例', kind: 'rate', pages: ['votes'] },
  { id: 'abnormal', unit: 'proposal', label: '每次提議異常票', help: '外白＋內黑的張數（票數對得上結果的提議）', kind: 'avg', pages: ['votes'] },
  { id: 'failed', unit: 'mission', label: '任務失敗', help: '任務被紅方拿下（第 4 輪要兩張失敗）的比例', kind: 'rate', pages: ['missions'] },
  { id: 'overfail', unit: 'mission', label: '兩紅以上多爆', help: '隊上有 2 個以上紅方時出了 2 張以上失敗的比例（第 4 輪不算）', kind: 'rate', pages: ['missions'] },
  { id: 'loneFail', unit: 'mission', label: '單紅出失敗', help: '隊上只有 1 個紅方時他出失敗的比例（第 4 輪不算）', kind: 'rate', pages: ['missions'] },
  { id: 'targetRed', unit: 'lake', label: '驗到紅', help: '湖中驗的人是紅方的比例', kind: 'rate', pages: ['lake'] },
  { id: 'claimTrue', unit: 'lake', label: '宣告與事實相符', help: '有寫宣告時，宣告的陣營跟被驗者真實陣營相同的比例', kind: 'rate', pages: ['lake'] },
  { id: 'claimRed', unit: 'lake', label: '宣告紅', help: '有寫宣告時宣告「紅」的比例', kind: 'rate', pages: ['lake'] },
  { id: 'targetMerlin', unit: 'lake', label: '驗到梅林', help: '湖中驗的人是梅林的比例', kind: 'rate', pages: ['lake'] },
  { id: 'finalWin', unit: 'seat', label: '最後贏', help: '這個座位的陣營最後贏（紅方：三紅或三藍被刀；藍方：三藍躲刺）的比例', kind: 'rate', pages: ['position', 'roles'] },
  { id: 'missionWin', unit: 'seat', label: '任務階段贏', help: '這個座位的陣營拿下三次任務的比例', kind: 'rate', pages: ['position', 'roles'] },
  ...EVENT_METRICS.map((m): DiscoveryMetric => ({
    ...m, kind: 'rate',
    pages: m.unit === 'twoRed' ? ['teams'] : ['votes'],
    link: m.unit === 'twoRed' ? 'twoRedCohort' : m.unit === 'decisive' ? 'decisiveBoard' : 'decisiveBoardAll',
  })),
];

/** 定義上就會相關的組合（單位|維度|指標），不比。 */
export const EXCLUDED_PAIRS: ReadonlySet<string> = new Set([
  'proposal|leaderCamp|teamRed', 'proposal|leaderRole|teamRed', 'proposal|teamThumb|teamRed',
  'proposal|round|passed', 'proposal|attempt|passed',
  'mission|round|overfail', 'mission|round|loneFail',
  // 紅方隊長幾乎都派自己上車：隊上就有紅
  'mission|leaderCamp|failed',
  'seat|role|finalWin', 'seat|role|missionWin',
  'lake|holderCamp|claimTrue', 'lake|holderRole|claimTrue', 'lake|holderRole|targetMerlin',
  // 10 號先拿湖，拿過湖的人不能再被驗：梅林坐 10 號就驗不到梅林
  'game|merlinSeat|lakeMerlin',
]);

// ── 拆單位 ─────────────────────────────────────────────

const FAILS_NEEDED = [1, 1, 1, 2, 1];

function decidedOutcome(g: Game): boolean {
  return g.outcome === OUTCOME_THREE_RED || g.outcome === OUTCOME_BLUE_DEAD || g.outcome === OUTCOME_BLUE_ALIVE;
}

function facts(entries: Array<[string, number, number] | null>): Facts {
  const m: Facts = new Map();
  for (const e of entries) if (e && e[2] > 0) m.set(e[0], [e[1], e[2]]);
  return m;
}

/** 一局拆出來的五種單位（事件單位另外拆，discoveryEvents.ts）。 */
type GameUnit = Exclude<DiscoveryUnit, EventUnit>;

const units = new WeakMap<Game, Record<GameUnit, Row[]>>();

/** 一局拆成五種單位的列（快取）。 */
export function gameUnits(g: Game): Record<GameUnit, Row[]> {
  const hit = units.get(g);
  if (hit) return hit;
  const info = gameInfo(g);
  const rolesKnown = /^[0-9]{6}$/.test(g.config);
  const roleOf = (s: string): string => g.seatRoles.get(s) ?? '忠臣';
  const isRed = (s: string): boolean => RED_ROLES.has(roleOf(s));
  const prOf = (s: string | undefined): number | null => {
    if (!s || !g.lineup) return null;
    const i = (SEATS as readonly string[]).indexOf(s);
    return i >= 0 && g.seatPlayers[i] ? g.lineup.prs[i] : null;
  };
  const seatName = (s: string): string => `${s === '0' ? 10 : s} 號`;
  const sTable = g.lineup?.s ?? null;
  const leaders = deriveLeaderSeats(g.votingProposals.map((p) => p[2]));
  const out: Record<GameUnit, Row[]> = { game: [], proposal: [], mission: [], lake: [], seat: [] };

  // game
  const merlin = SEATS.find((s) => roleOf(s) === '梅林');
  const assassin = SEATS.find((s) => roleOf(s) === '刺客');
  const seatNo = (s: string): number => (s === '0' ? 10 : Number(s));
  out.game.push({
    dims: {
      ...info.dims,
      category: g.category || null,
      year: g.timelineDate ? g.timelineDate.slice(0, 4) : null,
      merlinSeat: rolesKnown && merlin ? seatName(merlin) : null,
      assassinAfterMerlin: rolesKnown && merlin && assassin ? `第 ${(seatNo(assassin) - seatNo(merlin) + 10) % 10} 位` : null,
      firstTeamRed: rolesKnown && g.r11Seats.length ? `${Math.min(g.r11RedCount, 2)}${g.r11RedCount >= 2 ? '+' : ''} 紅` : null,
    },
    metrics: info.facts,
  });

  // 每輪開始前的比分
  // 每輪開始前的局勢：任務結果照順序（Edward 2026-10-31「紅藍藍紅 跟 藍紅紅藍 是完全不同的意義」），另有不看順序的比分；
  // 再加上到那時為止湖中女神的宣告（第 k 個湖在第 k+2 輪任務後）
  const scoreBefore: string[] = [];
  const seqBefore: string[] = [];
  const seqLakeBefore: string[] = [];
  let blue = 0;
  let red = 0;
  let seq = '';
  const lakeClaimAfter = (round: number): string => {
    const lake = g.lakes[round - 2];
    if (!lake) return '';
    const c = g.claims.find((x) => x.holder === lake.holder && x.target === lake.target)?.claim;
    return c === '紅' ? '紅' : c === '藍' ? '藍' : '?';
  };
  let lakes = '';
  for (let i = 0; i < 5; i++) {
    scoreBefore[i] = `藍 ${blue}：紅 ${red}`;
    seqBefore[i] = seq || '（開局）';
    seqLakeBefore[i] = `${seq || '（開局）'}${lakes ? `｜湖宣告${lakes}` : ''}`;
    const cell = g.roundResults[i] ?? '';
    if (!cell) continue;
    const isRedRound = [...cell].filter((c) => c === 'x').length >= FAILS_NEEDED[i];
    if (isRedRound) red += 1; else blue += 1;
    seq += isRedRound ? '紅' : '藍';
    lakes += lakeClaimAfter(i + 1);
  }

  // proposal & mission
  const byRound = new Map<number, number[]>();
  g.votingProposals.forEach(([round], k) => byRound.set(round, [...(byRound.get(round) ?? []), k]));
  if (rolesKnown) {
    for (const [round, ks] of byRound) {
      const cell = g.roundResults[round - 1] ?? '';
      ks.forEach((k, idx) => {
        const [, attempt, team, approved] = g.votingProposals[k];
        const went = Boolean(cell) && idx === ks.length - 1;
        const leader = leaders?.[k];
        if (attempt < 5) {
          const yes = new Set(approved);
          const reliable = (yes.size > 5) === went;
          const count = (test: (s: string) => boolean): number => SEATS.filter(test).length;
          const offRed = count((s) => !team.includes(s) && isRed(s));
          const offBlue = count((s) => !team.includes(s) && !isRed(s));
          const onRed = count((s) => team.includes(s) && isRed(s));
          const onBlue = count((s) => team.includes(s) && !isRed(s));
          const abnormal = count((s) => (team.includes(s) ? !yes.has(s) : yes.has(s)));
          out.proposal.push({
            dims: {
              round: `第 ${round} 輪`, attempt: `第 ${attempt} 次`,
              leaderCamp: leader ? (isRed(leader) ? '紅方' : '藍方') : null,
              leaderRole: leader ? roleOf(leader) : null,
              leaderSeat: leader ? seatName(leader) : null,
              score: scoreBefore[round - 1] ?? null,
              sequence: seqBefore[round - 1] ?? null,
              seqLake: seqLakeBefore[round - 1] ?? null,
              teamThumb: [...team].some((s) => roleOf(s) === '梅林' || roleOf(s) === '莫甘娜') ? '有拇指' : '沒有拇指',
              leaderPr: prOf(leader), sTable,
            },
            metrics: facts([
              cell ? ['passed', went ? 1 : 0, 1] : null,
              ['teamRed', [...team].some(isRed) ? 1 : 0, 1],
              leader ? ['leaderOnTeam', team.includes(leader) ? 1 : 0, 1] : null,
              reliable ? ['offApproveRed', count((s) => !team.includes(s) && isRed(s) && yes.has(s)), offRed] : null,
              reliable ? ['offApproveBlue', count((s) => !team.includes(s) && !isRed(s) && yes.has(s)), offBlue] : null,
              reliable ? ['onRejectRed', count((s) => team.includes(s) && isRed(s) && !yes.has(s)), onRed] : null,
              reliable ? ['onRejectBlue', count((s) => team.includes(s) && !isRed(s) && !yes.has(s)), onBlue] : null,
              reliable ? ['abnormal', abnormal, 1] : null,
            ]),
          });
        }
        if (went && team.length === cell.length) {
          const reds = [...team].filter(isRed).length;
          const fails = [...cell].filter((c) => c === 'x').length;
          out.mission.push({
            dims: {
              round: `第 ${round} 輪`, score: scoreBefore[round - 1] ?? null, attempt: `第 ${attempt} 次`,
              sequence: seqBefore[round - 1] ?? null, seqLake: seqLakeBefore[round - 1] ?? null,
              leaderCamp: leader ? (isRed(leader) ? '紅方' : '藍方') : null, sTable,
            },
            metrics: facts([
              ['failed', fails >= FAILS_NEEDED[round - 1] ? 1 : 0, 1],
              round !== 4 && reds >= 2 ? ['overfail', fails >= 2 ? 1 : 0, 1] : null,
              round !== 4 && reds === 1 ? ['loneFail', fails >= 1 ? 1 : 0, 1] : null,
            ]),
          });
        }
      });
    }

    // lake
    g.lakes.forEach((lake, i) => {
      if (!lake || !/^[0-9]$/.test(lake.holder) || !/^[0-9]$/.test(lake.target)) return;
      const claim = g.claims.find((c) => c.holder === lake.holder && c.target === lake.target)?.claim;
      const targetRed = isRed(lake.target);
      const said = claim === '紅' || claim === '藍';
      out.lake.push({
        dims: {
          after: `第 ${i + 2} 輪後`, holderCamp: isRed(lake.holder) ? '紅方' : '藍方', holderRole: roleOf(lake.holder),
          score: scoreBefore[i + 2] ?? null, sequence: seqBefore[i + 2] ?? null,
          // 這次之前的湖：任務順序後面接前幾個湖的宣告
          seqLake: `${seqBefore[i + 2]}${[...Array(i).keys()].map((j) => lakeClaimAfter(j + 2)).join('') ? `｜湖宣告${[...Array(i).keys()].map((j) => lakeClaimAfter(j + 2)).join('')}` : ''}`,
          holderPr: prOf(lake.holder), sTable,
        },
        metrics: facts([
          ['targetRed', targetRed ? 1 : 0, 1],
          said ? ['claimTrue', (claim === '紅') === targetRed ? 1 : 0, 1] : null,
          said ? ['claimRed', claim === '紅' ? 1 : 0, 1] : null,
          ['targetMerlin', roleOf(lake.target) === '梅林' ? 1 : 0, 1],
        ]),
      });
    });

    // seat
    if (decidedOutcome(g)) {
      for (const s of SEATS) {
        const role = roleOf(s);
        out.seat.push({
          dims: {
            seat: seatName(s), role,
            firstLeader: leaders ? (leaders[0] === s ? '是' : '否') : null,
            r1Tail: leaders && leaders.length >= 5 ? (leaders[4] === s ? '是' : '否') : null,
            seatPr: prOf(s),
          },
          metrics: facts([
            ['finalWin', isFinalWin(role, g.outcome) ? 1 : 0, 1],
            ['missionWin', (RED_ROLES.has(role) ? g.outcome === OUTCOME_THREE_RED : g.outcome !== OUTCOME_THREE_RED) ? 1 : 0, 1],
          ]),
        });
      }
    }
  }
  units.set(g, out);
  return out;
}

// ── 統計 ───────────────────────────────────────────────

/** 標準常態分布的累積機率（Abramowitz–Stegun 7.1.26，誤差 < 1.5e-7）。 */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const twoSided = (z: number): number => 2 * (1 - normalCdf(Math.abs(z)));

/** ln Γ(x)（Lanczos，x > 0）。 */
function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const ci of c) { y += 1; ser += ci / y; }
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

/** 正規化不完全 Beta 函數 I_x(a, b)（連分數，Numerical Recipes betacf）。 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (xx: number, aa: number, bb: number): number => {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d; if (Math.abs(d) < tiny) d = tiny; d = 1 / d;
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
      num = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d; if (Math.abs(d) < tiny) d = tiny; d = 1 / d;
      c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (front * cf(x, a, b)) / a : 1 - (front * cf(1 - x, b, a)) / b;
}

/** Student t 的雙尾 p（df 自由度；df 很大時等於常態）。 */
export function studentTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  if (!(df > 0) || df > 1e6) return twoSided(t);
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

const tCritCache = new Map<number, number>();
/** Student t 的 97.5% 分位數（95% CI 用；二分法）。 */
export function tCritical95(df: number): number {
  if (!(df > 0) || df > 1e6) return 1.96;
  const key = Math.round(df);
  const hit = tCritCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 1.9;
  let hi = 20;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (studentTwoSided(mid, key) > 0.05) lo = mid; else hi = mid;
  }
  const v = (lo + hi) / 2;
  tCritCache.set(key, v);
  return v;
}

/** 兩比例 z 檢定：[差（百分點）, 95% CI 下、上, p]。 */
export function twoProportion(k1: number, n1: number, k2: number, n2: number): { diff: number; lo: number; hi: number; p: number } {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  const diff = p1 - p2;
  return { diff: 100 * diff, lo: 100 * (diff - 1.96 * se), hi: 100 * (diff + 1.96 * se), p: sePooled > 0 ? twoSided(diff / sePooled) : 1 };
}

/** Welch 檢定（常態近似）：[差, 95% CI, p, Cohen's d]。 */
export function welch(a: readonly number[], b: readonly number[]): { diff: number; lo: number; hi: number; p: number; d: number } {
  const mean = (x: readonly number[]): number => x.reduce((s, v) => s + v, 0) / x.length;
  const variance = (x: readonly number[], m: number): number => x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1);
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a, ma);
  const vb = variance(b, mb);
  const se = Math.sqrt(va / a.length + vb / b.length);
  const diff = ma - mb;
  const sd = Math.sqrt((va + vb) / 2);
  return { diff, lo: diff - 1.96 * se, hi: diff + 1.96 * se, p: se > 0 ? twoSided(diff / se) : 1, d: sd > 0 ? diff / sd : 0 };
}

/** Cohen's h（兩個比例的效果量）。 */
export function cohenH(p1: number, p2: number): number {
  return 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(p2));
}

/** Benjamini–Hochberg 調整後的 q 值（與輸入同順序）。 */
export function benjaminiHochberg(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((x, y) => x[0] - y[0]);
  const q = new Array<number>(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, i] = order[r];
    min = Math.min(min, (p * m) / (r + 1));
    q[i] = min;
  }
  return q;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

// ── 掃描 ───────────────────────────────────────────────

export interface DiscoveryGroupStat {
  label: string;
  /** 比率（0–100）或平均。 */
  value: number;
  /** 分母（比率）或單位數（平均）。 */
  n: number;
  /** 這組有幾個單位（局、提議…）。 */
  units: number;
  /** 事件單位：這組的列來自幾局、幾位有寫名字的玩家。 */
  games?: number;
  players?: number;
}

export interface DiscoveryFinding {
  id: string;
  unit: DiscoveryUnit;
  dimension: DiscoveryDimension;
  metric: DiscoveryMetric;
  a: DiscoveryGroupStat;
  b: DiscoveryGroupStat;
  /** a − b（比率是百分點）與 95% CI。 */
  diff: number;
  lo: number;
  hi: number;
  p: number;
  q: number;
  /** 效果量（比率 Cohen's h、平均 Cohen's d），排序用。 */
  effect: number;
  /** 陣容維度：跟桌上 S 的相關係數。 */
  corrWithS?: number | null;
  /** 陣容維度：在 S 三分層內各自比，再依樣本加權平均的差（控制 S 後）。 */
  withinS?: number | null;
  /** 可以在組成比較打開的分組。 */
  grouping?: StrengthGrouping;
  /** 事件單位：檢定用叢集穩健的變異數（局、玩家兩個方向），p 與 CI 都已經算進同一局／同一位玩家的相關。 */
  clustered?: boolean;
  /** 事件單位：依做事的人的角色分層、各自比再加權平均的差（百分點；維度是角色時不算）。 */
  withinRole?: number | null;
  /** 新資料的發現：可能的策略（或不給的原因）。 */
  strategy?: DiscoveryStrategy;
}

export interface DiscoveryOptions {
  /** 每組至少幾個單位、比率的分母至少多少。 */
  minUnits?: number;
  minDen?: number;
  /** q 值門檻。 */
  fdr?: number;
  /** 事件單位：每組至少來自幾局、幾位玩家（叢集太少時叢集穩健的變異數不可靠）。 */
  minGames?: number;
  minPlayers?: number;
  /** 分組（強者／新手、高端／歡樂）的切點；預設 DEFAULT_COHORT_CUTS。 */
  cuts?: CohortCuts;
  /** 同一批局先算好的非事件單位候選（discoveryBase）；切點換了只重算事件單位。 */
  base?: DiscoveryBase;
}

export interface DiscoveryResult {
  /** 做了幾個檢定、各單位有幾列。 */
  tests: number;
  units: Record<DiscoveryUnit, number>;
  findings: DiscoveryFinding[];
}

interface Split {
  aLabel: string;
  bLabel: string;
  inA: (v: number | string) => boolean;
  inB: (v: number | string) => boolean;
  grouping?: StrengthGrouping;
}

function fmtCut(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function splitsFor(dim: DiscoveryDimension, rows: readonly Row[], minUnits: number): Split[] {
  const values = rows.map((r) => r.dims[dim.id]).filter((v): v is number | string => v !== null && v !== undefined);
  if (dim.pair) {
    const [a, b] = dim.pair;
    const na = values.filter((v) => v === a).length;
    const nb = values.filter((v) => v === b).length;
    return na >= minUnits && nb >= minUnits ? [{ aLabel: a, bLabel: b, inA: (v) => v === a, inB: (v) => v === b }] : [];
  }
  if (dim.kind === 'numeric') {
    const nums = (values as number[]).slice().sort((a, b) => a - b);
    if (nums.length < 3 * minUnits) return [];
    const lo = quantileSorted(nums, 1 / 3);
    const hi = quantileSorted(nums, 2 / 3);
    if (!(hi > lo)) return [];
    return [{
      aLabel: `前 1/3（≥ ${fmtCut(hi)}）`, bLabel: `後 1/3（< ${fmtCut(lo)}）`,
      inA: (v) => (v as number) >= hi, inB: (v) => (v as number) < lo,
      grouping: dim.unit === 'game' && dim.lineup ? { kind: 'tertile', dim: dim.id, lo, hi } : undefined,
    }];
  }
  const counts = new Map<string, number>();
  for (const v of values) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  if (counts.size < 2) return [];
  // 只有兩類時（紅方／藍方、是／否）兩個方向是同一件事：只比第一類
  const cats = [...counts.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return (counts.size === 2 ? cats.slice(0, 1) : cats)
    .filter(([, n]) => n >= minUnits && values.length - n >= minUnits)
    .map(([cat]) => ({ aLabel: cat, bLabel: '其他', inA: (v) => String(v) === cat, inB: (v) => String(v) !== cat }));
}

/**
 * 一組單位對每個指標的充分統計量：[k, n, 單位數, Σv, Σv²]，再加 S 三分層各自的 [k, n, 單位數, Σv]（v = 每個單位的
 * 分子 ÷ 分母）。一次掃過全部列就能算出每一類（或每個三分位）的數字，類別維度的「其他」= 全部 − 這一類。
 */
const ACC = 5 + 12;
type Acc = Float64Array;

function accumulate(target: Map<string, Acc>, row: Row, tier: number): void {
  for (const [id, [k, n]] of row.metrics) {
    let a = target.get(id);
    if (!a) {
      a = new Float64Array(ACC);
      target.set(id, a);
    }
    const v = k / n;
    a[0] += k; a[1] += n; a[2] += 1; a[3] += v; a[4] += v * v;
    if (tier >= 0) {
      const o = 5 + 4 * tier;
      a[o] += k; a[o + 1] += n; a[o + 2] += 1; a[o + 3] += v;
    }
  }
}

function minusAcc(total: Acc | undefined, part: Acc | undefined): Acc {
  const out = new Float64Array(ACC);
  for (let i = 0; i < ACC; i++) out[i] = (total?.[i] ?? 0) - (part?.[i] ?? 0);
  return out;
}

/** Welch 檢定（從充分統計量）。 */
function welchFromSums(a: Acc, b: Acc): { diff: number; lo: number; hi: number; p: number; d: number } {
  const stat = (x: Acc): [number, number, number] => {
    const n = x[2];
    const mean = x[3] / n;
    const variance = n > 1 ? Math.max(0, (x[4] - n * mean * mean) / (n - 1)) : 0;
    return [n, mean, variance];
  };
  const [na, ma, va] = stat(a);
  const [nb, mb, vb] = stat(b);
  const se = Math.sqrt(va / na + vb / nb);
  const diff = ma - mb;
  const sd = Math.sqrt((va + vb) / 2);
  return { diff, lo: diff - 1.96 * se, hi: diff + 1.96 * se, p: se > 0 ? twoSided(diff / se) : 1, d: sd > 0 ? diff / sd : 0 };
}

// ── 事件單位：叢集穩健的兩比例檢定 ───────────────────────────────

/**
 * 一組列的 [分子, 分母]：全部加總，以及依局、依玩家、依（局 × 玩家）各自加總；另有依角色的 [分子, 分母, 列數]。
 * 同一局的幾次提議、同一位玩家在很多局的票彼此相關，所以變異數用叢集穩健（sandwich）的寫法：
 *   差 d = pA − pB，每個叢集 c 的影響量 u_c =（kA_c − pA·nA_c）/ NA −（kB_c − pB·nB_c）/ NB，
 *   V_叢集 = G /（G − 1）· Σ u_c²（G = 叢集數；同一個叢集同時在兩組也照算，兩組的共變數自動扣掉）。
 * 兩個方向（Cameron–Gelbach–Miller）：V = V_局 + V_玩家 − V_局×玩家，再取 V、V_局、V_玩家、V_獨立（不管叢集）裡最大的
 * （保守），p 與 CI 用自由度 = 最少叢集數 − 1 的 t 分布（叢集少時 sandwich 偏小）。
 * 等於用局與玩家當重抽單位的 bootstrap 的大樣本近似；每組至少 minGames 局、minPlayers 位有寫名字的玩家才比
 * （沒寫名字的座位各自當一個叢集，但不算進玩家數）。
 */
export class ClusterAcc {
  k = 0;
  n = 0;
  units = 0;
  /** 叢集編號 → [分子, 分母]（局、玩家、局 × 玩家各一套編號）。 */
  readonly byGame = new Map<number, [number, number]>();
  readonly byPlayer = new Map<number, [number, number]>();
  readonly byInter = new Map<number, [number, number]>();
  readonly strata = new Map<string, [number, number, number]>();

  add(k: number, n: number, game: number, player: number, inter: number, stratum?: string): void {
    this.k += k;
    this.n += n;
    this.units += 1;
    bump(this.byGame, game, k, n);
    bump(this.byPlayer, player, k, n);
    bump(this.byInter, inter, k, n);
    if (stratum !== undefined) {
      const s = this.strata.get(stratum);
      if (s) { s[0] += k; s[1] += n; s[2] += 1; } else this.strata.set(stratum, [k, n, 1]);
    }
  }
}

function bump(m: Map<number, [number, number]>, key: number, k: number, n: number): void {
  const e = m.get(key);
  if (e) { e[0] += k; e[1] += n; } else m.set(key, [k, n]);
}

/** 一組的摘要（「其他」= 全部 − 這一組時不用真的建出每個叢集）。 */
interface SideSummary {
  k: number;
  n: number;
  units: number;
  games: number;
  players: number;
  strata: Map<string, [number, number, number]>;
}

/** 有寫名字的玩家數（named = 玩家編號 → 有沒有名字；沒給 = 全部算）。 */
function namedCount(m: Map<number, [number, number]>, named?: Uint8Array): number {
  if (!named) return m.size;
  let c = 0;
  for (const key of m.keys()) if (named[key]) c += 1;
  return c;
}

const summaryOf = (x: ClusterAcc, named?: Uint8Array): SideSummary => ({
  k: x.k, n: x.n, units: x.units, games: x.byGame.size, players: namedCount(x.byPlayer, named), strata: x.strata,
});

/** 有分母的叢集數（全部 − 這一組；named 給了就只數有名字的玩家）。 */
function restCount(total: Map<number, [number, number]>, part: Map<number, [number, number]>, named?: Uint8Array): number {
  let c = 0;
  for (const [key, [, n]] of total) if ((!named || named[key]) && n - (part.get(key)?.[1] ?? 0) > 0) c += 1;
  return c;
}

function restSummary(total: ClusterAcc, part: ClusterAcc, named?: Uint8Array): SideSummary {
  const strata = new Map<string, [number, number, number]>();
  for (const [key, [k, n, u]] of total.strata) {
    const p = part.strata.get(key);
    const uu = u - (p?.[2] ?? 0);
    if (uu > 0) strata.set(key, [k - (p?.[0] ?? 0), n - (p?.[1] ?? 0), uu]);
  }
  return {
    k: total.k - part.k, n: total.n - part.n, units: total.units - part.units,
    games: restCount(total.byGame, part.byGame), players: restCount(total.byPlayer, part.byPlayer, named), strata,
  };
}

/**
 * Σ u_c² 的 G /（G − 1）倍。b = null 時 B =（total − a），只走 total 的叢集（a 的叢集都在 total 裡）；
 * 否則 A、B 兩組的叢集聯集。
 */
function clusterVariance(
  a: Map<number, [number, number]>, other: Map<number, [number, number]>, rest: boolean,
  pA: number, nA: number, pB: number, nB: number,
): number {
  let sum = 0;
  let g = 0;
  if (rest) {
    for (const [key, [kt, nt]] of other) {
      const [ka, na] = a.get(key) ?? [0, 0];
      const u = (ka - pA * na) / nA - ((kt - ka) - pB * (nt - na)) / nB;
      sum += u * u;
      g += 1;
    }
  } else {
    for (const [key, [ka, na]] of a) {
      const [kb, nb] = other.get(key) ?? [0, 0];
      const u = (ka - pA * na) / nA - (kb - pB * nb) / nB;
      sum += u * u;
      g += 1;
    }
    for (const [key, [kb, nb]] of other) {
      if (a.has(key)) continue;
      const u = -(kb - pB * nb) / nB;
      sum += u * u;
      g += 1;
    }
  }
  return g > 1 ? (g / (g - 1)) * sum : sum;
}

interface ClusterTest { diff: number; lo: number; hi: number; p: number; se: number; naiveP: number; df: number }

/**
 * 叢集穩健的兩比例檢定。變異數取 V_局 + V_玩家 − V_局×玩家、V_局、V_玩家、不管叢集的 V_獨立 裡最大的（叢集內負相關或
 * 同一局在兩組時，叢集變異數可能比獨立的還小；取最大才真的是保守）。叢集少時 sandwich 估計偏小，p 與 CI 改用自由度
 * df = 最少的叢集數 − 1 的 t 分布（兩組各自的局數與玩家數裡最小的）。
 */
function clusterTest(a: ClusterAcc, other: ClusterAcc, rest: boolean, b: SideSummary, df: number): ClusterTest {
  const pA = a.k / a.n;
  const pB = b.k / b.n;
  const vg = clusterVariance(a.byGame, other.byGame, rest, pA, a.n, pB, b.n);
  const vp = clusterVariance(a.byPlayer, other.byPlayer, rest, pA, a.n, pB, b.n);
  const vi = clusterVariance(a.byInter, other.byInter, rest, pA, a.n, pB, b.n);
  const vIid = (pA * (1 - pA)) / a.n + (pB * (1 - pB)) / b.n;
  const v = Math.max(vg + vp - vi, vg, vp, vIid);
  const se = Math.sqrt(v);
  const d = pA - pB;
  const p = se > 0 ? studentTwoSided(d / se, df) : d === 0 ? 1 : 0;
  const crit = tCritical95(df);
  return { diff: 100 * d, lo: 100 * (d - crit * se), hi: 100 * (d + crit * se), p, se: 100 * se, naiveP: twoProportion(a.k, a.n, b.k, b.n).p, df };
}

/** 叢集穩健的兩比例檢定（兩組各自的列）：差（百分點）、95% CI、p，以及不管叢集的一般兩比例 z 檢定的 p（比較用）。 */
export function clusteredTwoProportion(a: ClusterAcc, b: ClusterAcc): ClusterTest {
  const df = Math.min(a.byGame.size, b.byGame.size, a.byPlayer.size, b.byPlayer.size) - 1;
  return clusterTest(a, b, false, summaryOf(b), df);
}

/** 依角色分層、各自比，再依樣本（兩組列數較小的那個）加權平均的差（百分點）；每層每組至少 10 列才算。 */
function withinStrata(a: SideSummary, b: SideSummary): number | null {
  let acc = 0;
  let wsum = 0;
  for (const [key, [ka, na, ua]] of a.strata) {
    const s = b.strata.get(key);
    if (!s) continue;
    const [kb, nb, ub] = s;
    if (ua < 10 || ub < 10 || na === 0 || nb === 0) continue;
    const w = Math.min(ua, ub);
    acc += w * 100 * (ka / na - kb / nb);
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : null;
}

interface EventLimits { minUnits: number; minDen: number; minGames: number; minPlayers: number }

/** 列的玩家編號與（局 × 玩家）編號（每個單位算一次）。 */
const clusterIds = new WeakMap<readonly Row[], { player: Int32Array; inter: Int32Array; named: Uint8Array }>();

/** 沒寫名字的座位的叢集鍵以 # 開頭（discoveryEvents.ts）：各自一個叢集，但不算進「幾位玩家」。 */
function idsOf(rows: readonly Row[]): { player: Int32Array; inter: Int32Array; named: Uint8Array } {
  const hit = clusterIds.get(rows);
  if (hit) return hit;
  const players = new Map<string, number>();
  const inters = new Map<string, number>();
  const player = new Int32Array(rows.length);
  const inter = new Int32Array(rows.length);
  rows.forEach((r, i) => {
    if (!r.cluster) return;
    const name = r.cluster.player;
    let pid = players.get(name);
    if (pid === undefined) { pid = players.size; players.set(name, pid); }
    const ik = `${r.cluster.game}|${pid}`;
    let iid = inters.get(ik);
    if (iid === undefined) { iid = inters.size; inters.set(ik, iid); }
    player[i] = pid;
    inter[i] = iid;
  });
  const named = new Uint8Array(players.size);
  for (const [name, pid] of players) named[pid] = name.startsWith('#') ? 0 : 1;
  const out = { player, inter, named };
  clusterIds.set(rows, out);
  return out;
}

/** 事件單位的一個維度：每一組 × 每個指標的叢集穩健檢定。 */
function clusteredCandidates(
  dim: DiscoveryDimension, rows: readonly Row[], splits: readonly Split[], metrics: readonly DiscoveryMetric[], lim: EventLimits,
): Array<Omit<DiscoveryFinding, 'q'>> {
  const ids = new Set(metrics.map((m) => m.id));
  const { player, inter, named } = idsOf(rows);
  const buckets = new Map<string, Map<string, ClusterAcc>>();
  const total = new Map<string, ClusterAcc>();
  const get = (m: Map<string, ClusterAcc>, id: string): ClusterAcc => {
    let a = m.get(id);
    if (!a) { a = new ClusterAcc(); m.set(id, a); }
    return a;
  };
  rows.forEach((r, i) => {
    const v = r.dims[dim.id];
    if (v === null || v === undefined || !r.cluster) return;
    const key = String(v);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = new Map(); buckets.set(key, bucket); }
    const game = r.cluster.game;
    for (const [id, [k, n]] of r.metrics) {
      if (!ids.has(id)) continue;
      get(bucket, id).add(k, n, game, player[i], inter[i], r.stratum);
      if (!dim.pair) get(total, id).add(k, n, game, player[i], inter[i], r.stratum);
    }
  });
  const enough = (x: SideSummary): boolean => x.units >= lim.minUnits && x.n >= lim.minDen
    && x.games >= lim.minGames && x.players >= lim.minPlayers;
  const out: Array<Omit<DiscoveryFinding, 'q'>> = [];
  for (const split of splits) {
    const accA = buckets.get(split.aLabel);
    if (!accA) continue;
    const accB = dim.pair ? buckets.get(split.bLabel) : undefined;
    for (const metric of metrics) {
      const a = accA.get(metric.id);
      if (!a) continue;
      const other = dim.pair ? accB?.get(metric.id) : total.get(metric.id);
      if (!other) continue;
      const sa = summaryOf(a, named);
      const sb = dim.pair ? summaryOf(other, named) : restSummary(other, a, named);
      if (!enough(sa) || !enough(sb)) continue;
      // 自由度：兩組的局數、有名字的玩家數裡最少的 − 1（沒名字的座位各自一個叢集，不算進來：偏保守）
      const t = clusterTest(a, other, !dim.pair, sb, Math.min(sa.games, sb.games, sa.players, sb.players) - 1);
      out.push({
        id: `${dim.unit}|${dim.id}|${split.aLabel}|${metric.id}`,
        unit: dim.unit, dimension: dim, metric,
        a: { label: split.aLabel, value: (100 * sa.k) / sa.n, n: sa.n, units: sa.units, games: sa.games, players: sa.players },
        b: { label: split.bLabel, value: (100 * sb.k) / sb.n, n: sb.n, units: sb.units, games: sb.games, players: sb.players },
        diff: t.diff, lo: t.lo, hi: t.hi, p: t.p, effect: cohenH(sa.k / sa.n, sb.k / sb.n),
        clustered: true,
        withinRole: dim.role ? undefined : withinStrata(sa, sb),
      });
    }
  }
  return out;
}

const eventCache = new WeakMap<Game, { key: string; rows: Record<EventUnit, Row[]> }>();

function cachedEventUnits(g: Game, cuts: CohortCuts): Record<EventUnit, Row[]> {
  const key = encodeCohortCuts(cuts);
  const hit = eventCache.get(g);
  if (hit && hit.key === key) return hit.rows;
  const rows = eventUnits(g, cuts);
  eventCache.set(g, { key, rows });
  return rows;
}

type Candidate = Omit<DiscoveryFinding, 'q'>;

/**
 * 不靠分組切點的那一半（局、提議、任務、湖、座位五種單位）的候選檢定（還沒做 BH）。切點一換只要重算事件單位：
 * 網站的 Worker 依篩選快取這一份，傳進 discoverFindings 的 options.base，BH 再對合起來的全部檢定做一次。
 */
export interface DiscoveryBase {
  readonly minUnits: number;
  readonly minDen: number;
  /** 算的時候用的局（傳進 discoverFindings 時逐局比對是不是同一批物件，不符就重算）。 */
  readonly games: readonly Game[];
  readonly candidates: readonly Candidate[];
  readonly units: Record<GameUnit, number>;
}

export function discoveryBase(games: readonly Game[], options: Pick<DiscoveryOptions, 'minUnits' | 'minDen'> = {}): DiscoveryBase {
  const minUnits = options.minUnits ?? 30;
  const minDen = options.minDen ?? 30;
  const rows: Record<GameUnit, Row[]> = { game: [], proposal: [], mission: [], lake: [], seat: [] };
  for (const g of games) {
    const u = gameUnits(g);
    for (const key of Object.keys(u) as GameUnit[]) for (const r of u[key]) rows[key].push(r);
  }
  // 陣容維度的 S 三分層（控制 S 用）
  const sValues = rows.game.map((r) => r.dims.s).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const sCuts = sValues.length >= 9 ? [quantileSorted(sValues, 1 / 3), quantileSorted(sValues, 2 / 3)] : null;
  const sTier = (r: Row): number => {
    const s = r.dims.s;
    if (typeof s !== 'number' || !sCuts) return -1;
    return s < sCuts[0] ? 0 : s < sCuts[1] ? 1 : 2;
  };

  const candidates: Candidate[] = [];
  for (const dim of DISCOVERY_DIMENSIONS) {
    if (isEventUnit(dim.unit)) continue;
    const unitRows = rows[dim.unit];
    const splits = splitsFor(dim, unitRows, minUnits);
    if (splits.length === 0) continue;
    const metrics = DISCOVERY_METRICS.filter((m) => m.unit === dim.unit && !EXCLUDED_PAIRS.has(`${dim.unit}|${dim.id}|${m.id}`));
    let corrWithS: number | null | undefined;
    if (dim.unit === 'game' && dim.kind === 'numeric' && dim.id !== 's') {
      const pairs = unitRows.filter((r) => typeof r.dims[dim.id] === 'number' && typeof r.dims.s === 'number');
      corrWithS = pearson(pairs.map((r) => r.dims[dim.id] as number), pairs.map((r) => r.dims.s as number));
    }
    // 一次掃過這個單位的列：每一類（類別）或每個三分位（數值）累加全部指標
    const buckets = new Map<string, Map<string, Acc>>();
    const total = new Map<string, Acc>();
    const numericSplit = dim.kind === 'numeric' ? splits[0] : null;
    const useStrata = corrWithS !== undefined;
    for (const r of unitRows) {
      const v = r.dims[dim.id];
      if (v === null || v === undefined) continue;
      const key = numericSplit ? (numericSplit.inA(v) ? 'A' : numericSplit.inB(v) ? 'B' : 'M') : String(v);
      let m = buckets.get(key);
      if (!m) {
        m = new Map();
        buckets.set(key, m);
      }
      const tier = useStrata ? sTier(r) : -1;
      accumulate(m, r, tier);
      if (!numericSplit) accumulate(total, r, tier);
    }
    for (const split of splits) {
      const accA = numericSplit ? buckets.get('A') : buckets.get(split.aLabel);
      if (!accA) continue;
      const accB = numericSplit ? buckets.get('B') : undefined;
      for (const metric of metrics) {
        const va = accA.get(metric.id);
        const vb = numericSplit ? accB?.get(metric.id) : minusAcc(total.get(metric.id), va);
        if (!va || !vb || va[2] < minUnits || vb[2] < minUnits) continue;
        let diff: number;
        let lo: number;
        let hi: number;
        let p: number;
        let effect: number;
        let aValue: number;
        let bValue: number;
        if (metric.kind === 'rate') {
          if (va[1] < minDen || vb[1] < minDen) continue;
          ({ diff, lo, hi, p } = twoProportion(va[0], va[1], vb[0], vb[1]));
          aValue = (100 * va[0]) / va[1];
          bValue = (100 * vb[0]) / vb[1];
          effect = cohenH(va[0] / va[1], vb[0] / vb[1]);
        } else {
          const w = welchFromSums(va, vb);
          ({ diff, lo, hi, p } = w);
          effect = w.d;
          aValue = va[3] / va[2];
          bValue = vb[3] / vb[2];
        }
        let withinS: number | null | undefined;
        if (useStrata) {
          let wsum = 0;
          let acc = 0;
          for (let t = 0; t < 3; t++) {
            const o = 5 + 4 * t;
            const [ka, na, ua, sa] = [va[o], va[o + 1], va[o + 2], va[o + 3]];
            const [kb, nb, ub, sb] = [vb[o], vb[o + 1], vb[o + 2], vb[o + 3]];
            if (ua < 10 || ub < 10 || na === 0 || nb === 0) continue;
            const d = metric.kind === 'rate' ? 100 * (ka / na - kb / nb) : sa / ua - sb / ub;
            const w = Math.min(ua, ub);
            acc += d * w;
            wsum += w;
          }
          withinS = wsum > 0 ? acc / wsum : null;
        }
        candidates.push({
          id: `${dim.unit}|${dim.id}|${split.aLabel}|${metric.id}`,
          unit: dim.unit, dimension: dim, metric,
          a: { label: split.aLabel, value: aValue, n: metric.kind === 'rate' ? va[1] : va[2], units: va[2] },
          b: { label: split.bLabel, value: bValue, n: metric.kind === 'rate' ? vb[1] : vb[2], units: vb[2] },
          diff, lo, hi, p, effect, corrWithS, withinS, grouping: split.grouping,
        });
      }
    }
  }
  return {
    minUnits, minDen, games: games.slice(), candidates,
    units: Object.fromEntries((Object.keys(rows) as GameUnit[]).map((k) => [k, rows[k].length])) as Record<GameUnit, number>,
  };
}

/** 掃描全部維度 × 指標，回傳 FDR 顯著、依效果量排序的發現。options.base = 同一批局先算好的 discoveryBase（可省略）。 */
export function discoverFindings(games: readonly Game[], options: DiscoveryOptions = {}): DiscoveryResult {
  const minUnits = options.minUnits ?? 30;
  const minDen = options.minDen ?? 30;
  const fdr = options.fdr ?? 0.05;
  const limits: EventLimits = { minUnits, minDen, minGames: options.minGames ?? 20, minPlayers: options.minPlayers ?? 10 };
  const cuts = options.cuts ?? DEFAULT_COHORT_CUTS;
  const given = options.base;
  const sameGames = (x: readonly Game[]): boolean => x.length === games.length && x.every((g, i) => g === games[i]);
  const base = given && given.minUnits === minUnits && given.minDen === minDen && sameGames(given.games)
    ? given : discoveryBase(games, { minUnits, minDen });
  const rows: Record<EventUnit, Row[]> = { twoRed: [], decisive: [], blueVote: [] };
  for (const g of games) {
    const e = cachedEventUnits(g, cuts);
    for (const key of EVENT_UNITS) for (const r of e[key]) rows[key].push(r);
  }
  const candidates: Candidate[] = [...base.candidates];
  for (const dim of DISCOVERY_DIMENSIONS) {
    if (!isEventUnit(dim.unit)) continue;
    const unitRows = rows[dim.unit];
    const splits = splitsFor(dim, unitRows, minUnits);
    if (splits.length === 0) continue;
    const metrics = DISCOVERY_METRICS.filter((m) => m.unit === dim.unit && !EXCLUDED_PAIRS.has(`${dim.unit}|${dim.id}|${m.id}`));
    candidates.push(...clusteredCandidates(dim, unitRows, splits, metrics, limits));
  }
  const qs = benjaminiHochberg(candidates.map((c) => c.p));
  // 兩個維度切出完全一樣的組（例：第 5 輪 = 比分 2：2）只留第一個
  const seen = new Set<string>();
  const findings = candidates
    .map((c, i) => ({ ...c, q: qs[i] }))
    .filter((f) => f.q <= fdr)
    .sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect))
    .filter((f) => {
      const key = `${f.unit}|${f.metric.id}|${f.a.n}|${f.b.n}|${f.a.value.toFixed(6)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // 比分跟局勢（任務順序）都有差異時，只留局勢那一層的（同一個單位、同一個指標、比分相同的順序）
  const seqScores = new Set(findings.filter((f) => f.dimension.id === 'sequence').map((f) => `${f.unit}|${f.metric.id}|${scoreOfSequence(f.a.label)}`));
  // 事件單位的角色只有梅林／派西維爾／忠臣三類：「忠臣 vs 其他」幾乎是「梅林 vs 其他」的鏡像，梅林那一項有列就不重複
  const merlinRole = new Set(findings.filter((f) => isEventUnit(f.unit) && f.dimension.role && f.a.label === '梅林').map((f) => `${f.unit}|${f.metric.id}`));
  const kept = findings.filter((f) => (f.dimension.id !== 'score' || !seqScores.has(`${f.unit}|${f.metric.id}|${f.a.label}`))
    && !(isEventUnit(f.unit) && f.dimension.role && f.a.label === '忠臣' && merlinRole.has(`${f.unit}|${f.metric.id}`)));
  for (const f of kept) {
    if (!isEventUnit(f.unit)) continue;
    const strategy = buildStrategy(f);
    if (strategy) f.strategy = strategy;
  }
  return {
    tests: candidates.length,
    units: { ...base.units, ...Object.fromEntries(EVENT_UNITS.map((k) => [k, rows[k].length])) } as Record<DiscoveryUnit, number>,
    findings: kept,
  };
}

/** 任務順序（例：藍紅紅）→ 比分的寫法（藍 1：紅 2）。 */
export function scoreOfSequence(seq: string): string {
  const blue = [...seq].filter((c) => c === '藍').length;
  const red = [...seq].filter((c) => c === '紅').length;
  return `藍 ${blue}：紅 ${red}`;
}

/** 發現跟哪些分析分頁有關（指標的分頁；陣容維度另外算在陣容強度）。 */
export function findingPages(f: DiscoveryFinding): DiscoveryPage[] {
  const pages = new Set<DiscoveryPage>(f.metric.pages);
  if (f.dimension.lineup) pages.add('strength'); else if (f.unit === 'game') pages.delete('strength');
  if (f.unit === 'seat' && f.dimension.id === 'seat') pages.add('position');
  return [...pages];
}
