# 後端搬到 Render Free — 上線清單

> Edward 2026-06-25：Cloud Run 長連線按秒計費容易爆帳單，改回 Render Free
> （固定 $0、可預測）。伺服器程式碼**不需改動**；本檔是操作步驟。

藍圖檔：repo 根目錄 `render.yaml`（已含服務設定與 env 佔位）。

---

## A. 建立 Render 服務（一次性）

1. [Render Dashboard](https://dashboard.render.com) →「**New +**」→「**Blueprint**」
2. 連 GitHub repo `l12203685/avalonpediatw` → Render 讀 `render.yaml` → **Apply**
   - 會建立 `avalon-server`，Docker（`Dockerfile.server`）、Singapore、Free 方案。
   - Free + Docker 第一次 build 較慢（約 5–10 分鐘），正常。

## B. 填機密環境變數（**最重要**）

GitHub-only 架構**不需要 Firebase / Supabase**——全部留空即可。需要兩個 GitHub repo：

- **`avalonpediatw-accounts`（PRIVATE）** — 放 email/密碼帳號（含密碼雜湊，務必 private）
- **`avalon-game-records`（public 可）** — 放完賽戰績

到該服務 → **Environment** → 填這些 `sync:false` 的值：

| 變數 | 說明 |
|---|---|
| `JWT_SECRET` | **必填**！缺了 server 拒絕啟動、一直重啟。`openssl rand -hex 32` |
| `GITHUB_ACCOUNTS_TOKEN` | 帳號庫 token（PRIVATE repo，Contents R/W）。缺了登入回 no_store |
| `GITHUB_RECORDS_TOKEN` | 戰績歸檔 token（public repo 可） |
| `ADMIN_SECRET` | `/api/ai/selfplay` 用，隨意一組 |
| `DISCORD_BOT_TOKEN` | Discord 同步腿。缺 → 只少這條腿 |
| `LINE_BOT_CHANNEL_ACCESS_TOKEN` / `LINE_BOT_CHANNEL_SECRET` | LINE 同步腿。缺 → 只少這條腿 |
| `LOBBY_MIRROR_LINE_GROUP_ID` | 要同步的 LINE 群 id（找法見 `docs/LINE_DISCORD_SYNC.md`） |

> `CORS_ORIGIN`、`GITHUB_ACCOUNTS_REPO`、`GITHUB_RECORDS_REPO/BRANCH`、`NODE_ENV`、
> `DISCORD_CLIENT_ID`、`LOBBY_MIRROR_DISCORD_CHANNEL_ID`、`LINE_WEBHOOK_AUTOSET`、`LINE_REPLY_DRAIN`、
> `KEEP_ALIVE`、`WEB_BASE_URL` 已寫在 `render.yaml`，免填。
> Firebase / Supabase 留空 = guest-only 模式 + GitHub 帳號庫接管登入。
> LINE / Discord 同步的設定、驗證與疑難排解：`docs/LINE_DISCORD_SYNC.md`
> （2026-06-25 第一版藍圖漏了這六個變數，正式機的同步因此全停；2026-10-08 補回）。

## C. 驗證後端

第一次部署完成後（Render → 服務 → Logs 看到 listening）：

```bash
curl https://<你的服務>.onrender.com/health
# 預期：{"status":"ok",...}（剛喚醒可能先回 "initializing"，也算正常）
```

## D. 把前端指向 Render（改一個 secret 就好）

玩家前端在 Firebase Hosting，build 時讀 GitHub secret `VITE_SERVER_URL`：

1. GitHub repo → **Settings → Secrets and variables → Actions**
2. 編輯 **`VITE_SERVER_URL`** = `https://<你的服務>.onrender.com`
3. **Actions** 分頁 → **Deploy Firebase** → **Run workflow**（重 build 前端，連到 Render）

> 程式碼層面所有前端服務都吃 `VITE_SERVER_URL`，不用改任何 .ts。

## E. 停掉 Cloud Run 止血（省錢的關鍵）

確認 Render 跑起來、玩家能正常連之後：

1. `gcloud run services delete avalon-server --region asia-east1`
2. `gcloud run services delete avalon-server-staging --region asia-east1`
   （或在 Cloud Console → Cloud Run 直接刪這兩個服務）
3. 之後別再跑 `deploy-staging.yml` / `promote-prod.yml`（那是 Cloud Run 的）。

---

## Free 方案要知道的事

- 閒置 **15 分鐘**後休眠 → 記憶體清空、Discord bot 離線。**20261009 起 server 每 10 分鐘
  自我喚醒（`KEEP_ALIVE`，免費）**，實際上常駐，不再有冷啟動。
- 額度：單一服務全月常駐 ≤ 744 小時，低於每個 workspace 每月 750 小時的免費額度；
  **同 workspace 再開第二個常駐 Free 服務就會超額**（超額後所有 Free 服務停到下個月）。
- 部署或 Render 重啟後仍有一次 ~30–60 秒冷啟動，之後自動恢復常駐。細節見 `docs/LINE_DISCORD_SYNC.md`。
