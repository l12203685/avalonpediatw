# 全站寫死統計數字二次稽核報告（Issue #148）

- **對應議題**：`l12203685/avalonpediatw#148`
- **稽核基準**：`main`（`8ee9ee98d189f9a3e48ca023846281e9e555fd1c`）
- **稽核範圍**：`packages/server/wiki_data.json`、`docs/avalon-wiki/**`、`packages/web/src/**`（含 `i18n/locales/{zh-TW,en}/common.json`、`data/**`、`components/**`、`pages/**`）、`packages/web/index.html`、`packages/server/src/bots/threads/concepts.json`。

## 稽核結論

1. **網站前端與數據頁（`packages/web/src/**`）**：全站數據分析、勝率表、個人分析與陣容強度皆已連動 `analysis_cache.json` / `games_cache.json`，**未發現寫死的實戰統計數字**。
2. **強者桌定義一致性**：全站已統一使用桌上平均 PR `S` 分層——`LINEUP_STRONG_S = 55`（高端桌 `S ≥ 55`）、`LINEUP_HIGH_S = 65`（高強度 `S ≥ 65`），`StrengthTiers.tsx`、`lineupFilter.ts`、`AiHistoryPage.tsx` 與 `i18n` 說明皆同源一致。
3. **百科文章（`wiki_data.json`）與守門強化**：
   - `wiki-40` 與各角色數據頁主體統計皆已包入 `<!-- stat:KEY -->`（由 `wiki_stats.py` 每晚重算）。
   - 發現 `wiki-147`（湖中女神）第 323–326 行含未受 `<!-- stat: -->` 保護之 2026-11-16 一次性實證統計（`約 56% 對 55%`、`49/78`、`130/132`、`約 6～7 個百分點`），其中 `約 56% 對 55%` 原未被 `HardcodedStats.test.ts` 的正則攔截。
   - 本 PR 已強化 `packages/server/src/__tests__/HardcodedStats.test.ts`：新增「實證比率對比（`X% 對 Y%`）」守門規則並將 `packages/web/index.html` 納入掃描，避免未來寫死統計回流。

## 掃描明細清單

| 檔案／出處 | 行號 | 目前寫法／值 | 分類 | 建議對應資料欄位／處置 |
| :--- | :--- | :--- | :--- | :--- |
| `wiki-147` | L323 | `原組合 44%，n=240；沒上過任務的人 45%，n=480`、`約 56% 對 55%` | 一次性實證統計（已標 2026-11-16） | 若改連動：對應 `analysis_cache.json` 湖中女神分頁（第 2 局三加一開紅後首湖目標陣營統計）；本 PR 已納入 `HardcodedStats.test.ts` 守門與 `ALLOW` 清單 |
| `wiki-147` | L324–326 | `約 6 成湖原組合（49/78）`、`幾乎都投黑（130/132）`、`約 6～7 個百分點` | 一次性實證統計（已標 2026-11-16） | 建議後續於 `wiki_stats.py` 補齊 `lake_r2_split_*` 動態標記後取代 |
| `wiki-182` | L186–188 | `三紅：53.3%（16 場）`、`三藍梅死：23.3%（7 場）`、`三藍梅活：23.3%（7 場）` | 歷史賽季紀錄（2023 S2 已結束） | 維持 `ALLOW` 例外，不需連動 |
| `wiki-209` | L43, L65–68, L127 | `100 局裡三紅 40…`、`n=100 ±10 個百分點`、`門檻 5 場…` | 說明用範例／統計公式 | 說明用，不需連動 |
| `wiki-109`、`wiki-176`、`wiki-205`、`wiki-216`、`wiki-217`、`wiki-72`、`wiki-26` | 多行 | `10/36 ≈ 27.8%`、`10/84 ≈ 11.9%`、`13/28 ≈ 46.4%` 等 | 數學組合機率公式 | 規則推導常數，不需連動 |
| `packages/web/src/data/aiHistory.json` | 多行 | 各回合歷史實驗勝率與刺中率紀錄 | 歷史優化日誌 | 歷史版本快照，已於 `HardcodedStats.test.ts` 排除 |
| `packages/server/src/bots/threads/concepts.json` | L38 | `派自己加2人全好約27.8%，外灑3人約11.9%` | 數學組合機率公式 | 規則推導常數，不需連動 |
| `packages/web/src/i18n/locales/{zh-TW,en}/common.json` | 多行 | `S ≥ 55`、`S ≥ 65`、`PR ≥ 80`、`100% − 紅方`、`±2 個百分點` | 門檻定義與公式說明 | 說明用，與 `LINEUP_STRONG_S` / `LINEUP_HIGH_S` 一致 |
