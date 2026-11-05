/**
 * 百科AI 對局紀錄（trace）的格式與文字 —— Edward 2026-11-05：「剛剛玩的那場模擬局有紀錄嗎? 我想對百科AI的一些行動跟投票作回饋
 * 像這樣回饋的功能可不可以寫在網站上 或是只要有百科AI參與的牌局就自動記錄在網站&DC上 我們可以直接針對AI的動作作反饋?」
 *
 * 一局一份 trace：遊玩頁（avalon.signage-cloud.org）的那一局（房間、時間、開牌後每一家的角色、每次提議與投票、任務、湖、刺殺），
 * 加上每一個百科AI 座位的每一個決定（第幾局、第幾次、派隊／投票／任務／湖／宣告／刺殺、做了什麼、理由）。理由跟網站「與機器人練習」
 * 的賽後回顧是同一套（src/ai/explain.ts）。
 *
 * 誰用：
 *   - scripts/signagePlayer.ts（GitHub Actions）在局結束、角色公開之後組 trace，scripts/signageAiTrace.ts 組資料，
 *     services/aiGameForum.ts 貼到 DC 論壇 #百科問題回報（標籤「百科AI對局」）：起始訊息＝摘要＋回饋方式，附 trace.json／trace.txt，
 *     後面幾則＝依局分組的決定（每則 2000 字以內）。
 *   - 伺服器 GET /api/ai-games…（routes/aiGames.ts）從 DC 讀 trace.json 給網站「百科AI 對局」頁。
 *
 * 這個檔只有純函式（不連網路、不 import src/ai），伺服器與腳本共用；網站另有結構相同的型別（packages/web/src/utils/aiGames.ts）。
 * 內容含真人暱稱（房間裡本來就看得到），只貼在 DC；公開的 GitHub Actions log 不能出現任何一局的內容。
 */

export const AI_GAME_FORMAT = 'avalon-ai-game';
export const AI_GAME_VERSION = 1;
/** 論壇標籤與討論串標題開頭。 */
export const AI_GAME_TAG_NAME = '百科AI對局';
/** Discord 一則訊息的上限是 2000 字；留一點餘裕。 */
export const DISCORD_MESSAGE_MAX = 1900;
/** 後續訊息最多幾則（9 個百科AI 一桌時決定很多，其餘看附檔／網站）。 */
export const AI_GAME_MAX_FOLLOWUPS = 20;
/** 網站「百科AI 對局」頁。 */
export const AI_GAMES_SITE_URL = 'https://avalonpediatw.com/#ai-games';

export type AiDecisionKind = 'team' | 'vote' | 'mission' | 'lake' | 'declare' | 'assassinate';
export const AI_DECISION_KINDS: readonly AiDecisionKind[] = ['team', 'vote', 'mission', 'lake', 'declare', 'assassinate'];
export const AI_DECISION_KIND_LABEL: Readonly<Record<AiDecisionKind, string>> = {
  team: '派隊', vote: '投票', mission: '任務', lake: '湖', declare: '湖的宣告', assassinate: '刺殺',
};

export type Camp = 'good' | 'evil';

export interface AiGameSeat {
  seat: number;
  /** 練習台暱稱（真人也照房間裡看到的寫；只貼在 DC）。 */
  name: string;
  /** 開牌後的角色名（練習台的寫法：梅林、派西維爾、雜魚1、刺客…；沒公開時空字串）。 */
  role: string;
  team: Camp | null;
  /** 這一家是百科AI。 */
  ai: boolean;
}

export interface AiGameProposal {
  round: number;
  attempt: number;
  leader: number;
  team: number[];
  approve: number[];
  reject: number[];
  approved: boolean;
  /** 第 5 次提議：練習台不投票，直接出任務。 */
  forced: boolean;
}

export interface AiGameMission {
  round: number;
  team: number[];
  fails: number;
  result: 'success' | 'fail';
}

export interface AiGameLake {
  /** 第幾局任務之後（2、3、4）。 */
  round: number;
  holder: number;
  target: number;
  /** 持湖者的宣告；沒宣告是 null。 */
  claim: Camp | null;
}

export interface AiDecision {
  /** 1 起算，依決定的時間排序（多個百科AI 合在一起）。 */
  id: number;
  /** 決定的時間（epoch ms）。 */
  at: number;
  /** 第幾局；湖與宣告＝那一局任務之後；刺殺＝最後一局。 */
  round: number;
  /** 第幾次提議；任務／湖／刺殺＝通過的那一次（不知道時 0）。 */
  attempt: number;
  kind: AiDecisionKind;
  seat: number;
  /** 百科AI 的暱稱（例：百科AI_21）。 */
  nick: string;
  /** 百科角色（merlin、percival、loyal、assassin…）。 */
  role: string;
  team: Camp;
  /** 簡短的中文動作（例：「派隊 1、4、0家」「贊成」「出失敗」）。 */
  action: string;
  detail: {
    team?: number[];
    vote?: boolean;
    card?: 'success' | 'fail';
    target?: number;
    claim?: Camp | null;
    actual?: Camp;
  };
  /** 理由（同網站練習模式的賽後回顧）。 */
  reason: string;
  rule?: string;
  suspectsLabel?: string;
  suspects?: { seat: number; score: number }[];
  suspectsNote?: string;
  knowledge?: string;
  /** agent＝AI 自己的決定；fallback＝AI 出錯或卡太久，用保守的預設動作。 */
  source: 'agent' | 'fallback';
}

export interface AiGameTrace {
  format: typeof AI_GAME_FORMAT;
  version: typeof AI_GAME_VERSION;
  source: 'signage-cloud';
  room: string;
  /** 房間描述（大廳上看到的標題）。 */
  title: string;
  startedAt: string;
  endedAt: string;
  winner: Camp | null;
  seats: AiGameSeat[];
  proposals: AiGameProposal[];
  missions: AiGameMission[];
  lakes: AiGameLake[];
  assassination: { target: number | null; hit: boolean | null } | null;
  decisions: AiDecision[];
  /** 補充說明（例：程式中途重啟、前面的決定沒記到）。 */
  notes: string[];
}

// ── 文字工具 ──────────────────────────────────────────────────────────────────────────

const ROLE_ZH: Readonly<Record<string, string>> = {
  merlin: '梅林', percival: '派西維爾', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德',
  oberon: '奧伯倫', minion: '爪牙',
};
/** 百科角色 → 中文。 */
export const roleZh = (role: string): string => ROLE_ZH[role] ?? role;

/** 座位 10 寫成 0（紙本牌譜的寫法）。 */
export const seatDigit = (seat: number): string => (seat === 10 ? '0' : String(seat));
export const seatZh = (seat: number): string => `${seatDigit(seat)}家`;
/** 「1、4、0家」（座位 10 排最後）。 */
export function seatsZh(seats: readonly number[]): string {
  if (!seats.length) return '無';
  return `${[...seats].sort((a, b) => a - b).map(seatDigit).join('、')}家`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 台灣時間的 Date（讀 UTC 欄位）。 */
function tw(iso: string): Date | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600_000) : null;
}
/** yyyymmdd_HHMM（台灣時間）。 */
export function twStamp(iso: string): string {
  const d = tw(iso);
  return d ? `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}` : '';
}
/** 2026-11-05 21:30（台灣時間）。 */
export function twReadable(iso: string): string {
  const d = tw(iso);
  return d ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : '';
}
const twHM = (iso: string): string => twReadable(iso).slice(11);

/** 單行化（換行、連續空白縮成一個空白）。 */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ── 標題與摘要 ────────────────────────────────────────────────────────────────────────

/** 討論串標題：「百科AI對局 yyyymmdd_HHMM 房間描述／房號」（台灣時間的開局時刻；≤100 字）。 */
export function aiGameThreadName(t: Pick<AiGameTrace, 'startedAt' | 'endedAt' | 'room' | 'title'>): string {
  const when = twStamp(t.startedAt || t.endedAt);
  const room = oneLine(t.room ?? '');
  const title = oneLine(t.title ?? '').replace(/[／/]+$/, '');
  const where = title && room ? `${title}／${room}` : title || room || '未知房間';
  const name = [AI_GAME_TAG_NAME, when, where].filter(Boolean).join(' ');
  return [...name].length > 100 ? `${[...name].slice(0, 99).join('')}…` : name;
}

/** 結果的一句話（例：「藍方勝（三藍，刺客刺 5家 沒中）」）。 */
export function resultText(t: Pick<AiGameTrace, 'winner' | 'missions' | 'assassination'>): string {
  const blue = t.missions.filter((m) => m.result === 'success').length;
  const red = t.missions.filter((m) => m.result === 'fail').length;
  const score = `任務 藍 ${blue}：紅 ${red}`;
  const a = t.assassination;
  const stab = a && a.target ? `刺客刺 ${seatZh(a.target)}${a.hit === true ? ' 刺中梅林' : a.hit === false ? ' 沒中' : ''}` : '';
  if (t.winner === 'good') return `藍方勝（${[score, stab].filter(Boolean).join('，')}）`;
  if (t.winner === 'evil') return `紅方勝（${[score, red >= 3 ? '三紅' : stab].filter(Boolean).join('，')}）`;
  return `勝負不明（${score}）`;
}

/** 六碼配置的寫法：刺娜德奧派梅各坐哪一家（缺的不寫）。 */
export function configText(seats: readonly AiGameSeat[]): string {
  const order: [string, string][] = [['刺客', '刺'], ['莫甘娜', '娜'], ['莫德雷德', '德'], ['奧伯倫', '奧'], ['派西維爾', '派'], ['梅林', '梅']];
  return order.map(([role, short]) => { const s = seats.find((x) => x.role === role); return s ? `${short} ${seatDigit(s.seat)}` : ''; })
    .filter(Boolean).join('、');
}

/** 一位百科AI 座位的介紹：「3家 派西維爾（百科AI_21）」。 */
function aiSeatText(t: AiGameTrace, seat: AiGameSeat): string {
  const d = t.decisions.find((x) => x.seat === seat.seat);
  const role = seat.role || (d ? roleZh(d.role) : '?');
  return `${seatZh(seat.seat)} ${role}（${seat.name || d?.nick || '百科AI'}）`;
}

const countBy = (t: AiGameTrace): string => AI_DECISION_KINDS
  .map((k) => [k, t.decisions.filter((d) => d.kind === k).length] as const)
  .filter(([, n]) => n > 0)
  .map(([k, n]) => `${AI_DECISION_KIND_LABEL[k]} ${n}`)
  .join('、');

/** 回饋方式（起始訊息與網站共用）。 */
export const FEEDBACK_HOWTO = '**怎麼回饋**：直接回覆這個討論串，寫「第幾局第幾次＋哪一家＋哪個動作＋為什麼怪」，'
  + '例如「第3局第2次 3家 投票反對：隊上明明沒有可疑的人」；每個決定都有編號 #n，寫編號也可以。'
  + `也可以到網站按「這步怪怪的」：${AI_GAMES_SITE_URL}`;

/** 起始訊息：摘要＋怎麼回饋（2000 字以內）。 */
export function aiGameSummary(t: AiGameTrace): string {
  const ai = t.seats.filter((s) => s.ai);
  const knowledge = ai.map((s) => {
    const k = t.decisions.find((d) => d.seat === s.seat && d.knowledge)?.knowledge;
    return k ? `${seatZh(s.seat)}：${k}` : '';
  }).filter(Boolean);
  const lines = [
    '**百科AI 對局紀錄**（遊玩頁 avalon.signage-cloud.org）',
    `房間：${[oneLine(t.title), t.room].filter(Boolean).join('／') || '未知'}`,
    `時間：${twReadable(t.startedAt)}${t.endedAt ? `–${twHM(t.endedAt)}` : ''}（台灣）`,
    `結果：${resultText(t)}`,
    `配置：${configText(t.seats) || '（角色沒有公開）'}`,
    `百科AI：${ai.map((s) => aiSeatText(t, s)).join('、') || '（無）'}`,
    ...(knowledge.length ? ['夜晚資訊：', ...knowledge.map((k) => `• ${k}`)] : []),
    `決定：共 ${t.decisions.length} 個${t.decisions.length ? `（${countBy(t)}）` : ''}`,
    ...t.notes.map((n) => `註：${n}`),
    '',
    FEEDBACK_HOWTO,
    '附檔：trace.json（完整紀錄）、trace.txt（可讀版）',
  ];
  return clip(lines.join('\n'), 2000);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── 決定與每一局 ──────────────────────────────────────────────────────────────────────

/** 決定在哪一段：「第 2 局第 1 次」「第 2 局任務後」「刺殺」。 */
export function decisionWhere(d: Pick<AiDecision, 'kind' | 'round' | 'attempt'>): string {
  if (d.kind === 'assassinate') return '刺殺';
  if (d.kind === 'lake' || d.kind === 'declare') return `第 ${d.round} 局任務後`;
  if (d.kind === 'mission') return `第 ${d.round} 局${d.attempt ? `第 ${d.attempt} 次` : ''}任務`;
  return `第 ${d.round} 局第 ${d.attempt} 次`;
}

/** 一個決定的標題行：「#12 3家 派西維爾 百科AI_21・投票：反對」。 */
export function decisionHead(d: AiDecision): string {
  const fb = d.source === 'fallback' ? '（預設動作）' : '';
  return `#${d.id} ${seatZh(d.seat)} ${roleZh(d.role)} ${d.nick}・${AI_DECISION_KIND_LABEL[d.kind]}：${d.action}${fb}`;
}

function suspectsText(d: AiDecision, top = 3): string {
  if (d.suspects && d.suspects.length) {
    return `${d.suspectsLabel ?? '嫌疑'}：${d.suspects.slice(0, top).map((s) => `${seatZh(s.seat)} ${s.score.toFixed(2)}`).join('、')}`
      + (d.suspectsNote ? `（${d.suspectsNote}）` : '');
  }
  return d.suspectsNote ? `${d.suspectsLabel ?? '嫌疑'}：${d.suspectsNote}` : '';
}

/** 一個決定的完整文字（標題＋理由＋規則；full 時再加嫌疑與夜晚資訊）。 */
export function decisionText(d: AiDecision, full = false): string {
  const lines = [decisionHead(d), `\u3000理由：${d.reason}`];
  if (d.rule) lines.push(`\u3000規則：${d.rule}`);
  if (full) {
    const sus = suspectsText(d);
    if (sus) lines.push(`\u3000${sus}`);
    if (d.knowledge) lines.push(`\u3000夜晚資訊：${d.knowledge}`);
  }
  return lines.join('\n');
}

function proposalLine(p: AiGameProposal): string {
  const head = `第 ${p.attempt} 次提議：隊長 ${seatZh(p.leader)} → ${seatsZh(p.team)}`;
  if (p.forced) return `${head}（第 5 次強制出任務）`;
  return `${head}\u3000贊成 ${seatsZh(p.approve)}／反對 ${seatsZh(p.reject)} → ${p.approved ? '通過' : '否決'}`;
}

function missionLine(m: AiGameMission): string {
  return `任務：${seatsZh(m.team)} → ${m.result === 'success' ? '成功' : '失敗'}（${m.fails} 張失敗）`;
}

function lakeLine(l: AiGameLake): string {
  const claim = l.claim === 'good' ? '宣告好人' : l.claim === 'evil' ? '宣告壞人' : '沒有宣告';
  return `湖：${seatZh(l.holder)} 湖 ${seatZh(l.target)}，${claim}`;
}

/**
 * 依局分組的文字段落（每段＝一局或刺殺）：那一局的公開紀錄（提議、投票、任務、湖）穿插百科AI 的決定。
 * full＝trace.txt 用（含嫌疑與夜晚資訊）。
 */
export function roundBlocks(t: AiGameTrace, full = false): string[] {
  const rounds = new Set<number>([...t.proposals.map((p) => p.round), ...t.missions.map((m) => m.round), ...t.lakes.map((l) => l.round),
    ...t.decisions.filter((d) => d.kind !== 'assassinate').map((d) => d.round)]);
  const blocks: string[] = [];
  for (const r of [...rounds].sort((a, b) => a - b)) {
    const lines = [`**第 ${r} 局**`];
    const ds = t.decisions.filter((d) => d.round === r && d.kind !== 'assassinate');
    const attempts = new Set<number>([...t.proposals.filter((p) => p.round === r).map((p) => p.attempt),
      ...ds.filter((d) => d.kind === 'team' || d.kind === 'vote').map((d) => d.attempt)]);
    for (const a of [...attempts].sort((x, y) => x - y)) {
      const p = t.proposals.find((x) => x.round === r && x.attempt === a);
      lines.push(p ? proposalLine(p) : `第 ${a} 次提議`);
      for (const d of ds.filter((x) => (x.kind === 'team' || x.kind === 'vote') && x.attempt === a)) lines.push(decisionText(d, full));
    }
    const m = t.missions.find((x) => x.round === r);
    if (m) lines.push(missionLine(m));
    for (const d of ds.filter((x) => x.kind === 'mission')) lines.push(decisionText(d, full));
    const l = t.lakes.find((x) => x.round === r);
    if (l) lines.push(lakeLine(l));
    for (const d of ds.filter((x) => x.kind === 'lake' || x.kind === 'declare')) lines.push(decisionText(d, full));
    blocks.push(lines.join('\n'));
  }
  const kills = t.decisions.filter((d) => d.kind === 'assassinate');
  if (t.assassination || kills.length) {
    const a = t.assassination;
    const lines = ['**刺殺**'];
    if (a?.target) lines.push(`刺客刺 ${seatZh(a.target)}${a.hit === true ? '，刺中梅林' : a.hit === false ? '，沒中' : ''}`);
    for (const d of kills) lines.push(decisionText(d, full));
    blocks.push(lines.join('\n'));
  }
  return blocks;
}

/**
 * 把段落裝進 Discord 訊息（每則 ≤ max 字）：段落盡量不拆；一段太長就照行拆，一行太長再硬切。
 */
export function splitMessages(blocks: readonly string[], max = DISCORD_MESSAGE_MAX): string[] {
  const out: string[] = [];
  let cur = '';
  const push = (piece: string): void => {
    if (!cur) { cur = piece; return; }
    if (cur.length + 1 + piece.length <= max) { cur += `\n${piece}`; return; }
    out.push(cur);
    cur = piece;
  };
  for (const block of blocks) {
    if (!block) continue;
    if (block.length <= max) {
      // 段落之間空一行（裝得下時）
      if (cur && cur.length + 2 + block.length <= max) { cur += `\n\n${block}`; continue; }
      push(block);
      continue;
    }
    for (const line of block.split('\n')) {
      if (line.length <= max) { push(line); continue; }
      for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max));
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 後續訊息：依局分組的決定（每則 ≤ DISCORD_MESSAGE_MAX）。超過 AI_GAME_MAX_FOLLOWUPS 則時最後一則改成「其餘看附檔」；
 * `siteUrl`（網站上這一局的網址）有給時，接在最後一則後面（裝不下就另起一則）。
 */
export function aiGameFollowups(t: AiGameTrace, siteUrl?: string): string[] {
  let msgs = splitMessages(roundBlocks(t));
  if (msgs.length > AI_GAME_MAX_FOLLOWUPS) {
    msgs = [...msgs.slice(0, AI_GAME_MAX_FOLLOWUPS - 1), `（後面還有 ${msgs.length - AI_GAME_MAX_FOLLOWUPS + 1} 則，請看附檔 trace.txt 或網站）`];
  }
  if (siteUrl) {
    const line = `網站上看這一局（每一步都有「這步怪怪的」按鈕）：${siteUrl}`;
    const last = msgs[msgs.length - 1];
    // 裝得下就接在最後一則後面，省一則訊息
    if (last !== undefined && last.length + 2 + line.length <= DISCORD_MESSAGE_MAX) msgs[msgs.length - 1] = `${last}\n\n${line}`;
    else msgs.push(line);
  }
  return msgs;
}

/** trace.txt：完整的可讀版（摘要、座位、每一局的公開紀錄與百科AI 的決定，含嫌疑與夜晚資訊）。 */
export function aiGameText(t: AiGameTrace): string {
  const seats = t.seats.map((s) => `${seatZh(s.seat)} ${s.role || '?'}${s.team ? `（${s.team === 'good' ? '藍' : '紅'}）` : ''} ${s.name}${s.ai ? '【百科AI】' : ''}`);
  const body = [
    aiGameThreadName(t),
    `房間：${[oneLine(t.title), t.room].filter(Boolean).join('／')}`,
    `時間：${twReadable(t.startedAt)}–${twHM(t.endedAt)}（台灣）`,
    `結果：${resultText(t)}`,
    `配置：${configText(t.seats)}`,
    ...t.notes.map((n) => `註：${n}`),
    '',
    '座位：',
    ...seats,
    '',
    ...roundBlocks(t, true).map((b) => `${b.replace(/\*\*/g, '')}\n`),
  ];
  return `${body.join('\n').trimEnd()}\n`;
}

// ── 讀回 trace.json（伺服器從 DC 讀）────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** 檢查 trace.json 的外形；不對時 null（不丟錯）。 */
export function parseAiGameTrace(raw: unknown): AiGameTrace | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<AiGameTrace>;
  if (t.format !== AI_GAME_FORMAT || t.version !== AI_GAME_VERSION) return null;
  if (!isStr(t.room) || !isStr(t.startedAt) || !Array.isArray(t.seats) || !Array.isArray(t.decisions)) return null;
  if (!t.seats.every((s) => s && isNum(s.seat) && isStr(s.name))) return null;
  if (!t.decisions.every((d) => d && isNum(d.id) && isNum(d.seat) && isNum(d.round) && AI_DECISION_KINDS.includes(d.kind) && isStr(d.action) && isStr(d.reason))) return null;
  return {
    ...t,
    title: isStr(t.title) ? t.title : '',
    endedAt: isStr(t.endedAt) ? t.endedAt : '',
    proposals: Array.isArray(t.proposals) ? t.proposals : [],
    missions: Array.isArray(t.missions) ? t.missions : [],
    lakes: Array.isArray(t.lakes) ? t.lakes : [],
    assassination: t.assassination ?? null,
    notes: Array.isArray(t.notes) ? t.notes.filter(isStr) : [],
    winner: t.winner === 'good' || t.winner === 'evil' ? t.winner : null,
  } as AiGameTrace;
}

// ── 網站的「這步怪怪的」→ 討論串回覆 ─────────────────────────────────────────────────────

export const FLAG_NOTE_MAX = 500;
export const FLAG_NAME_MAX = 32;

// 控制字元、雙向文字控制、BOM（同 feedbackForum.ts）。
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 原因：可多行；去控制字元、最多 FLAG_NOTE_MAX 字。 */
export function cleanFlagNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\r\n?/g, '\n').replace(UNSAFE, ' ').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return [...text].slice(0, FLAG_NOTE_MAX).join('');
}

/** 暱稱：單行、最多 FLAG_NAME_MAX 字。 */
export function cleanFlagName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return [...raw.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()].slice(0, FLAG_NAME_MAX).join('');
}

/** DC markdown 字元前加反斜線（暱稱照原樣顯示）。 */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>#[\]()<:-]/g, (c) => `\\${c}`);
}

/**
 * 網站送來的回饋 → 討論串裡的一則回覆：第幾局第幾次、哪一家、哪個決定、原因、暱稱（沒填＝匿名）。
 * 決定的內容由伺服器從 trace 取（不信任網站送來的文字）。
 */
export function formatFlagReply(d: AiDecision, note: string, name: string): string {
  const who = name ? escapeMarkdown(name) : '匿名';
  const lines = [
    `**【網站回饋】這步怪怪的** — ${who}`,
    `${decisionWhere(d)}・${seatZh(d.seat)} ${roleZh(d.role)} ${d.nick}・${AI_DECISION_KIND_LABEL[d.kind]}：${d.action}（決定 #${d.id}）`,
    ...(note ? note.split('\n').map((l) => `> ${l}`) : ['> （沒有寫原因）']),
  ];
  return clip(lines.join('\n'), 2000);
}
