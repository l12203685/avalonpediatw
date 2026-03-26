# Avalon Pedia 部署指南

完整的部署说明，包括 Vercel（前端）和 Railway（后端）配置。

## 📋 前置要求

- [ ] Vercel 账户（已登录）
- [ ] Railway 账户（已登录）
- [ ] Firebase 项目已配置
- [ ] GitHub 仓库已连接
- [ ] Node.js >= 18.0.0
- [ ] pnpm >= 8.0.0

## 🚀 快速部署步骤

### 第 1 步：前端部署到 Vercel

#### 方式 A：通过 Vercel Web 界面（推荐）

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 **"Add New..."** → **"Project"**
3. 导入此 GitHub 仓库 (`l12203685/avalonpediatw`)
4. 选择 **Root Directory**：`packages/web`
5. 设置环境变量（见下方环境变量部分）
6. 点击 **"Deploy"**

#### 方式 B：通过 CLI 部署

```bash
cd packages/web
pnpm install -g vercel
vercel --prod
# 按提示配置项目信息
```

### 第 2 步：后端部署到 Railway

#### 方式 A：通过 Railway Web 界面（推荐）

1. 访问 [Railway Dashboard](https://railway.app/dashboard)
2. 点击 **"New Project"**
3. 选择 **"Deploy from GitHub repo"**
4. 选择 `l12203685/avalonpediatw` 仓库
5. 配置以下设置：
   - **Root Directory**: `packages/server`
   - **Build Command**: `pnpm build`
   - **Start Command**: `pnpm start`
6. 设置环境变量（见下方环境变量部分）
7. 点击 **"Deploy"**

#### 方式 B：通过 CLI 部署

```bash
cd packages/server
npm install -g @railway/cli
railway login
railway init
railway up
```

## 🔐 环境变量配置

### Vercel 环境变量

在 Vercel 项目设置中添加以下环境变量：

```
VITE_API_URL=https://your-railway-app.railway.app
FIREBASE_API_KEY=<your_firebase_api_key>
FIREBASE_AUTH_DOMAIN=<your_firebase_project>.firebaseapp.com
FIREBASE_PROJECT_ID=<your_firebase_project_id>
FIREBASE_STORAGE_BUCKET=<your_firebase_project>.appspot.com
FIREBASE_MESSAGING_SENDER_ID=<your_firebase_sender_id>
FIREBASE_APP_ID=<your_firebase_app_id>
```

**获取方法**：
1. 登录 [Firebase Console](https://console.firebase.google.com)
2. 选择你的项目
3. 点击项目设置 → 常规
4. 复制 Firebase SDK 配置中的值

### Railway 环境变量

在 Railway 项目设置中添加以下环境变量：

```
NODE_ENV=production
PORT=3001
FIREBASE_PROJECT_ID=<your_firebase_project_id>
FIREBASE_PRIVATE_KEY=<your_firebase_private_key_base64>
FIREBASE_CLIENT_EMAIL=<your_firebase_client_email>
CORS_ORIGIN=https://your-vercel-app.vercel.app
```

**获取 Firebase 服务账户凭证**：
1. 登录 [Firebase Console](https://console.firebase.google.com)
2. 项目设置 → 服务账户
3. 点击 **"生成新的私钥"** 下载 JSON 文件
4. 提取以下信息：
   - `project_id`
   - `private_key` (需要 base64 编码)
   - `client_email`

**Base64 编码 private_key**：
```bash
# 使用以下命令进行编码（将 key 替换为实际的私钥）
echo -n 'YOUR_PRIVATE_KEY' | base64
```

## ✅ 部署验证清单

### 前端验证 (Vercel)

- [ ] 访问 Vercel 部署的 URL
- [ ] 页面正常加载，无 404 错误
- [ ] Firebase 认证工作正常
- [ ] 能成功连接到后端 API

### 后端验证 (Railway)

- [ ] 访问 `/health` 端点确认服务运行
- [ ] WebSocket 连接正常建立
- [ ] 数据库连接成功
- [ ] 日志中无错误

#### 测试命令

```bash
# 测试后端健康状态
curl https://your-railway-app.railway.app/health

# 测试 WebSocket 连接
# 使用前端应用连接或使用 WebSocket 客户端工具
```

## 🔄 持续部署 (CI/CD)

### 自动部署

两个平台都已配置自动部署：
- **Vercel**: 推送到 GitHub main 分支自动部署
- **Railway**: 推送到 GitHub main 分支自动部署

### 手动重新部署

**Vercel**:
1. 访问项目 → Deployments
2. 选择需要的部署
3. 点击三点菜单 → Redeploy

**Railway**:
1. 访问项目 Dashboard
2. 选择 Service
3. 点击 Redeploy latest commit

## 🚨 故障排除

### Vercel 部署失败

**问题**: 构建失败
- 检查构建日志：Project Settings → Build & Development Settings
- 确认 Root Directory 设置正确
- 验证所有环境变量已设置

**问题**: 环境变量未生效
- 确认在 Production 环境中设置了变量
- 重新部署（Settings → Redeploy）

### Railway 部署失败

**问题**: 构建失败
- 查看 Deployment 日志
- 确认 Node.js 版本 >= 18
- 检查 pnpm 版本 >= 8

**问题**: 环境变量问题
- 验证 FIREBASE_PRIVATE_KEY 正确 base64 编码
- 确认 CORS_ORIGIN 包含 Vercel URL
- 使用 Railway CLI 验证环境变量：`railway variables`

### 连接问题

**问题**: 前端无法连接后端
```bash
# 检查 VITE_API_URL 是否正确
# 在浏览器控制台检查：
console.log(import.meta.env.VITE_API_URL)

# 检查 CORS 设置
# 后端 CORS_ORIGIN 应包含前端 URL
```

## 📝 本地开发

继续使用本地开发环境：

```bash
# 安装依赖
pnpm install

# 启动前端（Vite）
cd packages/web && pnpm dev
# 访问 http://localhost:5173

# 启动后端（Express + Socket.io）
cd packages/server && pnpm dev
# 服务器运行在 http://localhost:3001
```

## 📊 监控和日志

### Vercel 日志
- Project Settings → Monitoring
- Analytics 标签页查看性能指标
- Deployments 查看构建日志

### Railway 日志
- Service → Logs 标签页
- 实时查看应用日志
- 按服务和日期过滤

## 🔒 安全建议

1. **环境变量安全**
   - 不要将敏感信息提交到 Git
   - 使用平台的密钥管理系统
   - 定期轮换 API 密钥

2. **CORS 配置**
   - 只允许特定的来源
   - 定期更新允许列表

3. **Firebase 安全规则**
   - 定期审查 Firestore 安全规则
   - 启用 Firebase 审计日志

## 📚 相关链接

- [Vercel 文档](https://vercel.com/docs)
- [Railway 文档](https://docs.railway.app)
- [Firebase 文档](https://firebase.google.com/docs)
- [环境变量配置](https://vercel.com/docs/projects/environment-variables)

## 🎯 下一步

- [ ] 配置自定义域名
- [ ] 设置 SSL/TLS 证书
- [ ] 配置备份和灾难恢复
- [ ] 设置监控告警
- [ ] 配置 CI/CD 流程
