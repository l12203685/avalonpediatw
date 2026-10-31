/**
 * 網站「牌譜紀錄」頁籤的純函式（Edward 2026-10-30：「百科網站可以直接多一個頁籤是『牌譜紀錄與覆盤』」）。
 *
 * 資料：GET /api/analysis/records = packages/server/records_cache.json（discord_records_export.py 每天從 Discord 論壇
 * #牌譜紀錄與覆盤 產生）。每篇貼文 = 一局：標題、標籤、發文時間，以及解析後的牌譜（或讀不懂的原因）。
 * 只有牌譜本身；討論串的回覆不在網站上，「到 DC 討論」連到那篇貼文。
 *
 * 牌譜慣例（同 DC）：座位 1–9 與 0（= 10 號）；提議一行一隊，後面的投票異常標記「57-」= 隊內 5、7 投反對（內黑），
 * 「6+」= 隊外 6 投贊成（外白），沒標的人照常（隊內贊成、隊外反對）；第 5 次提議是尾家強制局，沒有投票。
 * 配置六碼 = 刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林的座位，其餘是忠臣。
 *
 * 純函式放這裡，packages/server/src/__tests__/WebRecords.test.ts 測（web 沒有測試執行器）。
 */
import { playerNameKey } from '@avalon/shared';

export const RECORDS_SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export const DISCORD_GUILD_ID = '1132682489840812113';

export type RecordOutcome = '三紅' | '三藍死' | '三藍活';

export interface RecordProposal {
  /** 隊伍座位，照貼文寫的順序（0 = 10 號）。 */
  team: string;
  /** 投票異常標記，統一成符號在後：'7+'、'5-'、'57-6+'。 */
  votes: string[];
}

export interface RecordRound {
  proposals: RecordProposal[];
  /** 任務結果 o／x（小寫）。 */
  mission: string;
}

export interface RecordLake {
  /** 第幾輪任務結束後用湖（2–4）。 */
  after: number;
  holder: string;
  target: string;
  /** 宣告：o 藍、x 紅、? 不明、'' 沒寫。 */
  claim: '' | 'o' | 'x' | '?';
}

export interface RecordGame {
  config: string;
  /** 座位 1..9、0 的暱稱。 */
  names: string[];
  rounds: RecordRound[];
  lakes: RecordLake[];
  /** 刺殺目標座位；三紅或沒寫時 ''。 */
  assassination: string;
  outcome: RecordOutcome;
  category: '' | '線瓦' | '面瓦';
}

export interface RecordPost {
  /** Discord 討論串 id（= 起始訊息 id）。 */
  id: string;
  title: string;
  tags: string[];
  /** 發文時間（台北，ISO 8601）。 */
  created: string;
  /** 牌譜日期 YYYY-MM-DD（標題的 MMDD，沒有就發文日）。 */
  date: string;
  game: RecordGame | null;
  /** 讀不懂時的原因（固定的說明文字）與行號。 */
  problem?: string;
  problemLine?: number;
}

export interface RecordList {
  format: 'avalon-records';
  version: number;
  guildId: string;
  forumId: string;
  counts: { posts: number; games: number; unreadable: number };
  posts: RecordPost[];
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

export type RecordRole = (typeof CONFIG_ROLES)[number] | typeof LOYAL_ROLE;

/** 某座位的角色（配置裡沒有 = 忠臣）。 */
export function roleOfSeat(config: string, seat: string): RecordRole {
  const i = config.indexOf(seat);
  return i >= 0 && i < CONFIG_ROLES.length ? CONFIG_ROLES[i] : LOYAL_ROLE;
}

/** 結果的三種寫法：論壇標籤名稱（三紅／三藍被刀／三藍躲刺）。 */
export const RESULT_TAGS: Readonly<Record<RecordOutcome, string>> = {
  三紅: '三紅',
  三藍死: '三藍被刀',
  三藍活: '三藍躲刺',
};
const TAG_OUTCOME: Readonly<Record<string, RecordOutcome>> = { 三紅: '三紅', 三藍被刀: '三藍死', 三藍躲刺: '三藍活' };

/** 一篇的結果：讀得懂用牌譜的結果，否則看結果標籤（剛好一個才算）。 */
export function outcomeOf(post: RecordPost): RecordOutcome | null {
  if (post.game) return post.game.outcome;
  const tagged = post.tags.map((t) => TAG_OUTCOME[t]).filter(Boolean);
  return tagged.length === 1 ? tagged[0] : null;
}

/** 最後誰贏：三紅、三藍被刀 = 紅方；三藍躲刺 = 藍方。 */
export function winnerOf(outcome: RecordOutcome): 'red' | 'blue' {
  return outcome === '三藍活' ? 'blue' : 'red';
}

/** 第 5 次提議沒有標記 = 尾家強制局（沒有投票）。 */
export function isForcedProposal(attemptIndex: number, proposal: RecordProposal): boolean {
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
  proposal: RecordProposal,
  attemptIndex: number,
): Record<string, 'approve' | 'reject'> | null {
  if (isForcedProposal(attemptIndex, proposal)) return null;
  const marks = voteMarks(proposal.votes);
  const out: Record<string, 'approve' | 'reject'> = {};
  for (const seat of RECORDS_SEATS) {
    out[seat] = marks.get(seat) ?? (proposal.team.includes(seat) ? 'approve' : 'reject');
  }
  return out;
}

/** 贊成票數（強制局 null）。 */
export function approveCount(proposal: RecordProposal, attemptIndex: number): number | null {
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
  return [...team].sort((a, b) => RECORDS_SEATS.indexOf(a as never) - RECORDS_SEATS.indexOf(b as never)).join('');
}

/** 照 DC 牌譜頻道的格式重組文字（牌譜各行 → 六碼 → 刺客刺殺:X → 1.暱稱 … 0.暱稱），可複製貼回 DC。 */
export function recordsText(game: RecordGame): string {
  const lakes = new Map(game.lakes.map((l) => [l.after, l]));
  const lines: string[] = [];
  game.rounds.forEach((round, i) => {
    round.proposals.forEach((p, a) => lines.push(proposalLine(p, a)));
    lines.push(round.mission);
    const lake = lakes.get(i + 1);
    if (lake) lines.push(lakeLine(lake));
  });
  lines.push(game.config);
  lines.push(`刺客刺殺:${game.outcome === '三紅' ? '' : game.assassination}`);
  RECORDS_SEATS.forEach((seat, i) => lines.push(`${seat}.${game.names[i] ?? ''}`));
  return lines.join('\n');
}

/** 「到 DC 討論」的連結：那篇論壇貼文。 */
export function discordThreadUrl(id: string, guildId: string = DISCORD_GUILD_ID): string {
  return `https://discord.com/channels/${guildId}/${id}`;
}

export type RecordResultFilter = 'all' | RecordOutcome | 'unreadable';

export interface RecordFilter {
  result: RecordResultFilter;
  /** YYYY-MM-DD；空字串 = 不限。 */
  from: string;
  to: string;
  /** 暱稱（或標題）關鍵字；不分大小寫、全形半形。 */
  query: string;
}

export const EMPTY_RECORDS_FILTER: RecordFilter = { result: 'all', from: '', to: '', query: '' };

/** 這篇有沒有通過篩選。暱稱比對用 playerNameKey（同戰績的認人規則），也比對標題。 */
export function matchesRecords(post: RecordPost, filter: RecordFilter): boolean {
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
export function matchingSeats(post: RecordPost, query: string): string[] {
  const q = playerNameKey(query);
  if (!q || !post.game) return [];
  return RECORDS_SEATS.filter((_, i) => playerNameKey(post.game?.names[i] ?? '').includes(q));
}

/** 牌譜的深連結 #records=<貼文 id>（#records 本身 = 牌譜紀錄頁籤）。 */
export function recordsHash(id?: string): string {
  return id ? `#records=${id}` : '#records';
}

/** #records → { id: null }；#records=<id> → { id }；其他 hash → null。 */
export function parseRecordsHash(hash: string | null | undefined): { id: string | null } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^(?:records|paipu)$/i.test(raw)) return { id: null };
  const m = /^(?:records|paipu)[=/]([0-9]{15,22})$/i.exec(raw);
  return m ? { id: m[1] } : null;
}

/** 改名前的舊連結（#paipu、#paipu=<id>，2026-10-31 以前分享的）：App 換成新的 #records…。 */
export function isLegacyRecordsHash(hash: string | null | undefined): boolean {
  return /^#?paipu(?:$|[=/])/i.test((hash ?? '').trim());
}

/**
 * 「顯示角色」「顯示名稱」兩個開關（Edward 2026-10-31：「角色跟玩家名稱可以選擇是否展示」），預設都關、記在瀏覽器。
 * 關掉時整局畫面都不出現角色／暱稱，只看座位號（DC 格式文字與討論串回覆是原文，不受影響）。
 */
export interface RecordDisplayPrefs {
  roles: boolean;
  names: boolean;
}

export const RECORDS_PREF_KEYS: Readonly<Record<keyof RecordDisplayPrefs, string>> = {
  roles: 'avalon.records.showRoles',
  names: 'avalon.records.showNames',
};

/** 從儲存讀開關（只有 '1' 算開；讀不到、無痕或封鎖儲存 = 關）。 */
export function readRecordsPrefs(getItem: (key: string) => string | null): RecordDisplayPrefs {
  const read = (key: string): boolean => {
    try {
      return getItem(key) === '1';
    } catch {
      return false;
    }
  };
  return { roles: read(RECORDS_PREF_KEYS.roles), names: read(RECORDS_PREF_KEYS.names) };
}

/** 一個座位在畫面上的寫法：「3 號」，開了名稱加暱稱、開了角色加（角色）。 */
export function seatLabel(game: RecordGame, seat: string, prefs: RecordDisplayPrefs): string {
  const i = RECORDS_SEATS.indexOf(seat as (typeof RECORDS_SEATS)[number]);
  const name = prefs.names ? game.names[i] ?? '' : '';
  const role = prefs.roles ? `（${roleOfSeat(game.config, seat).name}）` : '';
  return `${seat} 號${name ? ` ${name}` : ''}${role}`;
}

/** 結果的說明句；關掉角色時不寫刺殺對象的角色、也不寫刺中梅林與否（結果標籤本身就說了）。 */
export function resultSentence(game: RecordGame, prefs: RecordDisplayPrefs): string {
  if (game.outcome === '三紅') return '紅方拿下三次任務';
  if (!game.assassination) {
    if (!prefs.roles) return '藍方拿下三次任務';
    return game.outcome === '三藍死' ? '藍方拿下三次任務；梅林被刺中' : '藍方拿下三次任務；刺客沒刺中梅林';
  }
  const assassin = game.config[0];
  const target = game.assassination;
  // 刺客是誰也是角色資訊：關掉角色時只寫刺殺了幾號
  if (!prefs.roles) return `藍方拿下三次任務；刺殺 ${seatLabel(game, target, prefs)}`;
  const base = `藍方拿下三次任務；刺客 ${seatLabel(game, assassin, { ...prefs, roles: false })} 刺殺 ${seatLabel(game, target, prefs)}`;
  return `${base}${target === game.config[5] ? '，刺中梅林' : '，沒刺中'}`;
}

/**
 * 每次提議的隊長（Edward 2026-10-31 的試算表牌譜有「隊長」欄）。DC 牌譜沒寫隊長，隊伍座位也是排序過的，只能推算：
 * 隊長每次提議（跨輪也一樣）往下一個座位輪替（1→2→…→9→0→1），第一位隊長不知道。隊長通常會派自己上車，所以試十種起點，
 * 取「隊長在隊伍裡」次數最多的那個；要夠明確（至少八成的提議、而且比第二名多 3 次以上）才採用，否則回傳 null（畫面照舊顯示第幾輪第幾次）。
 * 回傳每輪每次提議的隊長座位。
 */
export const LEADER_MIN_SHARE = 0.8;
export const LEADER_MIN_MARGIN = 3;

export function deriveLeaders(game: RecordGame): string[][] | null {
  const teams = game.rounds.flatMap((r) => r.proposals.map((p) => p.team));
  if (teams.length === 0) return null;
  const leaderAt = (start: number, k: number): string => RECORDS_SEATS[(start + k) % RECORDS_SEATS.length];
  const cover = RECORDS_SEATS.map((_, start) => teams.filter((team, k) => team.includes(leaderAt(start, k))).length);
  const best = Math.max(...cover);
  const start = cover.indexOf(best);
  const second = Math.max(...cover.filter((_, i) => i !== start));
  if (best < teams.length * LEADER_MIN_SHARE || best - second < LEADER_MIN_MARGIN) return null;
  let k = 0;
  return game.rounds.map((r) => r.proposals.map(() => leaderAt(start, k++)));
}

/**
 * 一次提議在 DC 牌譜裡的那一行（Edward 10/31：「異常票要列出來…基本上就是 DC 牌譜格式的文字」）：隊伍座位，
 * 接著內黑（隊內反對）座位加 -、外白（隊外贊成）座位加 +，順序同 DC 牌譜頻道的寫法（內黑在前），例：「2579 7- 1+」、
 * 「1345 26780+」。強制局（第 5 次、沒有標記）只有隊伍。從實際的票重組，所以不管原文怎麼寫標記，順序都一致。
 */
export function proposalLine(proposal: RecordProposal, attemptIndex: number): string {
  const votes = proposalVotes(proposal, attemptIndex);
  if (!votes) return proposal.team;
  const black = RECORDS_SEATS.filter((s) => proposal.team.includes(s) && votes[s] === 'reject').join('');
  const white = RECORDS_SEATS.filter((s) => !proposal.team.includes(s) && votes[s] === 'approve').join('');
  return [proposal.team, black && `${black}-`, white && `${white}+`].filter(Boolean).join(' ');
}

/** 湖在 DC 牌譜裡的那一行（例：「0>3 x」）。 */
export function lakeLine(lake: RecordLake): string {
  return `${lake.holder}>${lake.target}${lake.claim ? ` ${lake.claim}` : ''}`;
}
