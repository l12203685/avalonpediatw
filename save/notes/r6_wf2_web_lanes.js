export const meta = {
  name: 'r6-web-lanes',
  description: 'Round 6 website: split analytics tabs into files + preview harness, six parallel UI lanes on r6/base, integrate into r6/int',
  phases: [
    { title: 'Prep', detail: 'tab files + local preview/screenshot harness on r6/base' },
    { title: 'Lanes', detail: 'radar, overview, boards, teams, tabs-a (+full studies), tabs-b' },
    { title: 'Integrate', detail: 'merge lanes into r6/int, all checks' },
  ],
}

const SCRATCH = '/tmp/claude-0/-home-user-avalonpediatw/27d70abf-1650-5655-845c-cd1a670104bf/scratchpad'
const REPO = '/home/user/avalonpediatw'
const BASE_INFO = args && args.baseInfo ? args.baseInfo : ''

const RULES = `
HARD RULES (all agents):
- Repo: ${REPO} (pnpm monorepo: packages/server, packages/web = React/Vite/Tailwind/recharts/i18next, packages/shared). Public repo.
- NEVER push, never touch any remote, never open PRs. Work only on the local branch named in your task.
- Commit messages end with exactly these two trailer lines (nothing else; no model names anywhere):
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Lm2LzAfxNJrhD6ad5FMUYc
- Never put real player names in code, tests, docs or commit messages. The caches contain real names: screenshots you take stay in ${SCRATCH}/r6/shots/ only and are never committed; refer to players by rank/index in your reports.
- Match the surrounding code style and comment density (Traditional Chinese doc comments are common; keep the dated owner-decision comment convention at the top of components you change, e.g. "(2026-10-14 Edward：...)").
- i18n: every new string goes in BOTH packages/web/src/i18n/locales/zh-TW/common.json and en/common.json. Put your new keys in ONE contiguous block under a namespace unique to your lane (given below) to keep merges clean; you may edit existing keys you own.
- If node_modules is missing in a worktree: pnpm install --frozen-lockfile --offline (fall back to pnpm install --frozen-lockfile).
- Scratch files only under ${SCRATCH}/r6/.
`

const SPEC = `
OWNER FEEDBACK (Edward, 2026-10-14, paraphrased) for the website:
1. 玩家雷達: role win rates must be split into three blocks — 任務結果 (三藍 = blue wins, 三紅 = red wins), 刺殺結果 (only games that reached 三藍: 三藍活 = blue wins, 三藍死 = red wins), 遊戲結果 (三藍活 = blue wins, anything else = red wins). Outcome rates must be CONDITIONAL probabilities: e.g. "三藍死(紅方)" must be count(三藍死 & I was red) / count(三藍 reached & I was red), not / all red games. "Other numbers likewise": every outcome rate shows the right denominator and its n.
2. 排行: role theory over the last 50 games is too few — now 角色理論 = Σ p_r × final win rate over the player's last 10 games in each role (忠臣 last 40). 位置理論 over the last 100 games. 整體理論 = role theory over the whole career, only for players with >= 250 career games.
3. 分析 > 總覽: combine 三種結果 (three-outcome distribution) with 場次排行 (most-played players) — e.g. a big donut with small donuts. Next to the 角色理論 ranking also show the 位置理論 ranking (100 games) and the 整體理論 ranking (career, >= 250 games).
4. 分析 > 派隊: the analysis is good but too scattered — consolidate, present same-type topics together.
5. Global: use number tables instead of charts where that is clearer; pages must not be long — ideally each tab shows ALL of its content on one screen, splitting into sub-pages (sub-tabs) instead of scrolling; most 「查看完整研究」 links do not open.

Owner decisions applied in parallel by the 'decisions' lane (2026-10-14): sparse theory cells are topped up to 5 games (was 3; read theoryMinCellGames from the cache, never hard-code), and 角色王 ties each get the title (a role can have several rows). Low-sample dimming in tables should use the same theoryMinCellGames threshold from the cache config.

ACCEPTANCE for every tab you touch:
- Desktop 1280x800: the tab's content (below the page header + tab bar) fits without vertical page scrolling; if it cannot, split it into SectionTabs sub-pages so each sub-page fits.
- Phone 390x844: no horizontal page scroll; each sub-page at most ~1.5 screens tall; tables scroll inside their own container.
- Rates are shown as numbers with n (StatTable / MetricBlocks); keep a chart only when its shape tells something a table cannot (state why in a code comment).
- Works on BOTH caches: the schema-4 preview cache (${SCRATCH}/r6/analysis_cache_schema4.json) and the committed schema-3 packages/server/analysis_cache.json (new fields missing → graceful fallback text such as 「下次每日更新後提供」, never a crash or a 0%).
- Uses the shared primitives in packages/web/src/components/analysis/ui/ (SectionTabs, StatTable, Donut, MetricBlocks) and the shared outcome-blocks helper from @avalon/shared and the theory helpers in packages/web/src/services/api.ts built on r6/base — read them first; do not re-implement the math.
`

const LANE_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commit: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    fitCheck: { type: 'array', items: { type: 'object', properties: { view: { type: 'string' }, viewport: { type: 'string' }, cache: { type: 'string' }, contentHeight: { type: 'number' }, fits: { type: 'boolean' } }, required: ['view', 'viewport', 'fits'] } },
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ok: { type: 'boolean' }, detail: { type: 'string' } }, required: ['name', 'ok'] } },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'commit', 'summary', 'checks', 'openIssues'],
}

phase('Prep')
const prep = await agent(`${RULES}\n${SPEC}\n
Base branch info from the previous step: ${BASE_INFO}
YOUR TASK (main checkout ${REPO}, branch r6/base — check it out if needed; no worktree):
1. Refactor only (no behavior change): move each analysis tab body out of packages/web/src/pages/AnalyticsPage.tsx into its own file under packages/web/src/components/analysis/tabs/: BoardsTab.tsx (the BoardsSection), TeamsTab.tsx, VotesTab.tsx, LakeTab.tsx, AssassinationTab.tsx, PositionTab.tsx, RolesTab.tsx, plus OverviewTab.tsx / MissionsTab.tsx / PlayersTab.tsx thin wrappers around OverviewPanel / MissionAnalysis / PlayerRadarChart so every tab has exactly one owning file. Move the shared SectionTitle helper into tabs/SectionTitle.tsx. AnalyticsPage keeps the page shell and the tab switch only. Type-check/lint/build must pass. Commit on r6/base: "refactor(web): 分析各分頁拆成獨立檔案（第六輪分工前置）".
2. Build a local preview + screenshot harness in ${SCRATCH}/r6/preview/ (NOT in the repo):
   - The server already honours AVALON_ANALYSIS_CACHE=<path> (added on r6/base by the data lane) to read a different cache file — use it; do not add another variable. If the full server cannot start locally without secrets, instead write a minimal Node/tsx script in the harness that mounts only the analysis routes (and whatever else the stats pages call: check services/api.ts for the endpoints the 排行/分析 pages fetch, e.g. /api/analysis/*, leaderboard, auth providers) on the chosen port.
   - preview.sh <worktree-path> <cache-json> [port-offset]: starts that API and the vite dev server of THAT worktree (VITE_SERVER_URL pointing at the API) on free ports, waits until ready, prints the URLs, and can be stopped with preview.sh stop <port-offset>. Lanes run in parallel worktrees, so ports must be configurable (offset) to avoid collisions.
   - shoot.mjs (Playwright; Chromium is preinstalled — PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, executablePath /opt/pw-browsers/chromium if the pinned version differs; never run playwright install): args --url --viewport WxH --click "text" (repeatable, clicks buttons in order, e.g. "數據" route then "分析" then "總覽"; find how the stats page is opened — the #stats hash) --out file.png; prints JSON {contentHeight, viewportHeight, horizontalOverflow, consoleErrors}. contentHeight = document.scrollingElement.scrollHeight.
   - Verify the harness end-to-end on r6/base with BOTH caches (${SCRATCH}/r6/analysis_cache_schema4.json and ${REPO}/packages/server/analysis_cache.json) for the 總覽 tab at 1280x800 and 390x844. Write ${SCRATCH}/r6/preview/README.md with exact commands.
Return branch r6/base, final commit, summary with the exact harness commands, checks, open issues.`, { label: 'prep', phase: 'Prep', schema: LANE_SCHEMA })
if (!prep) return { error: 'prep failed' }

const LANE_COMMON = `
Start: git checkout -B lane/r6-LANE r6/base  (replace LANE as given; r6/base is at ${prep.commit}).
Preview harness (read ${SCRATCH}/r6/preview/README.md): ${prep.summary}
Use a unique port offset (given below) so parallel lanes do not collide; stop your servers when done.
Known setup notes from the previous step: (a) worktrees under ${REPO}/.claude/worktrees are nested in the main checkout, so plain "pnpm lint" picks up the parent's ESLint config and fails with "couldn't determine the plugin @typescript-eslint uniquely" — lint with: cd packages/web && npx eslint src --ext .ts,.tsx --no-eslintrc -c <the web package's own eslint config file> (find it), or the root config for server code, and report the exact command; (b) OutcomeCounts exists in @avalon/shared (re-exported by services/api.ts) and in components/analysis/ui/tokens.ts — import it from services/api.ts only; (c) MetricBlocks/StatTable take 0–100 rates by default — check the shared helper's scale and pass scale='fraction' only if it returns 0–1; (d) Chromium IS installed at /opt/pw-browsers (chromium-1194); PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers.
Before committing: pnpm --filter @avalon/web type-check, lint, build must pass (and server tests if you touched server code). Take screenshots of every view you changed at 1280x800 and 390x844 with both caches into ${SCRATCH}/r6/shots/LANE/ and report the fitCheck numbers honestly. Commit on your lane branch.`

const LANES = [
  { id: 'radar', port: 10, ns: 'analytics.r6.radar', task: `Lane radar — owns components/analysis/PlayerRadarChart.tsx, tabs/PlayersTab.tsx and any new components/analysis/radar/* files.
- Replace the stats sidebar and the legacy 角色勝率 bars with MetricBlocks: rows 紅方, 藍方, then each role (red roles red tone, blue roles blue tone) with the three conditional blocks and n, from players[].roleOutcomes (schema 4) and the raw faction counts (rawRed*/rawBlue* — available on schema 3 too, so the faction rows always work; role rows show the pending note on schema 3).
- The radar API changed on r6/base: radar.redMerlinKillRate and radar.blueMerlinProtect are now the conditional 刺殺結果 rates (number | null), and radar.outcomeBlocks exists. PlayerRadarChart.tsx ~line 71 still plots ff.finalBlueWinRate on the blueMerlinProtect axis and ~line 75 falls back to player.redMerlinDead — fix both (null → axis not drawn, never an unconditional fallback) and fix the axis labels/legends to say what they are.
- Any remaining single outcome numbers (e.g. 三藍死(紅方), 三藍活(藍方), 三紅) must be the conditional ones with n; radar axes that are outcome rates use the conditional definitions (e.g. 紅方刺中率 = 三藍死 / 三藍 reached as red).
- Theory section as a StatTable: 角色理論 (各角色近 10 場、忠臣近 40 場; show per-role games used / window and whether full; flag topped-up roles), 位置理論 (近 100 場), 整體理論 (生涯; show only when career >= overallMinGames, else 「生涯滿 250 場後顯示」). Read windows/thresholds from theorySettings, never hard-code.
- Fit one screen: split into SectionTabs sub-pages, e.g. 雷達圖 / 三塊勝率 / 理論勝率 (choose what fits), keep the player picker compact (e.g. search + a short list; the long button cloud must not push content down).` },
  { id: 'overview', port: 20, ns: 'analytics.r6.overview', task: `Lane overview — owns components/analysis/OverviewPanel.tsx, tabs/OverviewTab.tsx, OutcomeBar.tsx (only if needed) and new components/analysis/overview/* files.
- Combine 三種結果 and 場次排行: one block with a large Donut of the overall three-outcome split (with counts) and, around/next to it, small Donuts for the top 10 most-played players (overview.topPlayersByGames[].outcomes on schema 4; on schema 3 fall back to a compact games-only list) labelled with name + games. Provide a 表格 toggle showing the same numbers as a StatTable (name, games, 三紅, 三藍死, 三藍活 with %).
- Three theory rankings side by side as compact StatTables: 角色理論 (overview.topPlayersByRoleTheory, per-role windows), 位置理論 (topPlayersByPositionTheory, 近 100 場), 整體理論 (topPlayersByOverallTheory, 生涯 >= 250 場). On phones a SectionTabs switch between the three. Short legend lines with the definitions; read windows/thresholds from theorySettings. Schema 3: show today's role-theory list with a note that the new rankings come with the next daily refresh.
- Keep the total games / players / 三段結算 summary but make it compact (it is one row).
- Whole 總覽 fits 1280x800.` },
  { id: 'boards', port: 30, ns: 'analytics.r6.boards', task: `Lane boards — owns components/analysis/LeaderboardBoards.tsx, tabs/BoardsTab.tsx, components/LeaderboardV3Table.tsx (layout only).
- The 排行 top tab: new boards from the cache (main 角色理論 per-role windows, position 位置理論 近 100 場, overall 整體理論 生涯 >= 250 場, improved, assassin, newcomers, roleTitles); the old last50 board is gone on schema 4 but present on schema 3 — render whatever boards the cache has, by id/metric, with each board's title/period/note from the cache.
- Fit one screen: SectionTabs for the boards (e.g. 角色理論 / 位置理論 / 整體理論 / 進步 / 刺客 / 新人 / 角色王 / 精算榜) so only one board (or a tight grid) shows at a time; 精算榜 (LeaderboardV3Table) becomes one of these sub-pages instead of sitting below.
- Board tables: rank, name (clickable to the player's radar as today), the board's value, the secondary columns that board carries (e.g. 位置理論 and 最終勝率 for main, games/window) — numbers with one decimal.` },
  { id: 'teams', port: 40, ns: 'analytics.r6.teams', task: `Lane teams — owns tabs/TeamsTab.tsx, components/analysis/CaptainAnalysis.tsx, components/analysis/RoundsAnalysis.tsx and new components/analysis/teams/* files.
- The 派隊 tab today stacks CaptainAnalysis (per-mission captain chart + table, captain faction vs result, captain win rate), RoundsAnalysis (first vote, progression chart, red count on teams, mission-1 branch, game state) and the L139 feature card. Re-organise by topic into a few SectionTabs sub-pages, merging same-type content (e.g. 隊長陣營與結果 / 第一局與派票 / 任務進程 / 研究 L139 — decide from the actual content), each sub-page one screen, numbers in tables where clearer.
- Any outcome rate of a subgroup must use the conditional blocks (mission / assassination given 三藍 / final) with n.
- Do not change the L139 FeatureStudyCard component itself (another lane owns FeatureStudiesPanel.tsx); just place it.` },
  { id: 'tabsa', port: 50, ns: 'analytics.r6.tabsa', task: `Lane tabs-a — owns tabs/VotesTab.tsx, tabs/MissionsTab.tsx, tabs/LakeTab.tsx, tabs/AssassinationTab.tsx, components/analysis/MissionAnalysis.tsx, LakeAnalysis.tsx, AssassinationCard.tsx, and components/analytics/FeatureStudiesPanel.tsx.
- Make each of 投票 / 任務 / 湖中女神 / 刺殺 fit one screen (SectionTabs where needed), tables over charts where clearer, conditional outcome rates with n where subgroup outcome rates appear.
- Fix 「查看完整研究」 (FeatureStudiesPanel.tsx ~line 317: the link points to /docs/feature-study-<id> and preventDefault()s — it never opens). Build an in-site full study view (a modal or full-panel view, deep-linkable via the hash, e.g. #study=l141, with a back/close) for every featureStudies entry (L136, L139, L141, L142, L143): the question, the exact method/definitions (read how generate_cache.py computes each study and describe it accurately in plain Traditional Chinese + English), sample size and date, the FULL data table with n and confidence intervals where the data has them, low-sample flags, caveats (selection bias etc.) and how to read it. The link must work from every tab that shows a study card (派隊 L139, 投票 L136, 湖中 L141/L142, 刺殺 L143). Hash handling: check how the app already parses #stats / #player= (store/gameStore, App.tsx) and follow that pattern.` },
  { id: 'tabsb', port: 60, ns: 'analytics.r6.tabsb', task: `Lane tabs-b — owns tabs/PositionTab.tsx, tabs/RolesTab.tsx, components/analysis/SeatHeatmap.tsx, SeatPositionChart.tsx, SeatOrderAnalysis.tsx, RoleFinalWinRates.tsx, ChemistryMatrix.tsx.
- Make 位置 and 角色與默契 each fit one screen (SectionTabs sub-pages where needed), tables over charts where clearer.
- Per-seat and per-pair outcome numbers (players[].seatOutcomes, chemistry outcomePair, role final rates) must be presented with the conditional blocks (任務 / 刺殺 given 三藍 / 遊戲) and n instead of raw shares of all games, where they are outcome rates of a subgroup.
- RoleFinalWinRates: show per role the three blocks for the whole population (compute from data the cache already has; if a needed count is missing, say which field would be needed in openIssues rather than inventing numbers).` },
  { id: 'decisions', port: 70, ns: 'analytics.r6.decisions', task: `Lane decisions — NOT a web-layout lane. Owns packages/server/generate_cache.py (+ test_generate_cache.py) for the two settings below, packages/server/src/practice/* and packages/server/src/bots/feedback/* for the third, plus the docs they touch. Do not edit web components (other lanes own them); web text that states thresholds must already read them from the cache config (check; if some web/bot text hard-codes 3, fix only that string source, e.g. a constant in services/api.ts or statsReplies.ts).
Owner decisions (Edward, 2026-10-14):
 (5) "Fewer than 3 games usually means no statistical meaning; top up with the population average, but I suggest topping up to 5 games." → LEADERBOARD_CONFIG theoryMinCellGames 3 → 5 (affects role/position/overall theory cells, roleWindows), defaults in the TS readers (theorySettings / THEORY_MIN_CELL_GAMES) to 5 for caches that do not carry the setting? NO — older caches were computed with 3, so the readers' fallback for a cache WITHOUT the setting stays 3; only the generator changes. Update tests and docs/stats/two_stage_outcome.md.
 (6) 角色王 (roleTitles board) ties: "各給" — every player tied at the top of a role gets that role's title (today one winner per role; find the tie-break in compute_leaderboard and replace it: all players with the top value — same rounded final win rate over their last roleTitleGames games — are listed, each with the title; keep a stable order). Check the web LeaderboardBoards and bot /排行 readers handle several rows per role (bots: statsReplies; fix the bot side if needed; the web side is owned by the boards lane — only report in openIssues what it must handle).
 (7) Practice mode 「這步怪怪的」 reports: "要" also post to the admin channel 大劍管理員. Today they are written to the private sheet tab 練習回報 (packages/server/src/practice/PracticeReportWriter.ts; GameServer.ts wiring). Also forward each report to the Discord admin channel using the same sender the /意見 feedback uses (bots/feedback discordForwarder, DEFAULT_FEEDBACK_DISCORD_CHANNEL_ID / FEEDBACK_DISCORD_CHANNEL_ID): a short message with what the bot did, the reporter's note (sanitised: no @everyone/@here/role/user mentions — allowedMentions none; clipped length), seat/role/round context and the practice game id if any; rate-limited like feedback; failures counted, never thrown; content never logged (counts only). Env switch to turn it off (e.g. PRACTICE_REPORT_DISCORD=false), documented in .env.example / render.yaml comments / docs/PRACTICE_MODE.md, and a status counter in /api/bots/status if the practice/feedback status block exists.
Run python3.11 tests, server vitest/type-check/lint. Commit on lane/r6-decisions.` },
]

phase('Lanes')
const laneResults = await parallel(LANES.map(l => () => agent(`${RULES}\n${SPEC}\n${LANE_COMMON.replaceAll('LANE', l.id)}
Your port offset: ${l.port}. Your i18n namespace: ${l.ns}.
${l.task}
Return branch lane/r6-${l.id}, final commit, summary, files changed, fitCheck rows, checks, open issues.`, { label: `lane-${l.id}`, phase: 'Lanes', schema: LANE_SCHEMA, isolation: 'worktree' })))

const ok = laneResults.map((r, i) => ({ id: LANES[i].id, r })).filter(x => x.r)
const failed = laneResults.map((r, i) => (r ? null : LANES[i].id)).filter(Boolean)
if (failed.length) log(`lanes without a result: ${failed.join(', ')}`)

phase('Integrate')
const integrated = await agent(`${RULES}\n${SPEC}\n
YOUR TASK: integrate the lanes. Main checkout ${REPO} (no worktree).
1. git checkout -B r6/int r6/base, then merge each lane branch with --no-ff in this order: ${ok.map(x => 'lane/r6-' + x.id).join(', ')}. Merge commit message "merge: lane/r6-<id>（第六輪網站）" with the trailer lines. Resolve conflicts (expect the two i18n common.json files and maybe AnalyticsPage.tsx imports): keep every lane's keys, valid JSON, no duplicated keys with different text (if two lanes changed the same existing key, pick the text matching the final UI and note it).
2. Run all checks: pnpm --filter @avalon/web type-check + lint + build, pnpm --filter @avalon/server test + type-check + lint, root pnpm type-check, python3.11 tests for packages/server/test_generate_cache.py and test_discord_records_import.py as CI runs them.
3. Using the preview harness (${SCRATCH}/r6/preview/README.md), screenshot EVERY 排行 sub-page and EVERY 分析 tab/sub-page at 1280x800 and 390x844 with the schema-4 cache, and the 總覽 / 玩家雷達 / 排行 with the schema-3 cache, into ${SCRATCH}/r6/shots/int/. Record contentHeight, horizontal overflow and console errors for each. Fix integration breakage (not design choices) in follow-up commits on r6/int.
4. Leave the checkout on r6/int, clean. Return branch, commit, checks, a fitCheck row per view, open issues (include every lane's open issues that still apply).
Lane reports: ${JSON.stringify(ok.map(x => ({ id: x.id, summary: x.r.summary, openIssues: x.r.openIssues, fitCheck: x.r.fitCheck })))}`, { label: 'integrate', phase: 'Integrate', schema: LANE_SCHEMA })

return { prep, lanes: ok.map(x => ({ id: x.id, ...x.r })), failed, integrated }
