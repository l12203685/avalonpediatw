/**
 * INV-B3 (static, C5): agent code must not read a mission's `result` without
 * its `failCount` — "success" does not mean "no fail card" (an R4 success can
 * carry one: 219 of 1177 R4 missions in the 牌譜), and a failed mission's
 * fail count says how many reds it had (C2).
 *
 * The scan lists every line under `src/ai` (tests, the agreement benchmark's
 * own baselines and this harness excluded) that compares a `.result` with
 * 'fail' / 'success' and does not mention `failCount` on the same line.
 * Batch 1C (S1-1, 2026-10-22) rewrote every reader: the fail cards come
 * from `missionFacts.failCards` / `beliefFailCards`, and the public outcome
 * (the score, display text, trained-model features) from
 * `missionFacts.missionFailed` — so `missionFacts.ts`, the one sanctioned
 * definition of the outcome read, is the only file left out of the scan.
 * The rule is enforced at 0.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StaticHit {
  /** Path relative to `src/ai`. */
  file: string;
  line: number;
}

const RESULT_READ = /\.result\s*(===|!==|==|!=)\s*'(fail|success)'/;

/** The single place the outcome read is defined (see the module comment). */
const SANCTIONED_FILES: ReadonlySet<string> = new Set(['missionFacts.ts']);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'benchmark' || entry.name === 'invariants') continue;
      walk(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
}

/** Lines of agent code that read a mission result without its fail count. */
export function staticResultReads(aiDir: string): StaticHit[] {
  const files: string[] = [];
  walk(aiDir, files);
  const hits: StaticHit[] = [];
  for (const f of files.sort()) {
    const rel = path.relative(aiDir, f).split(path.sep).join('/');
    if (SANCTIONED_FILES.has(rel)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (RESULT_READ.test(text) && !text.includes('failCount')) {
        hits.push({ file: rel, line: i + 1 });
      }
    });
  }
  return hits;
}
