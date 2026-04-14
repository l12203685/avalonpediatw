# External References — avalonpediatw

> Draft — 2026-04-14 +08. Tracks external resources consumed or linked by the Avalonpedia site.
> Scope = media assets, third-party services, upstream content. Source code deps live in `package.json` / `pyproject.toml`, not here.

## 1. Video assets (M0.5)

All 6 assets produced by Edward in 2023-10. Currently stored in Google Drive at
`C:/Users/admin/GoogleDrive/專案/阿瓦隆百科/assets/videos/`.

Planned destination: Cloudflare R2 bucket `avalonpediatw-media`, prefix `videos/shorts/`.
See `docs/M0.5_r2_spike.md` for cost + rollout plan.

| Slug | Title (zh) | Role | Size | R2 key (planned) | Status |
|---|---|---|---:|---|---|
| assassin-key         | 刺客有多關鍵     | assassin | 8.18 MB | `videos/shorts/assassin-key.mp4`         | Staged, not uploaded |
| percival-hard        | 派西維爾有多難分 | percival | 8.88 MB | `videos/shorts/percival-hard.mp4`        | Staged, not uploaded |
| merlin-importance    | 梅林有多重要     | merlin   | 8.45 MB | `videos/shorts/merlin-importance.mp4`    | Staged, not uploaded |
| morgana-hard-to-play | 莫甘娜有多難玩   | morgana  | 9.33 MB | `videos/shorts/morgana-hard-to-play.mp4` | Staged, not uploaded |
| mordred-strong       | 莫德雷德有多強   | mordred  | 8.16 MB | `videos/shorts/mordred-strong.mp4`       | Staged, not uploaded |
| oberon-weak          | 奧伯倫到底有多爛 | oberon   | 6.55 MB | `videos/shorts/oberon-weak.mp4`          | Staged, not uploaded |

**License:** Original work by Edward. Pending confirmation — default to "All rights reserved,
educational fair-use on site" until Edward specifies CC license.

## 2. Upstream content sources

| Source | Path / URL | Usage | Notes |
|---|---|---|---|
| Master Excel workbook | `E:/阿瓦隆百科/阿瓦隆百科.xlsx` | Parsed by `scripts/parse_master.py` → `content/_data/*.yaml` | Not committed; kept off-repo. See M0.3 spike. |
| Historical game records | `E:/阿瓦隆百科/gameRecordsDataAnon_20220606.json` | Future AI stats pipeline | Anonymized; safe for analytics. |
| Wiki markdown | `C:/Users/admin/GoogleDrive/專案/阿瓦隆百科/wiki/` | 7 categories (入門基礎 / 角色玩法 / 派票策略 / 湖中與投票 / 進階思考 / 覆盤 / QnA) | To be piped into Astro content collections (P1, feature #7). |
| Competition rules HTML | `E:/阿瓦隆百科/🛡️阿瓦隆百科 線上阿瓦隆實戰比賽 規則說明🛡️.html` | Reference for tournament rules page | Source doc only, not served raw. |
| avalon_core Python engine | `C:/Users/admin/GoogleDrive/專案/avalon_core/` | Reference implementation; `analysis/stats.py` to port to TS | See DEVELOPMENT_PLAN §3. |

## 3. Third-party services (runtime)

| Service | Purpose | Free tier sufficient? | Credential location |
|---|---|---|---|
| Firebase Hosting | Frontend static hosting | Yes | `~/.claude/credentials/` (planned) |
| Firebase Realtime DB + Auth | Session state, user auth | Yes (Spark plan) | same |
| Firebase Firestore | Game history, rankings | Yes (Spark plan) | same |
| Render.com (Singapore) | Backend Socket.IO server | Free web service tier | same |
| Cloudflare R2 | Media (videos, images, audio) | Yes — 10 GB storage + free egress | **Not yet created (pending Edward)** |
| Discord API | Bot (slash commands, broadcast) | Yes | `~/.claude/credentials/all_bot_tokens.json` |
| LINE Messaging API | Bot (webhook, flex messages) | Yes | same |

## 4. Related repos / references

| Repo | URL / path | Role |
|---|---|---|
| avalon_core | `GoogleDrive/專案/avalon_core/` (local) | Python reference engine + stats analysis |
| listen-bot | `GoogleDrive/staging/listen-bot/` (local) | Passive Discord message collector |
| avalonpediatw-m03 (this) | `workspace/avalonpediatw-m03/` | Production web + bot + wiki |

## 5. Third-party libraries worth attribution

Only dependencies that need attribution beyond standard `package.json` show here.
None currently — update if we embed GPL / CC-BY-SA content.

---

_Maintainer note_: this file is the index for any external resource the site loads,
embeds, or relies on at runtime. When adding a new asset class, create a new section
rather than cramming into an existing table.
