/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Captains who put a Merlin-visible red on their own team — human data for
 * the assassination tier of logic-first batch 1G (practice report (b),
 * `AgentTuning.assassinVisibleRedTier` / `assassinVisibleRedLikelihood`,
 * docs/ai/logic_first.md 第 9 節).
 *
 *   pnpm --filter @avalon/server exec tsx scripts/assassinVisibleRedStudy.ts [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the strict replay parser of the
 * agreement benchmark (`parseReplayGame`; 10-player games) and measures:
 *
 *   (a) every proposal led by a blue captain, by round and attempt (the
 *       forced 5th proposal apart), Merlin captains vs loyal / Percival
 *       captains: how often the team holds a Merlin-visible red (assassin,
 *       Morgana, Oberon; Mordred is not visible), and the same split by what
 *       the ASSASSIN can tell at the assassination — `certain` (the team holds
 *       the assassin or Oberon, or both of the assassin's teammates, one of
 *       whom must be Morgana), `ambiguous` (exactly one of the two teammates,
 *       nothing certain: Morgana or Mordred, the assassin cannot tell), `none`
 *       (no red the assassin could call visible). Each class gets the
 *       likelihood ratio P(class | Merlin captain) / P(class | other blue
 *       captain) with a 95% interval (log method);
 *   (b) at every logged assassination (three blue missions): which blue
 *       candidates ever certainly proposed a visible red on a non-forced
 *       proposal (from R2, and from R1), the share among Merlins and among the
 *       other blues, where the human assassin's target fell, and the human
 *       hit rate by tier;
 *   (c) the soft factor on top of the assassination model, at the same
 *       assassinations: Merlin hit (all, and on the model's own held-out 30%
 *       of games), agreement with the human target and the mean ln P(Merlin)
 *       for the model alone, the tier, the tier + the batch-1G factor, the
 *       tier + the measured ambiguous-lead LR in-sample and 2-fold
 *       cross-fitted (rates from the other half of the games), and the tier
 *       + the residual β·ln LR given the model's score (conditional logit with
 *       the score as offset, β fitted on the other half) — whether the factor
 *       adds anything the model's own leader features do not already carry.
 *
 * Every rate is printed with n and a Wilson 95% interval. Output is aggregate
 * only (no names, no game ids).
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, type ReplayGame, type ReplayProposal } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { scoreAssassinCandidates } from '../src/ai/assassin/AssassinModel';
import { tierCandidates, visibleRedEvidence } from '../src/ai/assassin/VisibleRedProposals';

interface Args { json?: string; cache: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { cache: path.resolve(__dirname, '..', 'sheets_cache.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--json': args.json = next(); break;
      case '--cache': args.cache = path.resolve(next()); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

interface Rate { k: number; n: number; p: number; lo: number; hi: number }

export function wilsonRate(k: number, n: number): Rate {
  if (n === 0) return { k, n, p: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

interface Ratio { lr: number; lo: number; hi: number }

/** Ratio of two proportions with the log (Katz) 95% interval; 0.5 added to empty cells. */
export function rateRatio(k1: number, n1: number, k2: number, n2: number): Ratio {
  if (n1 === 0 || n2 === 0) return { lr: Number.NaN, lo: Number.NaN, hi: Number.NaN };
  const a = k1 === 0 || k2 === 0 ? k1 + 0.5 : k1;
  const b = k1 === 0 || k2 === 0 ? k2 + 0.5 : k2;
  const m1 = k1 === 0 || k2 === 0 ? n1 + 0.5 : n1;
  const m2 = k1 === 0 || k2 === 0 ? n2 + 0.5 : n2;
  const lr = (a / m1) / (b / m2);
  const se = Math.sqrt(1 / a - 1 / m1 + 1 / b - 1 / m2);
  return { lr, lo: lr * Math.exp(-1.96 * se), hi: lr * Math.exp(1.96 * se) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const fmtRate = (r: Rate): string => (r.n === 0 ? '—' : `${pct(r.p)} [${pct(r.lo)}, ${pct(r.hi)}] (${r.k}/${r.n})`);
const fmtRatio = (r: Ratio): string => (Number.isNaN(r.lr) ? '—' : `${r.lr.toFixed(2)} [${r.lo.toFixed(2)}, ${r.hi.toFixed(2)}]`);

type Klass = 'certain' | 'ambiguous' | 'none';

interface Seats { assassin: number; morgana: number; mordred: number; oberon: number }

function redSeats(game: ReplayGame): Seats | null {
  const find = (r: string): number => game.seatRoles.indexOf(r as never) + 1;
  const s = { assassin: find('assassin'), morgana: find('morgana'), mordred: find('mordred'), oberon: find('oberon') };
  return Object.values(s).every((x) => x > 0) ? s : null;
}

/** Truth: the team holds a red Merlin sees (assassin, Morgana, Oberon). */
function truthVisible(team: readonly number[], s: Seats): boolean {
  return team.includes(s.assassin) || team.includes(s.morgana) || team.includes(s.oberon);
}

/** What the assassin can tell at the assassination (it knows every red, not which teammate is Mordred). */
function assassinClass(team: readonly number[], s: Seats): Klass {
  const mates = [s.morgana, s.mordred].filter((x) => team.includes(x)).length;
  if (team.includes(s.assassin) || team.includes(s.oberon) || mates >= 2) return 'certain';
  return mates === 1 ? 'ambiguous' : 'none';
}

type Group = 'merlin' | 'percival' | 'loyal';

interface Cell { n: number; visible: number; certain: number; ambiguous: number; none: number; ambSeen: number; ambUnseen: number }
const emptyCell = (): Cell => ({ n: 0, visible: 0, certain: 0, ambiguous: 0, none: 0, ambSeen: 0, ambUnseen: 0 });

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const games: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (r.ok) games.push(r.game);
  }

  // (a) proposals
  const cells = new Map<string, Cell>();
  const cell = (key: string): Cell => {
    let c = cells.get(key);
    if (!c) { c = emptyCell(); cells.set(key, c); }
    return c;
  };
  const add = (key: string, p: ReplayProposal, s: Seats): void => {
    const c = cell(key);
    c.n++;
    if (truthVisible(p.teamSeats, s)) c.visible++;
    const k = assassinClass(p.teamSeats, s);
    c[k]++;
    if (k === 'ambiguous') {
      if (p.teamSeats.includes(s.morgana)) c.ambSeen++; else c.ambUnseen++;
    }
  };
  let skipped = 0;
  for (const g of games) {
    const s = redSeats(g);
    if (!s) { skipped++; continue; }
    for (const p of g.proposals) {
      const role = g.seatRoles[p.leaderSeat - 1] as string;
      if (role !== 'merlin' && role !== 'percival' && role !== 'loyal') continue;
      const grp = role as Group;
      const kind = p.forced ? 'forced' : 'nonforced';
      for (const g2 of [grp, grp === 'merlin' ? 'merlin' : 'other']) {
        add(`${g2}|R${p.round}|${kind}`, p, s);
        if (p.round >= 2) add(`${g2}|R2+|${kind}`, p, s);
        add(`${g2}|all|${kind}`, p, s);
      }
    }
  }

  console.log(`replayable 10p games: ${games.length}${skipped ? ` (no standard red roster: ${skipped})` : ''}`);
  console.log('\n(a) Blue captains: team holds a Merlin-visible red (assassin / Morgana / Oberon), and the assassin-view class');
  const rounds = ['R1', 'R2', 'R3', 'R4', 'R5', 'R2+', 'all'];
  const lrTable: Record<string, Record<string, Ratio & { merlin: Rate; other: Rate }>> = {};
  const mixTable: Record<string, number> = {};
  const rateTable: Record<string, Record<string, { merlinSeen: number; merlinUnseen: number; otherSeen: number; otherUnseen: number }>> = {};
  for (const kind of ['nonforced', 'forced']) {
    console.log(`\n  ${kind === 'forced' ? 'forced 5th proposals' : 'non-forced proposals (attempts 1-4)'}`);
    for (const r of rounds) {
      const m = cells.get(`merlin|${r}|${kind}`) ?? emptyCell();
      const o = cells.get(`other|${r}|${kind}`) ?? emptyCell();
      const pe = cells.get(`percival|${r}|${kind}`) ?? emptyCell();
      const lo = cells.get(`loyal|${r}|${kind}`) ?? emptyCell();
      if (m.n + o.n === 0) continue;
      console.log(`  ${r.padEnd(4)} visible   Merlin ${fmtRate(wilsonRate(m.visible, m.n))}  loyal ${fmtRate(wilsonRate(lo.visible, lo.n))}  Percival ${fmtRate(wilsonRate(pe.visible, pe.n))}  LR(Merlin/other) ${fmtRatio(rateRatio(m.visible, m.n, o.visible, o.n))}`);
      for (const k of ['certain', 'ambiguous', 'none'] as const) {
        const ratio = rateRatio(m[k], m.n, o[k], o.n);
        console.log(`       ${k.padEnd(9)} Merlin ${fmtRate(wilsonRate(m[k], m.n))}  other ${fmtRate(wilsonRate(o[k], o.n))}  LR ${fmtRatio(ratio)}`);
        (lrTable[`${kind}|${k}`] ??= {})[r] = { ...ratio, merlin: wilsonRate(m[k], m.n), other: wilsonRate(o[k], o.n) };
      }
      (lrTable[`${kind}|visible`] ??= {})[r] = {
        ...rateRatio(m.visible, m.n, o.visible, o.n), merlin: wilsonRate(m.visible, m.n), other: wilsonRate(o.visible, o.n),
      };
      // The soft likelihood of an ambiguous lead (exactly one of the two
      // teammates on the team, nothing certain): the assassin cannot tell
      // whether it is Morgana (seen) or Mordred (unseen), so its likelihood
      // ratio is the ratio of the two MIXED RATES, p = 1/2 —
      //   (p·m_seen + (1−p)·m_unseen) / (p·o_seen + (1−p)·o_unseen)
      // which at p = 1/2 is exactly LR(ambiguous) above. (Batch 1G averaged
      // two whole-team ratios instead, 1/2 LR(visible) + 1/2 LR(not visible);
      // withdrawn 2026-10-26.)
      const rate = (k: number, n: number): number => (n === 0 ? 0 : k / n);
      const mS = rate(m.ambSeen, m.n), mU = rate(m.ambUnseen, m.n), oS = rate(o.ambSeen, o.n), oU = rate(o.ambUnseen, o.n);
      const mix = (0.5 * mS + 0.5 * mU) / (0.5 * oS + 0.5 * oU);
      mixTable[`${kind}|${r}`] = mix;
      (rateTable[kind] ??= {})[r] = { merlinSeen: mS, merlinUnseen: mU, otherSeen: oS, otherUnseen: oU };
      console.log(`       ambiguous split  Morgana-only Merlin ${fmtRate(wilsonRate(m.ambSeen, m.n))} other ${fmtRate(wilsonRate(o.ambSeen, o.n))}; Mordred-only Merlin ${fmtRate(wilsonRate(m.ambUnseen, m.n))} other ${fmtRate(wilsonRate(o.ambUnseen, o.n))}`);
      console.log(`       ambiguous-lead multiplier (p = 1/2) = (${mS.toFixed(4)} + ${mU.toFixed(4)}) / (${oS.toFixed(4)} + ${oU.toFixed(4)}) = ${mix.toFixed(3)}`);
    }
  }

  // (b) assassinations
  console.log('\n(b) At the assassination: candidates who ever CERTAINLY proposed a visible red (non-forced)');
  const tiers: Record<string, { merlinFlag: number; merlins: number; otherFlag: number; others: number; games: number;
    gamesMerlinFlagged: number; gamesSomeFlagged: number; gamesAllFlagged: number;
    pickFlagged: number; pickFlaggedWhileUnflagged: number; hitsFlaggedPick: number; hitsUnflaggedPick: number; picks: number; hits: number;
    hitsIfUnflaggedOnly: number } > = {};
  for (const fromRound of [2, 1]) {
    const t = {
      merlinFlag: 0, merlins: 0, otherFlag: 0, others: 0, games: 0, gamesMerlinFlagged: 0, gamesSomeFlagged: 0, gamesAllFlagged: 0,
      pickFlagged: 0, pickFlaggedWhileUnflagged: 0, hitsFlaggedPick: 0, hitsUnflaggedPick: 0, picks: 0, hits: 0, hitsIfUnflaggedOnly: 0,
    };
    for (const g of games) {
      const s = redSeats(g);
      if (!s || g.assassinTargetSeat === undefined) continue;
      t.games++;
      const blues = g.seatRoles.map((r, i) => ({ r: r as string, seat: i + 1 })).filter((x) => x.r === 'merlin' || x.r === 'percival' || x.r === 'loyal');
      const flagged = new Set<number>();
      for (const p of g.proposals) {
        if (p.forced || p.round < fromRound) continue;
        if (assassinClass(p.teamSeats, s) === 'certain') flagged.add(p.leaderSeat);
      }
      let merlinSeat = 0;
      for (const b of blues) {
        const f = flagged.has(b.seat);
        if (b.r === 'merlin') { merlinSeat = b.seat; t.merlins++; if (f) t.merlinFlag++; } else { t.others++; if (f) t.otherFlag++; }
      }
      const someFlag = blues.some((b) => flagged.has(b.seat));
      const someUnflag = blues.some((b) => !flagged.has(b.seat));
      if (flagged.has(merlinSeat)) t.gamesMerlinFlagged++;
      if (someFlag) t.gamesSomeFlagged++;
      if (!someUnflag) t.gamesAllFlagged++;
      const target = g.assassinTargetSeat;
      const hit = target === merlinSeat;
      t.picks++;
      if (hit) t.hits++;
      if (flagged.has(target)) {
        t.pickFlagged++;
        if (someUnflag) t.pickFlaggedWhileUnflagged++;
        if (hit) t.hitsFlaggedPick++;
      } else if (hit) t.hitsUnflaggedPick++;
      // Upper bound of a tiered human: a flagged pick moved to an unflagged seat hits only if Merlin is unflagged.
      if (!flagged.has(merlinSeat)) t.hitsIfUnflaggedOnly++;
    }
    tiers[`R${fromRound}+`] = t;
    console.log(`\n  proposals counted from R${fromRound}: ${t.games} assassinations`);
    console.log(`    Merlin flagged        ${fmtRate(wilsonRate(t.merlinFlag, t.merlins))}`);
    console.log(`    other blue flagged    ${fmtRate(wilsonRate(t.otherFlag, t.others))}   LR(flag) ${fmtRatio(rateRatio(t.merlinFlag, t.merlins, t.otherFlag, t.others))}`);
    console.log(`    games with ≥1 flagged ${fmtRate(wilsonRate(t.gamesSomeFlagged, t.games))}; every candidate flagged ${fmtRate(wilsonRate(t.gamesAllFlagged, t.games))}`);
    console.log(`    human target flagged  ${fmtRate(wilsonRate(t.pickFlagged, t.picks))}; while an unflagged candidate existed ${fmtRate(wilsonRate(t.pickFlaggedWhileUnflagged, t.picks))}`);
    console.log(`    human hit rate        all ${fmtRate(wilsonRate(t.hits, t.picks))}; target flagged ${fmtRate(wilsonRate(t.hitsFlaggedPick, t.pickFlagged))}; target unflagged ${fmtRate(wilsonRate(t.hitsUnflaggedPick, t.picks - t.pickFlagged))}`);
  }

  const softFactor = sectionC(games);

  if (args.json) {
    const out = {
      softFactor,
      generatedBy: 'packages/server/scripts/assassinVisibleRedStudy.ts',
      games: games.length,
      cells: Object.fromEntries(cells),
      lr: lrTable,
      ambiguousLeadMultiplier: mixTable,
      ambiguousLeadRates: rateTable,
      assassination: tiers,
    };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`\nwrote ${path.resolve(args.json)}`);
  }
}

// ── (c) the soft factor on top of the assassination model ─────────────

/** FNV-1a (the split hash of scripts/assassinModel.ts). */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type RateRow = { mS: number; mU: number; oS: number; oU: number };

/** Non-forced ambiguous-lead rates by round over `games` (the table of `AMBIGUOUS_LEAD_RATES`). */
function ambiguousRates(games: readonly ReplayGame[]): Map<number, RateRow> {
  const c = new Map<number, { m: number; mS: number; mU: number; o: number; oS: number; oU: number }>();
  for (const g of games) {
    const s = redSeats(g);
    if (!s) continue;
    for (const p of g.proposals) {
      if (p.forced) continue;
      const role = g.seatRoles[p.leaderSeat - 1] as string;
      if (role !== 'merlin' && role !== 'percival' && role !== 'loyal') continue;
      let x = c.get(p.round);
      if (!x) { x = { m: 0, mS: 0, mU: 0, o: 0, oS: 0, oU: 0 }; c.set(p.round, x); }
      const amb = assassinClass(p.teamSeats, s) === 'ambiguous';
      const seen = amb && p.teamSeats.includes(s.morgana);
      if (role === 'merlin') { x.m++; if (amb) { if (seen) x.mS++; else x.mU++; } } else { x.o++; if (amb) { if (seen) x.oS++; else x.oU++; } }
    }
  }
  const out = new Map<number, RateRow>();
  for (const [r, x] of c) out.set(r, { mS: x.mS / Math.max(1, x.m), mU: x.mU / Math.max(1, x.m), oS: x.oS / Math.max(1, x.o), oU: x.oU / Math.max(1, x.o) });
  return out;
}

const mixedLr = (t: RateRow | undefined): number => (t && t.oS + t.oU > 0 && t.mS + t.mU > 0 ? (t.mS + t.mU) / (t.oS + t.oU) : 1);

interface AssassinationCase {
  game: ReplayGame;
  merlin: string;
  human: string;
  /** Model-test game (the assassination model's 30% held-out split). */
  modelTest: boolean;
  fold: number;
  pool: string[];
  all: string[];
  score: Map<string, number>;
  ambRounds: Map<string, number[]>;
  oneG: Map<string, number>;
}

function sectionC(games: readonly ReplayGame[]): Record<string, unknown> {
  console.log('\n(c) The soft factor on top of the assassination model (human assassination states; the model\'s own score as the base)');
  const cases: AssassinationCase[] = [];
  for (const g of games) {
    if (g.assassinTargetSeat === undefined || !redSeats(g)) continue;
    const aSeat = g.seatRoles.indexOf('assassin' as never) + 1;
    const mSeat = g.seatRoles.indexOf('merlin' as never) + 1;
    if (aSeat === 0 || mSeat === 0) continue;
    const obs = buildReplayObservation(g, aSeat, { kind: 'assassination' });
    const evil = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, obs.myPlayerId]);
    const all = obs.allPlayerIds.filter((id) => !evil.has(id));
    const ev = visibleRedEvidence(obs, all);
    // The batch-1G factor (withdrawn): 1/2 LR(visible) + 1/2 LR(not visible), from the study's own table.
    const oneGTable: Record<number, number> = { 1: 1.181, 2: 1.171, 3: 0.981, 4: 1.005, 5: 0.699 };
    const oneG = new Map(all.map((id) => [id, (ev.get(id)?.ambiguousRounds ?? []).reduce((a, r) => a + Math.log(oneGTable[r] ?? 1), 0)]));
    cases.push({
      game: g,
      merlin: seatId(mSeat),
      human: seatId(g.assassinTargetSeat),
      modelTest: fnv1a(`assassin|${g.id}`) % 100 >= 70,
      fold: fnv1a(`xfit|${g.id}`) % 2,
      pool: tierCandidates(all, ev),
      all,
      score: scoreAssassinCandidates(obs, all),
      ambRounds: new Map(all.map((id) => [id, ev.get(id)?.ambiguousRounds ?? []])),
      oneG,
    });
  }
  const tables = [0, 1].map((f) => ambiguousRates(games.filter((g) => fnv1a(`xfit|${g.id}`) % 2 !== f)));
  const full = ambiguousRates(games);
  const llOf = (c: AssassinationCase, id: string, t: Map<number, RateRow>): number =>
    (c.ambRounds.get(id) ?? []).reduce((a, r) => a + Math.log(mixedLr(t.get(r))), 0);

  // Residual of the factor given the model's score: conditional logit with the
  // score as offset, one coefficient β on the factor's ln-likelihood, fitted on
  // the other fold (Newton), within the tier pool.
  const fitBeta = (train: readonly AssassinationCase[], t: Map<number, RateRow>): number => {
    let beta = 0;
    for (let it = 0; it < 30; it++) {
      let grad = 0, hess = 0;
      for (const c of train) {
        if (!c.pool.includes(c.merlin)) continue;
        const xs = c.pool.map((id) => llOf(c, id, t));
        const ss = c.pool.map((id, i) => (c.score.get(id) ?? 0) + beta * xs[i]);
        const mx = Math.max(...ss);
        const es = ss.map((v) => Math.exp(v - mx));
        const z = es.reduce((a, b) => a + b, 0);
        const ex = xs.reduce((a, x, i) => a + x * es[i] / z, 0);
        const ex2 = xs.reduce((a, x, i) => a + x * x * es[i] / z, 0);
        grad += xs[c.pool.indexOf(c.merlin)] - ex;
        hess -= ex2 - ex * ex;
      }
      if (hess > -1e-9) break;
      const step = grad / hess;
      beta -= step;
      if (Math.abs(step) < 1e-7) break;
    }
    return beta;
  };
  const betas = [0, 1].map((f) => fitBeta(cases.filter((c) => c.fold !== f), tables[f]));
  const betaFull = fitBeta(cases, full);

  type Variant = { label: string; pool: (c: AssassinationCase) => string[]; adj: (c: AssassinationCase, id: string) => number };
  const variants: Variant[] = [
    { label: 'model alone', pool: (c) => c.all, adj: () => 0 },
    { label: 'tier', pool: (c) => c.pool, adj: () => 0 },
    { label: 'tier + 1G factor (1/2 LR(vis) + 1/2 LR(not), in-sample)', pool: (c) => c.pool, adj: (c, id) => c.oneG.get(id) ?? 0 },
    { label: 'tier + measured ambiguous LR (in-sample)', pool: (c) => c.pool, adj: (c, id) => llOf(c, id, full) },
    { label: 'tier + measured ambiguous LR (2-fold cross-fit)', pool: (c) => c.pool, adj: (c, id) => llOf(c, id, tables[c.fold]) },
    { label: 'tier + residual β·ln LR given the model (2-fold cross-fit)', pool: (c) => c.pool, adj: (c, id) => betas[c.fold] * llOf(c, id, tables[c.fold]) },
  ];
  const out: Record<string, unknown> = { betaFold: betas, betaFull, n: cases.length, modelTest: cases.filter((c) => c.modelTest).length };
  console.log(`  ${cases.length} assassinations (${cases.filter((c) => c.modelTest).length} in the model's held-out 30%); residual β (fold 0 / fold 1 / all) ${betas.map((b) => b.toFixed(3)).join(' / ')} / ${betaFull.toFixed(3)}`);
  for (const v of variants) {
    let hit = 0, hitTest = 0, agree = 0, lp = 0, lpN = 0;
    for (const c of cases) {
      const pool = v.pool(c);
      const sc = pool.map((id) => (c.score.get(id) ?? 0) + v.adj(c, id));
      const order = c.game.seatRoles.map((_, i) => seatId(i + 1));
      let best = 0;
      for (let i = 1; i < pool.length; i++) {
        if (sc[i] > sc[best] || (sc[i] === sc[best] && order.indexOf(pool[i]) < order.indexOf(pool[best]))) best = i;
      }
      if (pool[best] === c.merlin) { hit++; if (c.modelTest) hitTest++; }
      if (pool[best] === c.human) agree++;
      const mi = pool.indexOf(c.merlin);
      if (mi >= 0) {
        const mx = Math.max(...sc);
        const z = sc.reduce((a, s) => a + Math.exp(s - mx), 0);
        lp += sc[mi] - mx - Math.log(z);
        lpN++;
      }
    }
    const nTest = cases.filter((c) => c.modelTest).length;
    console.log(`  ${v.label.padEnd(62)} Merlin hit ${fmtRate(wilsonRate(hit, cases.length))}; model held-out ${fmtRate(wilsonRate(hitTest, nTest))}; same target as the human ${fmtRate(wilsonRate(agree, cases.length))}; mean ln P(Merlin | in pool) ${(lp / Math.max(1, lpN)).toFixed(4)} (n ${lpN})`);
    out[v.label] = { hit, hitTest, agree, n: cases.length, nTest, meanLogP: lp / Math.max(1, lpN), nLogP: lpN };
  }
  return out;
}

main();
