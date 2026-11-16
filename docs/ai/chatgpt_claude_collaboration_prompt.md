# AvalonPediaTW — ChatGPT × Claude 協作交接／排程執行 Prompt

> 2026-11-16 (Asia/Taipei)。此文件是跨 AI 協作的作業規範，不是某一次執行的最新狀態；每輪先讀 GitHub。  
> Repository: https://github.com/l12203685/avalonpediatw  
> Website: https://avalon-game-platform.web.app/  
> Claude 開發需維持既有根目錄 `CLAUDE.md` 的指示。該檔指向開發者**本機** `C:\Users\admin\CLAUDE.md`，ChatGPT 無法讀本機，不得假設已同步。  
> 若和 Edward 最新指示或現行專案裁定衝突，以最新明確裁定為準並在 Issue 記錄。

## 1. 給 Claude 的可直接執行交接指令

你與 ChatGPT 共同維護 AvalonPediaTW。Edward 會直接在 ChatGPT 對話提出 Bug、玩家回饋、研究與功能需求；ChatGPT 會在有權限時建立 GitHub Issue、審查、獨立研究和建立 Draft PR。**GitHub 是正式且可追溯的唯一協作交換站**。Claude 無須等待 Edward 人工轉貼 ChatGPT 回報；應在每次工作開始讀最新 GitHub Issues／PR／main。

工作開始：
1. `git fetch`；確認最新 `main` SHA、未結案 Issues、進行中的 PR、CI、最近 Commit（特別是 Claude 與 ChatGPT 互相提交的內容），檢查有無同項工作已在其他分支進行。
2. 讀 `docs/ai/optimization_loop.md`、`docs/ai/wiki_sop_map.md`、`docs/ai/rules_checklist.md`、相關程式和測試。研究引擎如尚未合併 main，從 [研究 Draft PR #15](https://github.com/l12203685/avalonpediatw/pull/15) 及其分支讀；**它不等於線上正式 AI**。
3. 依 P0 使用者遊戲阻塞、P1 邏輯/情報/權限錯誤、資料品質、可重現策略偏差、研究工程等優先級領一項可完成的工作。若別的 AI 已在修此 issue，改以審查、補測試、研究或領取其他 issue 為主，避免互相覆寫。
4. **交付必須有**可重現條件、fail-before/pass-after 回歸測試、型別/CI、不變量驗證、清楚標記的分支與 PR。不能實作就留下具體阻塞和下一步，不能虛報修復或部署。
5. 在相應 Issue／PR 回報：Owner、Status、main SHA、分支、測試、CI、下一步，便於另一方接續。

**任務派給 ChatGPT 的格式**（GitHub Issue 內文，標題可加 `[ChatGPT]`；有既有標籤體系則依其體系，不要大量新增裝飾標籤）：

```markdown
### 跨 AI 任務
- Owner: chatgpt
- Priority: P0/P1/P2/P3
- Status: todo / in_progress / review / blocked / done
- Objective: 一次可驗收的目標
- Problem & evidence: 重現步驟、現象、log／局號／seed
- Scope: 應查程式路徑與不能碰的範圍
- Rules & privacy: 角色視角、湖中／投票規則、不變量
- Acceptance: 最小重現與預期通過的測試
- Existing work: 已有分支／PR URL（避免重做）
- Updated: 日期時間與 SHA
```

**任務完成的定義**：不能只回答策略想法，需可驗證的程式／測試／分析或明確阻塞證據。正式部署、合併 main、改變 Edward 的既有裁定需要照專案權限及審查流程處理。

## 2. 給 ChatGPT 排程任務的完整執行指令

每一次觸發：針對 AvalonPediaTW **先讀 GitHub 即時狀態再做事**，從 https://github.com/l12203685/avalonpediatw 取得 main 最新 SHA、open Issues（包含 `[ChatGPT]` 任務／Bug／玩家回饋）、open PR／CI、近期 Claude 提交、`docs/ai/optimization_loop.md`、`docs/ai/wiki_sop_map.md`、本協作文件及研究 Draft PR #15。檢查網站可驗證的狀態。

從新／未完成 Issue 中選擇一個高影響且無其他人處理的工作；必要時對照 Claude 現有修正、直接審查 PR。遇到重複、已合併、已有修復 PR 的任務不要重做。可執行時進行最小修正或研究、回歸測試、在獨立分支提出 Draft PR 並關聯 Issue，**不直接覆寫 main／合併／部署**。研究策略要遵守角色私有資訊隔離與資訊流，不能把合成 IG 當成真實勝率改善。當次無法實作則留下確切障礙與可執行下一步；沒有新任務則簡短回報無變化，不重複跑大量模擬。

每次繁中簡報：台北時間、main SHA、Claude 新 Commit／PR、待處理 Issues、已重現或已修問題、實際實作／測試／CI、PR URL、下一步。GitHub 為共享記憶，ChatGPT 並不能無條件看到 Claude 未推上的本機檔案或其其他聊天的私人記憶。

## 3. 2026-11-16 已知的協作狀態（只供定位，必須刷新）

- [#16 百科 AI 黑白球投票卡住](https://github.com/l12203685/avalonpediatw/issues/16)：Claude 已從 signage-cloud 練習台接入 `packages/server/scripts/signagePlayer.ts` 找到湖結果解析／決策佇列問題，修正 [PR #18](https://github.com/l12203685/avalonpediatw/pull/18) **已合併**，Issue 已關閉；勿再用舊狀態把它當成待實作。若再現，應附新 log 和環境差異。
- [#17 梅林湖中宣告、拇指與莫德雷德推理](https://github.com/l12203685/avalonpediatw/issues/17)：Claude 已有 [Draft PR #19](https://github.com/l12203685/avalonpediatw/pull/19)，修 `merlinReuseFill` 可能補進依合法湖中／視野可推得的紅方座位；優先審查該 PR、比對既有 Certainty／LogicGates／MerlinLoyalStyle，不重寫相同修正。
- [#15 跨對話研究引擎 v0.2](https://github.com/l12203685/avalonpediatw/pull/15)：ChatGPT 新增 Python 獨立事件回放／私人視角隔離，35 個 Python 測試通過，**尚未整合進正式 TS 產品**。下步是 TS 事件轉接、snapshot parity、真人資料校準。
- Wiki SOP `docs/ai/wiki_sop_map.md` 的 180 條是盤點基準，狀態可能在後續 commits 變動。AI 成效以 `docs/ai/optimization_loop.md` 規定的任務成功 × 刺殺存活之最終藍方勝率驗證，需 paired-seed 與合法信賴區間判斷。

## 4. 排程、觸發和實際能力

Edward 希望 Claude 可以頻繁派任務給 ChatGPT。**ChatGPT 排程目前支援的最高頻率是每小時一次，不可保證四個互相錯開的排程形成每 15 分鐘執行。** 用戶若自行編輯排程，請依 ChatGPT 介面實際允許設定為準。GitHub 事件觸發是另一種可能：特定 ChatGPT Work 環境支援 GitHub PR 活動觸發，但**GitHub Issue 的建立與分派不可假設可以直接喚醒 ChatGPT**；必須有實際支援的 webhook／connector。

排程觸發≠每次均有完整本機開發環境；每輪確認權限、相依套件、測試／CI、各類額度，沒有權限就留下可交付審查與交接，不要宣稱已自動執行 Claude 本機操作。

## 5. 安全與回歸護欄

- 禁止從未揭露真身分、敵方視野、未來事件偷看資訊；角色視角在每一 event_seq 必須合法。
- R1–R2 正常票、第五次提案強制通過、10 人湖、7+ 第四任務雙失敗、專案已裁定變體等要照正式 Engine，不用教科書預設覆蓋站長規則。
- 修正 AI 強度不能只測任務勝率：需測最終勝率、梅林曝光／刺殺、生存與對手適應性。
- 不把公開 Issue 寫入敏感憑證、未經授權的玩家個資或未揭露角色私有資料。
- 高影響改動保留 feature flag、測試、可回退機制。
