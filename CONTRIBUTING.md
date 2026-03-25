# 貢獻指南

感謝你為 Avalon 項目做出貢獻! 請遵循以下指南以確保順利的協作。

---

## 📖 行為準則

- 尊重所有團隊成員
- 提供建設性反饋
- 專注於代碼質量
- 幫助新手上手

---

## 🔄 開發流程

### 1. Issue 工作流

```
1. 查看 GitHub Issues
2. 選擇 "需要幫助" 的 Issue
3. 評論 "我要做這個"
4. PM 分配給你
5. 建立分支並開始開發
```

### 2. 分支命名規則

```bash
feature/short-description      # 新功能
bugfix/short-description       # bug 修復
refactor/short-description     # 代碼重構
docs/short-description         # 文檔更新
```

### 3. 提交信息規範

遵循 [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type**:
- `feat`: 新功能
- `fix`: bug 修復
- `refactor`: 代碼重構
- `docs`: 文檔
- `style`: 代碼風格
- `test`: 測試
- `perf`: 性能
- `ci`: CI/CD

**Example**:
```
feat(game): Implement voting phase logic

- Add vote submission handler
- Calculate vote results
- Transition to next phase

Closes #42
```

### 4. Pull Request 流程

```bash
# 確保最新
git fetch origin
git rebase origin/claude/avalon-game-platform-0hDJ1

# 推送分支
git push -u origin feature/your-feature

# 在 GitHub 建立 PR
# 填寫 PR 模板
# 等待審查 (最多 24 小時)
```

**PR 模板**:
```markdown
## 📝 描述
簡要說明改動

## 🔗 相關 Issue
Closes #123

## 🧪 測試方式
步驟:
1. ...
2. ...

## 📸 截圖 (如有)
[粘貼截圖]

## ✅ 檢查清單
- [ ] 代碼遵循風格指南
- [ ] 本地測試通過
- [ ] 沒有 lint 錯誤
- [ ] 提交信息清楚
- [ ] 文檔已更新
```

---

## 🛠️ 代碼風格

### TypeScript

```typescript
// ✅ 好
interface User {
  id: string;
  name: string;
  email?: string;
}

function createUser(user: User): Promise<User> {
  // ...
}

// ❌ 避免
function createUser(user) {
  // ...
}
```

### React

```typescript
// ✅ 好
export function GameBoard(): JSX.Element {
  const { room } = useGameStore();

  return <div>{/* 內容 */}</div>;
}

// ❌ 避免
export const GameBoard = () => {
  const room = useGameStore().room;
  return <div>{/* 內容 */}</div>;
};
```

### 命名規則

```
文件: kebab-case
  - GameBoard.tsx
  - user-service.ts

函數/變數: camelCase
  - function handleVote() {}
  - const currentUser = {}

類/組件: PascalCase
  - class GameEngine {}
  - function UserProfile() {}

常數: UPPER_SNAKE_CASE
  - const MAX_PLAYERS = 10;
```

---

## 🧪 測試要求

### 單元測試

```bash
pnpm test

# 目標: 80%+ 覆蓋率
```

### 類型檢查

```bash
pnpm type-check
# 沒有錯誤
```

### Linting

```bash
pnpm lint
# 沒有警告
```

### 本地測試

```bash
pnpm dev
# 手動測試你的改動
```

---

## 📚 文檔更新

每當你添加新功能時:

```markdown
# 更新相應的文檔

1. README.md (如果是公共功能)
2. docs/*.md (詳細說明)
3. JSDoc 評論 (代碼文檔)
4. CHANGELOG.md (改動日誌)
```

**Example JSDoc**:
```typescript
/**
 * Submit a vote for quest team approval
 *
 * @param roomId - The game room ID
 * @param playerId - The voting player ID
 * @param vote - true for approve, false for reject
 * @throws Error if voting phase is not active
 */
export function submitVote(
  roomId: string,
  playerId: string,
  vote: boolean
): void {
  // ...
}
```

---

## 🔍 審查指南

### 作為作者

```
提交 PR 時:
□ 代碼質量高
□ 測試完整
□ 文檔清楚
□ 遵循風格指南
□ 沒有 WIP (Work In Progress)
```

### 作為審查者

```
檢查 PR 時:
□ 代碼邏輯正確
□ 性能可接受
□ 沒有安全問題
□ 測試覆蓋充分
□ 文檔準確
□ 風格一致
```

**反饋示例**:
```
❌ 不好:
"這個函數不好"

✅ 好:
"這個函數的時間複雜度是 O(n²)，
可以用 Map 優化到 O(n)。
參考: [鏈接]"
```

---

## 🚀 發布流程

1. **版本號**更新 (Semantic Versioning):
   - Major: 破壞性改動 (1.0.0 → 2.0.0)
   - Minor: 新功能 (1.0.0 → 1.1.0)
   - Patch: bug 修復 (1.0.0 → 1.0.1)

2. **更新 CHANGELOG.md**

3. **建立 Git Tag**:
   ```bash
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```

4. **建立 GitHub Release**

---

## 🆘 需要幫助?

### 資源

- **問題?** → GitHub Issues
- **快速問題?** → Slack #dev
- **文檔?** → 查看 TEAM_GUIDE.md
- **卡住了?** → 尋求同伴幫助

### 本地開發故障排除

```bash
# 依賴問題
pnpm install
pnpm clean

# 端口被佔用
lsof -i :3001  # 查看進程
kill -9 <PID>  # 終止進程

# 類型錯誤
pnpm type-check

# 遠程問題
git fetch origin
git status
```

---

## 📝 Commit 最佳實踐

```bash
# ✅ 好: 小的、有目的的 commits
git commit -m "feat: Add vote validation"
git commit -m "test: Add vote validation tests"

# ❌ 避免: 大的、混雜的 commits
git commit -m "Fixed stuff and updated things"
```

### Commit 原則

1. **一次一個概念** - 每個 commit 做一件事
2. **原子化** - 每個 commit 都能獨立運行
3. **清楚的信息** - 描述 "為什麼" 而不是 "什麼"
4. **適當的粒度** - 不要太小也不要太大

---

## 🔄 更新依賴

```bash
# 查看過期的包
pnpm outdated

# 更新特定包
pnpm update package-name@latest

# 更新所有包 (謹慎)
pnpm update --latest

# 檢查安全漏洞
pnpm audit
pnpm audit --fix
```

---

## 📊 性能指南

目標:

| 指標 | 目標 | 檢查 |
|------|------|------|
| 首屏加載 | < 3s | `pnpm build && pnpm preview` |
| WebSocket 延遲 | < 100ms | 瀏覽器 DevTools |
| 遊戲邏輯 | < 10ms | Node profiler |
| 內存使用 | < 100MB | `node --inspect` |

---

## 🔐 安全檢查清單

在提交 PR 前:

```
□ 沒有硬編碼的密鑰
□ 敏感數據在 .env
□ 輸入已驗證 (Zod)
□ 認證檢查完整
□ 沒有 XSS 漏洞
□ SQL/NoSQL 注入防護
□ CORS 配置正確
□ 依賴包已審計
```

---

感謝你的貢獻! 💙
