# Firebase 設置指南

## 📋 步驟 1: 建立 Firebase 專案

1. 訪問 [Firebase Console](https://console.firebase.google.com)
2. 點擊 "Add Project"
3. 輸入專案名稱: `avalon-game`
4. 禁用 Google Analytics (可選)
5. 點擊 "Create Project"

---

## 🔑 步驟 2: 取得 Firebase 配置

### Web 應用配置

1. 在 Firebase Console 點擊你的專案
2. 點擊 "Project Settings" (⚙️)
3. 向下滾動到 "Your apps" 部分
4. 點擊 Web 應用圖標 (`</>`)
5. 複製 `firebaseConfig` 物件中的以下內容：

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_BUCKET.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

---

## 🔐 步驟 3: 設置認證

### 啟用 Google 登入

1. 在 Firebase Console 點擊 "Authentication"
2. 點擊 "Sign-in method"
3. 點擊 "Google"
4. 啟用開關
5. 選擇 "Support email"
6. 點擊 "Save"

### 啟用 GitHub 登入

1. 在 "Sign-in method" 中點擊 "GitHub"
2. 啟用開關
3. 設置 OAuth 應用 (詳見下面的 GitHub OAuth 設置)

### GitHub OAuth 設置

1. 訪問 [GitHub Settings → Developer settings → OAuth apps](https://github.com/settings/developers)
2. 點擊 "New OAuth App"
3. 填寫表單：
   - **Application name**: Avalon Game
   - **Homepage URL**: `http://localhost:5173` (開發) 或你的部署 URL
   - **Authorization callback URL**: `https://YOUR_PROJECT.firebaseapp.com/__/auth/handler`

4. 複製 **Client ID** 和 **Client Secret**
5. 回到 Firebase Console，粘貼到 GitHub 認證設置中

---

## 🗄️ 步驟 4: 設置 Realtime Database

1. 在 Firebase Console 點擊 "Realtime Database"
2. 點擊 "Create Database"
3. 選擇地區 (建議 `asia-southeast1` 用於台灣用戶)
4. 選擇 "Start in test mode" (暫時允許所有讀寫，稍後設置規則)
5. 點擊 "Enable"

---

## 🔐 步驟 5: 配置 Security Rules

1. 在 Realtime Database 中點擊 "Rules" 標籤
2. 用以下規則替換：

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth.uid === $uid"
      }
    },
    "user-stats": {
      "$uid": {
        ".read": "auth != null",
        ".write": "auth.uid === $uid"
      }
    },
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

3. 點擊 "Publish"

---

## 🔧 步驟 6: 後端 (Service Account)

### 建立 Service Account

1. 在 Firebase Console 點擊 "Project Settings"
2. 點擊 "Service Accounts"
3. 點擊 "Generate New Private Key"
4. 下載 JSON 檔案並保存

### 配置環境變數

在 `packages/server/.env` 中：

```bash
# Firebase Configuration
FIREBASE_API_KEY=YOUR_API_KEY
FIREBASE_AUTH_DOMAIN=YOUR_PROJECT.firebaseapp.com
FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
FIREBASE_STORAGE_BUCKET=YOUR_BUCKET.appspot.com
FIREBASE_MESSAGING_SENDER_ID=YOUR_SENDER_ID
FIREBASE_APP_ID=YOUR_APP_ID

# Service Account (將下載的 JSON 內容作為字符串)
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'

# Server Configuration
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
```

---

## 🎨 步驟 7: 前端配置

在 `packages/web/.env` 中：

```bash
VITE_SERVER_URL=http://localhost:3001
VITE_FIREBASE_API_KEY=YOUR_API_KEY
VITE_FIREBASE_AUTH_DOMAIN=YOUR_PROJECT.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET=YOUR_BUCKET.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=YOUR_SENDER_ID
VITE_FIREBASE_APP_ID=YOUR_APP_ID
```

---

## ✅ 驗證設置

### 測試認證

1. 啟動開發伺服器：
```bash
pnpm dev
```

2. 打開 http://localhost:5173
3. 點擊 "Continue with Google" 或 "Continue with GitHub"
4. 應該看到成功登入訊息

### 檢查 Realtime Database

1. 成功登入後，應該在 Realtime Database 中看到新用戶：
```
users/
  └── [user-uid]/
      ├── uid
      ├── displayName
      ├── email
      ├── photoURL
      ├── provider
      ├── createdAt
      └── updatedAt
```

---

## 🐛 常見問題

### "Firebase initialization error"
- 檢查 `.env` 文件中的所有值
- 確保 Firebase 專案已啟用

### "Token verification failed"
- 檢查 Service Account JSON 是否正確
- 確保後端可以訪問 Firebase

### "Authentication error: No token provided"
- 確保前端成功取得 ID Token
- 檢查瀏覽器控制台的錯誤訊息

### GitHub OAuth 重定向失敗
- 檢查 "Authorization callback URL" 是否正確
- 確保與 Firebase 設置相匹配

---

## 📊 監控 Firebase 使用情況

1. 在 Firebase Console 點擊 "Usage"
2. 查看：
   - Realtime Database 讀寫操作
   - Authentication 登入次數
   - 存儲容量使用

## 💰 免費額度估算

| 項目 | 免費額度 | 用途 |
|------|---------|------|
| Realtime DB 連接 | 100 | 足夠 10 人遊戲 |
| Realtime DB 儲存 | 1 GB | 遊戲狀態 + 用戶數據 |
| Authentication | 無限 | 用戶登入 |
| 下載流量 | 1 GB/月 | 數據同步 |

---

## 🚀 部署到生產環境

當準備部署時：

1. 更新 `CORS_ORIGIN` 為實際域名
2. 更改 GitHub OAuth 的 Homepage URL 和 Callback URL
3. 在 Firebase Console 啟用 "Enforce rules for all users"
4. 設置備份策略

---

需要幫助？ 查看 [Firebase 官方文檔](https://firebase.google.com/docs)
