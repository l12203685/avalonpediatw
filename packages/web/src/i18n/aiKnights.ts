/**
 * 「AI騎士團」頁 strings (namespace `aiKnights`)。站長 2026-11-26：「可以把百科系統跟網站裡面 與百科AI有關 包括我剛剛提到的
 * 代理騎士擂台 全部挪到一個頁面下 頁面名稱看你建議 / 以後整個系統裡面的百科AI 都改名成 AI騎士_{風格}_{##} / 如果風格沒指定
 * 就是「百科」 就是目前訓練出來的」。頁面：components/aiKnights/AiKnightsHub.tsx。
 */
import i18n from './index';

export const AI_KNIGHTS_NS = 'aiKnights';

const zhTW = {
  title: 'AI騎士團',
  intro: '跟 AI騎士 有關的都在這裡：看它打過的局、它怎麼變強、擂台排行、跟它練習，也可以一起改它。',
  navLabel: 'AI騎士團',
  navShort: 'AI騎士',
  navTitle: 'AI騎士團：AI騎士的對局、優化歷程、擂台、練習',
  tabs: {
    games: '對局',
    history: '優化歷程',
    arena: '擂台',
    mine: '我的騎士',
    practice: '練習',
    collab: '一起改',
  },
  tabsLabel: 'AI騎士團的分頁',
  names: '名字：每一隻都叫「AI騎士_風格_編號」，風格沒寫就是「百科」＝目前訓練出來的那一隻（例：AI騎士_百科_03）。以前叫「百科AI」。',
  mine: {
    title: '我的騎士',
    soon: '還在做',
    body: '之後登入就能擁有一隻自己的 AI騎士：用一句話描述你想要的打法（例如「紅方再大膽一點」「不要那麼容易被看穿」），或看它打完的局寫回饋，慢慢把它調成你的風格。它會自動參加每週擂台。',
    titles: '成長稱號：侍從 → 騎士 → 圓桌騎士（看打過的局數與分數）。',
    nowTitle: '現在可以先做的事',
    nowArena: '去擂台：照範本做一隻自己的機器人（要會用 GitHub，或請你的 AI 幫忙）',
    nowPractice: '跟 AI騎士 練習：你和 9 隻 AI騎士 打一局',
  },
};

const en: typeof zhTW = {
  title: 'AI Knights',
  intro: 'Everything about the AI Knights in one place: the games they played, how they improved, the arena leaderboard, practice games, and how to help improve them.',
  navLabel: 'AI Knights',
  navShort: 'AI',
  navTitle: 'AI Knights: games, progress, arena and practice',
  tabs: {
    games: 'Games',
    history: 'Progress',
    arena: 'Arena',
    mine: 'My knight',
    practice: 'Practice',
    collab: 'Improve',
  },
  tabsLabel: 'AI Knights sections',
  names: 'Names: every bot is "AI騎士_style_number"; no style means "百科", the engine trained so far (e.g. AI騎士_百科_03). It used to be called "百科AI".',
  mine: {
    title: 'My knight',
    soon: 'Coming soon',
    body: 'Soon you can sign in and own an AI Knight: describe the style you want in your own words (e.g. "bolder as red", "harder to read"), or leave feedback on its games, and tune it step by step. It joins the weekly arena automatically.',
    titles: 'Ranks: Squire → Knight → Knight of the Round Table (by games played and rating).',
    nowTitle: 'What you can do now',
    nowArena: 'Arena: build your own bot from the template (needs GitHub, or ask your AI to help)',
    nowPractice: 'Practice: play a game with 9 AI Knights',
  },
};

if (!i18n.hasResourceBundle('zh-TW', AI_KNIGHTS_NS)) i18n.addResourceBundle('zh-TW', AI_KNIGHTS_NS, zhTW, true, true);
if (!i18n.hasResourceBundle('en', AI_KNIGHTS_NS)) i18n.addResourceBundle('en', AI_KNIGHTS_NS, en, true, true);
