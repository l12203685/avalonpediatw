/**
 * 對手類型的策略層（第 56b 回合 C；站長 2026-11-20）。
 *
 * 站長原話：
 * >「真人桌另一套：跟真人打的百科AI 用真人牌局當標準，自己對打只當參考」
 * >「因為你可能越來越強 所以接下來不一定要以真人為標準 可以參考真人強者 但也記得要針對角色 另外…未來你可能也會對上不同強度的人
 * >  也可能需要自行調整策略 所以對上 AI/弱真人/一般真人/強真人 你都可能會需要做調整 但不會過度 就是還是有一條基準線」
 *
 * 做法：一條基準線（`DEFAULT_AGENT_TUNING` ＋ 環境變數 = 自我對打量的那一套），每一種對手只在上面加**少數幾個**開關（`PROFILE_OVERRIDES`）。
 * - `ai`（對手是機器人、自我對打）= 基準線本身，不加任何東西。
 * - `weakHuman`／`avgHuman`／`strongHuman` = 基準線＋真人桌的讀法。判準是真人局的準確度（分角色，`scripts/humanProfileStudy.ts`），
 *   自我對打只當參考（docs/ai/optimization_loop.md 第 1 節「真人桌的改法」）。
 * - 可以改的開關只限 `PROFILE_KEYS`（讀人的信念，藍方座位才用），避免一個對手類型長成另一套策略；測試會檢查。
 *
 * 怎麼判斷對手類型（`opponentTypeOfTable`）：桌上沒有真人 → `ai`；有真人、知道桌上強度 S（網站「陣容強度」= 10 人開打前 PR 的平均）
 * → 照網站數據分析的分組切點（`DEFAULT_COHORT_CUTS`：S < 38 弱、38–55 一般、≥ 55 強）；不知道 S → `avgHuman`。
 * 開打時的 S 由 `tableStrength.ts` 從桌上真人的網站 Elo PR 算（網站房間、練習台補位都接上了）。
 */
import { DEFAULT_COHORT_CUTS } from '@avalon/shared/stats';
import { getDefaultAgentTuning, type AgentTuning, type AgentTuningKey } from './AgentTuning';

export type OpponentType = 'ai' | 'weakHuman' | 'avgHuman' | 'strongHuman';
export type StrengthTier = 'weak' | 'avg' | 'strong';

export const OPPONENT_TYPES: readonly OpponentType[] = ['ai', 'weakHuman', 'avgHuman', 'strongHuman'];

/** 中文名稱（log、說明用）。 */
export const OPPONENT_LABEL: Readonly<Record<OpponentType, string>> = {
  ai: 'AI（自我對打標準）',
  weakHuman: '弱真人桌',
  avgHuman: '一般真人桌',
  strongHuman: '強真人桌',
};

/** 真人桌可以偏離基準線的開關（只有讀人的信念）。 */
export const PROFILE_KEYS: readonly AgentTuningKey[] = ['copyDiscount55', 'copyRepeat55b', 'copyFreq55b', 'viewpoint53', 'viewpointPow53'];

/**
 * 真人桌的讀法（第 56b 回合 C；`scripts/humanProfileStudy.ts`，真人局 2,241 局、156 萬個點，逐角色 × 逐強度層）：
 * - 照派的提議（被否決、非強制、整隊包含最近一次乾淨成功任務隊）以 1 − 0.75 的權重讀（`copyDiscount55=0.75`）。真人的照派幾乎不帶資訊
 *   （第 55b 回合：第 2 局好人照派的概似比約 1.25），機器人忠臣只在自己後驗說乾淨時才照派，所以自我對打量不到好處（第 55、55b 回合）。
 *   四種寫法（0.75、1、照派只算一次、只算一次＋照派頻率）裡 0.75 的 Brier 最好，而且忠臣／派西／梅林 × 弱／一般／強九格沒有一格變差。
 * - 隊長視角讀法（`viewpoint53`／`viewpointPow53`，第 53b 回合 V3P）不用：它在真人局的 Brier 變差（全部 +1.3e-4，強桌 +13.3e-4、派西・強桌 +23.7e-4），
 *   基準線就算為了自我對打勝率採用了它，真人桌也照舊不讀。
 */
const HUMAN_READING: Readonly<Partial<AgentTuning>> = { copyDiscount55: 0.75, viewpoint53: 0, viewpointPow53: 0 };

export const PROFILE_OVERRIDES: Readonly<Record<OpponentType, Readonly<Partial<AgentTuning>>>> = {
  ai: {},
  weakHuman: HUMAN_READING,
  avgHuman: HUMAN_READING,
  strongHuman: HUMAN_READING,
};

/** 桌上強度 S → 網站數據分析「分組」的三層（S < sLo 弱、sLo ≤ S < sHi 一般、≥ sHi 強；預設 38／55）。 */
export function strengthTierOfS(s: number, cuts: { sLo: number; sHi: number } = DEFAULT_COHORT_CUTS): StrengthTier {
  if (s >= cuts.sHi) return 'strong';
  if (s >= cuts.sLo) return 'avg';
  return 'weak';
}

/**
 * 這一桌的對手類型。`humans` = 桌上真人的人數（不含百科AI 自己與其他機器人）；`tableS` = 桌上強度 S（不知道給 null／不給）。
 */
export function opponentTypeOfTable(table: { humans: number; tableS?: number | null }): OpponentType {
  if (table.humans <= 0) return 'ai';
  const s = table.tableS;
  if (typeof s !== 'number' || !Number.isFinite(s)) return 'avgHuman';
  const tier = strengthTierOfS(s);
  return tier === 'weak' ? 'weakHuman' : tier === 'strong' ? 'strongHuman' : 'avgHuman';
}

/** 基準線（預設＋環境變數，或傳進來的 base）加上這個對手類型的開關。 */
export function tuningForOpponent(type: OpponentType, base: Readonly<AgentTuning> = getDefaultAgentTuning()): AgentTuning {
  return { ...base, ...PROFILE_OVERRIDES[type] };
}

/** 文字名稱（命令列、環境變數）→ 對手類型；認不得回 null。接受 ai／weak／avg／strong 與完整名稱。 */
export function parseOpponentType(raw: string | undefined | null): OpponentType | null {
  const x = (raw ?? '').trim().toLowerCase();
  if (x === 'ai' || x === 'bot' || x === 'selfplay') return 'ai';
  if (x === 'weak' || x === 'weakhuman') return 'weakHuman';
  if (x === 'avg' || x === 'avghuman' || x === 'human') return 'avgHuman';
  if (x === 'strong' || x === 'stronghuman') return 'strongHuman';
  return null;
}
