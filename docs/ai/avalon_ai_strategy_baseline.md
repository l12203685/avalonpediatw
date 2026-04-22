# Avalon AI — Strategy Baseline

Canonical decision rules for Avalon AI agents (Heuristic tier and any rule-based
layer on top of historical learning). Source of truth; other AI docs must cross-
reference this file rather than redefine rules.

This doc captures only the rules that AI code MUST obey. TOP10-derived
behaviour tables live in `top10_behavior_priors_*.json` per tier.

## §1. Core directives (team goals)

- **Good team** — complete 3 quests and survive the assassination attempt.
- **Evil team** — fail 3 quests OR successfully assassinate Merlin after 3
  good quests.
- **聽牌 rule (listening)** — once either side has won 2 quests, evil must
  fail every remaining quest it can fail. Reference:
  `feedback_avalon_ai_listening_rule.md`.

## §2. Role-specific priors (共用 + 差異化)

- Evil roles share one base policy; per-role overrides handle the narrow
  differences (`feedback_avalon_top10_behavior_lookup.md` #5).
- Percival: thumb disambiguation uses behaviour signals, not coin-flip.
- Oberon: has no teammate knowledge — his lake targeting cannot benefit from
  the "bring a friend" heuristic below because his `knownEvils` is empty.

## §3. Suspicion accounting

- Suspicion is a live score per player maintained in the observation layer;
  evidence: appearing on failed quests, approving failed-quest teams, behaviour
  outliers (seat-order, vote timing).
- TOP10-derived priors (`top10_behavior_priors_<tier>.json`) inform baseline
  probabilities but tier-specific AI reads them through `PriorLookup`, never as
  hard-coded constants.

## §4. 湖中女神互動規則 (Lady of the Lake)

### §4.1 好人湖中

- 不湖已知紅方 — 湖一個 `knownEvils` 成員 = 零新資訊 = 浪費湖中。
- 從未知陣營玩家中選**最高 suspicion**：用 `estimateSuspicionFromHistory`
  （失敗任務出場 +2、approve 後失敗的隊 +1、出現在成功任務 -0.5、reject 後失敗的隊 -0.3）。
- 宣告策略：**預設誠實** — 湖到好人就宣告 good、湖到紅方就宣告 evil。
  不湖自己已知紅方的前提下，好人湖中通常拿到的就是真資訊，說真話最大化隊內信任。

### §4.2 紅方湖中 (Edward 2026-04-22 12:39 +08 校正)

> Edward 原話：**「紅方湖中女神當然可以湖隊友並宣告隊友是好人 / 不用刻意避開」**

- **不 filter 掉已知隊友** — 隊友也是合法目標。
- 策略化挑目標（`pickLadyTarget` 紅方分支）：
  1. 若某隊友目前在公開歷史上**明顯被懷疑**（`estimateSuspicionFromHistory >
     0` 且 ≥ 最像梅林對手的 Merlin-likeness 分數） → 湖隊友並**公開宣告 good**
     （洗白，隊友壓力轉移到好人那邊）。
  2. 否則湖**最像梅林的對手**（`estimateMerlinLikenessFromHistory` 高者）。
  3. 完全沒對手可湖時才回去洗壓力最大的隊友；沒隊友可湖時湖任一對手。
- **湖後公開宣告** (`decideLakeAnnouncement` 紅方分支)：
  - 隊友 → 一律宣告 **good**（洗白）。
  - 對手且 Merlin 傾向 > 0 → 宣告 **good**（確認他是安全牌，反而隱藏刺殺情報）。
  - 其他對手 → 宣告 **evil**（說謊製造混亂）。
- **歷史資料接入後再精修**：實際「被懷疑程度」「最像梅林」門檻會改由
  TOP10 情境化 `PriorLookup` 決定，現行僅為 first-cut heuristic。

### §4.3 Feature flag

- `AVALON_USE_SMART_LAKE=0` → 退回 legacy（好人湖 knownEvils[0]、紅方純隨機）。
- `AVALON_EVIL_LAKE_BRING_FRIEND=0` → 紅方湖中回 Fix #2 commit `9bdff755` 行為
  （filter 掉 `knownEvils`、只從對手挑 Merlin-likeness 最高者）。僅供 regression
  比對用；上線預設為 on。

## §5. Proposal strategy

- `HeuristicAgent.decideTeam` 遵循聽牌規則（§1）+ suspicion 邏輯（§3）。
- 紅方 propose：盡量塞入自己可出 fail 的配置；避免全忠臣組合。
- 好人 propose：最低 suspicion 陣容 + 當前 leader 自己優先。

## §6. 教科書錯誤 (AI 不得犯)

### §6.1 好人湖中浪費

- 湖已知紅方 = 資訊價值 0。無 flag 可豁免。Fix #2 commit `9bdff755` 鎖定。

### §6.2 紅方湖中「刻意避開隊友」(Edward 2026-04-22 12:39 +08 新增)

- **新錯誤定義**：紅方 filter 掉 `knownEvils` 不湖隊友 = 放棄「湖隊友+宣告好人」
  這條洗白路線。Fix #2 原實作（`9bdff755`）即犯此錯誤，已由本修正推翻。
- 現行正確行為見 §4.2。禁止在 `pickLadyTarget` 紅方分支重新加入 ally filter。
- Feature flag `AVALON_EVIL_LAKE_BRING_FRIEND` 僅保留作 regression 比較，不得
  預設關閉。

### §6.3 紅方聽牌不 fail

- 見 `feedback_avalon_ai_listening_rule.md`。

### §6.4 派西盲賭拇指

- 見 `feedback_avalon_top10_behavior_lookup.md` #4。

## §7. Data-driven vs hard-coded

- 任何硬編碼閾值需 inline comment 說明為何不走 `PriorLookup`。
- TOP10 情境化 priors 按難度切（expert / mid / novice），見
  `feedback_avalon_top10_behavior_lookup.md`.

## §8. Rule reference (SSoT pointers)

- §8.3 — 好人湖中不湖已知紅方（教科書）。
- §8.4 — 紅方湖中以前被誤鎖「不湖隊友」；已由 Edward 2026-04-22 推翻為 §4.2。

## Change log

- 2026-04-22 init — 從散落 feedback / subagent_results 抽出成單一 baseline。
- 2026-04-22 §4.2 / §6.2 — Edward 「紅方湖中女神當然可以湖隊友並宣告隊友是好人」校正。
