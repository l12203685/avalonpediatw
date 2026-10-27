# 機器人改版計畫：邏輯第一原理 → 像真人 → 強度（2026-10-14）

- **依據**：Edward 2026-10-14 指示 (1)–(5)；r7 的四份報告 `literature.md`、`logic_audit.md`、`belief_engine.md`、`framing_study.md`，審查 `critique.md`（其更正全部採用，見第 8 節），以及 `lane/r6-percival` 的 `docs/ai/percival_thumbs.md` 與 `percival_followups.md`。
- **程式碼版本**：`main` @ `52ae020`。`lane/r6-percival` @ `7c005d7`（`percivalNoThumbsR1`）**還沒有併進 main**。
- **資料**：`packages/server/sheets_cache.json` 牌譜，1970 局可重播 10 人局（湖鏈合法 1913 局）。本文所有數字都來自上列報告的彙總輸出，沒有新跑資料，也不含玩家名。
- **這份文件只是計畫**：沒有改任何程式。第 0、1、6、7 節是給 Edward 的中文說明；第 2–5 節是技術規格（英文為主）。

---

## 0. 給 Edward 的摘要

1. **新的採用順序**（第 1 節）取代「不能變弱」當第一關：
   - **第一關：邏輯正確。** 能消除一條「絕對正確約束」違規的修改，直接採用，並且要附回歸測試和不變量檢查。自我對打強度只**量測並回報**；如果變弱，下一步是從策略上補回來，**不把邏輯改回去**。
   - **第二關：像真人**（一致性基準）。
   - **第三關：強度**（多種子協定），只用在純策略、啟發式的修改。
   - 任何後面的修改都不能讓不變量檢查出現違規。
2. **第 1 階段**有 12 項，全部是小而確定的修正（第 2 節）：
   - 建一個共用的「確定性層」（列舉 210 種紅方組合，刪掉與確定事實矛盾的）；
   - 硬3 只看湖後；
   - 失敗張數約束（x 張失敗 ⇒ 至少 x 紅；R4 成功但有失敗牌也算）；
   - 湖鏈 C > B > A 的排序，並套用到派隊；
   - 「必定失敗的隊」好人不派、不投贊成；
   - 派西的三個邏輯錯誤；
   - 派西首局不放拇指（您 10/14 的裁定）；
   - 派西的湖 = 藍方的湖（拿掉拇指避開名單）；
   - 第 5 次強制提議的合成票不算資訊；
   - 紅方不做「不可能為真」的宣告；
   - 防禦與清理。
3. **現在違規最嚴重的三件事**（真人局面重播）：
   - **硬3 把湖前的隊也算進去。** R4、R5 開局時，46.5%、62.1% 的誠實藍方持湖者被釘在 ≥0.85 的嫌疑。湖前的訊號只有 0.0036 bit（概似比 1.16），湖後是 0.056 bit（概似比約 18）。
   - **確定的事實沒有進入信念。** 好人自己推得出「確定是紅」的人，有 51–63% 被打成 < 0.85；持湖者自己親眼湖到的藍方，17.9% 被自己打成 ≥ 0.85。
   - **好人照樣派出「必定失敗」的隊。** 這種隊占 7.3%（1685/22976），真人忠臣只有 0.06%。
4. **第 2 階段**：紅方嫁禍改用您說的三類目標，再加上用熵算的「暴露檢查」（第 3 節）。真人資料的重點：
   - 真人嫁禍挑的是「出過失敗任務、可信度在灰色帶」的人；
   - 對「梅林可疑人選」沒有偏好，也量不出好處；
   - 會讓自己「直接被判紅」的嫁禍，真人只有 1.5%。
   - 門檻：可信度 p_T < 0.24 時，宣紅會讓持湖者自己更可疑。
5. **第 3 階段**：統一的信念引擎（第 4 節）。
   - 依事件先後一步一步更新（Bellman 式的信念遞迴）：每一步只用行動者「當時」知道的資訊。這樣時序錯誤在結構上就不可能發生。
   - 每個決策用熵、資訊增益來評分；權重由一步前瞻的價值表決定，不靠手調。
6. **不變量檢查工具**（第 5 節）：大量跑自我對打和真人重播，逐條規則計算機器人違反了幾次。CI 跑小樣本（現有的 `test.yml` 已經會跑伺服器的 vitest，不用新增流程），要求硬規則 0 違規。
7. **需要您決定的事**列在第 7 節，最重要的四件：
   - 「好人持湖者一定說實話」要不要當硬規則（C > B > A 只在這個前提下是定理；真人違反率 0.61%）；
   - R4 只有一紅時「不一定失敗」，所以只否決「必定失敗」的隊；
   - R1–R2「一律正常票」遇到「確定必敗」的隊要不要破例；
   - 派西湖拇指時，有一半會湖到莫甘娜（湖會交到紅方手上）。這是拿掉避開名單的代價，您是否接受。

---

## 1. 新的採用順序（取代「不能變弱」）

### 1.1 三關

| 關卡 | 適用的修改 | 採用條件 | 必附 | 強度怎麼處理 |
|---|---|---|---|---|
| **第一關：邏輯正確** | 消除違反第 2.1 節約束目錄（C、K、P、M、Pe、T 類）的行為或信念；或把程式改成符合 Edward 已裁定的前提（例如派西湖 = 藍方湖、R1 不放拇指） | (a) 回歸測試能重現原本的違規，修正後通過；(b) 不變量工具在重播與自我對打樣本上，這條規則 **0 違規**（扣除第 1.3 節登記的例外） | 測試、不變量、修正前後的違規數 | **量測並回報**（第三關的協定）。如果藍方或紅方立場的 95% 區間整個在 0 以下，就開一張「策略補償」工作單，**不回退邏輯** |
| **第二關：像真人** | 模仿真人行為的模型修改（例如嫁禍的目標排序、似然表） | 一致性基準在 population 和 top/role 上進步，玩家甲、玩家乙 一起回報；沒有任何一列下降超過雜訊；不變量 0 違規 | 一致性前後對照 | 量測並回報；變弱時依 10/13 的先例（「先像真人，再從策略上提高勝率」）照樣採用，另開補償工作。**這一點請 Edward 確認**（第 7 節 D9） |
| **第三關：強度** | 純策略或啟發式的修改（權重、門檻、探索項） | 現行的種子協定：一個選版本種子，再加至少兩個沒用過的確認種子，合併後兩個立場都沒有「區間整個在 0 以下」；不變量 0 違規 | 每個種子的配對差與合併區間 | 這一關才拿強度決定採不採用 |

### 1.2 規則

1. **邏輯修改不和策略修改綁在同一個開關。** 一個開關只做一件事，量到的效果才能歸因。
2. **條件確定的約束要標明條件。** K 類（湖鏈）只在 A0 下確定（A0 = 藍方持湖者說實話；真人違反 15/2444 = 0.61%）。確定性層用 A0 當**硬規則**做否決與不變量；如果 A0 讓一致的世界變成空集合，就退回只用遊戲規則（L0）並記錄。機率層則用 ε ≈ 0.01（X3）。
3. **「被支配」以嚴格支配判定。** 只有在隊上有人「在決策者視角下不是確定藍」時，「含 A 不含 B」才算違規（X4）。
4. **重播輸入的瑕疵要分開記。** 強制提議沒有真的投票（引擎合成全員贊成），另有 2.7% 的非強制提議投票是重建的。所有在真人局面上的計數，都要把「輸入不可信」的決策點分開列。
5. **強度變化要找原因。** 自我對打勝率會反映機器人自己的慣例（例如舊版機器人紅方 R1 從不帶隊友時，「硬3 只看湖後」量到紅方 +0.69pp 的假訊號）。強度下降時，先查是不是這種自打自假象，再設計補償。

### 1.3 登記的例外（不變量照樣計數，但不算違規）

| 例外 | 原因 | 狀態 |
|---|---|---|
| 第 5 次強制提議 | 沒有投票，隊伍一定出任務 | 永久 |
| R1–R2「一律正常票」 | Edward 2026-04-30 的桌規裁定（F18） | 待 Edward 重新確認（第 7 節 D3） |
| 紅方的決勝窗口例外（`mayBreakHardRules`） | 紅方策略，不受藍方邏輯約束 | 永久（只限紅方） |
| 確定性層 L1 為空集合時退回 L0 | A0 在這局被違反（真人好人說謊或紀錄錯） | 永久，逐局記錄 |

---

## 2. Stage 1 — logic fixes (small, high-confidence)

### 2.0 Foundation: the certainty layer (S1-0)

A shared, deterministic module that every Stage-1 item reads. It extracts `buildWorlds` from `GoodLakeInfo.ts:144` and turns it into a 0/1 filter (no likelihoods).

- **File**: new `packages/server/src/ai/belief/Certainty.ts`. `GoodLakeInfo.ts` is refactored to call it, and its lake picks must stay identical on all 1913 lake-legal replays.
- **Parameters** (M8): `playerCount`, `evilCountFor(playerCount)`, fails required per round (10p: 1/1/1/2/1), enabled roles from the lobby (Morgana off ⇒ Percival sees one wizard who is certainly Merlin), and `knownWizards.length`.
- **Inputs (viewer's observation only)**:
  - every mission's `failCount`, including R4 successes that carry a fail card (C2, C5);
  - the viewer's own view: self is good; Merlin's 3 visible reds; Percival's "exactly one thumb is red"; red teammates;
  - the viewer's own lake results (needs S1-9b);
  - public lake declarations. At level L1 these are read under A0 as a hard rule.
- **Outputs**:
  - `worlds(level)` for level ∈ {L0, L1}, plus a flag `l1Empty` that triggers the fallback to L0;
  - `certRed(level)` and `certGood(level)`;
  - `minReds(team, level)` = minimum over consistent worlds of |w ∩ team|;
  - `failsRequired(round)`;
  - `provablyFailable(team)` := `minReds(team, L1*) ≥ failsRequired(round)`, where L1* is L1, or L0 when L1 is empty (X1);
  - `strictlyDominated(team, leader)`: the team holds A but not B, where A declared B blue (with chain closure), and the team holds at least one member who is not `certGood` from the leader's view (X4);
  - `entropyBits(level)` = log2 |worlds|. This is the logic-only uncertainty ledger in `logic_audit.md` §2.6.
- **Cost**: 210 masks × (missions + lakes) filters, a few µs per observation (`belief_engine.md` §3.6: 3.6–4.8 µs per event).
- **Tests**: property tests over random histories:
  - every kept world satisfies C2;
  - C4/C6 deductions;
  - K1/K3 ordering under any belief supported on L1 worlds;
  - P1, P2, P3, M2, Pe1/Pe2;
  - 5/7/9-player parameterisation;
  - Morgana-off.
  - The GoodLakeInfo identical-pick regression.

S1-0 changes no behaviour by itself. It ships together with the invariant harness (§5), and the harness's first run must reproduce the audit's baseline violation counts. That run validates the harness.

### 2.1 Stage 1 list

"Replay" counts are the bot's decisions at human decision points (1970 games, production `DEFAULT_AGENT_TUNING`). "Target" is the harness count after the fix. All items are tier 1. Items S1-7 and S1-8 implement owner rulings, not theorems.

| ID | Violation (constraint) | Files (main @ 52ae020) | Tests | Invariant (harness ID) | Expected effect |
|---|---|---|---|---|---|
| **S1-0** | Foundation: facts are not computed anywhere except `GoodLakeInfo` | new `src/ai/belief/Certainty.ts`; `GoodLakeInfo.ts:144-184` | property tests listed in §2.0; identical lake picks | INV-W1 (kept worlds satisfy C2); INV-W2 (L1-empty fallbacks are logged) | No behaviour change. The harness baseline must match `logic_audit.md` §5 |
| **S1-1** | Certain facts do not reach beliefs: no failCount use, no "I am good", no own-lake fact, no accuser fact, R4 success-with-fail-card treated as clean (C2, C4, C5, C6, P1, P2, P3, M2, Pe1; F3, F10, F11) | `baseline/pyramidScorer.ts:76-104` (layer 1 pins: L0 facts to 1.0 / 0.0, L1-only facts to 1−ε / ε with ε = 0.01); `pyramidScorer.ts:115-129` and `baseline/suspectInference.ts:44-53` (use `failCount` with C2 counting instead of +0.15 per member of a failed team); `LakePolicy.ts:819-821` (a success is not exculpatory when `failCount > 0`); `TeamReuse.ts:198-200` (reference team requires `failCount === 0`) | Fixtures from the audit (§3 F3): seat 2 on a 3-player R1 team with 2 fails ⇒ the other two are pinned red; Merlin case M2; R4 success with 1 fail card | INV-B2: `certRed` ⇒ score ≥ 1−ε, `certGood` ⇒ score ≤ ε; INV-B3: `result` is never read without `failCount` | Certain reds scored < 0.85: 51–63% → 0. Certain goods scored ≥ 0.85 (R4/R5): 15–18% → 0. Own lake-blue scored ≥ 0.85: 515/2873 → 0. Approvals of a team holding one's accuser: 20/143 → 0 (when the team is provably failable). R5 reuse of an R4 team that succeeded with a fail card: 6/55 → 0 (humans 0/55) |
| **S1-2** | 硬3 counts pre-lake teams (T1, T3; F1). Clause (b) is unrelated to the vouch (F2). TeamReuse treats any rule-3 key as certain red (F14) | `baseline/lakeChainTracker.ts:277-316`: always cut at the declaration round (the diagnostic `postLakeOnly` path becomes the only path); trigger = after the lake, A leads a team without B **and** the team holds someone A cannot be certain is good (no "A on team" condition, X2); delete clause (b) at `294-304`. `pyramidScorer.ts:151-157`: replace the 0.85 floor with an odds update by LR (6 = lower 95% bound; 18 = point estimate; X5). `TeamReuse.ts:295-308`: `goodLeaderRedSet` = `certRed` only | Metamorphic: adding or removing any pre-lake leader record leaves the score unchanged. Post-lake omission triggers. Merlin holder whose whole team is certain-good does not trigger | INV-H3a (pre-lake records have no effect); INV-H3b (honest blue holders are flagged only by post-lake omissions) | Honest blue holders flagged ≥ 0.85 at R4/R5 opening: 46.5% / 62.1% → about 0.8% (post-lake omissions only). Counterfactual on R3+ good-leader teams: 949/6648 change, and the actual reds on the changed teams fall 1126 → 704 (−37%). **Must ship together with S1-3** (M12: alone, it raises A→B ordering inversions from 40.5% to 63.9%) |
| **S1-3** | Lake-chain ordering and closure are not enforced: the pyramid inverts A→B; production R3+ teams ignore 硬1 and 硬2 (K1, K1′, K2, K3, K4, K5; F4, F5) | Beliefs: `pyramidScorer.ts:137-247`, projection after the layers: suspicion(C) ≤ suspicion(B) ≤ suspicion(A) along declared-blue chains; s(A) + s(B) ≥ 1 for declared-red pairs; K5 reversals come from `certRed`. Teams: `lakeChainTracker.findTeamHardRuleViolations` (`234-256`) gains chain closure and the strict-dominance filter; `forward/ForwardAgent.ts` `generateTeamSelectCandidates` and `buildTeamSignals` (`violatesLakeRules: false` at `1966`, `1996`) drop violating candidates whenever a compliant one exists; `HeuristicAgent.fixupTeamHardRules` (`1142-1227`) uses the same function | Chain A→B→C fixtures: any good-leader team with A also has B and C (when strictly dominated). Random-belief property test of the projection. K2 pair on a non-R4 team ⇒ provably failable | INV-K1 (no good leader proposes a strictly dominated team, applied recursively, which covers K3); INV-B1 (score ordering along the chain) | Production R3+ teams violating 硬1 / 硬2: 158 / 29 → 0 (strict-dominance subset; humans 59 / 22). First-proposal teams with A but not B: 819/12684 (6.5%) → 0. Pyramid A→B inversions: 33.1% → 0 |
| **S1-4** | Good leaders propose, and good voters approve, teams that must fail (C2, C4, C6, P1, P2, K2; F5 vote part, F9). Corrected per X1: veto only when minReds ≥ fails required, so R4 with one certain red goes to the probability layer | `ForwardAgent.ts` candidate generation (drop `provablyFailable` candidates when an alternative exists; one always exists, because the true all-good team is never provably failable at L0); vote path `ForwardAgent.ts:690-822`; `HeuristicAgent.ts:1643-1659` and `1736-1738` (R1–R2 policy, see D3); `GoodLakeFollowUp.ts:66-70, 176`: when on the team, veto only for "my own declared red is on the team" in rounds needing 1 fail (P2) | Fixtures: P1 (my failed mission), K2 pair, own declared red on the team in R2 vs R4, forced 5th attempt exempt | INV-T1 (good leader never proposes a provably failable team); INV-V1 (good voter on a non-forced proposal never approves one; R1–R2 counted under the exemption until D3) | Leader proposals that must fail: 1685/22976 (7.3%) → 0 (human loyals 0.06%). R3+ voter approvals of must-fail teams → 0 (humans 16.4% on reliable votes). On-team approvals with own declared red: 20/47 → 0 for rounds needing 1 fail (to be re-split by round) |
| **S1-5** | (Merged into S1-1 and S1-4: accuser pinned red, P3, F10.) Kept as an ID so the harness can count it separately | — | Accuser fixture | INV-P3 (good never approves a non-forced, non-R4 team holding their accuser) | 20/143 → 0 |
| **S1-6** | Percival treats probabilities as certain and ignores certainties (Pe1, Pe2, C2, C3; F6 with X1, F7, F8). "Percival = loyal + one-red-thumb" | `HeuristicAgent.ts:1778-1786`: remove "no thumb on team ⇒ reject". Before `1785` ("Percival on team ⇒ approve"), add "both thumbs on the team and fails required = 1 ⇒ reject" (non-forced; R1–R2 per D3; R4 goes to the probability layer). `RoleStrategy.ts:403-465`: make the implementation match the comment. `ForwardAgent.ts:741-774` delegation. `ForwardAgent.inferRedsFromTaskFails` (`198-222`, used at `1229`, `1311-1314`) → `certRed` only. "鐵咬" (`ForwardAgent.ts:1275-1302`): hard-exclude a thumb only when it is `certRed` (for example the other thumb is certain good); never break ties by seat order; otherwise use a soft ranking | Two-thumb team in R3 and in R4. No-thumb team that is all-blue. Thumb tie. Failed-mission attribution that is not certain | INV-Pe1 (non-forced, non-R4 R3+: Percival never approves a team holding both thumbs); INV-Pe2 (Percival never hard-excludes a player who is not `certRed`) | Non-R4 two-thumb approvals: 109/120 → 0. No-thumb automatic rejections: 1392/1392 (387 of those teams all-blue) → decided by general logic. Non-certain hard exclusions: 3715 → 0, including Merlin excluded 356 → 0. 鐵咬 excluding Merlin: 1178/2827 (41.7%) → certain cases only |
| **S1-7** | **Owner ruling 10/14**: with no information, Percival sends no thumbs | Land `lane/r6-percival` @ `7c005d7` (`PercivalThumbs.ts`, `AgentTuning.percivalNoThumbsR1`, `ForwardAgent.ts`, `RoleStrategy.ts`, `HeuristicAgent.ts`, `explain.ts`). Fix the gate at `PercivalThumbs.ts:77` from `knownWizards.length > 0` to `=== 2`: a lone wizard is certain Merlin (Morgana off) | Existing `PercivalThumbs.test.ts`, plus the one-wizard case and the `GameServer` bot path (followups gaps) | INV-R1NT (10p, two wizards, Percival captain before any mission result ⇒ no thumb on the team) | Already measured: thumb-set agreement 40.4% → 58.4%; strength over 3 seeds +0.01pp [−0.31, +0.32]; the descriptive 10-seat run −0.70pp (report). Open items D5 (thumb-includes-thumb exception) and 6–9 players |
| **S1-8** | **Owner ruling 10/14**: Percival's lake is a blue lake. The avoid list wrongly treats the thumbs as "wasted" lakes | `LakePolicy.ts:183-185`: the good avoid set becomes `knownEvils` only (drop `knownWizards`); Percival's target comes from `GoodLakeInfo` with the holder belief "loyal + exactly one thumb red" (already at `GoodLakeInfo.ts:161, 179-180`). Needs S1-9b so a thumb lake's private result is kept (afterwards Percival knows both thumbs) | Percival whose best-EIG target is a thumb picks it. Percival's ranking equals a loyal's ranking with the thumb constraint added. After a thumb lake, the certainty layer pins Merlin good and Morgana red for Percival | INV-PL (Percival's lake candidate set equals a loyal's; structural) | From the critique (M3): thumbs picked 86/393 (21.9%; humans 21.8%); the thumb picked is Merlin only 51% (humans 82.6%); top-1 target agreement 98 → 88/394. Report strength. Risk: about half of thumb lakes pass the lake to Morgana (D4) |
| **S1-9** | Information-flow plumbing (T1, T4). (a) Forced 5th-proposal votes are synthetic yet read as "outer-white" evidence (M1): a forced action carries 0 bits. (b) The holder's private lake result is not in the observation (P2). (c) Undeclared lakes are dropped (M2) | (a) Exclude `attempt ≥ 5` records in `baseline/voteInferer.ts` (`scoreFromVotePattern`), `HeuristicAgent.ts:974-1003` (memory), `RoleStrategy.scoreWizardAsMerlin`, `forward/ToMReverseEngine.ts` / `InterpretationModule.ts` (`AssassinModel.ts:71` already does this). (b) `myLakeResults` in `types.ts:13-41` `PlayerObservation`, filled for the holder only in `GameServer.ts:1938-1948`, `SelfPlayEngine.ts`, `benchmark/replayObservation.ts:16-17`. (c) `declaredClaim: 'good' \| 'evil' \| 'none'` (`types.ts:39`; remove the replay filter `claim !== null`); plumbing only, the likelihood is used in Stage 3 | Metamorphic: flipping any forced-vote record changes no score. `myLakeResults` is visible only to its holder (privacy test). A 'none' record round-trips | INV-F0 (forced votes have no effect); INV-OBS (no private field leaks to other seats) | Removes about 14.9 fake outer-white records per game (forced proposals are 15.4% of proposals but about 60% of mission teams, 4469/7444). (a) changes beliefs, so it ships in the same batch as S1-1 to S1-3 |
| **S1-10** | Red declarations that cannot be true (C8, K5; `framing_study.md` §8.1). A red holder must never make a claim for which no L0 + trusted-A0 world has "holder good and claim true". When such a claim is made anyway, blues pin the holder red (automatic through L1) | `LakePolicy.ts` red branch (`decideEvilLakeClaimHuman`, `decideLakeClaimForTeam`): if the chosen claim is impossible, use the other claim | Framing a publicly certain-good target; vouching for a publicly certain-red target | INV-R1 (no impossible red declaration); INV-R2 (after an impossible declaration, every blue has the holder in `certRed`) | Bot 1/220 → 0 (humans 1/197). Vouching for a publicly certain red is already 0; it becomes guarded |
| **S1-11** | Defensive guards and dead code (F12, F13, F16) | Good `quest_vote` ⇒ `success` at the top of `ForwardAgent.decide`, and a faction check on the bot path at `GameServer.ts:2180-2200` (the human path at `1101-1107` already has one). Delete the lake-chain cycle detection at `lakeChainTracker.ts:105-137`: it cannot fire under the path rule C7 (0/1970), and its 3-step rule is wrong. Legacy assassin heuristic visibility at `HeuristicAgent.ts:2690-2770` (fallback only): Merlin sees {assassin, Oberon} plus exactly one of the two teammates. The `AssassinModel` `visibleEvil` feature fix needs retraining, so it moves to Stage 2 (tier 3) | Good bot asked for a quest card ⇒ success; removing the cycle code changes no replay decision | INV-Q1 (good never plays fail; currently 0/22995); INV-A1 (the assassin never targets a known red; currently 0/1048) | No measurable behaviour change except the fallback path |

### 2.2 Batches and order (coupling matters)

| Batch | Items | Why together |
|---|---|---|
| 1A | Land `lane/r6-percival` (S1-7 with the gate fix) | It already touches `ForwardAgent.ts`, `RoleStrategy.ts` and `HeuristicAgent.ts`. Landing it first avoids conflicts |
| 1B | S1-0 + harness (§5) + S1-9b, S1-9c (plumbing) + S1-11 | No behaviour change except the guards. The harness baseline is recorded here |
| 1C | S1-1 + S1-2 + S1-3 (beliefs) + S1-9a | M12: 硬3 after-lake alone makes the ordering worse, and removing the forced votes shifts the same scores. One belief batch, measured once |
| 1D | S1-3 (team gate) + S1-4 + S1-5 | Decision gates on top of corrected beliefs |
| 1E | S1-6 + S1-8 | Percival = loyal + thumb constraint, in both team logic and lake logic |
| 1F | S1-10 | Red-side logic veto |

Each batch is behind its own `AgentTuning` flag (default on once accepted; legacy off). It reports, in this order:
1. harness counts before and after;
2. the agreement benchmark (population, top/role, 玩家甲, 玩家乙);
3. self-play on 3 fresh seeds, both stances, pooled.

Strength is reported, never used to revert. If a stance's pooled interval is entirely below 0, a tier-3 "compensation" item is opened.

### 2.3 Deliberately not in Stage 1 (probabilistic; Stage 2 or 3)

- R4 teams with exactly one certain red: P(≥ 2 reds) from the probability layer.
- "Success ⇒ all good" when reds need one more win: near-hard (1.4% exceptions), so it is a likelihood, not a rule.
- The size of the post-lake 硬3 signal beyond the conservative LR, and the 硬3 mirror for red declarations (M11, LR about 4.7, small n).
- Reading undeclared lakes (LR about 18), and using f/s for red declarations in `GoodLakeInfo` (instead of ½).
- Which thumb is Merlin (a role-level posterior; it replaces the hindsight-based `scoreWizardAsMerlin`).
- Retraining the `AssassinModel` feature.

---

## 3. Stage 2 — framing (抹黑／嫁禍) by the owner's categories, with an entropy-based exposure check

### 3.1 Definitions (all computed at the moment of the lake, from information available then; T4)

- **Π (the red's model of the blue common picture)**: 210 worlds.
  - L0 facts (C2, C5, C6).
  - Earlier lake declarations: A0 if the holder is good; for a red holder, P("red" | T blue) = f and P("red" | T red) = s.
  - Mission-card likelihood from human data, cross-fitted and keyed by score state (`belief_engine.md` EMP).
  - The holder is **not** assumed good.
- q_H = Π(H red), the holder's public red probability before the claim; q_H′ after claiming "T is red".
- **Credibility** p_T = Π(T red | H good): how plausible the claim is if H were an honest blue.
- **Update**: odds(q_H′) = odds(q_H) × [f · P(T blue | H red) + s · P(T red | H red)] / P(T red | H good). With f = 0.259 and s = 0.171 from human data, framing raises q_H exactly when p_T < **p\* = f / (1 + f − s) ≈ 0.238**. Measured on 7009 candidates: 100% below 0.20, 12.9% at 0.24–0.28, 0% at ≥ 0.30.
- **Owner categories** (only targets that are actually blue; the red holder knows camps except Oberon):
  - (a) **mission-intersection with suspicion**: `a_fail(T)` = T was on at least one failed mission. Secondary features: `a_m2` (two or more missions) and `a_shared` (shared a failed mission with H). Human data shows a_fail is the driver (1.35×), and within a_fail neither mission count nor sharing adds anything.
  - (b) **gray zone**: `gray(T)` = 0.40 ≤ p_T ≤ 0.60. Credibility, not the raw public red probability. Human framings peak at 0.45–0.60 (35.0% vs 25.3% by chance).
  - (c) **Merlin suspect**: `mSus(T)` = P(T = Merlin | red's view). In Stage 2 the proxy is `c_priv` (T avoided teams holding the holder's known reds). Stage 3 replaces it with the role-level posterior.

### 3.2 Entropy terms (bits)

| Term | Definition | Meaning (owner's words) |
|---|---|---|
| **Exposure** E(T) | [h(q_H) − h(q_H′)] · 𝟙(q_H′ > q_H), with h the binary entropy | "A lake that sharply cuts the uncertainty, so the table can conclude you are red": the uncertainty about the holder's own camp collapses **toward red**. The critique asks Edward to confirm this reading (D6) |
| **Misdirection** D(T) | −E_Oberon[log2 Π′(R\*) − log2 Π(R\*)], with R\* the true red set as the red knows it (averaged over Oberon's seat when Oberon is unknown) | Positive = pushes the blue picture **away** from the truth. Human framings average +0.30 bits; framings of clean targets −0.28 (they help blues) |
| **Chain discount** C(T) | Π′(T red) − Π(T red), if a lake remains after this one | T becomes the next holder; an honest lake from a now-distrusted T is discounted |
| **Merlin leak** L_M(T) | Holder is Mordred and T is not visible to Merlin ⇒ Merlin learns Mordred ∈ {H, T}: log2(n_M / 2) bits, where n_M is Merlin's current count of Mordred candidates; if T is Merlin herself, log2(n_M) (full reveal). Zero for assassin, Morgana and Oberon holders | M4: framing by Mordred tells Merlin something new |
| **Private leak** L_T | h(P_T(H red)) before vs 0 after (T knows the claim is false) | About 0.94 bits on average; 0.49 when T is Merlin and already sees H. Nearly constant across targets, so it is recorded but given low weight |

### 3.3 Scoring formula

Hard veto (tier 1, already S1-10): impossible claim (E_certain). Exposure vetoes (tier 2 default; data-backed):
- p_T < p\*(f, s): the claim raises q_H;
- q_H < 0.8 ≤ q_H′: the claim alone makes the holder look red.

For legal blue targets T that pass the vetoes:

**Score_frame(T) = P(T blue | holder view) · [ w_a·a_fail(T) + w_b·gray(T) + w_c·mSus(T) + w_D·D(T) + w_C·C(T) ] − λ_E·E(T) − λ_M·L_M(T)**

- **Truth alternative**: Score_truth(T) uses the same terms for the claim "T is blue". Its D and E are usually small or negative: vouching for a blue lowers q_H.
- **Who to lake (before the camp is seen)**: keep Edward's 10/13 teammate-first rule (`evilLakeHumanStrategy`). The score applies when the red holder lakes a blue and decides between framing and telling the truth, and it ranks blue targets by E[max(Score_frame, Score_truth)].
- **Frequency is a mixed strategy**: frame iff Score_frame − Score_truth > θ, with θ calibrated so that the overall framing rate among blue-target declarations stays near human f ≈ 0.26 on replay states. Use a seeded PRNG for ties. f is an equilibrium quantity: if bots frame more, p\* rises (f = 0.5 ⇒ p\* ≈ 0.38).
- **Starting weights**: fit w_a, w_b, w_c by conditional logit on the 197 human framings against the legal blue alternatives, cross-fitted by game parity. Expect w_c ≈ 0 (no human preference: c_pub 0.91×, c_priv 0.95× within non-a_fail; the outcome of framing the real Merlin is +1.4pp [−15.7, +18.6], n = 26). λ_E and λ_M start at 1 bit = 1 unit and are later set by the Stage 3 value table (M5).

### 3.4 Blue-side counterpart (tier 2, same stage)

- `GoodLakeInfo.buildWorlds` uses the red-claim likelihood f/s instead of ½. Using ½ puts the "raises q_H" threshold at p_T = 0.5 instead of 0.24, which overstates a framer's suspicion.
- `pyramidScorer` layer 3 updates q_H and P(T red) from every red claim using the same Π: below p\* the holder becomes more suspicious, above p\* T becomes more suspicious.
- Trust in T's next (honest) lake = P(T good), not "a wasted lake".

### 3.5 Data and calibration

- 761 human red-holder → blue declarations (197 framings), 1235 red holder states, f/s from the same data (cross-fit by parity, as `belief_engine.md` does).
- New splits required by the critique:
  - by holder role: Mordred / assassin+Morgana / Oberon (M4);
  - the declaration test as the main evidence (framing rate 30.9% for a_fail targets vs 19.3% for others) rather than the selection test (truth-telling red lakes also lean to (a), at 1.21×).
- Mordred's Merlin leak counted from the role assignment.

### 3.6 Measurements and acceptance

1. **Tier 1 (harness)**:
   - E_certain = 0;
   - share of bot framings with p_T < p\* = 0;
   - share with q_H jumping past 0.8 = 0.
2. **Tier 2 (human-likeness on the 1235 replay states)**:

   | Measure | Human | Bot now (`humanRate`) |
   |---|---|---|
   | Framing rate per state | 16.0% | 5.1% |
   | Targets with a_fail | 67.5% | 75% |
   | p_T distribution | 35.0% in 0.45–0.60 | not measured |
   | Exposure caused by the claim | 1.5% | 2.4% |

   Agreement-benchmark red lake target and claim rows (population, top/role, 玩家甲, 玩家乙) are reported alongside.
3. **Tier 3 (strength)**: seed protocol on the red stance; on the blue stance when §3.4 ships.
4. **Diagnostics**:
   - mean E, D, C, L_M by category and by holder role;
   - afterwards, how often blue captains include the framer (human ratio 0.25) and T (0.96).

---

## 4. Stage 3 — belief engine (time-ordered recursive updates and entropy scoring)

### 4.1 Architecture (`belief_engine.md` §3, with the critique's corrections)

- **Module**: `packages/server/src/ai/belief/BeliefEngine.ts`, pure and deterministic. It extends S1-0 (Certainty is its level-0 filter).
- **World levels**:
  - **Camp level**: W₀ = 210 red sets (10-bit masks), always maintained.
  - **Role level**: 720 role assignments per red set (151,200 in total), expanded only for the red sets covering 99% of the mass (typically 20–40k assignments), or fully at assassination time.
- **One public belief per room**: β_t(w) ∝ prior(w) · Π_{s≤t} L_s(w), maintained by the server once per event.
- **Seat belief** = β_t × the seat's private hard constraints (Certainty), renormalised. Ten bots share one public belief. This is the code form of "everything from the blue perspective": blue view = public belief × my constraints. Percival = loyal + thumb constraint (owner (1)).
- **Layers**:
  - **L0, hard**: H1 (C2), the viewer's own view, own lake result, path rule (C7).
  - **A0, near-hard**: ε = 0.01 in the probability layer, hard in Certainty (X3).
  - **Soft likelihoods** (level-1 tables from the 1970 games, cross-fitted, tempered τ = ½):
    - mission cards by (round, reds on team, score state);
    - lake claims by (holder camp, target camp), including 'none' (S1-9c);
    - proposals: P(other reds k | leader camp, round, attempt, leader on team) / #teams with that k;
    - votes: P(approve | voter camp, on team, other reds on team, round), **excluding forced attempts** (M1) and with the R1–R2 normal-vote convention as a separate key.

### 4.2 Time order and recursion (owner (4))

- **Belief half** (public belief state; Nayyar–Mahajan–Teneketzis 2013, BAD 2019, ReBeL 2020):
  **β_{t+1}(w) ∝ β_t(w) · π_i(a_t | s_i^t(w), β_t)**
  - s_i^t(w) is actor i's information set at event t in world w: their role view in w plus the public history cut at t. The cut reuses `replayObservation.cutFor`.
  - Before a lake, s_i^t holds no lake result, so the 硬3 factor is identically 1 there. The time-order error of F1 becomes structurally impossible.
  - π_i depends on β_t, and β_t was produced from β_{t−1} and π_{t−1}. So "t2 reads t1, including t1's reading of t0" is literal.
  - Reinterpretation comes for free: an R1 vote's likelihood differs by world, so when R3 proves X red, that vote's meaning changes with no special-case code.
- **Levels**:
  - level-0 = Certainty only;
  - level-1 = the human tables;
  - level-2 = π as a logit on features computed from i's own level-1 belief at t (for example, a good voter uses "P(team all good) in my view at t"; a red voter uses "how much does this vote move the public P(I am red)"). Stop at level-2 (humans ≈ 1.5–2 levels).
- **Fixed point (M10, two kinds kept apart)**:
  - **Descriptive (primary)**: EM-style alternation (fit π on β features, re-run β) until the coefficients stabilise. This is "consistent with humans".
  - **Strategic (guard rail only)**: self-play fictitious play. It absorbs bot conventions (example: the +0.69pp artefact), so it is never the target.
- **Value half** (M5; the Bellman equation proper, V(b) = max_a E[r + V(b′)]):
  - a small value table V(score, attempt, leader position, bucket of P(best team clean), bucket of the reds' Merlin entropy), fitted on human and self-play outcomes;
  - decisions use a one-step lookahead: candidate × possible fail counts → b′ → V. That is about 126 × 6 × 210 operations, negligible.
  - Information value = E[V(b′)] − V(b) (Howard's VOI). It replaces the hand-set λ, κ, μ, ν, so "explore early, exploit late" emerges from the table.

### 4.3 Entropy scoring per decision

- **Uncertainty measure**: joint entropy H(β) = −Σ_w β(w) log2 β(w). It replaces the Σ of per-player binary entropies in `GoodLakeInfo`, which overstates by about 2 bits at the uniform prior (9.71 vs 7.71).

| Decision | Score |
|---|---|
| Blue proposal | V-lookahead(team) + information term = I(R; fail count \| team) **plus I(R; votes \| proposal) for proposals that may be rejected** (M6; measured 0.14–0.39 bits per proposal+vote). Candidates must pass the Stage-1 gates |
| Blue vote | Approve ⇔ E[V \| pass] > E[V \| reject], including who leads next and the forced 5th. Must-fail ⇒ reject (Stage 1) |
| Blue lake (incl. Percival) | `GoodLakeInfo` with joint entropy: EIG of the common picture + trust-chain term, with the holder belief carrying the role constraints. Percival thumb lakes get a two-sided score: private gain (both thumbs resolved, ≥ 1 bit) vs the reds' drop in Merlin entropy |
| Merlin | V_blue(a) − κ·[H_red(M) − H_red(M \| a)], where H_red(M) is the Merlin-identity entropy in the reds' view (role level) |
| Red proposal, vote, quest card | ΔP(red win) − μ·[H(C_t) − H(C_{t+1})] − ν·[P_C(me red \| a) − P_C(me red)]. Quest-card leakage: two fails on a 3-player team leak 1.59 bits, one fail leaks 0.26 |
| Red lake | Stage 2 formula, now on engine quantities; mSus becomes the role-level P(T = Merlin) |
| Assassin | argmax_j P(Merlin = j \| history, red private info), with per-action Merlin-vs-loyal likelihood ratios computed at the actor's information set at that time (no hindsight) |

### 4.4 Migration (ForwardAgent stays usable at every step)

| Milestone | Content | Behaviour change | Exit criterion |
|---|---|---|---|
| M0 | `BeliefEngine` in **shadow mode**: computed and logged next to the pyramid; `explain.ts` shows it in the post-game review | None | Replay calibration: surprise ≈ entropy within 1 bit after tempering; top-4 hit ≥ 2.39 (EMP); harness 0 |
| M1 | `GoodLakeInfo` internals switched to the engine (identical picks first; then joint entropy and ε-A0 as separate flags) | Lake targets only | Identical-pick test, then tier 2/3 for the joint-entropy flag |
| M2 | Engine as ForwardAgent's belief source: candidate ranking by P(all good), team signals by P(all good) instead of average suspicion; votes likewise. Role biases and delegation kept | Teams, votes | Static replay: clean-team pick ≥ 39% (EMP; bot now 28.7%); agreement; strength reported |
| M3 | Information terms: proposal EIG including vote information, red card leakage, red framing on engine quantities (Stage 2 port) | Teams, cards, red lake | Tier 3 per term |
| M4 | Level-2 likelihoods (EM fit offline) and role level: assassin, Percival thumb identification (replaces `scoreWizardAsMerlin`), Merlin exposure | All roles | Tier 2, then tier 3 |
| M5 | Value table and one-step lookahead replacing hand-set weights | Weights | Tier 3 |

The pyramid is kept for explanations (`explain.ts`) until M2 has run for a full cycle.

### 4.5 Compute budget

| Item | Measured or estimated | Budget decision |
|---|---|---|
| Public update, camp level, hard + lake + missions | 3.6–4.8 µs per event (measured) | Online, incremental |
| With proposal and 10-vote likelihoods | about 71 µs per event (measured) | Online |
| Proposal scoring: P(all good) + EIG over ≤ 126 teams × 210 worlds × ≤ 6 fail counts | 0.2–0.5 ms | Online |
| Pass-probability prediction (level-2, 10 votes) | 0.3–1 ms | Online |
| Role level | 0.63–0.91 ms per event for a full 151,200; about 0.1 ms per event for the top-K sets; assassination recomputed from scratch 30–40 ms | Online, top-K; full at assassination |
| Level-2 **proposal** likelihood | about 10⁷ ops per event, 10–50 ms in TypeScript (critique: about 100× the literature estimate) | Only with incremental caches and closed-form features (for example "gap between this team's P(all good) and the best team's"). **Never call ForwardAgent inside a likelihood** (≈ 2.5 s per event) |
| SPARTA-style rollouts | about 140 s per decision (35 ms per game) | Offline diagnostics only |
| EM fit of level-2 | about 10⁹ ops, minutes | Offline script |
| Current ForwardAgent decision | about 1.2 ms | Reference |

- **Online target**: p95 ≤ 5 ms per bot decision.
- **Self-play impact**: about 35 ms per game today, an estimated 80–120 ms per game with the engine. 15,000 games per seed rises from about 9 minutes to about 25–30 minutes, so the seed protocol triples in wall time (D12).

### 4.6 Measurements per milestone

1. Harness 0 violations.
2. Information quality on replay, cross-fitted:
   - entropy trajectory;
   - surprise − entropy gap (calibration);
   - Brier score;
   - top-4 red hit;
   - static clean-team rate;
   - the share of games whose true red set is excluded must stay ≈ 0 (the FACE lesson: low entropy ≠ correct).
3. Agreement benchmark.
4. Strength by the seed protocol, reported for tier-1 milestones and deciding for tier-3 ones.

---

## 5. Invariant harness

### 5.1 Purpose

Run many self-play games and human replays. At every bot decision, check the decision against the catalog of absolute constraints, using only the deciding seat's observation (no hidden info). Count opportunities, exemptions and violations per rule. Ground truth is used only for diagnostic columns (for example "actual reds on teams the fix changed").

### 5.2 Components

| Component | File | Role |
|---|---|---|
| Catalog | `packages/server/src/ai/invariants/catalog.ts` | One entry per invariant: `{ id, constraintRefs: ['C2','K1',…], phase, appliesTo(obs, action), exemption(obs) → reason \| null, violated(ctx) → boolean, kind: 'hard' \| 'policy' \| 'metamorphic' }` |
| Context | `invariants/context.ts` | Builds the Certainty view (L0/L1 and fallback flag) for the deciding seat's observation; cached per (game, event) |
| Decision capture | `invariants/AuditAgent.ts` | Wraps any `AvalonAgent` (same pattern as `SwitchAgent` in `scripts/selfPlayStrength.ts`); records `(obs, action, meta)`. Lake target and claim go through `LakePolicy.pickLakeTargetForTeam` and `decideLakeClaimForTeam` in `SelfPlayEngine`, so the wrapper hooks those too (`hasLakeApi`) |
| Self-play source | `SelfPlayEngine` with production `DEFAULT_AGENT_TUNING`, fixed seeds, 10 players; plus 5/7/9-player smoke runs once S1-0 is parameterised (M8) | Bot vs bot |
| Replay source | `benchmark/replayObservation.buildReplayObservation` at every human decision point of `sheets_cache.json`; the bot decides there. The **human's** actual decision is checked too, as a reference column. Decision points with reconstructed or synthetic votes are flagged "unreliable input" | Bot on human states |
| Metamorphic checks | Same module | INV-H3a: insert or remove a pre-lake leader record ⇒ the score is unchanged. INV-F0: flip forced-vote records ⇒ no score changes. INV-OBS: no seat's observation contains another seat's private fields |
| CLI | `packages/server/scripts/invariantHarness.ts` (`--selfplay N --seed S --replays all\|N --flag …`) | Prints one table: rule, opportunities, exempt (by reason), bot violations, human violations (replay), L1-empty fallbacks. Aggregates only, no names, no seat-to-person mapping |
| CI test | `packages/server/src/ai/invariants/invariants.ci.test.ts` (vitest) | 30 self-play games (3 fixed seeds) and 60 fixed replay games. Asserts 0 violations for every `hard` rule and that `policy` exemption counts are reported. Runtime target < 60 s (self-play about 35 ms per game; a replay decision about 1–2 ms) |
| Workflow | No new workflow needed: the existing `.github/workflows/test.yml` already runs `pnpm --filter @avalon/server test` (vitest) on pushes to main/develop/`claude/**` and on PRs, so the CI test file is picked up automatically. The 60 s budget keeps the job short | Locally: `pnpm --filter @avalon/server exec vitest run src/ai/invariants` |
| Full run | Every Stage-1 batch: all 1970 replays + 2000 self-play games (about 5 minutes); numbers recorded in a new `docs/ai/invariants.md` | Release evidence |

### 5.3 Initial catalog

Constraint IDs are from `logic_audit.md` §2. "Now" values are replay numbers from the audit, used to validate the harness baseline.

| ID | Rule (bot, good side unless stated) | Refs | Kind | Now |
|---|---|---|---|---|
| INV-W1 | Every world kept by Certainty satisfies every mission's fail count | C2, C5 | hard | (new code) |
| INV-W2 | L1-empty fallback is logged per game | X3 | policy | about 0.8% of games |
| INV-Q1 | Good never plays a fail card | rule | hard | 0/22995 |
| INV-T1 | Good leader never proposes a provably failable team | C2, C4, C6, P1, P2, K2 | hard | 1685/22976 first proposals |
| INV-V1 | Good voter never approves a provably failable team on a non-forced proposal | same | hard (R1–R2 = policy until D3) | R3+ non-forced, see S1-4 |
| INV-K1 | Good leader never proposes a strictly dominated team (A in, B out, someone not certain-good to the leader), applied recursively along chains | K1′, K3 | hard | 158 (硬1) R3+ |
| INV-K2 | Good leader never proposes a team holding both members of a declared-red pair when one fail suffices | K2 | hard (subsumed by T1) | 29 |
| INV-B1 | Suspicion order along declared-blue chains: s(C) ≤ s(B) ≤ s(A), unless K5 reverses it | K1, K3, K5 | hard | 33.1% inversions |
| INV-B2 | `certRed` ⇒ score ≥ 1−ε; `certGood` ⇒ score ≤ ε | C/P/M/Pe | hard | 51–63% / 15–18% |
| INV-B3 | No belief code reads `result` without `failCount` | C5 | hard (static check + R4 fixture) | 219/1177 R4 missions are "success with a fail card" |
| INV-H3a | Pre-lake leader records do not change the rule-3 score | T1, T3 | metamorphic | violated now |
| INV-H3b | Honest blue holders flagged only by post-lake strictly-dominated omissions | T1, X2 | hard | 46.5% / 62.1% R4/R5 |
| INV-F0 | Forced-proposal votes change no belief | T4, M1 | metamorphic | violated now |
| INV-P3 | Good never approves a non-forced team holding their accuser when one fail suffices | P3 | hard | 20/143 |
| INV-L1 | Good holder never approves a non-forced team holding their own declared red when one fail suffices | P2 | hard | 20/47 (re-split) |
| INV-Pe1 | Percival never approves a non-forced R3+ team holding both thumbs when one fail suffices | Pe1 | hard (R1–R2 policy) | 109/120 |
| INV-Pe2 | Percival never hard-excludes a player who is not `certRed` | Pe1, C3 | hard | 3715 + 鐵咬 |
| INV-R1NT | 10p Percival captain, two wizards, no mission result yet ⇒ no thumb on the team | owner 10/14 | hard (owner rule) | 0 with `7c005d7` |
| INV-PL | Percival's lake candidate set = a loyal's; scoring = loyal + thumb constraint | owner 10/14 | hard (structural) | thumbs always excluded now |
| INV-M1 | Merlin never proposes or approves (R3+) a team holding a visible red | M1 | hard | 0 |
| INV-A1 | The assassin never targets a known red | A1 | hard | 0/1048 |
| INV-R1 | A red holder never makes an impossible declaration | C8, K5 | hard (red) | 1/220 |
| INV-R2 | After an impossible declaration, every blue has the holder in `certRed` | K5 | hard | (new) |
| INV-OBS | No private field (role view, `myLakeResults`) leaks to another seat | T1 | metamorphic | (new) |

New invariants are added whenever Stage 2 or 3 introduces a new certainty, for example the Stage-2 vetoes "share of bot framings with p_T < p\* = 0" and "q_H jump past 0.8 = 0" (both tier-2 defaults, enforced once adopted).

---

## 6. 風險

1. **修正之間互相牽動。** 硬3 只看湖後如果單獨上線，湖鏈排序的反轉會從 40.5% 升到 63.9%，因為湖前的旗標原本碰巧把持湖者往上推。所以第 1C 批要整批一起上（第 2.2 節），不能拆開。
2. **自我對打強度可能下降，而且不一定是真的變弱。** 舊的量測顯示，「硬3 只看湖後」讓紅方 +0.69pp，這是機器人自打自的慣例造成的。新規則下強度只回報、不回退，但要追原因；如果追不出來，就是第三關的補償工作。
3. **一致性基準可能下降。** 真人自己也會違反邏輯：可信票中有 16.4% 贊成「必定失敗」的隊；真人湖目標和資訊量規則的第一名一致率也會變低（派西湖 98→88/394）。依新的順序，邏輯優先。
4. **A0 當硬規則時，有約 0.8% 的局一致世界會變成空集合**（真人好人說錯或紀錄錯）。確定性層要退回 L0 並記錄；真人對局中這種局的機器人判斷會變弱。
5. **觀測格式改了**（`myLakeResults`、沒宣告的湖、`types.ts`、`GameServer.ts`），會碰到別的工作線（r6 網站、r8 模擬瓦）。要排在同一個整合窗口。
6. **人數與角色設定。** 確定性層如果寫死 10 人標準局，在 5–9 人房間或「關掉莫甘娜」的房間會給出錯的「確定」。S1-0 一開始就要參數化，並跑 5/7/9 人測試。
7. **嫁禍權重的過度擬合。** f、s、p\* 和權重都取自同一份牌譜，所以要做交叉擬合。p\* 是均衡量：機器人嫁禍越多，p\* 越高，現在的門檻就會失準。
8. **算力。** 第 3 階段的派隊 level-2 似然如果沒做快取，每個事件要 10–50 ms；自我對打的種子協定時間約變成三倍。
9. **小樣本的結論。** 硬3 湖後只有 3 次好人觸發（概似比區間 6–86）；嫁禍結果各格 n ≈ 20–40；梅林被嫁禍 n = 26。這些在本計畫只用來定方向和保守值，不當成精確參數。
10. **派西湖拇指的後果**：有一半會湖到莫甘娜，湖就交到紅方手上；第一次湖後刺殺下降的觀察有干擾因素（派西持第一湖時一定坐 10 號），所以不能當作證據，但也沒排除風險。

---

## 7. 需要 Edward 決定的事（白話）

| # | 問題 | 選項與建議 |
|---|---|---|
| D1 | 「好人持湖者一定說實話」要不要當**硬規則**？ | C > B > A（選 A 必選 B 必選 C）只有在這個前提下是 100% 成立的定理。真人違反率 0.61%。**建議**：在「否決」和「不變量」用硬規則，算機率時留 1% 的誤差；萬一某局出現矛盾，就退回只用遊戲規則 |
| D2 | R4 要兩張失敗。隊上「確定有一紅」不等於「確定失敗」 | **建議**：好人只對「確定會失敗」的隊硬性反對（R4 要確定兩紅）；R4 只有一紅的情況交給機率判斷 |
| D3 | R1–R2「一律投正常票」遇到「我確定這隊會失敗」時要不要破例？ | 現在機器人是照樣贊成：梅林 2358/2358，派西兩根拇指同隊 170/170。選項：(a) 維持現狀；(b) 忠臣、派西破例反對，梅林照舊（梅林反對會暴露自己）；(c) 全部破例。**建議 (b)**，但這是桌規，由您決定 |
| D4 | 派西的湖 = 藍方湖（拿掉拇指避開名單） | 代價：湖拇指的比例會和真人一樣（約 22%），但只有一半湖到梅林（真人 83%），另一半等於把湖交給莫甘娜；湖目標和真人第一名一致率從 98 降到 88/394。請確認接受。之後第 3 階段可以用「哪根拇指是梅林」的後驗，讓同分時偏向梅林 |
| D5 | 派西首局不放拇指：有「資訊」的特例要不要例外？ | 一根拇指先當隊長、又把另一根放進自己的隊時，被放的那根 87.9% 是梅林，真人派西 74% 會放她。(a) 一律不放（現行）；(b) 這種情況破例放被放的那根。另外 5–9 人局目前不適用 |
| D6 | 「讓場上不確定性大幅降低的嫁禍目標不是好選擇」 | 報告把它精確化為「持湖者自己的陣營往紅的方向收斂」。整體的熵其實是嫁禍下降得更多（0.66 vs 0.41 bits），但方向是錯的。請確認這個解讀 |
| D7 | 紅方湖藍方的頻率 | 10/13 的「能湖隊友就湖隊友」讓機器人只在 5.1% 的局面嫁禍，真人是 16.0%。(a) 維持；(b) 提高湖藍方的比例到接近真人 |
| D8 | 第 (c) 類「梅林可疑人選」 | 真人沒有這個偏好，結果上也量不出好處（n = 26）。**建議**：權重先設 0，等自我對打證據 |
| D9 | 第二關（像真人）的修改如果讓機器人變弱，要不要照樣上？ | 依 10/13 的先例是「照樣上，再從策略上補回」。請確認這個成為正式規則 |
| D10 | 硬3 湖後訊號的強度 | 實測概似比約 18，但好人只有 3 次觸發，95% 區間 6–86。**建議**用保守值 6 |
| D11 | 第 3 階段的「均衡」以哪一種為主？ | (a) 和真人行為一致的描述性不動點；(b) 機器人互打的策略均衡。**建議** (a) 為主，(b) 只當護欄，因為 (b) 會學到機器人自己的慣例 |
| D12 | 算力 | 第 3 階段後，自我對打每個種子的時間約變成三倍（約 9 分鐘 → 25–30 分鐘）。可以接受嗎？或是減少種子局數 |

---

## 8. 來源與審查更正（本計畫採用的版本）

| 原文 | 本計畫採用 | 來源 |
|---|---|---|
| 否決條件 `minReds ≥ 1` | `minReds ≥ 該局需要的失敗數`；R4 的一紅交給機率層 | critique X1 |
| 派西兩拇指同隊贊成 212/227 | 非 R4 109/120 是違規；R4 103/107 中只有 1 次是確定會失敗 | critique X1 |
| 硬3 加上「A 在隊上」條件 | 不加；用嚴格支配（隊上有人不是 A 確定的藍） | critique X2 |
| 湖鏈排序「不用另外實作」 | 確定性層用硬規則的 A0；機率層用 ε；空集合時退回 L0 | critique X3 |
| 硬1「含 A 就含 B」 | 只在嚴格支配時才算違規 | critique X4 |
| 0.85 固定下限 | 依概似比更新勝算（保守 6，點估計 18） | critique X5 |
| 硬3 湖後概似比 26 | 約 18（以每次決策為單位），95% 區間約 6–86 | critique §3 第 7 列 |
| 梅林「放不確定的人、漏確定藍」387/1121 算決策錯誤 | 只算信念缺口（梅林還要隱藏身分） | critique X6 |
| 真人贊成「必有紅」的隊 20.3% | 只用可信票：19.7%（必定失敗的隊 16.4%） | critique §3 第 11 列 |
| 強制提議的合成票 | 新增：被強迫的行動帶 0 bit（S1-9a、INV-F0） | critique M1 |
| 沒宣告的湖 | 新增：觀測加 'none'（S1-9c），第 3 階段當似然用 | critique M2 |
| 派西湖目標 | 依 Edward (1) 拿掉避開名單（S1-8），附量測與風險 | critique M3 + Edward 10/14 |
| 嫁禍不分持湖者角色 | 第 2 階段依莫德雷德、刺客或莫甘娜、奧伯倫拆開，加梅林洩漏項 | critique M4 |
| 只做信念遞迴 | 加上價值遞迴（一步前瞻價值表） | critique M5 |
| 派隊只算任務資訊 | 加上被否決提議的投票資訊 | critique M6 |
| 寫死 10 人局 | 確定性層參數化 | critique M8 |
| 硬3 可以單獨先上 | 不可以，要和排序約束整批上 | critique M12 |
| level-2 派隊成本 4×10⁵ 次運算 | 約 10⁷ 次運算/事件；SPARTA 約 140 s/決策 | critique §4 |
| 派西首局不放拇指的閘門 `> 0` | `=== 2`（只有一根拇指時她確定是梅林） | percival_followups |

報告與數字出處：
- `logic_audit.md` §2（約束目錄）、§3（F1–F18）、§5（彙總表）；
- `belief_engine.md` §1.4（必敗隊 7.3%）、§2（熵）、§3（架構）、§3.6（成本）；
- `framing_study.md` §3–§8；
- `literature.md` §4–§8；
- `critique.md` 全文；
- `lane/r6-percival:docs/ai/percival_thumbs.md` §6、§9、§11。
