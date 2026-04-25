# ELO 結局歸因方法論 (Outcome-Conditional Role Attribution)

> **文件用途**：本文件是 avalonpediatw ELO 排名系統中「per-結局 × per-角色 K-factor」的設計規格。
> 目標讀者：接手此系統的工程師 / 數據師 / 產品設計。
>
> **作者意圖**：給出三條可實作的方法論路徑、每條的數學形式、對 2146 場牌譜的應用方式、以及推薦演進路徑。本文件**不**規定 α 常數、**不**包含 TypeScript 實作，那些屬於 `packages/server/src/services/Elo*.ts`。
>
> **版本**：v1.2 · 2026-04-22 · 加入 §2.3.5 Phase 2.5 完整 4 因子規格（Information / Misdirection / Seat order）。v1.1 2026-04-22 Naming Alignment。v1.0 2026-04-20。

---

## 0.0 Naming Alignment（DG D, 2026-04-22）

本 doc 歷史版本用「方法學 Phase」命名三種歸因路徑（啟發式 / logistic / Shapley），**與** issue **#54** 的「實作路線 Phase」**編號正交、不可混用**。統一如下：

| 層次 | Phase 1 | Phase 2 | Phase 2.5 | Phase 3 |
|---|---|---|---|---|
| **#54 實作路線**（專案里程碑） | data-driven config（outcome × role 乘法） | per-event attribution factor（Proposal + OWIB，本文 §2.3 啟發式） | Information + Misdirection factor（本文 §2.3 延伸） | backtest + feature-flag 切換（可選 §2.2 logistic 當 weight tuner） |
| **本 doc 方法學**（數學路徑） | — | §2.3 **啟發式規則版** | §2.3 延伸 | §2.2 **Logistic Regression**（tuner）+ §2.1 **Shapley**（研究基準，可選）|

**重點**：
- #54 **Phase 2** 所做的「per-event attribution factor」**是本 doc §2.3 啟發式方法的實作**（`ProposalFactor.ts` + `OuterWhiteInnerBlackFactor.ts`）。
- #54 **Phase 3** 的 historical backtest 可用本文 §2.2 logistic regression 做 factor weight tuning。
- §2.1 Shapley Value 留作**研究基準**，非交付路徑。
- 下方 §2 各方法的「推薦時機 Phase N」欄位（table line 29-31、line 175/290/344）保留當歷史參考；以本段 naming 表為準。

---

## 0. Executive Summary

Avalon 有**三種結局**：
1. **三藍 (Good Wins via 3 Quest Successes)** — 藍方連勝三次任務且刺客未刺中梅林
2. **三紅 (Evil Wins via 3 Quest Failures)** — 紅方成功破壞三次任務
3. **三藍死 (Evil Wins via Assassin)** — 藍方連勝三次但刺客刺中梅林

標準 ELO 用**單一 K-factor** 對所有結局一視同仁是**不公平的**，因為：

- **三紅結局**中，投下失敗票的紅方玩家實際貢獻 >> 從未上隊的紅方玩家
- **三藍死結局**中，刺客的刺殺技術 >> 其他紅方的潛伏能力；對藍方則是「梅林暴露自己」的懲罰，與派西的「保護失效」的懲罰
- **三藍結局**中，刺客的失誤（沒刺中梅林）是負貢獻；藍方則是均衡分配的勝利

**本文件給出三種歸因方法**（依嚴謹度排序）：

| 方法 | 理論基礎 | 計算複雜度 | 資料需求 | 推薦時機 |
|------|---------|-----------|---------|---------|
| **啟發式規則版** | 遊戲結構直覺 | O(1) | 零 | MVP / Phase 1 |
| **Logistic Regression** | 統計推論 | O(n · k) 訓練 | 中 (>500 場) | Phase 2 |
| **Shapley Value** | 合作博弈論公設 | O(2^n) exact / O(m·n) sampling | 高 (需 simulator 或大量 coalition 資料) | Phase 3 / 研究 |

**推薦路徑**：MVP 上線用啟發式；累積 >2000 場後校正；>5000 場後升級 logistic；Shapley 作為研究基準。

---

## 1. 問題定義

### 1.1 Avalon 結構摘要

**盤面**：5~10 人。角色分兩陣營：

- **藍方（Good / Resistance）**：梅林（知道所有紅方，除莫德雷德）、派西（知道梅林+莫甘娜但不分辨）、忠臣（無資訊）
- **紅方（Evil / Spies）**：刺客（終局刺梅林）、莫甘娜（偽裝梅林給派西）、莫德雷德（對梅林隱身）、奧伯倫（對紅方隱身）、一般紅方

**勝負條件**：
- **藍勝**：5 輪任務中藍方連贏 3 次，且終局刺客**未**刺中梅林
- **紅勝 (三紅)**：5 輪任務中紅方連贏 3 次（任務中放 1 張以上失敗票）
- **紅勝 (刺殺)**：藍方連贏 3 次但刺客在終局刺殺階段正確指認梅林

### 1.2 標準 ELO 在 Avalon 的不公平性

單 K-factor ELO 假設：**一場比賽 = 單一貢獻向量 × 單一結果**。

在 Avalon，此假設**結構性地破產**：

**案例 A (三紅)**：紅方 A 在第 1、2、3 輪都上隊放了失敗票；紅方 B 始終沒被選上隊。兩者在「三紅」結局裡加同樣的分顯然錯誤——A 的行為可複製、可學習、可優化；B 可能只是運氣好被信任。

**案例 B (三藍死)**：這是**兩個事件的複合**——藍方贏了任務階段（應加分）**但**梅林被刺（應扣分）。對刺客而言，是**從必敗扭轉到勝利**的關鍵一擊，K 值應遠高於三紅的紅方玩家。對梅林而言，「暴露身分」是 skill-based 失敗，K 扣分應 >> 派西與忠臣。

**案例 C (三藍)**：刺客沒刺中是**失敗行為**，如果跟其他紅方一樣扣同樣分數，會過度懲罰無辜紅方（他們沒機會行動）。

### 1.3 為何需要「per-outcome × per-role」K

正式化：定義 ELO 更新為
```
ΔR_i = K_{outcome, role_i} × (S_{team_i} - E_{team_i})
```
其中：
- `i` 為玩家
- `outcome ∈ {三藍, 三紅, 三藍死}`
- `role_i ∈ {梅林, 派西, 忠臣, 刺客, 莫甘娜, 莫德雷德, 奧伯倫}`
- `S_{team_i}` 是該玩家陣營的實際得分 (1/0)
- `E_{team_i}` 是該玩家陣營的期望勝率（由雙方平均 ELO 算出）

**核心問題**：K 矩陣 (3 × 7) 的 21 個權重該怎麼設？

---

## 2. 三種歸因方法

### 2.1 方法 A：Shapley Value（理論最優）

#### 2.1.1 定義

給一個合作博弈 `(N, v)`，其中 `N` 是玩家集合、`v: 2^N → ℝ` 是價值函數（某 coalition 的總收益）。玩家 `i` 的 Shapley Value 為：

```
φ_i(v) = Σ_{S ⊆ N \ {i}} [ |S|! · (n - |S| - 1)! / n! ] · [v(S ∪ {i}) - v(S)]
```

**直覺**：把所有 `n!` 種可能的玩家入場順序平均起來，每個玩家的「邊際貢獻」（他加入後 coalition 價值的增量）的平均值，就是他該拿的份額。

#### 2.1.2 四大公設（Shapley 1953）

Shapley Value 是**唯一**同時滿足以下四條性質的分配：

1. **Efficiency（總和守恆）**：Σ φ_i = v(N)
2. **Symmetry（對稱性）**：若兩玩家對所有 coalition 的邊際貢獻相同，則得分相同
3. **Linearity（線性性）**：v = v₁ + v₂ ⇒ φ_i(v) = φ_i(v₁) + φ_i(v₂)
4. **Null Player（空玩家）**：若玩家對所有 coalition 無貢獻，φ_i = 0

這四條對應到 Avalon：
- **Efficiency** ↔ 總 K-factor 預算守恆（三紅總 K = 三藍總 K）
- **Symmetry** ↔ 兩個角色若等價（如兩個忠臣），K 相同
- **Linearity** ↔ 結局獨立處理後可疊加
- **Null Player** ↔ 「從不上隊且不發言」的玩家得 0

#### 2.1.3 應用到 Avalon 的 Shapley 計算

**設定**：角色集合 `N_role = {梅林, 派西, 忠臣, 刺客, 莫甘娜, 莫德雷德, 奧伯倫}`。價值函數 `v(S)` 定義為「只有 S 中的角色存在時，該陣營勝率」。

**資料來源**：2146 場 `牌譜` 資料，按配置分組：

| 配置 ID | 角色集合 S | 場數 | 勝率 v(S) |
|---------|-----------|------|----------|
| C1 | {梅林, 派西, 刺客, 莫甘娜, 3×忠臣} | ~800 | 0.34 |
| C2 | {梅林, 刺客, 莫甘娜, 3×忠臣} | ~200 | 0.29 |
| C3 | {梅林, 派西, 刺客, 莫甘娜, 莫德雷德, 3×忠臣} | ~300 | 0.31 |
| ... | ... | ... | ... |

實際 2146 場切片要由 `packages/server/src/utils/sheet_parser.py` 出分佈報告。

**偽程式碼**（exact Shapley）：

```
function shapley_exact(roles, v):
    n = |roles|
    phi = {role: 0 for role in roles}
    for each permutation π of roles:        # n! 種
        S = {}
        for role in π:
            marginal = v(S ∪ {role}) - v(S)
            phi[role] += marginal
            S = S ∪ {role}
    for role in roles:
        phi[role] /= n!
    return phi
```

**複雜度**：`n = 7` → `7! = 5040` 次 `v(S)` 查詢。若每次查詢都需要至少 ~100 場資料做穩定勝率估計，則需 `5040 × 100 = 504,000` 場——**遠超過 2146 場牌譜量**。

#### 2.1.4 Monte Carlo 近似（解決樣本稀疏）

Castro et al. (2009) 提出的**排列採樣法**：

```
function shapley_mc(roles, v, m):
    n = |roles|
    phi = {role: 0 for role in roles}
    for k in 1..m:                          # m 次採樣
        π = random_permutation(roles)
        S = {}
        for role in π:
            marginal = v_hat(S ∪ {role}) - v_hat(S)   # v_hat 用 2146 場估計
            phi[role] += marginal
            S = S ∪ {role}
    for role in roles:
        phi[role] /= m
    return phi
```

**複雜度**：O(m · n)，典型 m = 1000 → 7000 次查詢。**但仍需大量 coalition v(S) 資料**，而 Avalon 的配置是由規則決定（不能任意拆角色），所以**無法直接拿到 v({梅林, 刺客}) 這種 coalition 的實際資料**。

**解套**：用「配置替換」近似——用梅林缺席的盤（`v(N \ {梅林})`）作為 baseline。但 Avalon 規則中梅林必在，所以需要**模擬器**生成反事實資料。這是 Shapley 路徑的**最大障礙**。

#### 2.1.5 優缺點

| 項目 | 評估 |
|------|------|
| 理論嚴謹 | 最強，四公設唯一解 |
| 實作難度 | 高（需模擬器 + 大量 coalition 採樣） |
| 資料需求 | 2146 場不夠，需 simulator 補反事實 |
| 可解釋性 | 公式固定，不易 cherry-pick |
| 適用時機 | 研究論文級 / Phase 3 |

---

### 2.2 方法 B：Logistic Regression（資料驅動近似）

#### 2.2.1 核心構想

把「結局」當成 binary outcome，把「角色配置」當成 feature，擬合 logistic regression，**係數就是邊際貢獻**。

**設定**：對**每個結局類型分別訓練一個模型**（共 3 個）。以「三紅」為例：

```
y = 1   若結局 = 三紅
y = 0   否則

features x = (x_梅林, x_派西, x_刺客, x_莫甘娜, x_莫德雷德, x_奧伯倫, x_忠臣_count, ...)
其中 x_梅林 ∈ {0, 1} 表示該場是否有梅林（或更進階的 interaction term）
```

模型：
```
P(y = 1 | x) = σ(β₀ + Σ βᵢ · xᵢ)
```

**係數 β 的解讀**：`βᵢ` 代表「有角色 i」相對「無角色 i」改變三紅結局 log-odds 的量。

#### 2.2.2 從係數到 K-factor

直接用 β 當 K-factor **不對**——K 是 ELO 分步幅度，β 是 log-odds。需要**標準化變換**：

```
K_{outcome, role} = K_base × normalize(|β_role^{outcome}|) × sign(role 屬於勝方)
```

其中：
- `K_base` 是基準 K（例：32，如 FIDE 傳統）
- `normalize(·)` 把所有 β 縮到 [0.5, 2.0] 倍區間（避免極端值）
- `sign(·)` 處理「勝/負貢獻」方向（如三藍時刺客是負貢獻）

**更穩健的版本**：用**交互項**（interaction term）捕捉「角色 A × 角色 B 共同在場」的效應：

```
features = [x_梅林, x_派西, x_莫德雷德, x_梅林 × x_莫德雷德, ...]
```

這能抓到「有莫德雷德時梅林價值下降」這類結構性互動。

#### 2.2.3 2146 場的套用步驟

1. **資料萃取**（from Google Sheets 牌譜）：
   - 每場一列：`match_id, player_ids, roles[], winner, outcome_type, final_elo_snapshot`
   - 派生欄位：`outcome_type ∈ {三藍, 三紅, 三藍死}`

2. **三個模型**：
   - 模型 1：`y = [outcome == 三紅]`，擬合係數 β⁽³紅⁾
   - 模型 2：`y = [outcome == 三藍]`，擬合係數 β⁽³藍⁾
   - 模型 3：`y = [outcome == 三藍死]`，擬合係數 β⁽刺殺⁾

3. **K 矩陣填值**：
   - 對 (outcome, role) 格子，用該 outcome 模型的對應角色係數轉成 K

4. **交叉驗證**：5-fold CV，確保係數穩定。不穩定的係數（標準差 > 50% 均值）改用啟發式 fallback。

#### 2.2.4 偽程式碼

```python
import numpy as np
from sklearn.linear_model import LogisticRegression

def fit_role_contribution(games, outcome_label):
    """
    games: list of {roles: [set], outcome: str, winner_team: str}
    outcome_label: "三紅" | "三藍" | "三藍死"
    """
    X = []
    y = []
    role_vocab = ["梅林", "派西", "刺客", "莫甘娜", "莫德雷德", "奧伯倫"]
    for g in games:
        x = [1 if r in g.roles else 0 for r in role_vocab]
        # 加 interaction term
        x += [x[role_vocab.index("梅林")] * x[role_vocab.index("莫德雷德")]]
        X.append(x)
        y.append(1 if g.outcome == outcome_label else 0)

    model = LogisticRegression(penalty="l2", C=1.0).fit(X, y)
    return {
        "coefs": dict(zip(role_vocab + ["梅林×莫德雷德"], model.coef_[0])),
        "intercept": model.intercept_[0],
        "accuracy": model.score(X, y),
    }

def derive_k_matrix(games, K_base=32):
    K = {}
    for outcome in ["三紅", "三藍", "三藍死"]:
        res = fit_role_contribution(games, outcome)
        # 正規化到 [0.5, 2.0]
        max_abs = max(abs(b) for b in res["coefs"].values())
        for role, beta in res["coefs"].items():
            K[(outcome, role)] = K_base * (0.5 + 1.5 * abs(beta) / max_abs)
            # sign: 勝方正，負方負
            if (outcome in ["三紅", "三藍死"]) and role in GOOD_ROLES:
                K[(outcome, role)] *= -1
    return K
```

#### 2.2.5 優缺點

| 項目 | 評估 |
|------|------|
| 理論基礎 | 統計推論，可接受 |
| 實作難度 | 中（scikit-learn 一個 pipeline） |
| 資料需求 | 中，2146 場「夠用但勉強」；建議 >5000 場 |
| 可解釋性 | 高（係數就是答案） |
| 風險 | 配置 imbalance（奧伯倫場次 n=226 vs 梅林 n=1000+）→ 奧伯倫係數 confidence 弱 |
| 適用時機 | Phase 2（資料累積到 >1000 場） |

---

### 2.3 方法 C：啟發式規則版（Heuristic / Structural）

#### 2.3.1 核心構想

不依賴資料，直接用 Avalon 的**遊戲結構**與**社群共識**寫死 K 規則。優點是**零冷啟動成本**，缺點是**依賴作者直覺**（但可被後續資料校正）。

#### 2.3.2 建議規則集（MVP 起手式）

```
K 矩陣（建議初值，單位：ELO 點數）：

                  三藍     三紅     三藍死
梅林              +25      -15      -40      ← 三藍死扣大，因暴露身分是技術失敗
派西              +20      -15      -25      ← 保護梅林失敗扣
忠臣              +20      -15      -15      ← 結構性無影響，均攤
刺客              -30      +25      +45      ← 三藍死刺中是關鍵一擊；三藍沒刺中重罰
莫甘娜            -20      +25      +20      ← 偽裝梅林成功是核心貢獻
莫德雷德          -20      +25      +20      ← 對梅林隱身幫助大
奧伯倫            -15      +20      +15      ← 結構弱紅方，K 略小
```

**設計邏輯**：
- **刺客的三藍死 K = +45**：這是最高單點，反映「從必敗扭轉」的技術價值
- **梅林的三藍死 K = -40**：第二高（負），反映「暴露身分」的失敗
- **忠臣的 K 變化 ±15**：低於關鍵角色，反映結構性「無主動貢獻」但仍分擔結果
- **奧伯倫 K 最小**：因為他對紅方隱身、資訊最差，主動貢獻受限

#### 2.3.3 與資料校正的 hook

即便起手式是啟發式，仍應**保留資料校正通道**：

```
K_calibrated(outcome, role) = K_heuristic(outcome, role) × calibration_factor(outcome, role)

其中 calibration_factor 從 2146 場滾動更新：
    empirical_impact = 該角色在該結局的實際勝率偏離 / 平均偏離
    calibration_factor = clamp(empirical_impact, 0.7, 1.3)
```

這樣啟發式當**先驗**，資料當**後驗**，避免早期樣本少時完全漂移。

#### 2.3.4 優缺點

| 項目 | 評估 |
|------|------|
| 理論基礎 | 結構直覺 + 社群共識（非嚴格） |
| 實作難度 | 極低（一個查表） |
| 資料需求 | 零（可以 day-1 上線） |
| 可解釋性 | 極高（每個值都可以講故事） |
| 風險 | 作者偏見、社群共識可能偏離 empirical 真相 |
| 適用時機 | MVP / Phase 1，累積資料期 |

---

### 2.3.5 Phase 2.5 完整 4 因子規格（2026-04-22）

Edward 2026-04-20 原話列的 4 個因果因子 + 順位加成在 #54 Phase 2.5 實作完成。Phase 2 只上 §2.3.2 提到的 Proposal + OWIB，Phase 2.5 補上 Information + Misdirection + Seat。

**四因子對應 Edward 原話**：

| 順位 | Edward 原話 | 實作 | 陣營 | 檔案 |
|------|------------|------|------|------|
| 1 | 梅林/派西 資訊釋放品質 | InformationFactor | 好人限定 | `InformationFactor.ts` |
| 2 | 忠臣提案的合理性 | ProposalFactor（Phase 2） | 雙向 | `ProposalFactor.ts` |
| 3 | 紅方誤導效果 | MisdirectionFactor | 壞人限定 | `MisdirectionFactor.ts` |
| 4 | 外白內黑時機 | OuterWhiteInnerBlackFactor（Phase 2） | 壞人限定 | `OuterWhiteInnerBlackFactor.ts` |
| +α | 順位 × 角色 | SeatOrderAdjustment | 乘法 modifier（非加法） | `SeatOrderAdjustment.ts` |

**公式（Phase 2.5 完整）**：

```
rawFactorSum(player) =
    weights.proposal              × proposalScore(player)
  + weights.outerWhiteInnerBlack  × owibScore(player)
  + weights.information           × infoScore(player)
  + weights.misdirection          × misdirectionScore(player)

seatMultiplier(player) =
  weights.seatOrderEnabled
    ? depthToMultiplier(該玩家當過的每一次 leader 的 depth 平均)
    : 1.0

finalDelta(player) = legacyDelta(player) + rawFactorSum × seatMultiplier
```

其中 `depth = (slot_index / (total_slots - 1))`，從 0（第一個提案人，資訊最少）到 1（最後一個提案人，資訊最多）；`depthToMultiplier(d) ∈ [0.8, 1.2]` 線性映射。

**Information factor 規則**：

```
好人每投一票 × role multiplier:
  approves infected team (≥1 evil)       → -0.5
  rejects infected team                  → +0.5
  approves clean team (0 evil)           → +0.25
  rejects clean team                     → -0.25

role multiplier: merlin 2.0, percival 1.5, loyal 1.0

遊戲級一次性 bonus（梅林）:
  assassination_failed / timeout         → Merlin +2   (藏好身份)
  assassination_success / 刺殺梅林        → Merlin -2   (暴露)
```

**Misdirection factor 規則**：

```
(a) 每票，壞人 evil player:
  approves infected team                 → +0.5   (smuggle)
  approves clean team                    → +0.25  (camouflage)
  rejects infected team                  →  0     (self-protect 合理)
  rejects clean team                     → -0.5   (明目張膽反對)

(b) 每失敗任務，on-team 的壞人:
  evilCountOnTeam == 1                   → +2   (單紅難追查)
  evilCountOnTeam >= 2                   → +0.5 (多紅顯眼)

(c) 後段協調 bonus:
  evil 投同意 + infected + 該輪任務失敗  → 額外 +1
```

**Seat order 規則**：

- 只對「當過 leader」的玩家計算 multiplier；非 leader 拿 1.0（中性）。
- 玩家若在一場裡當多次 leader，取所有 depth 平均。
- 單一提案的 edge case → depth 0.5 → 1.0（避免除零）。
- Seat order 只乘 Phase 2/2.5 layer，**不碰 legacy delta**（不雙扣）。

**Default weights（可熱 reload）**：

```json
{
  "proposal": 2.0,
  "outerWhiteInnerBlack": 3.0,
  "information": 1.5,
  "misdirection": 1.5,
  "seatOrderEnabled": true
}
```

**Fallback matrix**（關 seat + 關某 factor 的路徑）：

| 情境 | 行為 |
|------|------|
| `attributionMode='legacy'` | 全回傳 applied:false，走 Phase 1 |
| `voteHistoryPersisted` 空 + `questHistoryPersisted` 空 | applied:false |
| 只有 `voteHistory` | OWIB 歸零；seat 正常 |
| 只有 `questHistory` | Proposal / Information / seat 歸零；Misdirection (b)/(c) 可能還在 |
| `weights.information = 0` | info 分量歸零；其他照算 |
| `weights.seatOrderEnabled = false` | seat multiplier 全 1.0（breakdown 仍回傳 1.0） |

**Phase 2.5 不做**（交 Phase 3）：
- Historical backtest（2146 場重跑算 Brier）
- Logistic regression 調 4 因子 weight
- 2-week shadow mode（per_event 算但不寫 DB）
- Admin UI weight slider（現在 per_event toggle 是 read-only weight）

---

## 3. 資料驅動推導（用 2146 場）

### 3.1 資料面向盤點

從 Google Sheets 的 `牌譜` 分頁能抽出：
- `match_id`, `date`, `player_count`
- `roles`（配置）
- `players`（每個玩家的 ID + 分到的角色）
- `quest_results`（每輪任務成敗）
- `final_outcome`（三種之一）
- `assassination_target`（若有刺殺）

### 3.2 三結局分布（預估，需實際 query 驗證）

根據 Nakamura (2019) 的 Avalon 統計與社群資料，對 5-10 人配置預估：

| 結局 | 佔比 | 2146 場預估場數 |
|------|------|----------------|
| 三藍 | ~30-35% | ~650-750 |
| 三紅 | ~35-40% | ~750-850 |
| 三藍死 | ~25-30% | ~540-650 |

這分布決定了**各 outcome 的樣本是否足夠 logistic regression**。

### 3.3 從 deviation 轉 K 權重的公式

核心想法：對每個 `(outcome, role)` pair，計算「該角色在該結局出現時，勝方陣營的 ELO-adjusted 勝率 deviation」。

```
# 定義
expected_winrate(team, match) = σ(Δ_ELO_team)    # 標準 ELO 勝率公式
actual_outcome(team, match) ∈ {0, 1}

deviation(outcome, role) = mean over all matches with (outcome, role):
    actual_outcome(team_of_role) - expected_winrate(team_of_role)

K(outcome, role) = K_base × normalize(deviation(outcome, role))
```

**關鍵洞見**：`deviation` 已經扣除了「強弱隊本來就該贏」的部分，剩下的就是「這個角色讓結果偏離預期的程度」——這正是 K-factor 該反映的東西。

### 3.4 滾動與時間權重（EMA / Rolling Window）

Avalon 的 meta 會隨玩家群體技巧演化（例：社群學會識別莫甘娜的發言模式後，莫甘娜的價值下降）。建議：

```
K_rolling(outcome, role, t) = (1 - λ) × K_rolling(outcome, role, t-1) + λ × K_instant(t)
λ ∈ [0.02, 0.10]    # 半衰期約 10-35 場，依 meta 變化速度調
```

或用固定窗口（rolling window），例：**最近 500 場重訓一次 logistic 係數**。

---

## 4. 邊界案例

### 4.1 奧伯倫的樣本稀缺（n ≈ 226）

**問題**：奧伯倫場次僅梅林的 ~20%，邏輯斯迴歸係數 confidence 弱。

**解法**：
1. **Bayesian prior**：用啟發式 K 當先驗，少樣本時 shrinkage 向先驗靠
2. **Pool similar roles**：把奧伯倫與「一般紅方」合併估計，再用場次 count 加權
3. **顯式標註不確定**：在排行榜上角色 tier 旁加 `±N` 置信區間標示

### 4.2 擴充盤新角色（例：Ross、Trickster、Mordred Lite）

**問題**：新角色一上線就沒有歷史資料。

**解法**：
1. **結構類比**：把新角色對應到最接近的既有角色（如 Ross ≈ 派西變體），用該角色的 K 當起手式
2. **Cold-start bonus**：前 N=100 場給全體玩家 K_boost = 1.5x，加速收斂
3. **隔離榜單**：新角色場次獨立計算，不影響舊角色排名穩定性

### 4.3 少場數玩家（已有 30 場菜雞 gate）

**問題**：新手 ELO 波動大，早期分數不代表技術。

**解法**：
1. **30 場菜雞 gate**（已存在於 `eloRank.ts`）不進入排名分布
2. **Provisional K**：0-30 場期間用 K × 2.0（加速收斂），30 場後切回正常 K
3. **排除從 role-tier 計算**：菜雞期的表現不進入 per-role 排行

### 4.4 5 人盤 vs 10 人盤的差異

**問題**：5 人盤只有 3 藍 2 紅，忠臣 K 應不同於 10 人盤的忠臣。

**解法**：
1. **人數分層 K 矩陣**：K[outcome][role][player_count]，從 (3,7) 升到 (3,7,6) 共 126 格
2. **降維**：僅對結構性變化大的角色（忠臣、一般紅方）分層；關鍵角色（梅林、刺客）跨人數共用

### 4.5 刺客刺錯（刺到派西）vs 根本沒刺

**問題**：同屬「三藍結局」，但兩種情境的刺客能力推論不同。

**解法**：
1. **子類別細分**：outcome 從 3 種擴到 4 種：{三藍-刺到派西, 三藍-刺到忠臣, 三紅, 三藍死}
2. **補償信號**：刺到派西代表「至少識別出梅林候選」，K 懲罰 < 刺到忠臣

---

## 5. 驗證方法

### 5.1 Hold-out Test

```
1. 把 2146 場依時間切 80/20：前 1720 場訓練，後 426 場測試
2. 對每場測試資料，用訓練模型預測結局
3. 計算 log-loss / AUC / Brier score
4. Baseline: 單 K-factor ELO 的預測準確率
5. 若多 K-factor 模型的 Brier < 單 K × 0.9，驗證通過
```

**目標指標**：Brier score <= 0.21 (vs coin-flip 0.25)

### 5.2 Top-player eyeballing

```
1. 套用新 K 系統後，抽前 10 名玩家
2. 交叉比對社群公認強者名單（Discord / 牌譜作者認知）
3. 若交集 >= 7 人，通過人工驗證
```

### 5.3 Role-leaderboard 合理性

```
對每個角色，看 top-10 是否為該角色的公認高手：
- 梅林 top-10：是否為公認會帶風向的玩家
- 刺客 top-10：刺殺成功率是否顯著高於平均
- 派西 top-10：是否為社群公認能扛線的人

這是 qualitative check，不進 CI，但每季人工 review 一次。
```

### 5.4 敏感度分析 (Sensitivity Analysis)

```
改變單一 K 值 ±20%，觀察 top-100 排名變動：
- 若變動 > 15 位，該 K 為「敏感參數」需謹慎
- 若變動 < 5 位，該 K 可放寬容忍度
```

### 5.5 對抗測試 (Adversarial Test)

```
模擬一個玩家：每場都當 X 角色、勝率 Y%：
- 系統算出來的 ELO 應與理論值吻合（誤差 < 5%）
- 若不吻合，K 矩陣存在結構性偏差
```

---

## 6. 推薦方案（Roadmap）

### Phase 1 (MVP, 當前)：啟發式規則版

**目標**：day-1 上線，不等資料。

**內容**：
- 用 §2.3.2 的 K 矩陣硬編碼
- 保留 `calibration_factor` hook（初值全 1.0）
- 每月人工 review 一次是否需要調整啟發式

**Exit criteria**：累積 >2000 場、各結局 >500 場時，進 Phase 2。

### Phase 2 (資料校正, ~Q3 2026)：Logistic Regression

**目標**：讓資料修正啟發式偏差。

**內容**：
- 以 §2.2 方法訓練 3 個 logistic 模型
- 用 §3.3 公式把係數轉 K
- 與啟發式 K 取加權混合：`K_final = 0.3 × K_heuristic + 0.7 × K_logistic`
- 加權比例隨場次上升逐步轉向 logistic（最終 0.1 / 0.9）

**Exit criteria**：Phase 2 跑 3 個月、Brier score 穩定、社群共識「排行榜合理」。

### Phase 3 (研究性升級, ~2027)：Shapley-based Attribution

**目標**：學術嚴謹性、可發論文。

**內容**：
- 實作 Avalon simulator（規則引擎 + bot 策略）
- 用 Monte Carlo Shapley 算真實邊際貢獻
- 與 logistic 結果比對，看差距
- 若差 >15%，切 Shapley；否則保留 logistic（複雜度 trade-off 不值）

**Exit criteria**：研究價值 > 工程成本時啟動。

### Trade-off 表

| 指標 | Phase 1 啟發式 | Phase 2 Logistic | Phase 3 Shapley |
|------|---------------|------------------|-----------------|
| 上線時間 | 當天 | 1-2 週 | 1-3 個月 |
| 工程成本 | 低 | 中 | 高（需 simulator） |
| 資料需求 | 零 | >2000 場 | >5000 場 + simulator |
| 理論嚴謹 | 低 | 中 | 高 |
| 可解釋 | 極高 | 高 | 中（需講公設） |
| 對抗 meta 變化 | 差 | 好（rolling） | 好（rolling） |
| Edward 接手門檻 | 低 | 中 | 高 |

---

## 7. 參考文獻

### 學術原始來源

- **Shapley, L. S. (1953)**. *A value for n-person games*. Contributions to the Theory of Games, Vol. II. → Shapley Value 原始定義
- **Harville, D. A. (1973)**. *Assigning probabilities to the outcomes of multi-entry competitions*. JASA. → ICM / Harville 方法
- **Castro, J., Gómez, D., Tejada, J. (2009)**. *Polynomial calculation of the Shapley value based on sampling*. Computers & OR. → Shapley Monte Carlo
- **Foerster, J. et al. (2018)**. *Counterfactual Multi-Agent Policy Gradients (COMA)*. AAAI. → RL 版的角色歸因 (counterfactual baseline)

### 應用實作參考

- **Nakamura, Y. (CMU 2019)**. *Is it Percival time yet? A preliminary analysis of Avalon*. → Avalon 角色勝率實證資料
- **Chuchro, R. (2022)**. *Training an Assassin AI for The Resistance: Avalon* (arXiv 2209.09331). → 刺客 AI 與角色策略
- **STRATZ IMP (Individual Match Performance)**. → DotA 2 multi-factor 貢獻分（產業界實作參考）
- **FiveThirtyEight NBA Elo**：K = 20(MOV+3)^0.8 / (7.5 + 0.006·ED)。→ Outcome-scaled K 的產業先例
- **Malmuth, M. (1987)**. *Gambling Theory and Other Topics*. → ICM 在撲克 tournament 的應用

### 網路資料

- [Shapley Value — Wikipedia](https://en.wikipedia.org/wiki/Shapley_value)
- [Elo Rating System — Wikipedia](https://en.wikipedia.org/wiki/Elo_rating_system)
- [ICM — Wikipedia](https://en.wikipedia.org/wiki/Independent_Chip_Model)
- [Beyond Winning: Margin of Victory Unlocks Accurate Skill Ratings (2025)](https://arxiv.org/html/2506.00348)
- [Sampling Permutations for Shapley Value Estimation (JMLR 2022)](https://jmlr.org/papers/volume23/21-0439/21-0439.pdf)
- [Counterfactual Multi-Agent Policy Gradients (arXiv 1705.08926)](https://arxiv.org/abs/1705.08926)
- [Disillusion Avalon: Board Game Data Analysis (Medium)](https://a1080211jeff.medium.com/disillusion-avalon-board-game-data-analysis-b30bb75d2cf7)

---

## 附錄 A：符號表

| 符號 | 意義 |
|------|------|
| `R_i` | 玩家 i 的 ELO |
| `K_{outcome, role}` | 給定結局與角色的 K-factor |
| `S_{team}` | 實際得分 (1 勝 / 0 負) |
| `E_{team}` | 期望勝率 |
| `φ_i` | 玩家 i 的 Shapley Value |
| `v(S)` | coalition S 的價值函數 |
| `β` | logistic regression 係數 |
| `λ` | EMA 衰減係數 |

## 附錄 B：實作 checkpoint（for 接手工程師）

1. [ ] 讀 `packages/web/src/utils/eloRank.ts` 了解現有 tier 結構
2. [ ] 確認 Google Sheets `牌譜` schema 含本文 §3.1 所需欄位
3. [ ] Phase 1：在 `packages/server/src/services/` 新建 `EloKMatrix.ts`，實作 §2.3.2 啟發式表
4. [ ] Phase 1：在 `GameEngine.ts` 的 `applyEloUpdate(match)` 注入 `K_matrix[outcome][role]`
5. [ ] Phase 2：寫 `scripts/analysis/fit_logistic_k.py`，dump K 矩陣成 JSON，運行時熱載
6. [ ] 寫 `__tests__/EloKMatrix.test.ts`：驗證邊界情況（奧伯倫 0 場 → fallback 啟發式）
7. [ ] 上 Phase 2 前跑 §5.1 hold-out test，Brier 不達標就別 ship

## 附錄 C：常見誤解 / FAQ

**Q：為什麼不直接用 DotA IMP 那套神經網絡？**
A：IMP 需要**細粒度場內事件**（每分鐘 gold、每次 kill 的情境）。Avalon 只有粗粒度事件（每輪投票、任務成敗）。樣本密度差 100 倍，NN 會 overfit。Logistic + 啟發式是 Avalon sweet spot。

**Q：Shapley 不是說最公平嗎？為什麼不直接上 Phase 3？**
A：Shapley 的「公平」依賴**精確的 v(S) 函數**。Avalon 規則決定了很多 coalition 不可能出現（例：沒有梅林的盤），v(S) 只能用模擬器生成。模擬器品質 → Shapley 品質。在 simulator 未就緒前，Shapley 只是「理論漂亮的估錯」。

**Q：為什麼 K_base = 32？能不能改？**
A：32 是 FIDE 傳統值，對應「每場最多 ±32 分」。可改，但改完需重跑所有歷史資料才能比較公平。建議前期鎖 32，Phase 2 驗證完再議。

**Q：三藍時刺客 K 為什麼是負的？他的隊伍輸了不就自動扣分了嗎？**
A：標準 ELO 已經扣分。但**額外負 K** 反映「刺客是關鍵角色，沒刺中比一般紅方輸球更糟」。這是**結構性加懲罰**，不是雙重扣分——把基礎 K 切成「陣營 K」+「角色 K」兩層。

---

**文件終**。有疑問或要挑戰 spec 合理性，去 cycle_log / Discord 找 Edward 或 GM，或在 `docs/methodology/` 新增 `elo_outcome_attribution_v1.1.md` 提案。
