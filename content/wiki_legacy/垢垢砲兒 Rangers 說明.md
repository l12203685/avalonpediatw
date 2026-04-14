# 垢垢砲兒 Rangers 說明


## Slide 1: 垢垢砲兒 Rangers 說明

- 準備賠光了嗎


## Slide 2: 5W1H - Who, Why, When

- 人 (Who): 主要操作者是我 (策略開發, 投組規劃, 資金控管)
- 事 (Why): 2 Reasons
- 作中學習 (本身對交易很有興趣)
- 賺錢報復社會 (重點)
- 時 (When):
- 測試期間: 2021/05/26 ~ 2021/06/16 (用自己的部位, 實單測試)
- 正式起跑: 2021/06/17 (台指期六月合約結算日隔天) to now
- 執行時間: 台指期交易期間 (0845 ~ 1345 & 1500~2359 & 0000~0500)


## Slide 3: 5W1H - Where, What

- 地 (Where): 中華電信 IDC 機房, 規格如下
- 10 Mb (光纖) + 100 Mb 雙線路備援
- 1G Switch + 1G 負載自動平衡, 斷線自動切換器
- 300W 電源供應
- 將天災人禍風險降到最低 (斷線, 斷電)
- 物 (What): 交易機, 規格如下
- CPU: 4.5G, 8 核
- Ram: 32G, 讀 11000 MB/s, 寫 14000 MB/s
- SSD: 500G, 讀 2400 MB/s, 寫 1600 MB/s
- 減少因硬體差異造成的交易滑價


## Slide 4: 5W1H - How (如何透過程式交易賺錢)

- 市場一直在變化, 但人性是不變的
- 人的行為在市場上有重現性 (例如: 斷頭砍倉, 凹單攤平, 厚尾趨勢)
- 交易必須服從市場規則 (例如: 現貨搓和, 國際開盤, 期貨結算)
- 交易機制導致的價格行為 (Price Action) (例如: 型態學, 關鍵價邏輯)
- 程式交易主要功能?
- 透過程式的進出場策略捕捉市場現象 (交易重現性)
- 透過回測進行策略有效性與穩健性評估 (是否市場真的有這種現象, 並且可利用程式交易獲利)


## Slide 5: 實際交易畫面 Demo - Multicharts



## Slide 6: 實際交易畫面 Demo - Line 即時通知與下單機



## Slide 7: 歷史績效圖

- https://docs.google.com/spreadsheets/d/19QGys7Nf1z9wDdsSdczg8XauKsC6oUQSya8Qx7Dn-SU/edit#gid=487103144


## Slide 8: 計畫參與方式

- 最小參與金額與時間: 100萬, 至少一年
- 結算方式:
- 損益部分由所有人資金比例均分
- 有人出入金後會重新計算所有人股權占比
- 管理獎金計算方式:
- 從參與者開始加入後起算
- 獎金為該年表現超過 5% 部分的 20%
- 每年重新計算 (即前次獲利不會累積到明年)


## Slide 9: 計畫參與方式

- 出金規則:
- 每次出金收 1% 手續費
- 參與滿一年後可免手續費出金乙次
- 出金最慢會在隔週週五的 1400 收到 (出金金額 - 手續費)
- 入金規則:
- 每月結算日前一週禮拜四凌晨 12:00 (即週五之前) 可以要求入金增加部位
- 入金最大上限, 目前參與金額的 30% (以10萬無條件捨去)
- 例如: 目前參與資金換算後為 210 萬, 當月可入金最大金額為 60 萬


## Slide 10: 常見問題

- 每天平均損益?
- 以 1 單位 (100 萬) 的資金來計算, 歷史日平均振幅約在 1.5% = 1.5 萬左右
- 最大的下風期間與虧損與對應報酬?
- 最大下風期間約為 8 個月 (從高點回落後沒創高)
- 最長連續虧損月份為 6 個月
- MDD (高點回落最大虧損) 約為 50%
- 風報比約為每年 1 倍 (每年願意扛多少 MDD, 就可以賺幾%)
- 維運成本?
- 每個月平均約 1 萬, 投組管理與策略開發時間每天 3hr+


## Slide 11: 幾個理念分享

- 風險控管的重要性:
- 時間是程式交易的朋友
- 活的夠長夠久才是重點
- 獲利回吐的真實性
- 投組的表現在獲利期都是假的
- 吃完 DD 才是真的
- 開發研究的持續性:
- 世界上不存在聖杯
- 投資組合的維運管理才是精華


## Slide 12: 2021.11 –下風期的處理應對: 風控機制重新檢視

- 計算新投組 (純波段) 槓桿
- 以經驗法則來看應該是要抓在 10 倍左右,目前先抓 10 看看, 太高再調低
- 最好讓日平均 DD 小於 1%
- 建立策略監控與失效下架 SOP
- 破DD 超過一段時間?
- 破MDD 超過一定倍率?
- 未創高一段時間?
- 創高天數/破D天數?
- => 用目標函數配合權重調整機制


## Slide 13: 下風期的處理應對 (2021.11) - 策略與投組精簡化

- 檢視投組裡面所有策略
- 確認策略邏輯是否太過複雜
- 簡化所有策略, 最多 2 個進場 (空手 & 反手), 2 個出場 (通常是停損 + 停利)
- 策略重看所有歷史績效表現
- 策略名稱重命名 (TX(A/P/F)(L/D)(B/S/N/F/I)_YYYYMMAuthor(Logic)
- 檢視策略量化 tag
- pnl distribution
- mae/mfe distribution
- 月平均交易次數
- 平均持倉天數 (日曆日)
- 多空 pnl 比例
- 創高天數時間序列
- DD 天數時間序列
- 風暴比時間序列


## Slide 14: 2022.01 – 架構重整



## Slide 15: 2022.01 – 架構重整: 策略開發

- 架構更單純簡化
- 排除不合理的濾網與要求
- mp = 0 (部位卡住反向訊號)
- 多空對稱
- 進場: 一種; 出場: 一種
- 參數最多4個
- 目標: 策略行數在 20 行內
- 邏輯檢驗
- 拿掉交易成本後的權益曲線
- 順勢 & 逆勢 (背離)
- 最佳化檢驗
- K 棒周期
- 參數高原
- 可配合市場做適應 (WFA)
- 目標函數 (配合投組管理)


## Slide 16: 2022.01 – 架構重整: 策略開發

- Data2 投組開發
- 口數/筆數/籌碼
- 委買賣
- 三大法人
- 現貨買賣超
- 融資融券
- 價差
- 現貨指數
- 近遠月
- 大台小台
- 電子金融
- 非金電
- 0050/台積電
- 當沖
- 開發噱爆加碼
- 主要吃日內的大行情
- 選擇權
- 點對點策略 (買進後放到期)
- 押注型價差
- Short Vega


## Slide 17: 2022.01 – 架構重整: 投組建構

- 右圖為原始支數比重
- 未來會依照近 125 天表現 計算各策略權重
- 權重計算方式 = Max{近 125 天淨損益/近 125 天最高累積損益, 0}
- 每天 1345 收盤後調整, 讓誤差最小


## Slide 18: 2022.01 – 架構重整: 資金風控

- 每日損益監控
- 換算成近 5/20 日 ATR
- 觀察損益分配情況
- 平均虧損控在淨值 1%左右
- 由於這與投組常態性持倉比重有關, 因此不能單純以最大槓桿做計算
- 槓桿監控
- 每日動態調整口數
- 維持等槓桿
- 未來研究方向
- 依大盤波動縮放槓桿


## Slide 19: 垢垢投組配比

- 期貨: 80%
- 遠期 BNH: 20%
- 噱爆: 30%
- 純價波段: 10%
- 價差: 10%
- DataN: 10%
- 選擇權: 20%
- 跳空, 事件交易: 5%
- 週選結算: 5%
- 波段賣方: 10%


## Slide 20: 順大, 逆小, 突破系統

- 季, 月, 周 (60, 20, 5)
- 月, 周, 日 (20, 5, 1)
- 日, 時, 分 (300, 60, 15)
- 時, 分, 突 (60, 15~20, 3~5)
- 分, 突, 觸 (15, 5, 1)


## Slide 21: SBF 投組

- 多空合併
- MinMaxDist
- TrendCorrectionNoPA
- 多空分拆
- 純日逆勢/順勢
- 純夜逆勢/順勢
- 無時間限制逆勢/順勢


## Slide 22

- Basic (Pure Signal)
- 觀察 MAE/MFE (撇除 outlier)
- 使用 DE 讓分布往左上移動
- DE 可以壓縮 MAE 分佈
- 趨勢交易 + DE 會變成波動交易


## Slide 23

- 往回推5年 & 3年
- 每周三 1500 ~ 每周三結算
- HO, OL, HL
- 用 bips 去看
- 平均值, 標準差
- 算關卡價
- 走到 H1 => sell bull spread
- 走到 H2 => square 原本的 + 建新的
- 用逆馬丁建倉
- 掉回 L1, L2 之後開始 sell bear spread


## Slide 24: 策略細節 – 遠期 BNH

- 只做當下最遠月, 做為比較基準
- 賺取超跌時的大盤成長 & 逆價差
- 1 個月不買超過 1.5% 資金, 4x 槓桿
- 大盤乖離季均線超過 x% 後釣魚買進
- 進階: 計算虧損 = x ATR, 套用資金管理?
- 研究 MaiMai 策略達哥修改後版本


## Slide 25: 策略細節 – 選擇權跳空, 事件交易

- 連假超過 3 天, 順向加碼/反向避險
- 消息面行情 (升息/非農/疫情/選舉…)
- 資金每次押注 < 0.25% (約 600 點)


## Slide 26: 策略細節 – 選擇權週選結算策略

- 每次押注比例 < 0.5% (1200點), 有機會才押
- 以當日結算方向押注
- 觀察方向: 權值股, 大盤指數, 日內走勢, 押注優勢, 對向歸零
- 注意幾點: 1.5x 保本, 3x 保利
- 找機會回顧大盤週三結算狀況 &
- 48 * 25, 36 * 36, 24 * 50, 12 * 100, 8 * 150


## Slide 27: 待辦事項與開發中策略

- 選擇權
- 波動交易
- 股期波段 (超級績效): 5%
- 以現股基本面, 財報, 籌碼, 成交量等資訊篩選標的
- 一檔標的投入資金 < 1%


## Slide 28

- 0.5% 日停損: 每次輸 cost * 50 * n/A = 0.5%
- N = (A/10000) /cost (in points)
- F* = ((1 + b) * (1 – p) – 1)/b = 1 – p – p/b = q – p/b
- P: 買方勝率 q: 賣方勝率 = 1 - p
- 勝率與 b 有關
- B = profit/loss = pnl/cost


## Slide 29: 資金管理筆記

- 投組日損益以 ATR(20) 衡量
- 再觀察虧損區分布, 25%, 50%, mean (10, 4, 7.5)
- 以及全部 pnl 分布的 2.5%, 5%, 1% (24, 20, 35)
- 先以 10 做為 Swing 標準 (代表 10 個ATR)
- 投組每口大台平均日損的分布虧損平均值落在虧損 10 (ATR/100)
- 若 1 口的波動為 Swing ATR/100, Swing = 10
- 帳戶平均虧損為 DailyLossPct, DailyLossPct = 1%
- 假設最大口數為 MaxContract, MaxContract 為變數
- TotalAsset * DailyLossPct = Swing * ATR * bigpointvalue * MaxContract
- Leverage = MaxContract * Price * bigpointvalue/TotalAsset
- Leverage = MaxContract * Price/(Swing * ATR * MaxContract/DailyLossPct)
- LeverageTarget = (Price/ATR) * (DailyLossPct/Swing)
- MaxContract = TotalAsset * Leverage/(Price * bigpointvalue)
- MaxContractTarget = (TotalAsset * DailyLossPct)/(ATR * Swing * bigpointvalue)
- Swing 會跟 Portfolio 有關 (理論上越平滑 Swing 會越小?)
- 算出來 Leverage 目前大概在 6.12


## Slide 30: 代辦事項

- 策略多空分拆
- 觀察策略權益曲線 vs 波動度 (or 其他或許與市場結構有關的變數)的相關性
- 最佳化/找策略參數的 SOP
- 找到之後策略即定型
- 也可以包含真OOS 的觀察期
- 策略控管 (觀察市場結構與策略績效的相關性, 以Ricky 的講法就是策略失效是因為波動度或其他外生因素改變結構導致)
- 投組的權重與配置 (透過一些數值去觀察策略的屬性, 包含與 Benchmark 的相關性, Beta, RecoveryRate, RecoveryPeriod 以及各種Tag)
- 資金管理 (依據投組產生的 return distribution 去決定槓桿 (而經驗法則應該都是5~6倍, or 讓日虧損的平均值落在 0.5%~1.5%)


## Slide 31: 2022-01-02 選擇權交易系統開發筆記

- 1. 寫好逐筆成交爬蟲 & 彙整函數 (期貨近月, 選擇權近周 & 選擇權近月)
- 2. 指數每 5 秒報價爬蟲是否需要?
- 3. 逐筆轉換 K線函數完成, resample(freq, cloesd='left', label='right')) 已用成交量確認過為國際分K (closed 應該就是前歸or後龜頭舉舉
- 4. 確認儲存資料的格式
- - 是否要另存 HOT 逐筆? => 因為 HOT逐筆幾乎 = 全部資料 = 原始資料
- - K線頻率 => 選擇權 5 秒K有時不會都有成交資料, 另一個考慮的點是, 策略用到這麼高頻好像不好?
- 5. 後續策略開發模組, 應該有兩種
- - K 線開發模組 (單一檔選擇權波段策略) => 與台指期策略類似, 透過單一檔選擇權報價去做買賣 (但filter 可用的維度就變多了, 當下期貨報價, 現貨點數, 價格 (=權利金), 量, 履約價 (=價內外點數/%數), 到期時間, 也可把未平倉三大法人那些納入)
- - 性質特性模組 (兩檔以上選擇權) => 透過不同履約價, C/P 組出的組合, 成交後放到結算到期
- 6. volatility trading 不知道有沒有辦法做到, 假設限定買賣都必須買賣 straddle or strangle, 或許可以
- 7. 剛剛思考了一下, 台指雖然長多, 但反過來說選擇權的價格應該就是長空? (時間是敵人, 相較於股市, 時間是朋友, 放久就是會漲回來) => 所以應該可以做大量的sell 策略


## Slide 32: 2022-01-06 選擇權交易系統開發筆記

- 1. 將台指期近月逐筆成交資料依每月合約存成檔案
- 2. 將選擇權逐筆成交資料依到期日(週)存成檔案 (幹很大)
- 3. 將台指期近月逐筆成交資料合併成 1 分K
- 4. 將選擇權到期日逐筆成交資料合併成 1 分K (set_index('datetime').groupby(['cp', 'strike']).resample('60s', closed='left', label='right').ohlc() and volume sum)
- 尋找夠大的免費網路空間 (選擇權的逐筆自2013以來要快20G)
- 1. 看成交量圖分配與極端行情, 如果要做賣方不能做裸賣, 只能做價差
- 2. 如果要篩出可供交易的標的(檔數), 當日0846-0900 的成交量可能是一個方向
- 3. 選標邏輯跟選股邏輯可能很像, 只是股票可用的資訊還有基本財報的數據,
- 選擇權的主要屬性應該是:
- - 自身屬性: 價格 (=權利金, 50點為一個切點), 買賣權(C or P), 履約價格(K), 到期時間(T)
- - 其他選擇權屬性: 例如對面同履約價的狀況, 上下一檔履約價的狀況, 月選 vs 週選
- - Data2: 台指期點數(F), 台灣加權股價指數(S),  台指波動度(可能採用ATR? 日內與日等級的?)未平倉量, 三大法人等
- 4. 看要不要計算 implied vol (我個人覺得不需要, 因為只是資訊維度轉換)


## Slide 33: 2022-01-14

- 寫一個根據C/P, K, T, ohlc 做買賣後部位放到到期的回測函數
- 思考: 選擇權嚴格說起來只有 Delta, Gamma, Vega 三種要素
- 這三個要素 = 與選擇權對應的參數有關
- S_T: 標的物價格在到期日時的分配 (path independent)
- K: 履約價
- T: 到期時間
- 選擇權當下的報價 = premium(S_T, K, T)
- Delta
- 可以靠 underlying asset 避險 (delta neutral or 直接雙 sell)
- K 對應於 S_T 分布的位置會決定 (以call 為例, 在 K 往右的面積就是 delta)
- Gamma
- 會影響 Delta 的避險比例
- 面積的變化就是 Gamma (分配右移(價格上漲) 可想成履約價左移 => K往右的面積變大)
- 同 strike 的 call & put gamma 會相同
- Vega = - Theta
- 實際上就是在賣機會


## Slide 34

- S_T 的分配可直接用離散型表示 (台指結算也只有整數位)
- 比如現價為 S_0 = 18300, S_T 的分配函數可寫成 P(S_T) = {p_s, S in [17300, 19300]} 且 P(S_0) 要在當時是最大的 (P(S_0) >= P(S) for S in [])
- 比較好估算機率的方式應該是每隔一個履約價計算近上下 50/100 點 (50/100 一跳)
- 同一個區間可被上下兩檔夾住 => 做買低賣高的套利?
- 分佈要相同否則可以套利 => 隨機優越
- 實戰上應該只能做 250 點權利金以內的 (流動性才夠)
- 配合 market profile 去抓 control point? (實際分配 vs 理論分配?)
- 應該要讓報酬權益曲線去fitting distribution?


## Slide 35

- 1. High-quality alpha: α2. collects premiums by selling out-of-the-money option: δ < 203. usually made 45-30 days from expiration: in the first two delivery months4. hold the option until expiration5. regardless of market direction6. a short-term trend indicator is used to help reduce the probability of selling options against a negative trend7. position sizing methods are employed to optimize risk-adjusted returns by balancing put/call exposure:8. adjustment protocol: dangerous side -> tighten spread, the other -> loosen spread9. penetrate adjustment: buy ahead contract of original strike price10. analysis be performed on the prices of various options     10-1. in absolute terms in relation to their historic price level     10-2. in relative terms comparing the prices of puts to the similar calls11. robust adjustment protocol result in a balanced strategy12. Positions are placed using proprietary strike level and ratio algorithms to achieve a strategy that can be profitable in flat or volatile market conditions.13. real-time monitoring of positions are the primary risk controls


## Slide 36

- 1. profit by methods of high-quality α2. collect premiums by selling out-of-the-money option: usually δ < 203. make 30-10 working days from expiration: in the first 2 delivery months4. as regardless as possible of market direction5. a short-term trend indicator is used to help reduce the probability of selling options against a negative trend6. position sizing methods are employed to optimize risk-adjusted returns by balancing puts/calls exposure7. adjustment protocol: dangerous side -> tight spreads + futures8. penetration adjustment: buy ahead contract of original strike price9. analysis performed on the prices of various options    9-1. in absolute terms in relation to their historic price level    9-2. in relative terms comparing the prices of puts to the similar calls10. robust adjustment protocol result in a balanced strategy11. positions are placed using proprietary strike level and ratio algorithms to achieve a strategy that can be profitable in flat or volatile market conditions12. real-time monitoring of positions are the primary risk controls13. use VIX, VVIX, and VVVIX as funnels to filter the breakouts coming from the price movements


## Slide 37: 不錯的文章跟系統蒐集

- https://individual-trader.blogspot.com/2014/06/blog-post_12.html
- https://individual-trader.blogspot.com/2020/01/blog-post.html
- http://www.optionshare.tw/forum.php?mod=viewthread&tid=3822&extra=
- http://www.optionshare.tw/forum.php?mod=viewthread&tid=2136&extra=
- https://www.wearn.com/bbs/t1019179.html
- https://individual-trader.blogspot.com/2021/07/moc.html
- https://individual-trader.blogspot.com/2021/04/blog-post.html
- https://individual-trader.blogspot.com/2020/08/momentum-amplitude-phase.html


## Slide 38

- 我覺得任何調整措施能同時符合以下兩種要求的, 就是一個好的調整方法:1. 侷限部位的風險2. 繼續保持獲利的潛能
- 1. 趨勢信念者應該看漲說漲 & 看跌說跌, 不應該連漲多次後, 開始認為續漲機率低, 或是連跌多次後, 開始認為續跌機率低, 這些都透露著想取巧的心態. 因此做roll up 或 down調整的同時, 不會去另外做反向的抵補部位2. 震盪信念者也是一樣, 應該永遠認為行情要在區間走, 不會有其他取巧的想法. 準此做roll up 或 down調整的同時, 肯定要去另外做反向的抵補部位想受其利, 也必須承受其弊, 有一好就沒有二好, 能貫徹單一信念, 比較容易 [一鳥在手]; 想兩面獲利, 下場常是 [二鳥在林]
- 我個人多數是(以日盤現貨來說) ---盤中(減少調整次數) counter-trend & 盤後 trend following月間(部位規模控管) anti-martingale & 月內 martingale
- 操作真的要笨一點, 想受其利, 也必須承受其弊, 有一好就沒有二好, 能貫徹單一信念, 比較容易 [一鳥在手]; 想兩面獲利, 下場常是 [二鳥在林], 最後落得只能先造神後開課才能過上日子
- Market on Close?
- 選擇MOC可以同時達到2種效果 ---1. 降低交易頻率: 有一說虧損大多歸因於過度交易, 開市日最多交易一次是種很好的降低法; MOO也有同樣效果2. 持續做對的事: [持續] 也涉及到頻率, 配合期交所的逐日結算制度(mark to market), 用 [日] 來劃分頻率很合適! 在現貨收盤後且在期指收盤前的15分鐘來下單, 那時各方多空勢力已先行在現貨市場裡做了當天的總結, 然後衍生性商品再依據他們的戰果做交易決策(合乎先後的邏輯), 因為15分鐘內的行情通常跑不遠了, 很能提高我們持續(每交易日)做對決策的機率; MOO沒有辦法, 不少基金選擇MOC來調整持股也是基於類似原因, 只是頻率(每季?)的考量不同罷了
- 用VIX_f 取代 VIX (highest(c, 20) – l)/(highest(c, 20)


## Slide 39

- A. 將 波動率(volatility) 以及大盤指數的 波幅(amplitude) 和 力道(power) 此三者, 做正規化讓它們在 -1 到 +1 之間變化(oscillator-style), 較容易綜合來判斷 --- 目前正在發展中ing的報價, 能否造成既有趨勢的轉折B. 採取分批進入的方法, 在上述每次趨勢的可能轉折處, 做轉向或偏向的部位調整C. 重複類此(B)分段跟蹤法, 讓每次的調整能夠去框住這大機率的結算點範圍D. 不管盤勢如何發展(震盪來回跑盤整, 或大幅度地往某方向跑趨勢), 口數總量管制好的話, 最終結算點必將在動態鎖定的範圍內, 真正發揮賣方可匡列範圍做單的好處
- 還是回到老路子 --- 結合 波動率(volatility) 以及 波幅(amplitude) 和 力道(power) 三者來同時做判斷, 不僅合乎邏輯, 準確率也不低, 回測結果不誇張地可信多了


## Slide 40: Adjust in TXO

- Put-Call parity: C + K*e^-rT = S + P
- Since r in TXO nearly = 0, parity becomes C + K = S + P
- Another way: C – P = S – K*e^-rT
- Thus bc + sp with strike K equals long 1 MTX with price K*e^-rT
- And if bc + sp + sf = long 1 MTX with price K*e^-rT and short 1 MTX with market price (says F_0),
- the PnL = S_T – K*e^-rT + F_0 – S_T = F_0 – K*e^-rT
- Ex: F_0 = 18432, c_18450 = 80, p_18450 = 99
- Cash flow of bc + sp + sf = + 19
- if S_T >= 18500 => Cash flow = + 50 – 0 – 68 = -18
- if S_T <= 18400 => Cash flow = + 0 – 50 + 32 = -18
- if S_T = 18450 => Cash flow = + 0 – 0 – 18 = - 18
- If S_T = 18475 => Cash flow = + 25 – 0 – 43 = -18
- If S_T = 18425 => Cash flow = + 0 – 25 + 7 = - 18


## Slide 41

- 接下來要問的是日線圖中, 隨著行情或波動率不斷地在變化, 一個完整的多方或空方循環cycle, 它的週期長度也不斷地跟著變化; 在我看盤ing的當兒, 到底當時已經進行到週期的哪裡? 哪一個階段? 抑或要問的是, 正在發展中的行情裡, 這次該有的週期長度該如何估計? (相關數學或定理請估狗大神, 不多做解釋)1) 使用 Hilbert Transform, 可以從少量價格的資料近似出一個 cycle 的 phasor (phase vector, 相量)2) 利用下圖中的公式便可近似出目前cycle的週期(period), 亦即 [趨勢長度]3) 公式的概念為, 將這根bar的複數訊號與前一根bar的共軛複數相乘, 可得到角頻率(angular frequency)4) 根據角頻率公式 2pi / Period, 便能算出此period (趨勢長度)
- 最後要問的是, 目前正在發展中ing的報價, 能否在前面已知的週期長度下造成趨勢的轉折? 也就是當前正在進行中的行情變量, 強度足以造成多空換位? 或者僅僅只是一般的雜訊而已?
- a) 將報價資料當作一連串的光譜數據, 以波的頻率來看, 趨勢波屬於低頻, 而震盪波屬於高頻; 因此可用頻通濾波器(band-pass filter)在設定好前面求得的趨勢長度(period)參數後, 用來濾出有趨勢性的資料(低頻)部分b) 頻通濾波器(band-pass filter)沒什麼, 不要被名詞嚇到, 常見的均線便是一種高頻濾波器, 也是一種低通濾波器(low-pass filter), 可留下低頻的趨勢波c) 再根據這些被濾過的真正具有趨勢性的資料, 以計算出振幅(amplitude)和力道(power)d) 最終綜合振幅(amplitude)和力道(power)兩者的大小便可判斷出 --- 當下正在發展中的報價, 能否對正在行進中的原趨勢(ex: 日線)造成轉折至此, 賣方為主思考的人就很簡單了 --- 趨勢若判斷已經轉折ing了, 一定要做相應的動作, 不要像麋鹿般見車燈嚇到不動而被撞死i)  原本在多方趨勢做SP的人, 面臨轉折便改做SC; 或是(調整)照比例用加空單來做在手單的hedge(抵補)ii) 原本在空方趨勢做SC的人, 面臨轉折便改做SP; 或是(調整)照比例用加多單來做在手單的hedge(抵補)


## Slide 42

- (Highest(Close,20)−Low) / (Highest(Close,20)) × 100
- A. 絕對要做的
- 1. 找一個合用的回測軟體
- 2. 把你新的交易策略寫成程式
- 3. 思考樣本區間的合理劃分
- 4. 進行Walk Forward Analysis 滾動式的歷史資料回測
- 5. 不畏失敗 (必須回到步驟2), 努力找到約略45度角的成長曲線圖
- 6. 利用MDD (Maximum DrawDown) 思考如何進行資金管理
- B. 看個性特質加做的
- 1. 提升勝率到可信 (55%以下) 程度
- 2. 提升盈虧比到可信 (3倍以下) 程度


## Slide 43

- 裸賣: 價內
- 價差: 價外~價平
- 假設我認定的 distribution P% 是 [x – 250, x + 350] (P > 80)
- 建 sc + bc + sp, 有單邊下跌風險
- 建 bp + sp + sc, 有單邊上漲風險
- 期貨部位如果跟上述對沖 => 可行? (每天/每小時調整?)


## Slide 44: 改進賣方報酬該努力的方向

- (先逆勢賣 & 後順勢買)
- or (trend & counter-trend)
- or (martingale & anti-martingale)
- 賣方為主策略的重點思考, 就是隨時監控在手每個契約的健康度(風險的履約機率), 然後加做反向抵補或買方的再保動作, 以及視 [到期日] & [可用資金] & [指數的發展] 三者, 有邏輯地去做加減碼而已
- 賣方為主策略而言
- 雙邊不對等做單 + 價外多口數 + 價平或價內少口數 = 符合人性較易堅持策略 + 獲利潛能%比高資金管理得當的話(似乎多數人都做不好), 有無價差完全不重要 (有價差當然也很好, 可以嘉惠營業員的業績)
- 每次的調整都代表一次的成本付出, 因此, 能夠不要調整是最好! 為什麼常說要MOC ? OP賣方以日線來評估完整的循環cycle周期是最妥適的 --- 不容易過度交易, 也不會太過遲鈍而欠反應行情變化的事實!
- 週選操作以部位規模控管而論, 因應時間價值的消減速度與程度, 可分為上下兩半週(由賣方布局遞變到買方思考):
- 上半週(Wed. ~ Fri.) 採用 加法 (martigale), 注重賣方布局下半週(Mon. ~ Wed.) 採用 減法 (anti-martigale), 思考買方離場


## Slide 45

- bnh:
- - 賺: 長期指數多頭, 經濟物價成長通貨膨脹, 熱錢過多灌入市場
- - 賠: 黑天鵝, 大環境不好, 大蕭條
- 價差 (不管是近月/遠月):
- - 賺: 價差收斂, 遊戲基本規則, 避險需求
- - 賠: 黑天鵝, 大事件來時避險需求大增導致期貨被賣得比現貨還多
- sbf:
- - 賺: 日內的厚尾行情, 大的實體K棒
- - 賠: 日內大型反轉AV (小反轉不會受傷 因為部位也不大)
- 波段:
- - 賺: 依據每隻的邏輯特性去賺, 行情的延續性
- - 賠: 行情延續性不夠時會一路被洗
- - note: 看起來短停利才是最理想的波段?
- 週選雙賣:
- - 賺: 盤在一個區間震盪, 跑不出行情時, 收取時間價值
- - 賠: 行情噴出時, 黑天鵝, 跳空, 波動放大時權利金會大幅放大
- - note: 買方賺賠相反
- 選擇權價差:
- - 賺: 市場上報價錯誤導致不合理價差出現 (時間價差, 履約價價差, 配合期貨的價差)
- - 賠: 沒有算清楚合理的價差, 自己其實才是不合理的一方
- 週選結算買方:
- - 賺: 結算行情噴出時, 尾盤 gamma 放大導致價平點數放大極快馬上保本的行情
- - 賠: 結算尾盤沒有行情出現時, 賠掉權利金
- DATA2 (非純價)


## Slide 46



## Slide 47: 策略組合



## Slide 48: SBF 想法整理

- 20:52 Steven Yeh 算有
- 20:52 Steven Yeh if(A>B,N,-N)
- 20:52 Steven Yeh 大致上是這樣
- 20:53 Steven Yeh 其實1.就是均線上下而已
- 20:53 Steven Yeh 我覺得可以更好
- 20:53 Steven Yeh 2.的話就是 opend(0)>3日高點
- 20:54 Steven Yeh 至於這個均線的參數,過了某個門檻之後績效誤差就不大了
- 20:54 Steven Yeh 我主要最佳化的應該是N要多少,不能太多也不能太少
- 20:54 Steven Yeh 調整項=(1-N1-N2)
- 20:54 Steven Yeh 但就是不連續
- 20:55 Steven Yeh 應該可以弄成一個自適性的數值
- 20:55 Steven Yeh 但這兩個調整項我真的想破頭XD


## Slide 49

- 主要是(以多單為例)
- 1.我定義開高走低是獲利了結的多殺多,比較容易出現在高檔,所以位階越高,進場會越容易
- 2.跳空比較像是意料之外的利潤,或者是近期這種夜盤拉高高追完,日盤獲利了結賣壓比較容易出現(我之前說的夜盤大賺日盤容易洗光光)


## Slide 50



## Slide 51



## Slide 52: 代辦事項

- 波段
- 多空分拆
- 開重複進場
- 一個合約期間進不到 5 口 => 事件
- 找有效的多次進場
- 建立停損停利模組 (通用型)
- 薛報
- 純/全 x 日/夜
- 純多空 x 順逆
- 管理
- 反向管理的測試
- 賺越多/創高 => 縮槓
- 賠越多/破MDD => 加槓
- 一開始上線就先縮槓
- 價差
- TWSE
- VIX
- 0050
- 2330
- 金/電/非金電
- 進遠月
- 籌碼
- ABV (委賣買量)
- TAB (賣買成筆)
- DUV (內外盤量)


## Slide 53

- 1. 提高 SBF + 價差
- 2. 降低波段比重
- 3. 加入選擇權策略 (週選雙賣 & 雙買)
- 4. 挪獨立資金測試價差純多& SBF 純空投組
- 5.


## Slide 54: SBF 架構

- 行情特徵
- 特徵值出現時有厚尾大行情
- 機率性思考
- 加碼特徵
- 適合用來加碼
- 有些特徵值同時符合條件
- 加速特徵
- 適合放大部位時的加速
- 單根塞多口
- 多根快速塞單
- (移動) 停損出場
- 拉回
- 停損/保本/保利
- 拉回波動移動停損
- 賺超出平均值後保本/保利


## Slide 55: 菲阿里四價

- 四價
- 昨高低收 & 今開
- 方法
- 價格突破
- 跳空開高, 往上走 => 作多
- 跳空開低, 往下走 => 作空
- 開盤價突破
- 直接上漲 => 拉回作多
- 先跌再漲 => 突破作多
- 先漲再跌 => 突破作空
- 直接下跌 => 拉回作空
- 箱體順大逆小
- 支撐與壓力順大逆小
- 心法
- 一定要止損或對沖套利
- 對沖: 價差交易
- 日內交易開始
- 大賺才留倉
- 虧損不留倉
- 每筆交易虧損不超過 1%
- 市場不是數學公式
- 是反映人們心理
- 不同人, 資金不同, 周期不同
- 面對同張行情圖多空不同


## Slide 56

- SPD + EVT: 24%
- BNH: 24%
- SBF: 28%
- OPT: 24%


## Slide 57

