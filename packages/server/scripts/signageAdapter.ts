/**
 * 遊玩頁（avalon.signage-cloud.org）畫面資料 ⇄ 百科 AI（HeuristicAgent）的轉接層。
 *
 * 純函式（不碰瀏覽器），scripts/signagePlay.ts（多個百科機器人一桌）與 scripts/signagePlayer.ts
 * （一個百科機器人去補位）共用；單元測試：src/__tests__/SignageAdapter.test.ts。
 *
 * 練習台的畫面資料（房間頁 Vue app 的欄位，TransformUsers / TransformMySelf）：
 *   - users[]：每個座位 set（1–10）、crown（隊長）、tick（被派進隊伍）、role（自己看得到的身分字串，
 *     看不到時 'unknown'；梅林／紅方看到的紅方是 'bad'，派西維爾看到的大拇指是 '梅莫'，湖到的人翻成 'good'／'bad'）。
 *   - myself：自己的角色名（梅林、派西維爾、雜魚1…、刺客、莫甘娜、莫德雷德、奧伯倫、爪牙1…）、is_good，
 *     以及「現在輪到我做什麼」的開關 can_dispatch_ticks / can_start_vote / can_vote / can_to_mission /
 *     can_lake_to / can_select_lake_result / can_assassin_to / can_verify。
 *   - missions：已完成任務的成敗；lake_result：每次湖 { from, to, result }（result＝持湖者宣告的好／壞，沒宣告是 null）。
 *   - 派票紀錄（房內「紀錄下載」同一份資料，SyncGameStatistics → RecvGameStatistics）：每輪的提議
 *     { ticks_set, white_ball_set, captain_set } 與任務 { member, result }。
 *
 * 練習台和百科的規則差異（照練習台）：第 5 次派隊是強制局（不投票直接出任務，紀錄裡是全員白球）；
 * 湖的宣告只有好／壞（AI 決定不宣告就不按）。
 */
import type { Role } from '@avalon/shared';
import { isPediaBotName } from './signagePaipu';
import type { LakePublicRecord, PlayerObservation, PrivateLakeResult, QuestRecord, VoteRecord } from '../src/ai/types';

// ── 練習台畫面資料 ─────────────────────────────────────────────────────────────────────
export interface SUser {
  id: string; name: string; master: boolean; role: string; set: number; crown: boolean; tick: boolean;
  vote_bag: boolean | null; lake: number | null; is_robot: boolean; dead: boolean;
}
export interface SMyself {
  id: string; name: string; master: boolean; role: string; is_good: boolean; set: number; vote_bag: boolean | null;
  can_dispatch_ticks: boolean; can_to_mission: boolean; can_vote: boolean; can_start_vote: boolean;
  can_lake_to: boolean; can_select_lake_result: boolean; can_assassin_to: boolean; can_verify: boolean;
  can_chat?: boolean; can_leave_free?: boolean; action_tip?: string; tick?: boolean; crown?: boolean;
}
export interface SLake { from: number; to: number | null; result: boolean | null }
export interface Snap {
  gaming: boolean; status: string; myself: SMyself; users: SUser[]; free_ticks: number;
  missions: boolean[]; mission_result?: boolean[]; lake_result: SLake[];
  /** 房間的角色設定（例：['梅林','刺客','派西維爾','雜魚1',…]）與規則開關。 */
  game_roles?: string[]; enable_lake?: boolean; enable_sword?: boolean;
}
export interface PlatformMeeting { ticks_set: number[]; white_ball_set: number[]; captain_set: number }
export interface PlatformRecord {
  [round: string]: { meetings?: PlatformMeeting[]; mission_history?: { member: number[]; result: boolean[] } | null } | number | undefined;
}

export const ENDED = '遊戲結束';

// ── 座位與角色 ─────────────────────────────────────────────────────────────────────────
export const sid = (set: number): string => `S${set}`;
export const setOf = (id: string): number => Number(id.slice(1));
/** 這一桌所有座位（依座號）。指定房間時桌上不一定是 10 人（練習台 5–10 人都能開）。 */
export const seatIds = (s: Pick<Snap, 'users'>): string[] => s.users.map((u) => u.set).sort((a, b) => a - b).map(sid);

const ROLE_OF: Record<string, Role> = {
  梅林: 'merlin', 派西維爾: 'percival', 刺客: 'assassin', 莫甘娜: 'morgana', 莫德雷德: 'mordred', 奧伯倫: 'oberon',
};
/** 練習台的角色名 → 百科角色；不支援的角色（例：蘭斯洛特）回傳 null。 */
export function roleOf(name: string): Role | null {
  if (ROLE_OF[name]) return ROLE_OF[name];
  if (/^雜魚\d*$/.test(name)) return 'loyal';
  if (/^爪牙\d*$/.test(name)) return 'minion';
  return null;
}
const EVIL_ROLES = new Set<Role>(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

/**
 * 房間的角色設定 → AI 的 lobbyRoles；有不支援的角色、或不是 5–10 人的設定時回傳 null。
 */
export function lobbyRolesOf(gameRoles: readonly string[] | undefined): Role[] | null {
  if (!gameRoles || gameRoles.length < 5 || gameRoles.length > 10) return null;
  const roles = gameRoles.map(roleOf);
  if (roles.some((r) => r === null)) return null;
  const rs = roles as Role[];
  if (!rs.includes('merlin') || !rs.includes('assassin')) return null;
  return rs;
}

/**
 * 已經開局、設定不支援時仍要打完（中途離開會讓整桌卡住）：不認得的角色照名字當忠臣（正…）或爪牙（邪…）。
 * 角色數不對時退回標準 10 人設定。
 */
export function lobbyRolesLoose(gameRoles: readonly string[] | undefined, players: number): Role[] {
  const strict = lobbyRolesOf(gameRoles);
  if (strict && strict.length === players) return strict;
  if (gameRoles && gameRoles.length === players) return gameRoles.map((n) => roleOf(n) ?? (/邪|爪牙/.test(n) ? 'minion' : 'loyal'));
  return ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
}

/**
 * 機器人能不能打這個房間目前的設定（支援的角色、5–10 人、沒開王者之劍）；不行時給原因（log 用，不含暱稱）。
 * `players` 有給時，角色數要和人數一樣（每晚補位只打 10 人局）。
 */
export function unsupportedReason(s: Pick<Snap, 'game_roles' | 'enable_sword'>, players = 10): string | null {
  if (s.enable_sword) return '開了王者之劍';
  if (!s.game_roles || s.game_roles.length !== players) return `角色設定 ${s.game_roles?.length ?? 0} 人`;
  if (!lobbyRolesOf(s.game_roles)) return '有機器人不支援的角色';
  return null;
}

// ── 夜晚資訊（依阿瓦隆規則，讀自己畫面上看得到的身分）──────────────────────────────────────
export interface Knowledge {
  me: string; role: Role; team: 'good' | 'evil';
  knownEvils: string[]; knownWizards: string[] | undefined;
  /** 開局時自己畫面上看到的別人身分字串（只寫本機紀錄）。 */
  nightView: Record<string, string>;
  /** 看到的人數和規則對不上時的說明（null＝對得上）。 */
  mismatch: string | null;
}

/**
 * 開局時的夜晚資訊。練習台已經依規則只顯示自己該看到的人；這裡再依阿瓦隆規則決定每種角色怎麼用：
 *   - 梅林：看到的（紅方，莫德雷德除外）→ knownEvils
 *   - 派西維爾：看到的大拇指（梅林＋莫甘娜，分不出誰是誰）→ knownWizards，不算紅
 *   - 刺客／莫甘娜／莫德雷德／爪牙：看到的隊友（奧伯倫除外）→ knownEvils
 *   - 奧伯倫、忠臣：什麼都不知道
 * `lobbyRoles` 有給時，檢查看到的人數是否符合規則（不符合只記在 mismatch，仍以畫面為準）。
 */
export function readKnowledge(s: Snap, lobbyRoles?: readonly Role[] | null): Knowledge {
  const team: 'good' | 'evil' = s.myself.is_good ? 'good' : 'evil';
  // 不支援的角色（例：蘭斯洛特）：照陣營當忠臣／爪牙打，不用夜晚資訊（中途離開會讓整桌卡住，所以不丟錯）
  const known = roleOf(s.myself.role);
  const role: Role = known ?? (team === 'good' ? 'loyal' : 'minion');
  const me = sid(s.myself.set);
  const nightView: Record<string, string> = {};
  for (const u of s.users) {
    if (u.set !== s.myself.set && u.role && u.role !== 'unknown') nightView[sid(u.set)] = u.role;
  }
  const all = Object.keys(nightView).sort((a, b) => setOf(a) - setOf(b));
  // 只取夜晚資訊的標記：紅方是 'bad'（或紅方角色名），派西維爾的大拇指是 '梅莫'。中途重連時畫面上可能已有
  // 湖翻開的 'good'／'bad'，忠臣、奧伯倫不看任何標記；梅林、紅方不會把湖翻出的 'good' 當成紅。
  const isRedMark = (v: string): boolean => v === 'bad' || EVIL_ROLES.has(roleOf(v) as Role);
  const isThumb = (v: string): boolean => v === '梅莫' || v === '梅林' || v === '莫甘娜';
  const seen = role === 'percival' ? all.filter((id) => isThumb(nightView[id])) : all.filter((id) => isRedMark(nightView[id]));
  let knownEvils: string[] = [];
  let knownWizards: string[] | undefined;
  let expected: number | null = null;
  const count = (pred: (r: Role) => boolean): number => (lobbyRoles ? lobbyRoles.filter(pred).length : 0);
  if (!known) {
    expected = null;
  } else if (role === 'percival') {
    knownWizards = seen;
    expected = count((r) => r === 'merlin' || r === 'morgana');
  } else if (role === 'merlin') {
    knownEvils = seen;
    expected = count((r) => EVIL_ROLES.has(r) && r !== 'mordred');
  } else if (team === 'evil' && role !== 'oberon') {
    knownEvils = seen;
    expected = count((r) => EVIL_ROLES.has(r) && r !== 'oberon') - 1;
  } else {
    expected = 0;
  }
  const shown = !known ? 0 : role === 'percival' || role === 'merlin' || (team === 'evil' && role !== 'oberon') ? seen.length : 0;
  const mismatch = lobbyRoles && expected !== null && expected !== shown
    ? `看到 ${shown} 人，規則應為 ${expected} 人` : null;
  return { me, role, team, knownEvils, knownWizards, nightView, mismatch };
}

// ── 公開紀錄 ─────────────────────────────────────────────────────────────────────────
/**
 * 派票紀錄 → AI 的投票與任務紀錄。進行中的提議（目前隊長的、還沒有人投票的）不算。
 * 第 5 次提議是強制局：一律記成通過。
 */
export function historyFromRecord(rec: PlatformRecord, s: Snap): { votes: VoteRecord[]; quests: QuestRecord[] } {
  const votes: VoteRecord[] = [];
  const quests: QuestRecord[] = [];
  const crown = s.users.find((u) => u.crown)?.set;
  const ids = seatIds(s);
  for (let r = 1; r <= 5; r++) {
    const round = rec[`round_${r}`];
    if (!round || typeof round !== 'object') continue;
    const meetings = round.meetings ?? [];
    meetings.forEach((m, i) => {
      const last = i === meetings.length - 1;
      const current = r === s.missions.length + 1;
      const inProgress = last && current && (m.white_ball_set ?? []).length === 0 && m.captain_set === crown
        && s.status !== ENDED && i < 4;
      if (inProgress) return;
      const yes = new Set(m.white_ball_set ?? []);
      votes.push({
        round: r, attempt: i + 1, leader: sid(m.captain_set), team: (m.ticks_set ?? []).map(sid),
        approved: i === 4 || yes.size * 2 > ids.length,
        votes: Object.fromEntries(ids.map((id) => [id, i === 4 ? true : yes.has(setOf(id))])),
      });
    });
    const mh = round.mission_history;
    if (mh && s.missions.length >= r) {
      quests.push({
        round: r, team: (mh.member ?? []).map(sid), result: s.missions[r - 1] ? 'success' : 'fail',
        failCount: (mh.result ?? []).filter((x) => x === false).length,
      });
    }
  }
  return { votes, quests };
}

/** 湖是在第 2、3、4 個任務之後：第 i 次湖（0 起算）在第 i+2 局任務之後。 */
const lakeRound = (i: number): number => i + 2;

/**
 * 公開的湖紀錄：已宣告的照宣告；沒宣告、而且已經過了那一輪（下一個任務做完）的記成 'none'；
 * 還在等宣告的不放（和百科引擎 publicLakeHistory 一樣，不洩漏持湖者的中間狀態）。
 */
export function lakeHistoryFromSnap(s: Snap): LakePublicRecord[] {
  const out: LakePublicRecord[] = [];
  s.lake_result.forEach((l, i) => {
    if (l.to === null || l.to === undefined) return;
    const done = s.missions.length > lakeRound(i);
    if (l.result === null && !done) return;
    out.push({ round: lakeRound(i), holderId: sid(l.from), targetId: sid(l.to),
      declaredClaim: l.result === true ? 'good' : l.result === false ? 'evil' : 'none' });
  });
  return out;
}

/** 自己湖到的結果：被湖的人在自己的畫面上翻成 good／bad。 */
export function myLakeFromSnap(s: Snap, prev: readonly PrivateLakeResult[] = []): PrivateLakeResult[] {
  const out = [...prev];
  s.lake_result.forEach((l, i) => {
    if (l.from !== s.myself.set || l.to === null || l.to === undefined) return;
    const u = s.users.find((x) => x.set === l.to);
    const r = u?.role === 'good' ? 'good' : u?.role === 'bad' ? 'evil' : null;
    if (r && !out.some((m) => m.round === lakeRound(i))) out.push({ round: lakeRound(i), targetId: sid(l.to), result: r });
  });
  return out;
}

/** 可以湖的人：不是自己、也沒拿過湖的人。 */
export function validLakeTargets(s: Snap): string[] {
  const used = new Set(s.lake_result.map((l) => l.from));
  return seatIds(s).filter((id) => setOf(id) !== s.myself.set && !used.has(setOf(id)));
}

/** 刺殺階段紅方開牌：自己畫面上看得到的紅方角色（含自己）。 */
export function evilRolesAtAssassination(s: Snap, k: Pick<Knowledge, 'me' | 'role'>): Record<string, Role> {
  const out: Record<string, Role> = { [k.me]: k.role };
  for (const u of s.users) {
    if (u.set === s.myself.set) continue;
    const r = roleOf(u.role);
    if (r && EVIL_ROLES.has(r)) out[sid(u.set)] = r;
    else if (u.role === 'bad') out[sid(u.set)] = 'minion';
  }
  return out;
}

export function buildObservation(
  k: Knowledge, s: Snap, hist: { votes: VoteRecord[]; quests: QuestRecord[] }, myLake: PrivateLakeResult[],
  phase: PlayerObservation['gamePhase'], lobbyRoles: Role[], extra: Partial<PlayerObservation> = {},
): PlayerObservation {
  const round = Math.min(5, s.missions.length + 1);
  const failCount = hist.votes.filter((v) => v.round === round && !v.approved).length;
  const leader = s.users.find((u) => u.crown);
  return {
    myPlayerId: k.me, myRole: k.role, myTeam: k.team, playerCount: s.users.length, allPlayerIds: seatIds(s),
    knownEvils: k.knownEvils, knownWizards: k.knownWizards,
    currentRound: round, currentLeader: leader ? sid(leader.set) : k.me, failCount,
    questResults: hist.quests.map((q) => q.result), gamePhase: phase,
    voteHistory: hist.votes, questHistory: hist.quests,
    proposedTeam: s.users.filter((u) => u.tick).map((u) => sid(u.set)),
    lakeHistory: lakeHistoryFromSnap(s), myLakeResults: myLake,
    evilCount: lobbyRoles.filter((r) => EVIL_ROLES.has(r)).length, lobbyRoles,
    ...extra,
  };
}

// ── 現在輪到我做什麼 → 練習台的動作 ────────────────────────────────────────────────────────
export type Decision = 'team' | 'vote' | 'mission' | 'lakeTarget' | 'lakeDeclare' | 'assassinate' | 'verify';

/** 依 myself 的開關判斷現在要做的決定；沒有要做的事時 null。 */
export function pendingDecision(s: Snap): Decision | null {
  if (!s.gaming || s.status === ENDED) return null;
  // 湖的宣告不擋遊戲進行（練習台在下一輪派票、投票時也能按），內建機器人動作很快，所以排在前面先做
  for (const d of ['lakeTarget', 'assassinate', 'lakeDeclare', 'team', 'vote', 'mission', 'verify'] as const) {
    if (decisionOpen(s, d)) return d;
  }
  return null;
}

/** 這個決定現在還能做嗎（等 1–3 秒再按之前重新確認用）。 */
export function decisionOpen(s: Snap, d: Decision): boolean {
  const m = s.myself;
  if (!s.gaming || s.status === ENDED) return false;
  switch (d) {
    case 'team': return Boolean(m.can_dispatch_ticks || (m.can_start_vote && s.free_ticks === 0));
    case 'vote': return Boolean(m.can_vote && (m.vote_bag === null || m.vote_bag === undefined));
    case 'mission': return Boolean(m.can_to_mission);
    case 'lakeTarget': return Boolean(m.can_lake_to);
    case 'assassinate': return Boolean(m.can_assassin_to);
    case 'lakeDeclare': return Boolean(m.can_select_lake_result) && pendingLakeDeclaration(s) !== null;
    case 'verify': return Boolean(m.can_verify);
  }
  return false;
}

/** 自己湖完、還沒宣告的那一次湖（lake_result 的 index）；沒有時 null。 */
export function pendingLakeDeclaration(s: Snap): number | null {
  const i = s.lake_result.findIndex((l) => l.from === s.myself.set && l.to !== null && l.result === null);
  return i >= 0 ? i : null;
}

/** 練習台的動作：每一個都對應房間頁上的一個按鈕（app 的同名方法）。 */
export type SiteAction =
  | { kind: 'touch'; set: number }       // 點座位：派兵牌／收兵牌、湖、刺殺（app.Touch）
  | { kind: 'startVote' }                // 派完隊伍按「開始投票」（app.StartVote）
  | { kind: 'vote'; yes: boolean }       // 白球／黑球（app.Vote）
  | { kind: 'mission'; success: boolean }// 任務成功／失敗（app.ExcuteMission）
  | { kind: 'lakeResult'; good: boolean }// 湖的宣告：好／壞（app.LakeResult）
  | { kind: 'declineVerify' };           // 王者之劍「不驗」（app.SkipSwap）

/**
 * 派隊：先收掉不在隊伍裡的兵牌、再補上要的人，一次一個動作（每次呼叫依目前畫面給下一步）；
 * 隊伍剛好是想要的人而且兵牌用完時按開始投票。第 5 次強制局練習台不投票，開始投票後直接出任務。
 */
export function nextTeamAction(s: Snap, want: readonly number[]): SiteAction | null {
  const w = new Set(want);
  const extra = s.users.find((u) => u.tick && !w.has(u.set));
  if (extra) return { kind: 'touch', set: extra.set };
  const missing = s.users.find((u) => !u.tick && w.has(u.set));
  if (missing && s.free_ticks > 0) return { kind: 'touch', set: missing.set };
  if (!missing && s.myself.can_start_vote) return { kind: 'startVote' };
  return null;
}

/** 任務牌：藍方一律成功（規則不能出失敗）；紅方照 AI。 */
export function missionCard(team: 'good' | 'evil', agentVote: 'success' | 'fail' | undefined): boolean {
  return team === 'good' ? true : agentVote !== 'fail';
}

// ── 補位規則（signagePlayer 的 live 模式）──────────────────────────────────────────────────
/** 房間標題／描述寫了不要機器人時不加入。 */
export const NO_BOT_RE = /不要\s*機器人|禁止\s*機器人|拒絕\s*機器人|不要\s*bot|禁止\s*bot|no\s*-?\s*bots?\b|bots?\s*not\s*allowed/i;

export interface LobbyRoom { name: string; description_title?: string; is_publish_room?: boolean; length?: number; gaming?: boolean }

/** 大廳上看得到的條件：野團、等待中、9 人、標題沒說不要機器人。 */
export function lobbyCandidate(r: LobbyRoom): boolean {
  return Boolean(r.is_publish_room) && !r.gaming && r.length === 9 && !NO_BOT_RE.test(r.description_title ?? '');
}

/** 房裡已經有百科機器人（每間房最多 1 個：Edward 11/03「目前先限制B只能有一隻進入」）。 */
export function hasPediaBot(users: readonly Pick<SUser, 'name'>[]): boolean {
  return users.some((u) => isPediaBotName(String(u.name ?? '')));
}

/** 進觀眾席看到的座位：9 個真人（沒有練習台機器人、沒有百科機器人）、還沒開局。 */
export function seatsCandidate(users: readonly Pick<SUser, 'is_robot' | 'name'>[], gaming: boolean): boolean {
  return !gaming && users.length === 9 && users.every((u) => !u.is_robot) && !hasPediaBot(users);
}

/**
 * 「人不夠」的計時：每間房連續符合條件多久了。`seen` 會被更新（不符合的房間移除）。
 * 回傳已經連續符合 ≥ waitMs 的房間名。
 */
export function shortRooms(seen: Map<string, number>, candidates: readonly string[], now: number, waitMs: number): string[] {
  const set = new Set(candidates);
  for (const k of [...seen.keys()]) if (!set.has(k)) seen.delete(k);
  for (const c of candidates) if (!seen.has(c)) seen.set(c, now);
  return candidates.filter((c) => now - (seen.get(c) as number) >= waitMs);
}
