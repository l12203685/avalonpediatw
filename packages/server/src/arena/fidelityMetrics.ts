/**
 * AI騎士 精準度：抽出來的決策點格式與各動作的一致度（純函式；`scripts/knightFidelity.ts`、`scripts/knightFidelityFit.ts` 用）。
 *
 * 座位一律用 1..n（幾家）；`S`／`X` 的欄位照 `residual.ts` 的特徵清單。
 */
import { SEAT_FEATURES, VOTE_FEATURES } from './residual';
import { prf } from './residualFit';

/** 一個座位（一位玩家坐過的一局的一個位置）。 */
export interface FidJob {
  /** 局號 */
  g: string;
  /** 座位 1..n */
  s: number;
  /** 玩家編號（入選清單裡的位置） */
  p: number;
  /** 隨機一半：0 擬合、1 測試（同 v1 `halfOf`）。 */
  half: 0 | 1;
  /** 時間切分：0 = 這位玩家較舊的 70%（擬合）、1 = 較新的 30%（測試）。 */
  time: 0 | 1;
  date: string;
}

/** 座位資訊（每個座位一筆）。 */
export interface FidMeta {
  t: 'M';
  j: number;
  role: string;
  /** 派西維爾看到的兩根拇指（其他角色空）。 */
  thumbs: number[];
  merlin: number;
  morgana: number;
  /** 刺客刺的座位（0 = 沒刺）。 */
  killed: number;
  winner: string;
}

interface Base { j: number; r: number; rf: number }

/** 派隊：h／d／k = 真人／百科AI／v1 的隊；S = 每個座位的特徵（`eng` 欄 = v1 的隊）。 */
export interface TeamRec extends Base { t: 'T'; p: number; a: number; h: number[]; d: number[]; k: number[]; S: number[][]; sz: number; pp: number[]; lm: number[] }
/** 投票：1 = 贊成。on = 在隊上；ld = 隊長；tr = 隊上有紅（真相）；to = 隊上有自己以外的紅（真相）。 */
export interface VoteRec extends Base { t: 'V'; p: number; a: number; h: 0 | 1; d: 0 | 1; k: 0 | 1; x: number[]; on: 0 | 1; ld: 0 | 1; tr: 0 | 1; to: 0 | 1; team: number[] }
/** 紅方任務牌：1 = 失敗。seen = 隊上看得到的隊友數。 */
export interface QuestRec extends Base { t: 'Q'; h: 0 | 1; d: 0 | 1; k: 0 | 1; x: number[]; seen: number; sz: number }
/** 湖中對象：c = 合法對象；X = 每個對象的座位特徵；hc = 真人的對象是紅（真相）。 */
export interface LakeRec extends Base { t: 'L'; h: number; d: number; k: number; c: number[]; X: number[][]; hc: 0 | 1 }
/** 湖中宣告：1 = 宣告紅；d／k 為 −1 = 引擎不宣告。te = 對象真的是紅；ally = 對象是看得到的隊友。 */
export interface ClaimRec extends Base { t: 'C'; h: 0 | 1; d: number; k: number; x: number[]; te: 0 | 1; ally: 0 | 1; tg: number }
/** 刺殺：c = 候選；m = 梅林的座位。 */
export interface AssassinRec extends Base { t: 'A'; h: number; d: number; k: number; c: number[]; X: number[][]; m: number }

export type FidRecord = TeamRec | VoteRec | QuestRec | LakeRec | ClaimRec | AssassinRec;

// ── 評估 ───────────────────────────────────────────────────


/** v2 對一個決策點的預測（派隊、湖中對象回前三名）。 */
export interface Predictor {
  team(r: TeamRec): number[][];
  vote(r: VoteRec): 0 | 1;
  quest(r: QuestRec): 0 | 1;
  lakeTarget(r: LakeRec): number[];
  lakeClaim(r: ClaimRec): number;
  assassinate(r: AssassinRec): number;
}

export interface EvalInput {
  records: readonly FidRecord[];
  meta: ReadonlyMap<number, FidMeta>;
  roleOf: (j: number) => string;
  isTest: (j: number) => boolean;
  v2: Predictor;
}

export type Col = 'D' | 'K' | 'V2';
export const COLS: readonly Col[] = ['D', 'K', 'V2'];
/** 一致的個數（n 個決策點裡）。 */
export interface Rate { n: number; D: number; K: number; V2: number }
export interface Prf { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null }
export interface Count { n: number; hit: number }
export interface RateCmp { n: number; human: number; D: number; K: number; V2: number }

export interface PlayerEval {
  overall: Rate;
  quest: Rate & { byRound: Record<string, Rate>; bySeen: Record<string, Rate>; byFails: Record<string, Rate> };
  team: { top1: Rate; top3V2: number; byRound: Record<string, Rate> };
  vote: Rate & {
    abnormal: Record<'red' | 'blue', { humanAbn: number; spots: number } & Record<Col, Prf>>;
    byKind: Record<string, Rate>;
  };
  lakeTarget: Rate & { top3V2: number; bySide: Record<string, Rate> };
  lakeClaim: Rate;
  assassin: Rate;
  percival: { games: number; round: Rate; game: Rate; switched: Rate; humanTrustsMerlin: Count };
  merlin: { metrics: Record<string, RateCmp>; agree: Record<string, Rate>; assassinHitOnHim: Count };
}

const emptyRate = (): Rate => ({ n: 0, D: 0, K: 0, V2: 0 });
const addRate = (r: Rate, d: boolean, k: boolean, v: boolean): void => { r.n++; r.D += d ? 1 : 0; r.K += k ? 1 : 0; r.V2 += v ? 1 : 0; };
const bucket = (m: Record<string, Rate>, key: string): Rate => (m[key] ??= emptyRate());
const eqSeats = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
const SI = (name: typeof SEAT_FEATURES[number]): number => SEAT_FEATURES.indexOf(name);
const VI = (name: typeof VOTE_FEATURES[number]): number => VOTE_FEATURES.indexOf(name);
const sideOf = (role: string): 'good' | 'evil' => (['merlin', 'percival', 'loyal'].includes(role) ? 'good' : 'evil');

/** 異常票（內黑 = 在隊上投反對；外白 = 不在隊上投贊成；隊長算在隊上）。 */
export function abnormalKind(onTeam: boolean, leader: boolean, approve: boolean): '內黑' | '外白' | null {
  const on = onTeam || leader;
  if (on && !approve) return '內黑';
  if (!on && approve) return '外白';
  return null;
}

/** 派西的信任：一個決策對「兩根拇指裡，a 是梅林」的證據（+ = 信 a）。 */
export function trustEvidence(kind: 'T' | 'V', team: readonly number[], thumbs: readonly number[], approve?: boolean): number {
  if (thumbs.length !== 2) return 0;
  const [a, b] = thumbs;
  const ina = team.includes(a) ? 1 : 0;
  const inb = team.includes(b) ? 1 : 0;
  if (kind === 'T') return ina - inb;
  if (ina === inb) return 0;
  return (ina ? 1 : -1) * (approve ? 1 : -1) * 0.5;
}

/** 每一局結束時（第 1..5 局）的信任：+1 信 a、−1 信 b、0 還看不出來。 */
export function trustPath(events: ReadonlyArray<{ round: number; e: number }>, rounds = 5): number[] {
  const out: number[] = [];
  let cum = 0;
  for (let r = 1; r <= rounds; r++) {
    for (const ev of events) if (ev.round === r) cum += ev.e;
    out.push(Math.sign(cum));
  }
  return out;
}

/** 信任有沒有換過（非 0 的信任變號），第一次換在第幾局（0 = 沒換）。 */
export function firstSwitch(path: readonly number[]): number {
  let last = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === 0) continue;
    if (last !== 0 && path[i] !== last) return i + 1;
    last = path[i];
  }
  return 0;
}

export function evaluatePlayer(inp: EvalInput): PlayerEval {
  const { records, meta, roleOf, isTest, v2 } = inp;
  const ev: PlayerEval = {
    overall: emptyRate(),
    quest: { ...emptyRate(), byRound: {}, bySeen: {}, byFails: {} },
    team: { top1: emptyRate(), top3V2: 0, byRound: {} },
    vote: {
      ...emptyRate(),
      abnormal: {
        red: { humanAbn: 0, spots: 0, D: prf([]), K: prf([]), V2: prf([]) },
        blue: { humanAbn: 0, spots: 0, D: prf([]), K: prf([]), V2: prf([]) },
      },
      byKind: {},
    },
    lakeTarget: { ...emptyRate(), top3V2: 0, bySide: {} },
    lakeClaim: emptyRate(),
    assassin: emptyRate(),
    percival: { games: 0, round: emptyRate(), game: emptyRate(), switched: emptyRate(), humanTrustsMerlin: { n: 0, hit: 0 } },
    merlin: { metrics: {}, agree: {}, assassinHitOnHim: { n: 0, hit: 0 } },
  };


  const abnPairs: Record<'red' | 'blue', Record<Col, Array<readonly [boolean, boolean]>>> = {
    red: { D: [], K: [], V2: [] }, blue: { D: [], K: [], V2: [] },
  };
  // 派西信任與梅林區塊：每個座位的決策（測試部分）。
  const percEvents = new Map<number, Record<'H' | Col, Array<{ round: number; e: number }>>>();
  const merlinCmp = (key: string, h: boolean, d: boolean, k: boolean, v: boolean): void => {
    const m = (ev.merlin.metrics[key] ??= { n: 0, human: 0, D: 0, K: 0, V2: 0 });
    m.n++; m.human += h ? 1 : 0; m.D += d ? 1 : 0; m.K += k ? 1 : 0; m.V2 += v ? 1 : 0;
    addRate((ev.merlin.agree[key] ??= emptyRate()), d === h, k === h, v === h);
  };

  for (const r of records) {
    if (!isTest(r.j)) continue;
    const role = roleOf(r.j);
    const side = sideOf(role);
    switch (r.t) {
      case 'T': {
        const top = v2.team(r);
        const v = top[0] ?? r.k;
        const d = eqSeats(r.d, r.h); const k = eqSeats(r.k, r.h); const vv = eqSeats(v, r.h);
        addRate(ev.team.top1, d, k, vv);
        addRate(ev.overall, d, k, vv);
        addRate(bucket(ev.team.byRound, r.r === 1 ? `R1A${Math.min(r.a, 5)}` : `R${r.r}`), d, k, vv);
        if (top.some((t) => eqSeats(t, r.h))) ev.team.top3V2++;
        if (role === 'merlin') {
          const self = r.S.findIndex((row) => row[SI('self')] === 1) + 1;
          const vis = (t: readonly number[]): boolean => t.some((s) => r.S[s - 1][SI('knownRed')] === 1);
          const rb = r.a >= 5 ? 'forced' : r.r <= 2 ? `R${r.r}` : 'R3+';
          merlinCmp(`proposal self-in ${rb}`, r.h.includes(self), r.d.includes(self), r.k.includes(self), v.includes(self));
          merlinCmp(`proposal visible-red ${rb}`, vis(r.h), vis(r.d), vis(r.k), vis(v));
        }
        if (role === 'percival') {
          const m = meta.get(r.j);
          if (m && m.thumbs.length === 2) {
            const e = percEvents.get(r.j) ?? { H: [], D: [], K: [], V2: [] };
            e.H.push({ round: r.r, e: trustEvidence('T', r.h, m.thumbs) });
            e.D.push({ round: r.r, e: trustEvidence('T', r.d, m.thumbs) });
            e.K.push({ round: r.r, e: trustEvidence('T', r.k, m.thumbs) });
            e.V2.push({ round: r.r, e: trustEvidence('T', v, m.thumbs) });
            percEvents.set(r.j, e);
          }
        }
        break;
      }
      case 'V': {
        const v = v2.vote(r);
        addRate(ev.vote, r.d === r.h, r.k === r.h, v === r.h);
        addRate(ev.overall, r.d === r.h, r.k === r.h, v === r.h);
        const hk = abnormalKind(r.on === 1, r.ld === 1, r.h === 1);
        const kinds: Record<Col, ReturnType<typeof abnormalKind>> = {
          D: abnormalKind(r.on === 1, r.ld === 1, r.d === 1), K: abnormalKind(r.on === 1, r.ld === 1, r.k === 1), V2: abnormalKind(r.on === 1, r.ld === 1, v === 1),
        };
        const sideKey = side === 'evil' ? 'red' : 'blue';
        ev.vote.abnormal[sideKey].spots++;
        if (hk) ev.vote.abnormal[sideKey].humanAbn++;
        for (const c of COLS) abnPairs[sideKey][c].push([kinds[c] !== null, hk !== null]);
        const on = r.on === 1 || r.ld === 1;
        const kindKey = `${sideKey} ${on ? '在隊上' : '不在隊上'}${hk ? `（真人${hk}）` : '（真人正常票）'}`;
        addRate(bucket(ev.vote.byKind, kindKey), r.d === r.h, r.k === r.h, v === r.h);
        if (role === 'merlin') {
          const dirty = r.x[VI('teamKnownRed')] > 0;
          const key = `vote ${on ? '在隊上' : '不在隊上'} ${dirty ? '隊上有看得到的紅' : '隊上沒有看得到的紅'} 贊成`;
          merlinCmp(key, r.h === 1, r.d === 1, r.k === 1, v === 1);
        }
        if (role === 'percival') {
          const m = meta.get(r.j);
          if (m && m.thumbs.length === 2) {
            const e = percEvents.get(r.j) ?? { H: [], D: [], K: [], V2: [] };
            e.H.push({ round: r.r, e: trustEvidence('V', r.team, m.thumbs, r.h === 1) });
            e.D.push({ round: r.r, e: trustEvidence('V', r.team, m.thumbs, r.d === 1) });
            e.K.push({ round: r.r, e: trustEvidence('V', r.team, m.thumbs, r.k === 1) });
            e.V2.push({ round: r.r, e: trustEvidence('V', r.team, m.thumbs, v === 1) });
            percEvents.set(r.j, e);
          }
        }
        break;
      }
      case 'Q': {
        const v = v2.quest(r);
        addRate(ev.quest, r.d === r.h, r.k === r.h, v === r.h);
        addRate(ev.overall, r.d === r.h, r.k === r.h, v === r.h);
        addRate(bucket(ev.quest.byRound, `R${r.r}`), r.d === r.h, r.k === r.h, v === r.h);
        addRate(bucket(ev.quest.bySeen, `隊友 ${Math.min(2, r.seen)}${r.seen >= 2 ? '+' : ''}`), r.d === r.h, r.k === r.h, v === r.h);
        addRate(bucket(ev.quest.byFails, `紅已 ${r.rf} 勝`), r.d === r.h, r.k === r.h, v === r.h);
        break;
      }
      case 'L': {
        const top = v2.lakeTarget(r);
        const v = top[0] ?? r.k;
        addRate(ev.lakeTarget, r.d === r.h, r.k === r.h, v === r.h);
        addRate(ev.overall, r.d === r.h, r.k === r.h, v === r.h);
        addRate(bucket(ev.lakeTarget.bySide, side), r.d === r.h, r.k === r.h, v === r.h);
        if (top.includes(r.h)) ev.lakeTarget.top3V2++;
        if (role === 'merlin') {
          const vis = (s: number): boolean => r.X[r.c.indexOf(s)]?.[SI('knownRed')] === 1;
          merlinCmp('lake target visible-red', vis(r.h), vis(r.d), vis(r.k), vis(v));
        }
        break;
      }
      case 'C': {
        const v = v2.lakeClaim(r);
        if (side === 'evil') {
          addRate(ev.lakeClaim, r.d === r.h, r.k === r.h, v === r.h);
          addRate(ev.overall, r.d === r.h, r.k === r.h, v === r.h);
        }
        if (role === 'merlin') merlinCmp('lake claim lie', r.h !== r.te, r.d !== r.te && r.d !== -1, r.k !== r.te && r.k !== -1, v !== r.te && v !== -1);
        break;
      }
      case 'A': {
        const v = v2.assassinate(r);
        addRate(ev.assassin, r.d === r.h, r.k === r.h, v === r.h);
        break;
      }
    }
  }
  for (const side of ['red', 'blue'] as const) for (const c of COLS) ev.vote.abnormal[side][c] = prf(abnPairs[side][c]);

  // 派西信任（每局、每一局結束時）。
  for (const [j, e] of percEvents) {
    const m = meta.get(j)!;
    ev.percival.games++;
    const H = trustPath(e.H);
    const paths: Record<Col, number[]> = { D: trustPath(e.D), K: trustPath(e.K), V2: trustPath(e.V2) };
    for (let i = 0; i < 5; i++) {
      if (H[i] === 0) continue;
      addRate(ev.percival.round, paths.D[i] === H[i], paths.K[i] === H[i], paths.V2[i] === H[i]);
    }
    const last = (p: number[]): number => [...p].reverse().find((x) => x !== 0) ?? 0;
    if (last(H) !== 0) {
      addRate(ev.percival.game, last(paths.D) === last(H), last(paths.K) === last(H), last(paths.V2) === last(H));
      ev.percival.humanTrustsMerlin.n++;
      if ((last(H) > 0 ? m.thumbs[0] : m.thumbs[1]) === m.merlin) ev.percival.humanTrustsMerlin.hit++;
    }
    const hs = firstSwitch(H) > 0;
    addRate(ev.percival.switched, (firstSwitch(paths.D) > 0) === hs, (firstSwitch(paths.K) > 0) === hs, (firstSwitch(paths.V2) > 0) === hs);
  }
  // 梅林被刺中（真人局；這位玩家當梅林、有走到刺殺的局）。
  for (const [j, m] of meta) {
    if (m.role !== 'merlin' || m.killed === 0) continue;
    if (!records.some((r) => r.j === j)) continue;
    ev.merlin.assassinHitOnHim.n++;
    if (m.killed === m.merlin) ev.merlin.assassinHitOnHim.hit++;
  }
  return ev;
}

// ── 報表 ───────────────────────────────────────────────────

const pct = (x: number, n: number): string => (n ? `${((100 * x) / n).toFixed(1)}%` : '—');
const f1s = (p: Prf): string => (p.f1 === null ? '—' : p.f1.toFixed(2));

function rateRow(label: string, r: Rate, extra = ''): string {
  return `| ${label} | ${r.n} | ${pct(r.D, r.n)} | ${pct(r.K, r.n)} | ${pct(r.V2, r.n)} | ${extra} |`;
}

/** 一位玩家的各動作表（Markdown；私人報表、早報用）。 */
export function formatPlayerTable(name: string, e: PlayerEval, splitLabel: string): string {
  const out: string[] = [];
  out.push(`#### ${name}（${splitLabel}）`, '', '| 動作 | 測試決策點 | 百科AI | v1 | v2 | v2 前三名／附註 |', '|---|---|---|---|---|---|');
  out.push(rateRow('全部（各動作合計）', e.overall));
  out.push(rateRow('1 任務牌（紅方，可確定的）', e.quest, ''));
  for (const [k, r] of Object.entries(e.quest.byRound).sort()) out.push(rateRow(`└ 任務牌 ${k}`, r));
  for (const [k, r] of Object.entries(e.quest.bySeen).sort()) out.push(rateRow(`└ 任務牌 ${k}`, r));
  for (const [k, r] of Object.entries(e.quest.byFails).sort()) out.push(rateRow(`└ 任務牌 ${k}`, r));
  out.push(rateRow('2 派隊（完全一樣才算）', e.team.top1, `前三名命中 ${pct(e.team.top3V2, e.team.top1.n)}`));
  for (const [k, r] of Object.entries(e.team.byRound).sort()) out.push(rateRow(`└ 派隊 ${k}`, r));
  out.push(rateRow('3 投票（全部）', e.vote, ''));
  for (const side of ['red', 'blue'] as const) {
    const a = e.vote.abnormal[side];
    out.push(`| └ 異常票 F1（${side === 'red' ? '紅方' : '藍方'}；真人異常 ${a.humanAbn}／${a.spots}） | ${a.spots} | ${f1s(a.D)} | ${f1s(a.K)} | ${f1s(a.V2)} | v2 準確率 ${a.V2.precision?.toFixed(2) ?? '—'}、召回 ${a.V2.recall?.toFixed(2) ?? '—'} |`);
  }
  for (const [k, r] of Object.entries(e.vote.byKind).sort()) out.push(rateRow(`└ 投票 ${k}`, r));
  out.push(rateRow('4 湖中對象', e.lakeTarget, `前三名命中 ${pct(e.lakeTarget.top3V2, e.lakeTarget.n)}`));
  out.push(rateRow('└ 湖中宣告（紅方）', e.lakeClaim, ''));
  out.push(rateRow('5 刺殺（弱訊號，不當主數字）', e.assassin));
  out.push(rateRow(`6 派西信任：每局結束時信同一根拇指（${e.percival.games} 局）`, e.percival.round));
  out.push(rateRow('└ 派西信任：整場最後信的那根', e.percival.game, `真人最後信對梅林 ${pct(e.percival.humanTrustsMerlin.hit, e.percival.humanTrustsMerlin.n)}`));
  out.push(rateRow('└ 派西信任：有沒有換過', e.percival.switched));
  out.push('', '梅林區塊（同樣的決策點，比率：真人／百科AI／v1／v2）', '', '| 項目 | 決策點 | 真人 | 百科AI | v1 | v2 | v2 逐點一致 |', '|---|---|---|---|---|---|---|');
  for (const [k, m] of Object.entries(e.merlin.metrics).sort()) {
    const ag = e.merlin.agree[k];
    out.push(`| ${k} | ${m.n} | ${pct(m.human, m.n)} | ${pct(m.D, m.n)} | ${pct(m.K, m.n)} | ${pct(m.V2, m.n)} | ${pct(ag.V2, ag.n)} |`);
  }
  out.push(`| 梅林被刺中（真人局） | ${e.merlin.assassinHitOnHim.n} | ${pct(e.merlin.assassinHitOnHim.hit, e.merlin.assassinHitOnHim.n)} | | | | |`);
  return out.join('\n');
}

export function formatPrivateTable(players: ReadonlyArray<{ id: string }>, results: Record<string, Record<string, PlayerEval>>): string {
  const out: string[] = ['# AI騎士 精準度 v2（私人：含玩家 ID 與真人比率）', ''];
  for (const p of players) {
    const r = results[p.id];
    if (!r) continue;
    out.push(`## ${p.id}`, '');
    if (r.time) out.push(formatPlayerTable(p.id, r.time, '時間切分：舊 70% 擬合、新 30% 測試'), '');
    if (r.half) out.push(formatPlayerTable(p.id, r.half, '隨機一半'), '');
  }
  return `${out.join('\n')}\n`;
}

const frac = (x: number, n: number): number | null => (n ? Math.round((1000 * x) / n) / 1000 : null);
const rateOut = (r: Rate): { n: number; D: number | null; K: number | null; V2: number | null } => ({ n: r.n, D: frac(r.D, r.n), K: frac(r.K, r.n), V2: frac(r.V2, r.n) });

function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 公開彙總：只有一致度（不含真人自己的比率），每隻 AI騎士 一列，加上中位數。 */
export function publicSummary(players: ReadonlyArray<{ id: string; games: number }>, results: Record<string, Record<string, PlayerEval>>, lambda: Record<string, number>): unknown {
  const knights: unknown[] = [];
  const med: Record<string, Record<string, number[]>> = {};
  const push = (split: string, key: string, v: number | null): void => {
    if (v === null) return;
    ((med[split] ??= {})[key] ??= []).push(v);
  };
  for (const p of players) {
    const r = results[p.id];
    if (!r) continue;
    const row: Record<string, unknown> = { knight: `AI騎士_${p.id}` };
    for (const split of ['time', 'half'] as const) {
      const e = r[split];
      if (!e) continue;
      const mGap = (c: Col): number | null => {
        const ms = Object.values(e.merlin.metrics).filter((m) => m.n >= 5);
        return ms.length ? Math.round((1000 * ms.reduce((s, m) => s + Math.abs(m[c] - m.human) / m.n, 0)) / ms.length) / 1000 : null;
      };
      const out = {
        overall: rateOut(e.overall),
        quest: rateOut(e.quest),
        teamTop1: { ...rateOut(e.team.top1), top3V2: frac(e.team.top3V2, e.team.top1.n) },
        vote: rateOut(e.vote),
        abnormalF1: Object.fromEntries((['red', 'blue'] as const).map((s) => [s, Object.fromEntries(COLS.map((c) => [c, e.vote.abnormal[s][c].f1 === null ? null : Math.round(e.vote.abnormal[s][c].f1! * 1000) / 1000]))])),
        lakeTarget: { ...rateOut(e.lakeTarget), top3V2: frac(e.lakeTarget.top3V2, e.lakeTarget.n) },
        lakeClaimRed: rateOut(e.lakeClaim),
        assassinWeak: rateOut(e.assassin),
        percivalTrustRound: rateOut(e.percival.round),
        percivalTrustGame: rateOut(e.percival.game),
        merlinRateGap: { D: mGap('D'), K: mGap('K'), V2: mGap('V2') },
      };
      row[split] = out;
      for (const c of COLS) {
        push(split, `overall.${c}`, out.overall[c] as number | null);
        push(split, `quest.${c}`, out.quest[c] as number | null);
        push(split, `teamTop1.${c}`, out.teamTop1[c] as number | null);
        push(split, `vote.${c}`, out.vote[c] as number | null);
        push(split, `lakeTarget.${c}`, out.lakeTarget[c] as number | null);
        push(split, `lakeClaimRed.${c}`, out.lakeClaimRed[c] as number | null);
        push(split, `abnormalF1.red.${c}`, out.abnormalF1.red[c]);
        push(split, `abnormalF1.blue.${c}`, out.abnormalF1.blue[c]);
        push(split, `percivalTrustRound.${c}`, out.percivalTrustRound[c] as number | null);
        push(split, `merlinRateGap.${c}`, out.merlinRateGap[c]);
      }
      push(split, 'teamTop3.V2', out.teamTop1.top3V2);
      push(split, 'lakeTop3.V2', out.lakeTarget.top3V2);
    }
    knights.push(row);
  }
  const medians = Object.fromEntries(Object.entries(med).map(([s, m]) => [s, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, median(v)]))]));
  return {
    generatedAt: new Date().toISOString(),
    method: '真人局重播；每個決策點百科AI（D）、v1 AI騎士（K）、v2（K ＋ 每人殘差層）各自和真人比。時間切分 = 每位玩家較舊 70% 擬合、較新 30% 測試；隨機一半同 v1。每個決策點都當成不同的局面；紀錄裡沒有完全相同的局面，所以不報天花板（要量真的天花板，見「重玩測驗」提案）。',
    lambda,
    medians,
    knights,
  };
}
