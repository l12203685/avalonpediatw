# AVALON / 阿瓦隆百科 全電腦資產總清單

**產出時間**: 2026-04-14 08:28 +08
**目的**: 整併所有阿瓦隆相關資料到 `C:/Users/admin/workspace/avalonpediatw/` 作為 single source of truth
**狀態**: Stage 1 — 僅產 inventory 與建議，不搬檔案

---

## 0. 掃描範圍與總量

| 硬碟 | 掛載狀態 | 命中數 | 主要聚落 |
|------|----------|--------|----------|
| C:\ | OK | 107 hits | `GoogleDrive\專案\阿瓦隆百科\`、`workspace\avalonpediatw\`、`downloads\阿瓦隆百科_同步閒聊\`、credentials、staging、LYH/ZP |
| E:\ | OK | 9 hits | `E:\阿瓦隆百科\`、`E:\投資交易\交易系統\bots\avalon\` |
| D:\ | OK | 無命中 | — |

**三大聚落體積**:
- `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\`: 197 files, **407.6 MB**（主力內容庫）
- `E:\阿瓦隆百科\`: 11 files, **349.7 MB**（Excel master + 原始素材）
- `C:\downloads\阿瓦隆百科_同步閒聊\`: 3382 files, **1145.5 MB**（Discord 長年圖片/影片歷史）

---

## 1. 現況：既有 single source `C:\Users\admin\workspace\avalonpediatw\`

**歸屬**: Edward 自己的 repo（remote: `l12203685/avalonpediatw`，branch `claude/avalon-game-platform-0hDJ1`；branch 名稱是 Claude Code worktree 慣例，非上游）

**現有結構**:
```
avalonpediatw/
├── packages/{server,shared,web}/   # monorepo app code (pnpm + turbo)
├── wiki/                           # 入門基礎 / 角色 / 派票策略 / 理論框架 /
│                                   # 湖中與投票 / 進階思考 / 覆盤 / QnA
├── docs/                           # DEPLOYMENT / FIREBASE / PERFORMANCE 等
├── scripts/  supabase/  Dockerfile{,.server}  docker-compose.yml
├── deploy.{bat,sh}  render.yaml  vercel.json  railway.json  firebase.json
└── README / CLAUDE / DEPLOY* / DEVELOPMENT_PLAN / GAME_FLOW / PHASE1_PROGRESS
```

**缺的**: 內容素材（影片/圖片/csv/pdf/html）、資料集（牌譜、聊天紀錄）、早期 prototype repos、Excel 源檔。

---

## 2. 分類 Inventory（含搬移建議）

動作代碼:
- **MOVE**：搬入 workspace repo（透過 git / copy）
- **LINK**：太大或 sync 機制特殊，留原地 + 在 repo 建 reference
- **DEDUP**：已確認重複，之後可刪
- **IGNORE**：誤殺（不相關），保留原地
- **REVIEW**：需 Edward 確認

---

### A. 內容素材（遊戲規則、角色、百科、教學、中文化、圖片、影片）

| 原路徑 | 類型 | 大小 | 建議 | 備註 |
|--------|------|------|------|------|
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\documents\` | 文件夾（9 檔） | ~1 MB | **MOVE → `content/rules/`** | 官方規則 PDF、進階規則、簡報教學、原始 Resistance 規則、基礎班整理 |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\wiki\` | 2 檔 md | ~13 KB | **DEDUP** | 與 workspace `wiki/阿瓦隆遊戲機制_代碼分析.md` + `wiki/QnA/阿瓦隆_Q&A_...md` **MD5 完全一致**，可刪 GD 版 |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\archive\HackMD_Team_備份_extracted\` | 12 檔 md | ~55 KB | **MOVE → `content/hackmd_backup/`** | HackMD 團隊備份（湖中女神、S1/S2 戰績、第 1–7 集） |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\_已整併_原檔\` | 2 檔 md | ~小 | **MOVE → `content/hackmd_backup/`** | 內黑的使用.md、主題.md（從 HackMD 整併過來的原檔） |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\` | 6 部 mp4 | ~52 MB | **LINK**（考慮） | 刺客/奧伯倫/梅林/派西/莫德雷德/莫甘娜角色短片。建議 Git LFS 或保留 GoogleDrive 做 ref |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\documents\🛡️阿瓦隆百科 線上阿瓦隆實戰比賽 規則說明🛡️.html` | html | 44 KB | **MOVE → `content/rules/`** | 實戰比賽規則；`E:\阿瓦隆百科\` 有同檔（MD5 一致，可 DEDUP） |
| `C:\Users\admin\.gstack\worktrees\3e8339d3\assets\素材\🛡️...🛡️.html` | html | 44 KB | **REVIEW** | 與 GD 版內容有差異（MD5 不同），可能是早期版 |
| `C:\downloads\阿瓦隆百科_同步閒聊\` | 3382 檔 | 1145 MB | **LINK**（強烈建議不搬） | Discord/LINE 長年同步閒聊圖片；體積過大，建議保留原地並於 repo 內加 `assets/EXTERNAL_REFS.md` 記錄路徑 |
| `E:\阿瓦隆百科\🛡️...🛡️.html` | html | 44 KB | **DEDUP** | 與 GD 版 MD5 一致 |
| `E:\阿瓦隆百科\2020~2023 DC群 (共113局).md` | md | 小 | **MOVE → `data/`** | 113 局原始對戰紀錄文字 |
| `E:\阿瓦隆百科\lobby.jpg, merlin.png, timer.png, vote.png` | 4 圖 | — | **MOVE → `assets/`** | UI/角色圖 |
| `E:\阿瓦隆百科\gameRecordsDataAnon_20220606.json` | json | — | **MOVE → `data/`** | 匿名化對局資料集（2022-06-06） |

---

### B. 程式碼（現行 app + 早期 prototypes）

| 原路徑 | 類型 | 大小 | 建議 | 備註 |
|--------|------|------|------|------|
| `C:\Users\admin\workspace\avalonpediatw\packages\{server,shared,web}` | monorepo | 現行 | **KEEP**（現行主體） | 目前開發中 |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\_github_repos\avalonpediatw-game-server\` | 16 檔 / 0.1 MB | 早期 | **MOVE → `archive/prototypes/game-server-v0/`** | 早期版 game-server snapshot |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\_github_repos\avalonpediatw-line-discord-sync\` | 13 檔 / 8.2 MB | 早期 | **MOVE → `archive/prototypes/line-discord-sync/`** | LINE⇄Discord 橋接；E 槽有同名目錄需 REVIEW 是否重複 |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\_github_repos\avalon_game\` | 5 檔 Python | 早期 | **MOVE → `archive/prototypes/avalon_game_py/`** | client/server/game/network 原型（含 networkTutrorial, Version_0.04） |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\_github_repos\avalon_online\` | 21 檔 Python | 早期 | **MOVE → `archive/prototypes/avalon_online_py/`** | app/auth/chat/game/history Flask-like 原型 |
| `E:\投資交易\交易系統\bots\avalon\avalon line_bot.py` | 3.3 KB | 工具 | **MOVE → `archive/prototypes/line_bot/`** | LINE bot 舊腳本（雖放在交易目錄但屬阿瓦隆） |
| `E:\投資交易\交易系統\bots\sync\avalonpediatw-line-discord-sync\` | 目錄 | 工具 | **REVIEW / DEDUP** | 與 GD `_github_repos\avalonpediatw-line-discord-sync\` 疑似同內容，需 diff |
| `C:\Users\admin\workspace\discord_archive_avalon.py` | 7 KB | 腳本 | **MOVE → `scripts/archive/`** | Discord 存檔工具 |
| `C:\Users\admin\.gstack\worktrees\3e8339d3\analysis\avalon_analysis.py` | 81 KB | 分析腳本 | **MOVE → `scripts/analysis/`** | 分析腳本（大檔，內含算法） |
| `C:\Users\admin\workspace\scan_avalon.py` | 1.6 KB | 本次掃描產物 | **IGNORE / 刪除** | 本次整併用工具 |

---

### C. 設計文件（PRD / 架構 / 需求）

| 原路徑 | 類型 | 建議 | 備註 |
|--------|------|------|------|
| `C:\Users\admin\workspace\avalonpediatw\docs\*.md` | 現行 5 份 | **KEEP** | DEPLOYMENT / FIREBASE / PERFORMANCE / BOT_SETUP |
| `C:\Users\admin\workspace\avalonpediatw\{DEPLOY*,DEVELOPMENT_PLAN,GAME_FLOW,PHASE1_PROGRESS,TEAM_*}.md` | 現行根目錄 | **KEEP**（可整併入 `docs/`） | 建議子整理 |
| `C:\Users\admin\GoogleDrive\staging\avalonpediatw_ui_requirements.md` | 1.3 KB | **MOVE → `docs/requirements/`** | UI 需求 |
| `C:\Users\admin\GoogleDrive\staging\dna_patches\_done\20260329_prove_self_avalon.md` | 1.3 KB | **MOVE → `docs/history/`** | DNA patch（已完成） |
| `C:\Users\admin\GoogleDrive\staging\dna_patches\_done\20260331_avalonpediatw_session_full.md` | 11 KB | **MOVE → `docs/history/`** | Session 紀錄 |
| `C:\Users\admin\GoogleDrive\staging\dna_patches\_done\20260331_avalon_wiki_deep_read.md` | 1.7 KB | **MOVE → `docs/history/`** | Wiki 深讀筆記 |
| `C:\Users\admin\GoogleDrive\staging\window1_directives\_done\20260401_avalonpediatw_9bugs.md` | 1.3 KB | **MOVE → `docs/history/`** | 9 bugs 清單 |
| `C:\Users\admin\ZP\thinking\avalon.md` | 4.3 KB | **LINK** | ZP public methodology 保留原地，repo 內加 ref |

---

### D. 資料（牌譜、統計、爬蟲、聊天紀錄）

| 原路徑 | 類型 | 大小 | 建議 | 備註 |
|--------|------|------|------|------|
| `E:\阿瓦隆百科\阿瓦隆百科.xlsx` | Excel master | 8.8 MB | **MOVE → `data/master/`**（或 LINK） | **重要！** master 試算表源檔 |
| `E:\阿瓦隆百科\阿瓦隆百科機器人.xlsx` | Excel | 3.3 MB | **MOVE → `data/master/`** | bot 試算表 |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\Google_Sheets_Export\*.csv` | 30 份 CSV | ~5.5 MB | **MOVE → `data/sheets_export/`** | Google Sheets 各分頁匯出（牌譜/戰績/生涯/個人資料卡/模擬等） |
| `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\data\阿瓦隆百科 - 牌譜.csv` | 875 KB | 資料 | **DEDUP vs** 上面 `阿瓦隆百科_牌譜.csv` | 需 diff |
| `E:\阿瓦隆百科\gameRecordsDataAnon_20220606.json` | 已列 A | — | — | — |
| `E:\投資交易\量化金融文獻\ResistanceAvalon_OriginRule.pdf` | 6.9 MB | **MOVE → `content/rules/`** | 原作 Resistance 原始規則 PDF |
| `C:\Users\admin\GoogleDrive\聊天記錄\jsonl\discord_archive_avalon_2026-04-11.jsonl` | 290 KB | **MOVE → `data/chat/`** | Discord 歷史 jsonl |
| `C:\Users\admin\GoogleDrive\聊天記錄\LINE_raw\R怪*阿瓦隆*.txt (2023-2026)` | 4 檔 ~4.7 MB | **MOVE → `data/chat/line/`** | LINE R怪群聊天 |
| `C:\Users\admin\GoogleDrive\聊天記錄\LINE_raw\[LINE] 阿瓦隆-百科小組的聊天.txt` | 650 KB | **MOVE → `data/chat/line/`** | 百科小組 LINE |
| `C:\Users\admin\GoogleDrive\聊天記錄\LINE_raw\阿瓦隆培訓*.txt` | 3 檔 ~1.8 MB | **MOVE → `data/chat/line/`** | 培訓群 |
| `C:\Users\admin\GoogleDrive\staging\avalon_analysis_2026-04-04.md` | 1.8 KB | **MOVE → `data/analysis/`** | 近期分析報告 |
| `C:\Users\admin\GoogleDrive\staging\avalon_stats_raw.txt` | 32 KB | **MOVE → `data/analysis/`** | raw 統計 |

---

### E. 備份 / 重複 / Credentials

| 原路徑 | 建議 | 備註 |
|--------|------|------|
| `C:\Users\admin\.claude\credentials\avalon-game-platform-firebase-adminsdk.json` | **KEEP 原地** | 機敏，絕不進 repo |
| `C:\Users\admin\.claude\credentials\avalonpediatw_render_env.txt` | **KEEP 原地** | 機敏 |
| `C:\Users\admin\.claude\credentials\avalonpediatw_vercel_env.txt` | **KEEP 原地** | 機敏 |
| `C:\Users\admin\.claude\credentials\gcloud_adc_avalon_game_platform.json` | **KEEP 原地** | 機敏 |
| `C:\Users\admin\.claude\credentials\google_sheets_avalonpediatw.json` | **KEEP 原地** | 機敏；與 `.credentials\avalonpediatw-gs-api-credentials.json` MD5 可能一致 |
| `C:\Users\admin\.credentials\avalonpediatw-gs-api-credentials.json` | **DEDUP 候選** | 與上同 size 2380 bytes |
| `C:\Users\admin\AppData\Local\claude-cli-nodejs\Cache\C--Users-admin-GoogleDrive----avalonpediatw` | **IGNORE** | CLI cache, 排除中但 listing 撈到 |
| `C:\Users\admin\AppData\Local\Temp\avalon_*.txt`、`pediatw.txt` | **IGNORE / 清掃** | 本次掃描暫存 |
| `E:\阿瓦隆百科\avalonpediatw\` | **IGNORE / REVIEW** | 只有空 `node_modules/`，無實質內容，建議刪除空目錄 |

---

### F. 誤殺（無關）

| 路徑 | 原因 |
|------|------|
| `C:\Program Files\Git\mingw64\...\Avalonia.*.dll`（30 個） | Avalonia UI framework（與阿瓦隆無關） |
| `C:\Program Files\Git\mingw64\libexec\git-core\Avalonia.*.dll`（15 個） | 同上 |

---

## 3. 建議整合目錄結構（套進既有 repo）

```
workspace/avalonpediatw/
├── packages/              # [KEEP] 現行 app (server/shared/web)
├── docs/                  # [KEEP + 擴充] 技術文件
│   ├── requirements/      # ← MOVE: avalonpediatw_ui_requirements.md
│   └── history/           # ← MOVE: dna_patches, 9bugs, session_full
├── wiki/                  # [KEEP] 策略/角色/理論百科
├── content/               # [NEW]
│   ├── rules/             # ← MOVE: documents/*, ResistanceAvalon_OriginRule.pdf, html
│   └── hackmd_backup/     # ← MOVE: HackMD_Team_備份_extracted/, _已整併_原檔/
├── assets/                # [NEW]
│   ├── images/            # ← MOVE: lobby.jpg, merlin/timer/vote.png
│   ├── videos/            # ← LINK (Git LFS 或 external): videos/*.mp4
│   └── EXTERNAL_REFS.md   # ← 記錄 downloads/阿瓦隆百科_同步閒聊/ 路徑
├── data/                  # [NEW]
│   ├── master/            # ← MOVE / LINK: 阿瓦隆百科.xlsx, 阿瓦隆百科機器人.xlsx
│   ├── sheets_export/     # ← MOVE: Google_Sheets_Export/*.csv
│   ├── chat/              # ← MOVE: discord_archive_avalon_*.jsonl, line/*.txt
│   └── analysis/          # ← MOVE: avalon_analysis_*.md, avalon_stats_raw.txt
├── scripts/               # [KEEP + 擴充]
│   ├── analysis/          # ← MOVE: avalon_analysis.py (81 KB)
│   └── archive/           # ← MOVE: discord_archive_avalon.py
├── archive/               # [NEW]
│   └── prototypes/
│       ├── game-server-v0/       # ← MOVE: _github_repos/avalonpediatw-game-server/
│       ├── line-discord-sync/    # ← MOVE: _github_repos/avalonpediatw-line-discord-sync/ (dedup E: 版)
│       ├── avalon_game_py/       # ← MOVE: _github_repos/avalon_game/
│       ├── avalon_online_py/     # ← MOVE: _github_repos/avalon_online/
│       └── line_bot/             # ← MOVE: E:\投資交易\...\avalon line_bot.py
└── AVALON_INVENTORY.md    # ← 本檔
```

---

## 4. 總計預估搬移量

| 分類 | 檔數 | 體積 | 搬 vs Link |
|------|------|------|------------|
| A. 內容素材（不含大圖庫） | ~30 | ~1 MB | MOVE |
| A. 影片 | 6 | 52 MB | LINK（LFS 或 external） |
| A. Discord 同步閒聊 | 3382 | 1145 MB | **LINK（不搬）** |
| B. 程式碼 prototypes | ~60 | ~9 MB | MOVE |
| C. 設計文件 | ~10 | ~20 KB | MOVE |
| D. 資料（CSV + chat + json） | ~40 | ~20 MB | MOVE |
| D. Excel master | 2 | 12 MB | MOVE（考慮 LFS） |
| E. Credentials | 6 | — | KEEP 原地 |
| F. 誤殺（Avalonia） | 45 | — | 忽略 |

**實際搬入 repo 約 42 MB（不含 LFS/LINK 項），可接受**。

---

## 5. 建議 Stage 2 執行順序（Edward 拍板後）

1. **先做 DEDUP 掃描**（MD5 全比對 wiki/GD 的 csv vs `data/` 的 csv），減少無謂搬移
2. **建立新目錄架構**（空殼）
3. **小檔優先搬**（docs/content/scripts/archive）— 單次 commit，好 review
4. **資料檔搬**（sheets_export/chat）— 獨立 commit
5. **Excel 與影片評估 Git LFS**（若用 LFS 先設定 `.gitattributes`）
6. **大圖庫**（downloads/阿瓦隆百科_同步閒聊）只做 reference，絕不入 repo
7. **最後清理**：刪 GD 內已 dedup 項、清 AppData Temp、刪 E: 空 avalonpediatw 殼

---

## 6. 分支建議

目前 branch: `claude/avalon-game-platform-0hDJ1`

**建議**: 整併工作在**新分支** `chore/inventory-consolidation` 做，完工後 PR 併回 `main`。現行 feature branch 的 app 開發可繼續，兩條線不互擾。

本次 inventory 提交建議直接 commit 在**當前 branch**（低侵入，只新增一份 md）並 push。
