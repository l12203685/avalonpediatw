> 規劃產出時間：[2026-04-14 13:22 +08]

# Plan C — 阿瓦隆百科 Production 平台

## Scope 釐清
Repo 同時包含 (1) 即時遊戲平台 (React+Socket.IO+Firebase) + (2) Wiki/百科 (Astro+Excel parser)。本計劃聚焦 (2) Wiki 上線 production。遊戲平台維持現狀。

## Goal
把 M0.3 parser 產出的 6 張核心 YAML 變成公開訪問的阿瓦隆百科靜態站。

## MVP Definition
GitHub Pages 部署的 Astro 靜態站，首頁 + 6 子頁（角色/陣容/規則/生涯排序/戰績排序/同贏同輸矩陣），build time 讀 YAML，無 server 無 DB。

## Milestones

| M | 目標 | 交付 | 估時 |
|---|---|---|---|
| M0.3 收尾 | Parser 產線化 | pytest + 去 E:/ + AVALON_MASTER_XLSX env | 0.6 d |
| M1 | Astro 骨架 | apps/wiki + 6 Zod schema | 1.0 d |
| M2 | 頁面模板 | 首頁 + 6 動態路由 | 1.5 d |
| M3 | 樣式中文 | Tailwind + Noto Sans TC + RWD | 0.5 d |
| M4 | CI 部署 | GH Actions → gh-pages | 0.4 d |
| M5 | 內容流程文件 | CONTENT_WORKFLOW.md | 0.2 d |

MVP 總估：4.2 工作日

## Tech Stack
Astro 4 + Content Collections + Zod + Tailwind + Python parser (本地) + **GitHub Pages**（不 Firebase/Render）。零新服務零信用卡。

## Critical Path
M0.3 → M1 → M2 → M3 / M4 平行 → M5。瓶頸 M2。

## Risk Register
- R1 牌譜表 3117×48 → 3MB 拖慢 build (M): 不直接進 Collection，切 JSON chunks
- R2 繁中 slug (M): 用 id 欄做 slug
- R3 xlsx schema 變動 (M): Zod + _parse_summary.yaml contract check
- R4 GitHub Pages public → 敏感外流 (H): xlsx 永不進 repo，YAML 人工掃敏，玩家 ID 若本名先 anonymize
- R5 Wiki 與遊戲平台耦合 (M): 獨立 workspace package

## Open Questions
無。預設玩家顯示名沿用 xlsx 暱稱，含本名則 M1 加 anonymize pass。

## First Actionable
subagent 執行 M0.3 收尾：移除 E:/ hardcode、改讀 env、新增 4 個 fixture pytest。不動前端。
