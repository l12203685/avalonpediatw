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
 */
import { OUTCOME_BLUE_ALIVE, OUTCOME_BLUE_DEAD, OUTCOME_THREE_RED, RED_ROLES, SEATS, isFinalWin } from './constants';
import type { Game } from './dataset';
import { deriveLeaderSeats } from './mistakes';
import {
  STRENGTH_DIMENSIONS, STRENGTH_METRICS, gameInfo, quantileSorted, type Facts, type StrengthGrouping,
} from './strength';

export type DiscoveryUnit = 'game' | 'proposal' | 'mission' | 'lake' | 'seat';
export type DiscoveryPage = 'overview' | 'teams' | 'votes' | 'missions' | 'lake' | 'assassination' | 'position' | 'roles' | 'strength';

export const UNIT_LABELS: Record<DiscoveryUnit, string> = {
  game: '局', proposal: '提議', mission: '任務', lake: '湖中女神', seat: '座位',
};

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
}

export interface DiscoveryMetric {
  id: string;
  unit: DiscoveryUnit;
  label: string;
  help: string;
  kind: 'rate' | 'avg';
  pages: DiscoveryPage[];
}

interface Row {
  dims: Record<string, number | string | null>;
  metrics: Facts;
}

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

const units = new WeakMap<Game, Record<DiscoveryUnit, Row[]>>();

/** 一局拆成五種單位的列（快取）。 */
export function gameUnits(g: Game): Record<DiscoveryUnit, Row[]> {
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
  const out: Record<DiscoveryUnit, Row[]> = { game: [], proposal: [], mission: [], lake: [], seat: [] };

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
}

export interface DiscoveryOptions {
  /** 每組至少幾個單位、比率的分母至少多少。 */
  minUnits?: number;
  minDen?: number;
  /** q 值門檻。 */
  fdr?: number;
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

/** 掃描全部維度 × 指標，回傳 FDR 顯著、依效果量排序的發現。 */
export function discoverFindings(games: readonly Game[], options: DiscoveryOptions = {}): DiscoveryResult {
  const minUnits = options.minUnits ?? 30;
  const minDen = options.minDen ?? 30;
  const fdr = options.fdr ?? 0.05;
  const rows: Record<DiscoveryUnit, Row[]> = { game: [], proposal: [], mission: [], lake: [], seat: [] };
  for (const g of games) {
    const u = gameUnits(g);
    for (const key of Object.keys(rows) as DiscoveryUnit[]) rows[key].push(...u[key]);
  }
  // 陣容維度的 S 三分層（控制 S 用）
  const sValues = rows.game.map((r) => r.dims.s).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const sCuts = sValues.length >= 9 ? [quantileSorted(sValues, 1 / 3), quantileSorted(sValues, 2 / 3)] : null;
  const sTier = (r: Row): number => {
    const s = r.dims.s;
    if (typeof s !== 'number' || !sCuts) return -1;
    return s < sCuts[0] ? 0 : s < sCuts[1] ? 1 : 2;
  };

  const candidates: Array<Omit<DiscoveryFinding, 'q'>> = [];
  for (const dim of DISCOVERY_DIMENSIONS) {
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
  const kept = findings.filter((f) => f.dimension.id !== 'score' || !seqScores.has(`${f.unit}|${f.metric.id}|${f.a.label}`));
  return {
    tests: candidates.length,
    units: Object.fromEntries((Object.keys(rows) as DiscoveryUnit[]).map((k) => [k, rows[k].length])) as Record<DiscoveryUnit, number>,
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
