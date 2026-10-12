---
status: noted_reference_20260401
name: avalonpediatw session 2026-03-31 完整紀錄
description: avalonpediatw 平台本 session 所有開發內容、技術決策、bug 修復、未完成任務的完整快照
type: project
---
status: noted_reference_20260401

# avalonpediatw Session 2026-03-31 DNA Patch

## 專案基本資訊

| 項目 | 值 |
|------|-----|
| 平台 | avalonpediatw（阿瓦隆桌遊線上平台） |
| Repo | https://github.com/l12203685/avalonpediatw |
| 本地路徑 | `C:\Users\user\GoogleDrive\阿瓦隆百科\avalonpediatw\` |
| 架構 | Turborepo + pnpm workspaces（packages: shared, server, web） |
| 前端 | React 18 + TypeScript + Vite + Zustand + Framer Motion + Tailwind |
| 後端 | Express + Socket.IO + TypeScript |
| DB | Supabase PostgreSQL（Render 上尚未完整設定） |
| 部署 | Render（render.yaml 管理） |
| Branch | main |

---
status: noted_reference_20260401

## 本 Session 完成項目

### 1. ProfilePage Follow/Unfollow 按鈕
**檔案：** `packages/web/src/pages/ProfilePage.tsx`

- `isMe` 移至 component scope（從 useEffect 內移出）
- 新增 `isFollowingUser`, `followLoading` state
- useEffect on mount 呼叫 `checkFollowing(token, profileUserId)`
- `handleFollowToggle` async function（follow/unfollow + toast feedback）
- 按鈕只在 `!isMe` 時顯示，位於 avatar card 內
- "最近 10 局" 改為動態 `profile.recent_games.length`

```typescript
const isMe = !profileUserId || profileUserId === 'me';
const [isFollowingUser, setIsFollowingUser] = useState(false);
const [followLoading, setFollowLoading] = useState(false);
```

### 2. HomePage 好友導航按鈕
**檔案：** `packages/web/src/pages/HomePage.tsx`

- 玩家名稱 init 從 localStorage 讀取：`useState(currentPlayer?.name ?? localStorage.getItem('avalon_player_name') ?? '')`
- createRoom / joinRoom 時寫入 `localStorage.setItem('avalon_player_name', playerName.trim())`
- 新增「追蹤列表」＋「快速練習」兩格 2-column grid nav button row

### 3. 用戶 Feedback + Error Reporting 系統

**新檔案：** `packages/server/src/routes/feedback.ts`
- POST `/api/feedback` — 使用者回饋，存 Supabase + Discord 通知
- POST `/api/feedback/errors` — 自動捕捉 JS 錯誤，1hr dedup for Discord
- `sendDiscord()` helper 用 `DISCORD_WEBHOOK_URL` env var
- `resolveUser()` 支援 custom JWT + Firebase 可選認證
- Rate limit: 10/min feedback, 30/min errors

**修改：** `packages/web/src/services/api.ts`
- 新增 `submitFeedback(data, token?)` — POST /api/feedback
- 新增 `submitError(data)` — POST /api/feedback/errors，swallows all errors，絕不 throw

**修改：** `packages/web/src/App.tsx`
- `window.addEventListener('error', ...)` + `unhandledrejection` → 自動呼叫 `submitError()`
- 帶 message, stack, 當前 gameState

### 4. FloatingControls 整合 FeedbackButton
**檔案：** `packages/web/src/components/FloatingControls.tsx`

- 原 FeedbackButton 獨立 component 造成與 ChatPanel z-index 衝突（兩者都是 fixed bottom-right）
- 解法：feedback form 內嵌進 FloatingControls（左下角），刪除獨立 FeedbackButton component
- 新增 state: `feedbackOpen`, `feedbackType`, `feedbackMsg`, `feedbackSending`
- 新增 `handleFeedbackSubmit` async function
- bug/suggestion type selector + textarea + submit UI
- **App.tsx 同步移除 `<FeedbackButton />` render**

### 5. GamePage ELO Delta 顯示
**檔案：** `packages/web/src/pages/GamePage.tsx`

- 遊戲結束畫面的玩家 card 顯示 ELO 變化
- 綠色正值 `+N`，紅色負值 `-N`
- 讀取 `room.eloDeltas?.[player.id]`

```tsx
{room.eloDeltas?.[player.id] !== undefined && (
  <span className={`text-xs font-bold flex-shrink-0 ${
    room.eloDeltas[player.id] >= 0 ? 'text-green-400' : 'text-red-400'
  }`}>
    {room.eloDeltas[player.id] >= 0 ? '+' : ''}{room.eloDeltas[player.id]}
  </span>
)}
```

**shared type 新增：** `packages/shared/src/types/game.ts`
```typescript
eloDeltas?: Record<string, number>  // 加入 Room interface
```

### 6. GamePage Bug 修復

**BUG-001 Vote 載入狀態卡死**
- 原因：try/finally 同步 socket.emit → isVoting 在同 tick reset
- 修法：setTimeout(3000) fallback + useEffect watching `room.votes` 偵測 server ACK

```typescript
const handleVote = (approve: boolean): void => {
  if (isVoting) return;
  setIsVoting(true);
  submitVote(room.id, currentPlayer.id, approve);
  setTimeout(() => setIsVoting(false), 3000);
};
useEffect(() => {
  if (!room || !currentPlayer) return;
  if (room.votes[currentPlayer.id] !== undefined) setIsVoting(false);
}, [room?.votes]);
```

**Role Reveal Modal 修復**
- 新增 `prevRoomState = useRef<string | null>(null)`
- 追蹤 lobby→voting transition 觸發顯示
- rematch 時重置 voting state

### 7. LeaderboardPage DB 離線 Banner
**檔案：** `packages/web/src/pages/LeaderboardPage.tsx`

- 新增 `dbOffline` state
- 原 `fetchLeaderboard()` 改為 raw `fetch()` 偵測 "Database not configured" 訊息
- DB 離線時顯示 `AlertTriangle` 警告 banner
- Imports: `AlertTriangle`（`DatabaseZap` 不在 lucide-react，改用此）, `LeaderboardEntry` type, `SERVER_URL`

### 8. GameServer Bug 修復
**檔案：** `packages/server/src/socket/GameServer.ts`

- **BUG-003**：vote/quest/assassinate handler 入口加 playerId 驗證
  ```typescript
  const playerId = socket.data.playerId as string | undefined;
  if (!playerId) { socket.emit('error', 'Not authenticated in room'); return; }
  ```
- **BUG-002**：`currentRoom.eloDeltas = eloDeltas;`（直接賦值，Room type 已加欄位）
  - saveGameRecords 後建 eloDeltas map（supabaseId → uid），attach to room，重新廣播
- **BUG-004**：spectator dedup 優先用 `socket.data.playerId`，fallback `socket.data.user?.uid`
- **BUG-008**：`generateRoomCode(attempt = 0)` 加 50 次嘗試上限

### 9. render.yaml 更新
- 新增 `DISCORD_WEBHOOK_URL`（實際 webhook 值）
- 新增 `SUPABASE_URL` 和 `SUPABASE_SERVICE_KEY`（sync: false 佔位符）

### 10. Phase 3 AI Self-Play 混合代理人族群
**檔案：** `packages/server/src/ai/SelfPlayScheduler.ts`（主要改動）

**BATCH_CONFIGS** — 8 個輪換設定：
```typescript
const BATCH_CONFIGS = [
  { playerCount: 5,  mode: 'normal'   },
  { playerCount: 6,  mode: 'hard'     },
  { playerCount: 7,  mode: 'mixed'    },
  { playerCount: 8,  mode: 'normal'   },
  { playerCount: 5,  mode: 'baseline' },
  { playerCount: 9,  mode: 'hard'     },
  { playerCount: 10, mode: 'mixed'    },
  { playerCount: 6,  mode: 'baseline' },
];
```

**buildAgents()** — 異質代理人族群建構：
- `normal`：全 HeuristicAgent normal
- `hard`：全 HeuristicAgent hard
- `mixed`：交錯 hard/normal HeuristicAgent
- `baseline`：偶數 HeuristicAgent normal + 奇數 RandomAgent（對照組）

**getSelfPlayStatus()** 新增 `nextConfig` 欄位

**匯出：** `export { buildAgents, BATCH_CONFIGS }`

**檔案：** `packages/server/src/routes/api.ts`

- `/api/ai/selfplay` POST 參數從 `agentType: 'heuristic'|'random'` 改為 `mode: 'normal'|'hard'|'mixed'|'baseline'`
- import 改為 `{ getSelfPlayStatus, buildAgents }` from SelfPlayScheduler
- 移除直接 import `RandomAgent`, `HeuristicAgent`（現由 buildAgents 封裝）
- Response 回傳 `mode` + `playerCount` 取代 `agentType`

**Commit：** `2b29606` — "feat(ai): Phase 3 self-play mixed agent populations"

---
status: noted_reference_20260401

## 未完成任務（必須在下個 session 處理）

### CRITICAL — Render Dashboard 手動設定（無法自動化）
1. **SUPABASE_URL** — 在 Render dashboard 手動設定（憑證不在本地）
2. **SUPABASE_SERVICE_KEY** — 同上
3. **DISCORD_WEBHOOK_URL** — webhook URL 已在對話中曝光，需重新生成新的

### 手動 Supabase SQL（建表）
feedback.ts 和 friends.ts 的 comment 中有 SQL，需在 Supabase dashboard 執行：
- `feedback` 表
- `error_reports` 表
- `friendships` 表

### BUG-007（部分修復）
Production `/api/ai/stats` 回傳舊格式 `{ message, totalGames, totalEvents }`，原因是 Render 跑舊 build。新 push 後應自動修復，但需確認 Render redeploy 完成。

---
status: noted_reference_20260401

## 關鍵技術架構備忘

### Socket.IO 身份認證模式
- `socket.data.playerId` 是房間內的 canonical in-room identity
- `socket.data.user?.uid` 是 Firebase UID（可能不存在）
- 所有 socket handler 入口必須先驗證 `socket.data.playerId`

### ELO Delta 資料流
```
saveGameRecords() → 計算 eloDeltas (supabaseId → uid map)
→ currentRoom.eloDeltas = eloDeltas
→ io.to(roomId).emit('room:update', room)
→ frontend: room.eloDeltas?.[player.id]
```

### Feedback 系統架構
```
前端 FloatingControls (左下) → submitFeedback() → POST /api/feedback
前端 App.tsx onerror        → submitError()    → POST /api/feedback/errors
後端 feedback.ts            → Supabase save + Discord notify
Discord dedup: error_reports 在 1hr 內相同 message 不重複通知
```

### AI Self-Play 資料生成策略
- 每 30 分鐘 1 batch，5 games per batch
- 8 個 config 輪換 → 覆蓋 5-10 人局 × 4 種 agent 組合
- baseline mode 用於建立 HeuristicAgent vs RandomAgent 勝率基準線
- mixed/hard mode 生成高品質對局數據

### Rate Limiting 規則
```
publicLimiter:  60 req/min
adminLimiter:   10 req/min
feedbackLimit:  10 req/min
errorLimit:     30 req/min
```

### render.yaml 注意事項
- `sync: false` 的 env var 只是佔位符，實際值需在 Render dashboard 手動設定
- render.yaml 更改只在首次 service 建立或手動 sync 時生效
- 不要把 secrets 的實際值寫進 render.yaml（已犯錯：Discord webhook 曾寫入）

---
status: noted_reference_20260401

## QA agent 發現的 9 個 Bug 狀態

| Bug | 描述 | 狀態 |
|-----|------|------|
| BUG-001 | Vote 按鈕載入狀態卡死 | ✅ 修復（setTimeout + useEffect） |
| BUG-002 | ELO delta 未顯示在結束畫面 | ✅ 修復（Room type + GameServer） |
| BUG-003 | 未認證 socket 可觸發 vote/quest | ✅ 修復（playerId guard） |
| BUG-004 | 觀眾重複計算 | ✅ 修復（socket.data.playerId dedup） |
| BUG-005 | Follow 按鈕缺失 | ✅ 修復（ProfilePage） |
| BUG-006 | 好友導航入口缺失 | ✅ 修復（HomePage） |
| BUG-007 | /api/ai/stats 回傳格式錯誤 | ⚠️ Render 重新部署後應修復 |
| BUG-008 | generateRoomCode 無上限遞迴 | ✅ 修復（50 attempt cap） |
| BUG-009 | DB 離線無提示 | ✅ 修復（LeaderboardPage banner） |

---
status: noted_reference_20260401

## 下個 Session 建議優先序

1. **確認 Render 已 redeploy 最新 commit（2b29606）**
2. **手動設定 Supabase env vars 在 Render dashboard**
3. **重新生成 Discord webhook URL**（舊的已曝光）
4. **執行 Supabase SQL 建表**（feedback, error_reports, friendships）
5. 確認 BUG-007 `/api/ai/stats` 已修復
6. 測試 `/api/ai/selfplay` 新 mode 參數
7. 考慮下個功能：friends list 頁面 UI、遊戲歷史詳情頁
