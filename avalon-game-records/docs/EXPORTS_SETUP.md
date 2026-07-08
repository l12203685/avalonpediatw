# 衍生輸出設定指南

本文件說明如何啟用 `games/**/*.json` → CSV / Google Sheets / HackMD 的自動同步。
`exports/games.csv` 與 `STATS.md` 不需任何設定即會自動產生；
Google Sheets 與 HackMD 同步為選用，沒設定對應 Secrets 就會自動跳過（不會報錯中斷）。

所有設定都是**單向**：JSON 是唯一真相來源，Sheets / HackMD 只是被動接收算好的結果，
不會、也不該手動回頭改它們再同步回 JSON。

---

## 0. 共同前置：允許 Action 寫回 main

GitHub 預設可能把 Actions 的寫入權限設成唯讀，這樣 Action 算完 CSV/STATS.md 後會
推不回 `main`。請先檢查：

`Settings → Actions → General → Workflow permissions` → 選 **Read and write permissions** → Save。

---

## 1. Google Sheets 同步

1. 到 [Google Cloud Console](https://console.cloud.google.com/)，建立或選一個專案，啟用
   **Google Sheets API**。
2. `IAM & Admin → Service Accounts` → 建立一個 service account（角色不用特別給，預設即可）。
3. 該 service account → `Keys` → `Add Key` → `Create new key` → JSON，下載金鑰檔。
4. 開一個 Google Sheet 當同步目標，建一個分頁，預設名稱抓 **`Games`**
   （之後想換名稱，在 workflow 的 Sheets 同步 step 多加一行
   `GOOGLE_SHEETS_TAB: ${{ secrets.GOOGLE_SHEETS_TAB }}` 並設對應 Secret 即可）。
5. 把整份試算表「共用」給該 service account 的 email（JSON 金鑰裡的 `client_email`，
   格式像 `xxx@yyy.iam.gserviceaccount.com`），權限給「編輯者」。
6. 從試算表網址取得 spreadsheet ID：
   `https://docs.google.com/spreadsheets/d/`**`<這段就是 ID>`**`/edit`。
7. 到本 repo（avalonpediatw）`Settings → Secrets and variables → Actions → New repository secret`，新增：
   - `GOOGLE_SHEETS_CREDENTIALS_JSON`：貼整份 JSON 金鑰檔的內容
   - `GOOGLE_SHEETS_ID`：貼 spreadsheet ID

每次同步是「清空分頁 → 整批重寫」，所以分頁裡不要手動加東西，會被覆蓋。

---

## 2. HackMD 自動統計頁

1. 登入 HackMD → `Settings → API` → 產生一個 Access Token。
2. 手動建立一個新 note 當同步目標（內容隨意，例如先打個標題就好）。
3. 從該 note 的網址取得 note ID：`https://hackmd.io/`**`<note id>`**。
4. 到本 repo（avalonpediatw）`Settings → Secrets and variables → Actions`，新增：
   - `HACKMD_API_TOKEN`
   - `HACKMD_NOTE_ID`

同步時會用 `STATS.md` 的完整內容覆寫該 note，所以**不要手動編輯這個 note**，下次同步會蓋掉。

> 腳本對接的是 HackMD API v1（`https://api.hackmd.io/v1`，`PATCH /notes/{noteId}`，
> body `{ "content": "..." }`，header `Authorization: Bearer <token>`）。
> 若 HackMD 之後調整了 API，第一次跑就會在 Action log 看到明確的 HTTP 錯誤訊息
> （而不是悄悄失敗），照錯誤訊息調整 `scripts/sync-hackmd.mjs` 即可。

---

## 3. 驗證設定

到本 repo（avalonpediatw）的 `Actions` 頁籤 → 選 `Game records exports` workflow
（定義在 repo 根目錄的 `.github/workflows/game-records-exports.yml`）→
`Run workflow`（手動觸發，不用等真的有新對局）。跑完後檢查：

- Log 裡有沒有 `Synced ... to Google Sheet ...` / `Synced STATS.md to HackMD note ...`
  （沒設 Secrets 的話會看到 `skipping ... sync` 訊息，這是正常的，不是錯誤）。
- 對應的 Google Sheet 分頁 / HackMD note 內容是否更新。
- `exports/games.csv` 與 `STATS.md` 是否被 commit 回 `main`
  （目前 `games/` 還沒有真實對局資料，這兩個檔案的內容會是「尚無資料」，這是預期行為）。

之後每次後端寫入新的一局（本目錄 `games/**` 有變動 push 到 `main`），都會自動重新跑一次。
