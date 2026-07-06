> 初版：2026-04-14 | 更新：2026-04-16

# 阿瓦隆百科全平台路線圖

## Scope

7 個正式角色：Merlin / Percival / 忠臣 / Mordred / Morgana / Assassin / Oberon。
不擴充 Lancelot / Galahad / Lady of the Lake 等非正式角色。

## 現況 (2026-04-16)

| 里程碑 | 狀態 | 說明 |
|---------|------|------|
| M0.1 內容盤點 | done | PR #6 |
| M0.2 Astro 5 POC | done | PR #5, 6 頁面, 繁中 slug |
| M0.3 Excel parser | done | 2146 場, 7 角色 JSON, 已 merge main |
| M0.4 Domain | blocked | 需信用卡註冊自訂域名 |
| CF Pages 部署 | done | https://avalonpediatw.pages.dev |

Repo 同時包含 React 遊戲平台 (packages/web) 與百科內容 (content/)。
目前 CF Pages 部署的是 React SPA (packages/web)。
Astro 百科站在 feat/m0.2-astro-poc 分支，尚未整合進 main。

---

## Phase 1 — 靜態百科 (Static Wiki)

**目標**: 公開可訪問的阿瓦隆百科站，涵蓋角色頁、遊戲規則、策略指南。

| 任務 | 說明 | 估時 |
|------|------|------|
| 1.1 Astro 整合 | 將 feat/m0.2-astro-poc 的 Astro 架構整合進 main，作為 apps/wiki 或獨立 build | 1.5d |
| 1.2 角色 JSON → Astro 頁面 | 7 個角色頁面讀取 content/_data/roles/*.json，顯示能力、陣營、基本描述 | 1.0d |
| 1.3 規則頁 | 遊戲規則、流程、人數配置 (5/6/7/8/9/10 人局) | 0.5d |
| 1.4 策略指南 | 各角色基礎策略、常見套路 | 1.0d |
| 1.5 UI/RWD | Tailwind + Noto Sans TC + 手機適配 | 0.5d |
| 1.6 SEO | sitemap, robots.txt, Open Graph meta | 0.3d |
| 1.7 CF Pages CI | GitHub Actions → build Astro → deploy CF Pages | 0.5d |
| 1.8 自訂域名 | avalonpedia.tw (待 M0.4 解鎖) | 0.2d |

**交付**: Astro 靜態站，CF Pages 部署，7 角色頁 + 規則頁 + 策略頁。
**估時**: 5.5 工作日

---

## Phase 2 — 遊戲統計 (Game Statistics)

**目標**: 展示 2146 場實戰資料的統計分析。

| 任務 | 說明 | 估時 |
|------|------|------|
| 2.1 角色勝率 | 各角色整體勝率 + 座位勝率 (已有 JSON 資料) | 0.5d |
| 2.2 勝負拆解 | 三紅/三藍死/三藍活 分佈圖表 | 0.5d |
| 2.3 人數 × 角色交叉 | 不同人數局各角色表現 | 1.0d |
| 2.4 座位分析 | 座位分佈 + 座位勝率熱力圖 | 0.5d |
| 2.5 排行榜 | 玩家生涯排名（勝場/勝率/場次） | 1.0d |
| 2.6 圖表元件 | Recharts or D3 視覺化元件 | 1.0d |

**交付**: 統計儀表板頁面，圖表互動式呈現。
**估時**: 4.5 工作日

---

## Phase 3 — UGC 使用者內容 (User-Generated Content)

**目標**: 讓社群成員貢獻內容。

| 任務 | 說明 | 估時 |
|------|------|------|
| 3.1 戰報上傳 | 用表單提交遊戲紀錄 (Google Form → Sheets → JSON) | 2.0d |
| 3.2 留言/討論 | Giscus (GitHub Discussions) 嵌入各頁面 | 0.5d |
| 3.3 策略投稿 | Markdown 投稿 → PR review → 發布 | 1.0d |
| 3.4 內容審核 | GitHub PR 審核流程 + 自動格式檢查 | 0.5d |

**交付**: 社群可提交戰報、留言、投稿策略文章。
**估時**: 4.0 工作日

---

## Phase 4 — 社群功能 (Community)

**目標**: 打造阿瓦隆社群平台。

| 任務 | 說明 | 估時 |
|------|------|------|
| 4.1 個人檔案 | 玩家個人頁面 (戰績/勝率/常用角色) | 2.0d |
| 4.2 賽季排名 | 按月/季/年的排行榜 | 1.0d |
| 4.3 錦標賽 | 線上/線下錦標賽頁面 + 報名 | 2.0d |
| 4.4 Discord 整合 | Bot 推送統計/排行到 Discord 頻道 | 1.0d |
| 4.5 成就系統 | 里程碑徽章 (百場/千場/連勝) | 1.0d |

**交付**: 完整社群功能，個人檔案、排名、錦標賽。
**估時**: 7.0 工作日

---

## 技術架構

```
                    CF Pages (靜態)
                         │
                    ┌─────┴─────┐
                    │ Astro SSG │ ← Phase 1-2
                    └─────┬─────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        content/      scripts/    packages/web
     (MD + JSON)    (Python       (React SPA —
                     parser)      遊戲平台,
                                  獨立部署)
```

- **Phase 1-2**: 純靜態 Astro SSG，CF Pages 部署，零後端
- **Phase 3**: Google Forms + Sheets 作為簡易 CMS，Giscus 留言
- **Phase 4**: 視需求評估是否加 serverless functions (CF Workers)

## 原則

1. 零新服務、零信用卡（CF Pages 免費方案足夠）
2. 靜態優先，能 SSG 就不 SSR
3. 7 角色 scope 不擴充
4. 繁體中文優先，slug 用英文 id
5. 每個 Phase 獨立可交付，不互相阻塞
