# 🚀 5分鐘快速部署指南

## 前置要求（必須有）
- [ ] Vercel 賬戶：https://vercel.com/signup
- [ ] Railway 賬戶：https://railway.app/register
- [ ] 本機已安裝 Node.js 和 npm

## 方案 A：自動部署（推薦！）

### Step 1：一鍵部署
```bash
bash deploy.sh
```

這個腳本會：
✅ 檢查環境
✅ 構建項目
✅ 部署前端到 Vercel
✅ 部署後端到 Railway
✅ 配置自動連接

---

## 方案 B：手動部署（如果自動腳本失敗）

### Step 1：登入工具
```bash
# 安裝 CLI
npm install -g @railway/cli vercel

# 登入 Vercel
vercel login

# 登入 Railway
railway login
```

### Step 2：部署前端
```bash
cd packages/web

# 首次部署（會提示輸入項目名稱等）
vercel --prod

# 獲取 URL
export VERCEL_URL=$(vercel ls --json | jq -r '.[0].url')
echo "前端 URL: https://$VERCEL_URL"
```

### Step 3：部署後端
```bash
cd ../server

# 初始化 Railway 項目
railway init

# 設置環境變量
railway variables set NODE_ENV=production
railway variables set PORT=3001
railway variables set FIREBASE_PROJECT_ID=avalon-game-platform
railway variables set FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@avalon-game-platform.iam.gserviceaccount.com
railway variables set CORS_ORIGIN=https://$VERCEL_URL

# 部署
railway up

# 獲取 URL
export RAILWAY_URL=$(railway status | grep -oP 'https://[^/]+')
echo "後端 URL: $RAILWAY_URL"
```

### Step 4：更新前端環境變量
```bash
cd ../web
vercel env set VITE_API_URL=$RAILWAY_URL --prod

# 重新部署
vercel --prod
```

---

## ✅ 驗證部署

```bash
# 測試後端
curl $RAILWAY_URL/health
# 應返回: {"status":"ok","timestamp":"..."}

# 訪問前端
open https://$VERCEL_URL
# 應看到 Avalon 遊戲界面
```

---

## 🎯 部署後自動更新

一旦部署成功，以後只需：
```bash
git push origin main
```

GitHub Actions 會自動部署到 Vercel 和 Railway！

---

## 🆘 故障排除

### 錯誤：Vercel 登入失敗
```bash
vercel login
# 選擇 GitHub/GitLab 認証
```

### 錯誤：Railway 找不到項目
```bash
railway projects
# 確認項目存在，然後：
railway link
```

### 錯誤：CORS 連接失敗
```bash
# 確保 Vercel 環境變量包含：
vercel env list
# 應該有 VITE_API_URL=<Railway URL>
```

---

## 📞 需要幫助？

查看完整文件：
- `DEPLOYMENT.md` - 詳細部署指南
- `ENV_SETUP.md` - 環境變量配置
- `vercel.json` - Vercel 配置
- `railway.json` - Railway 配置

祝部署順利！🎉
