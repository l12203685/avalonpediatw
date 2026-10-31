/**
 * 網站「牌譜紀錄」頁籤的純函式（Edward 2026-10-30：「百科網站可以直接多一個頁籤是『牌譜紀錄與覆盤』」）。
 *
 * 資料：GET /api/analysis/paipu = packages/server/paipu_cache.json（discord_paipu_export.py 每天從 Discord 論壇
 * #牌譜紀錄與覆盤 產生）。每篇貼文 = 一局：標題、標籤、發文時間，以及解析後的牌譜（或讀不懂的原因）。
 * 只有牌譜本身；討論串的回覆不在網站上，「到 DC 討論」連到那篇貼文。
 *
 * 牌譜慣例（同 DC）：座位 1–9 與 0（= 10 號）；提議一行一隊，後面的投票異常標記「57-」= 隊內 5、7 投反對（內黑），
 * 「6+」= 隊外 6 投贊成（外白），沒標的人照常（隊內贊成、隊外反對）；第 5 次提議是尾家強制局，沒有投票。
 * 配置六碼 = 刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林的座位，其餘是忠臣。
 *
 * 純函式放這裡，packages/server/src/__tests__/WebPaipu.test.ts 測（web 沒有測試執行器）。
 */
import { playerNameKey } from '@avalon/shared';

export const PAIPU_SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export const DISCORD_GUILD_ID = '1132682489840812113';

export type PaipuOutcome = '三紅' | '三藍死' | '三藍活';

export interface PaipuProposal {
  /** 隊伍座位，照貼文寫的順序（0 = 10 號）。 */
  team: string;
  /** 投票異常標記，統一成符號在後：'7+'、'5-'、'57-6+'。 */
  votes: string[];
}

export interface PaipuRound {
  proposals: PaipuProposal[];
  /** 任務結果 o／x（小寫）。 */
  mission: string;
}

export interface PaipuLake {
  /** 第幾輪任務結束後用湖（2–4）。 */
  after: number;
  holder: string;
  target: string;
  /** 宣告：o 藍、x 紅、? 不明、'' 沒寫。 */
  claim: '' | 'o' | 'x' | '?';
}

export interface PaipuGame {
  config: string;
  /** 座位 1..9、0 的暱稱。 */
  names: string[];
  rounds: PaipuRound[];
  lakes: PaipuLake[];
  /** 刺殺目標座位；三紅或沒寫時 ''。 */
  assassination: string;
  outcome: PaipuOutcome;
  category: '' | '線瓦' | '面瓦';
}

export interface PaipuPost {
  /** Discord 討論串 id（= 起始訊息 id）。 */
  id: string;
  title: string;
  tags: string[];
  /** 發文時間（台北，ISO 8601）。 */
  created: string;
  /** 牌譜日期 YYYY-MM-DD（標題的 MMDD，沒有就發文日）。 */
  date: string;
  game: PaipuGame | null;
  /** 讀不懂時的原因（固定的說明文字）與行號。 */
  problem?: string;
  problemLine?: number;
}

export interface PaipuList {
  format: 'avalon-paipu';
  version: number;
  guildId: string;
  forumId: string;
  counts: { posts: number; games: number; unreadable: number };
  posts: PaipuPost[];
}

/** 配置六碼的角色順序。 */
export const CONFIG_ROLES = [
  { name: '刺客', short: '刺', red: true },
  { name: '莫甘娜', short: '娜', red: true },
  { name: '莫德雷德', short: '德', red: true },
  { name: '奧伯倫', short: '奧', red: true },
  { name: '派西維爾', short: '派', red: false },
  { name: '梅林', short: '梅', red: false },
] as const;
export const LOYAL_ROLE = { name: '忠臣', short: '忠', red: false } as const;

export type PaipuRole = (typeof CONFIG_ROLES)[number] | typeof LOYAL_ROLE;

/** 某座位的角色（配置裡沒有 = 忠臣）。 */
export function roleOfSeat(config: string, seat: string): PaipuRole {
  const i = config.indexOf(seat);
  return i >= 0 && i < CONFIG_ROLES.length ? CONFIG_ROLES[i] : LOYAL_ROLE;
}

/** 結果的三種寫法：論壇標籤名稱（三紅／三藍被刀／三藍躲刺）。 */
export const RESULT_TAGS: Readonly<Record<PaipuOutcome, string>> = {
  三紅: '三紅',
  三藍死: '三藍被刀',
  三藍活: '三藍躲刺',
};
const TAG_OUTCOME: Readonly<Record<string, PaipuOutcome>> = { 三紅: '三紅', 三藍被刀: '三藍死', 三藍躲刺: '三藍活' };

/** 一篇的結果：讀得懂用牌譜的結果，否則看結果標籤（剛好一個才算）。 */
export function outcomeOf(post: PaipuPost): PaipuOutcome | null {
  if (post.game) return post.game.outcome;
  const tagged = post.tags.map((t) => TAG_OUTCOME[t]).filter(Boolean);
  return tagged.length === 1 ? tagged[0] : null;
}

/** 最後誰贏：三紅、三藍被刀 = 紅方；三藍躲刺 = 藍方。 */
export function winnerOf(outcome: PaipuOutcome): 'red' | 'blue' {
  return outcome === '三藍活' ? 'blue' : 'red';
}

/** 第 5 次提議沒有標記 = 尾家強制局（沒有投票）。 */
export function isForcedProposal(attemptIndex: number, proposal: PaipuProposal): boolean {
  return attemptIndex === 4 && proposal.votes.length === 0;
}

/** 標記裡每個座位的贊成（+）／反對（-）。 */
export function voteMarks(votes: readonly string[]): Map<string, 'approve' | 'reject'> {
  const marks = new Map<string, 'approve' | 'reject'>();
  for (const token of votes) {
    for (const m of token.matchAll(/([0-9]+)([+-])/g)) {
      for (const seat of m[1]) marks.set(seat, m[2] === '+' ? 'approve' : 'reject');
    }
  }
  return marks;
}

/** 每個座位這次提議投什麼；強制局回傳 null。 */
export function proposalVotes(
  proposal: PaipuProposal,
  attemptIndex: number,
): Record<string, 'approve' | 'reject'> | null {
  if (isForcedProposal(attemptIndex, proposal)) return null;
  const marks = voteMarks(proposal.votes);
  const out: Record<string, 'approve' | 'reject'> = {};
  for (const seat of PAIPU_SEATS) {
    out[seat] = marks.get(seat) ?? (proposal.team.includes(seat) ? 'approve' : 'reject');
  }
  return out;
}

/** 贊成票數（強制局 null）。 */
export function approveCount(proposal: PaipuProposal, attemptIndex: number): number | null {
  const votes = proposalVotes(proposal, attemptIndex);
  return votes ? Object.values(votes).filter((v) => v === 'approve').length : null;
}

/** 湖的宣告怎麼顯示：o 宣告藍、x 宣告紅、? 未記錄（平台沒記到宣告）、沒寫。 */
export function lakeClaimLabel(claim: string): string {
  if (claim === 'o') return '宣告藍';
  if (claim === 'x') return '宣告紅';
  if (claim === '?') return '未記錄';
  return '沒寫宣告';
}

/** 任務失敗數。 */
export function missionFails(mission: string): number {
  return [...mission].filter((c) => c === 'x').length;
}

/** 這輪任務是紅方拿下（10 人局第 4 輪要兩張失敗）。 */
export function missionIsRed(mission: string, roundIndex: number): boolean {
  return missionFails(mission) >= (roundIndex === 3 ? 2 : 1);
}

/** 隊伍座位依 1..9、0 排好（顯示用）。 */
export function sortedTeam(team: string): string {
  return [...team].sort((a, b) => PAIPU_SEATS.indexOf(a as never) - PAIPU_SEATS.indexOf(b as never)).join('');
}

/** 照 DC 牌譜頻道的格式重組文字（牌譜各行 → 六碼 → 刺客刺殺:X → 1.暱稱 … 0.暱稱），可複製貼回 DC。 */
export function paipuText(game: PaipuGame): string {
  const lakes = new Map(game.lakes.map((l) => [l.after, l]));
  const lines: string[] = [];
  game.rounds.forEach((round, i) => {
    for (const p of round.proposals) lines.push([p.team, ...p.votes].join(' '));
    lines.push(round.mission);
    const lake = lakes.get(i + 1);
    if (lake) lines.push(`${lake.holder}>${lake.target}${lake.claim ? ` ${lake.claim}` : ''}`);
  });
  lines.push(game.config);
  lines.push(`刺客刺殺:${game.outcome === '三紅' ? '' : game.assassination}`);
  PAIPU_SEATS.forEach((seat, i) => lines.push(`${seat}.${game.names[i] ?? ''}`));
  return lines.join('\n');
}

/** 「到 DC 討論」的連結：那篇論壇貼文。 */
export function discordThreadUrl(id: string, guildId: string = DISCORD_GUILD_ID): string {
  return `https://discord.com/channels/${guildId}/${id}`;
}

export type PaipuResultFilter = 'all' | PaipuOutcome | 'unreadable';

export interface PaipuFilter {
  result: PaipuResultFilter;
  /** YYYY-MM-DD；空字串 = 不限。 */
  from: string;
  to: string;
  /** 暱稱（或標題）關鍵字；不分大小寫、全形半形。 */
  query: string;
}

export const EMPTY_PAIPU_FILTER: PaipuFilter = { result: 'all', from: '', to: '', query: '' };

/** 這篇有沒有通過篩選。暱稱比對用 playerNameKey（同戰績的認人規則），也比對標題。 */
export function matchesPaipu(post: PaipuPost, filter: PaipuFilter): boolean {
  if (filter.result === 'unreadable') {
    if (post.game) return false;
  } else if (filter.result !== 'all' && outcomeOf(post) !== filter.result) {
    return false;
  }
  if (filter.from && post.date < filter.from) return false;
  if (filter.to && post.date > filter.to) return false;
  const q = playerNameKey(filter.query);
  if (q) {
    const names = post.game?.names ?? [];
    if (!names.some((n) => playerNameKey(n).includes(q)) && !playerNameKey(post.title).includes(q)) return false;
  }
  return true;
}

/** 牌譜裡暱稱符合關鍵字的座位（清單上標出來）。 */
export function matchingSeats(post: PaipuPost, query: string): string[] {
  const q = playerNameKey(query);
  if (!q || !post.game) return [];
  return PAIPU_SEATS.filter((_, i) => playerNameKey(post.game?.names[i] ?? '').includes(q));
}

/** 牌譜的深連結 #paipu=<貼文 id>（#paipu 本身 = 牌譜紀錄頁籤）。 */
export function paipuHash(id?: string): string {
  return id ? `#paipu=${id}` : '#paipu';
}

/** #paipu → { id: null }；#paipu=<id> → { id }；其他 hash → null。 */
export function parsePaipuHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^paipu$/i.test(raw)) return { id: null };
  const m = /^paipu[=/]([0-9]{15,22})$/i.exec(raw);
  return m ? { id: m[1] } : null;
}
