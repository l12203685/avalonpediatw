# 📋 部署检查清单

完整的部署检查清单，按顺序完成每一项。

## 🔐 前置准备 (开始前)

### 账户和权限
- [ ] 已登录 Vercel 账户
- [ ] 已登录 Railway 账户
- [ ] Firebase 项目已创建
- [ ] GitHub 仓库已授权（Vercel 和 Railway 可访问）
- [ ] 对 GitHub 仓库有写权限（用于 GitHub Secrets）

### 本地环境
- [ ] Node.js >= 18.0.0 已安装 (`node -v`)
- [ ] pnpm >= 8.0.0 已安装 (`pnpm -v`)
- [ ] 依赖已安装 (`pnpm install`)
- [ ] 代码可本地编译 (`pnpm build`)

### Firebase 准备
- [ ] Firebase 项目已创建
- [ ] Firestore 数据库已初始化
- [ ] 认证方式已配置（Email/Password）
- [ ] Firebase 安全规则已设置
- [ ] Web API 密钥已生成
- [ ] 服务账户密钥已生成并下载

---

## 📦 前端部署 (Vercel)

### 部署配置
- [ ] 访问 [Vercel Dashboard](https://vercel.com/dashboard)
- [ ] 点击 **Add New** → **Project**
- [ ] 导入 GitHub 仓库 `l12203685/avalonpediatw`
- [ ] **Framework Preset**: 选择 **Vite**（或自动检测）
- [ ] **Root Directory**: 设置为 `packages/web`
- [ ] **Build Command**: 应该是 `pnpm build`
- [ ] **Output Directory**: 应该是 `dist`
- [ ] **Install Command**: 应该是 `pnpm install`
- [ ] 点击 **Deploy**，等待初始部署完成

### 环境变量配置 (Production)

进入项目 → **Settings** → **Environment Variables**

#### Firebase 配置信息
- [ ] 从 Firebase Console 获取 Web SDK 配置
  - [ ] FIREBASE_API_KEY
  - [ ] FIREBASE_AUTH_DOMAIN
  - [ ] FIREBASE_PROJECT_ID
  - [ ] FIREBASE_STORAGE_BUCKET
  - [ ] FIREBASE_MESSAGING_SENDER_ID
  - [ ] FIREBASE_APP_ID

#### API 端点
- [ ] VITE_API_URL: 设置为你的 Railway 后端 URL
  - 暂时使用 `http://localhost:3001`（部署后端后更新）

### 验证前端部署
- [ ] 访问 Vercel 提供的 URL
- [ ] 页面加载无 404 错误
- [ ] 浏览器控制台无错误
- [ ] 能看到登录页面
- [ ] 打开开发者工具 Console，运行：
  ```javascript
  console.log(import.meta.env.VITE_API_URL)
  console.log(import.meta.env.FIREBASE_API_KEY)
  ```
  应该返回正确的值

---

## 🚂 后端部署 (Railway)

### 部署配置
- [ ] 访问 [Railway Dashboard](https://railway.app/dashboard)
- [ ] 点击 **New Project**
- [ ] 选择 **Deploy from GitHub repo**
- [ ] 选择仓库 `l12203685/avalonpediatw`
- [ ] **Root Directory**: 设置为 `packages/server`
- [ ] **Build Command**: `pnpm build`
- [ ] **Start Command**: `pnpm start`
- [ ] **Node Version**: >= 18
- [ ] 点击 **Deploy**，等待部署完成

### 环境变量配置

进入项目 → 选择 Service → **Variables**

#### Node.js 配置
- [ ] NODE_ENV: `production`
- [ ] PORT: `3001`

#### Firebase 配置
- [ ] FIREBASE_PROJECT_ID: 来自 Firebase 服务账户 JSON 的 `project_id`
- [ ] FIREBASE_CLIENT_EMAIL: 来自 Firebase 服务账户 JSON 的 `client_email`
- [ ] FIREBASE_PRIVATE_KEY: 来自 Firebase 服务账户 JSON 的 `private_key`（**需要 Base64 编码**）

#### CORS 配置
- [ ] CORS_ORIGIN: 设置为你的 Vercel 前端 URL
  - 例如：`https://avalon-game.vercel.app`

#### 可选：社群机器人配置（如果使用本地部署）
- [ ] DISCORD_BOT_TOKEN: (可选，已本地部署)
- [ ] DISCORD_CLIENT_ID: (可选，已本地部署)
- [ ] LINE_CHANNEL_ACCESS_TOKEN: (可选，已本地部署)
- [ ] LINE_CHANNEL_SECRET: (可选，已本地部署)

### 验证后端部署
- [ ] 从 Railway Dashboard 查看部署日志，确认无错误
- [ ] 部署状态显示 "Active"
- [ ] 测试健康检查端点：
  ```bash
  curl https://your-railway-app.railway.app/health
  ```
  应该返回：`{"status":"ok"}`
- [ ] 查看 Railway 日志，确认 Firebase 初始化成功
- [ ] 检查日志中是否有 CORS 配置信息

---

## 🔗 环境变量验证

### Base64 编码私钥
- [ ] 获取 Firebase 服务账户 JSON 中的 `private_key` 字段
- [ ] 使用以下命令编码：
  ```bash
  echo -n 'YOUR_PRIVATE_KEY_CONTENT' | base64
  ```
- [ ] 复制编码后的字符串（应该是一长行）
- [ ] 将编码后的值设置为 Railway 的 FIREBASE_PRIVATE_KEY

### 验证环境变量
- [ ] Railway → Service → Logs，应该显示：
  ```
  Firebase initialized successfully
  Server running on port 3001
  CORS origin: https://your-vercel-app.vercel.app
  ```

---

## 🔄 更新前端配置

### 更新 Vercel 环境变量
- [ ] 前端部署完成后，获取 Vercel 提供的 URL
- [ ] 后端部署完成后，获取 Railway 提供的 URL
- [ ] 在 Vercel → **Settings** → **Environment Variables** 中更新：
  - VITE_API_URL: `https://your-railway-app.railway.app`
- [ ] 点击重新部署：**Deployments** → 最新部署 → **Redeploy**

### 验证连接
- [ ] 等待 Vercel 重新部署完成（2-3 分钟）
- [ ] 访问前端 URL
- [ ] 尝试登录或连接到 API
- [ ] 浏览器控制台无 CORS 错误
- [ ] 网络标签页显示成功的 API 请求

---

## ✅ 完整功能测试

### 前端功能
- [ ] 页面加载时间 < 3 秒
- [ ] 所有静态资源正确加载
- [ ] 移动设备响应式设计正常
- [ ] 暗色模式（如果有）正常切换
- [ ] 本地存储工作正常

### 认证流程
- [ ] Firebase 登录页面加载
- [ ] 可以使用邮箱注册新账户
- [ ] 可以使用邮箱登录
- [ ] 登录后重定向到主页
- [ ] 退出登录工作正常
- [ ] Token 刷新工作正常

### API 连接
- [ ] WebSocket 连接成功
- [ ] 可以获取游戏数据
- [ ] 可以创建新房间
- [ ] 可以加入房间
- [ ] 实时消息传输正常
- [ ] 掉线重连工作正常

### 后端 API
- [ ] `/health` 端点可访问
- [ ] `/api/games` 可获取游戏列表
- [ ] `/api/rooms` 可创建房间
- [ ] WebSocket `/socket.io/` 可连接
- [ ] 处理无效请求返回 4xx 错误
- [ ] 错误响应格式正确

### 错误处理
- [ ] 网络断开时有错误提示
- [ ] Firebase 错误正确显示
- [ ] 服务器错误正确处理
- [ ] 日志输出清晰

---

## 🔒 安全检查

### Firebase 安全规则
- [ ] Firestore 安全规则已配置
- [ ] 只有认证用户能读写
- [ ] 用户只能访问自己的数据
- [ ] 管理员规则正确设置

### API 安全
- [ ] CORS 头正确设置
- [ ] 敏感信息不在日志中
- [ ] API 密钥不在客户端代码中
- [ ] 环境变量在 .gitignore 中

### 部署安全
- [ ] 生产环境 NODE_ENV=production
- [ ] 不使用开发依赖在生产
- [ ] 敏感信息通过环境变量设置
- [ ] 定期更新依赖包

---

## 📊 监控和日志

### Vercel 监控
- [ ] 设置 Vercel 通知（可选）
- [ ] 配置 Sentry 或其他错误跟踪（可选）
- [ ] 查看 Analytics 性能数据

### Railway 监控
- [ ] 设置 Railway 通知（可选）
- [ ] 配置日志告警（可选）
- [ ] 定期检查日志

### 性能指标
- [ ] 首屏加载时间 < 3 秒
- [ ] API 响应时间 < 500ms
- [ ] WebSocket 延迟 < 100ms
- [ ] 错误率 < 1%

---

## 🔄 持续部署配置

### GitHub Secrets 配置
在 GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions**

#### Vercel Secrets
- [ ] VERCEL_TOKEN: Vercel 访问令牌
- [ ] VERCEL_PROJECT_ID: Vercel 项目 ID
- [ ] VERCEL_ORG_ID: Vercel 组织 ID
- [ ] VERCEL_URL: 部署后的 Vercel URL

#### Railway Secrets
- [ ] RAILWAY_TOKEN: Railway 访问令牌
- [ ] RAILWAY_URL: 部署后的 Railway URL

### GitHub Actions
- [ ] 工作流文件已创建 (`.github/workflows/deploy.yml`)
- [ ] 推送到 main 分支触发自动部署
- [ ] 部署前运行测试和 linting
- [ ] 部署失败时收到通知

---

## 📝 文档完成

- [ ] DEPLOYMENT.md 已阅读
- [ ] ENV_SETUP.md 已完成
- [ ] QUICK_START.md 已参考
- [ ] 团队成员已通知部署地址

---

## 🎉 部署完成

所有检查项完成后：

- [ ] 在团队中宣布部署完成
- [ ] 共享前端 URL
- [ ] 共享后端 API URL
- [ ] 分发登录凭证（如需要）
- [ ] 收集用户反馈
- [ ] 监控初期运行状态

---

## 📞 故障排除

遇到问题？按顺序尝试：

1. **检查日志**
   - Vercel → Deployments → 日志
   - Railway → Logs

2. **验证环境变量**
   - Vercel → Settings → Environment Variables
   - Railway → Variables

3. **检查网络连接**
   - 测试 API 端点：`curl https://api.railway.app/health`
   - 检查 CORS 错误：浏览器 Console

4. **重新部署**
   - Vercel: Settings → Redeploy
   - Railway: Service → Redeploy latest commit

5. **查看详细文档**
   - 见 `DEPLOYMENT.md` 故障排除部分
   - 见 `ENV_SETUP.md` 常见问题部分

---

**完成日期**: ________________
**部署者**: ________________
**验证者**: ________________
**备注**: ________________________________

---

需要帮助？查看 `DEPLOYMENT.md` 或 `QUICK_START.md`。
