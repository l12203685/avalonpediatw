/**
 * 指定玩家的逐決策點一致度（站長 2026-11-21：現行百科AI 和指定真人玩家在同一個局面會不會做出相同的決策）。純函式。
 *
 * 決策點與重播同 `agreement.replaySeat`（第 1 關的座位一致度、人類 PR 量尺用的那一套）：機器人只拿到那個座位當時知道的東西
 * （公開紀錄＋自己角色的資訊；刺殺時紅方開牌），每個決策獨立（之後照真人的牌譜走）。本檔只做「挑座位、排除、彙總、分類」，
 * 重播在 `scripts/playerAgreement.ts`。
 *
 * 比的五種決策（玩家是做決定的人時）：
 *   出任務   紅方的任務牌（可確定的牌才算，同 `pinnedQuestCard`）；藍方只能出成功，不列。
 *   湖中     目標（所有持湖者）；宣告分紅方／藍方兩欄。
 *   派隊     玩家當隊長的每一次提議：整隊完全相同；Jaccard 平均當第二指標。
 *   投票     只看異常票（定義同 `infl/abnormalVotes.voteKind` 與數據分析 `shared/stats/abnormalVotes.ts`：
 *            內黑 = 在隊上投反對、外白 = 不在隊上投贊成；只算第 1～4 次提議、票數對得上結果的提議，強制局沒有投票）。
 *            兩個方向：玩家投異常票時機器人同票的比例；機器人會投異常票時玩家同票的比例。
 *   刺殺     玩家是任何紅方角色的局（紅方一起討論刺誰），比機器人刺客在同一個局面的選擇和實際刺殺目標。
 */
import { voteKind, type VoteKind } from '../infl/abnormalVotes';
import type { DecisionOutcome } from './agreement';

export type Profile = 'human' | 'ai';

/** 彙總的指標。 */
export const METRICS = [
  'quest_red',
  'lakeTarget',
  'lakeClaim_red',
  'lakeClaim_blue',
  'team',
  'abn_player',
  'abn_player_內黑',
  'abn_player_外白',
  'abn_bot',
  'abn_bot_內黑',
  'abn_bot_外白',
  'assassinate',
] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_ZH: Readonly<Record<Metric, string>> = {
  quest_red: '出任務（紅方任務牌）',
  lakeTarget: '湖中目標',
  lakeClaim_red: '湖中宣告（紅方）',
  lakeClaim_blue: '湖中宣告（藍方）',
  team: '派隊（整隊相同）',
  abn_player: '異常票：玩家投異常 → AI 同票',
  'abn_player_內黑': '　玩家內黑 → AI 同票',
  'abn_player_外白': '　玩家外白 → AI 同票',
  abn_bot: '異常票：AI 投異常 → 玩家同票',
  'abn_bot_內黑': '　AI 內黑 → 玩家同票',
  'abn_bot_外白': '　AI 外白 → 玩家同票',
  assassinate: '刺殺目標（紅方全員）',
};

export const ROLE_ZH: Readonly<Record<string, string>> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
};
export const ROLE_ORDER = ['loyal', 'percival', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon'] as const;

/** 一個比對過的決策點（只在私人輸出裡帶玩家名字）。 */
export interface PlayerSpot {
  player: string;
  profile: Profile;
  gameId: string;
  seat: number;
  role: string;
  side: 'good' | 'evil';
  type: DecisionOutcome['type'];
  round: number;
  attempt?: number;
  human: string;
  agent: string;
  match: boolean;
  jaccard?: number;
  /** 投票：玩家／機器人的票種。 */
  humanVote?: VoteKind;
  agentVote?: VoteKind;
  /** 刺殺：玩家這邊的刺殺是不是由別的紅方座位執行（玩家不是刺客）。 */
  viaTeammate?: boolean;
  /** 刺殺由別的座位執行時，那個座位（機器人在那個座位決定）。 */
  actorSeat?: number;
  /** 真人桌策略層（human profile 用的層；ai 欄也記同一桌的層，方便對照）。 */
  tier: string;
  situation: string;
  divergence: string;
}

/** DecisionOutcome（agreement.replaySeat）→ PlayerSpot。 */
export function spotFromOutcome(o: DecisionOutcome, player: string, profile: Profile, tier: string): PlayerSpot {
  const spot: PlayerSpot = {
    player, profile, gameId: o.gameId, seat: o.seat, role: o.role, side: o.side, type: o.type, round: o.round,
    ...(o.attempt !== undefined ? { attempt: o.attempt } : {}),
    human: o.human, agent: o.agent, match: o.match,
    ...(o.jaccard !== undefined ? { jaccard: o.jaccard } : {}),
    tier, situation: o.situation, divergence: o.divergence,
  };
  if (o.type === 'vote' && o.humanNonDefault !== undefined && o.agentNonDefault !== undefined) {
    // humanNonDefault = 票 ≠ 在不在隊上 → 還原「在隊上」再分類（同 voteKind）。
    const humanApprove = o.human === 'approve';
    const onTeam = o.humanNonDefault ? !humanApprove : humanApprove;
    spot.humanVote = voteKind(onTeam, humanApprove);
    spot.agentVote = voteKind(onTeam, o.agent === 'approve');
  }
  return spot;
}

/**
 * 刺殺：玩家是紅方但不是刺客 → 把刺客座位的刺殺決策（機器人在刺客座位、同一個局面的選擇）記到玩家的座位與角色上。
 */
export function assassinationForTeammate(assassinOutcome: DecisionOutcome, seat: number, role: string, player: string, profile: Profile, tier: string): PlayerSpot {
  return { ...spotFromOutcome(assassinOutcome, player, profile, tier), seat, role, side: 'evil', viaTeammate: true, actorSeat: assassinOutcome.seat };
}

/** 一個決策點算進哪些指標。 */
export function metricsOf(s: PlayerSpot): Metric[] {
  switch (s.type) {
    case 'quest': return s.side === 'evil' ? ['quest_red'] : [];
    case 'lakeTarget': return ['lakeTarget'];
    case 'lakeClaim': return [s.side === 'evil' ? 'lakeClaim_red' : 'lakeClaim_blue'];
    case 'team': return ['team'];
    case 'assassinate': return ['assassinate'];
    case 'vote': {
      const out: Metric[] = [];
      if (s.humanVote && s.humanVote !== 'normal') out.push('abn_player', `abn_player_${s.humanVote}` as Metric);
      if (s.agentVote && s.agentVote !== 'normal') out.push('abn_bot', `abn_bot_${s.agentVote}` as Metric);
      return out;
    }
    default: return [];
  }
}

export interface Cell {
  n: number;
  same: number;
  diff: number;
  /** same / n（百分比，一位小數）；n = 0 → null。 */
  samePct: number | null;
  /** 派隊：Jaccard 平均。 */
  jaccardMean?: number;
}

type CellMap = Partial<Record<Metric, Cell>>;

export interface PlayerProfileResult {
  all: CellMap;
  byRole: Record<string, CellMap>;
  bySeat: Record<string, CellMap>;
  byRoleSeat: Record<string, Record<string, CellMap>>;
  byTier: Record<string, CellMap>;
}

interface RawCell { n: number; same: number; jac: number; jn: number }

function finish(raw: Map<Metric, RawCell>): CellMap {
  const out: CellMap = {};
  for (const m of METRICS) {
    const r = raw.get(m);
    if (!r) continue;
    out[m] = {
      n: r.n, same: r.same, diff: r.n - r.same,
      samePct: r.n ? Math.round((1000 * r.same) / r.n) / 10 : null,
      ...(r.jn ? { jaccardMean: Math.round((1000 * r.jac) / r.jn) / 1000 } : {}),
    };
  }
  return out;
}

/** 一個玩家 × 一個策略層的所有決策點 → 全部／分角色／分座位／角色 × 座位／分桌層的格子。 */
export function aggregateSpots(spots: readonly PlayerSpot[]): PlayerProfileResult {
  const groups = new Map<string, Map<Metric, RawCell>>();
  const add = (g: string, m: Metric, s: PlayerSpot): void => {
    let mm = groups.get(g);
    if (!mm) { mm = new Map(); groups.set(g, mm); }
    const r = mm.get(m) ?? { n: 0, same: 0, jac: 0, jn: 0 };
    r.n += 1;
    r.same += s.match ? 1 : 0;
    if (s.jaccard !== undefined && m === 'team') { r.jac += s.jaccard; r.jn += 1; }
    mm.set(m, r);
  };
  for (const s of spots) {
    for (const m of metricsOf(s)) {
      add('all', m, s);
      add(`role|${s.role}`, m, s);
      add(`seat|${s.seat}`, m, s);
      add(`rs|${s.role}|${s.seat}`, m, s);
      add(`tier|${s.tier}`, m, s);
    }
  }
  const res: PlayerProfileResult = { all: {}, byRole: {}, bySeat: {}, byRoleSeat: {}, byTier: {} };
  const keys = [...groups.keys()].sort();
  for (const k of keys) {
    const cells = finish(groups.get(k)!);
    const [kind, a, b] = k.split('|');
    if (kind === 'all') res.all = cells;
    else if (kind === 'role') res.byRole[a] = cells;
    else if (kind === 'seat') res.bySeat[a] = cells;
    else if (kind === 'tier') res.byTier[a] = cells;
    else if (kind === 'rs') (res.byRoleSeat[a] ??= {})[b] = cells;
  }
  return res;
}

// ── 不同的種類 ─────────────────────────────────────────────

const SIDE_ZH = { good: '藍方', evil: '紅方' } as const;

function roundBand(round: number): string {
  return round <= 2 ? `R${round}` : 'R3+';
}

const VOTE_ZH: Readonly<Record<VoteKind, string>> = { normal: '正常票', 內黑: '內黑', 外白: '外白' };

const TEAM_DIV_ZH: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^human leaves self off$/, (): string => '玩家沒派自己'],
  [/^agent adds failed-mission member$/, (): string => 'AI 多放出過失敗任務的人'],
  [/^human adds failed-mission member$/, (): string => '玩家多放出過失敗任務的人'],
  [/^human adds an ally$/, (): string => '玩家多放紅方隊友'],
  [/^agent adds an ally$/, (): string => 'AI 多放紅方隊友'],
  [/^differs by (\d+) member/, (m): string => `差 ${m[1]} 人`],
];

const LAKE_KIND_ZH: Readonly<Record<string, string>> = {
  ally: '紅方隊友', wizard: '梅林／莫甘娜候選', 'failed-mission member': '出過失敗任務的人', 'clean seat': '沒出過失敗任務的人',
};

/**
 * 不同的種類（中文、可分組）：同一種類 = 同一種決策、同一方、相近的局面、同一種分歧。相同的決策點回傳 null。
 */
export function disagreementKind(s: PlayerSpot): string | null {
  if (s.match) return null;
  const side = SIDE_ZH[s.side];
  switch (s.type) {
    case 'team': {
      const hit = TEAM_DIV_ZH.map(([re, f]) => { const m = s.divergence.match(re); return m ? f(m) : null; }).find((x) => x !== null);
      return `派隊・${side}・${roundBand(s.round)}：${hit ?? s.divergence}`;
    }
    case 'vote':
      return `投票・${side}・${roundBand(s.round)}：玩家${VOTE_ZH[s.humanVote ?? 'normal']}（${s.human === 'approve' ? '贊成' : '反對'}），AI ${VOTE_ZH[s.agentVote ?? 'normal']}（${s.agent === 'approve' ? '贊成' : '反對'}）`;
    case 'quest':
      return `出任務・R${s.round}：玩家出${s.human === 'fail' ? '失敗' : '成功'}，AI 出${s.agent === 'fail' ? '失敗' : '成功'}`;
    case 'lakeTarget': {
      const m = s.divergence.match(/^human (.+) \/ agent (.+)$/);
      const k = (x: string): string => LAKE_KIND_ZH[x] ?? x;
      return `湖中目標・${side}：${m ? `玩家驗${k(m[1])}，AI 驗${k(m[2])}` : s.divergence}`;
    }
    case 'lakeClaim': {
      const truth = s.situation.match(/truth (good|evil)/)?.[1];
      const t = truth === 'evil' ? '紅' : '藍';
      const said = (c: string): string => (c === truth ? '說實話' : c === 'none' ? '不宣告' : '說謊');
      return `湖中宣告・${side}・驗到${t}：玩家${said(s.human)}，AI ${said(s.agent)}`;
    }
    case 'assassinate': {
      const m = s.divergence.match(/^human (hit|miss) \/ agent (hit|miss)$/);
      const z = (x: string): string => (x === 'hit' ? '刺中梅林' : '沒刺中');
      return `刺殺：${m ? `實際${z(m[1])}，AI ${z(m[2])}` : s.divergence}`;
    }
    default:
      return `${s.type}：${s.divergence}`;
  }
}

export interface DisagreementGroup<E> {
  kind: string;
  count: number;
  /** 這個種類佔玩家所有不同的比例（%）。 */
  share: number;
  examples: E[];
}

/**
 * 不同的種類依次數排序，取前 `top` 種，每種挑 `perKind` 個例子（照局號排序後平均取，避免都擠在同一段時間）。
 */
export function topDisagreements(spots: readonly PlayerSpot[], top = 5, perKind = 2): Array<DisagreementGroup<PlayerSpot>> {
  const byKind = new Map<string, PlayerSpot[]>();
  for (const s of spots) {
    const k = disagreementKind(s);
    if (k === null) continue;
    const xs = byKind.get(k) ?? [];
    xs.push(s);
    byKind.set(k, xs);
  }
  const total = [...byKind.values()].reduce((a, xs) => a + xs.length, 0);
  return [...byKind.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([kind, xs]) => {
      const sorted = [...xs].sort((a, b) => a.gameId.localeCompare(b.gameId, 'en', { numeric: true }) || a.round - b.round || (a.attempt ?? 0) - (b.attempt ?? 0));
      const picks: PlayerSpot[] = [];
      for (let i = 0; i < Math.min(perKind, sorted.length); i++) {
        picks.push(sorted[Math.floor(((i + 0.5) * sorted.length) / Math.min(perKind, sorted.length))]);
      }
      return { kind, count: xs.length, share: total ? Math.round((1000 * xs.length) / total) / 10 : 0, examples: picks };
    });
}

/** 每一種決策（派隊、投票、出任務、湖中目標、湖中宣告、刺殺）各自最常見的 `top` 種不同（不帶例子）。 */
export function topDisagreementsByType(spots: readonly PlayerSpot[], top = 1): Record<string, Array<{ kind: string; count: number; ofType: number }>> {
  const out: Record<string, Array<{ kind: string; count: number; ofType: number }>> = {};
  const types = [...new Set(spots.map((s) => s.type))];
  for (const t of types) {
    const mine = spots.filter((s) => s.type === t);
    const diffs = mine.filter((s) => !s.match).length;
    const groups = topDisagreements(mine, top, 0);
    if (groups.length) out[t] = groups.map((g) => ({ kind: g.kind, count: g.count, ofType: diffs }));
  }
  return out;
}

// ── 局的排除（總庫的錯誤局、重複局；站長的更正檔）───────────────

export interface GameDbRow {
  id: string;
  kind: string;
  status: string;
  sources: ReadonlyArray<{ src: string; id: string }>;
  checks: ReadonlyArray<{ rule: string; level: string; msg?: string }>;
}

export interface GameDbCorrection {
  exclude?: readonly string[];
  duplicateOf?: string;
}

/** 資料集的局號：牌譜 S<流水號> → 資料集 src 0 的 id；Discord 匯入 D<hash> → src 1 的 id。其他來源不在資料集。 */
export function datasetKeyOfSource(src: string, id: string): string | null {
  if (src === 'sheet' && /^S\d+$/.test(id)) return `0|${id.slice(1)}`;
  if (src === 'dc_import' && /^D/.test(id)) return `1|${id}`;
  return null;
}

/** 每局排除的原因（資料集 key → 原因）。 */
export function excludedDatasetKeys(rows: readonly GameDbRow[], corrections: Readonly<Record<string, GameDbCorrection>> = {}): Map<string, string> {
  const out = new Map<string, string>();
  const put = (key: string | null, why: string): void => { if (key && !out.has(key)) out.set(key, why); };
  for (const [srcId, c] of Object.entries(corrections)) {
    const key = /^S\d+$/.test(srcId) ? datasetKeyOfSource('sheet', srcId) : /^D/.test(srcId) ? datasetKeyOfSource('dc_import', srcId) : null;
    if (c.exclude && c.exclude.length > 0) put(key, `站長更正：${c.exclude.join('、')}`);
    if (c.duplicateOf) put(key, '站長更正：重複局');
  }
  for (const r of rows) {
    if (r.kind !== 'real') continue;
    const keys = r.sources.map((s) => ({ s, key: datasetKeyOfSource(s.src, s.id) })).filter((x) => x.key !== null);
    if (r.status === 'error') { for (const x of keys) put(x.key, `總庫錯誤局（${r.checks.filter((c) => c.level === 'error').map((c) => c.rule).join('、')}）`); continue; }
    const rules = new Set(r.checks.map((c) => c.rule));
    if (rules.has('NEAR_DUP') || rules.has('DUP_SAME_SOURCE')) { for (const x of keys) put(x.key, '總庫疑似重複局'); continue; }
    if (rules.has('SUPERSEDED')) {
      // 記錯的來源（訊息裡點名的試算表／匯入編號）不用。
      for (const x of keys) if (r.checks.some((c) => c.rule === 'SUPERSEDED' && (c.msg ?? '').includes(x.s.id))) put(x.key, '總庫：這個來源記錯（用了另一個來源）');
    }
    // 同一局同時在牌譜與 Discord 匯入：只留一份（先留沒被點名記錯的那份）。
    const kept = keys.filter((x) => !out.has(x.key!));
    for (const x of kept.slice(1)) put(x.key, '總庫：同一局的另一個來源（只算一份）');
  }
  return out;
}

/** 輸出路徑不可以在 repo 裡（輸出有玩家名字）。 */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string): string => (p.endsWith('/') ? p : `${p}/`);
  return norm(child).startsWith(norm(parent));
}
