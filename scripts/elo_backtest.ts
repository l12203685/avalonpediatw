/**
 * elo_backtest.ts — #54 Phase 3 historical replay
 *
 * Runs the ELO pipeline over a set of GameRecord inputs twice:
 *   1. Legacy mode    (attributionMode='legacy')    — Phase 1 behaviour
 *   2. Per-event mode (attributionMode='per_event') — Phase 2 / 2.5
 *
 * Produces a per-player comparison report so Edward can decide whether
 * per_event is worth flipping live. The script is PURE w.r.t. Firestore /
 * Firebase: it mocks the `rankings` path with an in-memory ledger and runs
 * `EloRankingService.processGameResult` in sequence. This lets us replay a
 * 2000+ game dataset locally without hitting prod.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   # Replay from a JSON dump of GameRecord[]
 *   npx tsx scripts/elo_backtest.ts --input /path/to/games.json
 *
 *   # Replay from a CSV (header: gameId,winner,winReason,...)
 *   npx tsx scripts/elo_backtest.ts --input /path/to/games.csv --format csv
 *
 *   # Replay from synthetic self-play (generated inline, 100 games)
 *   npx tsx scripts/elo_backtest.ts --synthetic 100
 *
 *   # Limit / dry-run (no file write)
 *   npx tsx scripts/elo_backtest.ts --input games.json --limit 500 --stdout
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *
 * Default: writes `backtest_report_<timestamp>.json` next to the input, with
 *   - playerCount
 *   - legacyFinalElo[]       sorted desc
 *   - perEventFinalElo[]     sorted desc
 *   - divergenceMetrics:
 *       samePlayerEloStdLegacy     (cross-game volatility)
 *       samePlayerEloStdPerEvent
 *       topK overlap                (how many of top-20 match)
 *       avgAbsDelta
 *   - topMovers[]            players whose rank shifted >= 5 positions
 *
 * This file does NOT write to Firestore or the live `rankings` RTDB path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { setEloConfig, DEFAULT_ELO_CONFIG } from '../packages/server/src/services/EloConfig';
import { computeNewElo, expectedScore } from '../packages/server/src/services/EloRanking';
import { computeAttributionDeltas } from '../packages/server/src/services/EloAttributionService';
import type {
  GameRecord,
  GamePlayerRecord,
} from '../packages/server/src/services/GameHistoryRepository';
import type { EloOutcome } from '../packages/server/src/services/EloConfig';
import { deriveEloOutcome } from '../packages/server/src/services/EloConfig';

// ---------------------------------------------------------------------------
// In-memory ELO ledger
// ---------------------------------------------------------------------------

interface LedgerEntry {
  elo: number;
  games: number;
  wins: number;
  losses: number;
}

class EloLedger {
  private book: Map<string, LedgerEntry> = new Map();

  constructor(private readonly startingElo: number, private readonly minElo: number) {}

  get(uid: string): number {
    return this.book.get(uid)?.elo ?? this.startingElo;
  }

  apply(uid: string, newElo: number, won: boolean): void {
    const entry = this.book.get(uid) ?? {
      elo: this.startingElo,
      games: 0,
      wins: 0,
      losses: 0,
    };
    entry.elo = Math.max(this.minElo, newElo);
    entry.games += 1;
    if (won) entry.wins += 1;
    else entry.losses += 1;
    this.book.set(uid, entry);
  }

  snapshot(): Record<string, LedgerEntry> {
    const out: Record<string, LedgerEntry> = {};
    for (const [uid, entry] of this.book.entries()) {
      out[uid] = { ...entry };
    }
    return out;
  }

  allPlayers(): string[] {
    return Array.from(this.book.keys());
  }
}

// ---------------------------------------------------------------------------
// Pure replay — does not hit Firestore / RTDB
// ---------------------------------------------------------------------------

interface ReplayOutput {
  /** Final in-memory ledger after replaying all games. */
  ledger: Record<string, LedgerEntry>;
  /** Per-game per-player delta trajectory for variance analysis. */
  deltas: Array<{ gameId: string; uid: string; delta: number; elo: number }>;
}

function replay(records: GameRecord[], mode: 'legacy' | 'per_event'): ReplayOutput {
  // Reset config each replay to guarantee clean state.
  setEloConfig({ attributionMode: mode });
  const cfg = { ...DEFAULT_ELO_CONFIG, attributionMode: mode };
  const ledger = new EloLedger(cfg.startingElo, cfg.minElo);
  const deltas: ReplayOutput['deltas'] = [];

  for (const rec of records) {
    const outcome: EloOutcome = deriveEloOutcome(rec.winner, rec.winReason);
    const attribution = computeAttributionDeltas(rec);

    const goodElos: number[] = [];
    const evilElos: number[] = [];
    for (const p of rec.players) {
      const e = ledger.get(p.playerId);
      if (p.team === 'good') goodElos.push(e);
      else if (p.team === 'evil') evilElos.push(e);
    }
    const avg = (arr: number[], team: 'good' | 'evil'): number =>
      arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : cfg.teamBaselines[team];
    const goodAvg = avg(goodElos, 'good');
    const evilAvg = avg(evilElos, 'evil');

    for (const p of rec.players) {
      const prev = ledger.get(p.playerId);
      const opponentAvg = p.team === 'good' ? evilAvg : goodAvg;
      const legacyNewElo = computeNewElo(
        prev,
        p.won,
        opponentAvg,
        p.role,
        undefined,
        outcome
      );
      const attrDelta = attribution.applied ? (attribution.deltas[p.playerId] ?? 0) : 0;
      const combined = Math.round(legacyNewElo + attrDelta);
      const newElo = Math.max(cfg.minElo, combined);
      ledger.apply(p.playerId, newElo, p.won);
      deltas.push({
        gameId: rec.gameId,
        uid: p.playerId,
        delta: newElo - prev,
        elo: newElo,
      });
    }
  }

  return { ledger: ledger.snapshot(), deltas };
}

// ---------------------------------------------------------------------------
// Divergence metrics
// ---------------------------------------------------------------------------

interface DivergenceReport {
  playerCount: number;
  gamesReplayed: number;
  legacy: { top20: Array<{ uid: string; elo: number }>; avgElo: number; std: number };
  perEvent: { top20: Array<{ uid: string; elo: number }>; avgElo: number; std: number };
  /** Kendall-tau-ish: how many of the top-20 lists overlap by uid. */
  top20Overlap: number;
  /** Average |legacyElo - perEventElo| across all shared players. */
  avgAbsEloDiff: number;
  /** Max rank shift (any player's rank difference between two ladders). */
  maxRankShift: number;
  topMovers: Array<{
    uid: string;
    legacyRank: number;
    perEventRank: number;
    legacyElo: number;
    perEventElo: number;
    rankDelta: number;
  }>;
  /** Per-player variance of deltas — stability indicator. */
  deltaVariance: { legacy: number; perEvent: number };
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeDeltaVariance(
  deltas: Array<{ uid: string; delta: number }>
): number {
  const byPlayer = new Map<string, number[]>();
  for (const d of deltas) {
    const arr = byPlayer.get(d.uid) ?? [];
    arr.push(d.delta);
    byPlayer.set(d.uid, arr);
  }
  // Player-level std, averaged — lower = more consistent.
  const stds: number[] = [];
  for (const arr of byPlayer.values()) {
    if (arr.length >= 3) stds.push(stddev(arr));
  }
  if (stds.length === 0) return 0;
  return stds.reduce((s, v) => s + v, 0) / stds.length;
}

function buildLadder(
  ledger: Record<string, LedgerEntry>
): Array<{ uid: string; elo: number; rank: number }> {
  const entries = Object.entries(ledger).map(([uid, e]) => ({ uid, elo: e.elo }));
  entries.sort((a, b) => b.elo - a.elo);
  return entries.map((e, idx) => ({ ...e, rank: idx + 1 }));
}

function compareReplays(
  legacy: ReplayOutput,
  perEvent: ReplayOutput,
  gamesReplayed: number
): DivergenceReport {
  const legacyLadder = buildLadder(legacy.ledger);
  const perEventLadder = buildLadder(perEvent.ledger);

  const legacyTop20 = legacyLadder.slice(0, 20);
  const perEventTop20 = perEventLadder.slice(0, 20);
  const top20Uids = new Set(legacyTop20.map((e) => e.uid));
  const top20Overlap = perEventTop20.filter((e) => top20Uids.has(e.uid)).length;

  const uids = new Set<string>([
    ...Object.keys(legacy.ledger),
    ...Object.keys(perEvent.ledger),
  ]);

  let absDiffSum = 0;
  let absDiffN = 0;
  let maxRankShift = 0;
  const legacyRankMap = new Map(legacyLadder.map((e) => [e.uid, e.rank]));
  const perEventRankMap = new Map(perEventLadder.map((e) => [e.uid, e.rank]));
  const movers: DivergenceReport['topMovers'] = [];

  for (const uid of uids) {
    const l = legacy.ledger[uid]?.elo;
    const p = perEvent.ledger[uid]?.elo;
    if (typeof l === 'number' && typeof p === 'number') {
      absDiffSum += Math.abs(l - p);
      absDiffN += 1;
    }
    const lRank = legacyRankMap.get(uid);
    const pRank = perEventRankMap.get(uid);
    if (typeof lRank === 'number' && typeof pRank === 'number') {
      const shift = Math.abs(lRank - pRank);
      if (shift > maxRankShift) maxRankShift = shift;
      if (shift >= 5 && typeof l === 'number' && typeof p === 'number') {
        movers.push({
          uid,
          legacyRank: lRank,
          perEventRank: pRank,
          legacyElo: l,
          perEventElo: p,
          rankDelta: pRank - lRank,
        });
      }
    }
  }

  movers.sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta));

  const legacyElos = legacyLadder.map((e) => e.elo);
  const perEventElos = perEventLadder.map((e) => e.elo);
  const avg = (arr: number[]): number =>
    arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  return {
    playerCount: uids.size,
    gamesReplayed,
    legacy: {
      top20: legacyTop20,
      avgElo: avg(legacyElos),
      std: stddev(legacyElos),
    },
    perEvent: {
      top20: perEventTop20,
      avgElo: avg(perEventElos),
      std: stddev(perEventElos),
    },
    top20Overlap,
    avgAbsEloDiff: absDiffN > 0 ? absDiffSum / absDiffN : 0,
    maxRankShift,
    topMovers: movers.slice(0, 20),
    deltaVariance: {
      legacy: computeDeltaVariance(legacy.deltas),
      perEvent: computeDeltaVariance(perEvent.deltas),
    },
  };
}

// ---------------------------------------------------------------------------
// Input loaders
// ---------------------------------------------------------------------------

function loadFromJson(file: string): GameRecord[] {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`Expected JSON array of GameRecord, got ${typeof data}`);
  }
  return data as GameRecord[];
}

function loadFromCsv(file: string): GameRecord[] {
  // Minimal CSV support — full Sheets import still goes through
  // scripts/import-games.ts. This is a quick path for ad-hoc replays.
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const records: GameRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = (cols[idx] ?? '').trim();
    });
    records.push(rowToGameRecord(row));
  }
  return records;
}

function rowToGameRecord(row: Record<string, string>): GameRecord {
  // Optimistic mapping — expects the columns emitted by a future
  // `export-games.ts` companion script. Missing columns fall back to
  // sensible defaults so replay still works on partial data.
  return {
    gameId: row.gameId ?? '',
    roomName: row.roomName ?? '',
    playerCount: Number(row.playerCount ?? 0),
    winner: (row.winner as 'good' | 'evil') ?? 'good',
    winReason: row.winReason ?? '',
    questResults: [],
    duration: Number(row.duration ?? 0),
    players: JSON.parse(row.players ?? '[]') as GamePlayerRecord[],
    createdAt: Number(row.createdAt ?? 0),
    endedAt: Number(row.endedAt ?? 0),
    voteHistoryPersisted: row.voteHistory ? JSON.parse(row.voteHistory) : undefined,
    questHistoryPersisted: row.questHistory ? JSON.parse(row.questHistory) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Synthetic self-play generator (POC)
// ---------------------------------------------------------------------------

function generateSyntheticRecords(n: number): GameRecord[] {
  const out: GameRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const goodWins = Math.random() < 0.52;
    const merlinKill = goodWins && Math.random() < 0.4;
    const players: GamePlayerRecord[] = [];
    const numPlayers = 7;
    const evilCount = 3;
    for (let p = 0; p < numPlayers; p += 1) {
      const isEvil = p < evilCount;
      players.push({
        playerId: `bot_${p % 10}_${Math.floor(i / 100)}`,
        displayName: `bot_${p}`,
        role: p === 3 ? 'merlin' : p === 0 ? 'assassin' : p === 1 ? 'morgana' : 'loyal',
        team: isEvil ? 'evil' : 'good',
        won: isEvil ? !goodWins : goodWins,
      });
    }
    out.push({
      gameId: `synth_${i}`,
      roomName: 'synth',
      playerCount: numPlayers,
      winner: goodWins ? 'good' : 'evil',
      winReason: merlinKill ? 'assassination_success' : goodWins ? 'assassination_failed' : 'failed_quests',
      questResults: [],
      duration: 600_000,
      players,
      createdAt: Date.now() - i * 3600_000,
      endedAt: Date.now() - i * 3600_000 + 600_000,
      voteHistoryPersisted: undefined,
      questHistoryPersisted: undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  input?: string;
  format: 'json' | 'csv';
  synthetic?: number;
  limit?: number;
  stdout: boolean;
  output?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { format: 'json', stdout: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--format') args.format = argv[++i] as 'json' | 'csv';
    else if (a === '--synthetic') args.synthetic = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--stdout') args.stdout = true;
    else if (a === '--output') args.output = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  let records: GameRecord[];

  if (args.synthetic) {
    records = generateSyntheticRecords(args.synthetic);
    console.log(`Generated ${records.length} synthetic games`);
  } else if (args.input) {
    if (args.format === 'csv') records = loadFromCsv(args.input);
    else records = loadFromJson(args.input);
    console.log(`Loaded ${records.length} games from ${args.input}`);
  } else {
    throw new Error('Provide --input <file> or --synthetic <n>');
  }

  if (args.limit && args.limit > 0) {
    records = records.slice(0, args.limit);
    console.log(`Limited to ${records.length} games`);
  }

  console.log('Replaying legacy mode ...');
  const legacyResult = replay(records, 'legacy');
  console.log('Replaying per_event mode ...');
  const perEventResult = replay(records, 'per_event');

  const report = compareReplays(legacyResult, perEventResult, records.length);

  if (args.stdout) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const outPath =
    args.output ??
    path.join(
      args.input ? path.dirname(args.input) : process.cwd(),
      `backtest_report_${Date.now()}.json`
    );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Report written to ${outPath}`);
  console.log(
    `[summary] players=${report.playerCount} games=${report.gamesReplayed} top20Overlap=${report.top20Overlap}/20 avgAbsEloDiff=${report.avgAbsEloDiff.toFixed(2)} maxRankShift=${report.maxRankShift}`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { replay, compareReplays, generateSyntheticRecords };
export type { DivergenceReport, ReplayOutput };
