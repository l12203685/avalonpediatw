/**
 * Shared role knowledge helpers.
 *
 * Centralises per-role info (icon, colour, description) and the per-viewer
 * night-information derivation so both the one-shot role-reveal modal and
 * the always-on persistent panel read from the same source.
 *
 * Security boundary: every helper here derives info strictly from the
 * *current viewer's* role. Never pass another player's role in — that would
 * leak secrets. Callers must supply `currentPlayer` as the viewer.
 */
import type { Room, Player, Role } from '@avalon/shared';
import { displaySeatNumber, seatOf } from './seatDisplay';

/**
 * Format a player as the bare seat number ("1", "2", ..., "0") for info
 * windows / role-reveal modals.
 *
 * Edward 2026-04-25: 「這種資訊視窗 都一律改成座位號碼 而不是玩家名字」 — every
 * piece of role-reveal / night-info / overlay text shows the seat number
 * instead of the player's display name so the canonical reference stays
 * the seat# across role reveal, persistent night-info panel, vote/quest
 * overlays, lady-of-the-lake, and assassin pickers.
 *
 * Edward 2026-04-25 21:59 撤回「N家」 — UI 顯示改純數字 (1, 2, ..., 9, 0)。
 * 牌桌口語仍說「N家」, 但寫到畫面上的字就是一個 digit, 不掛 suffix。
 */
export function seatLabel(playerId: string, players: Record<string, unknown>): string {
  const seat = seatOf(playerId, players);
  return seat === 0 ? '?' : displaySeatNumber(seat);
}

export interface RoleInfo {
  name: string;
  icon: string;
  team: 'good' | 'evil';
  color: string;
  bg: string;
  border: string;
  description: string;
  knowledge: string;
}

export const ROLE_INFO: Record<Role, RoleInfo> = {
  merlin: {
    name: '梅林',
    icon: '🧙',
    team: 'good',
    color: 'text-blue-300',
    bg: 'from-blue-900/80 to-blue-800/60',
    border: 'border-blue-500',
    description: '你是好人的精神領袖。你知道誰是邪惡方,但必須隱藏這個秘密。',
    knowledge: '你能看到所有邪惡方成員(除了奧伯倫)。小心刺客的注目!',
  },
  percival: {
    name: '派西維爾',
    icon: '🛡️',
    team: 'good',
    color: 'text-cyan-300',
    bg: 'from-cyan-900/80 to-cyan-800/60',
    border: 'border-cyan-500',
    description: '你是梅林的守護者。你能感知梅林的存在,但莫甘娜也會偽裝。',
    knowledge: '你能看到梅林(及莫甘娜),但無法分辨誰是真正的梅林。',
  },
  loyal: {
    name: '忠臣',
    icon: '⚔️',
    team: 'good',
    color: 'text-indigo-300',
    bg: 'from-indigo-900/80 to-indigo-800/60',
    border: 'border-indigo-500',
    description: '你是亞瑟王的忠臣。你沒有特殊情報,只能靠邏輯與直覺。',
    knowledge: '你沒有額外資訊。觀察其他玩家的行為來找出邪惡方!',
  },
  assassin: {
    name: '刺客',
    icon: '🗡️',
    team: 'evil',
    color: 'text-red-300',
    bg: 'from-red-900/80 to-red-800/60',
    border: 'border-red-500',
    description: '你是邪惡方的殺手。好人若贏得3次任務,你有一次機會刺殺梅林反敗為勝。',
    knowledge: '你知道隊友的身分。遊戲結束時,猜出梅林並刺殺他!',
  },
  morgana: {
    name: '莫甘娜',
    icon: '👑',
    team: 'evil',
    color: 'text-purple-300',
    bg: 'from-purple-900/80 to-purple-800/60',
    border: 'border-purple-500',
    description: '你偽裝成梅林迷惑派西維爾。讓派西維爾無法分辨你和梅林的差異。',
    knowledge: '你知道邪惡方隊友。派西維爾眼中,你看起來像梅林。',
  },
  oberon: {
    name: '奧伯倫',
    icon: '👻',
    team: 'evil',
    color: 'text-gray-300',
    bg: 'from-gray-900/80 to-gray-800/60',
    border: 'border-gray-500',
    description: '你是隱藏在陰影中的邪惡。你不知道隊友,隊友也不知道你。',
    knowledge: '你不知道其他邪惡方的身分,他們也不知道你。獨自行動,製造混亂。',
  },
  mordred: {
    name: '莫德雷德',
    icon: '🦹',
    team: 'evil',
    color: 'text-orange-300',
    bg: 'from-orange-900/80 to-orange-800/60',
    border: 'border-orange-500',
    description: '你是隱藏在梅林視野之外的邪惡領袖。梅林看不到你,但你知道誰是邪惡方。',
    knowledge: '你知道邪惡方隊友的身分。梅林無法察覺你——善加利用這個優勢!',
  },
  minion: {
    name: '爪牙',
    icon: '😈',
    team: 'evil',
    color: 'text-red-300',
    bg: 'from-red-900/80 to-red-800/60',
    border: 'border-red-500',
    description: '你是邪惡陣營的普通爪牙。你認識其他邪惡隊友,破壞任務是你的目標。',
    knowledge: '你知道邪惡方隊友的身分。',
  },
};

/**
 * Derive the list of night-info strings shown to the viewer.
 *
 * Returns lines already formatted for display. Never exposes information
 * outside the viewer's canonical knowledge scope (Merlin hides Mordred,
 * Oberon excluded from evil team view, Percival cannot tell Merlin apart
 * from Morgana, etc.).
 */
export function getKnowledgeList(role: Role, room: Room, currentPlayer: Player): string[] {
  const players = Object.values(room.players);

  // Edward 2026-04-25 21:52 角色資訊揭露 logic 修正:
  // 經典 Avalon 規則 — 紅方互看 / 梅林看紅方 都只知陣營, **不知具體角色**.
  // Server-side `sanitizeRoomForPlayer` 已把這些 visible peer 的具體 role mask
  // 成 null 但 keep team='evil'. 此處改用 team 比對而不是 role 比對.
  // Percival 的兩位 candidate (梅林|莫甘娜) 由 server 設 revealedCandidates 欄位.
  switch (role) {
    case 'merlin': {
      // Merlin 看到紅方 (server 已 strip Mordred/Oberon, 並把 role mask 成 null)
      const evilPeers = players.filter(p => p.id !== currentPlayer.id && p.team === 'evil');
      if (evilPeers.length === 0) return ['(無邪惡方玩家)'];
      return evilPeers.map(p => `${seatLabel(p.id, room.players)} — 邪惡方`);
    }
    case 'percival': {
      // Server 用 revealedCandidates=['merlin','morgana'] 標記兩位 candidates.
      const candidates = players.filter(
        p => p.id !== currentPlayer.id
          && Array.isArray(p.revealedCandidates) && p.revealedCandidates.length >= 2,
      );
      if (candidates.length === 0) return ['(無法感知梅林)'];
      return candidates.map(p => `${seatLabel(p.id, room.players)} — 可能是梅林或莫甘娜`);
    }
    case 'assassin':
    case 'morgana':
    case 'mordred':
    case 'minion': {
      // 紅方互看 — server 已 strip Oberon 並把具體 role mask 成 null, 留 team='evil'.
      const evilPeers = players.filter(p => p.id !== currentPlayer.id && p.team === 'evil');
      if (evilPeers.length === 0) return ['(無隊友)'];
      return evilPeers.map(p => `${seatLabel(p.id, room.players)} — 邪惡隊友`);
    }
    case 'loyal':
    case 'oberon':
    default:
      return ['你沒有特殊情報。'];
  }
}

/**
 * Structured night-info entry — parallel to `getKnowledgeList` but returns
 * the underlying player + known role so the UI can render a per-role avatar
 * next to each line. Never leaks roles outside the viewer's canonical scope.
 *
 * Percival case note: he cannot tell Merlin apart from Morgana, so the
 * entry's `knownRole` is intentionally left `undefined` — the UI should
 * render an ambiguous "梅/娜" badge or skip the avatar for those entries.
 */
export interface KnowledgeEntry {
  /** The player the viewer has info about. */
  player: Player;
  /** Role to show as an avatar. undefined when viewer cannot disambiguate. */
  knownRole?: Role;
  /** Short hint label (e.g. "邪惡方", "邪惡隊友", "可能是梅林"). */
  hint: string;
}

/**
 * Same logic as `getKnowledgeList`, but returns structured entries for UI
 * composition. Prefer this when you want to render role avatars; fall back
 * to `getKnowledgeList` for plain-text rendering.
 *
 * Edward 2026-04-25 21:52 角色資訊揭露 logic 修正:
 * 經典 Avalon — 梅林看紅方 / 紅方互看 只知陣營, 不知具體角色 → `knownRole`
 * 一律 `undefined`, 由 UI 渲染紅方陣營卡 (camp-only) 取代具體角色 avatar.
 * Percival 的兩位 candidate 仍 `knownRole=undefined`, UI 用 split tile 渲染.
 */
export function getKnowledgeEntries(
  role: Role,
  room: Room,
  currentPlayer: Player,
): KnowledgeEntry[] {
  const players = Object.values(room.players);

  switch (role) {
    case 'merlin': {
      // Server 已 mask 具體 role, keep team='evil'. UI 渲染紅方陣營 (no role avatar).
      const evilPeers = players.filter(p => p.id !== currentPlayer.id && p.team === 'evil');
      return evilPeers.map(p => ({ player: p, hint: '邪惡方' }));
    }
    case 'percival': {
      // Server 用 revealedCandidates 欄位標記兩位 candidate (梅林/莫甘娜).
      // knownRole 維持 undefined — Percival 無法 disambiguate.
      const candidates = players.filter(
        p => p.id !== currentPlayer.id
          && Array.isArray(p.revealedCandidates) && p.revealedCandidates.length >= 2,
      );
      return candidates.map(p => ({ player: p, hint: '可能是梅林或莫甘娜' }));
    }
    case 'assassin':
    case 'morgana':
    case 'mordred':
    case 'minion': {
      // 紅方互看 — 同梅林 case, 只知陣營不知具體角色.
      const evilPeers = players.filter(p => p.id !== currentPlayer.id && p.team === 'evil');
      return evilPeers.map(p => ({ player: p, hint: '邪惡隊友' }));
    }
    case 'loyal':
    case 'oberon':
    default:
      return [];
  }
}

/** Short, one-line label for what knowledge the current role grants. */
export function getKnowledgeLabel(role: Role): string {
  switch (role) {
    case 'merlin':   return '你看到的壞人';
    case 'percival': return '梅林候選 (含莫甘娜)';
    case 'assassin':
    case 'morgana':
    case 'mordred':
    case 'minion':   return '你的邪惡夥伴';
    case 'loyal':
    case 'oberon':
    default:         return '夜間資訊';
  }
}
