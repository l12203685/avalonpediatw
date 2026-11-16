# 研究寫作、查證及雙 AI 協作規範

## 內容層級

| 層級 | 定義 | 可作為哪種證據 |
|---|---|---|
| R0 正式遊戲規則 | 角色、任務／湖與視角真正可取得的資訊 | 推理硬約束（依房規） |
| R1 從規則演繹的定理 | 明確條件＋證明／反例測試 | 在前提成立時可當硬閘門 |
| R2 既有百科經驗 SOP | 典型玩法、常態、類比與站長策略指引 | 軟訊號／對應玩家理解；不能直接當確定身份 |
| R3 學術理論／實驗 | peer-reviewed、preprint 或有明確資料的模擬 | 依來源限制使用；不同人數房規不可直接比較勝率 |
| R4 模型假說 | 尚未實證的推理方向、IG、合成測試 | 優先做回歸、真實資料校準與勝率研究 |

## 必須能回溯的 metadata

paper: `id,title_original,title_zh,authors,venue,date,DOI,url,code_url,license,reading_status,read_by,read_at,page_ref,data,protocol,claims,limitations`。

wiki: `wiki_id,source_path,source_commit,category,key_claims,logic_or_empirical,preconditions,aliases,related_papers,related_implementation,tests,review_status`。

**PDF / 授權**：不要直接複製著作權受限的論文全文到此 Repo；先保留官方 URL、DOI、公開授權與摘要、自己的轉述／重現程式。網站原文同理保留現有原始碼與版本。

## 策略的可操作驗收

1. 從每項關鍵論點產生邊界案例。例：`A 湖 B 說好` 僅在藍方持湖不說謊（A0）假設下表示 `A 好 ⇒ B 好`，若 B 是梅林確定看得到的紅，則 A 為紅，且 10 人配置下不可見紅為莫德雷德。
2. **時序視角**：決策不能讀到未來任務、其他人的私人湖結果、派西拇指等；檢查 `event_seq` 與歷史快照。
3. **統計與策略**：`Brier/log-loss/ECE` 僅衡量校準，不能代替最終勝率；藍方最終勝率 = 三藍率 × 三藍後梅林存活條件比例。需要 paired-seed、自我對弈對手輪替和真人強者局一致度。
4. 研究、測試、Docs 要在 PR 留下差異；同一個 Issue 有 Claude 修正時 ChatGPT 不重做。

## 文獻與百科共同的主題分類

- **A 行為／語言**：欺騙、發言、心理、語言訊號與 ToM。
- **B 邏輯與投票**：任務/派票/黑白球/湖中、角色資訊與事件順序。
- **C 資訊／計算**：Bayes、CSP、圖模型、聯合熵、資訊增益、公眾信念與驗證。
- **D 角色戰術**：梅林、派西、忠臣、刺客、紅方專用；A/B/C 的應用層。
- **E 情境策略**：比分、座位、尾派、湖時點、刺殺、對手風格；A/B/C 的條件化整合。
