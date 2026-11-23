# Gemini 策略第二意見審查報告（Issue #149）

* **對應議題**：`l12203685/avalonpediatw#149`

* **審查基準**：`main`（`base_main_sha: ddc9feb019538a1ca7c1b5dc50c106c417c93298`）

* **參考文件**：`docs/ai/optimization_loop.md`（§1、§1F、§1H、第 50–57 回合）、`docs/ai/GEMINI_ONBOARDING_PROMPT.md`、`docs/ai/AI_COLLABORATION_OPERATING_MODEL.md`

* **實證依據**：以本專案 `sheets_cache.json` 10 人局實戰牌譜（3,117 局）抽樣與 142 局「0:2 兩單敗、3-5 5 家忠臣」五折樣本外交叉驗證（2,520 世界精確貝氏模型）結果作為量化佐證。

## 總論：Claude 現有推論架構的三個結構性盲點

在檢視 `docs/ai/optimization_loop.md` 第 50–57 回合（特別是 `src/ai/Round50.ts`、`src/ai/Round53.ts`、`scripts/acceptRound53.ts` 與 `bot:calibration`）後，目前五個卡關問題其實源自三個共同底層缺陷：

1. **獨立事件假設導致「資訊同源重複計數」與「跨提議意圖流失」**：現有 `viewpoint53` 將每一次派票視為獨立更新，既看不見後位隊長「延伸／修正／排斥」前位隊長的序列關係（導致 Q1 讀不出 1 家好人與 3 家可疑），又把多位無內建資訊忠臣的重複照派連乘多次（導致 Q2 把 0 家吹成大好人、且 ECE 從 2.22% 惡化至 4.90%）。

2. **決策層缺少「接續價值（Continuation Value）」與「公開偽裝邊界」**：藍方投票只看當前隊伍紅機率門檻，未對比「反掉後流向尾家的期望值」（導致第 3 局起過度內黑）；梅林派票直接最大化私人無拇指機率，未受限於「忠臣公開合理集合」（導致 1-1～1-4 照第 5 次派時刺中率上升 5pp）。

3. **紅方行為模型過度極化**：實證統計顯示紅方在 2、3 局派票放 2 紅以上比例過高、且奧伯倫首局藏牌直接送掉首局 +16pp 的藍方勝率槓桿，導致紅方容易被盤面推論反抓。

以下針對 Issue #149 五個問題，逐一提出**僅使用該座位當下合法資訊**的推論診斷、可寫成 `AgentTuning` 開關的規則與虛擬碼，以及預期對 §1、§1F、§1H 與校準曲線（ECE/Brier）的影響。

## 問題一：驗收題 Q1／Q2 一直不過（機器人推理缺了什麼）

### 1. 現有做法錯誤指正與根因推論

* **出處**：`docs/ai/optimization_loop.md` 第 53 回合、`src/ai/Round53.ts`、`scripts/acceptRound53.ts`。

* **Q1（1-5 5 家忠臣，前四提 `149 / 270 / 346 / 459` 全否決）的盲點**：

  1. **缺少「跨提議延伸」的反向背書**：4 家派 `459` 明確延伸了 1 家 `149` 的 `{4, 9}` 並共同排除 `{2, 3, 6, 7, 0}`。現有 `viewpoint53` 只讓 149 幫 4、9 加分、459 再幫 4、9 加分，卻沒有把「4 家認同 1 家視角」反向回推給 1 家，因此 1 家停在先驗 `0.47`。

  2. **缺少「對已知好人的無故排斥」懲罰**：5 家自己確定是藍方；在 2 家派 `270`（明顯與 149 對立）後，3 家派 `346` 既拆了 149 的 9、又莫名排除 5 家（尾家），在 5 家視角下這是高度異常的敵意派票，但靜態派票表未對「無硬證據下排除觀察者自己」給予額外紅方似然。

* **Q2（3-4 4 家派西，第 1 局兩紅只出一張失敗，7 家在 1347 投反對）的盲點**：

  1. **忠臣同源抄作業的雙重計數（Double Counting）**：`optimization_loop.md` 第 53 回合已記錄「隊長視角把忠臣 7 家、9 家派了 0 家讀成 0 家偏好人（`q = 0.077` 乘好幾次）」。忠臣沒有內建資訊，多人重複派同一位「公開乾淨的人」是**高度相關的同源資訊**，直接連乘必然造成過度自信（Platt 斜率低於 1、ECE 飆升）並讓莫德雷德 0 家被誤讀成鐵好。

  2. **任務牌模型過度低估「多紅只出一張失敗」**：根據 142 局實戰統計，第 1 局開單紅時隊內實際含 2 紅的比例高達 **17.0%**（24/141），第 2 局開單紅時含 2 紅更高達 **31.7%**（45/142）。若任務牌似然把「2 紅只出 1 敗」設得過低，就會壓過梅林／派西的派票線索。

### 2. 具體可測改法（建議開關：`seqIntent59` + `loyalCopyCap59`）

* **合法資訊範圍**：僅使用觀察者自身身分、已知必好座位（自己與確認的真好人）與公開的歷史派票／投票／任務結果。

* **核心規則**：

  1. **角色分層的聯合推論（梅林潛在變數）**：將世界狀態顯式區分為 `(4 壞集合 W, 莫德雷德 D, 梅林 M)`（對忠臣為 2,520 世界；對派西只需在雙拇指二選一，更精簡）。只有潛在梅林 `M` 的派票才以「0 可見紅（實證約 85–92%）」享有完整乘法權重；一般忠臣的重複派票必須做**次線性同源折扣**。

  2. **跨提議延伸背書（`seqIntent59`）**：若後位隊長 `L2` 派出的隊伍 `T2` 與前位隊長 `L1` 的 `T1` 重疊度高（例如 3 人隊重疊 2 人以上）且共同避開前人衝突區間，於「`L1` 與 `L2` 同為藍方」的世界給予正向似然加成，反向拉升 `L1`（如 Q1 的 1 家）。

  3. **觀察者視角排斥懲罰**：對任意觀察者 `self`（已知自己為藍方），當某位隊長 `L` 在「`self` 尚未上過失敗任務、且前人已釋放其他區間衝突」時（如 Q1 的 3 家），未選 `self` 且未延伸與 `self` 相容的路線，略微上調 `L` 為紅方的似然。

  4. **單敗任務的多紅似然校準**：使用實證平滑比率計算 `P(1 fail | k evils)`，以精確超幾何組合數做基數正規化，避免把 2 紅單敗壓成近乎不可能。

```
# 開關 1：忠臣同源重複派票折扣 (loyalCopyCap59)
function proposalLogLikelihood(world, leader, team, targetRepeatCount):
    if leader == world.merlin:
        return logP_merlin(countVisibleEvils(team, world))   # 完整權重
    elif leader in world.evils:
        return logP_evil(countAllEvils(team, world))
    else:
        # 一般忠臣：對同一目標被忠臣重複派票做 1 / sqrt(repeatCount) 次線性折扣
        base_ll = logP_loyal(countAllEvils(team, world))
        discount = 1.0 / sqrt(max(1, targetRepeatCount))
        return base_ll * discount

# 開關 2：跨提議延伸與觀察者視角懲罰 (seqIntent59)
function sequenceIntentBonus(world, prevLeader, prevTeam, currLeader, currTeam, selfSeat):
    ll = 0.0
    if overlap(prevTeam, currTeam) >= 2 and (prevLeader != currLeader):
        # 兩隊高度延伸：同陣營（尤其雙藍）相容度上升
        if (prevLeader not in world.evils) and (currLeader not in world.evils):
            ll += alpha_extend   # 建議網格測試 0.15 ~ 0.35
    if (selfSeat not in currTeam) and isCleanInPublic(selfSeat) and currLeader in world.evils:
        # 在無失敗紀錄下刻意迴避已知好人 selfSeat
        if conflictsWithPriorConsensus(currTeam, prevTeam):
            ll += alpha_exclude  # 建議網格測試 0.10 ~ 0.25
    return ll

```

### 3. 預期效果與風險

* **預期效果**：Q1 中 4 家延伸 1 家將把 1 家紅機率明顯拉低、同時把無故排 5 且拆車的 3 家推至前 2–3 高；Q2 中 7、9 家重複派 0 家不再連乘過度計數，派西能正確將 1 家讀往梅林端並將 0 家送進紅機率前 4；同時 `bot:calibration` 的 ECE 與 Platt 斜率預期同步改善。

* **風險**：若 `alpha_extend` 設太高，紅方雙壞刻意互相延伸疊票時會獲得額外假信任，因此須限制加成上限（不高於 0.35）並接受 §1F 與 ECE 檢驗。

## 問題二：藍方第 3 局以後自己在隊上太常內黑（占投票差異 30–38%）

### 1. 現有做法錯誤指正與根因推論

* **出處**：PR #146 強者重播比較、`docs/ai/optimization_loop.md` 第 53b / 57 回合（`blueVoteTemper57`、Platt 斜率 0.74）。

* **機器人為何一直內黑、強者為何投贊成**：

  1. **絕對門檻 vs 相對期望值（Outside Option）**：機器人看到自己在車上但「隊友 3–4 人全好機率低於門檻（例如 45%）」就投內黑，完全沒問「我把這車反掉之後，下一輪或尾家強制局的隊伍真的會更乾淨嗎？」。真人強者明白：第 3 局起自己已在車上，代表車上至少鎖住 1 席必好；若當局尾家可疑（或後位派票權偏向紅方），反掉眼前這車只會讓期望值更差。

  2. **忽略第 4 局保護局（2 敗才開紅）的容錯**：第 4 局（5 人隊）含 1 紅依然會開藍，藍方該評估的是「**至少 2 紅的機率**」，而非「至少 1 紅的機率」。

  3. **忽略比分壓力差異**：在 0:2 紅方聽牌（容錯 0）才應積極內黑保尾；在 2:0、2:1（藍方聽牌，容錯 1–2 局）或 1:1 時，自己在隊上亂內黑不只浪費乾淨車，還會讓隊友誤判你在搞事、後續不再派你。

  4. **信念過度自信放大內黑**：Platt 斜率 0.74 代表機器人把 60% 的懷疑算成 75%，進一步觸發不必要的內黑。

### 2. 具體可測改法（建議開關：`innerBlackEvGate59`）

* **合法資訊範圍**：僅使用自己身分、目前比分、當局剩餘提議次數、尾家座位、當前隊伍與自己視角的後驗世界分布。

* **核心規則（Continuation-Value EV 決策閘門）**：藍方在隊上時，預設投贊成（內白），**僅在「反掉後的期望過關率顯著高於當前隊伍」時才投內黑**。

```
function shouldBlueVoteInnerBlack(selfSeat, round, proposalIdx, scoreBlue, scoreRed, currentTeam, tailLeader, posteriorWorlds):
    # 計算當前隊伍的任務成功機率（第 4 局為 evils <= 1，其餘為 evils == 0）
    maxAllowedEvils = (round == 4) ? 1 : 0
    p_curr_success = sum(w.prob for w in posteriorWorlds if countEvils(currentTeam, w) <= maxAllowedEvils)

    # 估計若流到尾家強制局（或由尾家主導）的期望成功機率
    # 若尾家是自己：以自己視角最佳合法隊伍的全好機率作為 p_tail
    # 若尾家是別人：依尾家為藍/紅的後驗機率加權計算（紅方尾家預設高機率放足量紅）
    if tailLeader == selfSeat:
        p_tail_success = bestTeamSuccessProb(selfSeat, round, posteriorWorlds)
    else:
        p_tail_blue = 1.0 - marginalEvilProb(tailLeader, posteriorWorlds)
        p_tail_success = p_tail_blue * expectedBlueTailSuccess(round, posteriorWorlds) + (1.0 - p_tail_blue) * 0.08

    # 依比分與局數設定安全邊際 margin（避免非聽牌局無謂內黑）
    if scoreRed == 2 and round != 4:
        margin = 0.05   # 紅方聽牌且無保護局：只要尾家略好就果斷保尾
    elif round == 4:
        margin = 0.18   # 保護局容許 1 紅，內黑門檻大幅拉高
    elif scoreBlue == 2:
        margin = 0.22   # 藍方聽牌：任務容錯高，非必要不亂內黑暴露或破壞共識
    else:
        margin = 0.15   # 1:1 / 0:1 一般局勢

    return (p_tail_success - p_curr_success) > margin

```

### 3. 預期效果與風險

* **預期效果**：直接消除第 3 局起「尾家並不可信卻仍機械內黑」與「第 4 局保護局把單紅當雙紅內黑」的兩大誤差來源，大幅縮短 PR #146 與強者的投票距離（預計消減 30–38% 投票差異中的過半數），且藍方不會錯失可提前通過的乾淨車。

* **風險**：若 `margin` 設太高，在 0:2 聽牌局梅林可能不夠果斷保尾，因此必須將 `scoreRed == 2`（紅方聽牌）獨立設為低門檻 `0.05`。

## 問題三：「1-1～1-4 照第 5 次派」的兩難（如何不讓梅林多死 5pp）

### 1. 現有做法錯誤指正與根因推論

* **出處**：`docs/ai/optimization_loop.md` 第 56 回合（`goLike56` 篩選 `-2.58 / -2.30`，梅林被刺中多 5pp）。

* **根因**：

  * 在 1-1～1-4 時，公開資訊極少，忠臣的「第 5 次標準派法」本質上帶有高熵（均勻區間切割）。

  * 但當梅林也直接套用「照強制局全力挑最乾淨隊伍（`argmax` 無拇指）」時，梅林在 1-1～1-4 就會系統性地 **100% 避開 3 根可見紅方**（實證中這會創造高達 3.5 倍的對數似然比）。刺客在機器人互打時只要累積 1-1～1-4 與 2-1～2-4 的「零可見紅」派票紀錄，就能精準鎖定梅林。

  * 換言之：**忠臣與派西在 1-1～1-4 照第 5 次派是正 EV，但梅林在 1-1～1-4 必須受「公開忠臣分布」約束，不能直接最大化私人無拇指分數。**

### 2. 具體可測改法（建議開關：`merlinPublicMask59`）

* **合法資訊範圍**：梅林的私人拇指清單（3 名可見紅方）＋ 當下所有玩家共有的公開盤面。

* **核心規則（公開可行集過濾 ＋ 溫度抽樣）**：

  1. **忠臣與派西**：在 1-1～1-4 可安心啟用 `goLike56`（照第 5 次派，強化區間品質與全好隊率）。

  2. **梅林在 1-1～1-4（非強制局）**：

     * 先跑一次**純忠臣公開視角**評分，取出公開合理分數前 `K` 名（例如前 25% 或與最高分差距在 `0.04` 內）的候選隊伍集合 `C_public`。

     * 從 `C_public` 中篩出「不含可見紅方」的子集 `C_clean`。

     * **不要硬取 `argmax`**，而是依公開分數做 **Softmax 溫度抽樣**（`tau = 0.15`），並對「前人剛派過且公開看來最像好人的隊伍」保持自然延伸，避免做出「只有看過拇指才會想到的跳躍式閃避」。

     * 同時保留「**1-1～1-4 區間切割**」特性：不刻意每次都把自己放進最極端乾淨的冷門組合。

```
function merlinPickNonForced(round, proposalIdx, publicPosterior, visibleEvils):
    # 1. 只用公開資訊計算所有合法隊伍的忠臣合理分數
    scoredTeams = [(T, loyalPublicScore(T, publicPosterior)) for T in allLegalTeams(round)]
    maxPub = max(s for _, s in scoredTeams)

    # 2. 限制在「刺客眼中像忠臣會派」的公開可行集內
    publicFeasible = [(T, s) for (T, s) in scoredTeams if (maxPub - s) <= delta_pub]
    cleanFeasible = [(T, s) for (T, s) in publicFeasible if countIntersection(T, visibleEvils) == 0]

    if len(cleanFeasible) > 0:
        # Softmax 抽樣而非硬性 argmax，降低刺客的確定性鎖定
        return softmaxSample(cleanFeasible, temperature=0.15)
    else:
        # 進入問題四的「逼不得已」判斷邏輯
        return merlinForcedThumbDecision(round, proposalIdx, scoredTeams, visibleEvils)

```

### 3. 預期效果與風險

* **預期效果**：保留忠臣／派西在 1-1～1-4 照第 5 次派帶來的全好隊提升，同時把梅林在 1-1～1-4 的派票分布限制在忠臣公開可行集內，把刺殺暴露風險（多出的 5pp）壓回基準線甚至更低。

* **風險**：若 `delta_pub` 設太窄，可能過早觸發派拇指；建議在 `0.04 ~ 0.08` 區間掃描，並同時監控三藍率與刺中率兩項指標。

## 問題四：梅林派隊時，如何量化判斷「逼不得已」只能派拇指

### 1. 現有做法錯誤指正與根因推論

* **出處**：`docs/ai/optimization_loop.md` 第 54 回合（`merlinKnownRed54=7`）、站長 11/20 原則。

* **核心矛盾**：若完全禁止梅林派拇指，在「公開共識極度指向某位可見紅方（例如莫甘娜或隱藏刺客）」時，梅林硬把對方踢出隊伍會立刻暴露超前資訊、三藍後必被秒刺；但若太寬鬆允許梅林派拇指，又會為了躲刺而直接輸掉任務（違反「任務第一、躲刺第二」）。

### 2. 具體可測改法（建議開關：`merlinForcedThumbGate59`）

* **合法資訊範圍**：梅林的公開忠臣後驗分布 `P_loyal`、自身可見的 3 名紅方 `visibleEvils`、目前比分與局數。

* **「逼不得已」的嚴格量化條件（三條件同時成立才允許派恰好 1 根拇指）**：

  1. **局勢安全條件（絕不送局）**：不得處於紅方聽牌（`scoreRed == 2` 且非第 4 局）或 2:2 決勝局；僅在「非強制提議（預期被否決）」或「第 4 局保護局（隊中只放 1 拇指不致開紅）」或「藍方 2:0 領先」時允許考慮。

  2. **公開共識落差條件（超前資訊量超標）**：令 `T_pub*` 為純公開視角的最佳隊伍，`T_clean*` 為「不含任何可見紅方」的最佳隊伍。計算兩者在公開視角的分數落差 `pubGap = S_pub(T_pub*) - S_pub(T_clean*)`，以及 `T_clean*` 在所有隊伍中的公開百分位排名 `rankPct(T_clean*)`。只有當 **`pubGap > theta_gap`（例如 0.12）且 `rankPct(T_clean*)` 掉出前 35%**（代表不派拇指在忠臣眼中完全說不通），才判定為「逼不得已」。

  3. **最小傷害約束**：觸發後**嚴格最多只放 1 根拇指**（挑選公開評價最高的那 1 位可見紅方，絕不放 2 根），且其餘名額仍從無拇指候選中取公開最優者。

```
function merlinForcedThumbDecision(round, proposalIdx, scoredTeams, visibleEvils, scoreBlue, scoreRed):
    # 條件 1：紅方聽牌非保護局，任務永遠第一，絕不主動派可見紅
    if (scoreRed == 2 and round != 4) or (round == 5):
        return argmax([(T, s) for (T, s) in scoredTeams if countIntersection(T, visibleEvils) == 0])

    # 計算公開最佳 vs 無拇指最佳的落差
    T_pub_best, S_pub_best = argmax(scoredTeams)
    cleanTeams = [(T, s) for (T, s) in scoredTeams if countIntersection(T, visibleEvils) == 0]
    T_clean_best, S_clean_best = argmax(cleanTeams)

    pubGap = S_pub_best - S_clean_best
    cleanRankPct = percentileRank(S_clean_best, scoredTeams)  # 0.0 = 最高分, 1.0 = 最低分

    # 條件 2：公開可行集真空（不派拇指會明顯暴露超前資訊）
    isSafeSpot = (proposalIdx < 5) or (round == 4) or (scoreBlue == 2 and scoreRed == 0)
    if isSafeSpot and (pubGap > 0.12) and (cleanRankPct > 0.35):
        # 條件 3：最小傷害——恰好只放 1 根公開最像好人的拇指
        oneThumbTeams = [(T, s) for (T, s) in scoredTeams if countIntersection(T, visibleEvils) == 1]
        return argmax(oneThumbTeams)

    return T_clean_best

```

### 3. 預期效果與風險

* **預期效果**：把站長「除非逼不得已，否則不派拇指」的質化心法轉為可回測、可掃參的精確判準（`theta_gap` 與 `cleanRankPct`）；在一般局勢維持任務勝率，在公開共識一面倒指向某紅方時避免無謂暴露，拉高「三藍活」最終勝率。

* **風險**：若非強制局被紅方突然外白強推通過（特別是第 2、3 局），梅林派進 1 根拇指會造成該局開紅；因此第 2、3 局若發現場上外白風險高（例如 0:1 時），可將 `theta_gap` 再調嚴（例如 0.18）。

## 問題五：紅方派隊太好認（一隊放兩紅「太送」）與奧伯倫首局藏牌

### 1. 現有做法錯誤指正與根因推論

* **實證證據**：針對 142 局實戰盤面進行的行為審計顯示，紅方在 R1 派 2 紅佔 **49.5%**（136/275）、R2 派 2 紅以上佔 **69.3%**（203/293）、R3 派 2 紅以上佔 **59.6%**（164/275）。一旦機器人紅方複製甚至放大這種「一隊塞兩紅」的習慣：

  1. **直接送出藍方推論訊號**：只要對面（或貝氏推論引擎）納入紅方派票分布，看到某隊長連塞兩名紅方隊友，就會同時把該隊長與隊友整串鎖死（正如 v2 貝氏模型把刺客踩雷壓低到僅 12 次）。

  2. **無謂暴露隊友並浪費位階保護**：非保護局只要 1 張失敗就能開紅，塞兩紅進車既沒增加破壞成功率，反而讓隊友一起承擔任務失敗後的交集嫌疑（尤其害莫德雷德喪失乾淨人設）。

* **奧伯倫第 1 局藏牌的結構性錯誤**：

  * 根據平台 2,342 局總覽數據，**第 1 局成功時藍方勝率 40%，第 1 局失敗則暴跌至 24%**（差距高達 16 個百分點）。

  * 奧伯倫不與隊友相認，第 1 局僅 3 人任務，在沒有確切資訊證明車上有相認紅方時藏牌，大機率直接白送藍方第 1 局成功，違反 [奧伯倫百科原則](https://avalon-game-platform.web.app/wiki-md/wiki-21.md)「進任務預設出失敗」。

### 2. 具體可測改法（建議開關：`evilPickOneRed59` + `oberonR1AlwaysFail59`）

* **合法資訊範圍**：紅方相認名單（莫德雷德、莫甘娜、刺客互認，不知奧伯倫）、奧伯倫僅知自己為紅方、以及公開盤面資訊。

* **具體規則**：

  1. **紅方派票「精準單紅＋公開偽裝」（`evilPickOneRed59`）**：

     * **非第 4 局保護局**：紅方隊長的目標隊伍應優先滿足「**隊內恰好 1 名已知紅方**（自己或 1 位隊友）」，其餘名額直接挑選**公開忠臣評分最高的好人**。對隊內含 2 名以上已知紅方施加懲罰 `penalty_multi_evil`（僅在「該隊友已成全場鐵好共識、不帶反而可疑」時才豁免）。

     * **第 4 局保護局（需 2 敗）**：改為目標「**恰好 2 名已知紅方**」，確保開紅能力。

     * **莫德雷德保護條款**：刺客或莫甘娜派隊時，若自己已在隊上，優先不帶莫德雷德，保留莫德雷德的場外乾淨度以滲透後續尾家局。

  2. **奧伯倫首局強制出失敗（`oberonR1AlwaysFail59`）**：

     * 第 1 局奧伯倫上車：**100% 出失敗**（不藏牌）。

     * 第 2 局以後：預設仍出失敗，**僅在公開後驗推算「隊內其他成員至少含 1 名相認紅方且會出失敗」的機率大於 0.70 時**（非保護局），才允許以低機率藏牌。

```
# 開關 1：紅方精準單紅與公開偽裝派票 (evilPickOneRed59)
function evilScoreTeam(selfSeat, selfRole, round, team, knownEvils, publicPosterior):
    k_known = countIntersection(team, knownEvils)
    pub_score = loyalPublicScore(team, publicPosterior)

    if round == 4:
        # 保護局需 2 敗：目標恰好 2 名已知紅方
        role_bonus = (k_known == 2) ? +0.60 : ((k_known == 1) ? +0.10 : -0.50)
    else:
        # 一般局只需 1 敗：偏好恰好 1 紅，重罰無謂塞 2 紅以上
        if k_known == 1:
            role_bonus = +0.50
        elif k_known >= 2:
            # 僅當第二位隊友在公開視角極度乾淨（排名前 20%）時減輕懲罰
            role_bonus = isSecondEvilPublicConsensus(team, knownEvils, publicPosterior) ? -0.10 : -0.65
        else:
            role_bonus = -0.30   # 送全好車僅在極少數買信局使用

    # 若自己是刺客/莫甘娜且自己已在車上，避免無故把莫德雷德拖進失敗交集
    if (selfRole in [ASSASSIN, MORGANA]) and (selfSeat in team) and (mordredSeat in team) and (round != 4):
        role_bonus -= 0.25

    return pub_score + role_bonus

# 開關 2：奧伯倫出牌規則 (oberonR1AlwaysFail59)
function oberonShouldFail(round, team, selfSeat, publicPosterior):
    if round == 1:
        return True   # 第 1 局硬規則：絕對不藏，搶下 -16pp 藍方勝率槓桿
    if round == 4:
        return True   # 保護局需 2 敗，奧伯倫必須補失敗張數
    # 第 2、3、5 局：除非高度確信隊友裡已有相認紅方會出失敗，否則預設出失敗
    p_other_evil = probTeamHasAnotherEvil(team - {selfSeat}, publicPosterior)
    return (p_other_evil < 0.70)

```

### 3. 預期效果與風險

* **預期效果**：紅方派票會更貼近真人高階桌（減少「一隊兩紅太送」的明顯破綻），同時莫德雷德存活乾淨度提升、奧伯倫不再白送第 1 局成功；預期在紅方回合自我對打勝率上升且 §1F 對強者距離縮短。

* **風險**：若紅方過度執著於「恰好 1 紅」而在 2:0 落後或 1-5 強制局時不敢送全好買信，行為可能略微僵化，因此保留 `k_known == 0` 的微幅探索空間（`-0.30` 而非 `-∞`）。

## 建議 Claude 實測優先序

1. **第一批（直接解鎖第 59 回合與驗收題）**：先實作 `innerBlackEvGate59`（問題二）與 `loyalCopyCap59 + seqIntent59`（問題一），優先驗證 `scripts/acceptRound53.ts`（Q1/Q2）、`bot:calibration`（ECE）與 PR #146 強者投票距離。

2. **第二批（梅林雙開關）**：實作 `merlinPublicMask59`（問題三）＋ `merlinForcedThumbGate59`（問題四），在 5 萬局篩選確認「三藍率上升且刺中率不惡化」。

3. **第三批（紅方回合）**：實作 `evilPickOneRed59` ＋ `oberonR1AlwaysFail59`（問題五），依 §1 紅方回合協定與 §1F 強者距離驗收。