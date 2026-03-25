# 🤝 Avalon 遊戲平台 - 團隊開發指南

歡迎加入 **gstack 團隊**！本指南說明如何有效地協作開發這個專案。

---

## 📋 快速導覽

| 角色 | 職責 | 指南 |
|------|------|------|
| **前端開發者** | React UI, WebSocket 集成 | [前端指南](#-前端開發指南) |
| **後端開發者** | 遊戲邏輯, API, 數據庫 | [後端指南](#-後端開發指南) |
| **DevOps / 部署** | CI/CD, 服務器配置 | [部署指南](#-部署指南) |
| **測試工程師** | 功能測試, 性能優化 | [測試指南](#-測試指南) |
| **專案經理** | 進度追蹤, 優先級 | [PM 指南](#-專案管理指南) |

---

## 🛠️ 開發環境設置

### 前置要求

```bash
# 必須安裝
- Node.js >= 18.x
- pnpm >= 8.x (包管理器)
- Git

# 可選 (開發工具)
- VS Code (推薦編輯器)
- Postman (API 測試)
- Redis Desktop Manager (緩存檢查)
```

### 團隊成員第一次設置

```bash
# 1. 克隆仓库
git clone http://127.0.0.1:38315/git/l12203685/avalonpediatw.git
cd avalonpediatw

# 2. 檢查分支
git branch -a
git checkout claude/avalon-game-platform-0hDJ1

# 3. 安裝依賴
pnpm install

# 4. 複製環境配置
cp packages/server/.env.example packages/server/.env
cp packages/web/.env.example packages/web/.env

# 5. 編輯 .env 文件 (聯繫 PM 獲取值)
# vim packages/server/.env
# vim packages/web/.env

# 6. 啟動開發環境
pnpm dev
```

### IDE 設置 (VS Code)

建議安裝以下擴展：
```json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "firsttimersonly.first-timers-only",
    "ms-vscode.vscode-typescript-vue-plugin",
    "bradlc.vscode-tailwindcss",
    "Firebase.firebase-tools"
  ]
}
```

**VS Code 設置** (`.vscode/settings.json`):
```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

---

## 📁 前端開發指南

### 文件結構

```
packages/web/
├── src/
│   ├── pages/           ← 頁面級組件
│   │   ├── LoginPage.tsx
│   │   ├── HomePage.tsx
│   │   ├── LobbyPage.tsx
│   │   └── GamePage.tsx
│   ├── components/      ← 可重用組件 (待建)
│   │   ├── GameBoard.tsx
│   │   ├── PlayerCard.tsx
│   │   └── VotePanel.tsx
│   ├── store/           ← Zustand 狀態管理
│   │   └── gameStore.ts
│   ├── services/        ← API 和外部服務
│   │   ├── socket.ts    ← WebSocket 通訊
│   │   └── auth.ts      ← Firebase 認證
│   ├── hooks/           ← 自訂 React Hooks (待建)
│   ├── types/           ← 本地類型定義
│   ├── App.tsx          ← 主應用組件
│   ├── main.tsx         ← 入口點
│   └── index.css        ← 全局樣式
└── index.html
```

### 開發工作流

#### 1. 建立特性分支

```bash
# 從開發分支建立新分支
git checkout claude/avalon-game-platform-0hDJ1
git pull origin claude/avalon-game-platform-0hDJ1

# 建立特性分支 (命名規則: feature/description)
git checkout -b feature/game-board-component
```

#### 2. 開發規範

**TypeScript 嚴格模式**
```typescript
// ✅ 好
function handleVote(roomId: string, playerId: string, vote: boolean): void {
  submitVote(roomId, playerId, vote);
}

// ❌ 避免
function handleVote(roomId, playerId, vote) {
  submitVote(roomId, playerId, vote);
}
```

**React 最佳實踐**
```typescript
// ✅ 使用自訂 Hook
function useGameState() {
  const { room, currentPlayer } = useGameStore();
  return { room, currentPlayer };
}

// ✅ 使用 Zustand 狀態
const { gameState, setGameState } = useGameStore();

// ❌ 避免 useState 中的複雜邏輯
// 改用 Zustand store
```

**CSS 類命名**
```tsx
// ✅ 使用 Tailwind 類
<div className="flex items-center gap-4 p-6 bg-avalon-card rounded-lg">

// ❌ 避免混合 CSS-in-JS 和 className
```

#### 3. 提交代碼

```bash
# 查看改動
git status
git diff

# 添加文件
git add packages/web/src/components/GameBoard.tsx

# 提交 (遵循提交信息規範)
git commit -m "feat: Add GameBoard component with player visualization"

# 推送
git push origin feature/game-board-component
```

**提交信息格式** (Conventional Commits):
```
feat: Add new feature
fix: Fix a bug
refactor: Code refactoring
docs: Documentation updates
style: Code style changes
test: Add/update tests
perf: Performance improvements

例子:
feat(ui): Add GameBoard component with socket sync
feat(socket): Implement optimistic voting updates
fix(auth): Handle token expiration correctly
```

#### 4. 代碼審查流程

1. 推送分支
2. 建立 Pull Request
3. 描述改動內容
4. 等待審查 (需要 1 個批准)
5. 解決 lint 和測試錯誤
6. merge 到開發分支

**PR 模板**:
```markdown
## 描述
簡要說明改動

## 類型
- [ ] Feature
- [ ] Bug Fix
- [ ] Refactor
- [ ] Documentation

## 相關 Issue
Closes #123

## 測試方式
1. 步驟 1
2. 步驟 2

## 截圖 (如有)
[粘貼截圖]
```

---

## ⚙️ 後端開發指南

### 文件結構

```
packages/server/
├── src/
│   ├── index.ts         ← Express 服務器設置
│   ├── socket/          ← WebSocket 事件處理
│   │   └── GameServer.ts
│   ├── game/            ← 遊戲邏輯
│   │   ├── GameEngine.ts
│   │   └── RoomManager.ts
│   ├── middleware/      ← Express/Socket 中間件
│   │   └── auth.ts
│   └── services/        ← 外部服務
│       └── firebase.ts
├── .env                 ← 環境配置 (gitignore)
├── package.json
└── tsconfig.json
```

### 遊戲邏輯開發

#### 狀態機 (GameEngine)

```typescript
// 遊戲狀態流程
lobby → voting → quest → discussion → ended
  ↑
  └─ 返回 (投票失敗)

// 實現位置: packages/server/src/game/GameEngine.ts
```

#### 常見任務

**添加新角色**:
```typescript
// 1. packages/shared/src/types/game.ts
export type Role = '...' | 'new-role';

// 2. packages/server/src/game/GameEngine.ts
private getRoleTeam(role: Role): 'good' | 'evil' {
  if (role === 'new-role') return 'good'; // 或 'evil'
  // ...
}

// 3. 更新 AVALON_CONFIG
export const AVALON_CONFIG = {
  7: {
    roles: ['merlin', 'new-role', ...],
    // ...
  }
};
```

**添加新遊戲事件**:
```typescript
// 1. 在 @shared/types/game.ts 定義事件
export interface ClientToServerEvents {
  'game:new-event': (data: YourType) => void;
}

// 2. 在 GameServer.ts 註冊
socket.on('game:new-event', (data) => {
  this.handleNewEvent(socket, data);
});

// 3. 實現處理器
private handleNewEvent(socket: Socket, data: YourType): void {
  // 邏輯實現
}
```

### API 測試

使用 Postman 測試 API:

```bash
# 健康檢查
GET http://localhost:3001/health

# 驗證 Token (用於開發)
POST http://localhost:3001/auth/validate
Headers: {"Content-Type": "application/json"}
Body: {"token": "YOUR_ID_TOKEN"}
```

### WebSocket 事件調試

使用瀏覽器控制台:

```javascript
// 在前端檢查 Socket 事件
socket.on('game:state-updated', (room) => {
  console.log('Room state:', room);
});

socket.emit('game:vote', roomId, playerId, true);
```

---

## 🚀 部署指南

### 環境設置

#### 開發環境 (本地)
```bash
NODE_ENV=development
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

#### 測試環境 (Staging)
```bash
NODE_ENV=staging
PORT=3001
CORS_ORIGIN=https://staging.example.com
```

#### 生產環境
```bash
NODE_ENV=production
PORT=3001
CORS_ORIGIN=https://avalon.example.com
```

### CI/CD 流程 (GitHub Actions)

待建立的工作流:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm type-check
      - run: pnpm test

  deploy-frontend:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: vercel/action@v4
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}

  deploy-backend:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      # Railway 部署或類似的
```

### 部署清單

```
□ 代碼審查通過
□ 所有測試通過
□ 環境變數已配置
□ 數據庫遷移完成 (如有)
□ 性能測試通過
□ 安全掃描通過
□ 文檔已更新
```

---

## 🧪 測試指南

### 單元測試

```typescript
// packages/server/src/game/GameEngine.test.ts
import { GameEngine } from './GameEngine';
import { Room } from '@avalon/shared';

describe('GameEngine', () => {
  let engine: GameEngine;

  beforeEach(() => {
    const room: Room = { /* ... */ };
    engine = new GameEngine(room);
  });

  test('should assign roles correctly for 7 players', () => {
    engine.startGame();
    const roles = Object.values(engine.getRoom().players)
      .map(p => p.role);
    expect(roles).toContain('merlin');
  });

  test('should handle voting correctly', () => {
    engine.startGame();
    engine.submitVote('player1', true);
    // assertions...
  });
});
```

運行測試:
```bash
pnpm test
pnpm test:watch
pnpm test:coverage
```

### 集成測試

```bash
# 需要完整的服務啟動
pnpm test:integration

# 或手動測試:
1. 啟動後端: cd packages/server && pnpm dev
2. 啟動前端: cd packages/web && pnpm dev
3. 打開瀏覽器測試完整流程
```

### 性能測試

```bash
# 使用 Artillery 進行負載測試
npm install -g artillery

# 配置文件: load-test.yml
targets:
  - url: "http://localhost:3001"
scenarios:
  - name: "Create and play game"
    flow:
      - get:
          url: "/health"

# 運行測試
artillery run load-test.yml
```

---

## 📊 專案管理指南

### 進度追蹤

使用 GitHub Issues 和 Project Board:

**Issue 標籤** (labels):
```
- bug: 故障報告
- feature: 新功能
- enhancement: 功能改進
- documentation: 文檔
- help-wanted: 需要幫助
- good-first-issue: 適合新手
- blocked: 被阻止
```

**Milestone** (里程碑):
```
- Phase 1 MVP (本週)
- Phase 2 社群機器人 (下週)
- Phase 3 高級功能 (後續)
```

### 每日站會

```
時間: 每天 09:00
地點: 視訊會議

議程:
1. 昨天完成了什麼? (2 分鐘/人)
2. 今天的計劃? (2 分鐘/人)
3. 有什麼阻力嗎? (開放討論)
```

### Sprint 規劃

**衝刺週期**: 1 週

**衝刺前會議**:
- 優先級排序
- 容量估計
- 分配任務

**衝刺結束回顧**:
- 什麼進行得好?
- 什麼需要改進?
- 行動項目

---

## 🔐 安全性檢查清單

```
□ 所有敏感數據都在 .env (不提交)
□ 沒有硬編碼的密鑰或密碼
□ Firebase Security Rules 已設置
□ CORS 配置正確
□ 輸入驗證完成 (Zod schemas)
□ 認證令牌正確處理
□ 錯誤信息不洩露敏感信息
□ 依賴包定期更新
```

---

## 📚 資源和文檔

| 資源 | 連結 | 說明 |
|------|------|------|
| **項目 README** | `README.md` | 項目概述 |
| **Firebase 設置** | `docs/FIREBASE_SETUP.md` | 認證配置 |
| **遊戲規則** | `docs/RULES.md` (待建) | Avalon 規則說明 |
| **API 文檔** | (待建) | Socket.IO 事件列表 |
| **架構設計** | (待建) | 系統架構圖 |

---

## 🆘 常見問題

### "Cannot find module '@avalon/shared'"

```bash
# 確保 shared 包已編譯
cd packages/shared && pnpm build

# 檢查 tsconfig.json 的 paths
"paths": {
  "@shared/*": ["packages/shared/src/*"]
}
```

### "Socket connection failed"

```bash
# 檢查後端是否運行
curl http://localhost:3001/health

# 檢查 CORS 配置
CORS_ORIGIN=http://localhost:5173

# 檢查防火牆
```

### "Firebase initialization error"

```bash
# 檢查 .env 文件
ls -la packages/server/.env

# 驗證所有必須的環境變數
grep FIREBASE packages/server/.env
```

---

## 📝 代碼審查檢查清單

作為審查者，檢查:

```
□ 代碼遵循項目風格
□ 類型安全 (TypeScript)
□ 錯誤處理完整
□ 沒有性能瓶頸
□ 測試覆蓋率足夠
□ 文檔/評論清楚
□ 沒有硬編碼的值
□ 兼容舊版本 (如需要)
```

---

## 🎯 快速任務分配示例

### 給前端開發者

```
Feature: 改進遊戲棋盤 UI
- 添加玩家頭像環形排列
- 實時顯示投票結果
- 動畫過渡
Priority: High
Estimated: 4 小時
```

### 給後端開發者

```
Feature: 實現遊戲統計 API
- 保存遊戲結果到 Firebase
- 計算 ELO 評分
- 提供用戶統計端點
Priority: High
Estimated: 3 小時
```

### 給測試工程師

```
Task: 進行端到端測試
- 5 人遊戲流程
- 各種投票結果
- 連接失敗恢復
Priority: High
Estimated: 2 小時
```

---

## 🚀 下一步

1. **PM** - 建立 GitHub Project Board
2. **技術主管** - 建立 CI/CD 流程
3. **前端** - 開始組件開發
4. **後端** - 優化遊戲邏輯
5. **測試** - 設置測試框架

---

**需要幫助?**
- 查看相關文檔
- 在 #dev Slack 頻道提問
- 提出 GitHub Issue

祝開發順利! 🚀
