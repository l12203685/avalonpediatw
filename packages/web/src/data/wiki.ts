/**
 * Wiki Content Type Definitions
 */

export interface WikiCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  excerpt: string;
  tags: string[];
  author: string;
  updatedAt: Date;
  views: number;
}

// Avalon Game Rules & Strategy Wiki
export const WIKI_CATEGORIES: WikiCategory[] = [
  {
    id: 'rules',
    name: '遊戲規則',
    icon: '📋',
    description: '瞭解 Avalon 遊戲的基本規則和機制',
  },
  {
    id: 'roles',
    name: '角色指南',
    icon: '👥',
    description: '探索每個角色的能力和策略',
  },
  {
    id: 'strategies',
    name: '戰術分析',
    icon: '♟️',
    description: '學習進階策略和技巧',
  },
  {
    id: 'faq',
    name: '常見問題',
    icon: '❓',
    description: '獲得常見問題的答案',
  },
];

export const WIKI_ARTICLES: WikiArticle[] = [
  // 規則
  {
    id: 'rules-overview',
    title: 'Avalon 遊戲概述',
    category: 'rules',
    excerpt: 'Avalon 是一個 5-10 人的社交推理遊戲...',
    content: `# Avalon 遊戲概述

Avalon（抵抗組織）是一個 5-10 人的社交推理遊戲，結合了投票、祕密身份和合作元素。

## 遊戲目標

**好陣營**: 完成 3 個成功的任務
**邪惡陣營**: 完成 3 個失敗的任務

## 遊戲流程

1. **角色分配** - 每位玩家獲得祕密身份
2. **投票階段** - 玩家投票決定是否批准預選的任務隊伍
3. **任務階段** - 被選中的玩家決定任務成功或失敗
4. **暗殺階段** - 若好陣營即將勝利，刺客可嘗試殺死 Merlin
5. **結算** - 宣佈勝者並揭示角色

## 重要規則

- 所有角色在遊戲開始時保密
- 投票必須同時進行
- 任務結果後才會公佈投票結果
- 若連續 5 輪投票失敗，邪惡陣營勝利`,
    tags: ['基礎', '規則', '遊戲流程'],
    author: 'Avalon Wiki',
    updatedAt: new Date('2025-03-25'),
    views: 1524,
  },
  {
    id: 'rules-voting',
    title: '投票機制詳解',
    category: 'rules',
    excerpt: '深入瞭解 Avalon 中的投票系統...',
    content: `# 投票機制詳解

## 投票階段

每輪遊戲開始時，一名玩家（預選者）提議一個任務隊伍。所有玩家必須同時投票批准或拒絕。

## 投票規則

- **批准 (Approve)**: 🟢 綠色投票
- **拒絕 (Reject)**: 🔴 紅色投票
- **計票**: 批准票數必須 > 拒絕票數才能通過
- **時間限制**: 30 秒內必須投票

## 失敗投票的後果

- 若投票失敗，預選者角色傳遞給下一位玩家
- 連續 5 次投票失敗，邪惡陣營自動勝利
- 失敗計數器在新一輪開始時重置

## 投票策略提示

- 跟蹤每位玩家的投票模式
- 關注誰支持誰被選入隊伍
- 使用投票歷史推斷身份`,
    tags: ['投票', '規則', '策略'],
    author: 'Avalon Wiki',
    updatedAt: new Date('2025-03-20'),
    views: 892,
  },
  // 角色
  {
    id: 'roles-merlin',
    title: 'Merlin - 知識者',
    category: 'roles',
    excerpt: 'Merlin 知道邪惡玩家的身份...',
    content: `# Merlin - 知識者

## 陣營
🔵 **好陣營**

## 能力
- Merlin 知道除了 Morgana 外的所有邪惡玩家身份
- Merlin 知道誰是 Assassin（刺客）

## 勝利條件
- 與好陣營一起贏得 3 個任務

## 失敗條件
- 被刺客在暗殺階段殺死

## 遊戲策略

### 進攻策略
1. **領導任務**: 大膽提議並引導玩家通過
2. **證人**: 尋找另一個知道真相的好玩家並與之合作
3. **隱藏**: 不要太明顯，小心不要洩露 Percival

### 防守策略
1. **誘導**: 故意投票支持虛假信息來誤導邪惡陣營
2. **觀察**: 密切注意刺客的舉動
3. **保護**: 確保 Percival 存活到最後

## 常見錯誤
- ❌ 過於自信地披露信息
- ❌ 忽視 Morgana 的威脅
- ❌ 不保護 Percival`,
    tags: ['角色', '好陣營', 'Merlin'],
    author: 'Avalon Wiki',
    updatedAt: new Date('2025-03-25'),
    views: 2341,
  },
  {
    id: 'roles-assassin',
    title: 'Assassin - 刺客',
    category: 'roles',
    excerpt: '邪惡陣營的最終武器...',
    content: `# Assassin - 刺客

## 陣營
🔴 **邪惡陣營**

## 能力
- 知道其他邪惡玩家（Morgana 和 Oberon 除外）
- 在暗殺階段可以殺死一位玩家

## 勝利條件
1. 邪惡陣營贏得 3 個任務，或
2. 成功刺殺 Merlin

## 失敗條件
- 好陣營贏得 3 個任務且 Merlin 存活

## 遊戲策略

### 前期策略
1. **融入**: 表現得像個忠誠的好玩家
2. **蒐集信息**: 尋找 Merlin 的跡象
3. **配合**: 與 Morgana 協調虛假信息

### 後期策略
1. **最後機會**: 如果任務即將輸掉，準備刺殺
2. **選擇目標**:
   - 如果確定了 Merlin，就刺殺他
   - 如果不確定，刺殺看起來像 Merlin 的玩家
3. **時機**: 在最後投票輪完成後立即刺殺

## 常見錯誤
- ❌ 過早洩露身份
- ❌ 與 Morgana 過於友善
- ❌ 刺殺錯誤的目標`,
    tags: ['角色', '邪惡陣營', '刺客'],
    author: 'Avalon Wiki',
    updatedAt: new Date('2025-03-24'),
    views: 1876,
  },
  // 常見問題
  {
    id: 'faq-basic',
    title: '新手常見問題',
    category: 'faq',
    excerpt: '為遊戲新手解答基本問題...',
    content: `# 新手常見問題

## Q: 遊戲需要多少人才能進行？
A: 最少 5 人，最多 10 人。建議 6-8 人體驗最佳平衡。

## Q: 我可以說謊嗎？
A: 是的！說謊和誤導是遊戲的核心。道德謊言是策略的一部分。

## Q: 什麼是"隱藏身份"？
A: 除了 Merlin 和 Percival（及邪惡方），所有玩家都不知道彼此的身份。

## Q: 我被選中參加任務但投票反對批准，會發生什麼？
A: 沒關係。投票反對並不意味著你會被懷疑，這是策略的一部分。

## Q: 暗殺階段發生什麼？
A: 如果好陣營贏得 3 個任務，邪惡陣營有最後機會。刺客可以猜測誰是 Merlin。如果猜對，邪惡陣營仍然贏。

## Q: 遊戲需要多長時間？
A: 通常 20-30 分鐘，取決於玩家分析時間。`,
    tags: ['FAQ', '新手', '基礎'],
    author: 'Avalon Wiki',
    updatedAt: new Date('2025-03-23'),
    views: 3214,
  },
];
