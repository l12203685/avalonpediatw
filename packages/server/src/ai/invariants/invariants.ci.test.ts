/**
 * Invariant harness — CI sample (logic-first plan §5.2; docs/ai/logic_first.md).
 *
 * 60 fixed replay games (the first 60 replayable games of the 牌譜, with the
 * loyal-leader probe) and 30 self-play games (seeds 7101 / 7102 / 7103, ten
 * games each), production default tuning. Asserts:
 *   - every `enforced` invariant has 0 violations (the static INV-B3 scan
 *     included);
 *   - every `pending:<batch>` invariant has no more violations than the
 *     baseline below (a ratchet: the batch that fixes it lowers the number to
 *     0 and flips the catalog entry to `enforced`; after batch 1D only the
 *     batch-1E / 1F rules are pending);
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
 * file runs alone and 6 inside the full vitest run; the ratchet keeps 7.
 */
const PENDING_BASELINE: Record<'replay' | 'probe' | 'selfplay', Record<string, number>> = {
  replay: { 'INV-Pe2': 149, 'INV-PL': 20, 'INV-R1': 0 },
  probe: { 'INV-Pe2': 0, 'INV-PL': 0, 'INV-R1': 0 },
  selfplay: { 'INV-Pe2': 49, 'INV-PL': 7, 'INV-R1': 4 },
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

    // Aggregates only.
    process.stdout.write(`${[
      result.replay.formatTable('CI replay (60 games)', true),
      result.probe.formatTable('CI probe', false),
      result.selfplay.formatTable('CI self-play (30 games)', false),
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
    // INV-B3 (static), enforced since batch 1C: no agent code reads a mission result without its fail count.
    expect(staticResultReads(path.resolve(__dirname, '..'))).toEqual([]);
  }, 120_000);
});
