/**
 * 網站「牌譜紀錄」頁籤的純函式（Edward 2026-10-30：「百科網站可以直接多一個頁籤是『牌譜紀錄與覆盤』」）。
 *
 * 資料：GET /api/analysis/records = packages/server/records_cache.json（discord_records_export.py 每天產生）。
 * 所有來源的牌譜合成一個資料庫（Edward 2026-11-16）：Discord 論壇 #牌譜紀錄與覆盤 的貼文（id = 貼文 id）、
 * Google 試算表「牌譜」分頁（id = S＋流水號）、「模擬瓦」分頁（id = M＋流水號）；同一局只列一次（DC 貼文優先，
 * src 標出來源，其他來源的局號在 aka，舊連結照樣打得開）。每筆 = 一局：標題、標籤、發文時間，以及解析後的牌譜（或讀不懂的原因）。
 * 只有牌譜本身；討論串的回覆不在網站上，「到 DC 討論」連到那篇貼文（只有 DC 的局有）。
 *
 * 牌譜慣例（同 DC）：座位 1–9 與 0（0 家）；提議一行一隊，後面的投票異常標記「57-」= 隊內 5、7 投反對（內黑），
 * 「6+」= 隊外 6 投贊成（外白），沒標的人照常（隊內贊成、隊外反對）；第 5 次提議是尾家強制局，沒有投票。
 * 配置六碼 = 刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林的座位，其餘是忠臣。
 *
 * 純函式放這裡，packages/server/src/__tests__/WebRecords.test.ts 測（web 沒有測試執行器）。
 */
import { playerNameKey } from '@avalon/shared';
import { matchesLineup, roleStrength, type GameLineup, type LineupSeats, type RoleStrength } from '@avalon/shared/stats';
import {
  DEFAULT_LINEUP_FILTER,
  lineupCondition,
  lineupFilterActive,
  sanitizeLineupState,
  type LineupFilterState,
} from './lineupFilter';
import { recordMatchesBranch, sanitizeBranch, type RecordBranch } from '../components/analysis/stateTree/recordBranch';

export const RECORDS_SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export const DISCORD_GUILD_ID = '1132682489840812113';

export type RecordOutcome = '三紅' | '三藍死' | '三藍活';

export interface RecordProposal {
  /** 隊伍座位，照貼文寫的順序（0 = 0 家）。 */
  team: string;
  /** 投票異常標記，統一成符號在後：'7+'、'5-'、'57-6+'。 */
  votes: string[];
}

export interface RecordRound {
  proposals: RecordProposal[];
  /** 任務結果 o／x（小寫）；模擬局最後一輪還沒出任務時是 ''。 */
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
  /** 模擬局沒打完時是 ''。 */
  outcome: RecordOutcome | '';
  category: '' | '線瓦' | '面瓦' | '娛樂' | '其他';
}

/**
 * 陣容強度（discord_records_export.py 用 generate_cache.compute_lineups 算，Edward 2026-10-31）：開打前每個座位在
 * 「生涯已 ≥30 場」的玩家池裡的 PR；S = 10 人 PR 的平均。沒評分（玩家池太小、名字不夠…）就沒有這個欄位。
 */
export interface RecordLineup {
  /** 當時玩家池人數。 */
  pool: number;
  s: number;
  /** 座位 1..9、0 的 PR（0–100）。 */
  prs: number[];
  /** 暫定（賽前 <30 場）或對不到人的座位：PR 最高 50，不算進「PR X 以上」的人數。 */
  prov: string;
}

/** 可從紀錄直接證明的失誤：[標籤, 第幾輪（嚴重失誤這個總標籤是 0）, 相關座位]。 */
export type RecordMistake = [tag: string, round: number, seats: string];

/** 來源：沒有 = 只在 DC；'dc+sheet' = DC 貼文、試算表也有同一局；'sheet' = 只在試算表（id 是 S… 或 M…）。 */
export type RecordSource = 'dc+sheet' | 'sheet';

export interface RecordPost {
  /** Discord 討論串 id（= 起始訊息 id）；只在試算表的局是 S＋流水號（牌譜分頁）或 M＋流水號（模擬瓦分頁）。 */
  id: string;
  /**
   * 同一局的其他局號（伺服器組清單時從牌譜總庫 game_db.json 的 sources 補上，services/recordsList.ts recordAliases）：
   * 試算表也有的 DC 局的 S…、Discord匯入的 D…、重複貼文的另一篇等。#records=<這些 id> 也打開這一篇（findRecordPost）。
   */
  aka?: string[];
  src?: RecordSource;
  /** 模擬局（DC 標「模擬」的貼文、試算表模擬瓦分頁）。 */
  sim?: true;
  title: string;
  tags: string[];
  /** 發文時間（台北，ISO 8601）；只在試算表的局是 ''。 */
  created: string;
  /** 牌譜日期 YYYY-MM-DD（標題的 MMDD，沒有就發文日）；試算表沒寫日期的局是 ''。 */
  date: string;
  game: RecordGame | null;
  /** 讀不懂時的原因（固定的說明文字）與行號。 */
  problem?: string;
  problemLine?: number;
  lineup?: RecordLineup;
  mistakes?: RecordMistake[];
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
  if (post.game) return post.game.outcome || null;
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
    if (round.mission) lines.push(round.mission);
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

/** 這局有沒有 DC 貼文（只在試算表的局沒有討論串、回覆）。 */
export function isDiscordPost(post: Pick<RecordPost, 'id'>): boolean {
  return /^[0-9]{15,22}$/.test(post.id);
}

/** 來源標籤（清單與單局頁）：DC／試算表／DC＋試算表。 */
export function sourceLabel(post: Pick<RecordPost, 'id' | 'src'>): string {
  if (post.src === 'sheet' || !isDiscordPost(post)) return '試算表';
  return post.src === 'dc+sheet' ? 'DC＋試算表' : 'DC';
}

/** 實戰／模擬。 */
export function kindLabel(post: Pick<RecordPost, 'sim'>): '實戰' | '模擬' {
  return post.sim ? '模擬' : '實戰';
}

/** 失誤標籤（順序與名稱同 generate_cache.MISTAKE_TAGS）與說明。 */
export const SERIOUS_MISTAKE = '嚴重失誤';
export const RECORD_MISTAKE_TAGS: ReadonlyArray<{ tag: string; serious: boolean; help: string }> = [
  { tag: SERIOUS_MISTAKE, serious: true, help: '有「已證有紅的隊出任務」或「藍方隊長派已證有紅的隊」' },
  { tag: '已證有紅的隊出任務', serious: true, help: '前面失敗任務的隊員組成，已經公開證明這隊裡的紅方足以讓任務失敗，這隊還是出任務了' },
  { tag: '藍方隊長派已證有紅的隊', serious: true, help: '藍方隊長（隊長照輪替推算）提出了從他自己的視角已證明有紅的隊' },
  { tag: '藍方贊成已證有紅的隊', serious: false, help: '藍方對自己視角已證明有紅的隊投贊成（非強制、票數與結果對得上的提議）' },
  { tag: '藍方持湖宣告不符（待查）', serious: false, help: '梅林以外的藍方持湖，宣告的陣營與目標的真實陣營不同（可能是記錄打錯或刻意）' },
  { tag: '紅方賽點未出失敗（待查）', serious: false, help: '紅方已拿兩次任務、隊上紅方足以讓任務失敗，任務卻成功（可能是撞牌或記錄錯誤）' },
];

/** 一篇的失誤標籤（不重複，照 RECORD_MISTAKE_TAGS 的順序）。 */
export function mistakeTags(post: RecordPost): string[] {
  const own = new Set((post.mistakes ?? []).map((m) => m[0]));
  return RECORD_MISTAKE_TAGS.map((m) => m.tag).filter((t) => own.has(t));
}

/** 滑鼠提示：每次發生的輪次與座位（「第 2 輪：5、6、7、0 家」）。 */
export function mistakeDetails(post: RecordPost, tag: string): string[] {
  return (post.mistakes ?? [])
    .filter((m) => m[0] === tag && m[1] > 0)
    .map(([, round, seats]) => `第 ${round} 輪${seats ? `：${[...seats].join('、')} 家` : ''}`);
}

/** 貼文的陣容強度 → 共用判斷用的形狀（沒評分 = null）。 */
export function postLineup(post: RecordPost): GameLineup | null {
  const l = post.lineup;
  if (!l || !post.game) return null;
  return { pool: l.pool, s: l.s, prs: l.prs, prov: RECORDS_SEATS.map((seat) => l.prov.includes(seat)), elos: null };
}

/** 貼文的角色（配置）與有寫名字的座位，給角色條件與角色強度用。 */
export function postSeats(post: RecordPost): LineupSeats | null {
  const game = post.game;
  if (!game) return null;
  return {
    roles: RECORDS_SEATS.map((seat) => roleOfSeat(game.config, seat).name),
    known: RECORDS_SEATS.map((_, i) => Boolean((game.names[i] ?? '').trim())),
  };
}

/** 貼文的紅方／忠臣／藍方 PR（平均、最高、最低）與梅林、派西、刺客 PR；沒評分 = null。 */
export function postRoleStrength(post: RecordPost): RoleStrength | null {
  const lineup = postLineup(post);
  const seats = postSeats(post);
  return lineup && seats ? roleStrength(lineup, seats) : null;
}

export type RecordResultFilter = 'all' | RecordOutcome | 'unreadable';

/** 實戰／模擬（預設只看實戰，模擬一鍵切換）。 */
export type RecordKindFilter = 'real' | 'sim' | 'all';

export interface RecordFilter {
  kind: RecordKindFilter;
  result: RecordResultFilter;
  /** YYYY-MM-DD；空字串 = 不限。 */
  from: string;
  to: string;
  /** 暱稱（或標題）關鍵字；不分大小寫、全形半形。 */
  query: string;
  /** 陣容強度（S、PR X 以上至少 Y 人、且／或、包含未評分）。 */
  lineup: LineupFilterState;
  /** 失誤標籤：有選時，有任一個選到的標籤才列出。 */
  mistakes: string[];
  /** 數據分析「局勢樹」的分支（任務順序開頭 + 湖的宣告；從局勢樹的節點帶過來）。 */
  branch?: RecordBranch;
}

export const EMPTY_RECORDS_FILTER: RecordFilter = {
  kind: 'real', result: 'all', from: '', to: '', query: '', lineup: DEFAULT_LINEUP_FILTER, mistakes: [],
};

/** 篩選有沒有在作用（清除篩選按鈕、「符合幾局」）；實戰／模擬是分頁切換，不算。 */
export function recordsFilterActive(filter: RecordFilter): boolean {
  return filter.result !== 'all' || Boolean(filter.from || filter.to || filter.query.trim())
    || lineupFilterActive(filter.lineup) || filter.mistakes.length > 0 || Boolean(filter.branch);
}

/** 篩選記在瀏覽器（同顯示角色／名稱的開關）：下次打開牌譜紀錄還是同樣的條件。 */
export const RECORDS_FILTER_KEY = 'avalon.records.filter';

const RESULT_FILTERS: readonly RecordResultFilter[] = ['all', '三紅', '三藍死', '三藍活', 'unreadable'];
const KIND_FILTERS: readonly RecordKindFilter[] = ['real', 'sim', 'all'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 儲存的文字 → 篩選（讀不到、格式不對的欄位用預設值）。 */
export function parseRecordsFilter(text: string | null): RecordFilter {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const tags = new Set(RECORD_MISTAKE_TAGS.map((m) => m.tag));
  const branch = sanitizeBranch(raw.branch);
  return {
    ...(branch ? { branch } : {}),
    kind: KIND_FILTERS.includes(raw.kind as RecordKindFilter) ? (raw.kind as RecordKindFilter) : 'real',
    result: RESULT_FILTERS.includes(raw.result as RecordResultFilter) ? (raw.result as RecordResultFilter) : 'all',
    from: typeof raw.from === 'string' && DATE_RE.test(raw.from) ? raw.from : '',
    to: typeof raw.to === 'string' && DATE_RE.test(raw.to) ? raw.to : '',
    query: typeof raw.query === 'string' ? raw.query.slice(0, 100) : '',
    lineup: sanitizeLineupState(raw.lineup),
    mistakes: Array.isArray(raw.mistakes) ? raw.mistakes.filter((t): t is string => typeof t === 'string' && tags.has(t)) : [],
  };
}

/** 這篇有沒有通過篩選。暱稱比對用 playerNameKey（同戰績的認人規則），也比對標題。 */
export function matchesRecords(post: RecordPost, filter: RecordFilter): boolean {
  if (filter.kind === 'real' && post.sim) return false;
  if (filter.kind === 'sim' && !post.sim) return false;
  if (lineupFilterActive(filter.lineup) && !matchesLineup(postLineup(post), lineupCondition(filter.lineup), postSeats(post))) {
    return false;
  }
  if (filter.branch && !recordMatchesBranch(post.game, filter.branch)) return false;
  if (filter.mistakes.length > 0) {
    const own = mistakeTags(post);
    if (!filter.mistakes.some((t) => own.includes(t))) return false;
  }
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
    if (!names.some((n) => playerNameKey(n).includes(q)) && !playerNameKey(post.title).includes(q) && !matchesRecordIds(post, filter.query)) return false;
  }
  return true;
}

/**
 * 站長 2026-11-20「例如透過配置 870563 直接找到該局」：搜尋框也認配置六碼（例 870563，可以只打前幾碼）
 * 和局號（DC 貼文 id、S…、M…、D…、P…，含 aka）。
 */
export function matchesRecordIds(post: RecordPost, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return false;
  if (/^\d{4,6}$/.test(q) && post.game?.config && post.game.config.startsWith(q)) return true;
  const ids = [post.id, ...(post.aka ?? [])].map((x) => x.toLowerCase());
  return q.length >= 3 && ids.some((x) => x === q || (q.length >= 6 && x.includes(q)));
}

/** 牌譜裡暱稱符合關鍵字的座位（清單上標出來）。 */
export function matchingSeats(post: RecordPost, query: string): string[] {
  const q = playerNameKey(query);
  if (!q || !post.game) return [];
  return RECORDS_SEATS.filter((_, i) => playerNameKey(post.game?.names[i] ?? '').includes(q));
}

/**
 * 「只到出題的那一刻」（2026-11-18，每日小觀念與 Threads 題目的牌局連結：站長「牌局: 優先以當日 threads/IG 發文的題目」）：
 *   upto = 出題的那一次派票（整局第幾次，從 0 數；proposals 照輪次攤平的順序）——那一次（含）之後的票、任務、湖都藏起來；
 *          'A' = 刺殺題：任務、湖都看得到，藏起刺殺與結果。
 *   seat = 出題的那一家（'1'～'9'、'0'）：只顯示他自己的角色與他看得到的資訊；沒給就一個角色都不顯示。
 * 不管哪一種，結果、刺殺、其他人的角色、標題與標籤（可能寫了結果）、DC 回覆都不顯示；按「看完整牌譜」才打開整局。
 */
export interface RecordCut {
  upto: number | 'A';
  seat?: string;
}

/** 牌譜的深連結 #records=<貼文 id>（#records 本身 = 牌譜紀錄頁籤）；給了 cut 就加 &upto=…&seat=…。 */
export function recordsHash(id?: string, cut?: RecordCut | null): string {
  if (!id) return '#records';
  if (!cut) return `#records=${id}`;
  return `#records=${id}&upto=${cut.upto}${cut.seat ? `&seat=${cut.seat}` : ''}`;
}

/**
 * 局號正規化：DC 貼文 id（15～22 位數字）、S／M＋流水號（試算表牌譜／模擬瓦分頁）、D＋10 碼雜湊（試算表 Discord匯入）、
 * P＋24 碼（ProAvalon）；大小寫不拘（s1629 → S1629、D7FB… → D7fb…）。看不懂 → null。
 */
export function normaliseRecordsId(raw: string): string | null {
  const t = raw.trim();
  if (/^[0-9]{15,22}$/.test(t)) return t;
  if (/^[SM][0-9]{1,6}$/i.test(t)) return t.toUpperCase();
  if (/^D[0-9a-f]{10}$/i.test(t) || /^P[0-9a-f]{24}$/i.test(t)) return t[0].toUpperCase() + t.slice(1).toLowerCase();
  return null;
}

/**
 * #records=<id> 打開哪一篇：id 本身就是一篇 → 那一篇；不然找 aka 有這個 id 的那一篇（同一局合併後只留一篇，
 * 舊連結用的是另一個來源的局號，例：試算表 S1629 = DC 貼文那一篇）；都沒有 → undefined。
 */
export function findRecordPost<T extends Pick<RecordPost, 'id' | 'aka'>>(posts: readonly T[], id: string): T | undefined {
  return posts.find((p) => p.id === id) ?? posts.find((p) => p.aka?.includes(id));
}

/**
 * #records → { id: null }；#records=<id> → { id }（DC 貼文 id、S／M＋流水號、D＋雜湊、P＋ProAvalon id；normaliseRecordsId）；
 * #records=<id>&upto=<n|A>[&seat=<1-9|0>] → { id, cut }（upto 不認得就當作沒有 cut）；其他 hash → null。
 */
export function parseRecordsHash(hash: string | null | undefined): { id: string | null; cut?: RecordCut } | null {
  const raw = (hash ?? '').replace(/^#/, '').trim();
  if (/^(?:records|paipu)$/i.test(raw)) return { id: null };
  const m = /^(?:records|paipu)[=/]([0-9A-Za-z]{2,25})((?:&[a-z]+=[^&]*)*)$/i.exec(raw);
  const id = m ? normaliseRecordsId(m[1]) : null;
  if (!m || !id) return null;
  const params = new Map(m[2].split('&').filter(Boolean).map((p) => p.split('=') as [string, string]));
  const upto = params.get('upto');
  if (upto === undefined) return { id };
  const seat = params.get('seat');
  const cutUpto = /^a$/i.test(upto) ? 'A' : /^\d{1,3}$/.test(upto) ? Number(upto) : null;
  if (cutUpto === null) return { id };
  return { id, cut: { upto: cutUpto, ...(seat && /^[0-9]$/.test(seat) ? { seat } : {}) } };
}

/** cut 的視角：那一家的角色與他看得到的座位（照標準規則：梅林看到莫德雷德以外的紅、紅方互認但看不到奧伯倫、派西看到兩根拇指）。 */
export interface CutViewer {
  seat: string;
  role: RecordRole;
  /** 看到的座位與說明，例如「看到的紅方：3、7、9」。沒有資訊就 null。 */
  knows: string | null;
}

export function cutViewer(config: string, seat: string | undefined): CutViewer | null {
  if (!seat || !RECORDS_SEATS.includes(seat as (typeof RECORDS_SEATS)[number])) return null;
  const role = roleOfSeat(config, seat);
  const at = (i: number): string => config[i] ?? '';
  const list = (seats: string[]): string => seats.filter((s) => s && s !== seat).sort((a, b) => RECORDS_SEATS.indexOf(a as (typeof RECORDS_SEATS)[number]) - RECORDS_SEATS.indexOf(b as (typeof RECORDS_SEATS)[number])).join('、');
  let knows: string | null = null;
  // 配置六碼：刺客、莫甘娜、莫德雷德、奧伯倫、派西維爾、梅林。
  if (role.name === '梅林') knows = `看到的紅方：${list([at(0), at(1), at(3)])}（莫德雷德看不到）`;
  else if (role.name === '派西維爾') knows = `兩根拇指（梅林和莫甘娜）：${list([at(5), at(1)])}`;
  else if (role.name === '刺客' || role.name === '莫甘娜' || role.name === '莫德雷德') knows = `紅方隊友：${list([at(0), at(1), at(2)])}（奧伯倫看不到）`;
  return { seat, role, knows };
}

/**
 * 牌譜切到出題的那一刻：upto 之前的派票（票照舊）、那之前已經出完的任務與湖；配置、刺殺、結果、名字都清掉。
 * upto 超過整局的派票數（資料對不上）時整局的派票都留著，但結果照樣藏起來。
 */
export function cutRecordGame(game: RecordGame, cut: RecordCut): RecordGame {
  const hidden = { config: '', assassination: '', outcome: '' as const, names: game.names.map(() => '') };
  if (cut.upto === 'A') return { ...game, ...hidden };
  let left = cut.upto;
  const rounds: RecordRound[] = [];
  let stopRound = game.rounds.length;
  for (let r = 0; r < game.rounds.length; r++) {
    const round = game.rounds[r];
    if (left >= round.proposals.length) {
      rounds.push(round);
      left -= round.proposals.length;
      continue;
    }
    // 出題的那一局：那一次之前的派票，任務還沒出。
    rounds.push({ proposals: round.proposals.slice(0, left), mission: '' });
    stopRound = r;
    break;
  }
  // 湖：只留出題那一局之前已經用完的（第 r 局結束後用湖 = after r）。
  const lakes = game.lakes.filter((l) => l.after <= stopRound);
  return { ...game, ...hidden, rounds: rounds.filter((r, i) => r.proposals.length > 0 || i < stopRound), lakes };
}

/** cut 停在哪裡的說明：「第 3 局第 5 次派票」或「刺殺」。 */
export function cutLabel(game: RecordGame, cut: RecordCut): string {
  if (cut.upto === 'A') return '刺殺';
  let left = cut.upto;
  for (let r = 0; r < game.rounds.length; r++) {
    const n = game.rounds[r].proposals.length;
    if (left < n) return `第 ${r + 1} 局第 ${left + 1} 次派票`;
    left -= n;
  }
  return '整局最後';
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

/** 一個座位在畫面上的寫法：「3 家」（第十個座位是「0 家」），開了名稱加暱稱、開了角色加（角色）。 */
export function seatLabel(game: RecordGame, seat: string, prefs: RecordDisplayPrefs): string {
  const i = RECORDS_SEATS.indexOf(seat as (typeof RECORDS_SEATS)[number]);
  const name = prefs.names ? game.names[i] ?? '' : '';
  const role = prefs.roles ? `（${roleOfSeat(game.config, seat).name}）` : '';
  return `${seat} 家${name ? ` ${name}` : ''}${role}`;
}

/** 結果的說明句；關掉角色時不寫刺殺對象的角色、也不寫刺中梅林與否（結果標籤本身就說了）。 */
export function resultSentence(game: RecordGame, prefs: RecordDisplayPrefs): string {
  if (game.outcome === '') {
    const done = game.rounds.filter((r) => r.mission).length;
    return `模擬：${done ? `打完 ${done} 輪任務` : '還沒出任務'}，還沒分出勝負`;
  }
  if (game.outcome === '三紅') return '紅方拿下三次任務';
  if (!game.assassination) {
    if (!prefs.roles) return '藍方拿下三次任務';
    return game.outcome === '三藍死' ? '藍方拿下三次任務；梅林被刺中' : '藍方拿下三次任務；刺客沒刺中梅林';
  }
  const assassin = game.config[0];
  const target = game.assassination;
  // 刺客是誰也是角色資訊：關掉角色時只寫刺殺了幾家
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

/** 文字牌譜一行裡的一段，kind 決定顏色（RecordTextLine）。 */
export type RecordTextPart = { text: string; kind: 'team' | 'mark' | 'missionRed' | 'missionBlue' | 'lake' | 'claimGood' | 'claimEvil' | 'plain' };

const TEXT_MISSION_RE = /^[ox]{3,5}$/;
const TEXT_LAKE_RE = /^([0-9])>([0-9])(?: ([ox]))?$/;
const TEXT_MARK_RE = /^[0-9]+[+-]$/;

/** 這行是任務結果（ooox 這種）。 */
export function isMissionTextLine(line: string): boolean {
  return TEXT_MISSION_RE.test(line.trim());
}

/**
 * 文字牌譜一行切成上色的段（站長 2026-11-17「異常票有變色不錯 百科網站上的文字紀錄呈現也可以調整」）：
 * 隊伍白、值得注意的票（1- 36+）綠、任務結果紅方拿下紅／藍方拿下藍（roundIndex 0～4，第 4 輪要兩張失敗）、湖青色＋宣告藍／紅。
 * 其他行（六碼、刺客刺殺、暱稱）整行 plain。
 */
export function recordLineParts(line: string, roundIndex?: number): RecordTextPart[] {
  const t = line.trim();
  if (TEXT_MISSION_RE.test(t)) {
    const red = missionIsRed(t, roundIndex ?? (t.length === 5 ? 3 : 0));
    return [{ text: line, kind: red ? 'missionRed' : 'missionBlue' }];
  }
  const lake = TEXT_LAKE_RE.exec(t);
  if (lake) {
    const parts: RecordTextPart[] = [{ text: `${lake[1]}>${lake[2]}`, kind: 'lake' }];
    if (lake[3]) parts.push({ text: ` ${lake[3]}`, kind: lake[3] === 'o' ? 'claimGood' : 'claimEvil' });
    return parts;
  }
  const words = t.split(' ');
  if (words.length > 1 && /^[0-9]+$/.test(words[0]) && words.slice(1).every((w) => TEXT_MARK_RE.test(w))) {
    return [{ text: words[0], kind: 'team' }, ...words.slice(1).map((w) => ({ text: ` ${w}`, kind: 'mark' as const }))];
  }
  return [{ text: line, kind: 'plain' }];
}
