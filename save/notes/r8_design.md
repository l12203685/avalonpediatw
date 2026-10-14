# 模擬瓦 on the LINE / Discord bots — design v1 (read-only study, 2026-10-14)

Owner request (Edward 2026-10-14):「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」. Players have also asked for 模擬瓦 with a chosen role (SET 角色).

This is not the website practice game, where you play a full game against bots. A 模擬瓦 exercise is a frozen moment from a real human game: you sit in one seat with that seat's role and private information, read the proposals made so far, write down your 區間 (your interval reading), make your own proposal, and then check what that proposal tells the later seats. After that the roles are revealed. The bot asks the question, gives deterministic feedback (no LLM, no token cost), and reveals the answer.

---

## 1. What an exercise looks like, and how it maps onto the data

Source: `docs/avalon-wiki/覆盤/覆盤_模擬_753921.md`, `覆盤_模擬_3家梅林.md`, `派票.md`, `梅林派票的解讀-01.md`, `進階思考/Avalon.md`.

| Wiki exercise element | Example | Data (`parseReplayGame` → `ReplayGame`) |
|---|---|---|
| R1 proposals in captain order, written in 牌譜 notation | `460 1+` / `279` / `370` / `469` (line *i* = seat *i*'s proposal; `1+` = seat 1 approved from outside the team) | `proposals[]`: `leaderSeat`, `teamSeats`, `plusSeats` (X+), `minusSeats` (X-), `forced` (1-5) |
| A fixed viewpoint with its private info | 「2家：派西（1、5拇指）」「4家：雜魚」「3家：梅林(158拇指)」 | `seatRoles` + `roleKnowledge()` (`ai/benchmark/replayObservation.ts`, production conventions) |
| 區間 reasoning | 「7 8 9 *2」「1 2 *1-2，因為 12 派票不同邊」 | v1 logic panel (§4c) and the `/區間` parser (§3) |
| Reading earlier proposals | 「3 的派票不是好人派票」 | 「全好讀法」 claim checks (§4c) |
| Own proposal + final check | 「派票完的最後檢查：…傳遞的資訊是什麼?」「派469較468好，因為468變成跟279打對邊」 | the released-information panel (§4d) |
| Role reveal | 「刺7娜5莫3奧9派2梅1」 (the page title 753921 *is* this role code) | `seatRoles` (配置 order 刺娜德奧派梅) |

What the data contains (`packages/server/sheets_cache.json`, 牌譜 tab; scratch run of the strict parser, counts only):
- 2,146 records, of which 1,970 replay strictly. 1,913 of those have a valid lake chain, and 1,778 are left after also dropping the 娛樂 category. That pool of 1,778 games is the v1 bank.
- In 1,936 of the 1,970 games, R1 runs all 5 proposals (seats 1–5 propose; 1-5 is forced). R2 is then led by seats 6, 7, 8, 9 and 0 (about 1,500–1,770 proposals each). So **every seat has a natural first decision: seats 1–5 in R1, seats 6–0 in R2.** After that, a seat's next proposal comes about 10 proposals later, and in 29% of cases the game ends first.
- Number of exercises for each role at each R1 seat: about 170–220 per seat for each special role and about 700–780 per seat for 忠臣. For example, 派西 at seat 2 has 188, 梅林 at seat 4 has 186, 莫德雷德 at seat 3 has 180 and 忠臣 at seat 4 has 702.

---

## 2. Scenario bank

**Constraint:** a scenario contains no player names, no dates, no 流水號 and no free-text notes. It holds seat numbers only.

**Finding that changes the obvious option:** `packages/server/sheets_cache.json` is listed in `.dockerignore` (line 60), so it is **not in the Render image**. It also carries 玩1..玩0 names and the `note`/`日期時間` columns. Parsing it at server start would therefore mean shipping the names inside the image.

**Recommended (v1):** add a committed, generated, name-free file.
- File: `packages/server/sim_bank.json`, about 270 KB (1,778 games × roughly 150 bytes). It is not dockerignored, it sits under `packages/server/**` so it is covered by Render's buildFilter, and it stays far below the cache size.
  ```json
  { "version": 1, "builtFrom": "sheets_cache.json", "games": [
    { "id": "K7Q2M", "cfg": "753921", "rec": "460 1+\n279\n370\n469\n…\nooo\n…\n0>8 x\n…", "kill": "1", "res": "三藍死" } ] }
  ```
  - `rec` is the **canonical re-serialisation of the parsed game**: team digits, ` X-` / ` X+` tokens, `o`/`x` card lines and `H>T o|x` lake lines. It never contains the raw cell, so footers (`1.名字`), notes, full-width text and dates cannot leak. A round-trip test enforces `parseReplayGame(serialise(g))` ≡ `g` (ignoring names and the sheet id).
  - `id` is the first 5 characters of Crockford base32 of sha1(`record_fingerprint`) (配置 + teams + missions, the same definition `generate_cache.py` already uses). It is stable across rebuilds and independent of the 流水號. On a collision the builder extends to 6 characters. An exercise id is `<id>-<seat>`, for example `K7Q2M-4` (seat 10 is written `0`).
  - Games are sorted by `id`, so file order says nothing about when a game was played.
  - Filters are applied when the bank is built: strict replay OK, `lakeChainValid`, not 娛樂 (owner decision D6).
- Producer, v1: `packages/server/scripts/buildSimBank.ts`, an offline and deterministic `tsx` script. It reads `sheets_cache.json` through `rowsFromSheet` and `parseReplayGame`, so there is exactly one parser. Re-run it whenever the snapshot is refreshed. It prints counts only.
- Producer, v1.1 (only if the owner wants new games daily, D5): `generate_cache.py` gains `write_sim_bank()`. It runs over the merged game log (牌譜 + Discord匯入), cuts footers with the same rules, keeps only lines matching `^[0-9oxOX+\-> ?]+$`, and writes the same file. Tested on the snapshot, 2,142 of 2,146 records pass that whitelist; the other 4 contain full-width `？`, which NFKC normalisation fixes, or 「派西」. `refresh-analysis-cache.yml` would then `git add` the file in the same commit, with a guard that fails if the bank shrinks by more than 5%. The server still strict-parses every entry and counts the drops, so a Python/TS mismatch can only drop games; it cannot corrupt them. Optionally, games newer than N days are left out, using the date the generator has but never writes (D5).
- Server: `bots/simulation/bank.ts` loads the file once in the background after `initializeBots()`. It takes about 100–300 ms and is lazy, so the first `/模擬` waits for it if it is still loading. It builds:
  - `SimGame { id, roles, proposals, quests, lakes, assassinTargetSeat, winner }`. **There is no `names` field.** If a fallback ever builds the bank from raw rows, `ReplayGame.names` is dropped immediately, and a test asserts that `JSON.stringify(bank)` contains none of the fixture's names.
  - The decision index `role:seat → [{game, proposalIndex}]`: the seat's first proposal (R1 for seats 1–5, R2 for 6–0) plus the later ones it leads.
  - Human aggregates for §4b, keyed by (role, round, seat) for R1/R2 and by (role, round) for R3+.
  - A missing or corrupt file means `/模擬` answers 「題庫還沒準備好」, and the status endpoint shows `bank.loaded=false`.

The answer key (`cfg`) is in a public file, as it already is in `sheets_cache.json`. This is a self-practice tool and cheating only spoils it for the cheater. It needs no decision, but the risk is stated here.

---

## 3. Session engine

### Commands (same words on LINE and Discord; `/` or full-width `／`; space optional, like `/戰績`)

| Command | Meaning |
|---|---|
| `/模擬` | Random exercise. The default pool is R1, seats 2–5, any role; this matches the wiki format (D7). |
| `/模擬 <角色> [座位]` | `/模擬 派西 2`, `/模擬 梅林`, `/模擬 忠臣 4`, `/模擬 7`, `/模擬 紅` (random red role), `/模擬 藍` (random blue role). With a role but no seat, the seat is picked from 2–5. |
| `/模擬 題 <題號>` | A specific exercise (`/模擬 題 K7Q2M-4`), so a whole group can do the same one. |
| `/派 469` | Your proposal. `0` means seat 10. `4 6 9` and `4,6,9` are also accepted. The size must match the round (3 / 4 / 4 / 5 / 5) and seats must be distinct. Re-answering overwrites the previous answer. |
| `/區間 789=2 460=1` | Optional interval reading. Wiki style is accepted too: `7 8 9 *2 4 6 0 *1`, `12=1-2`, `3=紅`, `5=好`. Groups must be disjoint. |
| `/下一步` | Reveal the public events (proposals with votes, mission cards, lake claims) up to your next proposal, which you then answer the same way. If you have no later proposal, it shows the rest of the game without roles and asks for `/公布`. This also works before answering, to skip. |
| `/公布` (also `/解答`) | Reveal roles, the true red set, how your answers and 區間 scored against the truth, the real players' roles for the earlier proposals, and the result. Ends the exercise. |
| `/結束` | End the exercise without revealing. |

- Role aliases: 梅林/梅; 派西/派西維爾/派; 忠臣/雜魚/忠; 刺客/刺; 莫甘娜/魔甘娜/娜; 莫德雷德/莫德/默德/德; 奧伯倫/奧柏倫/奧; 紅/壞人; 藍/好人.
- Seats: 1–9, and 0 or 10 for seat 10. Replies always write seat 10 as `0家`.
- `/派`, `/區間`, `/下一步`, `/公布` and `/結束` with no open session get one short hint (「你目前沒有進行中的模擬，輸入 /模擬 開一題（30 分鐘沒動作會自動結束）」). A malformed argument gets the usage text.
- Plain chat is never answered, and the parser only matches these exact command words. `/派西 2` is not `/派`: the rest is not digits, so the command is ignored with no session, or gets the usage text with one.

### Selection: a "meaningful decision"
A pool entry is a (game, proposal) pair where `leaderSeat` = the chosen seat and the seat has the chosen role:
- Seats 1–5 use their R1 proposal; the seat's attempt must exist, which is true in 98% of games. Seat 5's forced 1-5 counts and is the classic 「5家怎麼派」.
- Seats 6–0 use their first R2 proposal, after the R1 mission result.
- Seat 1 in R1 has no earlier proposals, so it is pure 「釋放」 practice. It is only used when asked for explicitly.
- If a role/seat combination has fewer than 20 entries, the bot says so and lists the seats that are available for that role.
- The RNG is `seededRandom` from `ai/benchmark/agreement.ts`, seeded by session key and time, so tests are deterministic.

### What the viewer is shown
Production conventions, the same as `roleKnowledge()`:
- 梅林 sees the reds except 莫德雷德 (「拇指」).
- 派西維爾 sees two 拇指: one is Merlin and one is Morgana.
- 刺客, 莫甘娜 and 莫德雷德 see each other's seats but not their roles, and not 奧伯倫.
- 奧伯倫 sees nobody.
- 忠臣 sees nothing.

In a group this is shown openly, as in the wiki exercises.

### State (memory only)
```ts
interface SimSession {
  key: string;                // `${platform}:${chatId}:${userId}` — one per user per chat
  exerciseId: string;         // 'K7Q2M-4'
  game: number; seat: number; role: Role;
  decision: number;           // proposals[] index of the open decision
  cursor: number;             // public events shown so far (event list = proposals/quests/lakes in game order)
  answers: Map<number, number[]>;    // decision → team typed
  interval?: IntervalReading;        // last /區間
  phase: 'answering' | 'answered' | 'no-more-decisions' | 'revealed';
  lastReply?: { eventKey: string; text: string };  // LINE redelivery: resend, never advance twice
  startedAt: number; lastActiveAt: number;
}
```
- TTL is 30 minutes idle (`SIM_SESSION_TTL_MINUTES`) with a 2-hour hard cap. There are at most 500 sessions (least recently used evicted), at most 30 per chat, and at most 30 commands per user per 10 minutes; past that limit the user gets one notice and then nothing.
- A new `/模擬` replaces the user's open session and says so in one line.
- There is no persistence. A deploy or restart drops sessions; this is acceptable, since the daily cache refresh redeploys at about 03:47 +08 and keep-alive prevents idle sleep.
- **Commit after delivery.** The engine returns `{ text, commit() }`. The LINE client calls `commit()` only after `replyMessage` succeeds, so a failed reply does not skip a step. A LINE redelivery (`duplicate` from `isDuplicateDelivery`) re-sends `lastReply.text` without running the transition.

---

## 4. Feedback after each answer (v1: deterministic, no LLM)

Everything is computed from the bank and the exercise at the current cursor. The worked numbers below are from the wiki exercise 753921, viewpoint 4家忠臣, and were checked by script.

**(a) Real player.** 「實際這位 4家派：469（跟你一樣）」, plus what happened to that proposal (rejected or approved, mission cards). It is shown right after `/派` (D8) because it reveals only that seat's own action.

**(b) Humans in comparable spots.** The key is (role, round, seat) for R1/R2 and (role, round) for R3+. The current game is left out, and `n` is always printed; below 30 the bot shows 「樣本少」. Features are computed relative to that proposer's own information:
- whether the proposer included themselves;
- private-info hits: Merlin, how many seen reds are on the team; Percival, how many 拇指; 刺客/娜/德, how many teammates;
- overlap with the immediately previous proposal (0 / 1 / 2+);
- for R3+, overlap with the last mission team and whether a member of a failed mission is included.

The bot prints the share of humans with each feature and marks the viewer's own value. Real values from the pool:

| Spot | n | Includes self | Private-info hits | Overlap with previous proposal |
|---|---|---|---|---|
| 4家忠臣 R1 | 702 | 87% | — | 0 / 1 / 2+: 35% / 46% / 19% |
| 2家派西 R1 | 188 | 93% | 0 / 1 / 2 拇指: 93% / 7% / 0.5% | — |
| 4家梅林 R1 | 186 | 92% | 0 / 1 seen red: 91% / 9% | — |
| 3家莫德雷德 R1 | 180 | 94% | 0 / 1 / 2 teammates: 53% / 44% / 2% | — |

**(c) Logic panel.** Only certain information is used; proposal and vote behaviour is not weighed yet, and the reply says so. Worlds are the red sets R ⊂ {1..10} with |R| = 4 (210 in all) that satisfy:
- H2, the viewer's sight: good viewers are not in R; Merlin's seen reds ⊆ R; Percival's two 拇指 contain exactly one red; red viewers' teammates and themselves ⊆ R;
- H1, every mission with f fail cards had at least f reds on it. A success is no proof that the team was all good, and the panel says so. In R4, 1 fail can still mean the mission succeeded while proving at least 1 red;
- H3, the viewer's own lake results (the truth, from the roles) when the viewer held the lake.

Lake claims by others are not facts: they are listed as 「湖讀法」 (「若 0 是好人說實話，8 是紅 → 剩 N 種」), the same way proposals are read.

The worlds are weighted uniformly. The panel shows:
1. **Facts**, each on one line: own camp, private sight, every mission fact, own lake results.
2. **Size:** the number of consistent red sets and log2 of it, e.g. 「126 種（約 7.0 bits）」. These match the r7 survey table: 忠臣 126, 派西 70, 梅林 6, 刺/娜/德 7, 奧伯倫 84.
3. **Interval view in the wiki's own notation.** Seats are grouped by identical red marginal, and each group shows its count range across worlds:
   - 4家忠臣 at R1: 「其他 9 人各 44%（*4）——第 1 局任務前純邏輯沒有區間，區間全部來自派票解讀」;
   - 派西 at seat 2: 「1 5 *1（一梅一娜）｜3 4 6 7 8 9 0 *3（各 43%）」;
   - 梅林 at seat 1: 「5 7 9 紅（拇指）｜其餘 *1（莫德雷德，各 17%）」;
   - 莫德雷德 at seat 3: 「奧伯倫在 1 2 4 6 8 9 0（各 14%）」.
4. **全好讀法 checks** (reading a proposal as "the captain and the team are all good"). For each earlier proposal, claim C = team ∪ {captain}:
   - the share of worlds where C holds: 1家 `460 1+` → C = {1,4,6,0} → 15/126;
   - certain falsity from private sight: 「1家 460 含你看到的拇指 6 → 這個讀法不成立」;
   - pairwise joint counts: 「1家＋2家 合起來 7 人＞6 個好人 → 不可能都對：1、2 至少一個派到紅或本身是紅」(this is exactly the wiki's 「12 *1-2，因為 12 派票不同邊」); 「1家＋3家 只剩 1 種（紅 2589）」; 「2家＋3家 只剩 1 種（紅 1568）」.

**(d) Information your proposal releases.** For the viewer's team T with claim C_you = T ∪ {viewer}:
- the reading 「4 6 9 好 → 1 2 3 5 7 8 0 有 4 紅（35 種）」;
- against each earlier proposal: the overlapping seats and a label: 延伸 (2 or more shared), 部分 (1 shared) or 打對邊 (none shared); plus the joint world count. For the answer 469: 1家 460 overlaps on 4 6 (5 worlds); 2家 279 overlaps on 9 (5 worlds); 3家 370 does not overlap, so 打對邊, and only 1 world remains (紅 1258);
- the implied rejection: which earlier pair or triple your reading cannot coexist with (「跟 1家＋2家 不能同時成立 → 你在說 1、2 至少一個錯」);
- the viewer's own private sight. Merlin: does the team hold a seen red (a deliberate lie?), against the share of human Merlins who do that. Percival: does it hold a 拇指 (50% chance it is Morgana). Red: does it hold teammates, and does the reading place a teammate in the "good" zone (the wiki's 「包/疊隊友的票」「製造假區間」);
- a contrast line when an alternative team of the same size and shape (self + 2) is 打對邊 with a proposal yours extends. For example, 468 against 279 leaves only 紅 1350. This is the wiki's 「派469較468好」 point in mechanical form. It is printed only when it fits the length budget.

**(e) Your 區間.** For each group, the logic-only share of worlds with exactly that count, e.g. 「789=2：45/126（36%）」, plus the joint count across all groups, e.g. 「你的區間留下 24/126 種（19%）」. A group that includes the viewer's own seat is reduced, e.g. 「460=1：你自己是好人 → 6 0 一紅，56%」. A group that contradicts a certain fact gets 「與確定資訊矛盾：…」. After `/公布`, each group gets ✓ or ✗ against the truth, and the bot says whether the true red set is among the worlds your 區間 kept.

### v2 hook: a belief model
`logic.ts` exposes the world model behind an interface, so the coming belief engine (task Z: public belief state, human proposal and vote likelihoods learned from the bank, joint entropy) only has to plug in:
```ts
export interface SimWorld { redMask: number; weight: number; roles?: Uint8Array /* v2 role-level worlds */ }
export interface SimBeliefModel {
  readonly id: string;                 // 'logic' (v1)
  readonly label: string;              // 「純邏輯」 / v2 「派票加權（真人資料）」
  readonly weighsBehaviour: boolean;   // false → replies say "not yet weighing proposals"
  worlds(view: SimView): SimWorld[];   // weight-0 worlds omitted
}
export interface SimView { seat: number; role: Role; sight: Sight; events: PublicEvent[] /* up to cursor */; ownLakes: LakeTruth[] }
```
- All panels in (c), (d) and (e) consume `analyze(worlds)`, which returns marginals, group count distributions, claim probabilities and joint entropy −Σp·log2 p (log2 N when uniform). Swapping the model changes no formatter.
- The v2 model is `logic × Π_t π(action_t | proposer's information at t, world)` from human data, the level-1 filter recommended in r7's literature §0.3a.
- (d) then gains 「後面的好人不確定性下降 x bits」 under that model, and (b) gains a likelihood ratio such as "this proposal is k× more likely from Merlin than from 忠臣".
- The switch is `SIM_BELIEF_MODEL=logic|belief`, with logic as the default.
- The red-set enumeration (H1–H3, bitmasks over seats 1–10) goes into a shared pure module, e.g. `ai/worlds.ts`, holding `combinations`, `popcount` and `evilCountFor` moved out of `GoodLakeInfo.ts` with no behaviour change (guarded by `GoodLakeInfo.test.ts`). Task Z plans the same extraction (r7 literature §10 step 1), so whichever lane lands first owns the module and the other imports it.

---

## 5. Message formats

Every reply is **one message of at most 1,800 characters** (the same budget as stats; `STATS_REPLY_MAX_CHARS`). That fits Discord's 2,000-character limit and one LINE slot. Text is plain Traditional Chinese, using the 牌譜 notation the community already reads. On Discord only, the proposal block is wrapped in a code block. Seat 10 is written `0`, and nothing contains a name. Examples:

**Start** (`/模擬 忠臣 4`)
```
【模擬瓦 K7Q2M-4】你是 4家・忠臣（沒有額外資訊）
第 1 局派票（隊長依序；X+ 隊外贊成、X- 隊內反對）：
1家 460 1+
2家 279
3家 370
輪到你派 3 人（第 1 局第 4 次）。
作答：/派 469　區間（選填）：/區間 789=2 460=1
/下一步 跳過｜/公布 看角色｜/結束
```
For other roles the identity line changes:
- `你是 2家・派西維爾。拇指：1 5（一梅林一莫甘娜，不知道誰是誰）`
- `你是 1家・梅林。拇指（看到的紅）：5 7 9；莫德雷德看不到，還有 1 紅`
- `你是 3家・莫德雷德。隊友：5 7（奧伯倫不認隊友；梅林看不到你）`
- `你是 9家・奧伯倫。你不知道隊友，隊友也不知道你；梅林看得到你`

**After `/派 469`** (about 900 characters)
```
【K7Q2M-4・4家忠臣】你派 469
① 實際這位 4家派：469（跟你一樣）→ 否決
② 同位置真人（第1局 4家忠臣，702 次）：含自己 87%（你✓）；
   跟 3家 370 重疊 0 人 35%｜1 人 46%｜2 人以上 19%（你 0 人）
③ 邏輯（只用確定資訊，還沒算派票行為）
・你是好人，4 紅在其他 9 人：126 種（7.0 bits），每人 44%
・全好讀法：1家 1460、2家 279、3家 370 各 15/126
・1家＋2家 共 7 人＞6 好人 → 不可能都對（1、2 至少一個錯）
・1家＋3家 只剩紅 2589；2家＋3家 只剩紅 1568
④ 469 放出的資訊：4 6 9 好 → 1 2 3 5 7 8 0 有 4 紅（35 種）
・對 1家 460：延伸（4 6），都對剩 5 種
・對 2家 279：部分（9），都對剩 5 種
・對 3家 370：打對邊，都對只剩紅 1258
・不能和「1家＋2家」同時成立 → 你在說 1、2 至少一個錯
/區間 寫下你的區間｜/下一步｜/公布｜/結束
```

**`/區間 789=2 460=1`**
```
【K7Q2M-4 區間】（純邏輯，還沒算派票）
・789=2：45/126（36%）
・460=1：你是好人 → 6 0 一紅，70/126（56%）
・兩個都成立：24/126（19%）
/公布 後會對答案
```

**`/下一步`** shows the 1-5 proposal and R1 cards, the R2 proposals (6家…0家) and cards, the lake claim, and the R3 proposals (1家 2家 3家), then:
```
輪到你派 4 人（第 3 局第 4 次）。
```
followed by one short facts line (e.g. 「第 1 局 5 7 0 出 1 失敗 → 5 7 0 至少 1 紅」). About 15 event lines; the 「（之後照實際對局進行，你的答案不改變後面發生的事）」 note is shown once.

**`/公布`**
```
【K7Q2M-4 公布】
角色：梅林1 派西維爾2 莫德雷德3 莫甘娜5 刺客7 奧伯倫9；忠臣 4 6 8 0
紅：3 5 7 9
你的 469：0 紅 ✓｜區間 789=2 ✓（7 9）、460=1 ✗（0 紅）
前面派票：1家 梅林 460 全好；2家 派西 279 有 2 紅；3家 莫德雷德 370 有 2 紅（含自己）
這局結果：三藍活／三藍死（刺 X家）／三紅
```

### Help text
- Add `/模擬 [角色] [座位]` to `formatStatsHelp` (the LINE `/指令` reply) and to the Discord `/help` embed.
- Add a new row to the command table in `docs/LINE_DISCORD_SYNC.md`.
- Add a community page, `docs/SIMULATION.md` (「模擬瓦怎麼玩」), in Chinese.

---

## 6. Platform wiring

### LINE (`bots/line/client.ts`)
- `leadReplyFor()` keeps its order (stats, then `/意見`) and adds the 模擬 commands third. `LeadReply.kind` gains `'sim'`, booked under a new counter `LineWebhookStats.simReplies`.
- Its context grows to `{ duplicate, chat: group|user id, userId, quoteToken, eventKey }`. If a group event has no `userId`, the session falls back to a chat-shared key.
- **Mirror group, exactly as `/戰績` works today.** The command text is ingested and mirrored to Discord and the lobby like any text. The answer takes slot 1 of this reply token, the remaining 4 slots drain the mirror queue, and the answer is never queued or mirrored. A failed reply re-queues only the drained mirror messages, and `commit()` is not called.
- In groups the lead message carries `quoteToken`, so the reply visibly answers that person's command without naming anyone. The SDK's `TextMessage` and `TextEventMessage` both support it.
- 1:1 chats use `replyLead()`: no drain, and quick-reply buttons for /下一步, /公布 and /結束. Quick replies are not used in groups: they must sit on the last message object, which in the mirror group is a drained mirror line.
- Other LINE groups stay silent, as for `/戰績`, unless the owner allow-lists a practice group with `SIM_LINE_GROUP_IDS` (D1). There the reply uses only its own token and nothing is drained.
- `getFeedbackService().observe()` must skip 模擬 commands, the same way it skips stats commands, because they are usage and not reactions. `chatExport/rows.ts isTypedCommand` already skips any `/X…` text, so nothing reaches the sheet.

### Discord (`bots/discord/*`)
- Six new slash commands with CJK names:
  - `/模擬`, with options 角色 (choices: 梅林, 派西維爾, 忠臣, 刺客, 莫甘娜, 莫德雷德, 奧伯倫, 紅, 藍), 座位 (integer 1–10) and 題號 (string);
  - `/派` 隊伍; `/區間` 內容; `/下一步`; `/公布`; `/結束`.
  `/解答` is LINE-only, since Discord cannot alias commands. The total is 21 commands. `buildSlashCommands()` registers the whole list, and `DiscordBotCommands.test.ts` already validates the builder offline.
- The session key is `discord:${channelId}:${user.id}`.
- Each handler defers, then edits the reply with `allowedMentions: { parse: [] }`.
- Visibility: public in channels listed in `SIM_DISCORD_PUBLIC_CHANNEL_IDS` and ephemeral elsewhere. If the variable is empty, replies are public everywhere, like `/戰績` (D1).
- Global commands also work in a DM with the bot; guild-only registration through `DISCORD_GUILD_ID` does not.
- Mirror: a slash invocation creates no user message, and the bot's reply is bot-authored. `handleDiscordMirrorMessage` ignores bot authors and chat export skips them, so **nothing from a Discord 模擬 reaches LINE or the sheet.** A user who *types* `/派 469` as plain text in the sync channel gets no answer and the text is mirrored, the same as a typed `/戰績` today.
- Buttons (下一步 / 公布 / 結束 on the reply) are a nice-to-have for v1.1, not v1.

### Optional daily exercise (D3)
A `DailySimScheduler` copying the `WeeklyDigestScheduler` pattern (narrow +08 window, in-memory last-posted day) would post 「今日模擬題 K7Q2M-4」 with the start text (no roles) to the chosen Discord channel. For the LINE mirror group it would use `ChatMirror.enqueueLineReplyText()`, the free reply queue that goes out when someone next speaks; push is never used. The reveal would be by `/公布` per person, or a next-day post. Default: off.

---

## 7. Privacy and logging
- Scenarios hold seats only: the bank has no names or dates by construction and is ordered by hash. Replies never name a player.
- Command text, answers and 區間 live only in session memory. Logs are fixed strings plus error codes (`describeError`), never text or ids.
- `/api/bots/status` carries counts and booleans only (§8). It holds no exercise ids, chat ids or user ids.
- No GitHub, Actions or sheet output from this feature, except the optional v1.1 bank commit, which is name-free and logs counts only in the job summary.

---

## 7a. Code layout and reuse
`packages/server/src/bots/simulation/`:
- `bank.ts`: load and strict-parse `sim_bank.json`, build the index and human aggregates.
- `scenario.ts`: selection, ids, viewer sight, the public event list.
- `logic.ts`: `SimBeliefModel`, the logic-only model and `analyze()`, on top of the shared `ai/worlds.ts`.
- `commands.ts`: pure parsing (command, team, interval).
- `session.ts`: store, TTL, caps and transitions.
- `replies.ts`: pure formatting, length-clamped.
- `textCommands.ts`: `answerSimTextCommand` for LINE.
- `discordCommand.ts`.
- `config.ts`: `SIM_COMMANDS_ENABLED` (default on), `SIM_SESSION_TTL_MINUTES`, `SIM_DISCORD_PUBLIC_CHANNEL_IDS`, `SIM_LINE_GROUP_IDS`, `SIM_BELIEF_MODEL`.
- `index.ts`.

Reused code: `ai/benchmark/sheetsReplay.ts` (`parseReplayGame`, `rowsFromSheet`); `ai/benchmark/replayObservation.ts` (`roleKnowledge`); `services/sheetsGameRecordParser.ts` (`leaderSeatForProposal`); `ai/benchmark/agreement.ts` (`seededRandom`).

Module headers quote the owner's request (「Edward 2026-10-14：…」) and use Traditional Chinese doc comments.

---

## 8. Tests and metrics

**Unit tests (pure, vitest):**
- `commands`: every form of every command (full-width slash, missing space, aliases, seat 0/10, bad sizes, duplicate seats, overlapping 區間 groups, wiki `*` syntax). `/派西 2` must not parse as `/派`.
- `bank`: round trip `parse(serialise(g)) ≡ g`. Fixture rows use placeholder names (P1..P10) and a date; neither may appear anywhere in the built bank or in any reply. Ids are stable, unique and order-independent. Filters are applied.
- `scenario`: seats 1–5 map to R1 and 6–0 to R2; role/seat filter; thin pools; a 題號 round trip; sight per role equals `roleKnowledge`.
- `logic`, a golden test on the wiki 753921 exercise: 126 worlds; claim counts 15/126; 1家+2家 gives 0, 1家+3家 gives {2,5,8,9}, 2家+3家 gives {1,5,6,8}; 469 with 370 gives {1,2,5,8}; 468 with 279 gives {1,3,5,0}; 派西 at 2 gives 70 worlds with 1 and 5 at 50%. View sizes 126/70/6/7/84. Invariants: every world satisfies H1–H3, and the true red set is always consistent at every decision point.
- **Property test over the committed bank** (slow, like `benchmark.test.ts`): for every decision point, the true world is consistent, every reply is at most 1,800 characters, and every reply contains only expected characters.
- `session`: TTL with a fake clock; one session per user per chat; replacement; `/下一步` reaches the next decision or the end; `/公布` ends the session; caps and eviction; rate limit; commit-after-delivery; a redelivery re-sends without advancing.
- LINE, modelled on `LineStatsCommands.test.ts`: in the mirror group the answer takes slot 1 and 4 mirror messages drain; the command text is mirrored and the answer is not; a failed reply re-queues only mirror items and does not commit; `quoteToken` is set in groups; 1:1 replies carry quick replies; non-mirror groups stay silent unless allow-listed; the flag off means silence; `observe()` skips 模擬 commands.
- Discord: builder validation for the 6 new commands; handlers reply with mentions off; public versus ephemeral by channel config; bot replies in the sync channel are not mirrored.
- Status: the `simulation` block holds only numbers and booleans.

**Metrics** (`/api/bots/status → simulation`, counts only):
```json
{ "enabled": true,
  "bank": { "loaded": true, "games": 1778, "dropped": 0, "decisionPoints": 26850 },
  "sessions": { "active": 3 },
  "counts": { "started": { "line": 0, "discord": 0 }, "byRole": { "merlin": 0, "…": 0 },
              "answers": 0, "sameAsReal": 0, "intervals": 0, "intervalGroupsRight": 0, "intervalGroupsTotal": 0,
              "steps": 0, "reveals": 0, "ended": 0, "expired": 0, "usage": 0, "noSession": 0, "rateLimited": 0 } }
```
Plus `line.stats.simReplies`.

---

## 9. Rollout
1. M1: `ai/worlds.ts` (coordinate with task Z), the bank builder and `sim_bank.json`, and the pure `logic`, `scenario` and `replies` modules with the golden and property tests.
2. M2: the session engine and LINE wiring.
3. M3: the Discord slash commands.
4. M4: status counters, help texts, `docs/SIMULATION.md` and the sync-doc row.

Defaults until the owner answers: LINE 1:1 and the mirror group on; Discord public like `/戰績`; daily exercise off; snapshot bank; 娛樂 excluded; random pool R1 seats 2–5; real player shown after answering.

v2: the belief model (task Z), `/投` (vote) and `/湖` (lake) decisions, Discord buttons, and a 「群組共同題」 mode (D4).

---

## 10. Decisions for the owner (D1–D10)
These are in plain Chinese, in the order they matter:
- **D1 在哪裡可以玩**：LINE 1 對 1（建議開）。LINE 大群（同步群）要不要也能玩？在大群玩，每一步都會有一則較長的機器人回覆，大家都看得到。要不要另開一個「模擬瓦」LINE 群，把機器人拉進去專門練？Discord 的公開回覆要限定在哪個頻道（建議新開 #模擬瓦）？其他頻道是只有本人看得到，還是像 /戰績 一樣全公開？
- **D2 指令同步**：LINE 大群裡打的模擬指令（例如「/派 469」）要不要像 /戰績 一樣同步一行到 Discord？預設照 /戰績：指令那一行會同步，機器人的回答不會同步。
- **D3 每日一題**：要不要機器人每天固定時間貼一題？貼在哪裡（LINE 大群走免費回覆佇列，Discord 哪個頻道）、幾點？答案是各自 /公布，還是隔天由機器人公布？預設不開。
- **D4 個人題或大家一起**：群組裡預設一人一題。要不要加「一人出題、大家都能作答、一起公布」的群組共同題？
- **D5 題庫**：先用現有牌譜快照（約 1,778 局，不會自動加新局），還是每天跟著戰績更新加入新局？如果加新局，最近幾天（例如 14 天）的局要不要先不出，以免當局的人一眼認出來直接講答案？
- **D6 娛樂局**：題庫要不要排除分類「娛樂」的 135 局？預設排除。
- **D7 隨機出題的範圍**：預設只出第 1 局 2～5 家（像百科的模擬題）。要不要也隨機出 6～0 家的第 2 局派票？指定座位時一律可以。
- **D8 什麼時候給看真人的派法**：作答後馬上顯示「當時坐這個位置的人實際怎麼派」（預設），還是等 /公布 才顯示？
- **D9 指令名稱**：/模擬、/派、/區間、/下一步、/公布（LINE 也接受 /解答）、/結束，這樣可以嗎？
- **D10 紅方視角**：當紅方（刺客、莫甘娜、莫德雷德）時，只顯示隊友的座位（預設，照機器人現有規則），還是連隊友的角色也顯示？
