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

到該服務 → **Environment** → 填這些 `sync:false` 的值：

| 變數 | 說明 |
|---|---|
| `JWT_SECRET` | **必填**！缺了 server 會拒絕啟動、一直重啟。產生：`openssl rand -hex 32` |
| `ADMIN_SECRET` | `/api/ai/selfplay` 用，隨意設一組 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin 服務帳號 JSON |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase 連線 |
| `GITHUB_RECORDS_TOKEN` | （選用）開完賽歸檔才需要 |

> `CORS_ORIGIN`、`GITHUB_RECORDS_REPO/BRANCH`、`NODE_ENV` 已寫在 `render.yaml`，免填。

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

- 閒置 **15 分鐘**後休眠 → 記憶體清空。**進行中的對局狀態在記憶體**，但只要有玩家
  開著分頁，Socket.IO 心跳會維持喚醒，通常不會中斷。
- 真正會遇到的：冷清一段時間後**第一個開連結的人要等 ~30–60 秒**冷啟動。
- 若哪天覺得冷啟動太擾民，升級 **Starter（~$7/月）**即可常開，其餘設定不變。
