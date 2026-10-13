/**
 * AgentTuning — 機器人 AI 的可調開關（2026-10-12）。
 *
 * `docs/ai/agreement_benchmark.md` 第 7 節列出四個「讓 agent 更像真人」
 * 的槓桿，加上牌譜訓練的刺殺模型，這裡集中成一個物件：
 *
 *   - `r3NormalVotePrior`          R3+ 投票時正常票（隊內白、隊外黑）
 *                                   候選的加分（0 = 關；基準用 +0.6）。
 *   - `evilLakeClaimAlwaysGood`    紅方持湖時一律宣「好」。
 *   - `goodLakeTargetMostSuspicious` 好人持湖時查最可疑的人（原本查最不可疑）。
 *   - `humanQuestCardRules`        任務牌：R1 莫甘娜單紅出失敗；R4 可見紅 < 2
 *                                   且無人聽牌出成功（標準 5 局制的 R4 必有
 *                                   一方已拿兩局，所以實際只有 R1 規則生效）。
 *   - `assassinModel`              刺殺改用牌譜訓練的條件邏輯回歸
 *                                   （`assassin/AssassinModel.ts`）。
 *   - `evilLakeHumanStrategy`      （2026-10-13，**預設關**）紅方持湖「盡量
 *                                   湖隊友並宣好」的真人策略：有隊友可湖就湖
 *                                   隊友並宣好（自己帶隊時最少把他拿掉的那位
 *                                   優先）；最後一次湖只在隊友全都毫無嫌疑時
 *                                   才改湖藍方（實際上很少發生）；沒有隊友
 *                                   可湖時湖藍方 —— 紅方已聽牌且自己和對方
 *                                   同在一次失敗任務上就宣紅（嫁禍），其餘說
 *                                   實話宣好（買好感）。奧伯倫看不到隊友，
 *                                   一律走「湖藍方」那條（同樣的背書順序，
 *                                   不是挑最可疑的人），湖到紅方就宣好掩護。
 *                                   打開時優先於舊的紅方湖目標規則（含
 *                                   AVALON_EVIL_LAKE_BRING_FRIEND=0）；宣告上
 *                                   `evilLakeClaimAlwaysGood` 若也打開則以
 *                                   「一律宣好」為準。細節見
 *                                   `LakePolicy.pickEvilLakeTargetHuman`。
 *   - `goodLakeInfoMax`            （2026-10-13，**預設關**，已符合採用條件，
 *                                   見下方 DEFAULT 說明）好人持湖改用
 *                                   「共同資訊極大化」模型（`GoodLakeInfo.ts`）：
 *                                   列舉與持湖者所知一致的紅方組合，挑「宣告
 *                                   後藍方共同視角的不確定性下降最多」的人，
 *                                   之後還有湖時再加信任鏈項（目標是藍 → 下一
 *                                   位可信的持湖者；是紅 → 下一湖會說謊）；
 *                                   紅方已拿兩局或最後一次湖時不加信任鏈項。
 *                                   打開時優先於 `goodLakeTargetMostSuspicious`
 *                                   （模型找不到一致的組合時才退回它）；
 *                                   梅林不湖看得到的紅、派西不湖兩拇指照舊。
 *
 * 三層來源，後者覆蓋前者：
 *   1. `LEGACY_AGENT_TUNING`：2026-10-12 之前的行為（全部關閉）。
 *   2. `DEFAULT_AGENT_TUNING`：採用後的預設（見 `docs/ai/strength_benchmark.md`
 *      的採用結論）。
 *   3. 環境變數 `AVALON_TUNING_*`（部署時臨時切換，不改程式）。
 *   4. 建構 `HeuristicAgent` 時傳入的 `Partial<AgentTuning>`（自我對打
 *      基準需要同一局裡兩種設定同時存在）。
 *
 * 所有函式皆為純函式；`getDefaultAgentTuning()` 每次呼叫都重讀環境變數
 * （成本可忽略），測試可直接設定 `process.env` 再呼叫。
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';

export interface AgentTuning {
  /** R3+ 正常票先驗：加到正常票候選的分數；0 = 關閉。 */
  r3NormalVotePrior: number;
  /** 正常票先驗只套用在紅方（藍方不加）；補充實驗用，見 strength_benchmark.md。 */
  r3NormalVotePriorEvilOnly: boolean;
  /** 紅方持湖宣告一律宣「好」。 */
  evilLakeClaimAlwaysGood: boolean;
  /** 好人持湖時查最可疑的人。 */
  goodLakeTargetMostSuspicious: boolean;
  /** 任務牌真人規則：R1 莫甘娜單紅出失敗；R4 可見紅 < 2 且無人聽牌出成功（標準局 R4 恆聽牌 → 不生效）。 */
  humanQuestCardRules: boolean;
  /** 刺殺改用牌譜訓練的模型。 */
  assassinModel: boolean;
  /**
   * 紅方持湖改用「盡量湖隊友並宣好」的真人策略（Edward 2026-10-13 裁定），
   * 細節見 `LakePolicy.pickEvilLakeTargetHuman` / `decideEvilLakeClaimHuman`。
   */
  evilLakeHumanStrategy: boolean;
  /**
   * 好人持湖改用「共同資訊極大化」模型（Edward 2026-10-13），細節見
   * `GoodLakeInfo.ts`；打開時優先於 `goodLakeTargetMostSuspicious`。
   */
  goodLakeInfoMax: boolean;
}

export type AgentTuningKey = keyof AgentTuning;

export const AGENT_TUNING_KEYS: readonly AgentTuningKey[] = [
  'r3NormalVotePrior',
  'r3NormalVotePriorEvilOnly',
  'evilLakeClaimAlwaysGood',
  'goodLakeTargetMostSuspicious',
  'humanQuestCardRules',
  'assassinModel',
  'evilLakeHumanStrategy',
  'goodLakeInfoMax',
];

/** 2026-10-12 之前的行為：所有開關關閉。 */
export const LEGACY_AGENT_TUNING: Readonly<AgentTuning> = Object.freeze({
  r3NormalVotePrior: 0,
  r3NormalVotePriorEvilOnly: false,
  evilLakeClaimAlwaysGood: false,
  goodLakeTargetMostSuspicious: false,
  humanQuestCardRules: false,
  assassinModel: false,
  evilLakeHumanStrategy: false,
  goodLakeInfoMax: false,
});

/**
 * 正式預設（2026-10-12 採用，docs/ai/strength_benchmark.md 第 2 節；
 * 2026-10-13 量過 `evilLakeHumanStrategy` 但不採用，第 6 節；同日的
 * `goodLakeInfoMax` 符合採用條件，預設切換留待整合，第 7 節）。
 * 採用規則（2026-10-12 事前版）：一致性基準更像真人、且自我對打合計勝率
 * 95% 區間下界 ≥ 48%；整合時改依 Edward 原文「更像真人，而且不能讓它
 * 變弱」：任一立場配對差的 95% 區間整個落在 0 以下就算變弱、不採用。
 * 「合計」= 紅方立場與藍方立場的平均；只動一方的開關另一方恆為 0，
 * 所以這條規則允許單一立場最多約 −4pp 的顯著變弱，換取更像真人。
 *
 *   - 正常票先驗全員 +0.6 / +0.3 讓藍方明顯變弱（合計 47.0% / 47.8%），
 *     只套紅方（`r3NormalVotePriorEvilOnly`）則 49.8% 且更像真人 → 採用
 *     紅方版本。
 *   - `evilLakeClaimAlwaysGood`：一致性 +17～36pp，但紅方立場 −0.5pp
 *     [−0.9pp, −0.2pp]（統計上可辨地變弱，三個種子方向一致）。合計
 *     49.7% 雖在 48% 線上，Edward 的採用原則是「更像真人，而且不能讓它
 *     變弱」，區間不含 0 就是變弱 → **不採用**（預設關，可用
 *     AVALON_TUNING_EVIL_LAKE_CLAIM_GOOD=1 打開）。
 *   - 其餘開關各自通過，數字見 strength_benchmark.md 第 2 節（
 *     `humanQuestCardRules` 的 R4 規則在聽牌時讓位給 §0，見
 *     `humanQuestCardRule`）。
 *   - `evilLakeHumanStrategy`（2026-10-13，strength_benchmark.md 第 6 節）：
 *     對照的是上面這組正式預設（不是 legacy）。更像真人（紅方湖宣告一致性
 *     ED 50.0→78.6、Sin 61.1→90.7、top 60.4→79.5、population 58.2→73.3），
 *     但自我對打紅方立場變弱：選定版本用的 seed 20261012 是 −0.4pp
 *     [−1.0pp, +0.1pp]，換新種子重驗 seed 99 −1.0pp [−1.6pp, −0.4pp]、
 *     seed 4242 −0.8pp [−1.4pp, −0.3pp]（區間整個在 0 以下），五個種子
 *     （19000 組）合併 −0.6pp [−0.9pp, −0.3pp] → **不採用**（預設關，可用
 *     AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY=1 打開）。
 *   - `goodLakeInfoMax`（2026-10-13，strength_benchmark.md 第 7 節）：對照
 *     同樣是上面這組正式預設。好人持湖的湖目標一致性 ED 18.9→35.1%、
 *     Sin 20.3→22.9%、top 12.2→25.8%、population 14.9→24.7%；自我對打
 *     藍方立場 seed 4096（選版本）−0.3pp [−1.0pp, +0.3pp]、新種子 6174
 *     −0.3pp [−0.9pp, +0.4pp]、1729 −0.2pp [−0.9pp, +0.4pp]，三個種子合併
 *     −0.3pp [−0.7pp, +0.1pp]，區間都含 0 → 依規則不算變弱 → **符合採用
 *     條件**。預設的切換要和 `src/socket/GameServer.botLake.test.ts`（把
 *     正式預設的好人湖目標寫成「最可疑」）一起改，留待整合時進行；在那之前
 *     可用 AVALON_TUNING_GOOD_LAKE_INFO_MAX=1 打開（打開後
 *     `goodLakeTargetMostSuspicious` 只當模型找不到一致組合時的退路）。
 *
 * 2026-10-13 起正式伺服器的機器人湖目標與湖宣告改由機器人自己的 agent
 * 決定（`GameServer.pickBotLakeTarget` / `decideBotLakeClaim` 呼叫
 * `HeuristicAgent.pickLakeTarget` / `declareLake`），所以湖相關的開關
 * 對線上對局同樣有效；agent 出錯時才退回舊的隨機目標 / 紅方反說。
 * 整個退回舊的線上做法：AVALON_BOT_LAKE_VIA_AGENT=0（GameServer）。
 */
export const DEFAULT_AGENT_TUNING: Readonly<AgentTuning> = Object.freeze({
  r3NormalVotePrior: 0.6,
  r3NormalVotePriorEvilOnly: true,
  evilLakeClaimAlwaysGood: false,
  goodLakeTargetMostSuspicious: true,
  humanQuestCardRules: true,
  assassinModel: true,
  evilLakeHumanStrategy: false,
  goodLakeInfoMax: false,
});

/** 環境變數名稱（值：數字開關用數字，布林開關用 1/0/true/false）。 */
export const AGENT_TUNING_ENV: Readonly<Record<AgentTuningKey, string>> = Object.freeze({
  r3NormalVotePrior: 'AVALON_TUNING_R3_NORMAL_VOTE_PRIOR',
  r3NormalVotePriorEvilOnly: 'AVALON_TUNING_R3_NORMAL_VOTE_PRIOR_EVIL_ONLY',
  evilLakeClaimAlwaysGood: 'AVALON_TUNING_EVIL_LAKE_CLAIM_GOOD',
  goodLakeTargetMostSuspicious: 'AVALON_TUNING_GOOD_LAKE_MOST_SUSPICIOUS',
  humanQuestCardRules: 'AVALON_TUNING_HUMAN_QUEST_CARDS',
  assassinModel: 'AVALON_TUNING_ASSASSIN_MODEL',
  evilLakeHumanStrategy: 'AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY',
  goodLakeInfoMax: 'AVALON_TUNING_GOOD_LAKE_INFO_MAX',
});

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return undefined;
}

/**
 * 解析單一開關字串（CLI `--flag` 與環境變數共用）：
 *   `name`        → 布林開關 = true；數字開關 = 該開關的基準值（0.6）
 *   `name=value`  → 指定值
 * 未知名稱或無法解析的值會丟出 Error。
 */
export function parseTuningFlag(spec: string): Partial<AgentTuning> {
  const eq = spec.indexOf('=');
  const name = (eq >= 0 ? spec.slice(0, eq) : spec).trim() as AgentTuningKey;
  const raw = eq >= 0 ? spec.slice(eq + 1) : undefined;
  if (!AGENT_TUNING_KEYS.includes(name)) {
    throw new Error(`unknown tuning flag "${name}" (known: ${AGENT_TUNING_KEYS.join(', ')})`);
  }
  if (name === 'r3NormalVotePrior') {
    const value = raw === undefined ? 0.6 : Number.parseFloat(raw);
    if (!Number.isFinite(value)) throw new Error(`r3NormalVotePrior needs a number, got "${raw}"`);
    return { r3NormalVotePrior: value };
  }
  const value = raw === undefined ? true : parseBool(raw);
  if (value === undefined) throw new Error(`${name} needs a boolean, got "${raw}"`);
  return { [name]: value } as Partial<AgentTuning>;
}

/** 從環境變數讀取覆寫（沒設定的開關不出現在結果裡）。 */
export function tuningFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<AgentTuning> {
  const out: Partial<AgentTuning> = {};
  for (const key of AGENT_TUNING_KEYS) {
    const raw = env[AGENT_TUNING_ENV[key]];
    if (raw === undefined || raw.trim() === '') continue;
    try {
      Object.assign(out, parseTuningFlag(`${key}=${raw}`));
    } catch {
      // 壞值視同沒設定；部署時打錯字不該讓機器人整個失效。
    }
  }
  return out;
}

/** 正式預設 + 環境變數覆寫。 */
export function getDefaultAgentTuning(env: NodeJS.ProcessEnv = process.env): AgentTuning {
  return { ...DEFAULT_AGENT_TUNING, ...tuningFromEnv(env) };
}

/** 合併成完整物件：`base`（預設 = 正式預設 + 環境變數）再套 `overrides`。 */
export function resolveAgentTuning(
  overrides?: Partial<AgentTuning>,
  base: AgentTuning = getDefaultAgentTuning(),
): AgentTuning {
  return { ...base, ...(overrides ?? {}) };
}

/** 人看的簡短描述（文件、報表用）；全關時回 "legacy"。 */
export function describeAgentTuning(t: AgentTuning): string {
  const parts: string[] = [];
  if (t.r3NormalVotePrior !== 0) parts.push(`r3NormalVotePrior=${t.r3NormalVotePrior}`);
  for (const key of AGENT_TUNING_KEYS) {
    if (key === 'r3NormalVotePrior') continue;
    if (key === 'r3NormalVotePriorEvilOnly' && t.r3NormalVotePrior === 0) continue;
    if (t[key]) parts.push(key);
  }
  return parts.length === 0 ? 'legacy' : parts.join(',');
}

// ── 任務牌真人規則 ───────────────────────────────────────────

/**
 * `humanQuestCardRules` 的判斷（純函式，HeuristicAgent 與 ForwardAgent
 * 共用，避免兩條路徑各算一遍）。只對紅方有意義；回 `null` 表示規則不
 * 適用，交回原本的決策流程。
 *
 *   - R4 需要兩張失敗（7 人以上）而隊上「可見紅」（自己 + knownEvils）
 *     少於 2 → 單獨一張失敗只是曝光，出成功 — **但只在無人聽牌時**。
 *     「可見紅 < 2」不代表隊上只有一個紅：10 人局的奧伯倫對刺客 / 莫甘
 *     娜 / 莫德雷德不可見，奧伯倫自己也看不到任何隊友，所以刺客 + 奧伯
 *     倫同隊時兩人都以為自己是單紅。紅方聽牌時兩張失敗就是三紅直接獲
 *     勝（2026-10-12 審查：第一版在這裡白白放掉致勝局）；藍方聽牌時出
 *     失敗沒有代價（任務照樣成功就進刺殺，曝光已無意義）而且牌譜上真人
 *     單紅 R4 在 2-1 藍時 81.5% 出失敗（n=259）。§0 聽牌規則（任一方已
 *     拿兩局 → 紅方一律失敗）因此優先。標準 5 局制的 R4 必是 2-1 或
 *     1-2，所以這個分支在正式對局不會觸發；保留是為了非標準配置與規則
 *     本身的完整性，`humanQuestCardRules` 實際生效的是 R1 規則。
 *   - R1 莫甘娜是隊上唯一可見紅 → 出失敗（真人莫甘娜 R1 單紅 149/201
 *     出失敗，agent 原本出成功）。
 */
export function humanQuestCardRule(obs: PlayerObservation): 'success' | 'fail' | null {
  if (obs.myTeam !== 'good' && obs.myTeam !== 'evil') return null;
  if (obs.myTeam === 'good') return null;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId)) return null;
  const known = new Set(obs.knownEvils);
  const visibleEvil = team.filter((id) => id === obs.myPlayerId || known.has(id)).length;
  const round = obs.currentRound;
  const required = AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
  const results = obs.questResults ?? [];
  const goodWins = results.filter((r) => r === 'success').length;
  const evilWins = results.filter((r) => r === 'fail').length;
  const listening = goodWins === 2 || evilWins === 2;
  if (required >= 2 && visibleEvil < required && !listening) return 'success';
  if (round === 1 && (obs.myRole as string) === 'morgana' && visibleEvil === 1) return 'fail';
  return null;
}
