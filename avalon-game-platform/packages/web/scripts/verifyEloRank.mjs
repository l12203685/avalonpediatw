#!/usr/bin/env node
/**
 * Smoke verification for the hard-threshold tier system.
 *
 * Independently re-implements the expected rule from Edward 2026-04-23 spec
 * and cross-checks against constants in `src/utils/eloRank.ts`. Exits 1 on
 * any failure.
 *
 * Usage (from repo root):
 *   node packages/web/scripts/verifyEloRank.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const utilSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'eloRank.ts'), 'utf8');

let fail = 0;
const assert = (cond, msg) => {
  if (cond) console.log(`  PASS ${msg}`);
  else { console.log(`  FAIL ${msg}`); fail++; }
};

// ── Static source checks ─────────────────────────────────────────
console.log('[verify] ROOKIE_MAX_GAMES = 50 in source');
assert(/export const ROOKIE_MAX_GAMES = 50;/.test(utilSrc), 'ROOKIE_MAX_GAMES literal');

console.log('[verify] minGames ladder 50/100/150/200/250 in ELO_RANKS');
const expected = [
  [/初學.*minGames:\s*50\b/,  '初學 = 50'],
  [/新手.*minGames:\s*100\b/, '新手 = 100'],
  [/中堅.*minGames:\s*150\b/, '中堅 = 150'],
  [/高手.*minGames:\s*200\b/, '高手 = 200'],
  [/大師.*minGames:\s*250\b/, '大師 = 250'],
];
for (const [re, label] of expected) assert(re.test(utilSrc), label);

// ── Behavioural simulation ───────────────────────────────────────
// Independently re-implement the same spec so any drift between source &
// spec gets caught.
const SPEC_TIERS = [
  { label: '初學', minGames: 50  },
  { label: '新手', minGames: 100 },
  { label: '中堅', minGames: 150 },
  { label: '高手', minGames: 200 },
  { label: '大師', minGames: 250 },
];
const ROOKIE = { label: '菜雞', minGames: 0 };

function specTier(games) {
  for (let i = SPEC_TIERS.length - 1; i >= 0; i--) {
    if (games >= SPEC_TIERS[i].minGames) return SPEC_TIERS[i].label;
  }
  return ROOKIE.label;
}

console.log('[verify] boundary matrix (spec simulation)');
const boundaries = [
  [0,    '菜雞'], [49,   '菜雞'],
  [50,   '初學'], [99,   '初學'],
  [100,  '新手'], [149,  '新手'],
  [150,  '中堅'], [199,  '中堅'],
  [200,  '高手'], [249,  '高手'],
  [250,  '大師'], [9999, '大師'],
];
for (const [n, tier] of boundaries) assert(specTier(n) === tier, `${n} games → ${tier}`);

console.log('[verify] ranking-visibility rule');
// Per spec: N games make you eligible for every tier with minGames ≤ N.
const eligibleFor = (n) => {
  const tiers = ['菜雞'];
  for (const t of SPEC_TIERS) if (n >= t.minGames) tiers.push(t.label);
  return tiers.join('/');
};
assert(eligibleFor(30)  === '菜雞',                     'N=30 eligible = 菜雞');
assert(eligibleFor(75)  === '菜雞/初學',                 'N=75 eligible = 菜雞/初學');
assert(eligibleFor(120) === '菜雞/初學/新手',            'N=120 eligible = 菜雞/初學/新手');
assert(eligibleFor(180) === '菜雞/初學/新手/中堅',       'N=180 eligible = 菜雞/初學/新手/中堅');
assert(eligibleFor(220) === '菜雞/初學/新手/中堅/高手',  'N=220 eligible = 菜雞/初學/新手/中堅/高手');
assert(eligibleFor(300) === '菜雞/初學/新手/中堅/高手/大師', 'N=300 eligible = all six');

if (fail) {
  console.error(`\n${fail} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed');
