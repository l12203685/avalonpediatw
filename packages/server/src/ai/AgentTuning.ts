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
 *   - `evilLakeHumanStrategy`      （2026-10-13，**預設開**，Edward 當日裁定
 *                                   「先像真人，再從策略上提高勝率」）紅方持湖「盡量
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
 *   - 2026-10-13 第二輪（湖法打開後從其他紅方決策補強，見
 *     strength_benchmark.md 第 8 節；三個都是紅方專用、legacy 全關）：
 *     `evilVouchFollowUp`（**預設開**；紅方持湖者言行一致：自己宣藍的人
 *     放進自己派的隊、宣紅的不放；不在隊上時漏掉宣藍者的隊就反對，
 *     `RedLakeFollowUp.ts`）、`evilLakeFrameHumanRate`（**預設開**，暫定；
 *     嫁禍頻率照真人比例，但一致性基準的湖宣告分數下降，待 Edward 選）、
 *     `oberonLakeSeeksTeammates`（預設關；奧伯倫持湖找隊友，比真人更常
 *     湖到紅方而且略弱，不採用）。前兩個只在 `evilLakeHumanStrategy`
 *     打開時有作用。
 *   - `goodLakeInfoMax`            （2026-10-13，**預設開**）好人持湖改用
 *                                   「共同資訊極大化」模型（`GoodLakeInfo.ts`）：
 *                                   列舉與持湖者所知一致的紅方組合，挑「宣告
 *                                   後藍方共同視角的不確定性下降最多」的人，
 *                                   之後還有湖時再加信任鏈項（目標是藍 → 下一
 *                                   位可信的持湖者：P(藍) × 一次湖的價值，
 *                                   權重 2）；
 *                                   紅方已拿兩局或最後一次湖時不加信任鏈項。
 *                                   打開時優先於 `goodLakeTargetMostSuspicious`
 *                                   （模型找不到一致的組合時才退回它）；
 *                                   梅林不湖看得到的紅、派西不湖兩拇指照舊。
 *   - `redR1Teammate`              （2026-10-13 第三輪，**預設開**）看得到隊友的
 *                                   紅方 R1 當隊長時，前四次提議（不會過的說話隊）
 *                                   以真人比例 48.0% 放一位隊友（原本 0%）；第五次
 *                                   強制局照舊不放。只在 10 人局。細節見
 *                                   `RedR1Teammate.ts`。
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
   * 紅方持湖後言行一致（2026-10-13 第二輪，strength_benchmark.md 第 8 節）：
   * 自己宣藍的人一定放進自己派的隊、宣紅的人不放；自己不在隊上時，漏掉
   * 自己宣藍的人或放了宣紅的人的隊就反對（強制局例外；紅方聽牌 / R5 收尾
   * 的決勝窗口也照做，真人在那時一樣守信；baseline 的 硬1 / 硬2 在那時
   * 依 Q11 不管）。派隊是在原本的候選隊伍裡篩選「守信」的
   * 隊，原本選的隊已經守信就不變；沒有任何候選守信才圍繞被宣的人重組。
   * 只在 `evilLakeHumanStrategy` 打開時有作用
   * （`RedLakeFollowUp.evilVouchFollowUpActive`），所以
   * `AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY=0` 一個變數就退回第二輪之前
   * 的舊預設。細節見 `RedLakeFollowUp.ts`。
   */
  evilVouchFollowUp: boolean;
  /**
   * 紅方湖宣紅（嫁禍）的頻率改成真人的比例（2026-10-13 第二輪）：湖目標
   * 不再為了嫁禍去找一起出過失敗任務的人，湖到藍方時依情境（同出過失敗
   * 任務 × 紅方聽牌）照牌譜的比例宣紅（`LakePolicy.HUMAN_FRAME_RATE`），
   * 其餘說實話。只在 `evilLakeHumanStrategy` 打開時有作用。
   */
  evilLakeFrameHumanRate: boolean;
  /**
   * 奧伯倫持湖時找隊友（2026-10-13 第二輪）：湖「不是自己出的失敗牌」最多
   * 的人（`LakePolicy.oberonTeammateEvidence`），湖到紅方就宣好掩護、湖留
   * 在紅方；原本走藍方的背書順序，湖到紅方的比例比亂湖還低。只在
   * `evilLakeHumanStrategy` 打開時有作用。
   */
  oberonLakeSeeksTeammates: boolean;
  /**
   * 好人持湖改用「共同資訊極大化」模型（Edward 2026-10-13），細節見
   * `GoodLakeInfo.ts`；打開時優先於 `goodLakeTargetMostSuspicious`。
   */
  goodLakeInfoMax: boolean;
  /**
   * 紅方首局帶隊友（2026-10-13 第三輪，strength_benchmark.md 第 12 節）：
   * 看得到隊友的紅方 R1 當隊長時，不再一律不放隊友（真人 R1 43.9%，前四次
   * 提議 48.0%、第五次強制局 27.7%）：前四次提議以 48.0% 的機率放一位隊友，
   * 強制局照舊。只在 10 人局（資料與基準都是 10 人局）。細節見
   * `RedR1Teammate.ts`。R2+ 不變。
   */
  redR1Teammate: boolean;
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
  'evilVouchFollowUp',
  'evilLakeFrameHumanRate',
  'oberonLakeSeeksTeammates',
  'goodLakeInfoMax',
  'redR1Teammate',
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
  evilVouchFollowUp: false,
  evilLakeFrameHumanRate: false,
  oberonLakeSeeksTeammates: false,
  goodLakeInfoMax: false,
  redR1Teammate: false,
});

/**
 * 正式預設（2026-10-12 採用，docs/ai/strength_benchmark.md 第 2 節；
 * 2026-10-13 `evilLakeHumanStrategy` 依 Edward 裁定打開，第 6、8 節；同日
 * 採用 `goodLakeInfoMax`，第 7 節；兩者合併後的整組重跑見第 9 節）。
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
 *     （19000 組）合併 −0.6pp [−0.9pp, −0.3pp]，依規則原本不採用。
 *     **2026-10-13 Edward 裁定**（原文）：「紅方新湖法先打開 變弱應該從其他
 *     地方調整修正 (先像真人 再從策略上提高勝率)」→ 預設打開（legacy 仍
 *     關；`AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY=0` 可關掉），變弱的部分
 *     改由其他紅方決策補回（strength_benchmark.md 第 8 節）。
 *   - 2026-10-13 第二輪（strength_benchmark.md 第 8 節；對照組 = 上面那組
 *     不含新湖法的舊預設；seed 31337 選版本、8080 / 2718 確認）：變弱幾乎
 *     全部來自「湖留在紅方」× 好人機器人的硬3 規則（藍方持湖者被誤判的
 *     機會變少），不是紅方宣告本身。數字是同日審查修正後重跑的。
 *     `evilVouchFollowUp` 採用，審查修正後改成「決勝窗口也照做」（在選
 *     版本的種子上比較強、也比較像真人，用沒用過的 16180 / 14142 確認）：
 *     含 `evilLakeFrameHumanRate` 對「只開新湖法」三個種子（31337 +
 *     16180 + 14142）合併 +0.54pp [+0.25pp, +0.83pp]；R3+ 投票一致性
 *     ED 63.7→64.1、Sin 65.2→65.9、top 61.9→62.7。`evilLakeFrameHumanRate`
 *     暫時打開：強度不變（−0.03pp [−0.20pp, +0.14pp]），嫁禍頻率
 *     65.6%→29.7%（真人 25.9%）比較像真人，但一致性基準的紅方湖宣告比
 *     只開新湖法低 4.2–5.5 點，兩種量法相反，待 Edward 選。新預設對舊
 *     預設：三個種子合併 −0.31pp [−0.68pp, +0.06pp]（區間含 0），但本線
 *     五個種子合併 −0.42pp [−0.70pp, −0.13pp]（只開新湖法 −1.02pp）：
 *     補回約六成，用全部資料看**仍算變弱**；依 Edward 裁定新湖法照樣
 *     打開，剩下的差距與待決事項見第 8.6 節。這裡的採用依「對只開新湖法
 *     不變弱」，不是原定的「對舊預設不變弱」，也寫在第 8.6 節。
 *     `oberonLakeSeeksTeammates` 不採用。
 *     整合後（加上 `goodLakeInfoMax`）用三個新種子 5150 / 8128 / 6561 重跑
 *     （第 9 節）：紅方 +0.23pp [−0.14pp, +0.59pp]、藍方 −0.27pp [−0.64pp,
 *     +0.11pp]，兩邊區間都含 0；紅方與第 8 節五個種子合併約 −0.17pp
 *     [−0.40pp, +0.05pp] → 整組不算變弱。
 *   - `redR1Teammate`（2026-10-13 第三輪，strength_benchmark.md 第 12 節；對照
 *     組 = 上面整合後的正式預設；只在 10 人局）：R1 紅方隊長「放不放隊友」
 *     與真人相同的比例，去掉抽籤運氣的期望值 ED 49.0→53.9%、Sin 39.4→
 *     52.6%、top 52.2→53.6%（population 56.1→54.6%，只當同分參考；這次
 *     播種實際 61.2 / 58.5 / 52.8 / 54.2%）。與關掉時逐次配對只有 Sin 明確
 *     較好（46 對 19，McNemar p=0.001），top 持平（175 對 170），ED 11 對 5
 *     （p=0.21）；放隊友的比例照真人（說話隊 47.7% vs 48.0%）；派隊 Jaccard
 *     四群都升，其他決策完全不變；自我對打紅方
 *     選版本 seed 77777 +0.32pp [−0.19pp, +0.83pp]、新種子 88888 +0.24pp
 *     [−0.27pp, +0.75pp]、99999 −0.22pp [−0.71pp, +0.27pp]，三個種子合併
 *     +0.10pp [−0.19pp, +0.39pp]，藍方恆為 0 → 不算變弱 → **採用**
 *     （AVALON_TUNING_RED_R1_TEAMMATE=0 可關掉）。
 *   - `goodLakeInfoMax`（2026-10-13，strength_benchmark.md 第 7 節）：對照
 *     同樣是上面這組正式預設。好人持湖的湖目標一致性 ED 18.9→35.1%、
 *     Sin 20.3→22.9%、top 12.2→25.8%、population 14.9→24.7%（配對比較
 *     top / population 顯著，ED p≈0.07，Sin 看不出差別）；自我對打
 *     藍方立場 seed 4096（協定的選版本種子，只跑定案版）−0.3pp
 *     [−1.0pp, +0.3pp]、新種子 6174 −0.3pp [−0.9pp, +0.4pp]、1729 −0.2pp
 *     [−0.9pp, +0.4pp]，三個種子合併
 *     −0.3pp [−0.6pp, +0.1pp]，區間都含 0 → 依規則不算變弱 → **採用**
 *     （整合時打開；`goodLakeTargetMostSuspicious` 保留，只當模型找不到
 *     一致組合時的退路；AVALON_TUNING_GOOD_LAKE_INFO_MAX=0 可關掉）。
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
  evilLakeHumanStrategy: true,
  evilVouchFollowUp: true,
  evilLakeFrameHumanRate: true,
  oberonLakeSeeksTeammates: false,
  goodLakeInfoMax: true,
  redR1Teammate: true,
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
  evilVouchFollowUp: 'AVALON_TUNING_EVIL_VOUCH_FOLLOW_UP',
  evilLakeFrameHumanRate: 'AVALON_TUNING_EVIL_LAKE_FRAME_HUMAN_RATE',
  oberonLakeSeeksTeammates: 'AVALON_TUNING_OBERON_LAKE_SEEKS_TEAMMATES',
  goodLakeInfoMax: 'AVALON_TUNING_GOOD_LAKE_INFO_MAX',
  redR1Teammate: 'AVALON_TUNING_RED_R1_TEAMMATE',
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
