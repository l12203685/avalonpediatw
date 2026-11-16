# 阿瓦隆資訊不對稱研究平台 v0.2（v0.1 基線保留）

**更新：2026-11-16（Asia/Taipei）｜狀態：獨立研究實驗室，尚未部署正式站。**

本版本新增 `event_replay.py`：事件級 replay、可選房規、公開/個人視角快照、僅由合法當時資訊輸入 `infer()` 的 `belief_at()`；保留 v0.1 核心，不修改量化基線。原 README 見 `README_ORIGINAL_v0_1.md`。

## 一、這個版本實際完成了什麼

- 5–10 人標準範例配置的完整隱藏角色配置列舉（5 人 120、10 人 151,200 個不重複分配）。
- 基於硬約束的私有視角篩選：梅林不見莫德雷德，派西只見梅林/莫甘娜的兩個候選，普通紅方看不見奧伯倫。
- 基於破壞機率 `q` 的紅車失敗票張數似然、完整配置後驗機率及各座位壞人機率。
- Shannon entropy 與候選隊伍的預期資訊增益（完整失敗票張數，而非僅成功/失敗）。
- 每個候選隊伍的任務成功機率，以及依成功率／資訊增益的排序。
- 可重現的案例、`q` 敏感度表、15 項單元測試、文獻索引與下一階段規格。
- 不使用第三方 Python 套件，可在標準 Python 3.10+ 執行。
- 事件回放規格含第五次提案強制通過或第五次否決判負、九人特殊變體、湖中是否宣告、刺殺、事件序號。
- 35/35 單元測試通過（原 15 + 新 20）；`results/test_log_v0_2.txt`。

## 二、檔案索引

| 檔案 | 用途 |
|---|---|
| `event_replay.py` | 事件回放、版本化房規、按座位/時間切割合法視角、`belief_at()` 與核心推論串接 |
| `tests/test_replay.py` | 事件順序、房規、資訊邊界、犯規輸入和歷史快照測試 |
| `README_ORIGINAL_v0_1.md` | 保留原始交接說明，追溯來源 |
| `INTEGRATION_STATUS.md` | 與 `avalonpediatw` 主 repo 的對照、狀態和下一步 |
| `avalon_core.py` | 角色配置、私有視角、任務證據、信念與資訊熵的純 Python 核心 |
| `analyze.py` | 使用 JSON 個案進行推理與候選隊伍排序 |
| `demo.py` | 五人局／十人局固定可重現示範 |
| `sensitivity.py` | 以 q=0.2/0.4/0.6/0.8/1.0 執行小型敏感度試驗 |
| `examples/*.json` | 輸入格式範例 |
| `tests/test_core.py` | 15 項測試案例 |
| `results/*.json` | 實際運算結果 |
| `results/sabotage_sensitivity.csv` | 對破壞行為假設的敏感度結果 |
| `research_sources.jsonl` | 來源索引與查核等級（每列一筆 JSON） |
| `research_claims.jsonl` | 戰術命題、狀態與待驗證指標 |
| `RESEARCH_SPEC.md` | 科研方法、倫理／資料洩漏防護、階段驗收 |
| `HANDOFF_PROMPT.md` | 下一個 Chat / 工程代理可直接接續的交接 Prompt |
| `explorer.html` | 無需伺服器的十人局互動視覺展示（固定假設） |

## 三、執行指令

在專案資料夾執行：

```bash
python -m unittest discover -s tests -v
python demo.py --case all --out results/demo_results.json
python analyze.py --input examples/ten_357.json --out results/ten_357_analysis.json
python sensitivity.py
```

用瀏覽器直接開啟 `explorer.html`，可調整 `q`、比較候選隊伍的任務成功率與資訊增益。

## 四、重要模型假設

1. **僅分析身份與任務失敗張數**，尚未包含提案程序、黑白球、交談、刺殺終局或真正的遊戲全流程。
2. `q` 是**所有紅方上車後獨立選擇炸車的假設機率**，不是已從真人紀錄校準的統計值；當 `q=1` 是全員必炸的極端情境。
3. 主觀語言線索只能以假設的敏感度／特異度輸入，相關線索不可視為獨立證據反覆灌入。
4. 身份先驗在合法配置間均勻，未使用玩家實力、座位偏好、選人策略與跨場記憶。
5. **資訊增益 ≠ 勝率增益**。即使某隊伍帶來更高訊息，也可能導致立即的第三紅；這版沒有計算長期勝率最佳策略。
6. 觀測是以**某個合法觀察者的視角**進行；正式接上多人遊戲引擎後，必須由伺服器認證角色，禁止任何私有資料穿越視角邊界。
7. `Rules.standard` 是固定的教學配置；實際線上房間可自訂角色與規則，須在下一版新增版本化規則設定，不能當成所有房間的唯一標準。

## 五、原型與論文的關係

本程式為**獨立實作的最小研究基線**，採用了公開的資訊理論與貝葉斯方法概念；**不是 CSP4SDG、GRAIL、DeepRole 的重製版，也沒有聲稱重現它們的實驗結果**。論文與來源詳見 `research_sources.jsonl`。

## 六、目前不能宣稱的結果

- 沒有證明 357 案例中任何真實玩家身份。
- 沒有證明任何派票／發言流派比另一種更容易獲勝。
- 沒有完成真實對局資料的品質檢查、回放或大規模基準比較。
- 沒有部署到公開線上平台，也沒有向 GitHub 推送。

## 七、v0.2 事件回放最小案例

```python
from event_replay import Replay, ReplayRules
from avalon_core import Rules

roles = ('Merlin', 'Percival', 'Servant', 'Assassin', 'Morgana')
game = Replay(ReplayRules.official_style(5), roles)
game.apply({'kind':'proposal', 'leader':0, 'team':[2,3]})
game.apply({'kind':'vote','ballots':{i:True for i in range(5)}})
prior = game.belief_at(2, sabotage_probability=1.0)  # No mission result yet
game.apply({'kind':'quest','fail_cards':1})
posterior = game.belief_at(2, sabotage_probability=1.0)
assert posterior.evil_marginals()[3] == 1.0
assert prior.evil_marginals()[3] < 1.0
assert 'role_assignments' not in game.public_log()
```

**注意：** `Replay` 是研究用的伺服器端可信回放物件；透過 `view_at(observer)`
取得的資訊仍須由正式伺服器先驗證玩家身分。`belief_at` **只**使用公開任務失敗張數與該座位的起始私人資訊；提案、投票、湖宣告和發言目前均不計似然。非標準九人派隊人數尚未接通 `avalon_core` 的 `infer`，會明確拒絕，而非默默算錯。