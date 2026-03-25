# 环境变量设置指南

本指南帮助你快速配置所有部署所需的环境变量。

## 📋 需要的信息清单

在开始部署前，请收集以下信息：

### Firebase 信息

从 [Firebase Console](https://console.firebase.google.com) 获取：

- [ ] `FIREBASE_PROJECT_ID` - 项目 ID
- [ ] `FIREBASE_API_KEY` - Web API 密钥
- [ ] `FIREBASE_AUTH_DOMAIN` - 认证域
- [ ] `FIREBASE_STORAGE_BUCKET` - 存储桶
- [ ] `FIREBASE_MESSAGING_SENDER_ID` - 消息发送者 ID
- [ ] `FIREBASE_APP_ID` - 应用 ID
- [ ] `FIREBASE_CLIENT_EMAIL` - 服务账户客户端邮箱
- [ ] `FIREBASE_PRIVATE_KEY` - 服务账户私钥（Base64 编码）

### 部署 URLs

- [ ] `VITE_API_URL` - Railway 后端 URL（例：`https://api.railway.app`）
- [ ] `CORS_ORIGIN` - Vercel 前端 URL（例：`https://app.vercel.app`）

## 🔑 获取 Firebase 凭证详细步骤

### 步骤 1：获取 Web SDK 配置

1. 访问 [Firebase Console](https://console.firebase.google.com)
2. 选择你的项目
3. 点击 **⚙️ 项目设置**
4. 在 **"您的应用"** 部分，找到你的 Web 应用
5. 点击 **🔧** 图标
6. 复制显示的配置信息

配置将如下所示：
```javascript
{
  apiKey: "YOUR_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
}
```

**映射关系**：
```
apiKey → FIREBASE_API_KEY
authDomain → FIREBASE_AUTH_DOMAIN
projectId → FIREBASE_PROJECT_ID
storageBucket → FIREBASE_STORAGE_BUCKET
messagingSenderId → FIREBASE_MESSAGING_SENDER_ID
appId → FIREBASE_APP_ID
```

### 步骤 2：生成服务账户密钥

1. 在 **项目设置** → **服务账户** 标签页
2. 点击 **"生成新的私钥"** 按钮
3. JSON 文件会自动下载
4. 打开下载的 JSON 文件，复制以下信息：

```json
{
  "type": "service_account",
  "project_id": "your-project-id",          // → FIREBASE_PROJECT_ID
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk@...",  // → FIREBASE_CLIENT_EMAIL
  "client_id": "...",
  "auth_uri": "...",
  "token_uri": "...",
  "auth_provider_x509_cert_url": "...",
  "client_x509_cert_url": "..."
}
```

### 步骤 3：Base64 编码 Private Key

`FIREBASE_PRIVATE_KEY` 需要进行 Base64 编码。

**在 Linux/Mac 上**：
```bash
# 复制私钥内容（包括 -----BEGIN 和 -----END-----）
# 然后运行：
echo -n 'YOUR_PRIVATE_KEY_CONTENT' | base64
```

**在 Windows PowerShell 上**：
```powershell
$key = 'YOUR_PRIVATE_KEY_CONTENT'
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($key))
```

**在线工具**：
- 访问 [Base64 Encode Online](https://www.base64encode.org/)
- 粘贴私钥内容
- 复制编码结果

⚠️ **重要**：Base64 编码的私钥应该是一长串文本，不包含换行符。

## 🎯 Vercel 环境变量配置

### 通过 Web 界面

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 选择你的项目
3. 点击 **Settings** → **Environment Variables**
4. 添加以下变量（Production）：

| 变量名 | 值 | 示例 |
|--------|-----|------|
| `VITE_API_URL` | Railway 后端 URL | `https://avalon-api.railway.app` |
| `FIREBASE_API_KEY` | Firebase API 密钥 | `AIzaSyD...` |
| `FIREBASE_AUTH_DOMAIN` | Firebase 认证域 | `avalon-game.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | Firebase 项目 ID | `avalon-game-12345` |
| `FIREBASE_STORAGE_BUCKET` | Firebase 存储桶 | `avalon-game-12345.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase 消息 ID | `123456789` |
| `FIREBASE_APP_ID` | Firebase 应用 ID | `1:123456789:web:abc123` |

**步骤**：
1. 点击 "Add New"
2. 输入变量名和值
3. 选择 "Production" 环境
4. 点击 "Save"
5. 重新部署（Settings → Deployments → Redeploy）

### 通过 CLI

```bash
# 登录 Vercel
vercel login

# 进入项目目录
cd packages/web

# 添加环境变量
vercel env add VITE_API_URL
# 输入值：https://your-railway-app.railway.app

vercel env add FIREBASE_API_KEY
# 输入值：your-firebase-api-key

# ... 以此类推添加其他变量

# 部署
vercel --prod
```

## 🚂 Railway 环境变量配置

### 通过 Web 界面

1. 访问 [Railway Dashboard](https://railway.app/dashboard)
2. 选择你的项目
3. 选择后端 Service
4. 点击 **Variables** 标签页
5. 点击 **+ Add Variable**
6. 添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `NODE_ENV` | `production` | 生产环境标志 |
| `PORT` | `3001` | 服务器端口 |
| `FIREBASE_PROJECT_ID` | 你的 Firebase 项目 ID | |
| `FIREBASE_CLIENT_EMAIL` | Firebase 服务账户邮箱 | 来自 JSON 文件 |
| `FIREBASE_PRIVATE_KEY` | Base64 编码的私钥 | 来自 JSON 文件（已编码） |
| `CORS_ORIGIN` | Vercel URL | 例：`https://avalon.vercel.app` |

**步骤**：
1. 在输入框中输入变量名
2. 按 Tab 或点击值字段
3. 输入对应的值
4. 按 Enter 保存
5. 刷新或重新部署

### 通过 Railway CLI

```bash
# 登录 Railway
railway login

# 进入项目
railway link

# 查看当前环境变量
railway variables

# 添加变量
railway variables set NODE_ENV production
railway variables set PORT 3001
railway variables set FIREBASE_PROJECT_ID your-project-id
railway variables set FIREBASE_CLIENT_EMAIL your-service-account-email
railway variables set FIREBASE_PRIVATE_KEY "base64-encoded-key"
railway variables set CORS_ORIGIN https://your-vercel-app.vercel.app

# 查看更新后的变量
railway variables
```

## ✅ 验证配置

### 验证 Vercel 环境变量

1. 访问已部署的前端 URL
2. 打开浏览器开发者工具 (F12)
3. 在 Console 标签页输入：
   ```javascript
   import.meta.env.VITE_API_URL
   ```
4. 应该返回你设置的 API URL

### 验证 Railway 环境变量

1. 访问 Railway Dashboard → Logs
2. 查看启动日志，确认以下信息：
   - `PORT` 设置正确
   - Firebase 初始化成功
   - 无错误信息

3. 测试 API 端点：
   ```bash
   curl https://your-railway-app.railway.app/health
   ```

## 🔄 更新环境变量

### Vercel 更新
1. Settings → Environment Variables
2. 点击变量右侧的 "..." → Edit
3. 修改值
4. 点击 "Save"
5. 重新部署

### Railway 更新
1. Variables 标签页
2. 点击变量右侧的 "Edit"
3. 修改值
4. 按 Enter 保存
5. 自动重新部署

## 🚨 常见问题

### "密钥格式不正确"
- 确保 `FIREBASE_PRIVATE_KEY` 是 Base64 编码的
- 私钥不应该包含多行（所有内容在一行）
- 检查编码是否正确：`echo "encoded-string" | base64 -d` 应该输出原始密钥

### "Firebase 初始化失败"
- 检查 `FIREBASE_PROJECT_ID` 和 `FIREBASE_CLIENT_EMAIL` 是否匹配
- 确保私钥是有效的服务账户密钥
- 查看 Railway 日志了解详细错误

### "CORS 错误"
- 确认 `CORS_ORIGIN` 与 Vercel 部署 URL 完全匹配（包括协议）
- Railway 日志中应该显示正确的 CORS 配置
- 清除浏览器缓存并重新加载

### "连接被拒绝"
- 检查 Railway 服务是否正在运行
- 确认 `PORT` 设置为 3001
- 查看 Railway 日志了解启动错误

## 📝 环境变量检查清单

在部署前，确保以下所有项都已完成：

**前端 (Vercel)**:
- [ ] VITE_API_URL 已设置
- [ ] 所有 Firebase 变量已设置
- [ ] 已重新部署应用

**后端 (Railway)**:
- [ ] NODE_ENV 设置为 production
- [ ] PORT 设置为 3001
- [ ] FIREBASE_PROJECT_ID 已设置
- [ ] FIREBASE_CLIENT_EMAIL 已设置
- [ ] FIREBASE_PRIVATE_KEY 已 Base64 编码并设置
- [ ] CORS_ORIGIN 指向 Vercel URL

## 📚 相关资源

- [Firebase 服务账户文档](https://firebase.google.com/docs/admin/setup)
- [Base64 编码信息](https://en.wikipedia.org/wiki/Base64)
- [Vercel 环境变量](https://vercel.com/docs/projects/environment-variables)
- [Railway 环境变量](https://docs.railway.app/guides/variables)
