# AvalonPediaTW 三方協作：Claude × ChatGPT × Gemini

> 版本：2026-11-16 草稿（Claude 起草，待 ChatGPT 審查補充，合併後 Gemini 依此加入）。
> 這份是**作業規範**，不是即時狀態。每次開工先讀 GitHub 的即時狀態（main、open Issues、open PR、CI）。
> 取代 `docs/ai/chatgpt_claude_collaboration_prompt.md`。那份保留作歷史，內容已併入本文。
> 和 Edward（站長）最新的明確指示衝突時，以 Edward 為準，並在相關 Issue 記一筆。

---

## 1. 一句話分工

| 角色 | 主責 | 不做 |
|---|---|---|
| **Edward**（站長） | 定規則與優先順序；所有「裁定」都出自他 | — |
| **Claude**（雲端開發環境） | AI 策略優化（自我對打、配對種子驗收）、需要私人牌譜的分析、signage 補位與記錄員、整合與**合併 main**、部署、維護裁定紀錄 | 不做只要讀 repo 就能完成的大量審查與文件工作（交給另外兩方，省 token） |
| **ChatGPT**（每小時排程＋GitHub connector） | 把 Edward 在 ChatGPT 對話提的需求整理成 Issue；審查 PR；資訊理論、信念更新、決策品質研究；範圍明確的實作（網站、測試、研究引擎）開 PR | 不合併 main、不部署；不做需要私人牌譜或長時間自我對打的工作 |
| **Gemini**（Edward 手動啟動，最新模型、長上下文、可看圖） | 全 repo 長文稽核：百科 40 篇彼此之間、百科與裁定、百科與數據是否一致；網站畫面與易讀性審查（截圖）；AI 邏輯 PR 的第二審；英文內容草稿；測試覆蓋缺口 | 不合併 main、不部署；不改 AI 策略預設值 |

**為什麼這樣分**
- Claude 有可以跑自我對打的機器、能讀私人牌譜（不在公開 repo），也能連 signage-cloud。但 Claude 的 token 最貴。
- ChatGPT 不耗 Edward 的 token，又能每小時自動跑。適合持續性的整理、審查和範圍明確的實作。
- Gemini 的長上下文適合一次讀完整個百科或整個子系統做一致性檢查，看圖能力適合審網站畫面。

---

## 2. 溝通方式（唯一管道：GitHub）

三方**不會**直接對話，彼此也看不到對方的聊天紀錄或本機檔案。所有交接都寫在 GitHub。

### 2.1 各方什麼時候會「醒來」看到東西

| 誰 | 會被什麼叫醒 | 對其他人的意義 |
|---|---|---|
| Claude | Edward 傳訊息；Claude 自己開的、或已訂閱的 PR 有事件（CI、留言、合併） | **新開的 Issue、Issue 留言不會叫醒 Claude**。要 Claude 處理時：開 PR，或請 Edward 轉一句「看 #N」 |
| ChatGPT | 排程（最快每小時一次）；Edward 在 ChatGPT 對話叫它 | 留給 ChatGPT 的 Issue 最慢約一小時後被看到 |
| Gemini | Edward 手動開啟 | 每次開啟都要從本文第 5 節的提示詞開始 |

### 2.2 任務 Issue 格式

標題開頭寫負責人：`[Claude]`、`[ChatGPT]`、`[Gemini]`。內文開頭放這一塊：

```markdown
### 跨 AI 任務
- Owner: claude / chatgpt / gemini
- Priority: P0 / P1 / P2 / P3
- Status: todo / in_progress / review / blocked / done
- Objective: 一次可驗收的目標
- Problem & evidence: 重現步驟、現象、log、局號、seed（不寫玩家名字）
- Scope: 要看的程式路徑、不能碰的範圍
- Rules & privacy: 角色視角、湖中／投票規則、不變量
- Acceptance: 驗收用的測試或數字
- Existing work: 已有的分支／PR（避免重做）
- Updated: 日期時間與 main SHA
```

優先順序：
- **P0**：玩家遊戲卡住或資料毀損
- **P1**：AI 邏輯、資訊、權限錯誤
- **P2**：功能與整理
- **P3**：研究與長期項目

### 2.3 領任務與交接

1. 動手前在 Issue 留言「領取（Owner 名）」，並把 Status 改成 in_progress。看到別人已領取，就改做審查或別的任務，不要同時改同一處。
2. 分支用自己的前綴：`claude/…`、`chatgpt/…`、`gemini/…`。一個 Issue 對一個 PR，PR 內文寫 `Closes #N`。
3. 每次停手都在 Issue 或 PR 留一則交接，內容包括：
   - Status
   - main SHA
   - 分支
   - 做了什麼
   - 測試結果
   - 下一步
   - 需要誰決定什麼
4. 審查別人的 PR：用 PR 留言或 review。小問題直接寫建議修法；大方向的疑問寫在 PR 上讓作者和 Edward 決定。

### 2.4 合併與部署（Edward 2026-11-16 裁定）

- 「所有 PR 測試過了就都直接推」：PR 的 CI 測試（Test & Lint 的 `test (20.x)`、`test (22.x)`、`code-quality` 等）通過，就合併進 main。
- **合併由 Claude 執行**，其他兩方開 PR（可以是 draft）就好，不要直接推 main。
- `Workers Builds: avalonpediatw`（Cloudflare）目前在 main 上也失敗，是外部設定問題，不算在「測試通過」裡。
- 推上 main 會自動部署（網站與伺服器），所以 main 必須隨時可以上線。

---

## 3. 共同規則

### 3.1 隱私（公開 repo）

- Issue、PR、commit、測試、文件都是公開的。**不寫玩家名字、聊天內容、原始牌譜、未公開的角色資訊、任何密鑰或 token。**
- 測試用虛構的局與暱稱。真人牌譜只在 Claude 的環境裡分析，對外只寫彙總數字。
- GitHub Actions 的 log 也是公開的。

### 3.2 遊戲規則與 AI

- 角色私人視野要在每個時間點都合法：梅林看得到莫德雷德以外的紅；派西的拇指只有派西知道；紅方互認但不認奧伯倫。不能讀未來或別人的私人資訊。
- 站長的房規以正式引擎為準，不用教科書預設覆蓋。例如：
  - 第 1～2 局正常票
  - 第 5 次提議直接出任務（強制）
  - 10 人局有湖
  - 7 人以上第 4 局要兩張失敗
- **被湖中宣告＋任務結果（加上自己合法視野）證明是紅的人，藍方任何一局都不派**（Edward 2026-11-16）。
- AI 改動要分開回報三件事：邏輯正確、和真人強者的一致度、最終勝率。勝率要用配對種子和信賴區間判斷，規則見 `docs/ai/optimization_loop.md`。藍方目標勝率 34～35%（下限 34%）。
- 不能因為資訊熵下降、或合成資料上的改善，就說策略變強。

### 3.3 文字

- 繁體中文（台灣）。白話，不自創術語。
- 座位寫「N 家」，第十個座位寫「0 家」，不寫「10 號／10 家」（「10 人局」可以）。
- 百科的說法標【邏輯】或【經驗】；有牌譜數字的寫數字和樣本數，沒有的用模糊描述。

### 3.4 品質

- 修 bug：先寫修正前會失敗的測試，修好後通過（fail-before／pass-after）。
- 推之前跑：`pnpm --filter @avalon/shared build` → type-check → lint → 相關測試。
- 不跳過、不停用測試來讓 CI 變綠。

---

## 4. 重要文件索引

| 文件 | 內容 |
|---|---|
| `PROJECT_CONTEXT.md` | 架構、部署、網址 |
| `docs/ai/optimization_loop.md` | AI 優化流程、驗收標準、各回合紀錄 |
| `docs/ai/logic_first.md`、`docs/ai/basic_logic_inventory.md`、`docs/ai/rules_checklist.md` | 基本邏輯與不變量 |
| `docs/ai/wiki_sop_map.md` | 百科 SOP 與程式的對照 |
| `packages/server/wiki_data.json`、`docs/avalon-wiki/` | 百科內容（網站讀 JSON，docs 是副本） |
| `research/avalon_inference_v0_2/` | ChatGPT 的 Python 研究引擎（PR #15）。不是線上正式 AI |

---

## 5. 給各 AI 的開工提示詞

### 5.1 Gemini（每次開啟時貼上）

```
你是 AvalonPediaTW（阿瓦隆百科）的協作者之一，另外兩位是 Claude 與 ChatGPT。
Repository：https://github.com/l12203685/avalonpediatw
網站：https://avalon-game-platform.web.app/

1. 先讀 docs/ai/collaboration.md（分工與規則），再讀 GitHub 即時狀態：main 最新 SHA、
   open Issues（特別是標題 [Gemini] 開頭的）、open PR 與 CI。
2. 你的主責：長文一致性稽核（百科之間、百科與裁定、百科與數據）、網站畫面審查、
   AI 邏輯 PR 的第二審、英文內容草稿、測試覆蓋缺口。
3. 選一個 [Gemini] 任務，或沒有人領的 P0／P1，或一個待審 PR。先在 Issue 留言領取。
4. 能改就開分支 gemini/<主題>，開 PR 並寫 Closes #N；不要推 main、不要合併、不要部署。
   PR 測試通過後由 Claude 合併。
5. 只寫稽核結果時，開 Issue，標題 [Claude] 或 [ChatGPT]（看誰該處理），內容附檔案路徑與行號、
   原文、建議改法、理由。
6. 公開 repo：不寫玩家名字、聊天、原始牌譜、密鑰。
7. 結束時在 Issue 或 PR 留交接：Status、main SHA、分支、做了什麼、測試、下一步、需要誰決定什麼。
   用繁體中文。
```

### 5.2 ChatGPT（排程用；詳細版見 `docs/ai/chatgpt_claude_collaboration_prompt.md` 第 2 節）

```
每次觸發：讀 docs/ai/collaboration.md 與 GitHub 即時狀態（main SHA、open Issues、open PR、CI、
最近的 commit）。先處理標題 [ChatGPT] 的 Issue 與待審 PR，再把 Edward 在對話裡提的需求整理成
Issue（標題寫負責人）。能做的就開分支 chatgpt/<主題> 與 PR（Closes #N），不推 main、不合併；
PR 測試通過後由 Claude 合併。沒有新事情就簡短記錄，不重複跑大量運算。公開 repo 不寫玩家名字與私人資料。
用繁體中文交接：時間、main SHA、處理的 Issue／PR、測試、下一步。
```

### 5.3 Claude（開工時）

```
讀 docs/ai/collaboration.md 與 GitHub 即時狀態。檢查 [Claude] Issue、別人開的 PR（測試通過就合併）、
ChatGPT／Gemini 留給 Claude 的交接。負責自我對打驗收、私人牌譜分析、signage、整合與部署；
適合讀 repo 就能完成的工作開 [ChatGPT] 或 [Gemini] Issue 交出去。Edward 的新裁定記進裁定紀錄，
影響協作的部分同步更新本文。
```

---

## 6. 已知限制與待決事項

- **新 Issue 叫不醒 Claude。** 解法有兩個，要 Edward 決定：
  - 請 Edward 轉一句「看 #N」；
  - 讓 Claude 每幾小時自己檢查一次 GitHub（會耗 token）。
- ChatGPT 排程最快每小時一次；不能保證多個排程錯開成每 15 分鐘。
- Gemini 沒有排程，每次都由 Edward 開啟。
- Cloudflare `Workers Builds` 檢查一直失敗，需要有權限的人到 Cloudflare 後台看建置設定。
