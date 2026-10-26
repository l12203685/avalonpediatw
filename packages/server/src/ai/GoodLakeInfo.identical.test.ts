/**
 * S1-0 regression (2026-10-14, docs/ai/logic_first.md): `GoodLakeInfo` now
 * takes its possible worlds from the shared certainty layer
 * (`belief/Certainty.enumerateWorlds`). Its analyses — every candidate's
 * pEvil, common-picture prior, information gain, trust term and score, and
 * the pick — must be bit-for-bit what they were before the refactor, on
 * every lake decision point of every replayable game of the 牌譜 (all 1970
 * games, the 1913 lake-legal ones included), for the full legal target list
 * and for the thumb-free list Percival's caller passes.
 *
 * The digest was the SHA-256 of the same dump produced at lane/r6-percival
 * 7c005d7 (before the refactor): 7442 decision points, 10 of them with no
 * consistent world (`null`, unchanged) — c7bc6137…fad8.
 *
 * 2026-10-26 (Edward: A1 no stalling after two fails, A2 還湖 at L1): the dump
 * changes exactly where a convention applies. Checked once against the dump
 * before A1 / A2 (which still matched c7bc6137…): 1508 of the 7442 points
 * changed (659 picks), every one of them at a decision point where
 * `noStallCaps` or `admittedReds` is non-empty; none elsewhere. The digest
 * below is the dump after A1 / A2.
 */
import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame } from './benchmark/sheetsReplay';
import { buildReplayObservation, seatId, validLakeTargetSeats } from './benchmark/replayObservation';
import { analyzeGoodLake, pickGoodLakeTargetInfoMax } from './GoodLakeInfo';

const DIGEST_BEFORE_REFACTOR = '1965add6d17f58828fccc92e50bde6698b96612d121e688e5315107912831fe7';

describe('GoodLakeInfo — identical analyses after the certainty-layer refactor', () => {
  it('every lake decision point of the 牌譜 reproduces the pre-refactor analysis exactly', () => {
    const cache = path.resolve(__dirname, '../../sheets_cache.json');
    const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
    const lines: string[] = [];
    let legal = 0;
    let nulls = 0;
    for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
      if (!(row['文字記錄'] ?? '').trim()) continue;
      const r = parseReplayGame(row);
      if (!r.ok) continue;
      const g = r.game;
      if (g.lakeChainValid) legal++;
      for (let li = 0; li < g.lakes.length; li++) {
        const lake = g.lakes[li];
        const obs = buildReplayObservation(g, lake.holderSeat, { kind: 'lake', lake: li });
        const cands = validLakeTargetSeats(g, li).map(seatId);
        const thumbs = new Set<string>(obs.knownWizards ?? []);
        for (const [tag, pool] of [['all', cands], ['nothumb', cands.filter((c) => !thumbs.has(c))]] as Array<[string, string[]]>) {
          if (pool.length === 0) continue;
          const a = analyzeGoodLake(obs, pool);
          const pick = pickGoodLakeTargetInfoMax(obs, pool);
          if (!a) nulls++;
          lines.push(JSON.stringify([
            g.lakeChainValid ? 1 : 0, li, tag, pick,
            a ? [a.trustWeight, a.uncertainty, a.droppedLakes, a.candidates.map((c) => [c.id, c.pEvil, c.pEvilCommon, c.infoGain, c.trust, c.score, c.wentOnMission])] : null,
          ]));
        }
      }
    }
    expect(legal).toBe(1913);
    expect(lines).toHaveLength(7442);
    expect(nulls).toBe(10);
    const digest = crypto.createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex');
    expect(digest).toBe(DIGEST_BEFORE_REFACTOR);
  }, 60_000);
});
