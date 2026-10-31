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
  | { kind: 'weakLoyal'; pr: number };

export interface StrengthGroupDef {
  id: string;
  label: string;
  help: string;
}

interface GameCtx {
  g: Game;
  strength: RoleStrength | null;
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
    default: {
      const never: never = grouping;
      throw new Error(`unknown grouping ${(never as { kind: string }).kind}`);
    }
  }
}

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

export const METRIC_SECTIONS = ['陣容', '結果', '派隊與任務', '投票', '紅方出牌', '湖中女神', '失誤標籤'] as const;

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
  { id: 'threePlusOne', section: '派隊與任務', label: '首輪成功後三加一', help: '第 1 輪任務成功的局裡，第 2 輪出任務的 4 人隊包含第 1 輪那 3 人的比例（其餘是拆車）', kind: 'rate' },
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
  ...MISTAKE_TAGS.map((tag) => ({
    id: `mistake:${tag}`, section: '失誤標籤', label: tag,
    help: `有「${tag}」的局 ÷ 全部局（定義同牌譜紀錄的失誤標籤）`, kind: 'rate' as const,
  })),
];

/** [分子, 分母]。 */
type Facts = Map<string, [number, number]>;

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

  // 失誤標籤
  if (rolesKnown && decided) {
    const tags = new Set(gameMistakes(g).map((m) => m[0]));
    for (const tag of MISTAKE_TAGS) add(f, `mistake:${tag}`, tags.has(tag) ? 1 : 0);
  }
  return f;
}

// ── 報告 ───────────────────────────────────────────────

export interface StrengthPoint {
  id: string;
  date: string;
  outcome: string;
  s: number;
  /** 桌上 10 人賽前 Elo 的最低／中位／平均／最高；沒有座位 Elo 的舊資料 = null。 */
  elo: { min: number; median: number; mean: number; max: number } | null;
}

export interface OutcomeTally {
  n: number;
  threeRed: number;
  blueDead: number;
  blueAlive: number;
}

export interface HeatCell extends OutcomeTally {
  quarter: string;
  bin: string;
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
  quarters: string[];
  heatmap: HeatCell[];
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

/** YYYY-MM-DD → 2024Q3。 */
export function quarterOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
}

/** 每局的角色強度與指標貢獻跟分組方式無關：同一份解碼的局換分組時不用重算（失誤偵測最花時間）。 */
const perGame = new WeakMap<Game, { strength: RoleStrength | null; facts: Facts }>();

function gameInfo(g: Game): { strength: RoleStrength | null; facts: Facts } {
  let hit = perGame.get(g);
  if (!hit) {
    const strength = g.lineup ? roleStrength(g.lineup, gameSeats(g)) : null;
    hit = { strength, facts: gameFacts(g, strength) };
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
        elo: elos ? {
          min: Math.min(...elos), median: median(elos), mean: elos.reduce((a, b) => a + b, 0) / elos.length, max: Math.max(...elos),
        } : null,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const cells = new Map<string, Game[]>();
  const quarters = new Set<string>();
  for (const g of scored) {
    if (!g.timelineDate || !decided(g)) continue;
    const q = quarterOf(g.timelineDate);
    const bin = S_BINS.find((b) => g.lineup!.s >= b.min && g.lineup!.s < b.max)!;
    quarters.add(q);
    const key = `${q}|${bin.id}`;
    cells.set(key, [...(cells.get(key) ?? []), g]);
  }
  const heatmap: HeatCell[] = [...cells.entries()].map(([key, list]) => {
    const [quarter, bin] = key.split('|');
    return { quarter, bin, ...tally(list) };
  });

  const tiers = S_TIERS.map((t) => ({
    id: t.id, label: t.label, range: t.range,
    ...tally(scored.filter((g) => g.lineup!.s >= t.min && g.lineup!.s < t.max)),
  }));

  // 分組比較
  const def = groupingDef(grouping);
  const sums: Facts[] = def.groups.map(() => new Map());
  const all: Facts = new Map();
  const counts = def.groups.map(() => 0);
  let excluded = 0;
  for (const g of games) {
    const { strength, facts } = gameInfo(g);
    const i = def.classify({ g, strength });
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
    quarters: [...quarters].sort(),
    heatmap,
    overall: tally(scored),
    tiers,
    comparison: {
      groups: def.groups.map((gr, i) => ({ ...gr, games: counts[i] })),
      excluded,
      metrics: STRENGTH_METRICS.map((m) => ({ ...m, values: sums.map((s) => value(s, m)), all: value(all, m) })),
    },
  };
}
