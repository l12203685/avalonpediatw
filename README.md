# Avalon 完賽紀錄歸檔庫 (avalon-game-records)

> 本 repo 是 [avalonpediatw](https://github.com/l12203685/avalonpediatw) 線上阿瓦隆（Avalon）遊戲的**對戰紀錄歸檔庫**。
> 每一局遊戲結束後，後端會自動把該局的完整對戰紀錄寫入這裡，作為 append-only 的歷史存檔。

---

## ⚠️ 重要：請勿手動編輯既有檔案

- `games/**` 內的資料由 **avalonpediatw 後端自動寫入**（透過 GitHub Contents API）。
- 每一場是一個獨立的 JSON 檔，**append-only、永不覆寫**既有檔案。
- 請**勿手動新增、修改或刪除** `games/` 底下的檔案——它們是真實對戰資料，請視為**唯讀**。
- 唯一適合人類手動維護的檔案是本 `README.md`。

---

## 資料夾結構

```
games/
└── {YYYY}/                  # 開賽時間的 UTC 年份
    └── {MM}/                # 開賽時間的 UTC 月份（01–12）
        └── {gameId}.json    # 一場一檔
```

- 依**開賽時間（`playedAt`）的 UTC 年 / 月**分桶。
- 檔名即該局的 `gameId`。
- 範例：`games/2026/06/abc123.json`

---

## 紀錄檔格式（`GameRecordV2`）

每個 `.json` 檔都是一個 `GameRecordV2` 物件。頂層欄位如下：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|:--:|---|
| `schemaVersion` | `number` | ✓ | 結構版本，目前為 `2` |
| `gameId` | `string` | ✓ | 該局唯一 ID（與檔名相同） |
| `playedAt` | `number` | ✓ | 開賽時間，Unix 毫秒（ms） |
| `totalDurationMs` | `number` | | 選填，該局總時長（ms） |
| `playerSeats` | `string[]` | ✓ | 長度 10，按座號 1..10 的玩家識別。空座 = `""`；歷史無帳號玩家 = `"sheets:<名字>"` |
| `finalResult` | `object` | ✓ | `{ "winnerCamp": "good" \| "evil" }` |
| `missions` | `array` | ✓ | 各任務（mission）結果 |
| `ladyChain` | `array` | | 選填，湖中女神（Lady of the Lake）傳遞鏈 |
| `hasAI` | `boolean` | | 選填，該局是否含 AI / bot（ELO 計算排除用） |
| `casual` | `boolean` | | 選填，是否為娛樂局（ELO 計算排除用） |

> 完整且具權威性的型別定義位於 avalonpediatw 的
> [`packages/shared/src/types/game_v2.ts`](https://github.com/l12203685/avalonpediatw/blob/main/packages/shared/src/types/game_v2.ts) 的 `GameRecordV2`。
> `missions` 與 `ladyChain` 的子欄位請以該檔為準。

### 範例

```jsonc
{
  "schemaVersion": 2,
  "gameId": "abc123",
  "playedAt": 1710000000000,   // 開賽時間（Unix ms）
  "totalDurationMs": 123456,   // 選填，總時長
  "playerSeats": [
    "uid1", "uid2", "", "sheets:小明", "uid5",
    "uid6", "uid7", "uid8", "uid9", "uid10"
  ],
  "finalResult": { "winnerCamp": "good" },
  "missions": [ /* 各任務結果 */ ],
  "ladyChain": [ /* 選填，湖中女神傳遞鏈 */ ],
  "hasAI": false,
  "casual": false
}
```

---

## 寫入機制（pipeline）

- 寫入端程式：avalonpediatw 的 `packages/server/src/services/GitHubGameArchive.ts`。
- 後端在**每局結束時**，以 GitHub Contents API
  （`PUT /repos/{owner}/{repo}/contents/{path}`）寫入一筆 JSON。後端目前跑在 Render，
  但寫入機制本身與部署平台無關，未來更換平台不影響此 repo。
- 需設定下列三個環境變數才會啟用；**未設定則完全不動作（no-op）**：

| 環境變數 | 值 / 說明 |
|---|---|
| `GITHUB_RECORDS_TOKEN` | fine-grained PAT，權限 **Contents: Read and write**，且只勾選本 repo |
| `GITHUB_RECORDS_REPO` | `l12203685/avalon-game-records` |
| `GITHUB_RECORDS_BRANCH` | `main` |

---

## 衍生輸出（CSV / Google Sheets / HackMD）

`games/**/*.json` 是**唯一真相來源（source of truth）**。為了方便分析與分享，
repo 內有單向、唯讀的轉換腳本，從 JSON **算出**以下衍生輸出（不會反向寫回 JSON）：

| 輸出 | 內容 | 觸發方式 |
|---|---|---|
| `exports/games.csv` | 所有對局攤平成表格 | push 到 `main` 且 `games/**` 有變動時，GitHub Actions 自動重算並 commit 回 `main` |
| `STATS.md` | 勝率、排行榜等統計摘要 | 同上 |
| Google Sheets | 與 CSV 相同的攤平資料，寫入指定試算表 | 同上（需設定 Secrets，見下） |
| HackMD note | 與 `STATS.md` 相同的統計摘要，推到指定 note | 同上（需設定 Secrets，見下） |

- 這些都是**算出來的展示/分析用輸出**，不是資料庫；唯一真相永遠是 `games/**/*.json`。
- Google Sheets 與 HackMD 同步為選用功能，沒設對應的 GitHub Secrets 就會自動跳過。
- 設定步驟（service account、API token 等）見 [`docs/EXPORTS_SETUP.md`](docs/EXPORTS_SETUP.md)。

---

## 如何驗證第一筆紀錄

設定好環境變數、部署後端、並完整打完一局後：

1. 到本 repo 的 `games/{當前 UTC 年}/{當前 UTC 月}/` 目錄，確認出現了新的 `<gameId>.json`。
2. 確認該檔可被 JSON 正確 parse。
3. 檢查欄位齊全且合理：
   - `schemaVersion === 2`
   - 有 `gameId`、`playedAt`（合理的 Unix ms 時間戳）
   - `playerSeats` 長度為 `10`
   - `finalResult.winnerCamp` 為 `"good"` 或 `"evil"`

---

*本歸檔庫由 avalonpediatw 自動維護；資料僅供保存與分析之用。*
