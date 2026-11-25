
#### 8. 本回合的結果

| 開關 | 第 1 關（真人刺殺點，交叉擬合） | 自我對打（紅方 Δ） | 第 1F 節 | 第 1H 節（量尺刺客，對真人桌讀法） | 判定 |
|---|---|---|---|---|---|
| **`assassinWorldLine75=1`**（分層內只用世界線） | 39.1 → **43.2%**：對基準線 **+4.1 [+0.8, +7.4]**（偶數號 +5.5、奇數號 +2.8）；對真人桌讀法 +2.8 [−0.5, +6.1]；和真人的差 −5.4 → −1.3 [−4.6, +1.9] | 篩選 **+4.87 [+4.07, +5.68]**、新種子確認 **+5.97 [+4.40, +7.50]**（刺中 38.4 → 46.7%、37.2 → 47.2%） | 總距離變小（對真人 −0.0133／−0.0153、對高端桌 −0.0020／−0.0031），但對高端桌的座位角色族超過 0.01（篩選四族、確認 role:5 +0.0136）→ **不過** | 全部 +1.47 ± 0.85（偶數局 +2.13、奇數局 +0.80）；一般桌 **+3.34 ± 1.32**；弱桌 −2.05 ± 2.05（兩半都負）→ 沒到 2 個標準誤，**不算過** | **不自動採用**：基準線卡在第 1F 節的單族容許值（照規則交站長）；真人桌在現行讀法上多出來的部分還分不清楚（交站長） |
| `assassinWorldLine75=0.75`＋`assassinWorldLineOwn75=0.25`（混合現行分數） | 對基準線 42.7%（+3.7 [+0.8, +6.5]）；以真人桌讀法為底 +2.4 [+0.0, +4.8]（弱桌 −5.3） | — | — | — | 不採用（沒有比只用世界線好） |
| 不分層、只用世界線（離線） | 43.8% | 46.5%（篩選） | — | — | 不做（INV-A2；和分層內的差在雜訊裡） |

**基準線 `ai`、三種真人桌都不變**（`DEFAULT_AGENT_TUNING`、`HUMAN_READING` 都沒有改；`PROFILE_KEYS` 的上限照舊 17）。開關、表與腳本都進 repo，站長一句話就能開。

**世界線模型有沒有比現行的好（協調者要的結論）**：有，而且是在沒看過的那一半上——
1. 同一批真人刺殺點、同一個分層：39.1 → 43.2%（+4.1 [+0.8, +7.4]），第 61、71、73 回合三次都停在 38–42% 的那條線這次過了；和真人刺客只差 1.3pp（區間含 0）。
2. 站長說的兩件事各自量得到：**推派西維爾**（莫甘娜的視角）+3.3pp（40.5 → 43.8，同一套格）；**四個紅方一起看**比只有刺客自己的視角多 13pp（30.3 → 43.8），其中奧伯倫是誰最重要、莫甘娜／莫德雷德誰是誰 +3.6pp。
3. 另一半的進步來自把「梅林怎麼派隊」從「隊上有沒有看得到的紅」換成逐人、分角色的格（只用這一個分量 41.3%）。
4. 還沒補起來的：藍紅紅藍藍（52.2% 對真人 63.4%）；弱桌（世界線 41.3%、現行的真人桌讀法 45.5%、真人 42.9%）。

**要站長決定的**：
1. **基準線（機器人互打、全機器人房）要不要開 `assassinWorldLine75=1`**。勝率判準兩組種子都過（紅方 +4.87 [+4.07, +5.68]、+5.97 [+4.40, +7.50]），分局面的總距離明顯變小（對真人 0.0745 → 0.0612），但對高端桌（326 局）的三個座位角色族與 forced:R5 超過單族容許值 0.01，照第 1F 節不能自動採用——和第 53b 回合 V3P、第 58 回合 P7 當時一樣的情況（那兩次站長選「採用：勝率優先」）。要注意的是：採用之後機器人桌的藍方勝率 36.1 → 31.3%，低於 P7 之前的 36.7%（第 1A 節第 2 條的那條線）——每一條任務順序的刺中率都上升，不是只剋 P7；這代表機器人的梅林／派西維爾比真人更好讀（第 6 節），下一個藍方回合要回頭補。
2. **真人桌要不要開**。對現行真人桌讀法：刺中率 +2.8 [−0.5, +6.1]、量尺刺客 +1.47 ± 0.85（1.7 個標準誤），一般桌明確變好（+6.4 [+1.6, +11.0]、量尺 +3.34 ± 1.32），弱桌偏負（−4.2 [−12.2, +3.7]、量尺 −2.05 ± 2.05）。三個選項：(a) 三層都開（`PROFILE_KEYS` 的上限 17 → 18）；(b) 只開一般＋強＋S 不明、弱桌維持現行——要讓「每層最多一個開關」（`TIER_MAX_KEYS`）多一個例外；(c) 等更多真人局再量。本回合照 (c) 的現狀不動。
3. （不急）刺殺的分層（INV-A2）在世界線之下只是多一道保險：不分層 43.8%、分層 43.2%，差在雜訊裡，現狀不動。

#### 下一回合

1. **藍方（梅林、派西維爾）**：世界線在機器人桌刺中 46.7%（真人桌 43.2%）——機器人的梅林／派西維爾露得比真人多。第 6 節的分量表是下一個藍方回合的起點（派西維爾兩根拇指的放法、梅林逐人的派法往真人的比例靠；改的是藍方的派隊，照第 1B 節分角色量）。站長對上面第 1 題有裁定之前，藍方回合可以先用「紅方開 `red.assassinWorldLine75=1`」當對照組量。
2. 真人局增加之後重擬（`worldLineStudy75.py --part export`，約 30 秒）；弱桌要不要分開擬合等資料（現在 413 局不夠）。
3. 藍紅紅藍藍還差 11pp：世界線已經用掉提議、票、湖三種紀錄；剩下的最可能在提議的**順序**（誰修正誰、誰延伸誰——百科〈解讀前人派票〉的資訊流），這一版的格沒有放。

#### 9. 驗收（測試）與可重現

- 新增 `Round75.test.ts`（11 個：基準線與舊表預設關、真人桌照 `HUMAN_TABLE_READING`、解析；30 條世界線與兩個邊際加總為 1；只在紅方開牌、10 人局、四個紅方角色齊全時適用；只讀公開紀錄與紅方角色、和誰來問無關；莫甘娜是另一根拇指（只放一根 → 指向梅林；莫甘娜與莫德雷德對調證據跟著變）；梅林那一側避開看得到的紅、莫德雷德不算；小格往上一層收縮、強制局與票數對不上的提議不讀；疊加權重；正式的表只有計數、兩根拇指分得開；HeuristicAgent 關時逐位元相同、開時分層不變而分數 = 現行 × own＋世界線 × w、沒有紅方開牌時不套用；研究腳本換表與換回）；`AgentTuning.test`（兩個新開關列為數值開關）。
- 伺服器完整測試 @@TESTS@@；`tsc --noEmit`（server 與 scripts）乾淨；新檔案與改到的腳本 eslint 0 個錯誤、0 個警告；`build_ai_history.ts` 重新產生（沒有採用，沒有新里程碑）。
- 不變量（`invariantHarness.ts`，前 300 局重播＋探針＋300 局自我對打，種子 751001）：@@INV@@
- 開關關時逐局相同：自我對打紀錄重算刺殺 5,867／5,867 與 1,791／1,791 和紀錄相同；本機現行預設 563001 第 0–39 局和 `r69-screen` 合成的現行預設 40／40 相同；真人刺殺點的輸出在加開關前後逐位元相同（1,193／1,193）。
- 隱私：表（`worldLines75Tables.json`，6,374 格）只有計數；腳本的輸入輸出只有座位、角色、隊伍、票、任務牌、湖、刺殺與分數，沒有玩家名、沒有聊天。中間檔不進 repo。
- 新檔：`src/ai/Round75.ts`、`src/ai/assassin/WorldLines75.ts`、`src/ai/assassin/worldLines75Tables.json`、`src/ai/Round75.test.ts`、`scripts/worldLineStudy75.py`、`docs/ai/gap/r75-worldlines.md`。`assassinPathStudy.ts` 加 `--wl`／`--wl-tables`，`humanPrBenchmark.ts` 加 `--wl-tables`；`HeuristicAgent.assassinModelScores` 最後多一步（關的時候回傳同一個 Map）。自我對打用 `selfplay-runs-r71` 分支的 `sp.ts`（沒有改）。

```
cd packages/server
npx tsx scripts/keySpotStudy.ts --export-human h.jsonl
python3 scripts/worldLineStudy75.py --human h.jsonl --part export --out .            # worldLines75_full／even／odd.json；full 放到 src/ai/assassin/worldLines75Tables.json
npx tsx scripts/assassinPathStudy.ts --export-human hA_A.jsonl                        # 基準線
npx tsx scripts/assassinPathStudy.ts --export-human hA_H.jsonl --flag assassinPath61=1 # 真人桌讀法
python3 scripts/worldLineStudy75.py --human h.jsonl --base hA_A.jsonl --alt H=hA_H.jsonl --part eval|ablate|views [--kappa 5|20|40] [--alt-split] [--l2 20]
python3 scripts/worldLineStudy75.py --part cells
# TypeScript 的實作（交叉擬合）
npx tsx scripts/assassinPathStudy.ts --export-human hA_e.jsonl --wl --wl-tables worldLines75_even.json --flag assassinWorldLine75=1
npx tsx scripts/assassinPathStudy.ts --export-human hA_o.jsonl --wl --wl-tables worldLines75_odd.json --flag assassinWorldLine75=1
python3 scripts/worldLineStudy75.py --part merge --even-tables-file hA_e.jsonl --odd-tables-file hA_o.jsonl --out hA_cf.jsonl
# 自我對打（整局紀錄上重算刺殺）與第 1F 節
npx tsx scripts/keySpotStudy.ts --export-bot <r69-screen 合成的現行預設，或新種子的現行預設> b.jsonl
npx tsx scripts/assassinPathStudy.ts --export-bot b.jsonl bA.jsonl [--flag assassinWorldLine75=1]
python3 scripts/worldLineStudy75.py --part bot --base bA.jsonl --cand bA_wl.jsonl --games 10000
python3 scripts/worldLineStudy75.py --part patch --src <結果目錄> --src-prefix BASEF_ --cand bA_wl.jsonl --out cand --out-prefix WL_
npx tsx scripts/botGap.ts --bot cand --bot-prefix WL_ --baseline <結果目錄> --baseline-prefix BASEF_
python3 scripts/worldLineStudy75.py --human h.jsonl --bot b.jsonl --part botparts
USE_FORWARD_REASONING=true npx tsx scripts/selfplay/sp.ts --seed 563101 --from 0 --games 500 --out CB_563101_0.json --flag detail=1 [--flag red.assassinWorldLine75=1]
# 第 1H 節
npx tsx scripts/humanPrBenchmark.ts --workers 2 --boot 0 --roles assassin --tier-profile --dump pr_H.jsonl
npx tsx scripts/humanPrBenchmark.ts --workers 2 --boot 0 --roles assassin --tier-profile --flag assassinWorldLine75=1 --wl-tables worldLines75_even.json --dump pr_e.jsonl   # odd 同
python3 scripts/worldLineStudy75.py --part merge --even-tables-file pr_e.jsonl --odd-tables-file pr_o.jsonl --out pr_cf.jsonl
npx tsx scripts/tierPrCompare.ts pr_H.jsonl pr_cf.jsonl --split all|train|test --types assassinate
```

