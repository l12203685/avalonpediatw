/**
 * 刺殺階段的紅方討論（站長 2026-11-25）：
 * 「百科AI在跟真人玩的時候 如果抽到紅方 請先把自己的推論 認為誰是梅林跟原因說出來 等紅方隊友討論 請他們共同確認要刺殺誰
 *   如果百科AI是抽到刺客 請隊友再用對話送出 /刺殺 {座位號碼} 決定」
 * 同日補充：「沒有紅方專用頻道 是刺殺階段的討論 所以直接在房間發言就好 / 另外不管是什麼紅方角色 都應該分享自己從場上紅方
 *   知道隊友角色與位置後的視角中 誰是梅林 / 隊友都是百科AI當然就沒問題 因為思考方式會一模一樣 … 但有真人當紅方隊友的時候
 *   百科AI就必須分享推論過程 只是當抽到刺客時 要交給真人決定刺誰（百科AI依然可以提供想法跟參考）」
 *
 * 這個檔是兩個平台共用的純函式（不碰 socket、不碰瀏覽器）：
 *   - 自己網站（`socket/GameServer.ts`）的機器人；
 *   - 練習台 signage-cloud 的補位機器人（`scripts/signagePlayer.ts`）。
 * 只有「紅方裡至少有一個真人」才用；紅方全是機器人（機器人桌、自我對弈、基準測試）完全不經過這裡。
 *
 * 內容：
 *   - `redAssassinView`／`redViewMessage`：紅方機器人（任何紅方角色）用刺殺階段紅方開牌後的完整紅方資訊，
 *     照刺客實際的算法（`HeuristicAgent.assassinationReadout`：分層＋刺殺分數，世界線開的話也含在內）說出梅林人選、
 *     第二人選和 1–3 個白話理由。
 *   - `parseAssassinCommand`：隊友在聊天打的「/刺殺 N」。
 *   - `AssassinCommandWait`：機器人是刺客時，等紅方隊友的指令（最新一則有效的算數；收到後等幾秒才刺，讓人還能改；
 *     時間快到還沒收到就刺自己的第一人選），不讓遊戲卡住。
 */
import { HeuristicAgent } from './HeuristicAgent';
import type { AvalonAgent, PlayerObservation } from './types';
import { merlinSightFromAssassin } from './assassin/VisibleRedProposals';

// ── 時間（毫秒）─────────────────────────────────────────────────────────────────────
/** 收到有效的「/刺殺 N」之後等這麼久才真的刺：這段時間內有人改口（再打一次 /刺殺），以最新的為準。 */
export const RED_TALK_SUBMIT_DELAY_MS = 5_000;
/** 平台有刺殺倒數時，剩這麼多時間還沒收到指令就自己刺（留安全時間給網路延遲）。 */
export const RED_TALK_SAFETY_MARGIN_MS = 20_000;
/** 平台沒有刺殺倒數（或不知道有沒有）時，最多等這麼久（約 3 分鐘）就自己刺。 */
export const RED_TALK_NO_TIMER_WAIT_MS = 180_000;

/** 環境變數 `RED_ASSASSIN_TALK=off`（或 false／0／no）關掉這個功能；預設開（真人桌才會用到）。 */
export function redTalkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.RED_ASSASSIN_TALK ?? '').trim().toLowerCase();
  return !['off', 'false', '0', 'no'].includes(v);
}

/** 座位寫法：N家，第 10 位寫 0家。 */
export function seatLabel(seat: number): string {
  return `${seat === 10 ? 0 : seat}家`;
}

/** 刺客機器人請隊友下指令的那一句。 */
export const ASSASSIN_ASK_TEXT = '我是刺客，請紅方討論後在聊天輸入 /刺殺 座位號碼（例如 /刺殺 3），我照你們決定的刺。';

// ── 「/刺殺 N」────────────────────────────────────────────────────────────────────────
/**
 * 解析聊天的「/刺殺 N」：N 是 1–9，0 或 10 都是 0家（第 10 位）；接受全形數字、全形斜線「／」、可有可無的空白和「家」。
 * 回傳座位 1–10；不是這個格式就回 null。
 */
export function parseAssassinCommand(text: string): number | null {
  const t = String(text ?? '')
    .replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 48))
    .replace(/\uff0f/g, '/')
    .replace(/\u3000/g, ' ')
    .trim();
  const m = /^\/\s*刺[殺杀]\s*(10|[0-9])\s*家?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 0 ? 10 : n;
}

// ── 紅方的梅林看法 ─────────────────────────────────────────────────────────────────────
export interface RedTalkView {
  /** 梅林人選（玩家 id）。 */
  pick: string;
  /** 第二人選；沒有可比的分數時 null。 */
  second: string | null;
  /** 1–3 個白話理由（座位已寫成 N家）。 */
  reasons: string[];
}

const NUM = ['零', '一', '兩', '三', '四', '五'];

/**
 * 紅方機器人的梅林看法。`obs` 要是刺殺階段的觀察，而且帶完整紅方（`allEvilIds`、`allEvilRoles`：刺殺階段紅方開牌相認，
 * 每個紅方都知道隊友的角色和位置）。第一人選照 `agent.act`（刺客真的會刺的人），第二人選與理由照刺客的分數與分層。
 * `seatOf(id)`：玩家 id → 座位 1–10。
 */
export function redAssassinView(agent: AvalonAgent | undefined, obs: PlayerObservation, seatOf: (id: string) => number): RedTalkView | null {
  const evil = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, obs.myPlayerId]);
  const candidates = obs.allPlayerIds.filter((id) => !evil.has(id));
  if (candidates.length === 0) return null;
  const heuristic = agent instanceof HeuristicAgent ? agent : null;
  let readout: ReturnType<HeuristicAgent['assassinationReadout']> = null;
  try { readout = heuristic ? heuristic.assassinationReadout(obs) : null; } catch { readout = null; }
  const score = (id: string): number => readout?.scores.get(id) ?? Number.NEGATIVE_INFINITY;
  const bySeat = (a: string, b: string): number => seatOf(a) - seatOf(b);
  // 刺客的排序：分層前面的人優先，同層照分數高到低
  const front = new Set(readout?.front ?? candidates);
  const order = [...candidates].sort((a, b) => Number(front.has(b)) - Number(front.has(a)) || score(b) - score(a) || bySeat(a, b));
  let pick = order[0];
  try {
    const a = agent?.act({ ...obs, gamePhase: 'assassination' });
    if (a && a.type === 'assassinate' && candidates.includes(a.targetId)) pick = a.targetId;
  } catch { /* 算不出來就用分數第一 */ }
  const second = readout ? order.find((id) => id !== pick) ?? null : null;
  return { pick, second, reasons: redTalkReasons(obs, pick, candidates, readout, heuristic?.tuning.assassinWorldLine75 ?? 0, seatOf) };
}

function seatsText(ids: readonly string[], seatOf: (id: string) => number): string {
  const seats = ids.map(seatOf).filter((s) => s > 0).sort((a, b) => (a === 10 ? 11 : a) - (b === 10 ? 11 : b));
  return `${seats.map((s) => (s === 10 ? '0' : String(s))).join('、')}家`;
}

/** 理由：照刺客實際用到的幾項（分層、投票、隊長、湖、世界線），各自翻成看得到的事實，取份量最重的最多 3 個。 */
function redTalkReasons(
  obs: PlayerObservation,
  pick: string,
  candidates: readonly string[],
  readout: ReturnType<HeuristicAgent['assassinationReadout']>,
  worldLine: number,
  seatOf: (id: string) => number,
): string[] {
  const sight = merlinSightFromAssassin(obs);
  const seen = (team: readonly string[]): number => team.filter((id) => sight.certain.has(id) || sight.ambiguous.includes(id)).length;
  const P = seatLabel(seatOf(pick));
  const terms = readout?.terms.get(pick);
  const out: { w: number; text: string }[] = [];
  // 分層：當隊長時派過梅林看得到的紅的人排在後面
  if (readout && readout.front.includes(pick) && readout.front.length < candidates.length) {
    const dropped = candidates.filter((id) => !readout.front.includes(id));
    out.push({ w: 100, text: `${seatsText(dropped, seatOf)} 當隊長時派過梅林看得到的紅，排在後面` });
  }
  // 隊長：自己派的隊都沒有梅林看得到的紅
  const leads = obs.voteHistory.filter((v) => v.leader === pick);
  if (leads.length > 0 && leads.every((v) => seen(v.team) === 0)) {
    out.push({ w: 50 + (terms ? terms.lead : 1), text: `${P} 當隊長派的 ${leads.length} 隊都沒有梅林看得到的紅` });
  }
  // 投票：第 3 局起在隊外反對有梅林看得到的紅的隊
  const rejects = obs.voteHistory
    .filter((v) => v.round >= 3 && !v.team.includes(pick) && v.votes[pick] === false && seen(v.team) > 0)
    .sort((a, b) => seen(b.team) - seen(a.team) || b.round - a.round);
  if (rejects.length > 0 && (!terms || terms.vote > 0)) {
    const v = rejects[0];
    const n = seen(v.team);
    out.push({ w: 40 + (terms ? terms.vote : 1), text: `第 ${v.round} 局 ${P} 在隊外反對了有${NUM[n] ?? n}個紅的隊` });
  }
  // 湖：梅林不會湖自己看得到的紅
  if (terms && terms.lake > 0) {
    const lakes = (obs.lakeHistory ?? []).filter((l) => l.holderId === pick);
    if (lakes.length > 0 && lakes.every((l) => seen([l.targetId]) === 0)) out.push({ w: 30 + terms.lake, text: `${P} 拿湖時沒有湖梅林看得到的紅` });
  }
  if (worldLine > 0) out.push({ w: 20, text: `照誰像派西維爾、誰像梅林一起推，${P} 最可能是梅林` });
  out.sort((a, b) => b.w - a.w);
  const reasons = out.slice(0, 3).map((r) => r.text);
  if (reasons.length === 0) reasons.push(`看派隊和投票的整體紀錄，${P} 最像梅林`);
  return reasons;
}

/** 紅方機器人在聊天說的那一句：「我覺得梅林是 3家（第二人選 7家）：理由；理由。」 */
export function redViewMessage(view: RedTalkView, seatOf: (id: string) => number): string {
  const second = view.second ? `（第二人選 ${seatLabel(seatOf(view.second))}）` : '';
  return `我覺得梅林是 ${seatLabel(seatOf(view.pick))}${second}：${view.reasons.join('；')}。`;
}

// ── 刺客機器人等隊友的指令 ───────────────────────────────────────────────────────────────
/** 等到什麼時候：平台有倒數就在倒數結束前留 `RED_TALK_SAFETY_MARGIN_MS`；沒有倒數就 `RED_TALK_NO_TIMER_WAIT_MS`。 */
export function assassinWaitDeadline(startedAt: number, timerMs: number | null): number {
  if (timerMs === null || !Number.isFinite(timerMs) || timerMs <= 0) return startedAt + RED_TALK_NO_TIMER_WAIT_MS;
  const wait = Math.max(timerMs / 2, timerMs - RED_TALK_SAFETY_MARGIN_MS);
  return startedAt + Math.min(wait, RED_TALK_NO_TIMER_WAIT_MS);
}

export interface AssassinWaitOptions {
  /** 刺客機器人自己的座位（自己的訊息不算）。 */
  mySeat: number;
  /** 紅方座位（含自己）：只有紅方隊友的指令算數，也不能刺紅方。 */
  redSeats: ReadonlySet<number>;
  /** 桌上所有座位。 */
  tableSeats: ReadonlySet<number>;
  /** 到時間沒收到指令時刺的座位（機器人自己的第一人選）。 */
  fallbackSeat: number;
  /** 最晚什麼時候刺（`assassinWaitDeadline`）。 */
  deadlineAt: number;
  /** 收到指令後等多久才刺（預設 `RED_TALK_SUBMIT_DELAY_MS`）。 */
  submitDelayMs?: number;
}

export interface AssassinWaitStep {
  /** 要刺的座位。 */
  seat: number;
  /** command = 隊友的指令；timeout = 時間快到，刺自己的第一人選。 */
  source: 'command' | 'timeout';
  /** 刺之前在聊天說的那一句。 */
  reply: string;
}

/**
 * 刺客機器人等紅方隊友的「/刺殺 N」。`onChat` 收聊天（發話人的座位、內容、時間），回傳要回覆的一句（不能刺的對象）或 null；
 * `poll` 每隔一下呼叫，該刺的時候回傳一次 `AssassinWaitStep`，之後都回 null。
 */
export class AssassinCommandWait {
  private command: { seat: number; at: number } | null = null;
  private finished = false;
  private readonly delay: number;

  constructor(private readonly o: AssassinWaitOptions) {
    this.delay = o.submitDelayMs ?? RED_TALK_SUBMIT_DELAY_MS;
  }

  get done(): boolean { return this.finished; }
  /** 目前算數的指令座位（還沒有就 null）。 */
  get pendingSeat(): number | null { return this.command?.seat ?? null; }

  onChat(senderSeat: number, text: string, now: number): string | null {
    if (this.finished) return null;
    const seat = parseAssassinCommand(text);
    if (seat === null) return null;
    // 只聽紅方隊友：藍方、自己、看不出座位的訊息都不理
    if (senderSeat === this.o.mySeat || !this.o.redSeats.has(senderSeat)) return null;
    if (!this.o.tableSeats.has(seat)) return `桌上沒有 ${seatLabel(seat)}，請重新輸入 /刺殺 座位號碼。`;
    if (this.o.redSeats.has(seat)) return `${seatLabel(seat)} 是紅方，不能刺，請改選別人（/刺殺 座位號碼）。`;
    this.command = { seat, at: now };
    return null;
  }

  poll(now: number): AssassinWaitStep | null {
    if (this.finished) return null;
    const c = this.command;
    if (c && (now - c.at >= this.delay || now >= this.o.deadlineAt)) {
      this.finished = true;
      return { seat: c.seat, source: 'command', reply: `收到，刺殺 ${seatLabel(c.seat)}` };
    }
    if (now >= this.o.deadlineAt) {
      this.finished = true;
      return {
        seat: this.o.fallbackSeat, source: 'timeout',
        reply: `沒有收到紅方隊友的 /刺殺 指令，時間快到了，我照自己的判斷刺 ${seatLabel(this.o.fallbackSeat)}`,
      };
    }
    return null;
  }
}
