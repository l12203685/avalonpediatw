/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Team reuse study — how do human leaders build on the teams already on
 * the table? (`AgentTuning.teamReuse`, docs/ai/strength_benchmark.md 第 11 節)
 *
 *   pnpm --filter @avalon/server exec tsx scripts/teamReuseStudy.ts \
 *     [--player ED --player Sin] [--agent] [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the strict replay parser of the
 * agreement benchmark (`parseReplayGame`, 1970 replayable 10-player games)
 * and compares every proposal after the first with its reference team:
 *   - the previous proposal of the round (a later proposal: the team just
 *     rejected), or
 *   - the last mission team (the first proposal of R2+), split by that
 *     mission's result.
 * For each it records whether the leader kept the reference whole (plus
 * the extra seat when the team grows), changed one seat or more, leaves
 * themself off, swapped themself in, which seat was dropped (the previous
 * leader? a failed-mission member? an on-team rejecter of the reference?),
 * and for later proposals whether an older proposal of the round was
 * re-proposed and whether the team is closer to the last successful mission
 * team than to the rejected one. Rates carry n and a Wilson 95% interval;
 * cohorts: population, top/role (same rule as the agreement benchmark) and
 * the `--player` names (the public docs only use the ED / Sin labels).
 *
 * `--agent` also replays every team decision through `HeuristicAgent.act`
 * (production default, and production default + `teamReuse` with the
 * weights in `TeamReuse.ts` or `AVALON_TEAM_REUSE_VARIANT`) and prints team
 * agreement (exact / Jaccard) per context next to the "default" baseline
 * of the agreement benchmark, on all games and on a fixed 70/30 game split
 * (fnv1a("teamreuse|" + game id) mod 100 < 70 = the split the weights were
 * fitted on). Same seeding as the agreement benchmark, so the totals equal
 * its team rows.
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { computeTopPerformers, cohortKey, BENCHMARK_ROLES } from '../src/ai/benchmark/cohorts';
import { defaultTeam, jaccard as jaccardIds, withSeededRandom } from '../src/ai/benchmark/agreement';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { describeAgentTuning, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import { DEFAULT_TEAM_REUSE_OPTIONS, setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';

interface Args {
  players: string[];
  agent: boolean;
  json?: string;
  cache: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { players: [], agent: false, cache: path.resolve(__dirname, '..', 'sheets_cache.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--player': args.players.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--agent': args.agent = true; break;
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

// ── Statistics ─────────────────────────────────────────────────

interface Rate { k: number; n: number; rate: number; low: number; high: number }

function wilson(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const p1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

function fmtRate(k: number, n: number, ci = true): string {
  if (n === 0) return '—';
  const r = wilson(k, n);
  return ci ? `${p1(r.rate)} [${p1(r.low)}, ${p1(r.high)}] ${k}/${n}` : `${p1(r.rate)} ${k}/${n}`;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The fixed 70/30 game split the `teamReuse` weights were fitted on. */
function teamReuseSplit(gameId: string): 'train' | 'test' {
  return fnv1a(`teamreuse|${gameId}`) % 100 < 70 ? 'train' : 'test';
}

// ── Per-proposal record ────────────────────────────────────────

type Context = 'R1 later proposal' | 'R2+ later proposal' | 'first after success' | 'first after fail';
const CONTEXTS: readonly Context[] = ['R1 later proposal', 'R2+ later proposal', 'first after success', 'first after fail'];

interface Prop {
  gameId: string;
  name: string;
  role: string;
  camp: 'good' | 'evil';
  round: number;
  ctx: Context;
  /** Team grows over the reference (R1→R2, R3→R4 mission teams). */
  grow: number;
  leaderOnRef: boolean;
  leaderOnTeam: boolean;
  /** Reference seats replaced (beyond the growth): 0 = kept whole. */
  changed: number;
  exact: boolean;
  jaccard: number;
  /** Leader off the reference, on the team, every other change is for self. */
  swappedSelfIn: boolean;
  /** Kept whole and the extra seat (growth) is the leader. */
  grewBySelf: boolean | null;
  /** Exactly one reference seat dropped: was it the reference's leader / a failed-mission member / an on-team rejecter? */
  dropped: { prevLeader: boolean; prevLeaderOnRef: boolean; tainted: boolean; taintedShare: number; rejectedRef: boolean | null; refSize: number } | null;
  /** Later proposals: exact re-proposal of the previous / an older proposal of the round. */
  exactSource: 'previous' | 'older' | 'none' | null;
  /** Later proposals: leader on some earlier team of the round; re-proposed one of those exactly. */
  leaderOnEarlier: boolean | null;
  reproposedOwnEarlier: boolean | null;
  /** Later proposals after a successful mission: closer to the mission team or to the previous proposal (Jaccard). */
  closerTo: 'mission' | 'previous' | 'tie' | null;
  /** First after fail: failed-team members kept (excluding the leader). */
  failedKept: number | null;
  /** Later proposals re-proposing an earlier team exactly: the leader is on that team. */
  exactReuseHasLeader: boolean | null;
  /** What happened to this proposal: rejected / went and succeeded / went and failed. */
  outcome: 'rejected' | 'succeeded' | 'failed';
}

function setOf(a: readonly number[]): Set<number> {
  return new Set(a);
}

function jac(a: Set<number>, b: Set<number>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function collect(games: readonly ReplayGame[]): Prop[] {
  const out: Prop[] = [];
  for (const g of games) {
    for (let i = 1; i < g.proposals.length; i++) {
      const p = g.proposals[i];
      const prev = g.proposals[i - 1];
      const L = p.leaderSeat;
      const role = g.seatRoles[L - 1];
      const lastQuest = g.quests.find((q) => q.round === p.round - 1);
      let ctx: Context;
      if (p.round === 1) ctx = 'R1 later proposal';
      else if (p.attempt >= 2) ctx = 'R2+ later proposal';
      else ctx = lastQuest?.failed ? 'first after fail' : 'first after success';
      const H = setOf(p.teamSeats);
      const P = setOf(prev.teamSeats);
      const grow = Math.max(0, H.size - P.size);
      const kept = [...P].filter((x) => H.has(x));
      const dropped = [...P].filter((x) => !H.has(x));
      const added = [...H].filter((x) => !P.has(x));
      const changed = Math.max(0, added.length - grow);
      const failedBefore = new Set<number>();
      for (const q of g.quests) if (q.round < p.round && q.failed) for (const s of q.teamSeats) failedBefore.add(s);
      const earlier = g.proposals.slice(0, i).filter((x) => x.round === p.round);
      const later = p.attempt >= 2;
      const withLeader = later ? earlier.filter((x) => x.teamSeats.includes(L)) : [];
      let closerTo: Prop['closerTo'] = null;
      if (later && p.round >= 2 && lastQuest && !lastQuest.failed) {
        const jm = jac(H, setOf(lastQuest.teamSeats));
        const jp = jac(H, P);
        closerTo = jm > jp ? 'mission' : jm < jp ? 'previous' : 'tie';
      }
      out.push({
        gameId: g.id,
        name: g.names[L - 1] ?? '',
        role,
        camp: campOf(role),
        round: p.round,
        ctx,
        grow,
        leaderOnRef: P.has(L),
        leaderOnTeam: H.has(L),
        changed,
        exact: sameSet(p.teamSeats, prev.teamSeats),
        jaccard: jac(H, P),
        swappedSelfIn: !P.has(L) && H.has(L) && dropped.length === 1 && changed === 1,
        grewBySelf: grow > 0 && changed === 0 ? added.includes(L) : null,
        dropped: dropped.length === 1 && added.length >= 1
          ? {
            prevLeader: dropped[0] === prev.leaderSeat,
            prevLeaderOnRef: P.has(prev.leaderSeat),
            tainted: failedBefore.has(dropped[0]),
            taintedShare: [...P].filter((x) => failedBefore.has(x)).length / P.size,
            rejectedRef: prev.forced || !prev.votesReliable ? null : !prev.votes[dropped[0] - 1],
            refSize: P.size,
          }
          : null,
        exactSource: later
          ? sameSet(p.teamSeats, prev.teamSeats)
            ? 'previous'
            : earlier.slice(0, -1).some((x) => sameSet(p.teamSeats, x.teamSeats)) ? 'older' : 'none'
          : null,
        leaderOnEarlier: later ? withLeader.length > 0 : null,
        reproposedOwnEarlier: later && withLeader.length > 0 ? withLeader.some((x) => sameSet(p.teamSeats, x.teamSeats)) : null,
        closerTo,
        failedKept: ctx === 'first after fail' ? kept.filter((x) => x !== L).length : null,
        exactReuseHasLeader: later && earlier.some((x) => sameSet(p.teamSeats, x.teamSeats)) ? H.has(L) : null,
        outcome: !p.wentOnMission ? 'rejected' : g.quests.find((q) => q.round === p.round)?.failed ? 'failed' : 'succeeded',
      });
    }
  }
  return out;
}

// ── Tables ─────────────────────────────────────────────────────

interface Cohort { label: string; has: (p: Prop) => boolean }

function contextTable(props: readonly Prop[], cohorts: readonly Cohort[], ci: boolean): string {
  const lines: string[] = [];
  for (const ctx of CONTEXTS) {
    lines.push(`  ${ctx}`);
    for (const c of cohorts) {
      const s = props.filter((p) => p.ctx === ctx && c.has(p));
      const n = s.length;
      if (n === 0) continue;
      const k = (f: (p: Prop) => boolean): number => s.filter(f).length;
      const mj = s.reduce((a, p) => a + p.jaccard, 0) / n;
      lines.push(`    ${c.label.padEnd(12)} n=${String(n).padEnd(6)} kept whole ${fmtRate(k((p) => p.changed === 0), n, ci)}; one seat changed ${fmtRate(k((p) => p.changed === 1), n, ci)}; ≥2 changed ${fmtRate(k((p) => p.changed >= 2), n, false)}; exact ${fmtRate(k((p) => p.exact), n, false)}; mean Jaccard ${p1(mj)}; leader on reference ${fmtRate(k((p) => p.leaderOnRef), n, false)}; leader off own team ${fmtRate(k((p) => !p.leaderOnTeam), n, false)}`);
    }
  }
  return lines.join('\n');
}

function splitTable(props: readonly Prop[], label: string, split: (p: Prop) => string, values: readonly string[]): string {
  const lines = [`  ${label}`];
  for (const ctx of CONTEXTS) {
    for (const v of values) {
      const s = props.filter((p) => p.ctx === ctx && split(p) === v);
      if (s.length === 0) continue;
      const k = (f: (p: Prop) => boolean): number => s.filter(f).length;
      lines.push(`    ${ctx.padEnd(20)} ${v.padEnd(14)} n=${String(s.length).padEnd(6)} kept whole ${fmtRate(k((p) => p.changed === 0), s.length)}; one seat changed ${fmtRate(k((p) => p.changed === 1), s.length, false)}; ≥2 ${fmtRate(k((p) => p.changed >= 2), s.length, false)}; leader off own team ${fmtRate(k((p) => !p.leaderOnTeam), s.length, false)}`);
    }
  }
  return lines.join('\n');
}

function detailTable(props: readonly Prop[]): string {
  const lines: string[] = [];
  const rate = (label: string, s: readonly Prop[], f: (p: Prop) => boolean): void => {
    lines.push(`    ${label.padEnd(70)} ${fmtRate(s.filter(f).length, s.length)}`);
  };
  const succ = props.filter((p) => p.ctx === 'first after success');
  lines.push('  first proposal after a successful mission');
  for (const r of [2, 3, 4, 5]) {
    for (const on of [true, false]) {
      const s = succ.filter((p) => p.round === r && p.leaderOnRef === on);
      rate(`R${r} leader ${on ? 'on' : 'off'} the mission team: kept it whole`, s, (p) => p.changed === 0);
      if (!on) {
        if (r === 2 || r === 4) rate(`  … kept whole, the extra seat is the leader`, s.filter((p) => p.changed === 0), (p) => p.grewBySelf === true);
        else {
          rate(`  … kept whole without the leader (exact re-proposal)`, s, (p) => p.exact);
          rate(`  … swapped the leader in for one member`, s, (p) => p.swappedSelfIn);
        }
      }
    }
  }
  for (const camp of ['good', 'evil'] as const) {
    const s = succ.filter((p) => p.grow === 0 && p.exact && !p.leaderOnTeam && p.camp === camp);
    rate(`same-size round, ${camp} leader re-proposed it without self: went and succeeded`, s, (p) => p.outcome === 'succeeded');
  }
  const later = props.filter((p) => p.ctx === 'R2+ later proposal');
  lines.push('  R2+ later proposals (reference = the proposal just rejected)');
  rate('exact re-proposal of the previous proposal', later, (p) => p.exactSource === 'previous');
  rate('exact re-proposal of an older proposal of the round', later, (p) => p.exactSource === 'older');
  rate('exact re-proposals (previous or older): the leader is on the team', later.filter((p) => p.exactReuseHasLeader !== null), (p) => p.exactReuseHasLeader === true);
  rate('leader was on an earlier team of the round', later, (p) => p.leaderOnEarlier === true);
  rate('  … re-proposed one of those teams exactly', later.filter((p) => p.leaderOnEarlier), (p) => p.reproposedOwnEarlier === true);
  rate('leader off the reference: swapped self in for one member', later.filter((p) => !p.leaderOnRef), (p) => p.swappedSelfIn);
  const one = later.filter((p) => p.dropped !== null && p.changed === 1);
  const chanceLeader = one.reduce((a, p) => a + (p.dropped?.prevLeaderOnRef ? 1 / (p.dropped?.refSize ?? 1) : 0), 0) / Math.max(1, one.length);
  rate(`one seat changed: the dropped seat was the previous leader (chance ${p1(chanceLeader)})`, one, (p) => p.dropped?.prevLeader === true);
  const chanceTaint = one.reduce((a, p) => a + (p.dropped?.taintedShare ?? 0), 0) / Math.max(1, one.length);
  rate(`one seat changed: the dropped seat was on a failed mission (chance ${p1(chanceTaint)})`, one, (p) => p.dropped?.tainted === true);
  const rej = one.filter((p) => p.dropped?.rejectedRef !== null);
  rate('one seat changed: the dropped seat had rejected the reference on-team', rej, (p) => p.dropped?.rejectedRef === true);
  const afterSucc = later.filter((p) => p.closerTo !== null);
  rate('after a successful mission: closer to the mission team than to the previous proposal', afterSucc, (p) => p.closerTo === 'mission');
  rate('after a successful mission: closer to the previous proposal', afterSucc, (p) => p.closerTo === 'previous');
  const fail = props.filter((p) => p.ctx === 'first after fail');
  lines.push('  first proposal after a failed mission');
  for (const k of [0, 1, 2, 3]) rate(`failed-team members kept (leader excluded) = ${k}${k === 3 ? '+' : ''}`, fail, (p) => (k === 3 ? (p.failedKept ?? 0) >= 3 : p.failedKept === k));
  const r1 = props.filter((p) => p.ctx === 'R1 later proposal');
  lines.push('  R1 later proposals');
  rate('exact re-proposal of the previous proposal', r1, (p) => p.exactSource === 'previous');
  rate('exact re-proposal of an older R1 proposal', r1, (p) => p.exactSource === 'older');
  return lines.join('\n');
}

function roleTable(props: readonly Prop[]): string {
  const lines = ['  per role (population): first after success kept whole | R2+ later: kept whole or one seat changed | R2+ later exact (previous or older)'];
  for (const role of BENCHMARK_ROLES) {
    const s = props.filter((p) => p.role === role);
    const a = s.filter((p) => p.ctx === 'first after success');
    const b = s.filter((p) => p.ctx === 'R2+ later proposal');
    lines.push(`    ${role.padEnd(9)} ${fmtRate(a.filter((p) => p.changed === 0).length, a.length)} | ${fmtRate(b.filter((p) => p.changed <= 1).length, b.length)} | ${fmtRate(b.filter((p) => p.exactSource !== 'none').length, b.length)}`);
  }
  return lines.join('\n');
}

// ── Agent agreement per context ────────────────────────────────

interface AgentTally { n: number; exact: number; jac: number; dExact: number; dJac: number }

function agentAgreement(
  games: readonly ReplayGame[],
  tuning: AgentTuning,
  cohorts: readonly { label: string; has: (name: string, role: string) => boolean }[],
): Map<string, AgentTally> {
  const tally = new Map<string, AgentTally>();
  const add = (key: string, exact: boolean, j: number, dExact: boolean, dJ: number): void => {
    const t = tally.get(key) ?? { n: 0, exact: 0, jac: 0, dExact: 0, dJac: 0 };
    t.n++; t.exact += exact ? 1 : 0; t.jac += j; t.dExact += dExact ? 1 : 0; t.dJac += dJ;
    tally.set(key, t);
  };
  for (const g of games) {
    const split = teamReuseSplit(g.id);
    for (let i = 0; i < g.proposals.length; i++) {
      const p = g.proposals[i];
      const seat = p.leaderSeat;
      const role = g.seatRoles[seat - 1];
      const name = g.names[seat - 1] ?? '';
      const obs = buildReplayObservation(g, seat, { kind: 'team_select', proposal: i });
      const agent = new HeuristicAgent(seatId(seat), undefined, undefined, tuning);
      agent.onGameStart(buildReplayObservation(g, seat, { kind: 'team_select', proposal: 0 }));
      const action = withSeededRandom(`${g.id}|${seat}|team-${i}`, () => agent.act(obs));
      const A = action.type === 'team_select' ? action.teamIds : [];
      const H = p.teamSeats.map(seatId);
      const D = defaultTeam(g, i, obs);
      const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
      let ctx = 'R1 first proposal';
      if (i > 0) {
        const lastQuest = g.quests.find((q) => q.round === p.round - 1);
        if (p.round === 1) ctx = 'R1 later proposal';
        else if (p.attempt >= 2) ctx = 'R2+ later proposal';
        else ctx = lastQuest?.failed ? 'first after fail' : 'first after success';
      }
      const bucket = p.round === 1 ? 'R1' : 'R2+';
      const camp = campOf(role);
      for (const c of cohorts) {
        if (!c.has(name, role)) continue;
        for (const key of [bucket, `${bucket} ${camp}`, `${bucket} ${split}`, ctx, `${ctx} ${camp}`]) {
          add(`${c.label}|${key}`, same(A, H), jaccardIds(A, H), same(D, H), jaccardIds(D, H));
        }
      }
    }
  }
  return tally;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const games: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const res = parseReplayGame(row);
    if (res.ok) games.push(res.game);
  }
  const top = computeTopPerformers(games, { minGames: 30, perRole: 10, priorStrength: 'auto' });
  const props = collect(games);
  const cohorts: Cohort[] = [
    { label: 'population', has: () => true },
    { label: 'top/role', has: (p) => top.members.has(cohortKey(p.name, p.role)) },
    ...args.players.map((name) => ({ label: name, has: (p: Prop) => p.name === name })),
  ];

  console.log(`replayable 10-player games: ${games.length}; proposals after the first: ${props.length}`);
  console.log('Format: rate [Wilson 95%] k/n. Reference = previous proposal (later proposals of a round) or last mission team (first proposal of R2+).');
  console.log('"kept whole" = every reference seat kept (+ the extra seat when the team grows); "one seat changed" = one reference seat replaced.\n');
  console.log('1. By context and cohort');
  console.log(contextTable(props, cohorts, true));
  console.log('\n2. By leader camp (population)');
  console.log(splitTable(props, 'camp', (p) => p.camp, ['good', 'evil']));
  console.log('\n3. By whether the leader was on the reference (population)');
  console.log(splitTable(props, 'leader on reference', (p) => (p.leaderOnRef ? 'leader on' : 'leader off'), ['leader on', 'leader off']));
  console.log('\n4. Which seats change (population)');
  console.log(detailTable(props));
  console.log('\n5. Per role');
  console.log(roleTable(props));

  let agentOut: Record<string, unknown> | undefined;
  if (args.agent) {
    const options = teamReuseOptionsFromEnv();
    setTeamReuseOptions(options);
    if (JSON.stringify(options) !== JSON.stringify(DEFAULT_TEAM_REUSE_OPTIONS)) process.stderr.write(`teamReuse variant: ${JSON.stringify(options)}\n`);
    const agentCohorts = [
      { label: 'population', has: (): boolean => true },
      { label: 'top/role', has: (name: string, role: string): boolean => top.members.has(cohortKey(name, role)) },
      ...args.players.map((pl) => ({ label: pl, has: (name: string): boolean => name === pl })),
    ];
    const tunings: Array<[string, AgentTuning]> = [
      ['production default', resolveAgentTuning({})],
      ['+ teamReuse', resolveAgentTuning({ teamReuse: true })],
    ];
    const results = tunings.map(([label, t]) => [label, agentAgreement(games, t, agentCohorts)] as const);
    const tel = getForwardTelemetry();
    console.log(`\n6. Agent team agreement per context: exact / Jaccard (default baseline exact / Jaccard), n — ${tunings.map(([l, t]) => `${l} = ${describeAgentTuning(t)}`).join('; ')}`);
    console.log(`   teamReuse weights ${JSON.stringify(options)}; forward telemetry ${tel.totalDecisions} decisions, ${tel.fallbacks} fallbacks`);
    const keys = ['R1', 'R2+', 'R2+ good', 'R2+ evil', 'R2+ train', 'R2+ test', 'R1 first proposal', ...CONTEXTS, ...CONTEXTS.flatMap((c) => [`${c} good`, `${c} evil`])];
    for (const c of agentCohorts) {
      console.log(`  ${c.label}`);
      for (const key of keys) {
        const cells = results.map(([label, t]) => {
          const x = t.get(`${c.label}|${key}`);
          return x ? `${label}: ${p1(x.exact / x.n)} / ${p1(x.jac / x.n)}` : `${label}: —`;
        });
        const d = results[0][1].get(`${c.label}|${key}`);
        if (!d) continue;
        console.log(`    ${key.padEnd(26)} ${cells.join('   ')}   (default baseline ${p1(d.dExact / d.n)} / ${p1(d.dJac / d.n)}) n=${d.n}`);
      }
    }
    agentOut = { options, results: Object.fromEntries(results.map(([l, t]) => [l, Object.fromEntries(t)])) };
  }

  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({
      generatedBy: 'packages/server/scripts/teamReuseStudy.ts',
      games: games.length,
      proposals: props.length,
      records: props.map((p) => ({ ...p, name: args.players.includes(p.name) ? p.name : undefined })),
      agent: agentOut,
    }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
