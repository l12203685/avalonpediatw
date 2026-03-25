# 🚀 快速部署指南

## 5 分钟内完成部署

### 前置准备

- ✅ Vercel 账户已登录
- ✅ Railway 账户已登录
- ✅ Firebase 项目已准备
- ✅ GitHub 仓库已授权

---

## 第 1 步：部署前端（2 分钟）

### 在 Vercel 部署

```bash
cd packages/web
pnpm install -g vercel
vercel --prod
```

或者在 [Vercel Dashboard](https://vercel.com/dashboard) 中：

1. **Add New** → **Project**
2. 导入 GitHub 仓库
3. **Root Directory** 选择 `packages/web`
4. 点击 **Deploy**

### 添加环境变量

部署后，进入 **Settings** → **Environment Variables**，添加：

```env
VITE_API_URL=https://your-railway-backend.railway.app
FIREBASE_API_KEY=<from Firebase Console>
FIREBASE_AUTH_DOMAIN=<from Firebase Console>
FIREBASE_PROJECT_ID=<from Firebase Console>
FIREBASE_STORAGE_BUCKET=<from Firebase Console>
FIREBASE_MESSAGING_SENDER_ID=<from Firebase Console>
FIREBASE_APP_ID=<from Firebase Console>
```

---

## 第 2 步：部署后端（2 分钟）

### 在 Railway 部署

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

或者在 [Railway Dashboard](https://railway.app/dashboard) 中：

1. **New Project** → **Deploy from GitHub repo**
2. 选择 `l12203685/avalonpediatw`
3. **Root Directory** 设置为 `packages/server`
4. 点击 **Deploy**

### 添加环境变量

在 Railway 项目的 **Variables** 中添加：

```env
NODE_ENV=production
PORT=3001
FIREBASE_PROJECT_ID=<from Firebase>
FIREBASE_CLIENT_EMAIL=<from Firebase Service Account>
FIREBASE_PRIVATE_KEY=<Base64 encoded>
CORS_ORIGIN=https://your-vercel-app.vercel.app
```

---

## 第 3 步：验证部署（1 分钟）

### 检查前端
- 访问 Vercel 提供的 URL
- 检查浏览器控制台，确保无错误

### 检查后端
```bash
# 测试 API 健康状态
curl https://your-railway-app.railway.app/health

# 应该返回：
# {"status":"ok"}
```

---

## 📝 Firebase 凭证速查

### 获取 Web SDK 配置
Firebase Console → 项目设置 → 你的应用 → 复制配置

### 获取服务账户凭证
Firebase Console → 项目设置 → 服务账户 → 生成新密钥 → 下载 JSON

### Base64 编码私钥
```bash
# Linux/Mac
echo -n 'YOUR_PRIVATE_KEY' | base64

# Windows PowerShell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('YOUR_PRIVATE_KEY'))
```

---

## 🔗 重要 URLs

| 平台 | URL |
|-----|-----|
| Vercel Dashboard | https://vercel.com/dashboard |
| Railway Dashboard | https://railway.app/dashboard |
| Firebase Console | https://console.firebase.google.com |
| GitHub 仓库 | https://github.com/l12203685/avalonpediatw |

---

## ✅ 验证清单

部署前：
- [ ] Vercel 和 Railway 账户可用
- [ ] Firebase 项目已创建
- [ ] GitHub 仓库已授权

前端部署：
- [ ] Vercel 部署完成
- [ ] 前端 URL 可访问
- [ ] 环境变量已设置

后端部署：
- [ ] Railway 部署完成
- [ ] `/health` 端点可访问
- [ ] 环境变量已设置

验证：
- [ ] 前端可加载
- [ ] 后端 API 可连接
- [ ] Firebase 认证工作
- [ ] WebSocket 连接成功

---

## 🆘 快速故障排除

### 前端无法加载
```javascript
// 浏览器控制台检查
console.log(import.meta.env.VITE_API_URL)
```

### 后端无法连接
```bash
# 检查 Railway 日志
curl -v https://your-railway-app.railway.app/health
```

### Firebase 错误
- 检查 Firebase 项目 ID 是否正确
- 确认私钥正确 Base64 编码
- 验证服务账户权限

---

## 📚 更多帮助

- **详细部署指南**: 见 `DEPLOYMENT.md`
- **环境变量配置**: 见 `ENV_SETUP.md`
- **验证脚本**: 运行 `bash scripts/verify-deployment.sh`

---

## 🎯 下一步

部署完成后：

1. ✅ 配置自定义域名（可选）
2. ✅ 设置 SSL/TLS 证书（自动）
3. ✅ 配置备份和监控（可选）
4. ✅ 设置 CI/CD 自动部署

---

**需要帮助?** 查看完整的 `DEPLOYMENT.md` 和 `ENV_SETUP.md` 文档。
