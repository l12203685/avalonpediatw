# 觀念卡 ↔ 百科文章

> 2026-11-18 站長：「全部的觀念卡應該要放主控台啊 並且跟百科網站的文章完全連動 這樣才是真的整套系統完整整合」

觀念卡庫只有一份：`packages/server/src/bots/threads/concepts.json`。Threads 知識卡、網站（百科文章的「本篇觀念卡」、公開觀念卡頁 `#concepts=<id>`）、主控台的觀念卡分頁都讀這一份；文章的正本是 `packages/server/wiki_data.json`（網站打包的 `@wiki-bundle` 和伺服器 `/api/wiki` 都讀它）。

## 階段與角色（tags.phase／tags.role）

> 2026-11-18 站長：「觀念卡 派票總共80張 好像有點太多了 看是不是有些應該精簡一點 或是直接區分成 [第一局派隊] [第二局派隊] [第三~五局派隊] 這樣呢? 然後能力者的文章跟觀念好像完全沒看到?」

- `tags.phase`（必填，一張卡一個）：`第一局派隊`／`第二局派隊`／`第三～五局派隊`／`刺殺`／`投票・湖中・出任務`／`角色玩法`／`通用`。由 decision 與 round 推（`concepts.ts` 的 `conceptPhaseOf`）：有刺殺 → 刺殺；沒有派隊 → 投票・湖中・出任務；派隊而 round 有 `any` → 通用；都在第 3～5 局 → 第三～五局派隊；跨了三局以上 → 通用；其他歸最早的那一局；會是「通用」但有 `tags.role` 的卡歸「角色玩法」（站長：「通用卡張數怎麼這麼多」），通用只留不針對角色的通則（`角色玩法` 一定要有 role）。可以手動改（例：`w147-plan-before` 跨第 2～4 局，歸第二局派隊）。`concepts:apply` 的 tags 沒給 phase 時照這個規則補上。
- `tags.role`（選填）：這張卡在講哪個角色或哪一方怎麼玩：`梅林`／`派西維爾`／`忠臣`／`藍方`／`刺客`／`莫甘娜`／`莫德雷德`／`奧伯倫`／`紅方`，可以多個。跟 `tags.roles`（配對用：出題的那一家的角色）不同；沒有就是通則。
- 兩個都只給網站分組與篩選，不影響 Threads／每日小觀念的配對。公開觀念卡頁沒選階段時照階段分組（站長的三個派隊分組在最前面），「角色玩法」裡再照角色分小標（梅林／派西維爾／忠臣／藍方／刺客／莫甘娜／莫德雷德／奧伯倫／紅方，多個角色的卡列在 role 寫的第一個）；另有「角色」篩選。

## 卡片怎麼指到文章

每張卡的 `article`：

| 欄位 | 說明 |
| --- | --- |
| `slug` | wiki_data.json 的文章 id |
| `title` | 文章標題（跟 wiki_data.json 一樣） |
| `section` | 章節錨點＝標題的 slug（`web/src/utils/wikiSections.ts`）；沒有就是整篇 |
| `url` | 網站深連結 `<site>/#wiki=<id>&sec=<章節>` |
| `shareUrl` | 分享頁 `<site>/w/<id>/`（有 Open Graph 預覽） |
| `sectionHash` | 來源那一節的雜湊（下面） |
| `sourceQuote` | 那一節裡卡片依據的一句（去掉 Markdown 的純文字，最多 60 字） |

**文章 → 卡片**：打開百科文章時，文末有「本篇觀念卡」，依章節在文章裡的順序分組列出這篇的卡（情境／觀念／應用、證據類型）；有卡的章節標題旁有一個小數字，點了捲到那幾張卡。每張卡可以「回到原文這一節」（`#wiki=<id>&sec=<章節>`），或打開公開觀念卡頁的那一張（`#concepts=<卡片 id>`，#86 的 `components/ConceptCards.tsx` 捲到錨點 `concept-<id>` 並標出來；文末「全部觀念卡」是 `#concepts`）。

- 網址與頁面錨點用 #86 的 `web/src/utils/concepts.ts`（`conceptsHash`、`parseConceptsHash`、`conceptAnchorId`）。
- 文章裡「本篇觀念卡」的元素 id 是 `wiki-concept-<id>`（`utils/conceptLinks.ts` 的 `articleConceptAnchorId`）：從觀念卡檢視打開文章時那一頁還在 modal 底下，用同一個 id 會捲錯地方。
- 卡庫的載入同觀念卡頁：vite alias `@concepts-bundle`（型別 `src/conceptsBundle.d.ts`）的獨立 chunk，第一次打開文章時才下載。
- 程式：`web/src/components/WikiConceptCards.tsx`、`web/src/utils/conceptLinks.ts`。

## 待複查（staleness）

`sectionHash` = 那一節 Markdown 的 sha256 前 12 碼：

1. 範圍：`wikiSectionMarkdown`（標題那一行到下一個**同級或更高級**標題之前，含子章節；程式碼區塊裡的 `#` 不算標題；沒有 `section` 就是整篇，去掉 front matter）。
2. 正規化：換行統一成 `\n`、每行去掉行尾空白、拿掉空行、頭尾空白去掉。只改空白或空行不會變。
3. `sha256(utf8).hex[0:12]`。

`concepts:check` 對每張卡給一個狀態（由重到輕取第一個成立的）：

| status | 意思 | 怎麼處理 |
| --- | --- | --- |
| `article-missing` | 文章不在 wiki_data.json（併入別篇時附 `suggested`） | 改指新文章，或退役 |
| `section-missing` | 章節錨點不在了（標題改名有對照時附 `suggested`） | 改 `section` |
| `quote-missing` | 這一節改過，依據的那句也不見了 | 卡片要重看、改寫 |
| `changed` | 這一節改過，依據的那句還在 | 確認仍成立就 `reviewed: true` |
| `unstamped` | 還沒蓋章 | `concepts:stamp <id>` |
| `title-changed` | 文章標題改了 | 任何一次 apply 都會更新標題 |
| `ok` | 沒事 | |

除了 `ok` 都算待複查（`stale: true`）。目前 109 張（退役 29 個 id）、待複查 0 張。

- **CI**：`ConceptsSource.test.ts` 跑一次檢查，有待複查的卡只印警告（GitHub Actions 上是 `::warning::`），不讓測試失敗；`test.yml` 另有一步 `concepts:check --github`（`continue-on-error`），把清單寫進 job summary。文章或章節不見這種結構性的錯仍由 `ThreadsConcepts.test.ts` 擋下。
- **每日例行**：`pnpm --filter @avalon/server concepts:check --out <檔>` 寫 JSON（`--json` 印到 stdout；用 `--filter` 時 pnpm 會先印一行標頭，機器讀請用 `--out`）。`--strict` 時有待複查就 exit 1。

```jsonc
// ConceptCheckReport
{
  "checkedAt": "2026-11-18T03:00:00.000Z",
  "total": 109,
  "stale": 0,
  "byStatus": { "ok": 109 },
  "needsReview": [],            // 下面 cards 裡 stale 的那些
  "cards": [
    { "id": "w205-who-can-plan", "slug": "wiki-205", "section": "一、1-1-誰能有計畫",
      "status": "ok", "stale": false, "reasons": [],
      "recordedHash": "…", "currentHash": "…", "quoteFound": true,
      "suggested": { "slug": "…", "section": "…" } }   // 只有 article-missing／section-missing 才可能有
  ]
}
```

## 主控台的編輯流程

1. 主控台讀 `concepts:export` 的 JSON（`pnpm --filter @avalon/server concepts:export --out <檔>`）。
2. 站長在觀念卡分頁改卡、確認、退役、新增，主控台存成 `edits.json`。
3. `pnpm --filter @avalon/server concepts:apply <edits.json>`（先 `--dry-run` 看結果；`--json` 印機器讀的結果）。全部驗證通過才寫回 concepts.json，有一筆不對就整批不寫、列出每個問題。動到的卡依目前的文章重新蓋章，標題與網址照 wiki_data.json 重算。
4. 照平常的流程 commit／PR。

### export 的格式

```jsonc
{
  "format": "avalon-concepts-export",
  "version": 1,
  "exportedAt": "…",
  "site": "https://avalon-game-platform.web.app",
  "summary": { "total": 109, "stale": 0, "byStatus": { "ok": 109 } },
  "limits": {                       // 表單的檢查規則，跟 apply 一樣
    "sentenceMax": 40, "quoteMax": 60, "idPattern": "^[a-z0-9][a-z0-9-]{1,63}$",
    "parts": ["情境", "觀念", "應用"],
    "decisions": ["派隊", "投票", "湖中", "刺殺", "出任務"],
    "evidence": ["邏輯", "經驗", "判斷／待驗證"],
    "roles": ["merlin", "percival", "loyal", "assassin", "morgana", "mordred", "oberon"],
    "phases": ["第一局派隊", "第二局派隊", "第三～五局派隊", "刺殺", "投票・湖中・出任務", "角色玩法", "通用"],
    "roleTags": ["梅林", "派西維爾", "忠臣", "藍方", "刺客", "莫甘娜", "莫德雷德", "奧伯倫", "紅方"]
  },
  "cards": [ { /* concepts.json 的卡 */ "stale": false, "status": "ok", "reasons": [], "currentHash": "…", "quoteFound": true } ],
  "retired": ["w205-1-2", …],       // 退役的 id（不能再用）
  "articles": [ { "slug": "wiki-205", "title": "…", "sections": [ { "slug": "一、1-1-誰能有計畫", "title": "一、1-1 誰能有計畫", "level": 2 } ] } ]
}
```

### edits.json 的格式

`{ "edits": [ … ] }` 或直接一個陣列。每一筆都要有 `cardId`，其他欄位有給的才改：

```jsonc
{ "edits": [
  // 改句子（整句換掉；每句一句、含句號不超過 40 字、座位寫 N家／0家）
  { "cardId": "w205-who-can-plan", "觀念": "1-1只有梅林和相認紅方有計畫可言。" },
  // tags 整個換掉（不是合併；沒給 phase 就照 decision／round 補）；evidence 可以是 null；section 改指同一篇的另一節（null＝整篇）
  { "cardId": "w205-1-3", "tags": { "decision": ["派隊"], "round": ["1-3", "2-3"], "phase": "第一局派隊" }, "evidence": "經驗", "section": "1-3" },
  // 指定依據的那一句（必須在那一節裡，最多 60 字）
  { "cardId": "w205-loyal-seat1", "sourceQuote": "你唯一確定的好人是自己。" },
  // 文章改過、卡片仍成立：只重新蓋章
  { "cardId": "w206-consensus", "reviewed": true },
  // 退役：從卡庫拿掉，id 記進 retired，之後不能再用（不能跟其他欄位一起給）
  { "cardId": "w26-one-line", "retire": true },
  // 新增：cardId 是新卡的 id；article 只給 slug（和 section），標題與網址自動算
  { "cardId": "w205-new-idea", "new": {
      "article": { "slug": "wiki-205", "section": "忠臣坐-1-家" },
      "情境": "…。", "觀念": "…。", "應用": "…。",
      "tags": { "decision": ["派隊"], "round": ["1-1"], "role": ["忠臣"], "roles": ["loyal"] },
      "evidence": "邏輯" } }
] }
```

驗證：不認得的欄位、同一批改同一張卡兩次、id 格式、句子（`sentenceProblem`）、tags／evidence（`conceptProblems`）、文章與章節存在、sourceQuote 長度且在那一節裡、新卡 id 不重複也不是退役過的、網址等於網站深連結。

apply 的結果（`--json`）：

```jsonc
{ "ok": true, "dryRun": false,
  "results": [ { "cardId": "w205-who-can-plan", "action": "updated", "changed": ["觀念"] } ],
  // action：updated／reviewed／retired／created／unchanged（給的值都跟現在一樣，不重新蓋章）
  "errors": [],
  "stale": 0 }                      // 套用後還有幾張待複查
```

## 指令

| 指令 | 做什麼 |
| --- | --- |
| `pnpm --filter @avalon/server concepts:check [--json] [--out <檔>] [--github] [--strict]` | 待複查清單 |
| `pnpm --filter @avalon/server concepts:export [--out <檔>]` | 主控台讀的 JSON |
| `pnpm --filter @avalon/server concepts:apply <edits.json> [--dry-run] [--json]` | 套用主控台的修改 |
| `pnpm --filter @avalon/server concepts:stamp --missing \| <id>...` | 蓋章（新卡補章、確認過的卡） |

相對路徑以下指令的資料夾為準。程式：`web/src/utils/conceptSource.ts`（雜湊範圍、sourceQuote、檢查；純函式，雜湊函式由呼叫的一方給）、`server/src/bots/threads/conceptEdits.ts`（apply／export）、`server/scripts/conceptsWiki.ts`（讀檔、sha256、接起來）、`server/scripts/concepts.ts`（指令）。測試：`ConceptsSource.test.ts`、`ConceptsEdits.test.ts`、`WebConceptLinks.test.ts`。
