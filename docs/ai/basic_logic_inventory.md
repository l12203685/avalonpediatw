# 基本邏輯盤點：第一人稱的推理與自己行動的一致性（百科AI，第 1 階段）

**日期**：2026-11-03 · **起因**：Edward 當晚對 9 個機器人的實戰回報（下方 0 節）· **範圍**：只盤點與量測，**不改策略**（另一輪優化正在改 agent 檔案）· **量測工具**：`packages/server/scripts/logicAudit.ts`（測試 `scripts/logicAudit.test.ts`）· **程式**：`packages/server/src/ai`（commit 8bf94e1 為準）。所有數字都是彙總，沒有玩家名、座位或聊天內容。

> Edward：「這些思考邏輯應該都蠻基本的 包括鐵咬 隊內 隊外 主觀視角應該都會知道 你能夠重新盤點一下類似的邏輯 應該都要完整的寫到百科AI裡面嗎 還有自己的湖中 到派的隊伍跟 黑白球投票 都要有一致性」

---

## 0. 實戰回報的三個失誤（座位已去識別）

1. 派西在別人派的隊 T 上內黑；下一次自己當隊長，照派一模一樣的 T，然後對自己的隊投黑。→ 規則 (b)、(a)。
2. 第 2 局 4 人隊一張失敗；下一隊只拿掉其中一人（**鐵咬**他），被咬的奧伯倫投白。無辜的人知道失敗來自其他三人，一定反對；投白 = 認壞。→ 規則 (e)。
3. 已暴露的奧伯倫在第 4 局、藍方已兩藍時，對一個全藍、過了就三藍的隊外白。→ 規則 (f)。

三個都在第 9 節的「**矛盾**」裡：程式不只是沒寫，而是有一條規則在做相反的事。

## 1. 狀態定義與摘要

| 狀態 | 意思 |
|---|---|
| **done** | 正式路徑（`USE_FORWARD_REASONING`，`DEFAULT_AGENT_TUNING`）有實作，稽核或不變量量到 0 或接近 0 |
| **partial** | 有實作但有缺口（只管某些角色／局段／在隊上或不在隊上之一），或只在機率層 |
| **missing** | 沒有任何程式處理 |
| **contradicted** | 程式做的是相反的事（有一條規則或評分把它往違反推） |

摘要（第 2–9 節共 67 項；第 9 節的 11 項有 8 項是前面各節同一件事的交叉引用）：**done 43 · partial 14 · missing 4 · contradicted 6**。去掉重疊後 59 件不同的事：done 39 · partial 12 · missing 4 · contradicted 4。

四件 **contradicted**（程式往違反推）：
1. **自派自黑**（L2 / S4）：正式路徑 R3 起沒有「隊長贊成自己的隊」，四條規則會讓隊長投黑自己的隊。
2. **照派自己內黑過的隊**（V2 / S5）：`teamReuse` 對本局被否決的提議加分，不管自己在上面投了黑。
3. **奧伯倫被鐵咬還投白**（E3）：`biasForOberon` 出過失敗任務後 R3 起「贊成」一律加 1.5。
4. **奧伯倫在藍方兩藍時外白全藍隊**（G3）：同一條加分；相認紅的「藍方兩藍不外白」（`redVoteCritical`）明文排除奧伯倫。

量測（第 10 節）：機器人 1000 局自我對打（`DEFAULT_AGENT_TUNING`、正式路徑）vs 真人牌譜（`games_cache.json` 2,312 局中嚴格重播得了的 2,223 局）。

---

## 2. 自己角色的知識

| # | 推理（藍方該推／紅方該避） | 實作位置 | 開關（預設） | 狀態 |
|---|---|---|---|---|
| R1 | 好人只能出成功 | `forward/ForwardAgent.decideCore` 開頭的防護 | `goodQuestSuccessGuard`（開） | done（INV-Q1） |
| R2 | 梅林：看得到的紅（莫德雷德以外）是確定紅；派隊不放 | `MerlinLoyalStyle.merlinLoyalStyleTeam`；`belief/Certainty`（L0 視野） | `merlinLoyalStyle`（開） | done（INV-M1） |
| R3 | 梅林 R3 起：不外白有看得到紅的隊；在隊上照雜魚投（內白），只在「這隊會讓紅方當場拿下」時擋 | `ForwardAgent.decide` 的 `merlinNormalVoteNow` 區塊、`MerlinLoyalStyle.merlinVoteFatal` | `merlinNormalVote`（1） | partial（刻意：裝雜魚；稽核 (h) 梅林那一列就是這個） |
| R4 | 派西：兩根拇指恰好一紅；R3 起、一張失敗就夠的非強制提議，兩拇指同隊 → 反對 | `PercivalThumbs.percivalBothThumbsReject`；`ForwardAgent.decideCore` | `percivalLoyalVote`（開） | done（INV-Pe1） |
| R5 | 派西只硬排除確定紅；兩拇指同分不依座位選邊 | `ForwardAgent.generateTeamSelectCandidates`、`percivalSignalsWithoutTie` | `percivalCertainExclusion`（開） | done（INV-Pe2） |
| R6 | 派西 R1 沒有資訊時不放拇指（D5 例外） | `PercivalThumbs` | `percivalNoThumbsR1`、`percivalR1ThumbOnThumb`（開） | done |
| R7 | 好人：自己是藍（P1），這是推理的第一個事實 | `belief/Certainty.enumerateWorlds`（L0 自己的陣營） | `beliefCertainFacts`（開） | done |
| R8 | 相認紅：自己 + 看得到的隊友 = 已知紅；失敗張數超過自己這邊能出的 ⇒ 奧伯倫在隊上（catalog R1） | `belief/Certainty`（紅方視角也列舉世界） | — | partial：確定性層推得出，但紅方的投票／派隊規則（`RedVoteCamouflage.redVoteCritical`、`RedRound4`）只讀 `knownEvils`，不用推出來的奧伯倫 |
| R9 | 奧伯倫：只知道自己是紅；「大局觀 = 雜魚」，從別人的行動找隊友（wiki-21） | `forward/RoleStrategy.biasForOberon` | `oberonLakeSeeksTeammates`（關）、`oberonNormalVote`（關） | partial：沒有「找隊友」的推理；投票是固定的參與規則（見 E3、G3） |

## 3. 任務結果

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| M1 | x 張失敗 ⇒ 隊上至少 x 紅（C2） | `belief/Certainty.enumerateWorlds` | `beliefCertainFacts`（開） | done |
| M2 | 第 4 局成功但有失敗牌 ⇒ 至少一紅（C5）；只讀失敗張數 | `missionFacts.beliefFailCards` | 同上 | done（INV-B3） |
| M3 | 0 張失敗 ≠ 全藍（可能有人藏，C3） | 確定性層不從 0 張失敗推任何事 | — | done |
| M4 | 自己在失敗任務上 ⇒ 其餘隊員至少 x 紅（P1） | 確定性層 + `LogicGates.provablyFailable` | `mustFailGate`（開） | done（R3 起；R2 的票照 D3 桌規） |
| M5 | x = 人數 ⇒ 全紅；跨任務計數、全場恰好 4 紅（C4 / C6） | 世界列舉 | — | done |
| M6 | 兩紅後任務成功 ⇒ 隊上紅不足以失敗（不拖延，A1） | `Certainty.noStallCaps`（L1） | — | done |

## 4. 隊長、隊內、隊外

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| L1 | 隊長派的隊包含自己 | `ForwardAgent.generateTeamSelectCandidates`（候選一律含自己） | — | done |
| L2 | **自派自黑**：隊長不反對自己派、自己在上面的隊（wiki-148「如果反對這個組合，指派時就不應該指派這些玩家」【邏輯】） | 只有備援路徑 `HeuristicAgent.voteOnTeam` 有「隊長一律贊成」；正式路徑 R1–R2 委派到它所以守住，**R3 起 `ForwardAgent` 沒有這條**，而且 `GoodCleanVote.goodCleanVoteReject`、`goodKeyVoteReject`、`LogicGates.goodVoteGate`、評分器都不排除隊長；紅方評分器的「隊上紅數」不算自己（`redSelfOnTeam` 關），奧伯倫／莫德雷德隊長會反對自己的隊 | `goodCleanVote`（0.45）、`goodKeyVote`（0.5）、`redSelfOnTeam`（關） | **contradicted**（稽核 (a)） |
| L3 | R1–R2 一律正常票（桌規，D3 定案） | `ForwardAgent.decideCore` 委派 `HeuristicAgent.voteOnTeam` | — | done |
| L4 | 第 5 次強制提議沒有投票；好人隊長仍不派必敗隊 | `GameEngine`（合成全員贊成）；`ForwardAgent.generateTeamSelectCandidates` 的閘門 | `mustFailGate`（開） | done（INV-T1） |
| L5 | 好人隊長不派、R3 起不贊成自己視角必敗的隊 | `LogicGates.teamGateBreach` / `goodVoteGate` | `mustFailGate`（開） | done（R3 起；R2 投票 = D3 豁免，稽核 (h) R1-2 列） |
| L6 | 隊外不亂外白（外白要有意義：洗尾、這隊過了就三藍） | `GoodCleanVote.goodTailVote`；紅方 `RedVoteCamouflage.redNormalVoteNow` | `goodTailVote`（0.85）、`redNormalVote`（1） | done |
| L7 | 隊內不會沒意義地內黑（wiki-148、wiki-11「紅方在車上內黑 = 放棄一次出失敗」） | 莫甘娜在隊上必贊成（`HeuristicAgent.voteOnTeam`，正式路徑委派）；刺客靠 `r3NormalVotePrior`；莫德雷德／奧伯倫沒有 | `r3NormalVotePrior`（0.6）、`redSelfOnTeam`（關，第 23 回合量過變弱） | partial |
| L8 | 好人在 R2 對自己視角必敗的隊（例：自己在的 R1 失敗隊被照派、或鐵咬自己的隊） | 桌規 D3：R1–R2 一律正常票，不例外 | — | partial（Edward 裁定；只標示，不建議改） |

## 5. 票型（內黑、外白）

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| V1 | 讀別人的內黑／外白（機率） | `belief/BayesBelief`（投票格子：陣營 × 在不在隊上 × 贊成 × 隊上有沒有紅；關鍵局另外一組格子） | `bayesBelief`、`beliefBotTables`、`beliefKeyVoteCells`（開） | done（機率層） |
| V2 | 內黑過的組合之後完全照派 = 沒有意義的內黑（wiki-90） | `TeamReuse.teamReuseScorer`：本局先前被否決的提議是參考隊，**沿用就加分**，不管自己在那隊上投了黑 | `teamReuse`（開；權重 `reject` 藍 0.45、紅 1.35） | **contradicted**（稽核 (b)） |
| V3 | 解決不了黑球就解決開黑的人（只拔掉內黑的人 = 常見錯誤，wiki-90） | — | — | missing（沒有讀、也沒有避免） |
| V4 | 不外白自己認為有壞人的組合 | `goodTailVote`（乾淨機率 ≥ τ 才外白） | `goodTailVote`（0.85） | done（藍方） |
| V5 | 關鍵局（紅方兩紅）提高贊成門檻，在不在隊上都一樣 | `GoodCleanVote.goodKeyVoteReject` | `goodKeyVote`（0.5） | done |
| V6 | 先算票：內黑擋不住時只剩代價（wiki-11） | 紅方外白有算票（`RedVoteCamouflage.redKeyWhiteVote`）；藍方內黑沒有 | `redKeyWhite`（1） | partial |

## 6. 鐵咬（wiki-204：有失敗的任務裡，派隊只沿用「出任務人數 − 失敗張數」人，等於表明剩下的人是壞人）

注意：程式裡的「鐵咬」一詞（`ForwardAgent.generateTeamSelectCandidates` 的註解）指的是另一件事——**派西硬排除推定是莫甘娜的那根拇指**。本節用的是百科的定義。

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| E1 | 藍方被鐵咬：這隊留下的人裡確定有紅 → 反對（R3 起、一張失敗就夠的局） | `LogicGates.goodVoteGate`（P1 推出必敗）；第 4 局兩張失敗只確定一紅 → 機率層（D2） | `mustFailGate`（開） | done（R3 起一張失敗）；第 4 局 partial |
| E2 | 藍方隊長不派鐵咬自己（= 留下其餘失敗隊員）的隊 | `ForwardAgent.generateTeamSelectCandidates` 的必敗閘門（任何局） | `mustFailGate`（開） | done |
| E3 | 紅方被鐵咬：不投白（投白 = 認壞） | 相認紅：R1–R2 正常票；R3 起不在隊上走 `redNormalVoteNow` → 以忠臣視角重算（`RedR1Teammate.loyalViewOf`），忠臣視角下自己是藍、必敗閘門擋住，只有「隊上有隊友而且紅方已兩紅」時照紅方利益贊成（`redVoteCritical`）。**奧伯倫**：`oberonNormalVote` 關，走 `RoleStrategy.biasForOberon`，出過失敗任務之後 R3 起「贊成」加 1.5（舊的「出過失敗就無限開白」規則），所以被鐵咬也投白 | `redNormalVote`（1）、`oberonNormalVote`（關） | **contradicted**（奧伯倫；稽核 (e)） |
| E4 | 藍方讀「被鐵咬的人投白」= 認壞 | `BayesBelief` 的一般投票格子（不在隊上贊成）；沒有「被鐵咬」這一格 | — | partial |
| E5 | 派鐵咬隊的隊長 = 表明被拿掉的人壞（視角，不是事實） | `BayesBelief` 一般派隊格子 | — | partial |
| E6 | 失敗隊的隊員當隊長，不派鐵咬自己的隊（紅：認壞；藍：等於派必敗隊） | 藍方 = E2；紅方沒有規則 | — | partial（稽核 (e2)） |

## 7. 湖中女神與宣告

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| K1 | 藍方持湖說實話 | `LakePolicy.decideLakeClaimForTeam`（好人照實宣告） | — | done（稽核 (c0) 0%） |
| K2 | 自己湖到的結果是確定事實（P2） | `belief/Certainty`（`myLakeResults`） | — | done |
| K3 | 好人持湖者：派隊放自己宣藍的人、不放宣紅的人 | `GoodLakeFollowUp.goodVouchTeamConstraint` | `goodVouchFollowUp`（開） | done |
| K4 | 好人持湖者投票：隊外，漏掉宣藍或放了宣紅 → 反對；隊上有自己宣紅的人，一張失敗就夠 → 反對（P2） | `GoodLakeFollowUp.goodVouchVoteRule`；`LogicGates.goodVoteGate`（`ownDeclaredRed`） | `goodVouchFollowUp`、`mustFailGate`（開） | partial：第 4 局（兩張失敗）在隊上可以贊成有自己宣紅者的隊 |
| K5 | 宣藍鏈：A→B 宣藍，選 A 必選 B（K1 / K3） | `LogicGates.teamGateBreach`（`dominated`） | `teamDominanceGate`（開） | done（INV-K1 / K1V） |
| K6 | 被宣紅的藍方：宣我紅的人必紅（P3） | 確定性層 + `mustFailGate` | `mustFailGate`（開） | done（INV-P3） |
| K7 | 紅方持湖者言行一致：派隊照宣告；隊外投票照宣告 | `RedLakeFollowUp.evilVouchTeamConstraint` / `evilVouchVoteRule` | `evilVouchFollowUp`（開，需 `evilLakeHumanStrategy`） | done（強制局例外） |
| K8 | 紅方持湖者**在隊上**：不贊成有自己宣紅者的隊、不贊成漏掉自己宣藍者的隊 | 第 25 回合硬約束 `RedRound25.redVouchOnTeamReject`（在隊上、隊上有自己宣紅的人 → 反對，紅方已兩紅例外） | `redVouchConsistent`（開） | done（第 25 回合） |
| K9 | 紅方不做「好人持湖者不可能為真」的宣告；已公開確定是紅就不宣告 | `LakePolicy.decideLakeClaimForTeam` | `redPossibleClaimsOnly`（開） | done（INV-R1） |
| K10 | 還湖：被說壞的人把湖交給確定好人，不還 = 認壞（A2） | `LakePolicy.pickLakeTargetForTeam`；`Certainty.admittedReds` | `returnLake`（開） | done |
| K11 | 不湖持過湖的人、不湖結果已確定的人 | 引擎禁止前者；`GoodLakeInfo`（資訊量）避開後者 | `goodLakeInfoMax`（開） | done |
| K12 | 奧伯倫湖到紅 = 找到隊友（wiki-147） | 確定性層有這筆；紅方規則不用 | `oberonLakeSeeksTeammates`（關） | partial |

## 8. 聽牌、強制局與刺殺

| # | 推理 | 實作位置 | 開關 | 狀態 |
|---|---|---|---|---|
| G1 | 紅方已兩紅：隊上的紅一定出失敗（收尾） | `HeuristicAgent.voteOnQuest` 的聽牌規則；`ForwardAgent.decide` 先跑藏牌／位階法 | `redRankOrder`（開）、`humanQuestCardRules`（開）、第 27 回合 `redHideR4Solo=1`（開） | done（稽核 (p)：0 / 428 次任務；真人 5.4%）；**第 27 回合起 partial**：`redHideR4Solo=1` 讓第 4 局、紅方兩紅、自己是隊上唯一看得到的紅時藏牌（一張失敗讓不了任務失敗；強者紅方 85%、全體真人 90% 這樣做），奧伯倫剛好也在隊上時就漏掉收尾：(p) 3.1%（4／127）。自我對打 +0.88pp，策略取捨，請 Edward 確認 G1 是否接受這個例外 |
| G2 | 紅方已兩紅：紅隊長的強制提議放夠自己知道的紅 | 沒有明確規則；評分器 `threeRedWins` 偏好有隊友的隊；`RedRound4.redCleanLookTeam` | `redCleanLook`（開） | done（沒有明文規則，但稽核 (o) 0 / 105；真人 1.6%） |
| G3 | **藍方已兩藍：不在隊上的紅方不外白全藍的隊**（過了就進刺殺；wiki-21「你知道開這顆白球不會讓任務出去」才可以開擾亂白） | 相認紅：`RedVoteCamouflage.redVoteCritical`（沒有隊友、藍方兩藍 → 反對）；**奧伯倫被排除**（`ForwardAgent.decide`：`obs.myRole === 'oberon' ? null`，`oberonNormalVote` 關），走 `biasForOberon`：出過失敗任務後 R3 起贊成 +1.5 | `redNormalVote`（1）、`oberonNormalVote`（關）；第 25 回合硬約束 `oberonMatchPoint`（開） | done（第 25 回合：奧伯倫 (f) 50% → 0%、(f′) 8% → 0%） |
| G4 | 紅方已兩紅、隊上有隊友：外白衝（只在這隊過得了時） | `redVoteCritical` + `redKeyWhiteVote` | `redKeyWhite`（1） | done |
| G5 | 紅方已兩紅：好人擋有紅的隊，梅林寧可暴露也擋（wiki-207） | `merlinVoteFatal`、`goodKeyVoteReject` | `goodKeyVote`（0.5） | done |
| G6 | 第 4 局保護局：一紅不會開紅（D2） | 確定性層 `failsRequired` | — | done |
| G7 | 刺客只刺藍方（刺殺時拿到全部紅方名單） | `HeuristicAgent.assassinate`（`allEvilIds`） | — | done（INV-A1） |
| G8 | 刺殺時紅方翻牌相認（含奧伯倫） | `SelfPlayEngine` / `GameServer`（`allEvilRoles`） | — | done |
| G9 | 派過梅林看得到的紅的隊長排後（第二關：像真人） | `assassin/VisibleRedProposals` | `assassinVisibleRedTier`（開） | done（policy） |

## 9. 自己行動之間的一致性（本次重點）

鏈條：**自己的湖結果 → 自己的宣告 → 自己派的隊 → 自己的黑白球**；**自己派的隊 → 自己的票**；**自己內黑過 → 不照派**；**自己的任務牌 → 之後的票**。

| # | 一致性 | 實作位置 | 開關 | 狀態 | 稽核 |
|---|---|---|---|---|---|
| S1 | 湖結果 → 宣告（藍方照實） | K1 | — | done | (c0) |
| S2 | 宣告 → 自己派的隊（兩個陣營） | K3、K7 | `goodVouchFollowUp`、`evilVouchFollowUp` | done | (c/d) 派隊兩列 |
| S3 | 宣告 → 自己的票 | K4（藍方第 4 局在隊上的缺口）、K8（紅方在隊上沒有） | 同上 | partial | (c/d) 投白 |
| S4 | **自己派的隊 → 自己的票**（不自派自黑） | L2 | — | **contradicted** | (a) |
| S5 | **本局自己內黑過的隊 → 不照派** | V2 | `teamReuse` | **contradicted** | (b) |
| S6 | 自己本局派過的隊被別人照派、自己在上面 → 不內黑 | — | — | missing | (b3) |
| S7 | 本局內黑過的隊 → 之後同一隊（不是自己派）照樣反對 | — | — | missing（真人也常改票，見 (b2)，不建議當規則） | (b2) |
| S8 | 自己的任務牌（藍：成功）→ 被鐵咬時反對、不派留下其餘失敗隊員的隊 | E1、E2、M4 | `mustFailGate` | done（R3 起）；R2 = D3 | (g)、(h) |
| S9 | 自己的任務牌（紅：出過失敗）→ 被鐵咬時不認壞 | E3（相認紅 done、奧伯倫 contradicted） | `oberonNormalVote`（關） | partial | (e) |
| S10 | 自己湖說某人壞 → 自己被說壞時還湖 | K10 | `returnLake` | done | — |
| S11 | 自己外白過的隊（= 認為全好）→ 之後的派隊與票不反過來 | — | — | partial（機率層的信念會讀自己的票，沒有一致性規則） | — |

（S7 標 missing 但不建議做成規則；S11 標 partial。這兩項不列入第 11 節的硬規則。）

---

## 10. 量測：機器人 vs 真人

機器人：1000 局 10 人自我對打，主種子 20261103（`--shard 0/2` + `1/2` 合併；同種子重跑逐筆相同），每個座位都是 `DEFAULT_AGENT_TUNING` 的 `HeuristicAgent`（正式路徑 `USE_FORWARD_REASONING`）。真人：`games_cache.json` 2,312 局中 `datasetReplay.ts` 嚴格解析得了的 2,223 局（湖鏈對不起來的 64 局略過湖的規則）；票只用重建可信的提議（`votesReliable`：非強制、贊成數和結果一致）。舊紀錄常省略「過了的那一隊」的異常票，所以真人的投票違反率是**下限**。

格式：違反率（違反 / 機會）。「機會」= 那個人可以違反的場合（例如 (a)：隊長在自己派、自己在上面的非強制提議）。

### 10.1 依陣營

| 規則 | 陣營 | 機器人 | 機器人 R3+ | 真人 | 真人 R3+ | 判讀 |
|---|---|---|---|---|---|---|
| **(a) 自派自黑** | 藍 | 4.9% (407/8320) | **11.6%** (407/3516) | 0.4% (55/15357) | 0.8% (45/5809) | 真人幾乎不做 → **硬規則** |
| **(a) 自派自黑** | 紅 | 10.0% (557/5543) | **23.7%** (557/2347) | 0.2% (24/9808) | 0.6% (20/3402) | 同上 |
| (b) 非強制提議重派自己本局內黑過的隊 | 藍 | 15.0% (139/929) | 同左 | 8.5% (122/1437) | 9.9% (121/1218) | 真人也做 → 調整 |
| (b) 同上 | 紅 | **42.6%** (55/129) | 同左 | 4.2% (15/357) | 4.7% (13/278) | 奧伯倫 92%（= (a) 的後果） |
| (b′) 同 (b)，第 5 次強制提議 | 藍 / 紅 | 9.4% (41/434) / 34.5% (20/58) | | 12.8% (74/577) / 6.5% (8/123) | | 強制局真人更常這樣 |
| (b2) 內黑過的同一隊之後改投白 | 藍 / 紅 | 32.1% / 0.0% | | 48.7% / 67.9% | | 真人常改票，不是規則 |
| (b3) 別人照派自己本局派過的隊、自己在上面卻投黑 | 藍 | 10.3% (130/1258) | **22.3%** (130/559) | 3.1% (38/1227) | 4.6% (33/725) | 和 (a) 同源 |
| (b3) 同上 | 紅 | 5.0% (38/767) | 11.5% (38/331) | 0.7% (3/427) | 0.9% (2/219) | |
| (c0) 好人持湖說謊 / 不宣告 | 藍 | 0.0% / 0.0% (0/955) | | 0.6% (17/2671) / 0.3% | | done |
| (c) 好人持湖者派進自己宣紅的人 | 藍 | 0.0% (0/114) | | 1.6% (3/193) | | done |
| (c) 好人持湖者對有自己宣紅者的隊投白 | 藍 | 0.0% (0/611) | | 7.8% (38/486) | | done（真人多在第 4 局） |
| (c) 好人持湖者自己的隊漏掉自己宣藍的人 | 藍 | 0.0% (0/157) | | 0.7% (3/405) | | done |
| (d) 紅方持湖者派進自己宣紅的人 | 紅 | 6.7% (1/15) | | 8.8% (8/91) | | 樣本小 |
| (d) 紅方持湖者對有自己宣紅者的隊投白 | 紅 | 0.5% (1/196) | | 20.8% (89/428) | | 機器人比真人守信 |
| (d) 紅方持湖者自己的隊漏掉自己宣藍的人 | 紅 | 9.4% (26/278) | | 6.2% (14/227) | | partial（紅方決勝窗口豁免） |
| **(e) 被鐵咬還投白（認壞）** | 紅 | 24.2% (740/3057) | 25.4% (740/2917) | 20.6% (683/3323) | 21.9% (660/3010) | 合計像真人，但**奧伯倫 76.0%**（真人 24.4%），相認紅 8–12% 全部是「紅方兩紅、隊上有隊友」的衝刺 |
| (e) 同上 | 藍 | 0.0% (0/1828) | 0.0% | 4.7% (70/1496) | 5.3% (70/1322) | done |
| (e2) 失敗隊員當隊長派鐵咬自己的隊 | 藍 / 紅 | 0.0% / 0.0% | | 0.2% / 3.7% | | done |
| **(f) 藍方兩藍，不在隊上的紅方外白全藍隊** | 紅 | 13.4% (387/2896) | 同左 | 43.7% (1748/4004) | 同左 | **全部是奧伯倫**（53.5%）；相認紅 0%；真人 40–47%（隊伍反正會過時跟著白） |
| **(f′) 同 (f)，而且這顆白球剛好過半** | 紅 | 2.4% (69/2896) | 同左 | 3.3% (132/4004) | 同左 | 奧伯倫 9.5%（真人奧伯倫 4.0%、其他紅 2.7–3.6%） |
| (g) 好人出過失敗任務，對包含其餘全部隊員的必敗隊投白 | 藍 | 0.4% (5/1130) | 0.0% (0/1077) | 4.1% (38/921) | 3.5% (27/775) | done（5 次都在第 2 局：D3 桌規） |
| (g) 同上，當隊長派出 | 藍 | 0.0% (0/2146) | 0.0% | 0.1% (6/4478) | 0.1% | done |
| (g′) 同 (g) 投白，第 4 局只確定一紅 | 藍 | 0.0% (0/549) | | 20.8% (110/528) | | done（真人常放一位不確定的人） |
| (h) 好人對自己視角必敗的隊投白 | 藍 | 14.0% (1382/9881) | 3.6% (158/4413) | 19.8% (3824/19327) | 16.2% (1104/6810) | R3 起全部是梅林（5.8%）；派西、忠臣 R3 起 0% |
| (h) 好人隊長派出自己視角必敗的隊 | 藍 | 1.4% (137/10113) | 1.5% (63/4113) | 1.8% (362/20525) | 1.2% (90/7574) | 全部是梅林（8.1%；真人梅林 10.0%） |
| (o) 紅方兩紅，紅隊長強制提議沒放夠紅 | 紅 | 0.0% (0/105) | | 1.6% (2/122) | | done |
| (p) 紅方兩紅，紅方夠卻沒收尾 | 任務 | 0.0% (0/428) | | 5.4% (58/1076) | | done |

### 10.2 依角色（R3 起；機器人 / 真人）

| 規則 | 梅林 | 派西 | 忠臣 | 刺客 | 莫甘娜 | 莫德雷德 | 奧伯倫 |
|---|---|---|---|---|---|---|---|
| (a) 自派自黑 | 21.8% / 0.8% | 32.5% / 0.5% | 3.7% / 0.8% | 0.0% / 0.4% | 0.0% / 0.5% | 28.2% / 0.9% | **64.7%** / 0.6% |
| (b) 重派自己內黑過的隊（非強制） | 5.7% / 6.9% | **35.2%** / 4.9% | 12.1% / 10.0% | — / 1.2% | 0% / 4.3% | 12.0% / 5.3% | **92.0%** / 5.9% |
| (b3) 照派自己派過的隊卻內黑 | 26.4% / 4.7% | 22.0% / 5.1% | 22.7% / 4.3% | 0% / 2.0% | 0% / 0% | 19.6% / 1.5% | 75.0% / 0% |
| (e) 被鐵咬投白 | 0% / 6.7% | 0% / 3.9% | 0% / 5.3% | 11.9% / 22.5% | 9.6% / 22.2% | 8.1% / 19.2% | **76.0%** / 24.4% |
| (f′) 兩藍時決定性的外白 | | | | 0% / 2.7% | 0% / 2.9% | 0% / 3.6% | **9.5%** / 4.0% |
| (h) 對自己視角必敗的隊投白 | 5.8% / 20.0% | 0% / 8.8% | 0% / 4.7% | | | | |

（(b) 只算非強制提議；機器人的 (b) 全部發生在 R3 起，真人的 (b) 欄是全部局段。(f′) 只會在 R3 起發生。）

### 10.3 違反的那一票是哪一條規則決定的（`--why`，另一組種子 20261104 的 300 局）

| 規則 | 角色 | 正式路徑的決策 | 票數 |
|---|---|---|---|
| (a) | 奧伯倫 | 評分器「reject proposed team」（紅方評分的隊上紅數不算自己） | 120 |
| (a) | 莫德雷德 | 同上 | 51 |
| (a) | 梅林 | `merlinNormalVote`：以公開視角的忠臣重算，忠臣視角反對 | 35 |
| (a) | 派西 / 忠臣 | `goodKeyVote`（關鍵局後驗 < 0.5） | 31 / 21 |
| (a) | 派西 / 忠臣 | `goodCleanVote`（後驗 < 0.45） | 20 / 11 |
| (e) | 奧伯倫 | 評分器「approve proposed team」（`biasForOberon` 出過失敗後贊成 +1.5） | 142 |
| (e) | 莫甘娜 / 刺客 / 莫德雷德 | `redVoteCritical`：紅方兩紅、隊上有隊友 → 照紅方利益贊成 | 30 / 28 / 18 |
| (f) | 奧伯倫 | 評分器「approve proposed team」（同一條 +1.5） | 121 |

讀法：(a) 的根源是**派隊與投票用不同的評估**——隊長的派隊流程挑了這一隊，投票時另一條規則（後驗門檻、忠臣視角、紅方評分）說這隊不好。相認紅的 (e) 是聽牌時衝隊友，屬於策略（真人 19–22% 也這樣）；奧伯倫的 (e)(f) 是同一條舊規則「出過失敗就無限開白」（Edward 2026-04-24 batch 7/8），它在藍方聽牌時不分隊伍顏色。


---

## 11. 第 2 階段建議優先序

依「邏輯正確 > 像真人 > 強度」的採用順序（`logic_first.md` 第 1 節）。**硬規則** = 第一關：一直開、附回歸測試、強度只量測回報；**開關** = 第二／三關：要走勝率協定（`selfPlayStrength.ts` 的種子協定，選版本種子 + 至少兩個確認種子）。

| 優先 | 項目 | 種類 | 依據 | 建議做法 |
|---|---|---|---|---|
| 1 | **隊長不對自己派、自己在上面的非強制提議投黑**（(a)、S4） | **硬規則** | 真人 0.2–0.9%（每個角色 ≤ 0.9%）；wiki-148【邏輯】；Edward 2026-04-29 已裁定（備援路徑早有） | `ForwardAgent.decide` 最前面（藏牌／位階法之後、所有投票規則之前）加「隊長在自己的隊上 → 贊成」；新的不變量（例如 INV-S4「隊長贊成自己的隊」）加進 `invariants/catalog.ts` 與 CI。同時把派隊改成和投票同一個評估（下一項），否則隊長會派出自己估起來髒的隊 |
| 2 | **派隊與投票用同一個評估**（(a)、(b3) 的根源） | 硬規則（一致性） + 強度量測 | (b3) 機器人 R3 起 22% vs 真人 4.6% | 好人隊長的候選隊先過自己的 `goodCleanVote` / `goodKeyVote` 門檻（沒有合格的才放寬，和 `LogicGates.compliantTeams` 同樣的退路）；梅林派隊（`merlinLoyalStyle`）與投票（`merlinNormalVote`）用同一個忠臣視角；紅方評分把自己算進隊上的紅（隊長那一票由第 1 項處理，非隊長的 `redSelfOnTeam` 第 23 回合量過 −2.2pp，留給開關） |
| 3 | **奧伯倫：藍方兩藍時不做決定性的外白**（(f′)、G3） | **硬規則**（只拿掉矛盾的那條加分） | 奧伯倫 9.5% vs 真人 4.0%；相認紅已經是 0%（`redVoteCritical`）；wiki-21「你知道開這顆白球不會讓任務出去」才開 | `biasForOberon` 的「出過失敗後贊成 +1.5」在藍方已兩藍時不適用，改走 `redVoteCritical` 的「沒有看得到的隊友、藍方兩藍 → 反對」（奧伯倫看不到隊友，等於藍方兩藍時不外白）；(f) 的非決定性外白真人 40–47%，不硬禁 |
| 4 | **奧伯倫：被鐵咬不投白**（(e)、E3） | 開關（勝率協定） | 奧伯倫 76% vs 真人 24%；但真人紅方整體 20% 也會認壞（已暴露就放棄），不是「絕不」 | `biasForOberon` 的無限開白改成條件式（不在被鐵咬時、不在藍方聽牌時），目標比例對齊真人；或打開既有的 `oberonNormalVote`（第 16 回合候選）一起量 |
| 5 | **不照派自己本局內黑過的隊**（(b)、V2、S5） | 開關（勝率協定） | 真人藍 8.5%、紅 4.2%（非強制）——真人也做，不是硬規則；機器人派西 35% 偏離最大 | `TeamReuse.teamReuseGuard` 對「隊長自己內黑過的本局提議」不加 `reject` 權重的分（等於回到舊的 `PRIOR_PENALTY`）；第 1、2 項做完後重量一次（奧伯倫的 92% 主要是 (a) 的後果） |
| 6 | 紅方持湖者自己的隊漏掉自己宣藍的人（(d) 9.4% vs 真人 6.2%）、紅方持湖者在隊上的宣告一致（K8） | 開關 | 真人也有 5–20% | 檢查 `evilVouchTeamConstraint` 在決勝窗口的豁免與派隊後處理（`redCleanLook` 等）有沒有蓋掉約束 |
| 7 | 藍方讀「被鐵咬的人投白」（E4）、讀鐵咬派隊（E5） | 開關（信念） | 真人紅方 20% 會認壞，訊號真的存在 | `BayesBelief` 加一格「被鐵咬時不在隊上贊成」，用機器人表擬合後量 |
| — | 不建議做成規則 | — | (b2) 真人 49–68% 改票；(h) 梅林在隊上內白看得到的紅（刻意裝雜魚，真人梅林 20%）；R1–R2 的必敗隊（D3 定案） | 維持 |

第 1、3 項做完，Edward 回報的三個情況中 (1) 的「自己的隊投黑」與 (3) 會直接歸零；(1) 的「照派」與 (2) 要靠第 4、5 項，屬於像真人的比例調整。


## 12. 和既有文件的交叉比對

- `docs/ai/rules_checklist.md`：第 1 節規則與第 2 節鐵邏輯本盤點都涵蓋（第 2–3、8 節）；第 3 節裁定：R1–R2 正常票（L3、L8）、還湖（K10）、兩紅後不拖延（M6）、刺殺排除（G9）、已公開確定紅不宣告（K9）都有對應。清單**沒有**「自派自黑」「照派自己內黑過的隊」「鐵咬」「奧伯倫聽牌外白」——建議把第 11 節的硬規則加進該清單的第 3 節（需要 Edward 確認後再改，本次不改既有檔）。
- `docs/ai/logic_first.md` 第 2 節約束目錄（C1–C8、K1–K6、P1–P3、M1–M3、Pe1–Pe2、R1、A1、T1–T4）：全部是「從紀錄推出什麼是真的」與「好人不贊成必敗隊」；第 4 節不變量（INV-*）全部 enforced。本盤點新增的是**同一個人前後行動的一致性**與**紅方不自曝**，目錄裡沒有：S4–S7、E3、G3、K8。其中 S4（自派自黑）在備援路徑早就是 Edward 2026-04-29 的裁定（`HeuristicAgent.voteOnTeam` 的註解「隊長對自己派的隊伍 vote 反對 是一個 fundamental bug」），正式路徑 R3 起沒接上。
- 百科：wiki-148〈黑白球投票〉（自派自黑、正常／異常票、隊內／隊外）→ L2、L6、L7；wiki-11〈內黑的用途〉（先算票、紅方內黑 = 放棄出失敗）→ L7、V6；wiki-204〈術語〉鐵咬 → 第 6 節；wiki-207〈聽牌與決勝局〉→ G1–G6；wiki-206〈尾家〉強制局 → L4、G2；wiki-147 / 208〈湖中〉→ 第 7 節；wiki-90〈常見錯誤〉（內黑完照派、只拔開黑的人、想法矛盾）→ V2、V3、S5；wiki-21〈奧伯倫〉（暴露後的白球要「不會讓任務出去」）→ G3。

## 13. 重跑

```bash
cd packages/server
# 兩個程序平行（各 500 局），再合併；--human 加真人牌譜；--why 記下違反的票是哪一條規則決定的
npx tsx scripts/logicAudit.ts --games 1000 --shard 0/2 --human --out /tmp/a0.json
npx tsx scripts/logicAudit.ts --games 1000 --shard 1/2 --out /tmp/a1.json
npx tsx scripts/logicAudit.ts --merge /tmp/a0.json /tmp/a1.json --out /tmp/audit.json
npx tsx scripts/logicAudit.ts --games 300 --why --out /tmp/why.json
npx vitest run scripts/logicAudit.test.ts
```


## 14. 第 25 回合（紅方）之後的狀態

`docs/ai/optimization_loop.md` 第 25 回合；稽核 300 局、種子 20261103（括號 = 違反／機會）。

| # | 項目 | 第 25 回合的處理 | 前 → 後 | 真人 |
|---|---|---|---|---|
| G3 | 藍方兩藍，奧伯倫外白全藍隊（(f)、(f′)） | 硬約束 `oberonMatchPoint`：自己視角沒有確定夠多的紅能讓這隊失敗就投黑 | (f) 50.0% → 0%、(f′) 8.0% → 0% | 46.8%／4.0% |
| K8、S2、S3 | 紅方持湖者：自己的隊漏掉自己宣藍的人；在隊上、隊上有自己宣紅的人 | 硬約束 `redVouchConsistent`：`redCleanLook` 換隊守住宣告；在隊上反對（紅方已兩紅例外） | 漏掉 12.0% → 0%；投白 7.3% → 3.7% | 6.2%／20.8% |
| L2、S4（延伸） | 隊長對自己派、自己**不在**上面的提議投黑（新稽核 (a″)；第 24 回合 `goodReuseExact` 會派這種隊） | 硬約束 `leaderSelfApproveOffTeam`（好人仍過投票關卡；梅林不外白看得到紅的隊） | 藍 32.6%（14／43）→ 9.3%（4／43，只剩梅林照派有看得到的紅的隊） | 5.2%（紅 7.6%） |
| E3、S9 | 奧伯倫被鐵咬投白（(e)；新稽核 (e″) = 失敗任務的下一局） | 開關 `oberonBiteReject` 1／2／3（50%）都中性，照第 1C 節維持舊規則；藍方兩藍的部分由 G3 擋掉 | 71.2% → 49.6%（下一局 69.3% → 59.7%） | 23.0%（下一局 11.4%） |
| L7、G1 | 紅方已兩紅、自己在隊上、自己知道的紅夠讓任務失敗卻內黑（新稽核 (q)） | 開關 `redMatchPointApprove`（真人也做，不是純粹的矛盾），中性，沒有採用 | 莫德雷德 13.1%、奧伯倫 9.2%（刺客、莫甘娜 0%） | 17.3% |
| V2、S5 | 紅方隊長重派自己內黑過的隊（(b)） | 開關 `redLeadConsistent`（1／2）中性，沒有採用 | 52.4%（奧伯倫 90%） | 4.2% |

仍然標 contradicted 的只剩 E3（奧伯倫被鐵咬投白）；要不要當成硬約束待 Edward 裁定。

## 15. 第 29 回合（紅方）之後的狀態

`docs/ai/optimization_loop.md` 第 29 回合第 7 節；稽核 300 局、種子 20261103（第 28 回合預設 → 新預設）。

| # | 項目 | 第 29 回合的處理 | 前 → 後 | 真人 |
|---|---|---|---|---|
| G1 | 紅方已兩紅：隊上的紅一定出失敗 | 硬約束 `redMatchPointFail`：自己＋看得到的隊友夠讓任務失敗時，每一個相認紅都出失敗（不再照位階法藏一張） | 強者點第 3 局藏牌 17.5% → 2.0%；仍是 partial：`redHideR4Solo` 的例外（(p) 1.7%，待 Edward） | 第 3 局兩個相認紅兩張失敗 75%、三個三張 100% |
| L7 | 隊內不會沒意義地內黑（莫德雷德） | 硬約束 `mordredSoloApprove=1`：評分器不把投票者自己算成隊上的紅；莫德雷德在自己一張失敗就夠的隊上投白 | (q) 莫德雷德 19.3% → 0%；done | 17.3%（紅方 (q)） |
| V2、S5（紅） | 紅方隊長重派自己內黑過的隊（(b)） | 不用另外的規則（第 27 回合 `oberonSelfOnTeam`＋本回合 L7 之後）；`redLeadConsistent=1` 在新預設下沒有作用 | 6.3%（1／16）→ 0%；done | 4.2% |
| E3、S9 | 奧伯倫被鐵咬投白 | 沒有改（`redHumanVote=2` 第 1 階段再次沒通過） | 49.0% → 50.5% | 23.0% |

紅方仍然標 contradicted 的只剩 E3；partial：G1（`redHideR4Solo` 例外）、R8（相認紅不用推出來的奧伯倫）、K12（奧伯倫湖到紅＝找到隊友）。
