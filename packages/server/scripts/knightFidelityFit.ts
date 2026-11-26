/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI騎士 精準度 v2，第 2 步：擬合每人殘差層、各動作的一致度、寫進 profile。
 *
 *   cd packages/server && npx tsx scripts/knightFidelityFit.ts --in DIR/extract.json --out DIR [--only 玩家ID]
 *        [--summary ../../docs/ai/gap/knight_fidelity.json] [--write-knights]
 *
 * 做法：
 *   1. 兩種切分各做一次：隨機一半（同 v1：局號雜湊）、時間（每位玩家較舊 70% 擬合、較新 30% 測試）。
 *   2. 每一種決策（派隊、投票、任務牌、湖中對象、湖中宣告、刺殺），每個角色群組：先用所有入選玩家的擬合部分擬合「全體」權重
 *      （收縮到 0），再擬合每位玩家自己的權重（收縮到全體；λ 用擬合部分內再對半切選）。刺殺是弱訊號：λ 乘 5。
 *   3. 測試部分：百科AI（D）、v1 AI騎士（K）、v2（K ＋ 殘差層）各自和真人比，逐動作報。
 *   4. 天花板：玩家自己在「局面簽名」相同的地方做同樣選擇的比例（`selfConsistency`，留一）。
 *   5. `--write-knights`：用全部資料重新擬合，權重寫進 `community-bots/_knights/<id>/profile.json`（schema 2 的 `residual`）。
 *
 * 私人輸出（DIR，含玩家 ID 與真人的比率）：fidelity.json、fidelity.md。公開彙總（--summary）：只有一致度。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CLAIM_FEATURES, QUEST_FEATURES, RESIDUAL_VERSION, SEAT_FEATURES, TEAM_FEATURES, TEAM_GROUPS, VOTE_FEATURES, VOTE_GROUPS,
  dot, rankTeamsFrom, sigmoid, teamCandidatesFrom, teamGroupOf, topK,
  type ResidualWeights, type TeamGroup, type VoteGroup, type Weights,
} from '../src/arena/residual';
import { fitChoice, fitLogistic, toWeights, type ChoiceRow, type LogisticRow } from '../src/arena/residualFit';
import {
  evaluatePlayer, type EvalInput, type PlayerEval, type Predictor,
  type FidJob, type FidMeta, type FidRecord, type TeamRec, type VoteRec, type QuestRec, type LakeRec, type ClaimRec, type AssassinRec,
} from '../src/arena/fidelityMetrics';
import { validateProfile, type BotProfile } from '../src/arena/profile';
import { formatKnightProfile, knightFolderId } from '../src/arena/styleKnights';
import { isInside } from '../src/ai/benchmark/playerAgreement';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..', '..');
const KNIGHTS_DIR = path.join(REPO, 'community-bots', '_knights');

interface Args { inFile?: string; out?: string; only: string[]; summary?: string; writeKnights: boolean; popCap: number }

function parseArgs(argv: string[]): Args {
  const a: Args = { only: [], writeKnights: false, popCap: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--in': a.inFile = path.resolve(next()); break;
      case '--out': a.out = path.resolve(next()); break;
      case '--only': a.only.push(next()); break;
      case '--summary': a.summary = path.resolve(next()); break;
      case '--write-knights': a.writeKnights = true; break;
      case '--pop-cap': a.popCap = Number.parseInt(next(), 10); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

interface Extract { players: Array<{ id: string; games: number; strong: boolean; v1: boolean }>; jobs: FidJob[]; records: Array<FidRecord | FidMeta> }

const LAMBDAS = [2, 8, 32];
const SIDE_OF = (role: string): 'good' | 'evil' => (['merlin', 'percival', 'loyal'].includes(role) ? 'good' : 'evil');

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// ── 決策點 → 擬合用的列 ─────────────────────────────────────

const seatIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const ids2 = (seats: readonly number[]): string[] => seats.map((s) => `s${s}`);

function teamRow(r: TeamRec): { row: ChoiceRow; teams: string[][] } {
  const ids = seatIds(r.S.length);
  const c = teamCandidatesFrom(ids, r.S, r.sz, ids2(r.k), ids2(r.pp), ids2(r.lm));
  const key = ids2(r.h).join(',');
  const y = c.teams.findIndex((t) => t.join(',') === key);
  return { row: { X: c.X, y }, teams: c.teams };
}

function pickRow(r: LakeRec | AssassinRec): ChoiceRow {
  return { X: r.X, y: r.c.indexOf(r.h) };
}

type Kind = 'team' | 'vote' | 'quest' | 'lakeTarget' | 'lakeClaim' | 'assassinate';
const KIND_NAMES: Record<Kind, readonly string[]> = {
  team: TEAM_FEATURES, vote: VOTE_FEATURES, quest: QUEST_FEATURES, lakeTarget: SEAT_FEATURES, lakeClaim: CLAIM_FEATURES, assassinate: SEAT_FEATURES,
};

/** 一筆決策點屬於哪一種、哪一組（湖中宣告只學紅方）。 */
function kindGroup(r: FidRecord, role: string): [Kind, string] | null {
  const side = SIDE_OF(role);
  switch (r.t) {
    case 'T': return ['team', teamGroupOf(role, side)];
    case 'V': return ['vote', `${teamGroupOf(role, side)}_${r.on ? 'on' : 'off'}`];
    case 'Q': return r.rf >= 2 ? null : ['quest', 'all'];
    case 'L': return ['lakeTarget', side];
    case 'C': return side === 'evil' ? ['lakeClaim', 'all'] : null;
    case 'A': return ['assassinate', 'all'];
  }
}

interface Sample { r: FidRecord; player: number; gid: string; logistic?: LogisticRow; choice?: ChoiceRow }

function toSample(r: FidRecord, player: number, gid: string): Sample | null {
  switch (r.t) {
    case 'T': { const { row } = teamRow(r); return row.y < 0 ? null : { r, player, gid, choice: row }; }
    case 'L': case 'A': { const row = pickRow(r); return row.y < 0 ? null : { r, player, gid, choice: row }; }
    default: return { r, player, gid, logistic: { x: (r as VoteRec | QuestRec | ClaimRec).x, y: (r as VoteRec | QuestRec | ClaimRec).h } };
  }
}

function fitKind(kind: Kind, samples: readonly Sample[], prior: readonly number[], lambda: number): number[] {
  if (samples.length === 0) return [...prior];
  if (kind === 'vote' || kind === 'quest' || kind === 'lakeClaim') return fitLogistic(samples.map((s) => s.logistic!), prior, lambda);
  return fitChoice(samples.map((s) => s.choice!), prior, lambda);
}

/** 一個決策點用權重的預測是否和真人一樣（λ 選擇用）。 */
function hitWith(kind: Kind, s: Sample, beta: readonly number[]): number {
  if (s.logistic) {
    let z = 0;
    for (let i = 0; i < beta.length; i++) z += beta[i] * s.logistic.x[i];
    return (z >= 0 ? 1 : 0) === s.logistic.y ? 1 : 0;
  }
  const z = s.choice!.X.map((x) => { let v = 0; for (let i = 0; i < beta.length; i++) v += beta[i] * x[i]; return v; });
  return topK(z, 1)[0] === s.choice!.y ? 1 : 0;
}

function subsample<T>(xs: readonly T[], cap: number, salt: string): T[] {
  if (xs.length <= cap) return [...xs];
  const keyed = xs.map((x, i) => [fnv1a(`${salt}|${i}`), x] as const).sort((a, b) => a[0] - b[0]);
  return keyed.slice(0, cap).map(([, x]) => x);
}

interface Model { pop: Map<string, number[]>; per: Map<number, Map<string, number[]>>; lambda: Record<Kind, number> }

/**
 * 擬合：全體（每組，收縮到 0，λ = 1）→ 每位玩家（收縮到全體）。
 * `chooseLambda`：在 `samples` 內再依局號對半切，挑每一種決策的 λ（全部玩家一起算命中數）。
 */
function fitModel(samples: readonly Sample[], players: readonly number[], roleOf: (j: number) => string, popCap: number, chooseLambda: boolean, fixed?: Record<Kind, number>): Model {
  const byKG = new Map<string, Sample[]>();
  for (const s of samples) {
    const kg = kindGroup(s.r, roleOf(s.r.j));
    if (!kg) continue;
    const key = `${kg[0]}|${kg[1]}`;
    let list = byKG.get(key);
    if (!list) { list = []; byKG.set(key, list); }
    list.push(s);
  }
  const fitPop = (subset: Map<string, Sample[]>): Map<string, number[]> => {
    const pop = new Map<string, number[]>();
    for (const [key, list] of subset) {
      const kind = key.split('|')[0] as Kind;
      const d = KIND_NAMES[kind].length;
      pop.set(key, fitKind(kind, subsample(list, popCap, key), new Array<number>(d).fill(0), 1));
    }
    return pop;
  };
  const fitPer = (subset: Map<string, Sample[]>, pop: Map<string, number[]>, lambda: Record<Kind, number>): Map<number, Map<string, number[]>> => {
    const per = new Map<number, Map<string, number[]>>();
    for (const p of players) per.set(p, new Map());
    for (const [key, list] of subset) {
      const kind = key.split('|')[0] as Kind;
      const lam = lambda[kind] * (kind === 'assassinate' ? 5 : 1);
      const mine = new Map<number, Sample[]>();
      for (const s of list) { const m = mine.get(s.player); if (m) m.push(s); else mine.set(s.player, [s]); }
      for (const p of players) {
        const own = mine.get(p) ?? [];
        per.get(p)!.set(key, own.length ? fitKind(kind, own, pop.get(key)!, lam) : [...pop.get(key)!]);
      }
    }
    return per;
  };

  let lambda: Record<Kind, number> = fixed ?? { team: 8, vote: 8, quest: 8, lakeTarget: 8, lakeClaim: 8, assassinate: 8 };
  if (chooseLambda) {
    const inner = (s: Sample): 0 | 1 => (fnv1a(`lambda|${s.gid}`) & 1) as 0 | 1;
    const train = new Map<string, Sample[]>();
    const test = new Map<string, Sample[]>();
    for (const [key, list] of byKG) { train.set(key, list.filter((s) => inner(s) === 0)); test.set(key, list.filter((s) => inner(s) === 1)); }
    const pop = fitPop(train);
    const hits: Record<string, number[]> = {};
    LAMBDAS.forEach((lam, li) => {
      const per = fitPer(train, pop, { team: lam, vote: lam, quest: lam, lakeTarget: lam, lakeClaim: lam, assassinate: lam });
      for (const [key, list] of test) {
        const kind = key.split('|')[0];
        hits[kind] ??= LAMBDAS.map(() => 0);
        for (const s of list) hits[kind][li] += hitWith(kind as Kind, s, per.get(s.player)!.get(key)!);
      }
    });
    lambda = { ...lambda };
    for (const [kind, h] of Object.entries(hits)) {
      let best = 0;
      h.forEach((v, i) => { if (v >= h[best]) best = i; }); // 同分取較大的 λ（比較保守）
      lambda[kind as Kind] = LAMBDAS[best];
    }
    console.error(`  λ: ${JSON.stringify(lambda)}  hits ${JSON.stringify(hits)}`);
  }
  const pop = fitPop(byKG);
  return { pop, per: fitPer(byKG, pop, lambda), lambda };
}

// ── 預測 ───────────────────────────────────────────────────

function predictorFor(model: Model, player: number, roleOf: (j: number) => string): Predictor {
  const w = (key: string): number[] | undefined => model.per.get(player)?.get(key) ?? model.pop.get(key);
  return {
    team(r: TeamRec): number[][] {
      const kg = kindGroup(r, roleOf(r.j))!;
      const beta = w(`${kg[0]}|${kg[1]}`);
      if (!beta) return [r.k];
      const ids = seatIds(r.S.length);
      const c = teamCandidatesFrom(ids, r.S, r.sz, ids2(r.k), ids2(r.pp), ids2(r.lm));
      return rankTeamsFrom(c, toWeightsRaw(TEAM_FEATURES, beta), 3).map((t) => t.team.map((id) => Number(id.slice(1))));
    },
    vote(r: VoteRec): 0 | 1 {
      const kg = kindGroup(r, roleOf(r.j))!;
      const beta = w(`${kg[0]}|${kg[1]}`);
      return beta ? (sigmoid(dot(toWeightsRaw(VOTE_FEATURES, beta), VOTE_FEATURES, r.x)) >= 0.5 ? 1 : 0) : r.k;
    },
    quest(r: QuestRec): 0 | 1 {
      if (r.rf >= 2) return r.k; // A1
      const beta = w('quest|all');
      return beta ? (sigmoid(dot(toWeightsRaw(QUEST_FEATURES, beta), QUEST_FEATURES, r.x)) >= 0.5 ? 1 : 0) : r.k;
    },
    lakeTarget(r: LakeRec): number[] {
      const beta = w(`lakeTarget|${SIDE_OF(roleOf(r.j))}`);
      if (!beta) return [r.k];
      const z = r.X.map((x) => dot(toWeightsRaw(SEAT_FEATURES, beta), SEAT_FEATURES, x));
      return topK(z, 3).map((i) => r.c[i]);
    },
    lakeClaim(r: ClaimRec): number {
      if (SIDE_OF(roleOf(r.j)) === 'good') return r.k; // A0
      const beta = w('lakeClaim|all');
      return beta ? (sigmoid(dot(toWeightsRaw(CLAIM_FEATURES, beta), CLAIM_FEATURES, r.x)) >= 0.5 ? 1 : 0) : r.k;
    },
    assassinate(r: AssassinRec): number {
      const beta = w('assassinate|all');
      if (!beta) return r.k;
      const z = r.X.map((x) => dot(toWeightsRaw(SEAT_FEATURES, beta), SEAT_FEATURES, x));
      return r.c[topK(z, 1)[0]];
    },
  };
}

function toWeightsRaw(names: readonly string[], beta: readonly number[]): Weights {
  const out: Weights = {};
  names.forEach((n, i) => { out[n] = beta[i]; });
  return out;
}

function residualOf(model: Model, player: number): ResidualWeights {
  const res: ResidualWeights = { version: RESIDUAL_VERSION };
  const get = (key: string): number[] | undefined => model.per.get(player)?.get(key) ?? model.pop.get(key);
  for (const g of TEAM_GROUPS) { const b = get(`team|${g}`); if (b) (res.team ??= {})[g as TeamGroup] = toWeights(TEAM_FEATURES, b); }
  for (const g of VOTE_GROUPS) { const b = get(`vote|${g}`); if (b) (res.vote ??= {})[g as VoteGroup] = toWeights(VOTE_FEATURES, b); }
  const q = get('quest|all'); if (q) res.quest = toWeights(QUEST_FEATURES, q);
  for (const s of ['good', 'evil'] as const) { const b = get(`lakeTarget|${s}`); if (b) (res.lakeTarget ??= {})[s] = toWeights(SEAT_FEATURES, b); }
  const c = get('lakeClaim|all'); if (c) res.lakeClaim = toWeights(CLAIM_FEATURES, c);
  const a = get('assassinate|all'); if (a) res.assassinate = toWeights(SEAT_FEATURES, a);
  return res;
}

// ── 主程式 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.inFile || !a.out) throw new Error('--in and --out are required');
  if (isInside(a.out, REPO)) throw new Error(`--out must be outside the repo (${REPO})`);
  fs.mkdirSync(a.out, { recursive: true });
  const ex = JSON.parse(fs.readFileSync(a.inFile, 'utf8')) as Extract;
  const meta = new Map<number, FidMeta>();
  const recs: FidRecord[] = [];
  for (const r of ex.records) { if (r.t === 'M') meta.set(r.j, r); else recs.push(r); }
  const roleOf = (j: number): string => meta.get(j)?.role ?? 'loyal';
  const only = new Set(a.only);
  const players = ex.players.map((_, i) => i).filter((i) => !only.size || only.has(ex.players[i].id));
  const samples: Sample[] = [];
  for (const r of recs) { const job = ex.jobs[r.j]; const s = toSample(r, job.p, job.g); if (s) samples.push(s); }
  console.error(`records ${recs.length}, samples ${samples.length}, players ${players.length}`);

  const results: Record<string, Record<string, PlayerEval>> = {};
  let lambda: Record<Kind, number> | undefined;
  for (const split of ['half', 'time'] as const) {
    const t0 = Date.now();
    const isTest = (j: number): boolean => ex.jobs[j][split] === 1;
    const model = fitModel(samples.filter((s) => !isTest(s.r.j)), ex.players.map((_, i) => i), roleOf, a.popCap, split === 'half', lambda);
    lambda ??= model.lambda;
    for (const p of players) {
      const input: EvalInput = {
        records: recs.filter((r) => ex.jobs[r.j].p === p),
        meta, roleOf, isTest, v2: predictorFor(model, p, roleOf),
      };
      (results[ex.players[p].id] ??= {})[split] = evaluatePlayer(input);
    }
    console.error(`split ${split}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  fs.writeFileSync(path.join(a.out, 'fidelity.json'), JSON.stringify({ lambda, players: ex.players, results }, null, 1));

  if (a.writeKnights) {
    const model = fitModel(samples, ex.players.map((_, i) => i), roleOf, a.popCap, false, lambda);
    let wrote = 0;
    for (const p of players) {
      const id = ex.players[p].id;
      const folder = knightFolderId(id, 1);
      const file = path.join(KNIGHTS_DIR, folder, 'profile.json');
      if (!fs.existsSync(file)) continue;
      const old = JSON.parse(fs.readFileSync(file, 'utf8')) as BotProfile;
      const prof: BotProfile = { ...old, schema: 2, residual: residualOf(model, p) };
      const v = validateProfile(prof, folder, { house: true });
      if (!v.ok) throw new Error(`${id}: ${v.errors.join('; ')}`);
      fs.writeFileSync(file, formatKnightProfile(v.profile!));
      wrote++;
    }
    console.error(`wrote residual weights into ${wrote} knights`);
  }
  if (a.summary) {
    const { publicSummary } = await import('../src/arena/fidelityMetrics');
    fs.writeFileSync(a.summary, `${JSON.stringify(publicSummary(ex.players, results, lambda!), null, 1)}\n`);
  }
  const { formatPrivateTable } = await import('../src/arena/fidelityMetrics');
  fs.writeFileSync(path.join(a.out, 'fidelity.md'), formatPrivateTable(ex.players, results));
  console.log(formatPrivateTable(ex.players.filter((p) => !only.size || only.has(p.id)), results));
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

