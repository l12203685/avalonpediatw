/**
 * 「AI 擂台」頁 strings (namespace `arena`)。站長 2026-11-26：「我們有辦法提供個人AI的雛形嗎 然後他們再根據這個雛形
 * 送出自己認為的AI樣貌 以後就可以是一堆自建AI對戰」。說明文件：community-bots/README.md、docs/BOTS.md〈AI 擂台〉。
 */
import i18n from './index';
import { REPO_URL } from './collab';

export const ARENA_NS = 'arena';

const zhTW = {
  title: 'AI 擂台',
  intro: '做一隻你自己的阿瓦隆機器人，和AI騎士、其他人的機器人每週對打、上排行榜。不用寫程式：機器人就是AI騎士 的引擎，加上你選的打法開關。',
  howTitle: '怎麼做你的機器人',
  how1: '複製範本資料夾 community-bots/_template，改名成你的機器人 id（小寫英文、數字、減號）。',
  how2: '改 profile.json：名字、你的 GitHub 帳號、一段打法說明，和想調的開關（每個開關的意思見說明文件；也可以直接把下面的提示貼給你的 AI）。',
  how3: '在自己電腦試打：pnpm --filter @avalon/server arena:local community-bots/<你的 id>（會印出你坐紅方、藍方時的勝率，和AI騎士 比）。',
  how4: '從你的 fork 開 PR，只加你那一個資料夾。自動檢查通過、審過就合併，下一次每週擂台就會上場。',
  rulesTitle: '規則',
  rulesBody: '名字和說明不能放玩家名字、網址、@別人，也不能冒充官方（例如含「百科AI」，或用「AI騎士」開頭：那是官方騎士的名字）。一開始一人一隻。資料夾只能放 profile.json 和 README.md：擂台不執行任何人的程式碼。',
  promptTitle: '給你的 AI 的提示',
  promptHint: '整段複製貼給你的 AI，把「我想要的打法」那一行換成你要的樣子。',
  copy: '複製',
  copied: '已複製',
  copyFailed: '複製失敗，請手動選取',
  boardTitle: '排行榜',
  boardHint: '分數以 AI騎士_百科（目前訓練出來的那一隻）為 1500；+100 分大約是「一整邊都換成它」時贏的機會變成 1.8 倍。括號是 95% 區間，局數少時很寬。',
  loading: '讀取排行榜…',
  loadFailed: '還沒有排行榜，或暫時讀不到（每週一更新一次）。',
  retry: '重新讀取',
  updated: '更新：{{date}}，{{games}} 局（{{sizes}} 人局）',
  colRank: '名次',
  colBot: '機器人',
  colRating: '總分',
  colRed: '紅方分',
  colBlue: '藍方分',
  colRedWin: '紅方勝率',
  colBlueWin: '藍方勝率',
  colSeats: '座位數',
  reference: '參考點',
  referenceStyle: '網站上正在跑的AI騎士_百科（目前訓練出來的引擎、正式預設，沒有改任何開關）。所有分數都以它為 1500。',
  example: '示範對手',
  by: '作者',
  knobs: '開關',
  noKnobs: '沒有改開關',
  ci: '95% 區間',
  linksTitle: '連結',
  linkReadme: '說明文件（開關表、怎麼投稿）',
  linkTemplate: '範本資料夾',
  linkFolder: '所有機器人',
  phase2: '之後（第 2 階段）會開放真的寫程式的機器人，在隔離的沙盒裡跑；設計見 docs/ai/ARENA_CODE_BOTS.md。',
  back: '返回',
  prompt: `我要參加「阿瓦隆百科 AI 擂台」，請幫我寫一份機器人的 profile.json。
我想要的打法：<在這裡寫，例如「紅方很衝、早早出失敗；藍方很難放行」>

規則（照做）：
1. 只輸出一個 JSON 物件，欄位只有 schema、name、author、style、overrides、sides、roles。
2. schema 固定 1；name 最多 24 個字；author 是我的 GitHub 帳號（不含 @，我會自己填）；style 用一兩句白話說打法，最多 300 個字。
3. name、style 不能有網址、@別人、玩家名字；name 不能含「百科AI」「官方」，也不能用「AI騎士」開頭（保留給官方騎士）。
4. overrides 是所有座位都套用的開關；sides.good／sides.evil 只在藍方／紅方套用；roles.<角色> 只在拿到那個角色時套用（merlin、percival、loyal、assassin、morgana、mordred、oberon）。後面的蓋前面的。
5. 只能用下面列出的開關，數字要在範圍內；沒列出的一律不能用。沒寫的開關照AI騎士 的預設。
6. 每個你改的開關，在回答最後用一句話說為什麼。

說明文件：${REPO_URL}/blob/main/community-bots/README.md
可用的開關：`,
};

const en: typeof zhTW = {
  title: 'AI Arena',
  intro: 'Build your own Avalon bot and play it weekly against the AI Knight (AI騎士_百科) and everyone else\'s bots on a public leaderboard. No coding: a bot is the AI Knight engine plus the style knobs you choose.',
  howTitle: 'How to build your bot',
  how1: 'Copy the template folder community-bots/_template and rename it to your bot id (lowercase letters, digits, dashes).',
  how2: 'Edit profile.json: a name, your GitHub handle, a short description of the play style, and the knobs you want to change (see the guide, or paste the prompt below to your AI).',
  how3: 'Try it on your computer: pnpm --filter @avalon/server arena:local community-bots/<your id> (prints your win rates as red and blue next to the AI Knight\'s).',
  how4: 'Open a PR from your fork that adds only your folder. Once the automatic check passes and it is reviewed, it plays in the next weekly arena.',
  rulesTitle: 'Rules',
  rulesBody: 'Names and descriptions may not contain player names, links or @mentions, and may not impersonate the site (e.g. contain "百科AI", or start with "AI騎士", which is reserved for the official knights). One bot per person to start. A folder may only hold profile.json and README.md: the arena never runs anyone\'s code.',
  promptTitle: 'Prompt for your AI',
  promptHint: 'Copy all of it to your AI and replace the second line with the style you want.',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed, please select the text manually',
  boardTitle: 'Leaderboard',
  boardHint: 'AI騎士_百科 (the engine trained so far) is fixed at 1500; +100 means roughly 1.8× the odds of winning when a whole side is this bot. Brackets are 95% intervals and are wide with few games.',
  loading: 'Loading the leaderboard…',
  loadFailed: 'No leaderboard yet, or it cannot be loaded right now (updated every Monday).',
  retry: 'Retry',
  updated: 'Updated {{date}}, {{games}} games ({{sizes}} players)',
  colRank: '#',
  colBot: 'Bot',
  colRating: 'Rating',
  colRed: 'Red',
  colBlue: 'Blue',
  colRedWin: 'Red win',
  colBlueWin: 'Blue win',
  colSeats: 'Seats',
  reference: 'reference',
  referenceStyle: 'The AI Knight that plays on the site (production defaults, no knobs changed). Every rating is relative to its 1500.',
  example: 'demo opponent',
  by: 'by',
  knobs: 'Knobs',
  noKnobs: 'no knobs changed',
  ci: '95% interval',
  linksTitle: 'Links',
  linkReadme: 'Guide (knob table, how to submit)',
  linkTemplate: 'Template folder',
  linkFolder: 'All bots',
  phase2: 'Later (phase 2) real code bots will be allowed, running in an isolated sandbox; see docs/ai/ARENA_CODE_BOTS.md.',
  back: 'Back',
  prompt: `I want to enter the "AvalonPediaTW AI Arena". Please write a profile.json for my bot.
The style I want: <write it here, e.g. "aggressive red that fails early; blue that rarely approves">

Rules (follow them):
1. Output a single JSON object with only these fields: schema, name, author, style, overrides, sides, roles.
2. schema is 1; name is at most 24 characters; author is my GitHub handle without @ (I will fill it in); style describes the play in one or two plain sentences, at most 300 characters.
3. name and style may not contain links, @mentions or player names; name may not contain "百科AI" or "official" and may not start with "AI騎士" (reserved for the official knights).
4. overrides apply to every seat; sides.good / sides.evil only on that side; roles.<role> only for that role (merlin, percival, loyal, assassin, morgana, mordred, oberon). Later layers win.
5. Use only the knobs listed below, with numbers inside their ranges; anything else is rejected. Knobs you leave out keep the AI Knight's default.
6. At the end, give one sentence per knob you changed explaining why.

Guide: ${REPO_URL}/blob/main/community-bots/README.md
Available knobs:`,
};

if (!i18n.hasResourceBundle('zh-TW', ARENA_NS)) i18n.addResourceBundle('zh-TW', ARENA_NS, zhTW, true, true);
if (!i18n.hasResourceBundle('en', ARENA_NS)) i18n.addResourceBundle('en', ARENA_NS, en, true, true);
