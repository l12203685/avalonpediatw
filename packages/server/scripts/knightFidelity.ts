/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI騎士 精準度 v2，第 1 步：重播、抽特徵（站長 2026-11-26「80% 不夠像…要切每個動作來看」）。
 * 第 2 步（擬合、各動作的一致度、寫進 profile）在 `scripts/knightFidelityFit.ts`。
 *
 *   cd packages/server && npx tsx scripts/knightFidelity.ts --out /repo 外的資料夾 [--workers 2] [--only 玩家ID] [--include ID[=名字]]
 *
 * 入選玩家同 v1（`scripts/styleKnights.ts` 的 `selectPlayers`：總場數 ≥ 250 或強者；`--include` 同 v1，點名加人）。每位玩家坐過的每個座位，
 * 同一套重播（`agreement.replaySeat`：只給那個座位當時知道的東西，每個決策點獨立，之後照真人牌譜走）跑兩隻引擎：
 *   D = 百科AI 本身（預設開關）；K = 那位玩家的 v1 AI騎士（`community-bots/_knights` 的 profile；沒有就 = D）。
 * 每個決策點記下：真人的選擇、D 和 K 的選擇、殘差層的特徵（`src/arena/residual.ts`，用 K 的開關算，`eng` = K 的決定）。
 * 決策點：派隊、投票（非強制局、票可信）、紅方可確定的任務牌、湖中對象、湖中宣告、刺殺。
 *
 * 輸出（私人，不可以在 repo 裡；含玩家 ID）：DIR/extract.json = { players, jobs, records }。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import type { AgentTuning } from '../src/ai/AgentTuning';
import type { AgentAction, PlayerObservation } from '../src/ai/types';
import { pinnedQuestCard, withSeededRandom } from '../src/ai/benchmark/agreement';
import { replayGameFromDataset } from '../src/ai/benchmark/datasetReplay';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId, seatOfId, validLakeTargetSeats } from '../src/ai/benchmark/replayObservation';
import { isInside } from '../src/ai/benchmark/playerAgreement';
import { resolveProfileTuning, validateProfile, type ArenaSide, type BotProfile } from '../src/arena/profile';
import { knightFolderId } from '../src/arena/styleKnights';
import { claimFeatures, pickCandidates, questFeatures, teamSpotFeatures, voteFeatures } from '../src/arena/residual';
import type { FidRecord, FidJob, FidMeta } from '../src/arena/fidelityMetrics';
import { halfOf, parseArgs as parseV1Args, selectPlayers, type Dataset } from './styleKnights';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..', '..');
const KNIGHTS_DIR = path.join(REPO, 'community-bots', '_knights');

interface Args {
  out?: string;
  workers: number;
  only: string[];
  include: string[];
  dataset: string;
  shard?: [number, number];
  jobs?: string;
  shardOut?: string;
  profiles?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { workers: 2, only: [], include: [], dataset: path.join(SERVER, 'games_cache.json') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--out': a.out = path.resolve(next()); break;
      case '--workers': a.workers = Math.max(1, Number.parseInt(next(), 10)); break;
      case '--only': a.only.push(next()); break;
      case '--include': a.include.push(next()); break;
      case '--dataset': a.dataset = path.resolve(next()); break;
      case '--shard': { const [x, n] = next().split('/').map((v) => Number.parseInt(v, 10)); a.shard = [x, n]; break; }
      case '--jobs': a.jobs = next(); break;
      case '--shard-out': a.shardOut = next(); break;
      case '--profiles': a.profiles = next(); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const r3m = (m: number[][]): number[][] => m.map((row) => row.map(r3));
const seatsOf = (ids: readonly string[]): number[] => ids.map(seatOfId).sort((a, b) => a - b);

// ── 重播一個座位（子行程） ──────────────────────────────────

function extractSeat(game: ReplayGame, seat: number, j: number, tunD: AgentTuning, tunK: AgentTuning, out: FidRecord[]): void {
  const role = game.seatRoles[seat - 1];
  const side = campOf(role);
  const me = seatId(seat);
  const seedOf = (key: string): string => `${game.id}|${seat}|${key}`;
  const agentD = new HeuristicAgent(me, undefined, undefined, tunD);
  const agentK = new HeuristicAgent(me, undefined, undefined, tunK);
  agentD.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  agentK.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const both = (mk: () => PlayerObservation, key: string): { d: AgentAction; k: AgentAction; obs: PlayerObservation } => {
    const d = withSeededRandom(seedOf(key), () => agentD.act(mk()));
    const obs = mk();
    const k = withSeededRandom(seedOf(key), () => agentK.act(obs));
    return { d, k, obs };
  };
  const evilSeat = (s: number): boolean => campOf(game.seatRoles[s - 1]) === 'evil';

  let proposalIdx = 0;
  for (const quest of game.quests) {
    const round = quest.round;
    const redFails = game.quests.filter((q) => q.round < round && q.failed).length;
    for (; proposalIdx < game.proposals.length && game.proposals[proposalIdx].round === round; proposalIdx++) {
      const p = game.proposals[proposalIdx];
      const idx = proposalIdx;
      if (p.leaderSeat === seat) {
        const { d, k, obs } = both(() => buildReplayObservation(game, seat, { kind: 'team_select', proposal: idx }), `team-${idx}`);
        const kTeam = k.type === 'team_select' ? k.teamIds : [];
        const f = teamSpotFeatures(obs, kTeam, tunK);
        if (f.k === p.teamSeats.length && kTeam.length === f.k) {
          out.push({
            t: 'T', j, p: idx, r: round, a: p.attempt, rf: redFails,
            h: [...p.teamSeats].sort((x, y) => x - y), d: d.type === 'team_select' ? seatsOf(d.teamIds) : [], k: seatsOf(kTeam),
            S: r3m(f.S), sz: f.k, pp: seatsOf(f.prevProp), lm: seatsOf(f.lastMission),
          });
        }
      }
      if (!p.forced && p.votesReliable) {
        const { d, k, obs } = both(() => buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx }), `vote-${idx}`);
        const onTeam = p.teamSeats.includes(seat);
        const kVote = k.type === 'team_vote' ? k.vote : onTeam;
        out.push({
          t: 'V', j, p: idx, r: round, a: p.attempt, rf: redFails,
          h: p.votes[seat - 1] ? 1 : 0, d: (d.type === 'team_vote' ? d.vote : onTeam) ? 1 : 0, k: kVote ? 1 : 0,
          x: voteFeatures(obs, kVote, tunK).map(r3), on: onTeam ? 1 : 0, ld: p.leaderSeat === seat ? 1 : 0,
          tr: p.teamSeats.some(evilSeat) ? 1 : 0, to: p.teamSeats.some((s) => s !== seat && evilSeat(s)) ? 1 : 0,
          team: [...p.teamSeats].sort((x, y) => x - y),
        });
      }
    }
    const pinned = pinnedQuestCard(game, round, seat);
    if (pinned !== null && side === 'evil') {
      const { d, k, obs } = both(() => buildReplayObservation(game, seat, { kind: 'quest_vote', round }), `quest-${round}`);
      const kCard = k.type === 'quest_vote' ? k.vote : 'success';
      const seen = obs.proposedTeam.filter((id) => id !== me && obs.knownEvils.includes(id)).length;
      out.push({
        t: 'Q', j, r: round, rf: redFails, h: pinned === 'fail' ? 1 : 0, d: d.type === 'quest_vote' && d.vote === 'fail' ? 1 : 0, k: kCard === 'fail' ? 1 : 0,
        x: questFeatures(obs, kCard).map(r3), seen, sz: quest.teamSeats.length,
      });
    }
    const lakeIdx = game.lakes.findIndex((l) => l.round === round);
    if (lakeIdx >= 0 && game.lakeChainValid && game.lakes[lakeIdx].holderSeat === seat) {
      const lake = game.lakes[lakeIdx];
      const valid = validLakeTargetSeats(game, lakeIdx).map(seatId);
      const human = seatId(lake.targetSeat);
      const mk = (): PlayerObservation => buildReplayObservation(game, seat, { kind: 'lake', lake: lakeIdx });
      const dT = withSeededRandom(seedOf(`lake-${lakeIdx}`), () => agentD.pickLakeTarget(mk(), valid));
      const obs = mk();
      const kT = withSeededRandom(seedOf(`lake-${lakeIdx}`), () => agentK.pickLakeTarget(obs, valid));
      if (valid.includes(human)) {
        const c = pickCandidates(obs, valid, kT, tunK);
        out.push({
          t: 'L', j, r: round, rf: redFails, h: lake.targetSeat, d: seatOfId(dT), k: seatOfId(kT),
          c: c.ids.map(seatOfId), X: r3m(c.X), hc: campOf(game.seatRoles[lake.targetSeat - 1]) === 'evil' ? 1 : 0,
        });
      }
      if (lake.claim !== null) {
        const truth = campOf(game.seatRoles[lake.targetSeat - 1]);
        const dC = withSeededRandom(seedOf(`claim-${lakeIdx}`), () => agentD.declareLake(mk(), human, truth));
        const obsC = mk();
        const kC = withSeededRandom(seedOf(`claim-${lakeIdx}`), () => agentK.declareLake(obsC, human, truth));
        const enc = (c: 'good' | 'evil' | null): number => (c === null ? -1 : c === 'evil' ? 1 : 0);
        out.push({
          t: 'C', j, r: round, rf: redFails, h: lake.claim === 'evil' ? 1 : 0, d: enc(dC), k: enc(kC),
          x: claimFeatures(obsC, human, truth, kC, tunK).map(r3), te: truth === 'evil' ? 1 : 0,
          ally: obsC.knownEvils.includes(human) ? 1 : 0, tg: lake.targetSeat,
        });
      }
    }
  }
  if (role === 'assassin' && game.assassinTargetSeat !== undefined) {
    const { d, k, obs } = both(() => buildReplayObservation(game, seat, { kind: 'assassination' }), 'assassinate');
    const kT = k.type === 'assassinate' ? k.targetId : '';
    const evil = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, me]);
    const cands = obs.allPlayerIds.filter((id) => !evil.has(id));
    if (cands.includes(seatId(game.assassinTargetSeat)) && kT) {
      const c = pickCandidates(obs, cands, kT, tunK);
      out.push({
        t: 'A', j, r: game.quests.length, rf: 0, h: game.assassinTargetSeat, d: d.type === 'assassinate' ? seatOfId(d.targetId) : 0, k: seatOfId(kT),
        c: c.ids.map(seatOfId), X: r3m(c.X), m: game.seatRoles.indexOf('merlin') + 1,
      });
    }
  }
}

function seatMeta(game: ReplayGame, seat: number, j: number): FidMeta {
  const role = game.seatRoles[seat - 1];
  const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 });
  return {
    t: 'M', j, role, thumbs: (obs.knownWizards ?? []).map(seatOfId).sort((a, b) => a - b),
    merlin: game.seatRoles.indexOf('merlin') + 1, morgana: game.seatRoles.indexOf('morgana') + 1,
    killed: game.assassinTargetSeat ?? 0, winner: game.winner,
  };
}

function runShard(a: Args): void {
  const ds = loadJson<Dataset>(a.dataset);
  const jobs = loadJson<FidJob[]>(a.jobs!);
  const profiles = loadJson<Record<string, BotProfile | null>>(a.profiles!);
  const [k, n] = a.shard!;
  const iId = ds.fields.indexOf('id');
  const rowOf = new Map(ds.games.map((r) => [String(r[iId]), r]));
  const games = new Map<string, ReplayGame>();
  const out: Array<FidRecord | FidMeta> = [];
  const started = Date.now();
  for (let j = k; j < jobs.length; j += n) {
    const job = jobs[j];
    let game = games.get(job.g);
    if (!game) {
      const res = replayGameFromDataset(rowOf.get(job.g)!, ds);
      if (!res.ok) continue;
      game = res.value.game;
      if (games.size > 400) games.clear();
      games.set(job.g, game);
    }
    const role = game.seatRoles[job.s - 1];
    const side = campOf(role) as ArenaSide;
    const tunD = resolveProfileTuning(null, role, side);
    const tunK = resolveProfileTuning(profiles[String(job.p)] ?? null, role, side);
    out.push(seatMeta(game, job.s, j));
    const recs: FidRecord[] = [];
    extractSeat(game, job.s, j, tunD, tunK, recs);
    for (const r of recs) out.push(r);
    if (k === 0 && j % (n * 250) === 0) console.error(`  shard 0: job ${j}/${jobs.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
  fs.writeFileSync(a.shardOut!, JSON.stringify(out));
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a.shard) { runShard(a); return; }
  if (!a.out) throw new Error('--out DIR is required (outside the repo)');
  if (isInside(a.out, REPO)) throw new Error(`--out must be outside the repo (${REPO})`);
  fs.mkdirSync(a.out, { recursive: true });
  const ds = loadJson<Dataset>(a.dataset);
  const v1 = parseV1Args(['--dataset', a.dataset, ...a.include.flatMap((x) => ['--include', x])]);
  const { selected, jobs: v1Jobs } = selectPlayers(v1, ds);
  const iId = ds.fields.indexOf('id');
  const iDate = ds.fields.indexOf('date');
  const order = new Map(ds.games.map((r, i) => [String(r[iId]), i]));
  const dateOf = new Map(ds.games.map((r) => [String(r[iId]), String(r[iDate] ?? '')]));

  // v1 的 profile（有留下的才有）。
  const profiles: Record<string, BotProfile | null> = {};
  selected.forEach((p, pi) => {
    const file = path.join(KNIGHTS_DIR, knightFolderId(p.id, 1), 'profile.json');
    if (!fs.existsSync(file)) { profiles[String(pi)] = null; return; }
    const v = validateProfile(loadJson<unknown>(file), knightFolderId(p.id, 1), { house: true });
    profiles[String(pi)] = v.ok ? v.profile! : null;
  });

  // 時間切分：每位玩家自己的座位依日期排，前 70% 擬合、後 30% 測試。
  const only = new Set(a.only);
  let jobs: FidJob[] = v1Jobs.map(([g, s, p]) => ({ g, s, p, half: halfOf(g), time: 0 as 0 | 1, date: dateOf.get(g) ?? '' }));
  if (only.size) jobs = jobs.filter((j) => only.has(selected[j.p].id));
  const byPlayer = new Map<number, FidJob[]>();
  for (const j of jobs) byPlayer.set(j.p, [...(byPlayer.get(j.p) ?? []), j]);
  for (const list of byPlayer.values()) {
    list.sort((x, y) => x.date.localeCompare(y.date) || (order.get(x.g)! - order.get(y.g)!));
    const cut = Math.floor(list.length * 0.7);
    list.forEach((j, i) => { j.time = i >= cut ? 1 : 0; });
  }

  const dir = fs.mkdtempSync(path.join(a.out, 'extract-'));
  const jobsFile = path.join(dir, 'jobs.json');
  const profFile = path.join(dir, 'profiles.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  fs.writeFileSync(profFile, JSON.stringify(profiles));
  const started = Date.now();
  console.error(`players ${selected.length} (v1 profiles ${Object.values(profiles).filter(Boolean).length}); seats ${jobs.length}`);
  await Promise.all(Array.from({ length: a.workers }, (_, k) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], ['--dataset', a.dataset, '--jobs', jobsFile, '--profiles', profFile, '--shard', `${k}/${a.workers}`, '--shard-out', path.join(dir, `s${k}.json`)], {
      execArgv: process.execArgv, stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
  })));
  const records: Array<FidRecord | FidMeta> = [];
  for (let k = 0; k < a.workers; k++) for (const r of loadJson<Array<FidRecord | FidMeta>>(path.join(dir, `s${k}.json`))) records.push(r);
  console.error(`extract: ${jobs.length} seats → ${records.length} records in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const players = selected.map((p, pi) => ({ id: p.id, games: p.games, strong: p.strong.length > 0, v1: profiles[String(pi)] !== null }));
  fs.writeFileSync(path.join(a.out, 'extract.json'), JSON.stringify({ players, jobs, records }));
  fs.rmSync(dir, { recursive: true, force: true });
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
