# Threads 第一則留言

每天一個檔：`YYYY-MM-DD.md`（台北日期），整個檔案的內容就是那天貼文 A 底下的第一則留言（ChatGPT 寫，Issue #37）。

- 純文字，≤ 300 字（Threads 上限 500），白話；最後一行放一篇百科文章的網址（分享網址 `https://avalon-game-platform.web.app/w/<id>/`）。
- 不劇透當天的答案、不寫那一局的角色；數字只引用網站或百科已有的統計；座位寫「0 家」，不寫玩家名字。
- `<!-- -->` 註解會被拿掉，可以拿來寫備註。
- 那天沒有檔案時，自動發佈會用備案：「今天這題跟「關鍵字」有關，觀念整理在這篇：」＋建議文章的網址。
- 建議的文章和關鍵字：跑 `pnpm --filter @avalon/server threads:draft -- --date YYYY-MM-DD`，看產生的 `<日期>.json` 裡的 `firstComment`。
