/**
 * Invariant harness — CI sample (logic-first plan §5.2; docs/ai/logic_first.md).
 *
 * 60 fixed replay games (the first 60 replayable games of the 牌譜, with the
 * loyal-leader probe) and 30 self-play games (seeds 7101 / 7102 / 7103, ten
 * games each), production default tuning; since the 2026-10-26 review also
 * 5-, 7- and 9-player self-play (seeds 7101 / 7102, five games each) and
 * 8-player games with Percival switched off in the lobby (seeds 7101 / 7102,
 * five games each; the only role switch the engine's canonical 7-role lock
 * accepts) — the plan's M8 coverage (the 7-player games exercise the Mordred
 * assassinator). Asserts:
 *   - every `enforced` invariant has 0 violations (the static INV-B3 scan
 *     included);
 *   - every `pending:<batch>` invariant has no more violations than the
 *     baseline below (a ratchet: the batch that fixes it lowers the number to
 *     0 and flips the catalog entry to `enforced`; since batches 1E / 1F
 *     no rule is pending — the ratchet stays for the next new rule);
 *   - the registered exemptions are counted (the R1–R2 normal-vote rule);
 *   - 0 ForwardAgent fallbacks.
 * The full run (all 1970 replays + 2000 self-play games) is
 * `scripts/invariantHarness.ts`; its first run reproduces the logic audit's
 * counts (docs/ai/logic_first.md §4).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING } from '../AgentTuning';
import { parseReplayGame, rowsFromSheet, type ReplayGame } from '../benchmark/sheetsReplay';
import { INVARIANTS } from './catalog';
import { auditReplayGame, auditSelfPlay, emptyResult, type HarnessResult } from './sources';
import { staticResultReads } from './staticScan';

/**
 * Bot violations of the pending invariants on this sample at the 2026-10-22
 * baseline (batch 1D, production default). Lower is fine (update the number);
 * higher fails.
 *
 * History: the 2026-10-14 baseline (batch 1A/1B) was replay T1 7 / V1 13 /
 * K1 7 / K2 1 / B1 200 / B2 654 / H3a 105 / H3b 40 / F0 1134 / Pe1 4 / Pe2 152
 * / PL 20, probe T1 68 / K1 30 / K2 4, self-play T1 20 / V1 45 / K1 2 / B1
 * 102 / B2 506 / H3a 46 / H3b 9 / F0 474 / Pe1 1 / Pe2 62 / PL 7 / R1 5, and
 * 27 static INV-B3 reads. Batch 1C brought B1 / B2 / B3 / H3a / H3b / F0 to 0
 * (enforced) and left replay T1 2 / V1 15 / K1 4 / K2 1 / Pe1 4, probe T1 4 /
 * K1 6 / K2 1, self-play T1 1 / V1 7 / K2 1 / Pe1 1 (V1 15: teams that must
 * fail as a set, no single certain seat). Batch 1D's gates (LogicGates.ts)
 * brought T1 / V1 / K1 / K2 / P3 / L1, the new K1V and Pe1 to 0 on this
 * sample and on the full run (all 1970 replays, the probe, 2000 self-play
 * games) — all enforced now. Self-play INV-PL (batch 1E's) reads 7 when this
 * file runs alone and 6 inside the full vitest run; the ratchet kept 7
 * (2026-10-26 review: not reproducible. The file alone and inside the full
 * vitest run print the same INV-PL counts at the batch-1D commit (7 and 7)
 * and at the batch-1E / 1F commit (6 opportunities, 0 violations, both), and
 * identical tables on the review commit, with or without
 * USE_FORWARD_REASONING — vitest isolates each file and the AuditAgent calls
 * the ForwardAgent directly. The "6" most likely came from a full run on the
 * 1E / 1F working tree while its Percival switches were already in, not from
 * state leaking between tests; docs/ai/logic_first.md 第 10 節).
 * Batch 1D left replay Pe2 149 / PL 20 / R1 0, self-play Pe2 49 / PL 7 /
 * R1 4; batches 1E / 1F (Percival = loyal + thumb constraint, blue lake;
 * red possible claims only) brought all three to 0 here and on the full
 * run — enforced. Batch 1G added INV-A2 (the assassination tier) and
 * brought it to 0 here and on the full run (enforced; before the batch:
 * replay 6 of 22, self-play 0 of 3 on this sample). Nothing is pending now.
 */
const PENDING_BASELINE: Record<'replay' | 'probe' | 'selfplay', Record<string, number>> = {
  replay: {},
  probe: {},
  selfplay: {},
};

function loadGames(n: number): ReplayGame[] {
  const cache = path.resolve(__dirname, '../../../sheets_cache.json');
  const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
  const games: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (games.length >= n) break;
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (r.ok) games.push(r.game);
  }
  return games;
}

describe('invariant harness — CI sample', () => {
  it('enforced rules hold, pending rules do not regress, exemptions are counted', async () => {
    const tuning = { ...DEFAULT_AGENT_TUNING };
    const result: HarnessResult = emptyResult();
    for (const g of loadGames(60)) auditReplayGame(g, { tuning, observationChecks: true, probe: true }, result);
    for (const seed of [7101, 7102, 7103]) {
      await auditSelfPlay({ tuning, seed, games: 10, playerCount: 10, observationChecks: true }, result);
    }
    // Plan M8 (2026-10-26 review): other player counts and a lobby role switch.
    for (const playerCount of [5, 7, 9]) {
      for (const seed of [7101, 7102]) await auditSelfPlay({ tuning, seed, games: 5, playerCount, observationChecks: true }, result);
    }
    for (const seed of [7101, 7102]) {
      await auditSelfPlay({ tuning, seed, games: 5, playerCount: 8, observationChecks: true, roleToggles: { percival: false } }, result);
    }

    // Aggregates only.
    process.stdout.write(`${[
      result.replay.formatTable('CI replay (60 games)', true),
      result.probe.formatTable('CI probe', false),
      result.selfplay.formatTable('CI self-play (30 ten-player games + 5/7/9-player and 8-player Percival-off games)', false),
      `L1-empty games: replay ${result.l1EmptyGames.replay}/${result.l1EmptyGames.replayGames}, self-play ${result.l1EmptyGames.selfplay}/${result.l1EmptyGames.selfplayGames}`,
    ].join('\n\n')}\n`);

    for (const source of ['replay', 'probe', 'selfplay'] as const) {
      const ledger = result[source];
      expect(ledger.get('forward.fallbacks')).toBe(0);
      for (const spec of INVARIANTS) {
        const t = ledger.tallies.get(spec.id);
        if (!t) continue;
        if (spec.status === 'enforced') {
          expect({ source, id: spec.id, violations: t.violations }).toEqual({ source, id: spec.id, violations: 0 });
        } else if (spec.kind !== 'static') {
          expect(PENDING_BASELINE[source][spec.id], `${source} ${spec.id} has a baseline`).toBeDefined();
          expect(t.violations, `${source} ${spec.id}`).toBeLessThanOrEqual(PENDING_BASELINE[source][spec.id]);
        }
      }
    }
    // The registered R1–R2 normal-vote exemption is counted, not hidden.
    expect(result.replay.tallies.get('INV-V1')?.exempt['R1-R2 normal vote (D3)'] ?? 0).toBeGreaterThan(0);
    // The batch-1D gates have something to gate on this sample (opportunities, not exemptions only).
    for (const id of ['INV-T1', 'INV-V1', 'INV-K1', 'INV-K1V']) {
      expect(result.replay.tallies.get(id)?.opportunities ?? 0, `replay ${id} opportunities`).toBeGreaterThan(0);
    }
    expect(result.selfplay.tallies.get('INV-M1')?.exempt['R1-R2 normal vote (D3)'] ?? 0).toBeGreaterThan(0);
    // The batch-1E / 1F rules have opportunities on this sample (Percival's
    // team exclusions and lakes, red claims), not only exemptions.
    for (const id of ['INV-PL', 'INV-R1']) {
      expect(result.replay.tallies.get(id)?.opportunities ?? 0, `replay ${id} opportunities`).toBeGreaterThan(0);
      expect(result.selfplay.tallies.get(id)?.opportunities ?? 0, `self-play ${id} opportunities`).toBeGreaterThan(0);
    }
    // Batch 1G: the assassination tier has opportunities (some candidate certainly
    // proposed a seen red, not every one did) on the replays and in self-play.
    expect(result.replay.tallies.get('INV-A2')?.opportunities ?? 0, 'replay INV-A2 opportunities').toBeGreaterThan(0);
    expect(result.selfplay.tallies.get('INV-A2')?.opportunities ?? 0, 'self-play INV-A2 opportunities').toBeGreaterThan(0);
    // Review 2026-10-26: the 7-player Mordred assassinates (it used to be
    // skipped), the other player counts and the Mordred-off lobby ran, and
    // Percival's lake has a behavioural check (INV-PL2).
    expect(result.selfplay.get('A.7p.mordred'), '7-player Mordred assassinations').toBeGreaterThan(0);
    for (const k of ['games.5p', 'games.7p', 'games.9p', 'games.8p.percivalOff']) expect(result.selfplay.get(k), k).toBeGreaterThan(0);
    expect(result.selfplay.get('A2.rosterMismatch')).toBe(0);
    expect(result.replay.get('A2.rosterMismatch')).toBe(0);
    for (const src of ['replay', 'selfplay'] as const) {
      expect(result[src].tallies.get('INV-PL2')?.opportunities ?? 0, `${src} INV-PL2 opportunities`).toBeGreaterThan(0);
    }
    const pe2 = result.replay.tallies.get('INV-Pe2');
    expect((pe2?.opportunities ?? 0) - Object.values(pe2?.exempt ?? {}).reduce((a, b) => a + b, 0), 'replay INV-Pe2 non-exempt').toBeGreaterThan(0);
    // INV-B3 (static), enforced since batch 1C: no agent code reads a mission result without its fail count.
    expect(staticResultReads(path.resolve(__dirname, '..'))).toEqual([]);
  }, 300_000);
});
