/**
 * 自動發現的「可能的策略」（Edward 2026-11-11）：每一項新資料（兩紅之後的派隊、關鍵票、全部投票）的發現，用跟指標與
 * 維度綁在一起的範本寫一句白話的策略。
 *
 *   一律標成假設：觀察資料，相關不是因果（STRATEGY_HYPOTHESIS）；只寫組名（強者／新手、高端桌…），不寫任何玩家。
 *   不給策略的情況（suppressed，畫面上寫原因；卡片照樣列）：
 *     small      差距的絕對值不到 STRATEGY_MIN_DIFF 個百分點（顯著但太小，照做也看不出差別）
 *     role       維度就是角色（梅林看得到拇指、派西看得到梅林／莫甘娜：角色本身的資訊差，不是策略），或在同一個角色
 *                裡比（依角色分層、樣本加權平均的差 withinRole）時差距不到門檻或方向相反 → 差異是角色組成造成的；
 *                withinRole 算不出來（沒有一個角色兩邊都有 10 列）也不給：沒辦法排除是角色造成的
 *     structure  遊戲結構的維度（座位、第幾局、第幾次提議、局勢、紅方已兩勝）：差異多半來自規則與資訊狀態（隊長座位跟著
 *                輪替走、各局隊伍人數不同；第 4 局單紅的票是中性、不算對錯，跟第 3、5 局的對率不是同一把尺），不是可以照做的線索
 *     direction  強者 vs 新手，但強者在不好的方向（例：強者的關鍵外白對率反而比較低）：沒有可以照做的方向
 *     neutral    這個分類本身沒有好壞（第 4 局只含一拇指：一張失敗不會紅）
 *     context    八格（四組 × 對／錯）各佔關鍵票的比例：任何維度都不給。佔比跟那一組人多常在隊上、各種隊伍出現的多寡
 *                一起變（例：強者比較常被派上隊，「在隊上放行全好」的佔比自然比較高），不是做法的差；做法看四組的對率
 *   範本（只剩兩種維度會給）：
 *     做事的人的分組（強者 vs 新手）→「強者在兩紅後第 4 局比較常派最多一紅的隊（80% vs 新手 56%）→ 第 4 局可以優先找…」
 *     桌的分組（高端 vs 歡樂）→ 描述性的讀法：「在高端桌，… → 在高端桌，隊上比較常有拇指，投票前多檢查一次」
 */
import type { DiscoveryFinding } from './discovery';
import type { EventUnit } from './discoveryEvents';

/** 給策略的最小差距（百分點，絕對值）。 */
export const STRATEGY_MIN_DIFF = 5;
/** 策略一律附上的標示。 */
export const STRATEGY_HYPOTHESIS = '假設：來自觀察資料，相關不是因果';

export type StrategySuppressed = 'small' | 'role' | 'structure' | 'direction' | 'neutral' | 'context';

export interface DiscoveryStrategy {
  /** 策略那一句（不給 = null）。 */
  text: string | null;
  suppressed?: StrategySuppressed;
  /** 不給的原因（白話）。 */
  reason?: string;
}

interface Template {
  /** share：某種做法的比例（「比較常／比較少」）；accuracy：做對的比例（「比較高／低」）。 */
  kind: 'share' | 'accuracy';
  /** 範圍的前綴（例：第 4 局）。 */
  scope?: string;
  /** share：做法（「派最多一紅的隊」）；accuracy：名詞（「關鍵外白對率」）。 */
  phrase: string;
  /** 哪個方向對藍方比較好；null = 本身沒有好壞。 */
  better: 'higher' | 'lower' | null;
  /** 照做的建議（往好的方向）。 */
  act: string;
  /** 情境（桌的分組）的讀法：這個情境下數字比較高／比較低時（描述性，不宣稱沒量到的事）。 */
  readHigh?: string;
  readLow?: string;
  /** 八格的佔比：任何維度都不給策略。 */
  cell?: boolean;
}

const DECISIVE_ACT = {
  onYes: '在隊上投贊成前，先確認同隊的人都可信',
  onNo: '在隊上投反對（內黑）要有根據：確定同隊有紅方才擋',
  offYes: '不在隊上投贊成（外白）要有把握：只放行你確定全好的隊',
  offNo: '不在隊上時，看到可疑的隊就投反對擋下',
} as const;
const DECISIVE_READ = {
  onYes: ['藍方在隊上投贊成時，隊伍比較常全好', '藍方在隊上投贊成時，隊伍比較常其實有紅，投票前多檢查一次'],
  onNo: ['藍方內黑時，隊上比較常真的有紅', '藍方內黑時，比較常擋到全好的隊'],
  offYes: ['藍方外白時，隊伍比較常全好', '藍方外白時，比較常放行會失敗的隊，投票前多檢查一次'],
  offNo: ['藍方在場外投反對時，比較常擋對', '藍方在場外投反對時，比較常擋到全好的隊'],
} as const;
const GROUP_NOUN = { onYes: '場內白', onNo: '內黑', offYes: '外白', offNo: '場外黑' } as const;

/** 八格的名詞（只用在 cell 範本；八格不給策略）。 */
const CELL_PHRASE: Record<string, string> = {
  onYesRight: '在關鍵時在隊上放行全好的隊', onYesWrong: '在關鍵時在隊上放行會失敗的隊',
  onNoRight: '在關鍵時內黑擋下會失敗的隊', onNoWrong: '在關鍵時內黑擋下全好的隊',
  offYesRight: '在關鍵時外白放行全好的隊', offYesWrong: '在關鍵時外白放行會失敗的隊',
  offNoRight: '在關鍵時在場外擋下會失敗的隊', offNoWrong: '在關鍵時在場外擋下全好的隊',
};

const TEMPLATES: Record<string, Template> = {
  'twoRed|allGood': {
    kind: 'share', phrase: '派全好的隊', better: 'higher', act: '兩紅之後當隊長，優先派全好（沒有紅方）的隊',
    readHigh: '藍方隊長兩紅後的隊比較常全好', readLow: '藍方隊長兩紅後的隊比較常混到紅方，投票前多檢查一次',
  },
  'twoRed|mordred': {
    kind: 'share', phrase: '派到莫德雷德（隊上沒有拇指）', better: 'lower', act: '隊上沒有拇指時仍可能有莫德雷德（梅林看不到他），派隊時別只看有沒有拇指',
    readHigh: '沒有拇指的隊比較常有莫德雷德，投票前多檢查一次', readLow: '沒有拇指的隊比較少有莫德雷德',
  },
  'twoRed|thumb': {
    kind: 'share', scope: '第 3、5 局', phrase: '派到拇指', better: 'lower', act: '第 3、5 局一張失敗就輸：派隊時多留意誰可能是拇指（刺客、莫甘娜、奧伯倫）',
    readHigh: '隊上比較常有拇指，投票前多檢查一次', readLow: '隊上比較少有拇指',
  },
  'twoRed|oneThumb': { kind: 'share', scope: '第 4 局', phrase: '派只含一拇指的隊', better: null, act: '' },
  'twoRed|r4Safe': {
    kind: 'share', scope: '第 4 局', phrase: '派最多一紅的隊', better: 'higher', act: '第 4 局可以優先找最多一紅、出任務一定成功的隊',
    readHigh: '第 4 局的隊比較常最多一紅（一張失敗不會紅）', readLow: '第 4 局的隊比較常有兩個以上紅方，放行前多想',
  },
  'decisive|acc': {
    kind: 'accuracy', phrase: '關鍵票正確率', better: 'higher', act: '剛好差一票的時候，先確認隊伍全好才放行、有紅才擋',
    readHigh: '藍方的關鍵票比較常投對', readLow: '藍方的關鍵票比較常投錯，投票前多想一次',
  },
  'blueVote|acc': {
    kind: 'accuracy', phrase: '投票正確率', better: 'higher', act: '每一票都照「全好就放行、有紅就擋」投，不要照習慣投',
    readHigh: '藍方的票比較常投對', readLow: '藍方的票比較常投錯，投票前多想一次',
  },
};
for (const g of ['onYes', 'onNo', 'offYes', 'offNo'] as const) {
  TEMPLATES[`decisive|${g}`] = {
    kind: 'accuracy', phrase: `關鍵${GROUP_NOUN[g]}對率`, better: 'higher', act: DECISIVE_ACT[g], readHigh: DECISIVE_READ[g][0], readLow: DECISIVE_READ[g][1],
  };
  TEMPLATES[`blueVote|${g}`] = {
    kind: 'accuracy', phrase: `${GROUP_NOUN[g]}對率`, better: 'higher', act: DECISIVE_ACT[g], readHigh: DECISIVE_READ[g][0], readLow: DECISIVE_READ[g][1],
  };
}
for (const [id, phrase] of Object.entries(CELL_PHRASE)) TEMPLATES[`decisive|${id}`] = { kind: 'share', phrase, better: null, act: '', cell: true };

/** 這個指標有沒有策略範本。 */
export function hasStrategyTemplate(unit: string, metricId: string): boolean {
  return `${unit}|${metricId}` in TEMPLATES;
}

const pct = (v: number): string => `${Math.round(v)}%`;

/** 組在句子裡的寫法：桌的組加「桌」、其他類 =「其他情況」。 */
function groupName(dimId: string, label: string): string {
  if (label === '其他') return '其他情況';
  if (dimId === 'tableTier') return `${label}桌`;
  return label;
}

/** 情境的前綴（在高端桌…）；結構性的維度不會走到這裡。 */
function context(dimId: string, label: string): string {
  return dimId === 'tableTier' ? `在${label}桌` : `${label}時`;
}

/**
 * 一項事件單位的發現 → 策略（或不給的原因）。withinRole = 依角色分層後的差（百分點；null = 算不出來）。
 */
export function buildStrategy(f: Pick<DiscoveryFinding, 'unit' | 'dimension' | 'metric' | 'a' | 'b' | 'diff' | 'withinRole'>): DiscoveryStrategy | undefined {
  const t = TEMPLATES[`${f.unit}|${f.metric.id}`];
  if (!t) return undefined;
  const unit = f.unit as EventUnit;
  const dim = f.dimension;
  if (t.cell) {
    return { text: null, suppressed: 'context', reason: '八格的佔比跟這組人多常在隊上、各種隊伍出現的多寡一起變，不是做法的差（做法看四組的對率）' };
  }
  if (t.better === null) return { text: null, suppressed: 'neutral', reason: '這個分類本身沒有好壞（第 4 局只含一拇指：一張失敗不會紅）' };
  if (Math.abs(f.diff) < STRATEGY_MIN_DIFF) return { text: null, suppressed: 'small', reason: `差距不到 ${STRATEGY_MIN_DIFF} 個百分點` };
  if (dim.role) return { text: null, suppressed: 'role', reason: '角色本身的資訊差（梅林看得到拇指、派西看得到梅林／莫甘娜），不是可以照做的策略' };
  if (dim.structural) {
    return { text: null, suppressed: 'structure', reason: '遊戲結構造成的差異（座位跟著隊長輪替、各局隊伍人數不同、第 4 局單紅的票不算對錯），不是可以照做的線索' };
  }
  const w = f.withinRole;
  if (typeof w !== 'number') return { text: null, suppressed: 'role', reason: '樣本不夠在同一個角色裡比，沒辦法排除差異是角色組成造成的' };
  if (Math.abs(w) < STRATEGY_MIN_DIFF || Math.sign(w) !== Math.sign(f.diff)) {
    return { text: null, suppressed: 'role', reason: `在同一個角色裡比，差距只剩 ${w > 0 ? '+' : w < 0 ? '−' : '±'}${Math.abs(w).toFixed(0)} 個百分點：差異多半是角色組成造成的` };
  }
  const higher = f.diff > 0;
  const aName = groupName(dim.id, f.a.label);
  const bName = groupName(dim.id, f.b.label);
  const nums = `（${pct(f.a.value)} vs ${bName} ${pct(f.b.value)}）`;
  const scope = t.scope ?? '';
  if (dim.skill) {
    const good = (t.better === 'higher') === higher;
    if (!good) return { text: null, suppressed: 'direction', reason: `${aName}反而在不好的方向，沒有可以照做的策略` };
    const where = unit === 'twoRed' ? `在兩紅後${scope}` : scope;
    const what = t.kind === 'share'
      ? `${aName}${where}${higher ? '比較常' : '比較少'}${t.phrase}`
      : `${aName}${where}的${t.phrase}比較${higher ? '高' : '低'}`;
    return { text: `${what}${nums} → ${t.act}` };
  }
  const ctx = context(dim.id, f.a.label);
  const subject = unit === 'twoRed' ? `藍方隊長兩紅後${scope}` : scope;
  const what = t.kind === 'share'
    ? `${ctx}，${subject}${higher ? '比較常' : '比較少'}${t.phrase}`
    : `${ctx}，藍方${subject}的${t.phrase}比較${higher ? '高' : '低'}`;
  const read = higher ? t.readHigh : t.readLow;
  return { text: read ? `${what}${nums} → ${ctx}，${read}` : `${what}${nums}` };
}

/** 畫面上的一整行：「可能的策略（假設：…）：…」。 */
export function strategyLine(s: DiscoveryStrategy): string | null {
  return s.text ? `可能的策略（${STRATEGY_HYPOTHESIS}）：${s.text}` : null;
}
