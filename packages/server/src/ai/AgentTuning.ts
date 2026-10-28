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
 *   - `goodVouchFollowUp`          （2026-10-13 第三輪，**預設開**）好人持湖者
 *                                   言行一致：自己宣藍的人（含「我宣藍的人之後
 *                                   宣藍的人」）放進自己派的隊、宣紅的不放；不在
 *                                   隊上時違反宣告的隊就反對（`GoodLakeFollowUp.ts`）。
 *   - `teamReuse`                  （2026-10-13 第三輪，**預設開**）派隊沿用
 *                                   前一隊：ForwardAgent 從 R2 起不再懲罰重提
 *                                   被否決的隊，改成「保留參考隊成員比例」
 *                                   加分（上一個成功任務的隊、本回合先前的
 *                                   提議），沿用的隊加進候選；防護擋下的隊（硬1 /
 *                                   硬2 違規、好人隊長的隊有自己當作紅的人）不加
 *                                   分、保留舊懲罰；R1 不變。`TeamReuse.ts`。
 *   - `redR1Teammate`              （2026-10-13 第三輪，**預設開**）看得到隊友的
 *                                   紅方 R1 當隊長時，前四次提議（不會過的說話隊）
 *                                   以真人比例 48.0% 放一位隊友（原本 0%）；第五次
 *                                   強制局照舊不放。只在 10 人局。細節見
 *                                   `RedR1Teammate.ts`。
 *   - `percivalNoThumbsR1`         （2026-10-14，**預設開**）派西 R1（第一個
 *                                   任務結果出來之前，五次提議含強制局）當隊長
 *                                   時兩根拇指都不放，不分配置、座位；R2 起不變，
 *                                   湖的避開名單不變；只在 10 人局。Edward
 *                                   2026-10-14「一開始在沒任何資訊時先預設不派」，
 *                                   真人資料與預先登記的規則見
 *                                   `docs/ai/percival_thumbs.md` 第 9、11 節，
 *                                   強度見 `strength_benchmark.md` 第 14 節，
 *                                   細節見 `PercivalThumbs.ts`。2026-10-14 依
 *                                   GM 決定 D5 修正：只在看得到兩根拇指時作用
 *                                   （大廳關掉莫甘娜時唯一的拇指確定是梅林）、
 *                                   擴到 6–9 人局（5 人局仍不適用）。
 *   - 2026-10-14 邏輯第一（`docs/ai/logic_first.md`，第 1A / 1B 批；每個開關
 *     只做一件事，legacy 全關，不變量 0 違規後預設開）：
 *     `percivalR1ThumbOnThumb`（D5 (b) 例外：R1 一根拇指當隊長時把另一根
 *     放進自己的隊，被放的那根可以進派西的隊，`PercivalThumbs.ts`）、
 *     `goodQuestSuccessGuard`（好人任務牌一律成功的防護，ForwardAgent 開頭；
 *     INV-Q1）、`assassinHeuristicVisibility`（舊刺殺啟發式的視野修正：梅林
 *     看得到刺客自己、奧伯倫與兩位隊友中的一位，看不到莫德雷德；只在
 *     `assassinModel` 關掉時跑，INV-A1）。
 *   - 2026-10-22 邏輯第一第 1C 批（信念；`docs/ai/logic_first.md` 第 1C 節；
 *     四個開關各做一件事，legacy 全關，不變量歸零後預設開）：
 *     `beliefCertainFacts`（S1-1：確定事實進入金字塔 —— 確定性層的確定紅 /
 *     確定藍釘 1 / 0，只靠 A0 的釘 1−ε / ε；第 2 層依失敗張數 C2 計數；所有
 *     信念讀 `failCount` 而不是 `result`，R4 成功帶失敗牌也算；INV-B2、
 *     INV-B3）、`rule3PostLakeOnly`（S1-2：硬3 只看湖後、嚴格支配、刪 (b)、
 *     概似比 6 的勝算更新取代 0.85 下限；派隊沿用的防護只用確定紅；
 *     INV-H3a、INV-H3b）、`beliefChainProjection`（S1-3 信念部分：宣藍鏈上
 *     s(C) ≤ s(B) ≤ s(A)、宣紅的一對 s(A) + s(B) ≥ 1 的投影；INV-B1）、
 *     `forcedVoteZeroBits`（S1-9a：第 5 次強制提議的合成票不算資訊；INV-F0）。
 *     細節見 `belief/BeliefOptions.ts`。環境變數：
 *     AVALON_TUNING_BELIEF_CERTAIN_FACTS、AVALON_TUNING_RULE3_POST_LAKE_ONLY、
 *     AVALON_TUNING_BELIEF_CHAIN_PROJECTION、AVALON_TUNING_FORCED_VOTE_ZERO_BITS。
 *   - 2026-10-22 邏輯第一第 1D 批（建在修正後信念上的決策閘門；
 *     `docs/ai/logic_first.md` 第 7 節；兩個開關各做一件事，legacy 全關，
 *     不變量歸零後預設開，細節見 `LogicGates.ts`）：
 *     `teamDominanceGate`（S1-3 派隊閘門：好人隊長不派、好人 R3+ 不贊成「嚴格
 *     被支配」的隊 —— A 在隊上、A 宣藍的 B 不在、隊上另有人可能是唯一的紅，
 *     逐對檢查所以湖鏈 A→B→C 自動閉合；INV-K1）、`mustFailGate`（S1-4 + S1-5
 *     必敗隊閘門：好人隊長不派、好人在非強制的 R3+ 提議不贊成「確定性層 L1*
 *     的 minReds ≥ 該局所需失敗數」的隊；R1–R2 照桌規（D3 定案）；在所有角色
 *     的「在隊上一律贊成」捷徑之前執行；持湖者在隊上時，一張失敗就夠而隊上有
 *     自己宣紅的人 → 反對（P2）；INV-T1、V1、K2、P3、L1）。環境變數：
 *     AVALON_TUNING_TEAM_DOMINANCE_GATE、AVALON_TUNING_MUST_FAIL_GATE。
 *   - 2026-10-26 邏輯第一第 1E / 1F 批（派西 = 帶「兩拇指恰好一紅」內建資訊
 *     的忠臣；紅方不做不可能為真的湖宣告；`docs/ai/logic_first.md` 第 8 節；
 *     四個開關各做一件事，legacy 全關，不變量歸零後預設開）：
 *     `percivalLoyalVote`（S1-6 投票：拿掉派西「在隊上一律贊成」與「隊上沒有
 *     拇指就反對」兩條捷徑，改走一般好人投票；R3 起非強制、一張失敗就夠的
 *     回合兩拇指同隊 → 反對；莫甘娜自己的紅方規則不動；INV-Pe1）、
 *     `percivalCertainExclusion`（S1-6 派隊：派西只硬排除確定性層的確定紅 ——
 *     `inferRedsFromTaskFails` 只留確定紅、「鐵咬」只在那根拇指確定是紅時硬
 *     排除，兩根拇指同分時不依座位序選邊；INV-Pe2）、`percivalBlueLake`
 *     （S1-8：派西的湖是藍方湖，避開名單只剩 `knownEvils`；INV-PL）、
 *     `redPossibleClaimsOnly`（S1-10：紅方持湖者不做「好人持湖者不可能為真」
 *     的宣告，改宣另一邊，兩邊都不可能時不宣告；INV-R1）。
 *   - 2026-10-26 第 1G 批（刺殺；練習回報 (b)；`docs/ai/logic_first.md` 第 9 節；
 *     同日審查後歸為**第二關（像真人）**的規則 —— 真人的強規律、不是絕對正確的
 *     約束）：`assassinVisibleRedTier`（**預設開**；當隊長時（Edward 2026-10-26 起第 5 次強制提議也算）確定把
 *     梅林看得到的紅放進隊的候選，排在每一位從沒這樣做過的候選之後；字典序的
 *     層級、不是硬排除；兩條刺殺路徑都適用；INV-A2，policy 類）、
 *     `assassinVisibleRedLikelihood`（**預設關**，審查後；隊上只有一位看得到的
 *     隊友 —— 莫甘娜或莫德雷德、刺客分不出 —— 的非強制提議，乘上真人資料量到
 *     的概似比；只在模型路徑；和模型的隊長特徵重複計算、交叉驗證沒有增益）。
 *     `assassin/VisibleRedProposals.ts`。環境變數：
 *     AVALON_TUNING_ASSASSIN_VISIBLE_RED_TIER、AVALON_TUNING_ASSASSIN_VISIBLE_RED_LIKELIHOOD。
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
   * 好人持湖者言行一致（2026-10-13 第三輪，strength_benchmark.md 第 10 節；
   * `evilVouchFollowUp` 的藍方版本）：自己宣藍的人一定放進自己派的隊、宣紅
   * 的人不放；自己不在隊上時，漏掉自己宣藍的人或放了宣紅的人的隊就反對
   * （強制局例外）。細節見 `GoodLakeFollowUp.ts`。
   */
  goodVouchFollowUp: boolean;
  /**
   * 派隊沿用前一隊（2026-10-13 第三輪，strength_benchmark.md 第 11 節）：
   * ForwardAgent 從 R2 起不再懲罰重提本回合被否決的隊，改成「保留參考隊
   * 伍成員的比例」加分（參考 = 上一個成功任務的隊、本回合先前的提議），
   * 並把沿用參考隊的候選（原隊、換自己進去、加一人、換一人）加進候選
   * 集合；防護擋下的隊（硬1 / 硬2 違規；好人隊長的隊上有看得到的紅、湖鏈 /
   * 硬3 違規者、失敗任務推得出的紅或金字塔 ≥ 0.85 的人）不加分、保留舊懲罰，
   * 也不加進候選。細節見 `TeamReuse.ts`。2026-10-13 採用（預設開）。
   */
  teamReuse: boolean;
  /**
   * 紅方首局帶隊友（2026-10-13 第三輪，strength_benchmark.md 第 12 節）：
   * 看得到隊友的紅方 R1 當隊長時，不再一律不放隊友（真人 R1 43.9%，前四次
   * 提議 48.0%、第五次強制局 27.7%）：前四次提議以 48.0% 的機率放一位隊友，
   * 強制局照舊。只在 10 人局（資料與基準都是 10 人局）。細節見
   * `RedR1Teammate.ts`。R2+ 不變。
   */
  redR1Teammate: boolean;
  /**
   * 派西首局不放拇指（2026-10-14，`docs/ai/percival_thumbs.md` 第 9 節）：
   * 派西 R1（第一個任務結果出來之前；五次提議都算，含強制局）當隊長時，
   * 兩根拇指（梅林 / 莫甘娜，分不出誰是誰）都不放進隊，不分配置（拇指在
   * 派西之前派過幾次隊）、不分派西或拇指的座位；人數不夠時才依 2026-10-10
   * 的補位順序放回。R2 起照原本的辨識邏輯，湖的避開名單不變。原本只有
   * R1 第一次提議（而且只在 fallback 的 baseline 路徑）不放，正式路徑的
   * ForwardAgent 在 R1 一律放座位較小的那根。只在 10 人局。2026-10-14 依
   * 預先登記的規則採用（strength_benchmark.md 第 14 節）。細節見
   * `PercivalThumbs.ts`。
   */
  percivalNoThumbsR1: boolean;
  /**
   * 派西首局不放拇指的例外（2026-10-14，GM 決定 D5 (b)，`docs/ai/logic_first.md`）：
   * R1 在派西之前，一根拇指當隊長時把另一根拇指放進自己的隊，被放的那根
   * 可以進派西的隊（真人資料：被放的那根 87.9% 是梅林，真人派西 73.9% 會放
   * 她）；兩根互相放過則訊號抵銷、不例外。只在 `percivalNoThumbsR1` 生效時
   * 有作用。細節見 `PercivalThumbs.percivalR1ThumbException`。
   */
  percivalR1ThumbOnThumb: boolean;
  /**
   * 好人任務牌防護（2026-10-14，S1-11，INV-Q1）：好人機器人被要求出任務牌
   * 時，`ForwardAgent.decide` 一開始就回「成功」，不進評分。好人本來就 0 次
   * 出失敗（22995 次），這是防護，不改行為。
   */
  goodQuestSuccessGuard: boolean;
  /**
   * 舊刺殺啟發式的視野修正（2026-10-14，S1-11，INV-A1、M1）：`assassinModel`
   * 關掉時才跑的 `getMistakeCount` / `getPercivalLikenessPenalty` 把刺客的
   * `knownEvils`（莫甘娜 + 莫德雷德）當成「梅林看得到的紅」；正確的是刺客
   * 自己、奧伯倫確定看得到，莫甘娜與莫德雷德之中梅林只看得到莫甘娜（刺客
   * 分不出隊友角色時 = 兩位隊友中恰一位）。正式預設的刺殺走模型，所以只影響
   * fallback 與 legacy。
   */
  assassinHeuristicVisibility: boolean;
  /**
   * S1-1（2026-10-22，第 1C 批，INV-B2 / INV-B3）：確定事實進入信念。金字塔
   * 第 1 層把確定性層（`belief/Certainty.ts`）在 L0（規則 + 自己的視野 +
   * 失敗張數 + 自己湖到的結果）確定的紅 / 藍釘在 1 / 0，只靠 A0（好人持湖者
   * 說實話）才確定的釘在 1−ε / ε（ε = 0.01，GM 決定 D1）；第 2 層改依每次
   * 任務的失敗張數（C2：x 張失敗 ⇒ 至少 x 紅，扣掉已確定的紅，平分給不確定
   * 的隊員）而不是「失敗隊每人 +0.15」；所有信念讀 `failCount`，R4 成功但帶
   * 失敗牌的任務也算（C5）。
   */
  beliefCertainFacts: boolean;
  /**
   * S1-2（2026-10-22，第 1C 批，INV-H3a / INV-H3b）：硬3 只看湖後。持湖者 A
   * 宣 B 藍之後，A 自己帶的隊沒放 B、而且隊上有人在 A（若為好人）當時的視角
   * 下不是確定藍（嚴格支配，critique X2 / X4）才算；湖前帶的隊不算（時序
   * T1 / T3）；刪掉「帶過失敗隊 +0.5」的 (b) 款；旗標改成概似比 6 的勝算更新
   * （GM 決定 D10）而不是 0.85 下限；`TeamReuse` 防護的「好人隊長視為紅」
   * 只用確定性層的確定紅。
   */
  rule3PostLakeOnly: boolean;
  /**
   * S1-3 信念部分（2026-10-22，第 1C 批，INV-B1）：分層算完之後把分數投影到
   * 湖鏈的約束上 —— 宣藍的 A→B（鏈 A→B→C）要 s(B) ≤ s(A)、s(C) ≤ s(B)
   * （K1 / K3），宣紅的一對要 s(A) + s(B) ≥ 1（K2）；被釘住的座位不動。
   */
  beliefChainProjection: boolean;
  /**
   * S1-9a（2026-10-22，第 1C 批，INV-F0）：第 5 次強制提議沒有投票（引擎合成
   * 全員贊成），被強迫的行動帶 0 bit：所有讀投票紀錄的信念（第 4 層的外白 /
   * 內黑、記憶、派西的梅林辨識、宣告者投票偏差）略過 `attempt >= 5` 的紀錄。
   */
  forcedVoteZeroBits: boolean;
  /**
   * S1-3 派隊閘門（2026-10-22，第 1D 批，INV-K1）：好人隊長的候選隊先過
   * 「嚴格支配」檢查（確定性層 L1、A0 為硬規則）：隊上有 A、A 宣藍的 B 不在、
   * 而且隊上有 A 以外的人在某個一致的世界裡是隊上唯一的紅（把他換成 B 會讓
   * P(全隊藍) 嚴格變大，critique X4）的隊不派 —— 有合格候選時丟掉不合格的，
   * 沒有時從全部含自己的隊裡挑合格的（一定存在）；逐對檢查，所以 A→B→C 的
   * 鏈自動閉合（選 A 必選 B 必選 C，Edward 第一原理例 (ii)）。好人在非強制的
   * R3+ 提議也不贊成這種隊（硬1 在正式路徑生效）。L1 為空（A0 被違反）時不
   * 適用。只動好人座位。
   */
  teamDominanceGate: boolean;
  /**
   * S1-4 + S1-5 必敗隊閘門（2026-10-22，第 1D 批，INV-T1 / V1 / K2 / P3 / L1）：
   * 「必敗」= 確定性層 L1*（L1 為空時退回 L0）的每個一致世界裡，隊上的紅都
   * 不少於該局所需的失敗數（GM 決定 D2；R4 要確定兩紅）。好人隊長不派（任何
   * 回合、含強制局；沒有合格候選時從全部含自己的隊裡挑）；好人在非強制的 R3+
   * 提議不贊成 —— 在派西 / 莫甘娜「在隊上一律贊成」等所有角色捷徑之前執行；
   * R1–R2 照「一律正常票」桌規（Edward 2026-10-14 對 D3 的定案裁定：維持、
   * 無例外、不建替代開關）。持湖者在隊上時，一張失敗就夠而隊上有自己宣紅的
   * 人 → 反對（`GoodLakeFollowUp` 的在隊上條款，P2）。指控者（宣我紅的人）
   * 在 L1 是確定紅（S1-5），含他的隊在一張失敗就夠的回合是必敗隊。
   */
  mustFailGate: boolean;
  /**
   * S1-6 派西的投票（2026-10-26，第 1E 批，INV-Pe1）：派西 = 帶「兩拇指恰好
   * 一紅」內建資訊的忠臣，投票走一般好人邏輯（忠臣的邏輯 + 拇指限制 +
   * 第 1D 批的必敗閘門 + 機率層）。拿掉「派西在隊上一律贊成」（ForwardAgent
   * 與 HeuristicAgent 兩條路徑；莫甘娜自己的紅方規則不動）與「隊上沒有拇指
   * 就反對」（沒有拇指的隊不提供任何紅藍資訊，Pe1）；R3 起、非強制提議、
   * 一張失敗就夠的回合，兩拇指同隊（必有一紅）→ 反對；R1–R2 照桌規（D3
   * 定案），R4 兩張失敗交給機率層。
   */
  percivalLoyalVote: boolean;
  /**
   * S1-6 派西的派隊（2026-10-26，第 1E 批，INV-Pe2）：派西只硬排除確定性層
   * L1* 的確定紅。`inferRedsFromTaskFails`（「每次失敗任務都在場」= 紅）只留
   * 確定紅；「鐵咬」（金字塔分數較高的拇指 = 莫甘娜）只在那根拇指確定是紅時
   * 硬排除，否則留在候選裡照嫌疑排序（軟性）；兩根拇指分數相同時不依座位序
   * 指定誰是梅林 / 莫甘娜。R1 不放拇指的裁定不變（第 1A 批）。HeuristicAgent
   * （fallback）R2 起的派西派隊改走忠臣的派隊。
   */
  percivalCertainExclusion: boolean;
  /**
   * S1-8 派西的湖 = 藍方湖（2026-10-26，第 1E 批，Edward 2026-10-14 裁定、D4；
   * INV-PL）：好人持湖者的避開名單只剩 `knownEvils`（梅林看得到的紅），不再
   * 包含派西的兩根拇指；目標由 `GoodLakeInfo` 用持湖者信念（派西：兩拇指
   * 恰好一紅）挑。湖到拇指後確定性層用自己的湖結果同時解出兩根拇指。
   */
  percivalBlueLake: boolean;
  /**
   * S1-10 紅方不做不可能為真的宣告（2026-10-26，第 1F 批，C8 / K5，INV-R1）：
   * 紅方持湖者選好的宣告如果在公開的 L1（A0；L1 為空時 L0）裡沒有任何
   * 「持湖者是好人而且宣告為真」的世界 —— 宣告本身就證明持湖者是紅 ——
   * 就改宣另一邊；兩邊都不可能時（持湖者在公開的局面上已經確定是紅）不宣告
   * （湖以 `declaredClaim: 'none'` 結束）。藍方看到這種宣告會把持湖者
   * 放進確定紅（確定性層自動做到，INV-R2）。
   */
  redPossibleClaimsOnly: boolean;
  /**
   * 刺殺的「看得到的紅」層級（2026-10-26，第 1G 批，練習回報 (b)，INV-A2；
   * 審查後歸為第二關 —— 像真人 —— 的規則，不是邏輯約束）：刺殺時刺殺者知道
   * 全部紅方（含奧伯倫），但分不出兩位隊友誰是莫德雷德（梅林唯一看不到的紅；
   * 大廳有沒有莫德雷德看 `lobbyRoles`）。候選人在 R1 起的非強制提議當隊長時，
   * 隊上「一定有」梅林看得到的紅（刺殺者自己、奧伯倫，或兩位隊友都在）→ 排在
   * 每一位從沒這樣做過的候選之後（字典序層級，分數只在同一層裡比；全部候選都
   * 做過時照分數）。真人梅林這樣派的比例 2.2–19.7%（依回合），忠臣 / 派西
   * 17.8–51.1%，概似比 0.12–0.46；刺殺時真梅林被標記 10.5%、其他藍 39.5%。
   * 模型與舊啟發式都適用。
   */
  assassinVisibleRedTier: boolean;
  /**
   * 刺殺的軟性概似（2026-10-26，第 1G 批；審查後**預設關**）：候選人當隊長的
   * 非強制提議，隊上只有一位看得到的隊友（莫甘娜或莫德雷德，刺客分不出、各 ½）
   * 時，勝算乘上「恰好這種隊」的概似比 —— 兩個混合比例的比值（依回合，真人
   * 資料：R1 1.25、R2 1.64、R3 1.03、R4 1.51、R5 1.01；第 1G 批原本用兩個
   * 比值的平均 ½·LR(有) + ½·LR(沒有)，已撤回）。只在模型路徑（加在線性分數上）；
   * 預設關：模型本來就有這類提議的特徵（`ledWithAllyRate`、`ledCleanCount`），
   * 交叉驗證後沒有增益（`assassinVisibleRedStudy.ts` (c)）。
   */
  assassinVisibleRedLikelihood: boolean;
  /**
   * 還湖（Edward 2026-10-26）：上一個湖宣告持湖者是紅，而可以湖的人裡有公開確定是好人的
   * （例：兩局失敗後成功的任務隊員），持湖者把湖交給其中一位（座位序第一位）。好人、紅方都這樣做 ——
   * 不還湖 = 認壞（確定性層 A2）。
   */
  returnLake: boolean;
  /**
   * 隊伍用「會不會過」評分（2026-10-27，練習台實戰）：派隊與投票原本看隊上的**平均**嫌疑，但一張失敗牌
   * 就讓任務失敗（7 人以上第 4 局兩張）——隊上一位 0.95 的人，其他人再乾淨，這隊也幾乎一定失敗。開：用每個人的
   * 紅方機率算「隊上紅方少於該局失敗牌數」的機率，再和同樣人數的所有隊伍比排名（排名 0–1 取代平均嫌疑）。
   * 範圍：0 關；1 派隊與投票都用；2 只有投票；3 只有賽點（下一次任務失敗紅方就贏）的派隊與投票；4 只有賽點的投票。
   * 第 5 次強制提議藍方一律贊成（有開就套用）。
   */
  teamPassRank: number;
  /**
   * 梅林在注定被否決的提議裡放一個看得到的紅（2026-10-28，優化迴圈第 1 回合）：第 1、2 局非強制的提議照裁定一律
   * 正常票、一定被否決；梅林在這些提議裡換一個看得到的紅進去，讓刺客的「派過可見紅的隊長排除」把他排除。
   * 強制提議與第 3 局起照常（`MerlinCover.ts`）。
   */
  merlinDoomedRed: boolean;
  /**
   * 藍方隊長用「所有符合紀錄的分配」挑隊（2026-10-28，優化迴圈第 1 回合）：第 3 局起，藍方隊長把每一隊「會過」的機率
   * 用確定性層的世界（L1*）算——每個世界依金字塔嫌疑加權（紅的人乘 p、好的人乘 1−p）——並把最好的那隊加進候選；
   * 每個候選的分數加上 權重 × 會過的機率。0 = 關；只寫名字 = 10。
   */
  goodLeaderWorldPick: number;
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
  'goodVouchFollowUp',
  'teamReuse',
  'redR1Teammate',
  'percivalNoThumbsR1',
  'percivalR1ThumbOnThumb',
  'goodQuestSuccessGuard',
  'assassinHeuristicVisibility',
  'beliefCertainFacts',
  'rule3PostLakeOnly',
  'beliefChainProjection',
  'forcedVoteZeroBits',
  'teamDominanceGate',
  'mustFailGate',
  'percivalLoyalVote',
  'percivalCertainExclusion',
  'percivalBlueLake',
  'redPossibleClaimsOnly',
  'assassinVisibleRedTier',
  'assassinVisibleRedLikelihood',
  'returnLake',
  'teamPassRank',
  'merlinDoomedRed',
  'goodLeaderWorldPick',
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
  goodVouchFollowUp: false,
  teamReuse: false,
  redR1Teammate: false,
  percivalNoThumbsR1: false,
  percivalR1ThumbOnThumb: false,
  goodQuestSuccessGuard: false,
  assassinHeuristicVisibility: false,
  beliefCertainFacts: false,
  rule3PostLakeOnly: false,
  beliefChainProjection: false,
  forcedVoteZeroBits: false,
  teamDominanceGate: false,
  mustFailGate: false,
  percivalLoyalVote: false,
  percivalCertainExclusion: false,
  percivalBlueLake: false,
  redPossibleClaimsOnly: false,
  assassinVisibleRedTier: false,
  assassinVisibleRedLikelihood: false,
  returnLake: false,
  teamPassRank: 0,
  merlinDoomedRed: false,
  goodLeaderWorldPick: 0,
});

/**
 * 正式預設（2026-10-12 採用，docs/ai/strength_benchmark.md 第 2 節；
 * 2026-10-13 `evilLakeHumanStrategy` 依 Edward 裁定打開，第 6、8 節；同日
 * 採用 `goodLakeInfoMax`，第 7 節；兩者合併後的整組重跑見第 9 節；第三輪
 * `goodVouchFollowUp` + `teamReuse` + `redR1Teammate` 合併後的整組重跑見
 * 第 13 節）。
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
 *   - `goodVouchFollowUp`（2026-10-13 第三輪，strength_benchmark.md 第 10 節）：
 *     對照 = 上面這組整合後的正式預設。更像真人（好人持湖者宣告後自己派隊
 *     放被宣的人 47%→100%，真人 99.2%；目標決策的派隊 Jaccard ED 44.6→53.1、
 *     Sin 54.7→59.2、top 47.3→56.3；不在隊上時對違反宣告的隊的票 Sin
 *     85.2→96.3、top 81.8→95.9、ED 100 不變），藍方立場選版本 seed 11111
 *     +0.64pp [+0.31pp, +0.97pp]，新種子 22222 +0.36pp [−0.00pp, +0.72pp]、
 *     33333 +0.68pp [+0.36pp, +1.00pp]，三個種子合併 +0.57pp [+0.38pp,
 *     +0.77pp]（紅方立場恆為 0）→ **採用**（AVALON_TUNING_GOOD_VOUCH_FOLLOW_UP=0
 *     可關掉）。
 *   - `teamReuse`（2026-10-13 第三輪，strength_benchmark.md 第 11 節；數字
 *     是同日審查修正後重跑的）：對照 = 整合後的正式預設（第 9 節）。派隊
 *     一致性 R2+（完全相同 / Jaccard）ED 3.5→11.8 / 39.2→48.8、Sin 4.4→22.7
 *     / 42.5→57.1、top 3.0→15.4 / 40.2→52.4、population 3.8→16.1 /
 *     41.2→53.1，其他決策不變；自我對打（單邊立場）選版本種子 44444 + 重跑
 *     55555 / 66666 + 新種子 67890 / 68888 合併：紅方 +2.77pp [+2.41pp,
 *     +3.13pp]、藍方 +5.08pp [+4.62pp, +5.54pp]；十個座位都開的機器人自打自
 *     藍勝約 7.1%→10.5% → **採用**（AVALON_TUNING_TEAM_REUSE=0 可關掉）。
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
 *   - 第三輪整合（strength_benchmark.md 第 13 節）：上面三個第三輪開關各自
 *     的對照組都不含另外兩個，所以合併後整組重跑。新預設（這裡的全部開關）
 *     對第 9 節正式預設，三個沒用過的新種子 101010 / 202020 / 303030（各
 *     5000 組 × 3 局）合併：紅方 +3.18pp [+2.70pp, +3.65pp]、藍方 +4.89pp
 *     [+4.28pp, +5.49pp]，兩個立場都不在 0 以下 → 整組保留。十個座位都用
 *     新預設的機器人自打自（seed 404040）藍勝 7.42%→11.32%。一致性基準
 *     只有派隊（R1、R2+）與 R3+ 投票改變（派隊 Jaccard R2+ ED 39.2→49.0、
 *     Sin 42.5→57.1、top 40.2→52.5、population 41.2→53.2），其他逐項相同。
 *   - `percivalNoThumbsR1`（2026-10-14，strength_benchmark.md 第 14 節、
 *     percival_thumbs.md 第 9、11 節；對照組 = 上面第三輪整合後的正式預設；
 *     只在 10 人局）：Edward「一開始在沒任何資訊時先預設不派」。規則與門檻
 *     在跑任何種子之前預先登記。一致性：派西派隊「拇指組合與真人相同」
 *     population 40.4→58.4%、top 40.7→59.0%、Sin 40.8→57.0%（ED 22/47→
 *     29/47）；一致性基準只有 R1 派西隊長的派隊列改變（R1 派西完全相同
 *     population 0.9→3.4%、top 0.7→4.4%、Sin 0→0%，Jaccard 29.8→34.6、
 *     29.2→36.3、30.6→35.5%），其他每一列（含 R2+ 派隊、投票、任務牌、湖、
 *     刺殺）逐項相同。自我對打藍方立場 515151 +0.16pp [−0.37pp, +0.69pp]、
 *     新種子 626262 +0.02pp [−0.54pp, +0.58pp]、737373 −0.18pp [−0.74pp,
 *     +0.38pp]，三個合併 +0.01pp [−0.31pp, +0.32pp]、兩個確認種子合併
 *     −0.08pp [−0.47pp, +0.32pp]；紅方立場恆為 0；0 次 fallback → 不算
 *     變弱 → **採用**（AVALON_TUNING_PERCIVAL_NO_THUMBS_R1=0 可關掉）。
 *   - 2026-10-14 邏輯第一（`docs/ai/logic_first.md`，新的採用順序：邏輯正確
 *     優先，強度只量測回報、不用來回退）：`percivalR1ThumbOnThumb`、
 *     `goodQuestSuccessGuard`、`assassinHeuristicVisibility` 預設開（不變量
 *     INV-R1NT / INV-Q1 / INV-A1 為 0）；強度見 strength_benchmark.md 第 15 節。
 *   - 2026-10-22 第 1C 批（信念，`logic_first.md` 第 6 節）：`beliefCertainFacts`、
 *     `rule3PostLakeOnly`、`beliefChainProjection`、`forcedVoteZeroBits` 預設開
 *     （INV-B1 / B2 / B3 / H3a / H3b / F0 在 1970 局重播與 2000 局自我對打上為 0）。
 *     強度只回報（strength_benchmark.md 第 16 節）：藍方立場變強、紅方立場變弱
 *     （區間整個在 0 以下）→ 依第一關的規則照樣採用，紅方補償另開工作單。
 *   - 2026-10-22 第 1D 批（決策閘門，`logic_first.md` 第 7 節）：`teamDominanceGate`、
 *     `mustFailGate` 預設開（INV-T1 / V1 / K1 / K2 / P3 / L1 在 1970 局重播、探針與
 *     2000 局自我對打上為 0）。強度只回報（strength_benchmark.md 第 17 節）。
 *   - 2026-10-26 第 1E / 1F 批（派西 = 忠臣 + 拇指限制、派西藍方湖、紅方只做
 *     可能為真的宣告；`logic_first.md` 第 8 節）：`percivalLoyalVote`、
 *     `percivalCertainExclusion`、`percivalBlueLake`、`redPossibleClaimsOnly`
 *     預設開（INV-Pe2 / PL / R1 在 1970 局重播與 2000 局自我對打上為 0）。
 *     強度只回報（strength_benchmark.md 第 18 節）。
 *   - 2026-10-26 第 1G 批（刺殺：確定把梅林看得到的紅放進自己隊的隊長排在後面；
 *     `logic_first.md` 第 9 節）：`assassinVisibleRedTier` 預設開（INV-A2 在
 *     1970 局重播與 2000 局自我對打上為 0；審查後歸為第二關的規則，依重播的
 *     刺中率與一致性保留）；`assassinVisibleRedLikelihood` 審查後預設關。強度
 *     見 strength_benchmark.md 第 19、20 節。
 *   - 2026-10-26 Edward 裁定：`returnLake`（還湖）預設開；刺殺階段紅方開牌相認
 *     （`allEvilRoles`，梅林看得到的紅 = 莫德雷德以外的紅方）；第 5 次強制提議也算。
 *   - 2026-10-27 練習台實戰（派西在兩局失敗後贊成隊上有 0.95 嫌疑的人的隊、任務三張失敗）：
 *     `teamPassRank`（範圍見欄位說明）；預設值見 strength_benchmark.md 第 22 節。
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
  goodVouchFollowUp: true,
  teamReuse: true,
  redR1Teammate: true,
  percivalNoThumbsR1: true,
  percivalR1ThumbOnThumb: true,
  goodQuestSuccessGuard: true,
  assassinHeuristicVisibility: true,
  beliefCertainFacts: true,
  rule3PostLakeOnly: true,
  beliefChainProjection: true,
  forcedVoteZeroBits: true,
  teamDominanceGate: true,
  mustFailGate: true,
  percivalLoyalVote: true,
  percivalCertainExclusion: true,
  percivalBlueLake: true,
  redPossibleClaimsOnly: true,
  assassinVisibleRedTier: true,
  assassinVisibleRedLikelihood: false,
  returnLake: true,
  teamPassRank: 0,
  merlinDoomedRed: false,
  goodLeaderWorldPick: 0,
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
  goodVouchFollowUp: 'AVALON_TUNING_GOOD_VOUCH_FOLLOW_UP',
  teamReuse: 'AVALON_TUNING_TEAM_REUSE',
  redR1Teammate: 'AVALON_TUNING_RED_R1_TEAMMATE',
  percivalNoThumbsR1: 'AVALON_TUNING_PERCIVAL_NO_THUMBS_R1',
  percivalR1ThumbOnThumb: 'AVALON_TUNING_PERCIVAL_R1_THUMB_ON_THUMB',
  goodQuestSuccessGuard: 'AVALON_TUNING_GOOD_QUEST_SUCCESS_GUARD',
  assassinHeuristicVisibility: 'AVALON_TUNING_ASSASSIN_HEURISTIC_VISIBILITY',
  beliefCertainFacts: 'AVALON_TUNING_BELIEF_CERTAIN_FACTS',
  rule3PostLakeOnly: 'AVALON_TUNING_RULE3_POST_LAKE_ONLY',
  beliefChainProjection: 'AVALON_TUNING_BELIEF_CHAIN_PROJECTION',
  forcedVoteZeroBits: 'AVALON_TUNING_FORCED_VOTE_ZERO_BITS',
  teamDominanceGate: 'AVALON_TUNING_TEAM_DOMINANCE_GATE',
  mustFailGate: 'AVALON_TUNING_MUST_FAIL_GATE',
  percivalLoyalVote: 'AVALON_TUNING_PERCIVAL_LOYAL_VOTE',
  percivalCertainExclusion: 'AVALON_TUNING_PERCIVAL_CERTAIN_EXCLUSION',
  percivalBlueLake: 'AVALON_TUNING_PERCIVAL_BLUE_LAKE',
  redPossibleClaimsOnly: 'AVALON_TUNING_RED_POSSIBLE_CLAIMS_ONLY',
  assassinVisibleRedTier: 'AVALON_TUNING_ASSASSIN_VISIBLE_RED_TIER',
  assassinVisibleRedLikelihood: 'AVALON_TUNING_ASSASSIN_VISIBLE_RED_LIKELIHOOD',
  returnLake: 'AVALON_TUNING_RETURN_LAKE',
  teamPassRank: 'AVALON_TUNING_TEAM_PASS_RANK',
  merlinDoomedRed: 'AVALON_TUNING_MERLIN_DOOMED_RED',
  goodLeaderWorldPick: 'AVALON_TUNING_GOOD_LEADER_WORLD_PICK',
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
  if (name === 'goodLeaderWorldPick') {
    const value = raw === undefined ? 10 : Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`goodLeaderWorldPick needs a number ≥ 0, got "${raw}"`);
    return { goodLeaderWorldPick: value };
  }
  if (name === 'teamPassRank') {
    // 範圍 0–4；只寫名字 = 1（派隊與投票都用）。
    const value = raw === undefined ? 1 : Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || value < 0 || value > 4) throw new Error(`teamPassRank needs 0–4, got "${raw}"`);
    return { teamPassRank: value };
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
    if (key === 'teamPassRank') { if (t.teamPassRank) parts.push(`teamPassRank=${t.teamPassRank}`); continue; }
    if (key === 'goodLeaderWorldPick') { if (t.goodLeaderWorldPick) parts.push(`goodLeaderWorldPick=${t.goodLeaderWorldPick}`); continue; }
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
