/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * Evil Lady-of-the-Lake study — how do human red holders use the lake?
 *
 *   pnpm --filter @avalon/server exec tsx scripts/evilLakeStudy.ts \
 *     [--player ED --player Sin] [--json out.json] [--cache PATH]
 *
 * Reads `sheets_cache.json` → `牌譜` with the same strict replay parser the
 * agreement benchmark uses (`parseReplayGame`, only games whose lake chain
 * is valid) and, for every lake held by a red seat, records:
 *   (a) target choice — visible teammate vs blue (vs the hidden Oberon) when
 *       at least one visible teammate was a legal target, by lake index and
 *       by role;
 *   (b) declaration — teammate → o / x; blue target → x (lie) / o (truth);
 *   (c) state features that predict choosing a blue target, and that predict
 *       the truthful-blue declaration;
 *   (d) descriptive final-win rate per strategy (confounded — the strategy
 *       is chosen in response to the state).
 * Oberon holders (see nobody, nobody sees them) are reported separately.
 *
 * Every rate is printed with n and a Wilson 95% interval. Output is
 * aggregate only; `--player NAME` adds per-player rows (local use only —
 * do not paste player rows into CI logs or the public docs).
 *
 * Edward 2026-10-13 ruling: red holder should, as far as possible, lake a
 * visible teammate and declare them blue (keeps the lake on the red side);
 * tactical exceptions: lake a blue and declare red (confusion) or lake a
 * blue and truthfully declare blue (goodwill).
 */

import * as fs from 'fs';
import * as path from 'path';
import { rowsFromSheet, parseReplayGame, campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId, validLakeTargetSeats } from '../src/ai/benchmark/replayObservation';
import { computeTopPerformers, cohortKey } from '../src/ai/benchmark/cohorts';
import { estimateSuspicionFromHistory, estimateMerlinLikenessFromHistory } from '../src/ai/LakePolicy';
import { leaderSeatForProposal } from '../src/services/sheetsGameRecordParser';

interface Args {
  players: string[];
  json?: string;
  cache: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { players: [], cache: path.resolve(__dirname, '..', 'sheets_cache.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--player': args.players.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
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

export interface Rate {
  k: number;
  n: number;
  rate: number;
  low: number;
  high: number;
}

/** Wilson 95% score interval. */
export function wilsonRate(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: 0, low: 0, high: 0 };
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function fmt(r: Rate): string {
  if (r.n === 0) return '— (n=0)';
  const p = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return `${p(r.rate)} [${p(r.low)}, ${p(r.high)}] ${r.k}/${r.n}`;
}

// ── Per-lake record ────────────────────────────────────────────

type TargetKind = 'teammate' | 'hiddenEvil' | 'blue';

export interface EvilLake {
  gameId: string;
  name: string;
  role: string;
  /** 0 = first lake (after R2), 1 = after R3, 2 = after R4 (no lake follows). */
  lakeIdx: number;
  round: number;
  /** Good / evil missions won when the lake is used. */
  goodWins: number;
  evilWins: number;
  legalTeammates: number;
  /** Legal targets (for the chance level of laking a teammate). */
  validCount: number;
  legalTeammateTainted: boolean;
  /** Holder and target sat on the same failed mission. */
  sharedFailedMission: boolean;
  /** Red already has two failed missions. */
  redListening: boolean;
  maxTeammateSusp: number;
  holderSusp: number;
  holderTainted: boolean;
  holderOnThisMission: boolean;
  /** Next round's first leader is the holder / a visible teammate. */
  nextLeaderSelf: boolean;
  nextLeaderTeammate: boolean;
  target: TargetKind;
  /** For Oberon holders: evil target he could not see (he learns it is red). */
  targetTainted: boolean;
  targetSusp: number;
  targetMerlinLike: number;
  claim: 'good' | 'evil' | null;
  evilWon: boolean;
}

function failedMissionCount(game: ReplayGame, seat: number, upToRound: number): number {
  return game.quests.filter((q) => q.round <= upToRound && q.failed && q.teamSeats.includes(seat)).length;
}

function collect(games: readonly ReplayGame[]): EvilLake[] {
  const out: EvilLake[] = [];
  for (const game of games) {
    if (!game.lakeChainValid) continue;
    game.lakes.forEach((lake, lakeIdx) => {
      const holder = lake.holderSeat;
      const role = game.seatRoles[holder - 1];
      if (campOf(role) !== 'evil') return;
      const obs = buildReplayObservation(game, holder, { kind: 'lake', lake: lakeIdx });
      const valid = validLakeTargetSeats(game, lakeIdx);
      const visible = new Set(obs.knownEvils);
      const legalTeammateSeats = valid.filter((s) => visible.has(seatId(s)));
      const targetSeat = lake.targetSeat;
      const targetId = seatId(targetSeat);
      const targetCamp = campOf(game.seatRoles[targetSeat - 1]);
      const target: TargetKind = visible.has(targetId)
        ? 'teammate'
        : targetCamp === 'evil' ? 'hiddenEvil' : 'blue';
      const mission = game.proposals.find((p) => p.round === lake.round && p.wentOnMission);
      const nextLeaderSeat = mission ? leaderSeatForProposal(mission.globalIndex + 1, game.playerCount) : -1;
      const goodWins = obs.questResults.filter((r) => r === 'success').length;
      const evilWins = obs.questResults.filter((r) => r === 'fail').length;
      const teammateSusps = legalTeammateSeats.map((s) => estimateSuspicionFromHistory(seatId(s), obs));
      out.push({
        gameId: game.id,
        name: game.names[holder - 1] ?? '',
        role,
        lakeIdx,
        round: lake.round,
        goodWins,
        evilWins,
        legalTeammates: legalTeammateSeats.length,
        validCount: valid.length,
        sharedFailedMission: game.quests.some((q) => q.round <= lake.round && q.failed
          && q.teamSeats.includes(holder) && q.teamSeats.includes(targetSeat)),
        redListening: evilWins >= 2,
        legalTeammateTainted: legalTeammateSeats.some((s) => failedMissionCount(game, s, lake.round) > 0),
        maxTeammateSusp: teammateSusps.length > 0 ? Math.max(...teammateSusps) : Number.NaN,
        holderSusp: estimateSuspicionFromHistory(seatId(holder), obs),
        holderTainted: failedMissionCount(game, holder, lake.round) > 0,
        holderOnThisMission: mission?.teamSeats.includes(holder) ?? false,
        nextLeaderSelf: nextLeaderSeat === holder,
        nextLeaderTeammate: legalTeammateSeats.includes(nextLeaderSeat)
          || (nextLeaderSeat > 0 && visible.has(seatId(nextLeaderSeat))),
        target,
        targetTainted: failedMissionCount(game, targetSeat, lake.round) > 0,
        targetSusp: estimateSuspicionFromHistory(targetId, obs),
        targetMerlinLike: estimateMerlinLikenessFromHistory(targetId, obs),
        claim: lake.claim,
        evilWon: game.winner === 'evil',
      });
    });
  }
  return out;
}

// ── Report ─────────────────────────────────────────────────────

interface Section {
  title: string;
  rows: Array<{ label: string; rate: Rate }>;
  /** Free-text note (e.g. a chance level that is an expectation, not a rate). */
  note?: string;
}

function rateOf<T>(items: readonly T[], pred: (x: T) => boolean): Rate {
  return wilsonRate(items.filter(pred).length, items.length);
}

function bucket<T>(
  title: string,
  items: readonly T[],
  splits: Array<[string, (x: T) => boolean]>,
  outcome: (x: T) => boolean,
): Section {
  return {
    title,
    rows: splits.map(([label, f]) => {
      const sub = items.filter(f);
      return { label, rate: rateOf(sub, outcome) };
    }),
  };
}

const LAKE_LABEL = ['1st lake (after R2)', '2nd lake (after R3)', '3rd lake (after R4, last)'];

function scoreLabel(l: EvilLake): string {
  return `blue ${l.goodWins} : red ${l.evilWins}`;
}

function suspBucket(x: number): string {
  if (Number.isNaN(x)) return 'n/a';
  if (x <= 0) return '≤0 (clean)';
  if (x < 2) return '0–2';
  if (x < 4) return '2–4';
  return '≥4 (very suspected)';
}

export function analyse(all: readonly EvilLake[]): Section[] {
  const sections: Section[] = [];
  const seers = all.filter((l) => l.role !== 'oberon');
  const withTeammate = seers.filter((l) => l.legalTeammates > 0);
  const isTeammate = (l: EvilLake): boolean => l.target === 'teammate';
  const isBlue = (l: EvilLake): boolean => l.target === 'blue';

  sections.push({
    title: '(a) Seeing reds, ≥1 visible teammate legal — target choice',
    rows: [
      { label: 'laked a visible teammate', rate: rateOf(withTeammate, isTeammate) },
      { label: 'laked a blue', rate: rateOf(withTeammate, isBlue) },
      { label: 'laked the hidden Oberon', rate: rateOf(withTeammate, (l) => l.target === 'hiddenEvil') },
    ],
    note: withTeammate.length === 0 ? undefined
      : `chance level (uniform random legal target) for "laked a visible teammate": ${(100 * withTeammate.reduce((a, l) => a + l.legalTeammates / l.validCount, 0) / withTeammate.length).toFixed(1)}% (expectation over the same ${withTeammate.length} lakes)`,
  });
  sections.push(bucket('(a) teammate share by lake index', withTeammate,
    [0, 1, 2].map((i) => [LAKE_LABEL[i], (l: EvilLake) => l.lakeIdx === i] as [string, (l: EvilLake) => boolean]),
    isTeammate));
  sections.push(bucket('(a) teammate share by role', withTeammate,
    ['assassin', 'morgana', 'mordred'].map((r) => [r, (l: EvilLake) => l.role === r] as [string, (l: EvilLake) => boolean]),
    isTeammate));
  sections.push({
    title: '(a) Seeing reds, no visible teammate legal — target',
    rows: [
      { label: 'n lakes; laked a blue', rate: rateOf(seers.filter((l) => l.legalTeammates === 0), isBlue) },
    ],
  });

  // (b) declarations
  const declared = (l: EvilLake): boolean => l.claim !== null;
  const tm = seers.filter((l) => isTeammate(l) && declared(l));
  const blue = seers.filter((l) => isBlue(l) && declared(l));
  const hidden = seers.filter((l) => l.target === 'hiddenEvil' && declared(l));
  sections.push({
    title: '(b) Declarations (seeing reds; declared lakes only)',
    rows: [
      { label: 'teammate → o (lie: blue)', rate: rateOf(tm, (l) => l.claim === 'good') },
      { label: 'blue → x (lie: red)', rate: rateOf(blue, (l) => l.claim === 'evil') },
      { label: 'blue → o (truth: blue)', rate: rateOf(blue, (l) => l.claim === 'good') },
      { label: 'hidden Oberon → o', rate: rateOf(hidden, (l) => l.claim === 'good') },
      { label: 'declared at all (all seeing-red lakes)', rate: rateOf(seers, declared) },
    ],
  });
  sections.push(bucket('(b) blue → truthful o, by lake index', blue,
    [0, 1, 2].map((i) => [LAKE_LABEL[i], (l: EvilLake) => l.lakeIdx === i] as [string, (l: EvilLake) => boolean]),
    (l) => l.claim === 'good'));
  sections.push(bucket('(b) blue → truthful o, by role', blue,
    ['assassin', 'morgana', 'mordred'].map((r) => [r, (l: EvilLake) => l.role === r] as [string, (l: EvilLake) => boolean]),
    (l) => l.claim === 'good'));

  // (c) predictors of choosing blue (teammate available)
  sections.push(bucket('(c) P(lake a blue | teammate legal) by #legal teammates', withTeammate,
    [['1 legal teammate', (l) => l.legalTeammates === 1], ['2 legal teammates', (l) => l.legalTeammates >= 2]],
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by score', withTeammate,
    uniqueLabels(withTeammate, scoreLabel).map((s) => [s, (l: EvilLake) => scoreLabel(l) === s] as [string, (l: EvilLake) => boolean]),
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by holder tainted', withTeammate,
    [['holder on a failed mission', (l) => l.holderTainted], ['holder clean', (l) => !l.holderTainted]],
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by holder suspicion', withTeammate,
    ['≤0 (clean)', '0–2', '2–4', '≥4 (very suspected)'].map((b) => [b, (l: EvilLake) => suspBucket(l.holderSusp) === b] as [string, (l: EvilLake) => boolean]),
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by legal teammate tainted', withTeammate,
    [['a legal teammate on a failed mission', (l) => l.legalTeammateTainted], ['legal teammates clean', (l) => !l.legalTeammateTainted]],
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by max teammate suspicion', withTeammate,
    ['≤0 (clean)', '0–2', '2–4', '≥4 (very suspected)'].map((b) => [b, (l: EvilLake) => suspBucket(l.maxTeammateSusp) === b] as [string, (l: EvilLake) => boolean]),
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by holder on this mission', withTeammate,
    [['holder on this round\'s mission', (l) => l.holderOnThisMission], ['holder off', (l) => !l.holderOnThisMission]],
    isBlue));
  sections.push(bucket('(c) P(lake a blue | teammate legal) by next leader', withTeammate,
    [['next leader = holder', (l) => l.nextLeaderSelf], ['next leader = teammate', (l) => l.nextLeaderTeammate], ['next leader = other', (l) => !l.nextLeaderSelf && !l.nextLeaderTeammate]],
    isBlue));

  // (c) predictors of truthful-blue among blue targets
  const truthful = (l: EvilLake): boolean => l.claim === 'good';
  sections.push(bucket('(c) P(truthful o | blue target) by score', blue,
    uniqueLabels(blue, scoreLabel).map((s) => [s, (l: EvilLake) => scoreLabel(l) === s] as [string, (l: EvilLake) => boolean]),
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by target tainted', blue,
    [['blue target on a failed mission', (l) => l.targetTainted], ['blue target clean', (l) => !l.targetTainted]],
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by holder tainted', blue,
    [['holder on a failed mission', (l) => l.holderTainted], ['holder clean', (l) => !l.holderTainted]],
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by holder suspicion', blue,
    ['≤0 (clean)', '0–2', '2–4', '≥4 (very suspected)'].map((b) => [b, (l: EvilLake) => suspBucket(l.holderSusp) === b] as [string, (l: EvilLake) => boolean]),
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by target Merlin-likeness', blue,
    [['merlinLike > 0', (l) => l.targetMerlinLike > 0], ['merlinLike ≤ 0', (l) => l.targetMerlinLike <= 0]],
    truthful));
  sections.push(bucket('(c) P(red claim x | blue target) by shared failed mission × red listening', blue,
    [
      ['shared failed mission, red listening', (l) => l.sharedFailedMission && l.redListening],
      ['shared failed mission, red not listening', (l) => l.sharedFailedMission && !l.redListening],
      ['no shared failed mission, red listening', (l) => !l.sharedFailedMission && l.redListening],
      ['no shared failed mission, red not listening', (l) => !l.sharedFailedMission && !l.redListening],
    ],
    (l) => l.claim === 'evil'));
  sections.push(bucket('(c) P(truthful o | blue target) by teammate availability', blue,
    [['a teammate was legal (chose blue anyway)', (l) => l.legalTeammates > 0], ['no teammate legal', (l) => l.legalTeammates === 0]],
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by holder on this mission', blue,
    [['holder on this round\'s mission', (l) => l.holderOnThisMission], ['holder off', (l) => !l.holderOnThisMission]],
    truthful));
  sections.push(bucket('(c) P(truthful o | blue target) by next leader', blue,
    [['next leader = holder', (l) => l.nextLeaderSelf], ['next leader = teammate', (l) => l.nextLeaderTeammate], ['next leader = other', (l) => !l.nextLeaderSelf && !l.nextLeaderTeammate]],
    truthful));

  // (d) descriptive win rate per strategy (confounded)
  const strat = (l: EvilLake): string => {
    if (l.target === 'teammate') return `teammate→${l.claim === 'good' ? 'o' : l.claim === 'evil' ? 'x' : '?'}`;
    if (l.target === 'blue') return `blue→${l.claim === 'good' ? 'o (truth)' : l.claim === 'evil' ? 'x (lie)' : '?'}`;
    return `hidden Oberon→${l.claim === 'good' ? 'o' : l.claim === 'evil' ? 'x' : '?'}`;
  };
  sections.push(bucket('(d) red final win rate by strategy (seeing reds, CONFOUNDED: descriptive only)', seers,
    uniqueLabels(seers, strat).map((s) => [s, (l: EvilLake) => strat(l) === s] as [string, (l: EvilLake) => boolean]),
    (l) => l.evilWon));
  sections.push(bucket('(d) red final win rate by strategy, teammate legal only (CONFOUNDED)', withTeammate,
    uniqueLabels(withTeammate, strat).map((s) => [s, (l: EvilLake) => strat(l) === s] as [string, (l: EvilLake) => boolean]),
    (l) => l.evilWon));
  // Like-for-like headline (any claim) before the stratified rows below.
  sections.push(bucket('(d) red final win rate by target, teammate legal, any claim (CONFOUNDED)', withTeammate,
    [['teammate', isTeammate], ['blue', isBlue]], (l) => l.evilWon));
  for (const tainted of [true, false]) {
    const sub = withTeammate.filter((l) => l.legalTeammateTainted === tainted);
    sections.push(bucket(`(d) red final win rate by target, legal teammate ${tainted ? 'on a failed mission' : 'clean'} (CONFOUNDED)`, sub,
      [['teammate', isTeammate], ['blue', isBlue]], (l) => l.evilWon));
  }
  for (const i of [0, 1, 2]) {
    const sub = withTeammate.filter((l) => l.lakeIdx === i);
    sections.push(bucket(`(d) red final win rate by target, ${LAKE_LABEL[i]}, teammate legal (CONFOUNDED)`, sub,
      [['teammate', isTeammate], ['blue', isBlue]], (l) => l.evilWon));
  }

  // Oberon
  const ob = all.filter((l) => l.role === 'oberon');
  const obBlue = ob.filter((l) => isBlue(l) && declared(l));
  const obRed = ob.filter((l) => l.target !== 'blue' && declared(l));
  sections.push({
    title: 'Oberon holder (sees nobody)',
    rows: [
      { label: 'target was red (by chance)', rate: rateOf(ob, (l) => l.target !== 'blue') },
      { label: 'blue target → x (lie)', rate: rateOf(obBlue, (l) => l.claim === 'evil') },
      { label: 'blue target → o (truth)', rate: rateOf(obBlue, (l) => l.claim === 'good') },
      { label: 'red target → o (cover)', rate: rateOf(obRed, (l) => l.claim === 'good') },
      { label: 'declared at all', rate: rateOf(ob, declared) },
    ],
  });
  sections.push(bucket('Oberon: P(blue target → x) by lake index', obBlue,
    [0, 1, 2].map((i) => [LAKE_LABEL[i], (l: EvilLake) => l.lakeIdx === i] as [string, (l: EvilLake) => boolean]),
    (l) => l.claim === 'evil'));
  sections.push(bucket('Oberon: P(blue target → x) by target tainted', obBlue,
    [['blue target on a failed mission', (l) => l.targetTainted], ['blue target clean', (l) => !l.targetTainted]],
    (l) => l.claim === 'evil'));
  sections.push(bucket('Oberon: P(target tainted) — does he lake failed-mission members?', ob,
    [['all Oberon lakes', () => true]], (l) => l.targetTainted));
  sections.push(bucket('Oberon: red final win rate by declaration on a blue (CONFOUNDED)', obBlue,
    [['blue→x', (l) => l.claim === 'evil'], ['blue→o', (l) => l.claim === 'good']], (l) => l.evilWon));
  return sections;
}

function uniqueLabels<T>(items: readonly T[], f: (x: T) => string): string[] {
  return [...new Set(items.map(f))].sort();
}

function printSections(label: string, sections: readonly Section[]): void {
  console.log(`\n================ ${label} ================`);
  for (const s of sections) {
    console.log(`\n${s.title}`);
    for (const r of s.rows) console.log(`  ${r.label.padEnd(44)} ${fmt(r.rate)}`);
    if (s.note) console.log(`  (${s.note})`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(fs.readFileSync(args.cache, 'utf8')) as Record<string, string[][]>;
  const rows = rowsFromSheet(data['牌譜'] ?? []);
  const games: ReplayGame[] = [];
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const res = parseReplayGame(row);
    if (res.ok) games.push(res.game);
  }
  const lakes = collect(games);
  const top = computeTopPerformers(games);
  console.log(`replayable 10p games: ${games.length}; with a valid lake chain: ${games.filter((g) => g.lakeChainValid).length}`);
  console.log(`red-held lakes: ${lakes.length} (Oberon ${lakes.filter((l) => l.role === 'oberon').length})`);

  const cohorts: Array<[string, EvilLake[]]> = [
    ['population', lakes],
    ['top/role', lakes.filter((l) => top.members.has(cohortKey(l.name, l.role)))],
  ];
  for (const p of args.players) cohorts.push([p, lakes.filter((l) => l.name === p)]);
  const result: Record<string, Section[]> = {};
  for (const [label, items] of cohorts) {
    const sections = analyse(items);
    result[label] = sections;
    printSections(`${label} (red-held lakes n=${items.length})`, sections);
  }
  if (args.json) {
    fs.writeFileSync(path.resolve(args.json), JSON.stringify({
      generatedBy: 'packages/server/scripts/evilLakeStudy.ts',
      games: games.length,
      redLakes: lakes.length,
      cohorts: result,
    }, null, 2));
    console.log(`wrote ${path.resolve(args.json)}`);
  }
}

main();
