# TOP10 Behavior Priors Schema (v2)

生成腳本：`scripts/compute_top10_behavior_threetier_v2.py`
來源：`content/_data/牌譜.yaml`（2146 有效 games）
產出（非 runtime）：`analysis/output/top10_behavior_priors_{expert|mid|novice}.json`

## 本次（2026-04-22 wave 2）關鍵發現

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
