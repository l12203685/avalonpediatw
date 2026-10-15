# D：練習模式畫面審查修正

分支：`gpt/practice-ui`。基底更新至 `origin/main`（`0e38727`）。未推 main、未開合併 PR。

## 變更

沿用 `lane/r6-room` 與 `wip/r6-room-fix` 的版面方向，重新驗證並補完。寬度至少 640px 的牌桌依可用高度計算側欄；大廳設定、行動提示及操作列放在中欄。高度不超過 640px 時使用橫卡，讓名字仍有足夠寬度。

| 檔案 | 用途 |
|---|---|
| `packages/web/src/components/GameBoard.tsx` | 卡片與欄寬公式、中欄操作列、通知定位 |
| `packages/web/src/components/PlayerCard.tsx` | 窄卡圖示縮放、資訊分層、名字與角色字級、泡泡 portal |
| `packages/web/src/components/QuestTeamToolbar.tsx` | 依中欄寬度調整人數與按鈕，避免平板截字 |
| `packages/web/src/components/ToastContainer.tsx` | 讀取牌桌中欄定位，離開房間後回復預設 |
| `packages/web/src/hooks/useMediaQuery.ts` | 共用寬視窗條件 |
| `packages/web/src/pages/RoomPage.tsx` | 大廳與遊戲操作配置、準備／踢人圖示分離 |

沒有修改伺服器遊戲邏輯、AI、模擬瓦、Gemini 的測試基礎建設或 e2e。

## 審查缺陷處理

| 原問題 | 處理與驗收 |
|---|---|
| 投票球／任務盾遮住名字 | 窄卡底部改為圖示列 → 賽後角色 → 名字，圖示不再壓在名字兩端 |
| 640–767px 或低於 500px 高度未套用新版 | 寬視窗門檻改為寬度至少 640px，不再限制最低高度 |
| 派西維爾／莫德雷德標籤被截 | 角色依字數縮放；矮視窗改橫卡提供足夠寬度 |
| 大廳三、四字名字被截 | 大廳設定移到中欄；名字可縮字及換成兩行；寬視窗量測沒有名字溢出 |
| 準備勾勾與踢人 X 重疊 | 寬視窗勾勾置中，踢人仍在右上角 |
| AI 徽章蓋住紅方問號 | 窄卡 AI 標記移到名字前方；問號依卡寬縮放 |
| 平板派隊提示與「已選」被截 | 依工具列容器寬度縮小字級／按鈕；次要提示只在至少 36rem 時顯示 |
| 賽後泡泡遮住自己的角色 | 桌機泡泡移到卡片側邊，不覆蓋角色列 |
| 手機泡泡變短 | 手機泡泡保留卡片下方位置，以 portal 顯示，寬度最多 140px，不受卡寬限制 |
| 矮桌機兩側仍捲動、圖示占滿卡片 | 高度不超過 640px 時橫卡；圖示另限制為 16px／18px；500px 與 480px 高度均驗收 |
| 右下通知蓋住第五張卡 | 房內通知移至中欄聊天區，也避開手機底部投票按鈕 |

## 瀏覽器驗收

Playwright + Chromium 153。先實際從首頁「與機器人練習」建立十人房間，確認首頁 → API／Socket.IO → 牌桌可用。接著在同一頁以固定虛構房間狀態檢查七階段：大廳、派隊、投票、任務、湖、刺殺、賽後。這是版面驗收，並非宣稱七階段均由一場真人操作的對局走完。

固定時間為 `2026-01-02T12:00:00Z`。畫面中的名字與泡泡都是合成驗收資料，沒有搬用玩家或聊天室內容。大廳測房主視角，派隊實際點選三張卡，賽後切回牌桌；通知與泡泡同時顯示，以檢查遮擋。

- 24 組尺寸／縮放 × 7 階段 = **168 張截圖**。
- 168／168 組 `contentHeight` 等於 CSS viewport 高度。
- 168／168 組左右欄均不捲動，且沒有頁面橫向溢出。
- 154／154 組寬視窗（寬度至少 640px）沒有名字元素溢出。手機沿用原本長名字截斷方式，可由完整 title 辨識；此輪手機修正聚焦泡泡與通知。
- 指定的 11 組尺寸／縮放全部包含，另補 13 組已回報的窄、矮視窗。
- `1280×800 @125%` 以 `1024×640` CSS viewport、DPR 1.25 模擬，輸出影像為 `1280×800`；這是 Chromium 裝置度量模擬，不是作業系統縮放驗收。
- 分階段檢視全部尺寸的總覽圖，並放大檢查窄卡、手機、平板派隊及矮視窗賽後畫面。

逐組數值：[measurements.md](practice_ui_20261015/measurements.md)。機器可讀量測 metrics.json 與 168 張截圖的 zip（共約 17 MB）只保留在分支 `gpt/practice-ui`，沒有併入 main（整合時移除，避免公開 repo 永久變大）。

完整截圖依階段封裝：[大廳](practice_ui_20261015/chromium_lobby.zip)、[派隊](practice_ui_20261015/chromium_team.zip)、[投票](practice_ui_20261015/chromium_vote.zip)、[任務](practice_ui_20261015/chromium_quest.zip)、[湖](practice_ui_20261015/chromium_lake.zip)、[刺殺](practice_ui_20261015/chromium_assassination.zip)、[賽後](practice_ui_20261015/chromium_ended.zip)。為控制公開 repo 體積，PNG 截圖轉為保持原尺寸的 WebP（品質 94）後封裝；共有 168 張。檔名包含尺寸、縮放及階段。截圖沒有真實玩家資料。

## 指令結果

| 檢查 | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 通過，pnpm 8.15.4；工作樹使用已下載依賴離線安裝 |
| `pnpm --filter @avalon/shared build` | 通過 |
| `pnpm --filter @avalon/server test` | 122 檔通過、1 檔略過；2,486 測試通過、28 略過 |
| `pnpm --filter @avalon/server type-check` | 通過 |
| `pnpm --filter @avalon/server lint` | 0 錯誤、160 個既有警告 |
| `pnpm --filter @avalon/web type-check` | 通過 |
| `pnpm --filter @avalon/web lint` | 0 錯誤、137 個警告 |
| `pnpm --filter @avalon/web build` | 通過；保留既有 bundle 體積提示 |
| `pnpm type-check` | 3／3 工作通過 |
| Python 3.11 `test_generate_cache.py` | 139 測試，138 通過、1 略過 |
| Python 3.11 `test_discord_records_import.py` | 102／102 通過 |
| `git diff --check` | 通過 |

驗收中曾發現窄大廳仍捲動與泡泡跟不上階段切換，修正後重新跑完整矩陣。一次註解整理造成 JSX 標籤缺失，已由 type-check 發現並修復；最終 type-check、lint、build 皆通過。工作區的 Python 3.11 路徑曾失效，改用固定安裝路徑後兩組 Python 測試重跑通過。一張 2560×1440 任務截圖曾損壞，已重新擷取並驗證可解碼。

## 限制與整合

此分支可獨立整合，不依賴 B。未改遊戲規則或新增產品選項，沒有需要 Edward 裁決的事項。

驗收範圍為 Chromium；沒有宣稱 Safari／Firefox 或實體手機已驗證。不支援容器單位的舊瀏覽器保留原本欄寬。大廳設定變多時中欄可捲動，玩家欄仍保持可見；非常小於本輪尺寸範圍的視窗保留必要捲動能力。

Playwright 啟動與狀態注入腳本保留在工作區，沒有加入 Gemini 負責的測試基礎建設。可由 Gemini 將固定資料情境納入後續 e2e；Claude 整合後再驗證正式部署。
