---
status: done
priority: high
created: 2026-04-01T06:21
---

# avalonpediatw 前端 9 個問題

來源：Edward 2026-04-01 測試 https://avalon-game-platform.web.app

## 阻塞級（影響核心功能）

1. **建立房間失敗** — WebSocket 連不上 Render 後端。檢查 CORS_ORIGIN 設定 + Socket.IO transport config。可能需要在 Render 加 WebSocket 支援。
2. **排行榜資料庫未連線** — 需要接 Firebase Realtime DB 或從牌譜 Google Sheet 拉資料。先用 Sheet 資料做靜態排行。
3. **登入沒有按鈕** — Firebase Auth Google login UI 沒渲染。檢查 FirebaseUI 或自建 login component。

## 功能缺失

4. **新手指南點了沒反應** — routing 或 component 沒接。
5. **提交貢獻點了沒反應** — 同上。
6. **文章分類點了沒反應** — 同上。
7. **快速練習點了沒反應** — 同上。

## UI/UX 問題

8. **文章顯示位置** — 列表應在左側，內容在中間。markdown 格式跑掉。
9. **只有 17 篇文章** — 檢查 wiki content 來源，可能只載入了部分。

## 資料問題

10. **AI 自對弈統計是假資料** — self-play 未啟用，顯示 mock data。需要真實數據或隱藏此頁面。

## 修復優先序

1 → 3 → 2 → 8 → 9 → 4-7 → 10
