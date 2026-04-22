# TOP10 Behavior Priors Schema (v4)

> **v4 (2026-04-22 15:12)** — 異常票 × 外白/內黑 × 回合 cross-product。v3 schema 全部保留向後相容，新增 `anomaly_stats.by_round` / `round_weight_suggestion` / `pooled_rates_for_reference`。
>
> **v3 (2026-04-22 14:18)** — Edward 正確投票規則（無標=正常、+=off_team白、−=in_team黑）。
>
> **v2 (2026-04-22 早期)** — 錯誤 dissenter 推斷，已作廢。

生成腳本：`scripts/compute_top10_behavior_threetier_v4_anomaly_rounds.py`（當前）
來源：`content/_data/牌譜.yaml`（2146 有效 games）
產出（非 runtime）：`analysis/output/top10_behavior_priors_{expert|mid|novice}.json`

## v4 新增：異常票外白/內黑 × 回合

### 語意定義

| 類型 | token | 條件 | 意思 |
|---|---|---|---|
| **外白**（outer_white） | `+` | seat ∈ `+` 且 seat ∉ team | off_team 卻投 approve |
| **內黑**（inner_black） | `−` | seat ∈ `−` 且 seat ∈ team | in_team 卻投 reject |

Edward 原則：越後面回合異常票意義權重越大（R5 決勝局 = 強訊號，R1 異常 = 探索噪音）。

### 新 JSON 欄位

```jsonc
{
  "version": 4,
  "rule_version": "edward_2026-04-22",
  "anomaly_breakdown_version": "edward_2026-04-22_15:12_round_cross_product",
  // ... 其他 v3 欄位不變 ...
  "anomaly_stats": {
    // v3 保留欄位（不動）
    "anomaly_approve_count": 11885,
    "anomaly_reject_count": 8668,
    "anomaly_approve_ratio_of_all_votes": 0.18424,
    "anomaly_reject_ratio_of_all_votes": 0.13437,

    // v4 新增
    "by_round": {
      "1": {
        "outer_white_rate": 0.02598,     // 外白票 / off_team 座位機會數
        "inner_black_rate": 0.00902,     // 內黑票 / in_team 座位機會數
        "outer_white_count": 1533,
        "inner_black_count": 229,
        "off_team_seat_opportunities": 59005,
        "in_team_seat_opportunities": 25375,
        "attempts_in_round": 8438,
        "games_with_round": 1685
      },
      "2": { ... }, "3": { ... }, "4": { ... }, "5": { ... }
    },
    "round_weight_suggestion": {
      "1": 0.5, "2": 0.7, "3": 1.0, "4": 1.3, "5": 1.8
    },
    "pooled_rates_for_reference": {
      "outer_white_rate": 0.05847,
      "inner_black_rate": 0.09188
    },
    "note": "runtime 建議以 by_round 為主。"
  }
}
```

### 分母選擇

- `outer_white_rate` 分母 = 該 round 所有 attempts 的 `off_team 座位數總和` — 代表「該 round 任一 off_team 座位出現 `+` 的機率」
- `inner_black_rate` 分母 = 該 round 所有 attempts 的 `in_team 座位數總和` — 代表「該 round 任一 in_team 座位出現 `−` 的機率」
- 不用 player-level 分母（會把同一玩家多場算多次）；用 seat-opportunity level（attempt 為單位），讓 round 之間的稀有度直接可比

### 實測數字（高手 TOP10）

| Round | 外白率 | 內黑率 | off_opps | in_opps | attempts |
|---|---|---|---|---|---|
| R1 | 2.60% | 0.90% | 59,005 | 25,375 | 8,438 |
| R2 | 3.51% | 3.31% | 47,748 | 31,832 | 7,958 |
| R3 | 12.98% | 13.87% | 34,787 | 23,213 | 5,800 |
| R4 | 23.62% | 20.04% | 10,640 | 10,640 | 2,128 |
| R5 | 26.75% | 32.89% | 6,012 | 6,008 | 1,202 |

→ **R5 異常率 ≈ R1 的 10 倍**，Edward「後面權重大」直覺強烈得到資料驗證。內黑率在 R5 超過外白率（決勝局內部反水 > 外部聲援）。

### Runtime wire 建議

1. `PriorLookup.getAnomalyRate(kind, round, difficulty)` where `kind ∈ {'outer_white','inner_black'}`, `round ∈ 1..5`
2. 對後期回合（R4/R5）看到異常票時，HeuristicAgent 應對該票來源玩家加大 suspicion 權重（+30~60%）
3. `round_weight_suggestion` 可直接當 Bayesian 乘數：`posterior = prior × round_weight[N]`
4. 同 interface 可給 Fix #4 Percival thumb prior 使用（異常票在 Percival 看莫甘娜/梅林時也適用）

### Round weight 設計考量

| R | 權重 | 理由 |
|---|---|---|
| 1 | 0.5 | R1 異常率 2-3% — 噪音多，探索期 |
| 2 | 0.7 | R2 異常率 3-4% — 仍在觀望 |
| 3 | 1.0 | R3 異常率 13-14% — 基準 inflection 點（好人/壞人已看 2 局結果） |
| 4 | 1.3 | R4 異常率 20-27% — 關鍵搶分局（壞人贏 2 局要擋，好人贏 2 局要踩定） |
| 5 | 1.8 | R5 異常率 27-35% — 決勝局；此時投異常票 = 強信念（押壞人 or 推好人） |

Edward 可隨時調整這組權重；若需非線性（exp）可改 {0.4, 0.6, 1.0, 1.5, 2.5}。

### 三難度差異（外白率 × 回合）

| Round | Expert | Mid | Novice |
|---|---|---|---|
| R1 | 2.60% | 2.64% | 2.30% |
| R2 | 3.51% | 3.55% | 3.42% |
| R3 | 12.98% | 12.95% | 14.37% |
| R4 | 23.62% | 23.08% | 26.82% |
| R5 | 26.75% | 25.59% | 30.71% |

→ 新手後期外白率最高（30.7%）— 亂投 approve 送壞人過；高手/中手差不多（越後期越謹慎）。

### 三難度差異（內黑率 × 回合）

| Round | Expert | Mid | Novice |
|---|---|---|---|
| R1 | 0.90% | 0.96% | 0.93% |
| R2 | 3.31% | 3.46% | 3.30% |
| R3 | 13.87% | 13.93% | 14.52% |
| R4 | 20.04% | 19.99% | 20.24% |
| R5 | 32.89% | 32.98% | 34.61% |

→ 內黑率三難度幾乎一致，R5 都超過 32% — 決勝局內部反水是**結構性**行為，不是難度問題。Edward「後期內黑 = 強信念」在三難度都成立。

---

## v3 歷史（2026-04-22 14:18，規則修正）

- 推翻 v2 的 dissenter 推斷：token 不是「少數派」，是 Edward 明示的「異常票」
- `rule_version = "edward_2026-04-22"`；invariants 見 `staging/subagent_results/priors_recompute_correct_vote_rule_2026-04-22.md`

---

## v2 本次（2026-04-22 wave 2，已作廢但保留供對照）關鍵發現

### 1. 牌譜投票 token 慣例（blocker #1 已解）

- `{seats}+` = 這些座位**明確同意**（dissenter approver）
- `{seats}-` = 這些座位**明確反對**（dissenter rejecter）
- 未列出的座位 → 與 **majority** 同向
- majority 推斷：attempt 是該 round 最後一次 → approve；否則 reject

驗證 game 1 R2A1 `3589 6+`：非 R2 最後 → majority=reject；seat 6 明確 `+` → approve（dissenter）；其他 9 seat = reject。
驗證 game 1 R1A5 `358`：是 R1 最後（後跟 `ooo`）→ majority=approve；無明記 → 全 10 seat = approve。

### 2. 隊長輪替公式（blocker #2 已解）

10 人局順時針：`leader = ((global_attempt - 1) % 10) + 1`（跨 round 不重置）

驗證：game 1 R1A1 leader=1 team `147`；R2A5 leader=10 team `3590`。

### 3. 牌譜記錄結構（本 wave 新發現）

**97.6% 的 games R1 完整記錄 5 attempts**（包括不是被接受的 proposals）。這意味牌譜並非「每次投票就記錄」，而是**列出該 round 內 1-5 個潛在 proposals，最後一個被接受為實際執行的任務隊**。這使得：

- 「inference 視圖」approve rate 偏低（因 R1 平均 4-5 個 proposals 但只有 1 個被接受）
- 「accepted 視圖」才是最接近「TOP10 玩家在最終投票時的實際行為」
- 「explicit 視圖」反映 yaml 記錄者特別標注的 dissenter 案例

## Root schema

```jsonc
{
  "version": 2,
  "tier": "expert" | "mid" | "novice",
  "generated_at": "2026-04-22T13:25:... +08:00",
  "source": "牌譜.yaml via internal_nickname_ranking_threetier + v2 vote/leader resolved",
  "pool_avg_win_rate": 0.528,
  "top10_player_nicknames": ["FOX", ...],
  "games_processed": 1685,
  "attempts_scanned": 25526,
  "votes_counted": 64510,              // inference view
  "votes_counted_explicit": 6213,      // explicit-token view
  "votes_counted_accepted": 16567,     // accepted-attempt view (is_last_in_round)
  "confidence_summary": { "total_keys": 92, "high_conf_keys": 62, ... },
  // 三視圖，每個含 situations（6 維） + rollups（L1-L4）
  "situations":          { "{6d_key}": {...} },  // inference view
  "rollups":             { "L{1-4}.{...}": {...} },
  "situations_explicit": { ... },                // explicit dissenter view
  "rollups_explicit":    { ... },
  "situations_accepted": { ... },                // accepted attempts only
  "rollups_accepted":    { ... },
  "data_quality": { ... },
  "fallback_chain": [ ... ],
  "schema_note": "..."
}
```

每個 `situations[key]` / `rollups[key]` entry schema：

```jsonc
{
  "sample_size": 917,
  "approve_count": 196,
  "reject_count": 721,
  "approve_rate": 0.2138,
  "reject_rate": 0.7862,
  "confidence": "high"  // >=30 samples
}
```

`confidence` 分級：
- `high`: sample_size >= 30
- `medium`: 10 <= sample_size < 30
- `low`: 1 <= sample_size < 10
- `none`: 0

## Situation key 結構（6 維）

```
{role}.{stage}.{leader}.{team}.{failed}.{team_size}
```

| 維度 | 值 | 說明 |
|---|---|---|
| `role` | `good` / `evil` / `unknown` | 只有 4 個座位（1/4/5/10）yaml 有角色欄位；其餘 6 座位 = `unknown` |
| `stage` | `r1` / `r2_plus` | R1 vs R2+ |
| `leader` | `leader` / `off_leader` | 是否隊長 |
| `team` | `in_team` / `off_team` | 是否在被提議隊伍中 |
| `failed` | `f0` / `f1` / `f2_plus` | 已失敗任務數 |
| `team_size` | `ts2` / `ts3` / `ts4` / `ts5_plus` | 隊伍人數 |

範例：`good.r1.off_leader.in_team.f0.ts3` — 好人、R1、非隊長、在隊、0 失敗、3 人隊

## Rollup 層級（fallback chain）

| Level | Key 格式 | 維度 | 用途 |
|---|---|---|---|
| L1 | `L1.{role}.{stage}.{leader}.{team}` | 4 維 | 精確 key sample 不足時首選 |
| L2 | `L2.{stage}.{leader}.{team}` | 3 維（去 role） | role=unknown 時 |
| L3 | `L3.{stage}.{team}` | 2 維 | 最穩定基準 |
| L4 | `L4.{team}` | 1 維 | 極端 fallback |

## 三種視圖對比（關鍵 L1 key 範例 — Expert tier）

| L1 key | inference | explicit | accepted |
|---|---|---|---|
| `L1.evil.r1.off_leader.in_team` | n=499 app=16.4% | n=7 app=0% | n=82 app=100% |
| `L1.good.r1.off_leader.in_team` | n=917 app=21.4% | n=25 app=0% | n=196 app=100% |
| `L1.good.r2_plus.off_leader.in_team` | n=4489 app=29.4% | n=761 app=0.4% | n=1366 app=96.5% |
| `L1.evil.r2_plus.off_leader.in_team` | n=1585 app=23.7% | n=185 app=0.5% | n=379 app=98.7% |

**解讀**：
- `inference` 反映「所有潛在 proposals 中被接受的比率」— 低值來自 R1 平均 4-5 個 proposals 但只有 1 個最後通過
- `explicit` 反映「記錄者標記的 dissenter 事件」— 全反對（in_team- 在被拒 proposals）或全同意（off_team+ 在通過 proposals）
- `accepted` 反映「最終被接受的隊 TOP10 是否投 approve」— 接近 100% 但非 100%（例：好人 r2_plus off_leader in_team accepted 96.5% = 3.5% 機率 TOP10 好人對自己在隊的通過隊仍投反對）才是真正的策略信號

**AI wiring 建議**：
- **主用 `accepted` 視圖**當「在最終 proposal 投 approve 的基準 prior」
- **輔用 `inference` 視圖**當「對非最終 proposal 表態支持的粗估」
- **補用 `explicit` 視圖**當 dissenter-specific 情境（例：隊外想主動表態支持的信號）

## 三難度 TOP10 名單（承襲前 wave）

見 `analysis/output/top10_players_threetier.json`。

### Expert（勝率前 10，avg 52.8%）
FOX 55.3 / 豬羊 54.9 / 洋蔥 53.8 / Alan 53.8 / 菜 52.2 / HAO 51.9 / ED 51.7 / Liang 51.6 / 池 51.5 / 發達 51.0

### Mid（rank 40-60%，avg 47.3%）
Dean 48.1 / kevin 47.9 / 小向 47.5 / Yumi 47.5 / JOY 47.4 / 呂安 47.2 / fancy 47.2 / 黑羊 47.1 / Dal 47.1 / 阿寶 46.5

### Novice（rank 65-90%，avg 43.9%）
亞可 45.6 / 布冬 45.5 / 爾勵 45.2 / 大星 44.8 / Emma 44.4 / 黃某人 43.9 / 豬豬 43.9 / 毛爸 42.4 / 很乖 42.3 / 夆 41.4

## 資料信心度分佈

| tier | total keys | high (≥30) | medium (10-29) | low (<10) | accepted votes |
|---|---|---|---|---|---|
| Expert | 92 | 62 | 13 | 17 | 16567 |
| Mid | 86 | 59 | 13 | 14 | 10894 |
| Novice | 76 | 53 | 6 | 17 | 8378 |

## Wire roadmap

**本 wave（資料層）已完成**：
1. 解 vote token 慣例（dissenter marking convention）
2. 解 leader rotation 公式（global_attempt mod 10）
3. 發現 dataset 結構 = round-level proposals + accepted last
4. 產三視圖三難度 9 份 JSON（92/86/76 keys × 3 views）
5. 設計 4 層 rollup fallback 降維
6. schema doc

**下一 wave（runtime wire）**：
1. `PriorLookup.ts` 加 `lookupTop10Behavior(situation, tier, view?)` 方法
   - `view` 預設 `'accepted'`（最接近真實投票行為）
   - Fallback chain: `situations[key]` → `rollups[L1.key]` → L2 → L3 → L4 → action_priors → hardcode
2. `HeuristicAgent.ts` 依 `difficulty` 路由：`hard→expert`, `normal→mid`, `easy→novice`
3. 切 `data_quality.safe_to_wire_runtime=true`（accepted view 已可安全使用，inference view 需加解讀層）
4. 搬 JSON 到 `packages/server/src/ai/priors/` runtime 路徑
5. Unit tests for `lookupTop10Behavior` + `difficultyToTier` + view selection

## 限制 / 已知 caveats

1. **inference 視圖結構偏差**：approve_rate 受 "R1 平均 proposal 數" 影響。R1 大多數 games 記 5 個 proposals 但只 1 個被接受 → approve rate ~20%。不可直接當「AI 每次投票的 approve 機率」。
2. **role 維度稀疏**：yaml 只 4 座位標角色，role=evil/good sample 約為 role=unknown 的 1/3。
3. **team_size 與 stage 強相關**：Avalon 各 round 隊伍人數固定，ts2/ts3/ts4/ts5_plus 分布不獨立。
4. **failed_count 偏差**：f2_plus 樣本小（多數場 R3 內結束）。
5. **non-10-player games**：leader rotation 假設 10 人，7/8/9 人局有偏差（本 wave 未排除）。
6. **internal nickname ≠ Firestore user_id**：無法 join 排行榜；內部暱稱可能有重名玩家被混為一（eligible_total=47 人需 >=30 場 known_faction，已過濾掉隨意玩家）。
