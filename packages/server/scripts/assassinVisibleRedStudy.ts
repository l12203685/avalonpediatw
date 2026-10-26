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
 *       hit rate by tier.
 *
 * Every rate is printed with n and a Wilson 95% interval. Output is aggregate
 * only (no names, no game ids).
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, type ReplayGame, type ReplayProposal } from '../src/ai/benchmark/sheetsReplay';

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

interface Cell { n: number; visible: number; certain: number; ambiguous: number; none: number }
const emptyCell = (): Cell => ({ n: 0, visible: 0, certain: 0, ambiguous: 0, none: 0 });

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
    c[assassinClass(p.teamSeats, s)]++;
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
      // The soft likelihood of an ambiguous lead (the assassin's view: the one
      // teammate on it is seen with probability 1/2): 1/2 LR(seen) + 1/2 LR(not seen).
      const lrSeen = (m.visible / m.n) / (o.visible / o.n);
      const lrUnseen = (1 - m.visible / m.n) / (1 - o.visible / o.n);
      const mix = 0.5 * lrSeen + 0.5 * lrUnseen;
      mixTable[`${kind}|${r}`] = mix;
      console.log(`       ambiguous-lead multiplier 1/2 LR(seen) + 1/2 LR(not seen) = 1/2 × ${lrSeen.toFixed(3)} + 1/2 × ${lrUnseen.toFixed(3)} = ${mix.toFixed(3)}`);
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

  if (args.json) {
    const out = {
      generatedBy: 'packages/server/scripts/assassinVisibleRedStudy.ts',
      games: games.length,
      cells: Object.fromEntries(cells),
      lr: lrTable,
      ambiguousLeadMultiplier: mixTable,
      assassination: tiers,
    };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`\nwrote ${path.resolve(args.json)}`);
  }
}

main();
