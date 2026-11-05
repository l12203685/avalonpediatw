/**
 * 百科AI 在遊玩頁（avalon.signage-cloud.org）打的每一局 → 對局紀錄（trace）——Edward 2026-11-05：
 *「剛剛玩的那場模擬局有紀錄嗎? 我想對百科AI的一些行動跟投票作回饋……只要有百科AI參與的牌局就自動記錄在網站&DC上」。
 *
 * scripts/signagePlayer.ts 用：
 *   - draftDecision：百科AI 做完一個決定（按鈕送出之後）就組一筆紀錄，理由用網站「與機器人練習」賽後回顧的同一套說明
 *     （src/ai/explain.ts，只讀；用決定當下的觀察重算，不碰正在打的 AI 的記憶）。
 *   - captureToGame（buildAiGameTrace）：局結束、角色公開之後，把局末畫面＋派票紀錄（RecvGameStatistics）＋系統訊息轉成
 *     那一局的公開紀錄（座位角色、提議與投票、任務、湖、刺殺、勝負）。
 *   - AiTraceHub：同一間房同一局的多個百科AI（--bots N）合成一份 trace；每個座位都打完（或第一個打完後 90 秒）才送出一次。
 *
 * 純資料轉換（不碰瀏覽器、不連網路）；貼 DC 在 src/services/aiGameForum.ts。單元測試：src/__tests__/AiGameTrace.test.ts。
 * trace 含真人暱稱，只貼 DC；不要印到 stdout（公開的 GitHub Actions log 只能有時間、房號、狀態與數量）。
 */
import type { Role } from '@avalon/shared';
import {
  explainAssassination, explainLakeClaim, explainLakeTarget, explainQuestCard, explainTeamProposal, explainTeamVote,
  type DecisionExplanation,
} from '../src/ai/explain';
import type { HeuristicAgent } from '../src/ai/HeuristicAgent';
import type { PlayerObservation } from '../src/ai/types';
import {
  AI_GAME_FORMAT, AI_GAME_VERSION, seatZh, seatsZh,
  type AiDecision, type AiDecisionKind, type AiGameLake, type AiGameMission, type AiGameProposal, type AiGameSeat, type AiGameTrace, type Camp,
} from '../src/services/aiGameTrace';
import { roleOf, setOf, type PlatformRecord, type SLake } from './signageAdapter';

// ── 一個決定 ──────────────────────────────────────────────────────────────────────────

export type DecisionInput =
  | { kind: 'team'; teamIds: string[] }
  | { kind: 'vote'; vote: boolean; team: string[] }
  | { kind: 'mission'; card: 'success' | 'fail' }
  | { kind: 'lake'; targetId: string; eligible: string[] }
  | { kind: 'declare'; targetId: string; claim: Camp | null; actual?: Camp }
  | { kind: 'assassinate'; targetId: string };

export type DraftDecision = Omit<AiDecision, 'id'>;

export interface DraftContext {
  /** 決定當下 AI 看的觀察（已複製一份）；AI 出錯、連觀察都組不出來時 null。 */
  obs: PlayerObservation | null;
  seat: number;
  nick: string;
  role: Role;
  team: Camp;
  round: number;
  attempt: number;
  source: 'agent' | 'fallback';
  agent?: HeuristicAgent;
  at?: number;
}

const ids2seats = (ids: readonly string[]): number[] => ids.map(setOf).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);

/** 動作的中文與細節（同網站練習模式 preparePracticeTrace 的寫法）。 */
export function actionOf(input: DecisionInput): { action: string; detail: AiDecision['detail'] } {
  switch (input.kind) {
    case 'team': return { action: `派隊 ${seatsZh(ids2seats(input.teamIds))}`, detail: { team: ids2seats(input.teamIds) } };
    case 'vote': return { action: input.vote ? '贊成' : '反對', detail: { vote: input.vote, team: ids2seats(input.team) } };
    case 'mission': return { action: input.card === 'fail' ? '出失敗' : '出成功', detail: { card: input.card } };
    case 'lake': return { action: `湖 ${seatZh(setOf(input.targetId))}`, detail: { target: setOf(input.targetId) } };
    case 'declare': return {
      action: input.claim === null
        ? `不公開 ${seatZh(setOf(input.targetId))} 的湖中結果`
        : `宣告 ${seatZh(setOf(input.targetId))} 是${input.claim === 'good' ? '好人' : '壞人'}`,
      detail: { target: setOf(input.targetId), claim: input.claim, ...(input.actual ? { actual: input.actual } : {}) },
    };
    case 'assassinate': return { action: `刺殺 ${seatZh(setOf(input.targetId))}`, detail: { target: setOf(input.targetId) } };
  }
}

/** 理由：src/ai/explain.ts 的同一套說明（不改任何決定）。 */
export function explainDecision(obs: PlayerObservation, input: DecisionInput, agent?: HeuristicAgent): DecisionExplanation {
  switch (input.kind) {
    case 'team': return explainTeamProposal(obs, input.teamIds, agent);
    case 'vote': return explainTeamVote(obs, input.vote, agent);
    case 'mission': return explainQuestCard(obs, input.card, agent);
    case 'lake': return agent ? explainLakeTarget(obs, input.targetId, input.eligible, agent.tuning) : explainLakeTarget(obs, input.targetId, input.eligible);
    case 'declare': return agent
      ? explainLakeClaim(obs, input.targetId, input.actual, input.claim, agent.tuning)
      : explainLakeClaim(obs, input.targetId, input.actual, input.claim);
    case 'assassinate': return explainAssassination(obs, input.targetId, agent);
  }
}

/** 一筆決定紀錄。不丟錯：說明失敗時理由寫「（理由產生失敗）」。 */
export function draftDecision(input: DecisionInput, ctx: DraftContext): DraftDecision {
  const { action, detail } = actionOf(input);
  // 沒有觀察（卡太久直接用預設動作、或連觀察都組不出來）時沒有理由可寫
  let ex: DecisionExplanation = { reason: '', suspects: [] };
  if (ctx.obs) {
    try { ex = explainDecision(ctx.obs, input, ctx.agent); } catch { ex = { reason: '（理由產生失敗）', suspects: [] }; }
  }
  const fallbackNote = ctx.source === 'fallback' ? '（AI 沒有給出可用的決定或輪到它太久，用保守的預設動作）' : '';
  const out: DraftDecision = {
    at: ctx.at ?? Date.now(), round: ctx.round, attempt: ctx.attempt, kind: input.kind as AiDecisionKind,
    seat: ctx.seat, nick: ctx.nick, role: ctx.role, team: ctx.team, action, detail,
    reason: `${fallbackNote}${ex.reason}` || '（沒有 AI 的觀察，無法說明理由）', source: ctx.source,
  };
  if (ex.rule) out.rule = ex.rule;
  if (ex.suspectsLabel) out.suspectsLabel = ex.suspectsLabel;
  if (ex.suspects?.length) out.suspects = ex.suspects.map((s) => ({ seat: s.seat, score: Math.round(s.score * 1000) / 1000 }));
  if (ex.suspectsNote) out.suspectsNote = ex.suspectsNote;
  if (ex.knowledge) out.knowledge = ex.knowledge;
  return out;
}

// ── 那一局的公開紀錄 ────────────────────────────────────────────────────────────────────

/** 局末畫面上的一個座位（練習台 users[]：開牌後 role 是角色名）。 */
export interface EndUser { set: number; name: string; role: string; dead?: boolean }
export interface FlatMeeting { ticks_set?: number[]; white_ball_set?: number[]; captain_set?: number }
export interface FlatMission { member?: number[]; result?: boolean[]; crown_set?: number }

/** 局結束時在百科AI 自己的分頁抓到的資料（scripts/signagePlayer.ts captureEnd）。 */
export interface EndCapture {
  users: EndUser[];
  missions: boolean[];
  lake: SLake[];
  /** 派票紀錄（SyncGameStatistics → RecvGameStatistics）；抓不到時 null。 */
  record: PlatformRecord | null;
  /** 房間頁的 app.meetings／app.mission_historys（派票紀錄抓不到時用）。 */
  meetings?: FlatMeeting[];
  missionHistorys?: FlatMission[];
  /** 系統訊息（刺殺、勝負）。 */
  logs: string[];
  endedAt: string;
}

/** 一個百科AI 座位（自己知道自己的角色，不靠開牌畫面）。 */
export interface AiSeatInfo { seat: number; nick: string; roleName: string; role: Role; team: Camp }

const EVIL: ReadonlySet<Role> = new Set<Role>(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);
/** 開牌後的角色名 → 陣營；不是角色名（unknown、good、bad、梅莫）時 null。 */
export function campOfRoleName(name: string): Camp | null {
  const r = roleOf(name);
  if (r) return EVIL.has(r) ? 'evil' : 'good';
  if (/^(unknown|good|bad|梅莫)$/i.test(name) || !name) return null;
  if (/邪|爪牙|莫|刺/.test(name)) return 'evil';
  if (/正|雜魚|忠/.test(name)) return 'good';
  return null;
}

const sortNums = (xs: readonly number[] | undefined): number[] => [...(xs ?? [])].filter((x) => typeof x === 'number').sort((a, b) => a - b);

/** 依任務人數與規則判斷失敗：第 4 局（7 人以上）要 2 張失敗。 */
const missionFailed = (round: number, fails: number, players: number): boolean => fails >= (round === 4 && players >= 7 ? 2 : 1);

/** 派票紀錄（每一局分開）→ 提議與任務。 */
function fromRecord(rec: PlatformRecord, seats: number[], missions: boolean[]): { proposals: AiGameProposal[]; quests: AiGameMission[] } {
  const proposals: AiGameProposal[] = [];
  const quests: AiGameMission[] = [];
  for (let r = 1; r <= 5; r++) {
    const round = rec[`round_${r}`];
    if (!round || typeof round !== 'object') continue;
    (round.meetings ?? []).forEach((m, i) => {
      const forced = i === 4;
      const approve = forced ? [] : sortNums(m.white_ball_set);
      const team = sortNums(m.ticks_set);
      if (!team.length) return;
      proposals.push({
        round: r, attempt: i + 1, leader: m.captain_set, team, approve,
        reject: forced ? [] : seats.filter((s) => !approve.includes(s)),
        approved: forced || approve.length * 2 > seats.length, forced,
      });
    });
    const mh = round.mission_history;
    if (mh && (mh.result ?? []).length) {
      const fails = (mh.result ?? []).filter((x) => x === false).length;
      const failed = missions.length >= r ? !missions[r - 1] : missionFailed(r, fails, seats.length);
      quests.push({ round: r, team: sortNums(mh.member), fails, result: failed ? 'fail' : 'success' });
    }
  }
  return { proposals, quests };
}

/** 房間頁的平面紀錄（所有提議接在一起）→ 提議與任務：提議和任務的隊伍、隊長相同時那一局結束（同 signagePaipu）。 */
function fromFlat(meetings: FlatMeeting[], missionsH: FlatMission[], seats: number[], missions: boolean[]): { proposals: AiGameProposal[]; quests: AiGameMission[] } {
  const proposals: AiGameProposal[] = [];
  const quests: AiGameMission[] = [];
  let round = 1;
  let attempt = 0;
  for (const m of meetings.filter(Boolean)) {
    attempt += 1;
    const team = sortNums(m.ticks_set);
    const forced = attempt === 5;
    const approve = forced ? [] : sortNums(m.white_ball_set);
    proposals.push({
      round, attempt, leader: m.captain_set ?? 0, team, approve, reject: forced ? [] : seats.filter((s) => !approve.includes(s)),
      approved: forced || approve.length * 2 > seats.length, forced,
    });
    const ms = missionsH[round - 1];
    if (ms && sortNums(ms.member).join(',') === team.join(',') && ms.crown_set === m.captain_set) {
      const fails = (ms.result ?? []).filter((x) => x === false).length;
      const failed = missions.length >= round ? !missions[round - 1] : missionFailed(round, fails, seats.length);
      quests.push({ round, team, fails, result: failed ? 'fail' : 'success' });
      round += 1;
      attempt = 0;
    }
  }
  return { proposals, quests };
}

const STAB_RE = /背刺\s*(\d+)\s*家|(\d+)\s*家擋刀/;

export interface BuildArgs {
  room: string;
  title: string;
  startedAt: string;
  end: EndCapture;
  ai: AiSeatInfo[];
  decisions: DraftDecision[];
  notes?: string[];
}

/** 一局的 trace（見 src/services/aiGameTrace.ts）。資料缺東缺西也不丟錯，照有的轉。 */
export function buildAiGameTrace(a: BuildArgs): AiGameTrace {
  const e = a.end;
  const users = (e.users ?? []).filter((u) => u && typeof u.set === 'number').sort((x, y) => x.set - y.set);
  const seatNums = users.map((u) => u.set);
  const aiBySeat = new Map(a.ai.map((s) => [s.seat, s]));
  const seats: AiGameSeat[] = users.map((u) => {
    const bot = aiBySeat.get(u.set);
    const shown = campOfRoleName(String(u.role ?? '')) ? String(u.role) : '';
    const role = shown || bot?.roleName || '';
    return { seat: u.set, name: String(u.name ?? ''), role, team: bot?.team ?? campOfRoleName(role), ai: Boolean(bot) };
  });
  for (const bot of a.ai) {
    if (!seats.some((s) => s.seat === bot.seat)) seats.push({ seat: bot.seat, name: bot.nick, role: bot.roleName, team: bot.team, ai: true });
  }
  seats.sort((x, y) => x.seat - y.seat);
  const missions = Array.isArray(e.missions) ? e.missions : [];
  const { proposals, quests } = e.record && Object.keys(e.record).some((k) => /^round_\d$/.test(k))
    ? fromRecord(e.record, seatNums, missions)
    : fromFlat(e.meetings ?? [], e.missionHistorys ?? [], seatNums, missions);
  const lakes: AiGameLake[] = [];
  (e.lake ?? []).forEach((l, i) => {
    if (!l || l.to === null || l.to === undefined) return;
    lakes.push({ round: i + 2, holder: l.from, target: l.to, claim: l.result === true ? 'good' : l.result === false ? 'evil' : null });
  });
  const logs = (e.logs ?? []).map(String);
  const stabLog = logs.map((x) => STAB_RE.exec(x)).find(Boolean);
  const target = users.find((u) => u.dead)?.set ?? (stabLog ? Number(stabLog[1] ?? stabLog[2]) : NaN);
  let assassination: AiGameTrace['assassination'] = null;
  if (Number.isFinite(target) && target > 0) {
    const hit = logs.some((x) => /背刺/.test(x) && /梅林/.test(x)) ? true : logs.some((x) => /擋刀/.test(x)) ? false
      : seats.find((s) => s.seat === target)?.role === '梅林' ? true : seats.find((s) => s.seat === target)?.role ? false : null;
    assassination = { target, hit };
  }
  const reds = quests.filter((q) => q.result === 'fail').length;
  const winner: Camp | null = logs.some((x) => /壞人獲勝/.test(x)) ? 'evil' : logs.some((x) => /好人獲勝/.test(x)) ? 'good'
    : reds >= 3 ? 'evil' : assassination?.hit === true ? 'evil' : assassination?.hit === false ? 'good' : null;
  const decisions: AiDecision[] = [...a.decisions].sort((x, y) => x.at - y.at || x.seat - y.seat).map((d, i) => ({ ...d, id: i + 1 }));
  return {
    format: AI_GAME_FORMAT, version: AI_GAME_VERSION, source: 'signage-cloud',
    room: a.room, title: a.title, startedAt: a.startedAt, endedAt: e.endedAt, winner,
    seats, proposals, missions: quests, lakes, assassination, decisions, notes: a.notes ?? [],
  };
}

// ── 多個百科AI 合成一份 ──────────────────────────────────────────────────────────────────

export type SeatStatus = 'ended' | 'stalled' | 'error' | 'left';

interface Member { done: boolean; status?: SeatStatus; end?: EndCapture | null; info?: AiSeatInfo }

/** 同一間房、同一局：所有百科AI 座位的決定與局末資料。 */
export class AiGameCollector {
  readonly decisions: DraftDecision[] = [];
  readonly notes = new Set<string>();
  private readonly members = new Map<string, Member>();
  private flushed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  startedAt: string;

  constructor(readonly room: string, private readonly onFlush: (c: AiGameCollector) => void, private readonly graceMs: number, now = Date.now()) {
    this.startedAt = new Date(now).toISOString();
  }

  get closed(): boolean { return this.flushed; }
  has(label: string): boolean { return this.members.has(label); }
  isDone(label: string): boolean { return Boolean(this.members.get(label)?.done); }
  join(label: string): void { if (!this.members.has(label)) this.members.set(label, { done: false }); }
  setSeat(label: string, info: AiSeatInfo): void { const m = this.members.get(label); if (m) m.info = info; }
  add(d: DraftDecision): void { if (!this.flushed) this.decisions.push(d); }

  /** 一個座位這局打完了（任何狀態都要報）；全部報完（或第一個報完 graceMs 後）送出一次。 */
  finish(label: string, status: SeatStatus, end: EndCapture | null): void {
    const m = this.members.get(label);
    if (!m || m.done || this.flushed) return;
    m.done = true; m.status = status; m.end = end;
    if ([...this.members.values()].every((x) => x.done)) { this.flush(); return; }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.graceMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.flushed) return;
    this.flushed = true;
    if (this.timer) clearTimeout(this.timer);
    this.onFlush(this);
  }

  /** 組 trace：至少一個座位打到遊戲結束（角色公開）而且有局末資料才組，否則 null。 */
  build(title: string): AiGameTrace | null {
    const ended = [...this.members.values()].filter((m) => m.status === 'ended' && m.end);
    if (!ended.length) return null;
    // 局末資料取最完整的一份（派票紀錄有抓到、座位最多）
    const end = ended.map((m) => m.end as EndCapture)
      .sort((x, y) => Number(Boolean(y.record)) - Number(Boolean(x.record)) || y.users.length - x.users.length)[0];
    const ai = [...this.members.values()].map((m) => m.info).filter((x): x is AiSeatInfo => Boolean(x));
    const notes = [...this.notes];
    if ([...this.members.values()].some((m) => m.status && m.status !== 'ended')) notes.push('有百科AI 座位沒有正常打完這局，它的決定可能不完整');
    return buildAiGameTrace({ room: this.room, title, startedAt: this.startedAt, end, ai, decisions: this.decisions, notes });
  }
}

/**
 * 每間房目前這一局的收集器。第一個開局的百科AI 開新的；同房其他百科AI 加入同一個；自己已經在（上一局）裡報完的再開局 → 開新的。
 * 送出（sink）是非同步的，drain() 等全部送完（程式結束前呼叫）。
 */
export class AiTraceHub {
  private readonly open = new Map<string, AiGameCollector>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly sink: (c: AiGameCollector) => Promise<void>,
    private readonly graceMs = 90_000,
  ) {}

  join(room: string, label: string, now = Date.now()): AiGameCollector {
    let c = this.open.get(room);
    if (!c || c.closed || c.has(label)) {
      c = new AiGameCollector(room, (done) => this.flushed(done), this.graceMs, now);
      this.open.set(room, c);
    }
    c.join(label);
    return c;
  }

  private flushed(c: AiGameCollector): void {
    if (this.open.get(c.room) === c) this.open.delete(c.room);
    const p = this.sink(c).catch(() => undefined).finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  /** 等送出中的都送完（最多 timeoutMs）；還沒送出的收集器（有座位沒報完）立刻送出。 */
  async drain(timeoutMs = 120_000): Promise<void> {
    for (const c of [...this.open.values()]) c.flush();
    if (!this.pending.size) return;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); })]);
  }
}
