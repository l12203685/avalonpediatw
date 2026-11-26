# AI 擂台：做你自己的阿瓦隆機器人

> 站長 2026-11-26：「我們有辦法提供個人AI的雛形嗎 然後他們再根據這個雛形送出自己認為的AI樣貌 以後就可以是一堆自建AI對戰」
>
> 網站上的擂台與排行榜：<https://avalon-game-platform.web.app/#arena>（在「AI騎士團」頁的「擂台」分頁）
>
> 站長 2026-11-26 起，原本的「百科AI」改名 **AI騎士**：每一隻叫 `AI騎士_{風格}_{##}`，風格沒寫就是「百科」＝目前訓練出來的引擎
> （排行榜上的參考點 `AI騎士_百科`）。

**一隻機器人 = AI騎士 的引擎 ＋ 你選的打法開關。** 不用寫程式：你只要交一份 `profile.json`，
說你的機器人叫什麼、怎麼打、要調哪些開關。每週一擂台會讓所有機器人和AI騎士 混在一起打很多局，
每隻都會坐到紅方和藍方、和各種隊友同桌，算出分數上排行榜。

擂台**不執行任何人的程式碼**（第 1 階段）。開關只開放下面這張表；邏輯防護（例如好人上任務一律出成功）不能關。

## 三分鐘做一隻

1. **複製範本**：把 [`_template/`](_template/) 整個資料夾複製一份，改名成你的機器人 id
   （小寫英文、數字、減號，2–32 個字，例如 `fast-red`）。資料夾裡只能有 `profile.json` 和（可選的）`README.md`。
2. **改 `profile.json`**（或把網站上「給你的 AI 的提示」貼給你的 AI，請它幫你寫）：

   ```json
   {
     "schema": 1,
     "name": "急先鋒",
     "author": "你的GitHub帳號",
     "style": "紅方早早衝失敗、票照紅方利益投；藍方很難放行。",
     "overrides": { "goodCleanVote": 0.5 },
     "sides": { "evil": { "redNormalVote": 0.3, "redHideHuman": false } },
     "roles": { "merlin": { "merlinNormalVote": 0.8 } }
   }
   ```

   | 欄位 | 說明 |
   |---|---|
   | `schema` | 固定 `1`。 |
   | `name` | 排行榜上的名字，最多 24 個字。 |
   | `author` | **你自己選擇公開的** GitHub 帳號（不含 `@`），排行榜會顯示並連到你的 GitHub 頁面。 |
   | `style` | 一兩句白話說你的機器人怎麼打，最多 300 個字。 |
   | `overrides` | 所有座位都套用的開關。 |
   | `sides` | `good`（藍方）／`evil`（紅方）：只在那一邊套用。 |
   | `roles` | `merlin`、`percival`、`loyal`、`assassin`、`morgana`、`mordred`、`oberon`：只在拿到那個角色時套用。 |

   套用順序：AI騎士 預設 → `overrides` → `sides` → `roles`，後面的蓋前面的。沒寫的開關照AI騎士。

3. **檢查**（需要 Node 20+ 與 pnpm 8；在 repo 根目錄 `pnpm install` 後）：

   ```bash
   pnpm --filter @avalon/shared build
   pnpm --filter @avalon/server arena:check community-bots/fast-red
   ```

4. **在自己電腦試打**：

   ```bash
   pnpm --filter @avalon/server arena:local community-bots/fast-red            # 預設 300 局
   pnpm --filter @avalon/server arena:local community-bots/fast-red --games 1000 --players 5-10
   ```

   每一局你的機器人隨機坐一半的座位、其他是AI騎士（所以紅藍兩邊都會坐到），同一局再打一次「全部AI騎士」當對照，印出：
   你坐紅方／藍方時那一邊的勝率和AI騎士 比（成對差、95% 區間）、分角色勝率、三種結局（三紅／三藍刺中／三藍活）的比例、
   你當刺客時的刺中率。區間跨過 0 就是還看不出好壞，加 `--games` 會更準。

5. **投稿**：從你的 fork 開 PR，**只加你那一個資料夾**。PR 會自動跑檢查（`AI arena bot check`）；
   通過、審過就合併，下一次每週擂台就會上場。

## 規則

- `name`、`style` 不能放**玩家名字**、網址、`@` 別人，也不能冒充官方：`name` 不能含「百科AI」「官方」「管理員」等，也不能用「AI騎士」開頭（大小寫、全半形、空白、`_` `-` 這類分隔符號都不分）——「AI騎士」開頭只給官方的風格騎士（`community-bots/_knights/`，作者「AI騎士團」）。
  審查的人會看名字；不合適的會請你改。
- 一開始**一人一隻**（同一個 `author` 只能有一隻）；名字不能和別隻重複。
- 資料夾只能放 `profile.json` 和 `README.md`。想寫真的程式？那是第 2 階段（[設計](../docs/ai/ARENA_CODE_BOTS.md)），還沒開放。
- 你的機器人只在擂台裡打，不會變成網站上陪真人打的AI騎士。

## 開放的開關

每個開關都用 `arena:knobs --live` 量過「改了真的會改變打法」。表格由
`pnpm --filter @avalon/server arena:knobs --table` 從
[`packages/server/src/arena/knobs.ts`](../packages/server/src/arena/knobs.ts) 產生，改那份再重產。

| 陣營 | 開關 | 範圍 | AI騎士 預設 | 白話說明 | 往上／往下 |
|---|---|---|---|---|---|
| 紅方 | `redHideHuman` | true / false | true | 第 1、2 局自己是隊上唯一看得到的紅時，照強者紅方的比例偶爾出成功藏身。 | 開（預設）：早期偶爾藏牌，比較不容易被讀出來。 關：改走舊規則（第 1 局刺客／莫甘娜落單一律出成功藏身）。 |
| 紅方 | `redNormalVote` | 0 – 1 | 1 | 第 3 局起不在隊上時，照「只看公開紀錄的忠臣」那樣投票的比例（偽裝成雜魚）。 | 1（預設）：票看起來像好人，難抓。 越低越常照紅方利益投（有隊友的隊投白、沒隊友的投黑），比較衝也比較好認。 |
| 紅方 | `redCleanWhite` | 0 – 1 | 0 | 偽裝投票時，隊上沒有自己看得到的紅、忠臣會投黑的隊，改投白的比例。 | 越高越常放行乾淨的隊，看起來比較隨和。 0（預設）：照忠臣的票。 |
| 紅方 | `redCleanApprove` | 0 – 1 | 0 | 第 3 局起不在隊上、隊上沒有看得到的紅時贊成的機率。 | 越高越常放行沒有隊友的隊。 0（預設）：不額外贊成。 |
| 紅方 | `redStackRate65` | 0 – 1 | 0.5 | 第 3、5 局紅方當隊長時，多帶一位隊友上任務的比例。 | 越高越常疊隊友（失敗牌比較穩，但隊伍比較好認）。 0：不多帶隊友。預設 0.5。 |
| 紅方 | `redR1Teammate` | true / false | true | 紅方第 1 局當隊長時，前四次提議有時（約一半）放一位隊友。 | 開（預設）：像真人，偶爾帶隊友。 關：第 1 局一律不帶隊友。 |
| 紅方 | `oberonR1AlwaysFail64` | 0 – 1 | 0 | 奧伯倫第 1 局上任務一律出失敗（0 = 關、1 = 開）。 | 1：奧伯倫開局就搶失敗。 0（預設）：照一般規則。 |
| 藍方 | `goodCleanVote` | 0 – 0.9 | 0.3 | 第 3 局起，忠臣和派西估「這隊沒有紅」的機率低於這個門檻就投黑。 | 越高越嚴格、越常否決。 越低越寬鬆；0 = 不用這條。預設 0.3。 |
| 藍方 | `goodKeyVote` | 0 – 0.9 | 0.3 | 紅方已拿兩局（再一個紅就輸）時，忠臣和派西的投黑門檻。 | 越高越不敢放行，關鍵局更保守。 越低越願意賭；0 = 不用這條。預設 0.3。 |
| 藍方 | `goodTailVote` | 0 – 0.95 | 0.7 | 第 3 局起忠臣和派西不在隊上時預設投黑，這隊乾淨的機率達到這個門檻才投白。 | 越高越常投黑。 越低越常放行；0 = 不用這條。預設 0.7。 |
| 藍方 | `merlinNormalVote` | 0 – 1 | 1 | 梅林第 3 局起照「只看公開紀錄的忠臣」那樣投票的比例（只在會直接輸掉時才擋）。 | 1（預設）：梅林藏得深，不容易被刺中。 越低梅林越常照自己看到的紅投票，任務比較穩，但比較容易被刺。 |
| 藍方 | `merlinCover77` | 0 – 1 | 0 | 第 1、2 局幾乎不會出任務的提議裡，梅林照「只看公開紀錄的忠臣」會派的隊來派的比例（看得到的紅在不在隊上照公開局勢）。 | 越高梅林早期派隊越像忠臣，比較難被刺中。 0（預設）：梅林照自己看到的派。 |
| 藍方 | `percivalNoThumbsR1` | true / false | true | 派西第 1 局當隊長時，兩根拇指（梅林／莫甘娜）都不放進隊。 | 開（預設）：沒資訊時先不派拇指。 關：第 1 局就會放一根拇指。 |
| 刺客 | `assassinModel` | true / false | true | 刺殺用牌譜訓練的模型；關掉改用舊的經驗規則。 | 開（預設）：用模型。 關：用經驗規則。 |

## 範例

- [`_examples/aggressive-red`](_examples/aggressive-red/profile.json)「激進派紅方」：紅方不藏牌、票照紅方利益投、常疊隊友；奧伯倫開局就搶失敗。
- [`_examples/cautious-blue`](_examples/cautious-blue/profile.json)「保守藍方」：藍方投黑門檻都拉高；梅林早期派隊照忠臣、藏得更深。

這兩隻是擂台的內建示範對手，每週都會上場（不算任何人的投稿）。

## 排行榜怎麼算

- 每週一（台灣時間 02:23）GitHub Actions 跑 `arena:tournament`：參賽 = AI騎士 ＋ 示範對手 ＋ 所有合併進 main 的機器人。
  10 人局、每個座位隨機抽一隻（可重複），角色由遊戲引擎發；局數 = max(600, 150 × 參賽數)。
- 分數 = 分陣營的隊伍邏輯回歸：AI騎士_百科 固定 1500；+100 分大約是「一整邊都換成它、對手是 AI騎士_百科」時贏的機會變成 1.8 倍。
  分紅方分、藍方分，總分是兩者平均；括號是 95% 信賴區間。
- 結果寫進 [`arena/leaderboard.json`](../arena/leaderboard.json)（只有機器人名字與作者自己公開的 GitHub 帳號），網站直接讀這一份。

---

## English (short)

**A bot = the AI Knight engine (formerly "百科AI"; the reference bot is `AI騎士_百科`) + the style knobs you choose.** No code: submit one `profile.json`.

1. Copy [`_template/`](_template/) to `community-bots/<your-id>/` (lowercase letters, digits, dashes). Only `profile.json` and an optional `README.md` are allowed.
2. Fill in `name` (≤ 24 chars), `author` (your GitHub handle, shown publicly), `style` (≤ 300 chars), and knobs in `overrides` (all seats), `sides.good` / `sides.evil`, or `roles.<role>`. Later layers win; unset knobs keep the default.
3. `pnpm --filter @avalon/server arena:check community-bots/<id>` validates it; `arena:local community-bots/<id> [--games N]` plays it against the AI Knight with paired control games and prints win rates per side and role, the three-outcome split and the assassin hit rate.
4. Open a PR from your fork that adds only your folder. The `AI arena bot check` workflow validates it; once merged it plays in the next weekly tournament.

Rules: no player names, links or @mentions in `name` / `style`; no impersonating the site (`name` may not contain "百科AI" and may not start with "AI騎士", reserved for the official knights in `_knights/`); one bot per person; names must be unique. The arena never runs submitted code (code bots are phase 2, see [`docs/ai/ARENA_CODE_BOTS.md`](../docs/ai/ARENA_CODE_BOTS.md)).

| Side | Knob | Range | Default | Meaning |
|---|---|---|---|---|
| Red | `redHideHuman` | true / false | true | Rounds 1-2, sole visible red on the team: sometimes play success to hide, at strong human rates. |
| Red | `redNormalVote` | 0 – 1 | 1 | From round 3, off the team: share of votes cast like a public-info loyal would (camouflage). |
| Red | `redCleanWhite` | 0 – 1 | 0 | While camouflaging: chance to approve a clean-looking team that a loyal would reject. |
| Red | `redCleanApprove` | 0 – 1 | 0 | From round 3, off the team and no visible red on it: chance to approve. |
| Red | `redStackRate65` | 0 – 1 | 0.5 | Rounds 3 and 5 as red leader: how often to bring one extra teammate. |
| Red | `redR1Teammate` | true / false | true | Red leader in round 1: about half of the first four proposals include a teammate. |
| Red | `oberonR1AlwaysFail64` | 0 – 1 | 0 | Oberon always fails a round-1 mission (0 = off, 1 = on). |
| Blue | `goodCleanVote` | 0 – 0.9 | 0.3 | From round 3, loyals and Percival reject when the chance the team is clean is below this. |
| Blue | `goodKeyVote` | 0 – 0.9 | 0.3 | When red has two fails already: the clean-chance bar below which loyals and Percival reject. |
| Blue | `goodTailVote` | 0 – 0.95 | 0.7 | From round 3, loyals and Percival off the team reject unless the clean chance reaches this. |
| Blue | `merlinNormalVote` | 0 – 1 | 1 | From round 3, share of Merlin votes cast like a public-info loyal (blocks only when a red team would win outright). |
| Blue | `merlinCover77` | 0 – 1 | 0 | Rounds 1-2, in proposals that will not go: share of Merlin proposals that copy what a public-info loyal would pick. |
| Blue | `percivalNoThumbsR1` | true / false | true | Percival as leader in round 1 leaves both thumbs (Merlin / Morgana) out. |
| Assassin | `assassinModel` | true / false | true | Assassinate with the model trained on human games; off = the older rule of thumb. |
