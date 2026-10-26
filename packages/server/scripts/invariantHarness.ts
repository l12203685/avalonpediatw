/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Invariant harness (logic-first plan §5, 2026-10-14; docs/ai/logic_first.md).
 *
 *   USE_FORWARD_REASONING=true pnpm --filter @avalon/server exec tsx scripts/invariantHarness.ts \
 *     [--replays all|N] [--no-probe] [--no-observations] \
 *     [--selfplay N --seed S [--seed S2 ...] [--players 10] [--roles percival=0]] \
 *     [--flag NAME[=V] ...] [--legacy] [--json out.json] [--md out.md] [--diag]
 *
 * Options:
 *   --replays all|N    replay the first N replayable 10-player games of the
 *                      牌譜 (default all; 0 = none)
 *   --no-probe         skip the counterfactual loyal-leader probe (INV-T1)
 *   --no-observations  skip the per-seat round-opening checks (B1 / B2 / F0 /
 *                      R2 / OBS)
 *   --selfplay N       N self-play games per seed (default 0)
 *   --seed S           self-play master seed (repeatable)
 *   --players P        self-play player count (default 10; repeatable)
 *   --roles SPEC       self-play lobby role switch: `percival=0` (Percival
 *                      becomes a loyal) or `std` (default); repeatable. The
 *                      engine's canonical 7-role lock refuses a minion, so
 *                      Morgana / Oberon / Mordred cannot be switched off; the
 *                      size-changing options are not offered either
 *   --flag NAME[=V]    AgentTuning switch on top of the production default
 *                      (or of legacy with --legacy); repeatable
 *   --json / --md      write the full result
 *   --diag             also print the diagnostic counters (the logic audit's
 *                      names, for line-by-line comparison)
 *
 * Prints one table per source: rule, kind, status, opportunities, exempt (by
 * reason), bot violations, of them on unreliable replay input, and on the
 * replay the human's own violations; then the L1-empty fallbacks (INV-W2),
 * the static INV-B3 scan and the ForwardAgent fallback count. Aggregates
 * only — no names, no seat-to-person mapping, no game ids.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  parseTuningFlag,
  resolveAgentTuning,
  type AgentTuning,
} from '../src/ai/AgentTuning';
import { rowsFromSheet, parseReplayGame, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import {
  auditReplayGame,
  auditSelfPlay,
  emptyResult,
  parseRoleToggles,
  roleTogglesLabel,
  type RoleToggles,
} from '../src/ai/invariants/sources';
import { staticResultReads } from '../src/ai/invariants/staticScan';

interface Args {
  replays: number | 'all';
  probe: boolean;
  observations: boolean;
  selfplay: number;
  seeds: number[];
  players: number[];
  roles: RoleToggles[];
  flags: Partial<AgentTuning>;
  legacy: boolean;
  json?: string;
  md?: string;
  diag: boolean;
  cache: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    replays: 'all', probe: true, observations: true, selfplay: 0, seeds: [], players: [], roles: [],
    flags: {}, legacy: false, diag: false, cache: path.resolve(__dirname, '../sheets_cache.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case '--replays': { const v = next(); a.replays = v === 'all' ? 'all' : Number.parseInt(v, 10); break; }
      case '--no-probe': a.probe = false; break;
      case '--no-observations': a.observations = false; break;
      case '--selfplay': a.selfplay = Number.parseInt(next(), 10); break;
      case '--seed': a.seeds.push(Number.parseInt(next(), 10)); break;
      case '--players': a.players.push(Number.parseInt(next(), 10)); break;
      case '--roles': a.roles.push(parseRoleToggles(next())); break;
      case '--flag': Object.assign(a.flags, parseTuningFlag(next())); break;
      case '--legacy': a.legacy = true; break;
      case '--json': a.json = next(); break;
      case '--md': a.md = next(); break;
      case '--diag': a.diag = true; break;
      case '--cache': a.cache = next(); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  if (a.players.length === 0) a.players.push(10);
  if (a.roles.length === 0) a.roles.push({});
  return a;
}

export function loadReplayGames(cache: string): ReplayGame[] {
  const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
  const games: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (r.ok) games.push(r.game);
  }
  return games;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tuning = args.legacy ? { ...LEGACY_AGENT_TUNING, ...args.flags } : resolveAgentTuning(args.flags);
  const result = emptyResult();
  const started = Date.now();
  const out: string[] = [];
  out.push(`agent tuning: ${describeAgentTuning(tuning)}`);

  if (args.replays !== 0) {
    const all = loadReplayGames(args.cache);
    const games = args.replays === 'all' ? all : all.slice(0, args.replays);
    out.push(`replay: ${games.length} games (of ${all.length} replayable; ${games.filter((g) => g.lakeChainValid).length} lake-legal)`);
    let n = 0;
    for (const g of games) {
      auditReplayGame(g, { tuning, observationChecks: args.observations, probe: args.probe }, result);
      n++;
      if (n % 200 === 0) process.stderr.write(`  replay ${n}/${games.length}, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  }
  for (const players of args.players) {
    for (const roleToggles of args.roles) {
      for (const seed of args.seeds) {
        if (args.selfplay <= 0) continue;
        await auditSelfPlay({ tuning, seed, games: args.selfplay, playerCount: players, observationChecks: args.observations, roleToggles }, result);
        process.stderr.write(`  self-play ${players}p ${roleTogglesLabel(roleToggles)} seed ${seed}: ${args.selfplay} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    }
  }
  if (args.selfplay > 0) {
    out.push(`self-play: ${args.selfplay} games × seeds [${args.seeds.join(', ')}] × players [${args.players.join(', ')}] × roles [${args.roles.map(roleTogglesLabel).join(', ')}]`);
  }

  // INV-B3 (static): belief code reading a mission result without its fail count.
  const scan = staticResultReads(path.resolve(__dirname, '../src/ai'));
  for (const ledger of [result.replay, result.selfplay]) {
    ledger.record('INV-B3', { violated: scan.length > 0 });
  }

  out.push('');
  out.push(result.replay.formatTable('Replay (bot at the human decision points; human column = the human\'s own decision)', true));
  out.push('');
  out.push(result.probe.formatTable('Probe (every loyal seat as leader at the first proposal of R2..R5)', false));
  out.push('');
  out.push(result.selfplay.formatTable('Self-play', false));
  out.push('');
  const e = result.l1EmptyGames;
  out.push(`INV-W2 L1-empty fallbacks: replay ${e.replay}/${e.replayGames} games; self-play ${e.selfplay}/${e.selfplayGames} games`);
  out.push(`INV-B3 static scan: ${scan.length} reads of a mission result without its fail count (${[...new Set(scan.map((s) => s.file))].join(', ') || 'none'})`);
  out.push(`ForwardAgent fallbacks: replay ${result.replay.get('forward.fallbacks')}, probe ${result.probe.get('forward.fallbacks')}, self-play ${result.selfplay.get('forward.fallbacks')}`);
  out.push(`probe (audit "HARD" model): must fail ${result.probe.get('X5chk.provablyFailable')}/${result.probe.get('X5chk.n')}, holds a certain red ${result.probe.get('X5chk.provablyTainted')}/${result.probe.get('X5chk.n')}`);
  out.push(`elapsed ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (args.diag) {
    for (const [label, ledger] of [['replay', result.replay], ['probe', result.probe], ['selfplay', result.selfplay]] as const) {
      out.push('');
      out.push(`## diagnostics: ${label}`);
      for (const [k, v] of Object.entries(ledger.toJSON().diag)) out.push(`${k}\t${v}`);
    }
  }
  const text = out.join('\n');
  console.log(text);
  if (args.md) fs.writeFileSync(args.md, `${text}\n`);
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      tuning: describeAgentTuning(tuning),
      replay: result.replay.toJSON(),
      probe: result.probe.toJSON(),
      selfplay: result.selfplay.toJSON(),
      l1EmptyGames: result.l1EmptyGames,
      staticB3: scan,
    }, null, 2));
  }
}

if (require.main === module) {
  // GameEngine leaves its AFK timers behind after a self-play game; exit explicitly.
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
