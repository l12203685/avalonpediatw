/**
 * 刺殺：用「派西維爾－梅林」世界線找梅林（優化迴圈第 75 回合・紅方；`AgentTuning.assassinWorldLine75`，開關在 `Round75.ts`）。
 *
 * 站長 2026-11-25（原話）：
 * >「真人刺中率比較高是因為 來自四個紅方的視角會綜合考慮 你不能只考慮刺客的視角
 * >  還有莫甘娜跟整體場上的反饋 因為莫甘娜會被派西維爾看到 所以考慮刺殺梅林時 可以從這點去反推可能的派西維爾位置
 * >  進而推出誰是派西維爾 誰是梅林 的世界線存在的可能性與合理性」
 *
 * 現行的刺殺一次只看一個候選人「像不像梅林」。這裡改成一次看一條世界線：有序的一對（派西維爾 = X、梅林 = Y），
 * 6 個藍方座位共 30 條，剩下 4 個是忠臣。刺殺時四個紅方開牌相認（`allEvilRoles`），誰是莫甘娜（派西維爾的另一根拇指）、
 * 誰是莫德雷德（梅林看不到）、誰是奧伯倫都知道，所以每條世界線裡每個藍方座位「看得到什麼」是確定的。
 *
 * 一條世界線的分數 = 每個藍方座位「照這條世界線給他的角色」做出他實際做過的事的對數概似，減掉「不分角色的藍方」做同一件事的對數概似，
 * 分九個分量（角色 派西／梅林／忠臣 × 動作 派隊／票／湖）各自加總，再乘上疊加權重：
 *   - 派隊：他當隊長的每一次提議 × 每個其他座位「有沒有被放上隊」。格 = 隊長的角色 × 被放的人的角色 × 第幾局 × 是不是強制局 ×
 *     那個人在不在最近一次成功的任務隊上 × 出過失敗的任務沒有。派西維爾對梅林那一格再分「莫甘娜在不在這一隊」（兩根拇指只放一根），
 *     對莫甘娜那一格再分「莫甘娜曝光了沒」（出過失敗的任務，或被湖宣告成紅）。
 *   - 票：非強制、票和結果對得上、不是他自己的提議。派西維爾：兩根拇指各自在不在隊上、隊長是哪一根拇指、莫甘娜曝光了沒；
 *     梅林：隊上幾個他看得到的紅、莫德雷德在不在、紅方是不是已經兩勝；忠臣：梅林／派西維爾在不在隊上、隊長是誰。
 *   - 湖：他持湖時湖了哪一類人。
 * 每一格的比例來自真人局（`worldLines75Tables.json`，`scripts/worldLineStudy75.py --part export`；格子人數少的往上一層的格收縮）。
 *
 * 梅林的邊際 log P(梅林 = Y) = log Σ_X exp(分數(X, Y)) − log Σ 全部世界線；派西維爾的邊際同理。
 *
 * 只用公開紀錄（提議、票、任務結果、湖的持有者／目標／宣告）加上紅方開牌之後的紅方角色；絕不讀藍方的真實角色。
 * 不是 10 人局、或紅方不是刺客／莫甘娜／莫德雷德／奧伯倫各一個時不適用（回 null，刺殺照原本）。
 */
import type { PlayerObservation } from '../types';
import { missionFailed } from '../missionFacts';
import FULL_TABLES from './worldLines75Tables.json';

export const WORLD_LINE_COMPS = ['Pk', 'Pv', 'Pl', 'Mk', 'Mv', 'Ml', 'Lk', 'Lv', 'Ll'] as const;
export type WorldLineComp = (typeof WORLD_LINE_COMPS)[number];

/** `scripts/worldLineStudy75.py --part export` 的輸出。 */
export interface WorldLineTables {
  version: string;
  /** 往上一層收縮的強度（偽計數）。 */
  kappa: number;
  comps: readonly string[];
  /** 九個分量的疊加權重（與 `comps` 同序）。 */
  weights: readonly number[];
  /** 二元事件的格：每一層前綴 → [次數, 發生的次數]。 */
  bin: Readonly<Record<string, readonly number[]>>;
  /** 湖：持湖者的角色（L／P／M／B）→ 目標類別 → 次數。 */
  lake: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export const WORLD_LINE_TABLES_75: WorldLineTables = FULL_TABLES as unknown as WorldLineTables;

type Part = string | number;
type RoleHyp = 'L' | 'P' | 'M';
type Triple = [number, number, number];

/** 湖的目標類別各有幾個座位（類別內平均分）。 */
const LAKE_N: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  L: { merlin: 1, percival: 1, loyal: 3, red: 4 },
  P: { merlin: 1, morgana: 1, loyal: 4, red: 3 },
  M: { percival: 1, loyal: 4, seen: 3, mordred: 1 },
  B: { blue: 5, red: 4 },
};

const P_MIN = 1e-4;

/** 一張表的機率查詢（逐層退回上一層的前綴當先驗；結果記住）。 */
class TableReader {
  private readonly memo = new Map<string, number>();

  constructor(readonly tables: WorldLineTables) {}

  /** P(事件發生 | 格)。`key` 的前 3 個元素是最上層。 */
  p(key: readonly Part[]): number {
    const id = key.join('|');
    const hit = this.memo.get(id);
    if (hit !== undefined) return hit;
    const cell = this.tables.bin[id];
    const n = cell ? cell[0] : 0;
    const k = cell ? cell[1] : 0;
    let val: number;
    if (key.length <= 3) val = (k + 0.5) / (n + 1);
    else val = (k + this.tables.kappa * this.p(key.slice(0, -1))) / (n + this.tables.kappa);
    val = Math.min(Math.max(val, P_MIN), 1 - P_MIN);
    this.memo.set(id, val);
    return val;
  }

  llBin(key: readonly Part[], v: boolean): number {
    const q = this.p(key);
    return Math.log(v ? q : 1 - q);
  }

  /** log P(湖了這一類裡的某一個座位 | 持湖者的角色)。 */
  llLake(rs: string, cat: string): number {
    const row = this.tables.lake[rs] ?? {};
    const cats = LAKE_N[rs];
    let tot = 0;
    for (const c of Object.keys(row)) tot += row[c];
    return Math.log((((row[cat] ?? 0) + 1) / (tot + Object.keys(cats).length)) / cats[cat]);
  }

  /** 這張表有沒有這個角色的湖（沒有 = 湖不算分；正式的表一定有）。 */
  hasLake(rs: string): boolean {
    const row = this.tables.lake[rs];
    return row !== undefined && Object.keys(row).length > 0;
  }
}

const readers = new WeakMap<WorldLineTables, TableReader>();
function readerOf(tables: WorldLineTables): TableReader {
  let r = readers.get(tables);
  if (!r) { r = new TableReader(tables); readers.set(tables, r); }
  return r;
}

interface Prop {
  r: number;
  a: number;
  leader: string;
  team: ReadonlySet<string>;
  /** 贊成的人；null = 強制局，或票數和結果對不上（真人牌譜裡少數記錯的提議）。 */
  appr: ReadonlySet<string> | null;
  forced: boolean;
  /** 這一局開始之前紅方贏了幾局。 */
  fails: number;
  /** 這一局之前最近一次成功的任務隊（沒有 = 空）。 */
  lastSucc: ReadonlySet<string>;
  /** 這一局之前出過失敗任務的人。 */
  onFail: ReadonlySet<string>;
  /** 這一局之前被湖宣告成紅的人。 */
  lakedX: ReadonlySet<string>;
}

interface Reds { assassin: string; morgana: string; mordred: string; oberon: string }

function redsOf(obs: PlayerObservation): Reds | null {
  const roles = obs.allEvilRoles;
  if (!roles || obs.playerCount !== 10 || obs.allPlayerIds.length !== 10) return null;
  const find = (role: string): string[] => Object.keys(roles).filter((id) => roles[id] === role);
  const a = find('assassin');
  const m = find('morgana');
  const d = find('mordred');
  const o = find('oberon');
  if (a.length !== 1 || m.length !== 1 || d.length !== 1 || o.length !== 1 || Object.keys(roles).length !== 4) return null;
  return { assassin: a[0], morgana: m[0], mordred: d[0], oberon: o[0] };
}

function propsOf(obs: PlayerObservation): Prop[] {
  const quests = [...obs.questHistory].sort((x, y) => x.round - y.round);
  const lakes = obs.lakeHistory ?? [];
  const n = obs.playerCount;
  return obs.voteHistory.map((v) => {
    const before = quests.filter((q) => q.round < v.round);
    const succ = before.filter((q) => !missionFailed(q));
    const onFail = new Set<string>();
    for (const q of before) if (missionFailed(q)) for (const id of q.team) onFail.add(id);
    const forced = v.attempt >= 5;
    const approvers = obs.allPlayerIds.filter((id) => v.votes[id] === true);
    const complete = obs.allPlayerIds.every((id) => v.votes[id] !== undefined);
    // 票數和結果對得上才讀（過半才出任務）；實戰的紀錄一定對得上，真人牌譜有少數記錯的提議。
    const reliable = !forced && complete && (v.approved ? approvers.length * 2 > n : approvers.length * 2 <= n);
    return {
      r: v.round,
      a: v.attempt,
      leader: v.leader,
      team: new Set(v.team),
      appr: reliable ? new Set(approvers) : null,
      forced,
      fails: before.filter((q) => missionFailed(q)).length,
      lastSucc: new Set(succ.length ? succ[succ.length - 1].team : []),
      onFail,
      lakedX: new Set(lakes.filter((l) => l.round < v.round && l.declaredClaim === 'evil').map((l) => l.targetId)),
    };
  });
}

interface Ctx {
  ids: readonly string[];
  props: readonly Prop[];
  reds: Reds;
  redRole: ReadonlyMap<string, string>;
  lakes: readonly { holder: string; target: string }[];
  tb: TableReader;
}

/** 座位 s 照角色假設 rs（世界線的派西 x、梅林 y）的三個分量：[派隊, 票, 湖] 的對數概似比。 */
function seatScore(c: Ctx, s: string, rs: RoleHyp, x: string | null, y: string | null): Triple {
  const { reds, redRole, tb } = c;
  const m = reds.morgana;
  const d = reds.mordred;
  let pick = 0;
  let vote = 0;
  let lake = 0;
  for (const p of c.props) {
    const team = p.team;
    const forced = p.forced ? 1 : 0;
    if (p.leader === s) {
      const exposed = p.onFail.has(m) || p.lakedX.has(m) ? 1 : 0;
      const self = team.has(s);
      pick += tb.llBin(['k', rs, 'self', 0, p.r, forced], self) - tb.llBin(['k', 'B', 'self', p.r, forced], self);
      for (const t of c.ids) {
        if (t === s) continue;
        const pub0 = p.lastSucc.has(t) ? 1 : 0;
        const pub1 = p.onFail.has(t) ? 1 : 0;
        const red = redRole.get(t);
        const rt = red ?? (t === y ? 'merlin' : t === x ? 'percival' : 'loyal');
        const inv = red ?? 'blue';
        let extra = 0;
        if (rs === 'P' && rt === 'merlin') extra = team.has(m) ? 1 : 0;
        else if (rs === 'P' && rt === 'morgana') extra = exposed;
        const on = team.has(t);
        pick += tb.llBin(['k', rs, rt, extra, p.r, forced, pub0, pub1], on) - tb.llBin(['k', 'B', inv, p.r, forced, pub0, pub1], on);
      }
      continue;
    }
    if (p.appr === null) continue;
    const on = team.has(s) ? 1 : 0;
    let nred = 0;
    let nseen = 0;
    let nother = 0;
    for (const t of team) {
      if (!redRole.has(t)) continue;
      nred++;
      if (t !== d) nseen++;
      if (t !== m) nother++;
    }
    const att4 = p.a === 4 ? 1 : 0;
    const v = p.appr.has(s);
    const leaderRed = redRole.has(p.leader);
    let key: Part[];
    if (rs === 'L') {
      const lead = p.leader === y ? 'M' : p.leader === x ? 'P' : leaderRed ? 'r' : 'b';
      key = ['v', 'L', on, y !== null && team.has(y) ? 1 : 0, x !== null && team.has(x) ? 1 : 0, lead, p.r, Math.min(nred, 2), att4];
    } else if (rs === 'P') {
      const lead = p.leader === y ? 'M' : p.leader === m ? 'G' : 'o';
      const exposed = p.onFail.has(m) || p.lakedX.has(m) ? 1 : 0;
      key = ['v', 'P', on, y !== null && team.has(y) ? 1 : 0, team.has(m) ? 1 : 0, lead, exposed, p.r, Math.min(nother, 1), att4];
    } else {
      const lead = p.leader === x ? 'P' : p.leader === d ? 'd' : leaderRed ? 's' : 'b';
      key = ['v', 'M', on, Math.min(nseen, 2), team.has(d) ? 1 : 0, p.fails >= 2 ? 1 : 0, p.r, x !== null && team.has(x) ? 1 : 0, lead, att4];
    }
    vote += tb.llBin(key, v) - tb.llBin(['v', 'B', on, Math.min(nred, 2), p.r, leaderRed ? 1 : 0, att4], v);
  }
  for (const l of c.lakes) {
    if (l.holder !== s || !tb.hasLake(rs) || !tb.hasLake('B')) continue;
    const t = l.target;
    const red = redRole.has(t);
    let cat: string;
    if (rs === 'L') cat = red ? 'red' : t === y ? 'merlin' : t === x ? 'percival' : 'loyal';
    else if (rs === 'P') cat = t === m ? 'morgana' : red ? 'red' : t === y ? 'merlin' : 'loyal';
    else cat = t === d ? 'mordred' : red ? 'seen' : t === x ? 'percival' : 'loyal';
    lake += tb.llLake(rs, cat) - tb.llLake('B', red ? 'red' : 'blue');
  }
  return [pick, vote, lake];
}

export interface WorldLine {
  percival: string;
  merlin: string;
  /** 九個分量（`WORLD_LINE_COMPS` 的順序）的對數概似比。 */
  comps: number[];
  /** 疊加權重之後的分數。 */
  score: number;
}

export interface WorldLineReadout {
  worlds: WorldLine[];
  /** log P(梅林 = 這個座位)（30 條世界線的 softmax 對派西維爾加總）。 */
  merlin: Map<string, number>;
  /** log P(派西維爾 = 這個座位)。 */
  percival: Map<string, number>;
}

function logSumExp(xs: readonly number[]): number {
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of xs) if (v > mx) mx = v;
  let s = 0;
  for (const v of xs) s += Math.exp(v - mx);
  return mx + Math.log(s);
}

/**
 * 30 條世界線的分數與梅林／派西維爾的邊際。`obs` = 刺殺階段刺客的觀測（要有 `allEvilRoles`）；不適用時 null。
 */
export function worldLines75(obs: PlayerObservation, tables: WorldLineTables = WORLD_LINE_TABLES_75): WorldLineReadout | null {
  const reds = redsOf(obs);
  if (!reds) return null;
  const redRole = new Map<string, string>([[reds.assassin, 'assassin'], [reds.morgana, 'morgana'], [reds.mordred, 'mordred'], [reds.oberon, 'oberon']]);
  const blue = obs.allPlayerIds.filter((id) => !redRole.has(id));
  if (blue.length !== 6) return null;
  const c: Ctx = {
    ids: obs.allPlayerIds,
    props: propsOf(obs),
    reds,
    redRole,
    lakes: (obs.lakeHistory ?? []).map((l) => ({ holder: l.holderId, target: l.targetId })),
    tb: readerOf(tables),
  };
  const w = tables.weights;
  // 每個座位的三種角色假設各算一次：忠臣（世界線的派西 x、梅林 y）、派西（梅林 y）、梅林（派西 x）。
  const asLoyal = new Map<string, Triple>();
  const asPercival = new Map<string, Triple>();
  const asMerlin = new Map<string, Triple>();
  for (const s of blue) {
    for (const o of blue) {
      if (o === s) continue;
      asPercival.set(`${s}|${o}`, seatScore(c, s, 'P', null, o));
      asMerlin.set(`${s}|${o}`, seatScore(c, s, 'M', o, null));
      for (const o2 of blue) {
        if (o2 === s || o2 === o) continue;
        asLoyal.set(`${s}|${o}|${o2}`, seatScore(c, s, 'L', o, o2));
      }
    }
  }
  const worlds: WorldLine[] = [];
  for (const x of blue) {
    for (const y of blue) {
      if (x === y) continue;
      const pv = asPercival.get(`${x}|${y}`) as Triple;
      const mv = asMerlin.get(`${y}|${x}`) as Triple;
      const lv = [0, 0, 0];
      for (const s of blue) {
        if (s === x || s === y) continue;
        const t = asLoyal.get(`${s}|${x}|${y}`) as Triple;
        lv[0] += t[0];
        lv[1] += t[1];
        lv[2] += t[2];
      }
      const comps = [pv[0], pv[1], pv[2], mv[0], mv[1], mv[2], lv[0], lv[1], lv[2]];
      let score = 0;
      for (let i = 0; i < comps.length; i++) score += (w[i] ?? 0) * comps[i];
      worlds.push({ percival: x, merlin: y, comps, score });
    }
  }
  const all = logSumExp(worlds.map((wl) => wl.score));
  const merlin = new Map<string, number>();
  const percival = new Map<string, number>();
  for (const id of blue) {
    merlin.set(id, logSumExp(worlds.filter((wl) => wl.merlin === id).map((wl) => wl.score)) - all);
    percival.set(id, logSumExp(worlds.filter((wl) => wl.percival === id).map((wl) => wl.score)) - all);
  }
  return { worlds, merlin, percival };
}
