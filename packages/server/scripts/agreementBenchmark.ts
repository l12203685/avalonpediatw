/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Agreement benchmark — how often does the production AI make the same
 * decision a given human made in the logged 10-player games?
 *
 *   pnpm --filter @avalon/server exec tsx scripts/agreementBenchmark.ts \
 *     --player ED [--player Sin] [--limit N] [--json out.json] [--no-population]
 *
 * Options:
 *   --player NAME        named player(s) to score (repeat or comma-separate;
 *                        default "ED,Sin"; the first one is the primary)
 *   --limit N            only the first N replayable games (sheet order)
 *   --json PATH          write the full aggregated result as JSON
 *   --no-population      skip the all-seats population replay (faster)
 *   --min-role-games N   top-performer eligibility (default 30)
 *   --top N              top performers kept per role (default 10)
 *   --prior K|auto       shrinkage pseudo-games for the adjusted win rate
 *                        (default auto = empirical Bayes per role, clamped 20..300)
 *   --cache PATH         sheets cache (default ./sheets_cache.json)
 *   --flag NAME[=V]      AgentTuning switch for the agents (repeatable; see
 *                        src/ai/AgentTuning.ts; default = production default
 *                        + AVALON_TUNING_* env)
 *   --legacy             start from the pre-2026-10-12 tuning (all off)
 *                        before applying --flag
 *
 * Agent = `HeuristicAgent.act` exactly as the GameServer bot calls it (with
 * USE_FORWARD_REASONING the decision is routed through ForwardAgent; the
 * forward telemetry printed below confirms it), plus
 * `HeuristicAgent.pickLakeTarget` / `declareLake` for the lake.
 * Deterministic: Math.random is reseeded per (game, seat, decision).
 */

import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import {
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { getForwardTelemetry } from '../src/ai/forward/ForwardAgent';
import { rowsFromSheet, parseReplayGame, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGame, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import { computeTopPerformers, cohortKey, BENCHMARK_ROLES } from '../src/ai/benchmark/cohorts';
import {
  addOutcome,
  emptyCohort,
  formatDivergence,
  formatTable,
  pct,
  topDivergences,
  type CohortReport,
} from '../src/ai/benchmark/report';

interface Args {
  players: string[];
  limit?: number;
  json?: string;
  population: boolean;
  minRoleGames: number;
  top: number;
  prior: number | 'auto';
  cache: string;
  flags: Partial<AgentTuning>;
  legacy: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    players: [],
    population: true,
    minRoleGames: 30,
    top: 10,
    prior: 'auto',
    cache: path.resolve(__dirname, '..', 'sheets_cache.json'),
    flags: {},
    legacy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--player': args.players.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--limit': args.limit = Number.parseInt(next(), 10); break;
      case '--json': args.json = next(); break;
      case '--no-population': args.population = false; break;
      case '--min-role-games': args.minRoleGames = Number.parseInt(next(), 10); break;
      case '--top': args.top = Number.parseInt(next(), 10); break;
      case '--prior': {
        const v = next();
        args.prior = v === 'auto' ? 'auto' : Number.parseFloat(v);
        break;
      }
      case '--cache': args.cache = path.resolve(next()); break;
      case '--flag': Object.assign(args.flags, parseTuningFlag(next())); break;
      case '--legacy': args.legacy = true; break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (args.players.length === 0) args.players = ['ED', 'Sin'];
  return args;
}

const ROLE_COLUMNS: Array<{ label: string; key: (role: string) => string }> = [
  { label: 'team R2+', key: (r) => `team/R2+ role=${r}` },
  { label: 'vote R2', key: (r) => `vote/R2 role=${r}` },
  { label: 'vote R3+', key: (r) => `vote/R3+ role=${r}` },
  { label: 'anomaly', key: (r) => `vote/human-anomaly role=${r}` },
  { label: 'quest', key: (r) => `quest/role=${r}` },
  { label: 'lake tgt', key: (r) => `lakeTarget/role=${r}` },
  { label: 'lake claim', key: (r) => `lakeClaim/role=${r}` },
  { label: 'assassin', key: (r) => `assassinate/role=${r}` },
];

function roleTable(cohorts: readonly CohortReport[]): string {
  const header = ['role', 'cohort', ...ROLE_COLUMNS.map((c) => c.label)];
  const rows: string[][] = [];
  for (const role of BENCHMARK_ROLES) {
    cohorts.forEach((c, i) => {
      rows.push([
        i === 0 ? role : '',
        c.label,
        ...ROLE_COLUMNS.map((col) => {
          const t = c.metrics[col.key(role)];
          return t && t.n > 0 ? `${pct(t.agent, t.n)}/${t.n}` : '—';
        }),
      ]);
    });
  }
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')).join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tuning = resolveAgentTuning(args.flags, args.legacy ? { ...LEGACY_AGENT_TUNING } : undefined);
  const started = Date.now();
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const rows = rowsFromSheet(data['牌譜'] ?? []);

  const parseFailures = new Map<string, number>();
  let recorded = 0;
  const allGames: ReplayGame[] = [];
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    recorded += 1;
    const res = parseReplayGame(row);
    if (res.ok) allGames.push(res.game);
    else parseFailures.set(res.reason, (parseFailures.get(res.reason) ?? 0) + 1);
  }
  const games = args.limit !== undefined ? allGames.slice(0, args.limit) : allGames;

  const top = computeTopPerformers(allGames, {
    minGames: args.minRoleGames,
    perRole: args.top,
    priorStrength: args.prior,
  });

  const playerCohorts = new Map(args.players.map((p) => [p, emptyCohort(p)]));
  const topCohort = emptyCohort('top/role');
  const population = emptyCohort('population');
  const playerGames = new Map(args.players.map((p) => [p, 0]));

  for (const game of games) {
    const seats: number[] = [];
    for (let seat = 1; seat <= game.playerCount; seat++) {
      const name = game.names[seat - 1];
      const wanted = args.population
        || playerCohorts.has(name)
        || top.members.has(cohortKey(name, game.seatRoles[seat - 1]));
      if (wanted) seats.push(seat);
      if (playerGames.has(name)) playerGames.set(name, (playerGames.get(name) ?? 0) + 1);
    }
    const outcomes: DecisionOutcome[] = replayGame(game, seats, {
      makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning),
    });
    for (const o of outcomes) {
      if (args.population) addOutcome(population, o);
      const pc = playerCohorts.get(o.name);
      if (pc) addOutcome(pc, o);
      if (top.members.has(cohortKey(o.name, o.role))) addOutcome(topCohort, o);
    }
  }

  const telemetry = getForwardTelemetry();
  const cohorts = [...playerCohorts.values(), topCohort, ...(args.population ? [population] : [])];
  const primary = cohorts[0];

  console.log(`牌譜 rows with a record: ${recorded}; replayable 10p games: ${allGames.length}; evaluated: ${games.length}`);
  console.log(`skipped: ${[...parseFailures].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join('; ')}`);
  console.log(`games per named player: ${[...playerGames].map(([p, n]) => `${p}=${n}`).join(', ')}`);
  console.log(`agent tuning: ${describeAgentTuning(tuning)}`);
  console.log(`forward telemetry: ${telemetry.totalDecisions} decisions via ForwardAgent, ${telemetry.fallbacks} fallbacks`);
  if (telemetry.totalDecisions === 0) {
    console.warn('WARNING: ForwardAgent path not active — results reflect the baseline HeuristicAgent only.');
  }
  console.log('\nAgreement: agent% (default-baseline% / rule-baseline%) n');
  console.log(formatTable(cohorts));
  console.log('\nPer-role agent agreement (agent%/n)');
  console.log(roleTable([primary, topCohort, ...(args.population ? [population] : [])]));
  for (const c of cohorts) {
    console.log(`\nTop divergences — ${c.label}`);
    for (const d of topDivergences(c.situations, 5)) console.log(`  ${formatDivergence(d)}`);
  }
  console.log('\nTop performers (rule: ≥' +
    `${top.options.minGames} games in role, adj = (wins + K·p_role) / (games + K), K per role, top ${top.options.perRole})`);
  for (const role of BENCHMARK_ROLES) {
    const list = top.byRole[role] ?? [];
    console.log(`  ${role.padEnd(9)} p=${pct(top.roleWinRate[role] ?? 0, 1)} K=${(top.priorStrengthByRole[role] ?? 0).toFixed(0)}  ` +
      list.map((r) => `${r.name}(${r.games}g ${pct(r.wins, r.games)}→${pct(r.adjWinRate, 1)})`).join(', '));
  }
  console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (args.json) {
    const perRoleDivergences: Record<string, Record<string, ReturnType<typeof topDivergences>>> = {};
    for (const c of cohorts) {
      perRoleDivergences[c.label] = {};
      for (const role of BENCHMARK_ROLES) {
        perRoleDivergences[c.label][role] = topDivergences(c.roleSituations, 5, (k) => k.startsWith(`${role} | `));
      }
    }
    const out = {
      generatedBy: 'packages/server/scripts/agreementBenchmark.ts',
      options: { ...args, cache: path.basename(args.cache) },
      tuning,
      dataset: {
        recorded,
        replayable: allGames.length,
        evaluated: games.length,
        skipped: Object.fromEntries(parseFailures),
        gamesPerPlayer: Object.fromEntries(playerGames),
      },
      forwardTelemetry: telemetry,
      topPerformers: { ...top, members: [...top.members] },
      cohorts: Object.fromEntries(cohorts.map((c) => [c.label, c])),
      divergences: Object.fromEntries(cohorts.map((c) => [c.label, topDivergences(c.situations, 15)])),
      perRoleDivergences,
    };
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(out, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
