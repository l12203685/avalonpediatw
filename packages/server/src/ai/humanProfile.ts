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
 * - 三種真人桌共用一組讀法（`HUMAN_READING`），各層只在上面做小調整（第 57 回合：每層最多一個開關、偏離最多 0.1；`TIER_MAX_KEYS`／`TIER_MAX_STEP`）。
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

/**
 * 真人桌可以偏離基準線的開關：讀人的信念（只給藍方座位），加上第 58 回合一個梅林派隊的開關 `merlinOwnRank58`——
 * 站長 2026-11-20 的裁定本身就是這條派法（「要從公開資訊中找到符合自己內建資訊」），真人局重播（梅林的提議、人類 PR 量尺兩半）都沒有一層變差。
 */
export const PROFILE_KEYS: readonly AgentTuningKey[] = ['copyDiscount55', 'copyRepeat55b', 'copyFreq55b', 'viewpoint53', 'viewpointPow53', 'blueVoteTemper57', 'missionRole56', 'merlinOwnRank58'];

/**
 * 「不會過度」（第 57 回合）：三種真人桌共用 `HUMAN_READING`，每一層最多再改 `TIER_MAX_KEYS` 個開關、每個開關最多偏離共用值 `TIER_MAX_STEP`
 * （測試檢查）。分層只做小調整，不讓某一層長成另一套。
 */
export const TIER_MAX_KEYS = 1;
export const TIER_MAX_STEP = 0.1;

/**
 * 真人桌的讀法（三種真人桌共用；第 56b 回合 C、第 57 回合；`scripts/humanProfileStudy.ts`，真人局 2,241 局，逐角色 × 逐強度層）：
 * - 照派的提議（被否決、非強制、整隊包含最近一次乾淨成功任務隊）以 1 − 0.75 的權重讀（`copyDiscount55=0.75`）。真人的照派幾乎不帶資訊
 *   （第 55b 回合：第 2 局好人照派的概似比約 1.25），機器人忠臣只在自己後驗說乾淨時才照派，所以自我對打量不到好處（第 55、55b 回合）。
 *   第 57 回合分層再量（偶數局擬合、奇數局驗證）：弱桌改 0.9／1、強桌改 0.5 在擬合的一半變好、驗證的一半變差，所以三層照舊 0.75。
 * - 隊長視角讀法（`viewpoint53`／`viewpointPow53`，第 53b 回合 V3P）不用：真人局的 Brier 變差（強桌、派西最多）。第 57 回合試了只開一部分（次方 0.1／0.25），每一層都比不讀差。
 * - 讀「票」的次方 0.4（`blueVoteTemper57`；基準線 `beliefTemper=73` 的投票那一半是 0.7，派隊那一半 0.3 不變；只給藍方座位）：第 57 回合，
 *   真人的票比基準線讀的少帶資訊——驗證的一半全部 ΔBrier −14.7e-4，弱／一般／強／S 不明 × 忠臣／派西／梅林每一格都變好。
 * - 任務牌分有沒有奧伯倫（`missionRole56=1`，第 56 回合；只給藍方座位）：第 57 回合，擬合 −1.8e-4、驗證 −1.2e-4（都約 2.5 個標準誤），
 *   每一層都沒有角色變差超過雜訊；人類 PR 量尺不變（+0.03 ± 0.02 pp／座位局）。
 * - 梅林在公開上說得通的乾淨隊裡先比自己的乾淨機率（`merlinOwnRank58=0.5`，第 58 回合；站長 11/20「要從公開資訊中找到符合自己內建資訊」）：
 *   真人梅林 3,465 個提議重播 Jaccard +0.006 ± 0.006、全好隊 +1.8pp，沒有一層變差；人類 PR 量尺梅林 +0.69 ± 0.18 pp／座位局（偶數局 +0.60、奇數局 +0.77），
 *   各層兩半都在 2 個標準誤內；網站 Room-17（2026-11-20）3-5 梅林不再派帶莫德雷德的隊。自我對打 −0.36（刺客讀得到），所以基準線不用。
 */
const HUMAN_READING: Readonly<Partial<AgentTuning>> = { copyDiscount55: 0.75, viewpoint53: 0, viewpointPow53: 0, blueVoteTemper57: 0.4, missionRole56: 1, merlinOwnRank58: 0.5 };

/**
 * 分層的小調整（第 57 回合；每層最多一個開關、偏離共用值最多 0.1）：
 * - 弱真人桌：讀票的次方退回一格到 0.5。0.4 的 Brier 在弱桌也變好，但人類 PR 量尺（決策層）弱桌兩半都偏負（−0.38／−0.25 pp／座位局）；
 *   0.5 量尺中性（−0.11 ± 0.12），Brier 驗證 −9.9e-4、三個角色都變好。
 * - 強真人桌：讀票的次方再低一格到 0.3。強桌的票最不帶資訊（擬合 0.4 → 0.3 再 −5.7e-4；0.2、0.1 還在變好，但超過一格不做）；
 *   驗證 0.3 比 0.4 再好 −3.1e-4，忠臣／派西／梅林都比 0.4 好；量尺和 0.4 一樣（+0.08 ± 0.11）。
 * - 一般真人桌（S 讀不到的桌也是這一層）：共用的 0.4。
 */
export const PROFILE_OVERRIDES: Readonly<Record<OpponentType, Readonly<Partial<AgentTuning>>>> = {
  ai: {},
  weakHuman: { ...HUMAN_READING, blueVoteTemper57: 0.5 },
  avgHuman: HUMAN_READING,
  strongHuman: { ...HUMAN_READING, blueVoteTemper57: 0.3 },
};

/** 三種真人桌共用的讀法（測試、說明用）。 */
export const HUMAN_TABLE_READING: Readonly<Partial<AgentTuning>> = HUMAN_READING;

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
