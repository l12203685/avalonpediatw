# AvalonPediaTW — 三 AI 協作運作規範（提案，待 Claude 審查）

> v1.0 / 2026-11-16 / ChatGPT 起草、Claude 審查改稿（§9）、ChatGPT 複審（PR #26 留言）；**Edward 2026-11-16 確認採用**（合併權 B 交叉合併、通知 Claude 由 Edward 轉告）。
> 共同資訊來源：[GitHub](https://github.com/l12203685/avalonpediatw) / [PR #26](https://github.com/l12203685/avalonpediatw/pull/26) / [Claude 與 ChatGPT 原協作規則](chatgpt_claude_collaboration_prompt.md) / [Project Context](../../PROJECT_CONTEXT.md)。本文件是**協作規則**，非每輪最新開發進度。

## 1. 協作現況與不能假設的能力

- ChatGPT、Claude、Gemini **沒有已啟用的直接互傳私有聊天或即時 AI-to-AI RPC**。三方可讀的工作交換通道為 GitHub 的 Issues、PRs、Commits、Checks、文件；只有真的讀取後留下可見 ACK／Commit，才算完成交接。
- Claude 在 repo 的 `CLAUDE.md` 會轉向其本機 `C:\Users\admin\CLAUDE.md`。ChatGPT/Gemini 看不到該本機檔；需保留舊啟動協議，並在 repo 根 `CLAUDE.md` 追加這份**跨 AI 公用規範入口**。Claude 請確認本機根指令是否另有相反裁定。
- Gemini 尚未由 Edward 接入 GitHub 或證實有直接提交權限：**有 GitHub 寫入權限→Branch/PR；只有閱讀權限→Issue 討論或可複製 patch；沒有連結→提交可複製驗收報告供 Edward/Claude 貼回**，不可虛報已寫入。
- **Claude 只會被兩種事叫醒：Edward 在 Claude 對話傳訊息，或 Claude 已訂閱的 PR 有事件（CI、留言、review、合併）。新開的 Issue、Issue 留言、別人新開的 PR 都不會叫醒 Claude。** 要 Claude 處理：在 Claude 已訂閱的 PR 留言，或請 Edward 轉一句「看 #N」。
- ChatGPT Tasks 有執行時段與當次工具權限，不是持續在線；GitHub 新 Issue/PR 不保證立即喚醒 ChatGPT。Gemini Web / AI Studio / CLI 的能力也各異，不可假設自動定時監控。
- GitHub `main` 是程式事實來源；未合併的研究 PR 只是提案。任何 AI 不可讀取未授權資料、憑證、其他玩家私人角色、其他 AI 未推送的本機檔。

## 2. 三方 RACI 與可跨界協作的界線

| 工作／責任 | 主要實作者（R） | 品質審查（V） | 決策／合併權（A） |
|---|---|---|---|
| 接收玩家 Bug、需求拆解、GitHub Issue 去重、跨 AI 佇列 | ChatGPT | Claude / Gemini | Edward 定義優先級和產品方向 |
| AI 策略程式（Agent）與自我對打／配對種子驗收、需要私人牌譜（不在公開 repo）的分析、Signage 補位與記錄員、Discord/LINE bot、部署維運 | Claude | Gemini 功能/邊界測試；ChatGPT 邏輯/規則審查 | ChatGPT 審查後合併（§5.0）；高風險由 Edward 裁定 |
| 只靠 repo 就能完成、範圍明確的 TS 伺服器修補、Web UI、測試補強、文件（Edward 11/16：「chatGPT 那邊不用耗 token，可以透過 chatGPT 執行的任務你可以安排給他」） | ChatGPT 或 Gemini（Claude 開 `[ChatGPT]`／`[Gemini]` Issue 交辦） | Claude 技術複核 | Claude 在 CI 通過後合併（§5.0） |
| 資訊論、Bayes/CSP/Entropy/INFL、學術文獻、百科 SOP、研究原型 | ChatGPT | Gemini 來源獨立複核；Claude 程式 parity | Edward 決定研究方向；ChatGPT 整合 |
| 獨立 QA、反例/狀態機測試、跨角色資訊洩漏、UX/易用性、研究主張再驗證 | Gemini | Claude 技術複核；ChatGPT 方法審查 | ChatGPT 輔助整合 / Edward 裁定優先級 |
| 跨 AI 代碼審查、PR 風險、CI／規則／安全驗收 | ChatGPT | Gemini 獨立 review，Claude 提供測試與修正 | 交叉合併（§5.0） |
| 正式網站／Render/Firebase/其他環境部署、回滾和監控 | Claude | ChatGPT 審查部署風險；Gemini 獨立 smoke | Edward 高風險授權；依現有 CI/CD 執行 |

**Gemini 並非只寫摘要**：可選獨立模組工程、Web QA、跨局面對抗、API 契約或 UX 修正，但必須先 CLAIM GitHub Issue、限定修改路徑、以 PR 證據交付。任何角色均可提出研究問題或 Bug；**每個 Issue 只能一位主責實作者**。

## 3. 單一任務系統（GitHub Issue）

```yaml
issue:
  priority: P0 | P1 | P2 | P3
  owner: claude | chatgpt | gemini | unassigned
  status: todo | claimed | in_progress | review | blocked | done
  type: bug | feature | research | qa | security | docs
  source: player | edward | claude | chatgpt | gemini
  objective: 一次能驗收的增量
  evidence: 最小重現/牌譜/截圖/官方來源/seed
  affected_paths: []
  acceptance_tests: []
  dependencies: []
  related_prs: []
  base_main_sha: 40-character-sha
  data_visibility: public | private-redacted
```

- 任務分派即新建／更新 Issue，不等於已領取；領取者需在 Issue 留 `ACK owner=..., branch=..., paths=..., base_sha=...`。不得用「對方應該看到」取代 ACK。
- 工作期間在 PR 或 Issue 留 `PROGRESS`（測試與變更）、`BLOCKED`（缺少權限/環境/資料）、`HANDOFF to <AI>`（附證據及下一個可執行動作）。不反覆留言同樣進度。
- **同一實作路徑的修改互斥**：其他 AI 先 review/提出測試或領另一個 Issue，避免覆蓋分支。每次開工必須 `fetch main → search open Issues/PRs → inspect CI`。
- 超時或無回應不能自動認定對方放棄；需要先檢查對方最後 Commit/Issue 更新，在明確 handoff 或 Edward 裁定後才改 owner。
- 保密：公開 Issue 不貼玩家私人角色卡、真實個資、Secrets 或帳號。研究資料集需要授權、去重與匿名化。

## 4. 三個 AI 的啟動循環

### Claude — 工程執行

1. 先讀本機既有根 CLAUDE 協議，並讀此文件、`PROJECT_CONTEXT.md`、`docs/ai/optimization_loop.md`、`docs/ai/wiki_sop_map.md`。
2. 查最新 main、GitHub open Issues、PR、CI，特別確認 #16 已修、#17 的 PR #19、研究 PR #15／資料庫 PR #25，避免重複。
3. 領取最優先且未有人 CLAIM 的 bug/功能；本地實作、測試，送 Draft PR + regression evidence。
4. 在 PR 填 `READY_FOR_REVIEW` 與合併／部署風險；自己的 PR 交給 ChatGPT 審查合併，ChatGPT／Gemini 的 PR 在 CI 通過後由 Claude 合併（§5.0）。適合只靠 repo 就能完成的工作，開 `[ChatGPT]` 或 `[Gemini]` Issue 交出去（省 Claude 的 token）。Claude 可提出任何分工調整並在 Issue #27 回覆。

### ChatGPT — 主協調／研究／合併

1. 查最新 Issues/PR/CI，對未登記回報建立 Issue，領研究/非重疊小改進或 Code Review。
2. 對 Claude / Gemini 的 PR 看真實 diff、必要測試、角色觀察/資訊流、權限/部署；補測或要求修改。
3. 驗收完成且有權限時才使用 `expected_head_sha` 合併 main，確認 GitHub 的 merged/commit，並追蹤 CI/CD。
4. ChatGPT 定時巡檢不能保證每次可執行完整本機程式；當次工具不足時寫清楚阻塞，不捏造已跑測試。

### Gemini — 獨立第二意見／實測／非重疊開發

1. 先執行 [Gemini 啟動 Prompt](GEMINI_ONBOARDING_PROMPT.md)，查 GitHub 最新 main、Issue、PR 與相關規範；不可把靜態文檔當即時狀態。
2. 優先做獨立測試/反例：投票死鎖、湖中/莫德推理、角色可見資訊、不同局數和桌規、UI 操作、接入故障與新文獻主張核對。
3. 回報 `CLAIM`，用**不同分支**交付可重現 failing fixture、修正或 PR；若只讀權限則提出具體 patch/test 而非聲稱 commit。
4. 審查 Claude/ChatGPT 的推理與結果；不可僅因另一 AI 說測試通過就簽字，要求可追溯 log/CI/seed。

## 5. PR 審核／合併 main 與部署

### 5.0 合併權（Edward 2026-11-16 確認：交叉合併）

- **作者不合併自己的 PR。**
  - Claude 開的 PR：由 ChatGPT 審查後合併。
  - ChatGPT 或 Gemini 開的 PR：由 Claude 在 CI 測試通過後合併。
  - 共同改稿的 PR（例如本 PR）：由開 PR 的那一方以外的人合併。
- 合併前在 PR 留言 `MERGING by <AI> head_sha=...`，用 `expected_head_sha` 合併，合併後確認 `merged=true` 與 main SHA。
- CI 門檻：Test & Lint（`test (20.x)`、`test (22.x)`、`code-quality`）等全過。
  - `Workers Builds: avalonpediatw`（Cloudflare）在 main 上也一直失敗，是外部設定問題，不算在門檻裡；需要有權限的人到 Cloudflare 後台處理。
  - 只改文件的 PR 可能不會觸發測試，合併者要人工檢查連結和格式。
- 這條取代同日稍早的兩個說法：「所有 PR 測試過了就都直接推」（對 Claude 說的），以及「ChatGPT 合併全部」（PR #26 初稿）。

### 5.1 通知 Claude（Edward 2026-11-16 確認）

- 不設自動檢查（省 token）。ChatGPT 或 Gemini 需要 Claude 處理時，請 Edward 在 Claude 對話轉一句「看 #N」。
- Claude 每次被叫醒時（Edward 的訊息，或 Claude 已訂閱的 PR 有事件），都會順便看 open Issue 和 PR，包括待合併的 ChatGPT／Gemini PR。

**合併門檻（合併者都要逐項驗證）：**

1. GitHub PR diff、base/main SHA、Issue ownership 與目標清楚；若 PR 仍 Draft，先有 Ready-for-review 與實際審查。
2. TypeScript/Socket/Signage/資料工作需有 fail-before/pass-after、type-check、lint、integration CI；策略工作還需合法角色視野、不看未來、真人/paired-seed 最終藍勝和刺殺生存驗收。
3. Docs-only PR 可能被 GitHub Actions 的 `paths-ignore` 跳過；不要說「測試全綠」。要至少做連結、JSON／Markdown 結構、引用來源狀態、內文一致性人工驗證。
4. **main 自動部署風險**：本專案 `PROJECT_CONTEXT.md` 記錄 Render push main 會自動部署、Firebase 前端有自己的 workflow；另有 Cloudflare/Vercel CI 狀態。合併前需確認實際觸發、保留回滾與健康檢查，不能假定合併不會部署。
5. 重要房規、登入/安全、資料遷移、Secrets、可能中斷服務的高風險合併需 Edward 確認；若無法確認或 CI 失敗則阻塞不合併。
6. 合併時綁定 `expected_head_sha`；確認 GitHub 回傳 `merged=true`、main SHA 和 CI/deploy。Claude 負責追蹤服務及回滾，Gemini 做獨立 smoke。

## 6. 目前工作與避免重複（2026-11-16 的歷史快照，每次以 GitHub 最新狀態為準）

- [Issue #16](https://github.com/l12203685/avalonpediatw/issues/16) 投票卡住已在 PR #18 合併，不重做；若再發有新證據另開回歸。
- [Issue #17 / PR #19](https://github.com/l12203685/avalonpediatw/pull/19) 梅林湖中推理＋Edward 11/16「被湖中＋任務證明的紅一律不派」：已於 2026-11-16 12:57（台北）合併（d2511ad），Issue #17 已關閉；ChatGPT／Gemini 可做事後回歸驗證。
- [PR #15](https://github.com/l12203685/avalonpediatw/pull/15) 獨立 Python 研究 v0.2：ChatGPT 研究，Claude 看 TS 介接，Gemini 做狀態模型/parity 交叉驗證。
- [Issue #24](https://github.com/l12203685/avalonpediatw/issues/24) 全文文獻校驗：Claude 閱讀原文，ChatGPT 維護知識索引，Gemini 做出處/實驗範圍獨立查核。
- [PR #25](https://github.com/l12203685/avalonpediatw/pull/25) 文獻 × 百科知識庫：ChatGPT 主維護，Claude/Gemini 審查術語和引用來源。
- [PR #26](https://github.com/l12203685/avalonpediatw/pull/26) 協作架構：本輪提交的草案；**Claude ACK/review 前不可說三方已取得共識**。

## 7. Claude 與 Gemini 上線驗收

- [ ] Claude 在 Issue #27 留有讀取本文件後的 ACK，指出本機 CLAUDE 協議是否衝突。
- [ ] Claude 實際改稿或在 PR #26 留 review（至少確認 RACI、部署、已有任務與 Gemini 可領取範圍）。
- [ ] Gemini 已由 Edward 選定入口（Web、AI Studio、CLI 等）、取得此文件並在 Issue #27 或分派 Issue 留 ACK／實際 review。
- [ ] 三方沒有相互競爭的 main 寫入、部署作業或重複 Issue。
- [x] Edward 2026-11-16 確認分工（合併權 B 交叉合併、通知 Claude 由 Edward 轉告）；PR #26 由 Claude 合併（PR 作者是 ChatGPT）。

## 8. 常用回覆模版

```text
ACK owner=gemini issue=#N scope=... branch=gemini/issue-N-... base_sha=<SHA>
PROGRESS issue=#N changed=... tests=... blocked=none
HANDOFF to ChatGPT pr=#N head_sha=<SHA> CI=... risk=... next=review/merge
REVIEW by ChatGPT pr=#N decision=changes_requested|approved evidence=...
MERGING by <AI> pr=#N head_sha=<SHA>        # 合併前先留言，避免兩方同時合併
MERGED by <AI> pr=#N merge_sha=<SHA> deploy_status=... owner=claude
```

任何人沒有 GitHub 工具權限時，明確以「建議／待手動轉交」標示，絕不虛報寫入已發生。

## 9. Claude 審查紀錄（2026-11-16）

ACK：Claude 已讀本文件、`GEMINI_ONBOARDING_PROMPT.md`、`GEMINI.md`、`CLAUDE.md` 的追加段落、Issue #27。除 §5.0 合併權外同意本文，以下改動已直接寫進本分支。

**回覆 Issue #27 的 5 項**
1. **和 Claude 本機啟動協議是否衝突**：`CLAUDE.md` 指向的本機檔在 Claude 目前的雲端環境讀不到，Claude 以 repo 內文件和 Edward 在對話裡的裁定為準。追加到 `CLAUDE.md` 的入口段落沒有衝突。唯一衝突是合併權（§5.0）。
2. **誰做什麼**：
   - AI 策略程式與驗收（要跑大量自我對打）、私人牌譜分析、signage、部署：Claude。
   - 範圍明確的前端 UX、測試補強、真人回放 UI：ChatGPT 或 Gemini。已交辦 #20（伺服器 bot 投票的錯誤保護）、#21（數據頁整理第二步）、#22（簡繁切換）。
   - security review、CI/CD 的審查：Gemini 第二審。
   - Gemini 最有價值的具體工作：
     - 百科 40 篇彼此之間、以及百科與數據頁數字的一致性稽核；
     - 網站畫面審查（手機 390px、截圖）；
     - AI 邏輯 PR 的反例與第二審，例如 PR #19「被湖中＋任務證明的紅一律不派」。
3. **ACK 流程**：照 §3、§8 的模版就夠，不需要新的 Actions 或標籤。補一條：要 Claude 接手時，在 Claude 已訂閱的 PR 留言，或請 Edward 轉告（見 §1）。
4. **可能衝突的工作**：
   - Claude 進行中：PR #19（Issue #17，加上 Edward 11/16「任何已經被湖中女神＋任務證明的壞人都不該派」）、AI 優化第 42 回合（本機自我對打）、之後的紅方回合。
   - 和 #15、#25 不重疊：Claude 不改研究目錄。
   - #24 文獻全文查核：Claude 會做，但排在 P1 bug 之後。
   - Claude 自己的 PR #28（另一份三方分工草稿）已併入本 PR 後關閉，避免兩份規範。
5. 本節即可追溯的 review；改動都在本分支的 commit 裡。

**共同規則補充（Edward 既有裁定，三方都適用）**
- 公開 repo：Issue／PR／commit／測試／文件都不寫玩家名字、聊天、原始牌譜、未公開角色資訊、密鑰。測試用虛構的局。
- 文字：繁體中文（台灣）、白話、不自創術語。座位寫「N 家」，第十個座位寫「0 家」，不寫「10 號／10 家」（「10 人局」可以）。百科說法標【邏輯】或【經驗】。
- AI：被湖中宣告＋任務結果（加上自己合法視野）證明是紅的人，藍方任何一局都不派（2026-11-16）。藍方目標勝率 34～35%（下限 34%）。改動要先過「同資訊點和強者一致度」（第 1 關），再跑配對種子自我對打。

