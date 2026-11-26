/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 依玩家風格建立的 AI騎士（站長 2026-11-26；純函式在 src/arena/styleKnights.ts，說明在 docs/BOTS.md〈依玩家風格建立的 AI騎士〉）。
 *
 *   cd packages/server && npx tsx scripts/styleKnights.ts --out /repo 外的資料夾 [--workers 2] [--write-knights] [--summary ../../docs/ai/gap/style_knights.json]
 *
 * 選項：
 *   --out DIR          私人輸出（必填，不可以在 repo 裡）：players.csv（入選玩家與場數）、fit.json（每位玩家的擬合細節）
 *   --workers N        平行子行程（預設 2）
 *   --min-games N      總場數門檻（預設 250；網站的真人局，併過 player_aliases.json 的舊名）
 *   --strong-top K     強者玩家 = 強者分面前 K（預設 5；第 1G 節，scripts/strongCohort.ts）
 *   --kappa K          收縮強度（預設 20：玩家每一族的決策點少於 20 個時，全體的偏好佔一半以上）
 *   --select-only      只選玩家、寫 players.csv
 *   --exclude ID       不替這位玩家建 AI騎士（可重複；玩家不想要時用；對法同網站，舊名也認得）
 *   --sample N         只取平均分布的 N 個座位（試跑、估時間用；結果不能用）
 *   --write-knights    把留下來的 AI騎士 寫進 community-bots/_knights/<id>/profile.json（先清掉這支程式以前寫的資料夾）
 *   --summary PATH     彙總（不含任何對局紀錄）：每隻 AI騎士 的留出一半一致度、標籤、開關
 *   --dataset/--game-db/--corrections/--aliases/--analysis  同 playerAgreement.ts
 *
 * 做法（一位玩家）：
 *   1. 玩家坐過的每個座位，用第 1 關／人類 PR 量尺的同一套重播（只給那個座位當時知道的東西，每個決策點獨立，之後照真人牌譜走），
 *      對每一組開關值（`buildProbes`：百科AI 本身 D ＋ 幾組改過的值）各算一次機器人的決策。只算會被那組開關影響的決策點。
 *   2. 局依局號雜湊分兩半：擬合的一半、留出的一半。每一個「決策族」（`buildFamilies`：紅方藏牌、紅方疊隊友、紅方投票、忠臣派西投票、
 *      梅林投票、梅林派隊、刺殺…，彼此不重疊）在擬合的一半挑一個開關值：期望一致數往全體（所有入選玩家）的一致率收縮後最高的那個。
 *      機率開關（每次決策擲一次）用「開關 = 0」「開關 = 1」兩次重播的加權算期望一致度。
 *   3. 留出的一半：AI騎士 和百科AI 各自的期望一致度。比百科AI 高才留下（寫成 profile）。
 *   4. 檢查：留出的一半再用合起來的 profile 實際重播一次（擲骰照種子），報實際的一致度差（族與族之間有沒有互相影響）。
 *
 * 湖中（目標、宣告）沒有開放的開關，AI騎士 和百科AI 在湖中的決策一樣，所以不列入比較。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import { playerIdentityKey } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../src/ai/AgentTuning';
import type { AgentAction, PlayerObservation } from '../src/ai/types';
import { pinnedQuestCard } from '../src/ai/benchmark/agreement';
import { replayGameFromDataset, type DatasetHeader, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { excludedDatasetKeys, isInside, type GameDbCorrection, type GameDbRow } from '../src/ai/benchmark/playerAgreement';
import { resolveProfileTuning, validateProfile, type BotProfile, type ArenaSide } from '../src/arena/profile';
import {
  buildFamilies,
  buildKnightProfile,
  buildProbes,
  chooseShrunk,
  styleCenter,
  choicesToLayers,
  familyAgreement,
  familyOf,
  knightFolderId,
  knightNameFits,
  scoreFamily,
  type CandidateScore,
  type DecisionType,
  type FittedChoices,
  type Probe,
  type ScoredSpot,
  type SpotLite,
} from '../src/arena/styleKnights';
import { loadStrongCohorts } from './strongCohort';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..', '..');
const KNIGHTS_DIR = path.join(REPO, 'community-bots', '_knights');
const FACETS = [
  'redMission', 'blueMission', 'assassinHit', 'merlinSurvival',
  'mission:merlin', 'mission:percival', 'mission:loyal', 'mission:assassin', 'mission:morgana', 'mission:mordred', 'mission:oberon',
] as const;

interface Args {
  out?: string;
  workers: number;
  minGames: number;
  strongTop: number;
  kappa: number;
  selectOnly: boolean;
  sample?: number;
  exclude: string[];
  writeKnights: boolean;
  summary?: string;
  dataset: string;
  gameDb: string;
  corrections: string;
  aliases: string;
  analysis: string;
  // worker
  shard?: [number, number];
  jobs?: string;
  shardOut?: string;
  profiles?: string;
  probeIds?: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    workers: 2, minGames: 250, strongTop: 5, kappa: 20, selectOnly: false, writeKnights: false, exclude: [],
    dataset: path.join(SERVER, 'games_cache.json'),
    gameDb: path.join(SERVER, 'game_db.json'),
    corrections: path.join(SERVER, 'game_db_corrections.json'),
    aliases: path.join(SERVER, 'player_aliases.json'),
    analysis: path.join(SERVER, 'analysis_cache.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--out': a.out = path.resolve(next()); break;
      case '--workers': a.workers = Math.max(1, Number.parseInt(next(), 10)); break;
      case '--min-games': a.minGames = Number.parseInt(next(), 10); break;
      case '--strong-top': a.strongTop = Number.parseInt(next(), 10); break;
      case '--kappa': a.kappa = Number(next()); break;
      case '--select-only': a.selectOnly = true; break;
      case '--sample': a.sample = Number.parseInt(next(), 10); break;
      case '--exclude': a.exclude.push(next()); break;
      case '--write-knights': a.writeKnights = true; break;
      case '--summary': a.summary = path.resolve(next()); break;
      case '--dataset': a.dataset = path.resolve(next()); break;
      case '--game-db': a.gameDb = path.resolve(next()); break;
      case '--corrections': a.corrections = path.resolve(next()); break;
      case '--aliases': a.aliases = path.resolve(next()); break;
      case '--analysis': a.analysis = path.resolve(next()); break;
      case '--shard': { const [x, n] = next().split('/').map((v) => Number.parseInt(v, 10)); a.shard = [x, n]; break; }
      case '--jobs': a.jobs = next(); break;
      case '--shard-out': a.shardOut = next(); break;
      case '--profiles': a.profiles = next(); break;
      case '--probe-ids': a.probeIds = next().split(','); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

type Dataset = DatasetHeader & { games: DatasetTuple[]; players: string[]; aliases?: Record<string, string> };

/** 一個座位：[局號, 座位, 玩家編號（入選清單裡的位置）, 半（0 擬合、1 留出）]。 */
type Job = [string, number, number, 0 | 1];

/** 子行程輸出的一個決策點：[job, 種類, 第幾局, 第幾次提議, 紅方失敗數, 在隊上（1／0）, 玩家的選擇, {probe: 機器人的選擇}]。 */
type RawSpot = [number, DecisionType, number, number, number, number, string, Record<string, string>];

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 局 → 擬合（0）或留出（1）。一局的所有座位在同一半。 */
export function halfOf(gameId: string): 0 | 1 {
  return (fnv1a(`style-knights|${gameId}`) & 1) as 0 | 1;
}

// ── 重播（子行程）──────────────────────────────────────────

/** 同 agreement.ts 的種子寫法（D 的決策和 replaySeat 一樣）。 */
function withSeed<T>(seed: string, fn: () => T): T {
  let s = fnv1a(seed);
  const original = Math.random;
  Math.random = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return fn(); } finally { Math.random = original; }
}

function redFailsBefore(game: ReplayGame, round: number): number {
  return game.quests.filter((q) => q.round < round && q.failed).length;
}

interface SeatSpot { lite: SpotLite; attempt: number; human: string; obs: () => PlayerObservation; seedKey: string }

/** 一個座位的決策點（派隊、投票、可確定的紅方任務牌、刺殺）。觀察延遲建立。 */
function seatSpots(game: ReplayGame, seat: number): SeatSpot[] {
  const out: SeatSpot[] = [];
  const role = game.seatRoles[seat - 1];
  let proposalIdx = 0;
  for (const quest of game.quests) {
    const round = quest.round;
    const redFails = redFailsBefore(game, round);
    for (; proposalIdx < game.proposals.length && game.proposals[proposalIdx].round === round; proposalIdx++) {
      const p = game.proposals[proposalIdx];
      const idx = proposalIdx;
      if (p.leaderSeat === seat) {
        out.push({
          lite: { type: 'team', role, round, redFails }, attempt: p.attempt,
          human: [...p.teamSeats].sort((a, b) => a - b).join(','),
          obs: () => buildReplayObservation(game, seat, { kind: 'team_select', proposal: idx }), seedKey: `team-${idx}`,
        });
      }
      if (!p.forced && p.votesReliable) {
        out.push({
          lite: { type: 'vote', role, round, redFails, onTeam: p.teamSeats.includes(seat) }, attempt: p.attempt,
          human: p.votes[seat - 1] ? 'approve' : 'reject',
          obs: () => buildReplayObservation(game, seat, { kind: 'team_vote', proposal: idx }), seedKey: `vote-${idx}`,
        });
      }
    }
    const pinned = pinnedQuestCard(game, round, seat);
    if (pinned !== null && campOf(role) === 'evil') {
      out.push({
        lite: { type: 'quest', role, round, redFails }, attempt: 0, human: pinned,
        obs: () => buildReplayObservation(game, seat, { kind: 'quest_vote', round }), seedKey: `quest-${round}`,
      });
    }
  }
  if (role === 'assassin' && game.assassinTargetSeat !== undefined) {
    out.push({
      lite: { type: 'assassinate', role, round: game.quests.length, redFails: redFailsBefore(game, 6) }, attempt: 0,
      human: String(game.assassinTargetSeat),
      obs: () => buildReplayObservation(game, seat, { kind: 'assassination' }), seedKey: 'assassinate',
    });
  }
  return out;
}

function decide(agent: HeuristicAgent, sp: SeatSpot, game: ReplayGame, seat: number): string {
  const action: AgentAction = withSeed(`${game.id}|${seat}|${sp.seedKey}`, () => agent.act(sp.obs()));
  switch (sp.lite.type) {
    case 'team': return action.type === 'team_select' ? action.teamIds.map(seatOfId).sort((a, b) => a - b).join(',') : '';
    case 'vote': return action.type === 'team_vote' ? (action.vote ? 'approve' : 'reject') : '';
    case 'quest': return action.type === 'quest_vote' ? action.vote : 'success';
    case 'assassinate': return action.type === 'assassinate' ? String(seatOfId(action.targetId)) : '';
  }
}

/** 一個座位、一組開關（或一份 profile）→ 想要的決策點的機器人選擇。 */
function replayWith(game: ReplayGame, seat: number, spots: SeatSpot[], tuning: AgentTuning, wants: (s: SpotLite) => boolean): Map<number, string> {
  const res = new Map<number, string>();
  const idxs = spots.map((s, i) => (wants(s.lite) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return res;
  const agent = new HeuristicAgent(seatId(seat), undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  for (const i of idxs) res.set(i, decide(agent, spots[i], game, seat));
  return res;
}

function runShard(a: Args): void {
  const ds = loadJson<Dataset>(a.dataset);
  const jobs = loadJson<Job[]>(a.jobs!);
  const profiles = a.profiles ? loadJson<Record<string, BotProfile>>(a.profiles) : null;
  const probes = buildProbes().filter((p) => !a.probeIds || a.probeIds.includes(p.id));
  const families = buildFamilies();
  const [k, n] = a.shard!;
  const iId = ds.fields.indexOf('id');
  const rowOf = new Map(ds.games.map((r) => [String(r[iId]), r]));
  const games = new Map<string, ReplayGame>();
  const out: RawSpot[] = [];
  for (let j = k; j < jobs.length; j += n) {
    const [gid, seat, player] = jobs[j];
    let game = games.get(gid);
    if (!game) {
      const res = replayGameFromDataset(rowOf.get(gid)!, ds);
      if (!res.ok) continue;
      game = res.value.game;
      games.set(gid, game);
    }
    const spots = seatSpots(game, seat);
    const decisions: Array<Record<string, string>> = spots.map(() => ({}));
    const role = game.seatRoles[seat - 1];
    if (profiles) {
      // 檢查：合起來的 profile 實際重播（只算擬合用到的決策族）。
      const profile = profiles[String(player)];
      if (!profile) continue;
      const tuning = resolveProfileTuning(profile, role, campOf(role) as ArenaSide);
      const inFamily = (s: SpotLite): boolean => familyOf(families, s) !== undefined;
      for (const [i, v] of replayWith(game, seat, spots, tuning, inFamily)) decisions[i].K = v;
    } else {
      for (const probe of probes) {
        const tuning: AgentTuning = { ...DEFAULT_AGENT_TUNING, ...(probe.knobs as Partial<AgentTuning>) };
        for (const [i, v] of replayWith(game, seat, spots, tuning, probe.wants)) decisions[i][probe.id] = v;
      }
    }
    spots.forEach((s, i) => {
      if (Object.keys(decisions[i]).length === 0) return;
      out.push([j, s.lite.type, s.lite.round, s.attempt, s.lite.redFails, s.lite.onTeam ? 1 : 0, s.human, decisions[i]]);
    });
    if (k === 0 && j % (n * 200) === 0) console.error(`  shard 0: job ${j}/${jobs.length}`);
  }
  fs.writeFileSync(a.shardOut!, JSON.stringify(out));
}

async function runWorkers(a: Args, jobs: Job[], extra: string[], tag: string): Promise<RawSpot[]> {
  const dir = fs.mkdtempSync(path.join(a.out!, `${tag}-`));
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const started = Date.now();
  await Promise.all(Array.from({ length: a.workers }, (_, k) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], ['--dataset', a.dataset, '--jobs', jobsFile, '--shard', `${k}/${a.workers}`, '--shard-out', path.join(dir, `s${k}.json`), ...extra], {
      execArgv: process.execArgv, stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
  })));
  let spots: RawSpot[] = [];
  for (let k = 0; k < a.workers; k++) spots = spots.concat(loadJson<RawSpot[]>(path.join(dir, `s${k}.json`)));
  console.error(`${tag}: ${jobs.length} seats → ${spots.length} decision points in ${((Date.now() - started) / 1000).toFixed(0)}s (${a.workers} workers)`);
  fs.writeFileSync(path.join(a.out!, `${tag}.json`), JSON.stringify({ jobs, spots }));
  fs.rmSync(dir, { recursive: true, force: true });
  return spots;
}

// ── 選玩家 ─────────────────────────────────────────────────

interface Selected {
  id: string;
  games: number;
  strong: string[];
  reason: string;
  seats: number;
  indices: number[];
}

function selectPlayers(a: Args, ds: Dataset): { selected: Selected[]; jobs: Job[]; skipped: Array<{ id: string; why: string }> } {
  const aliasFile = fs.existsSync(a.aliases) ? loadJson<{ aliases?: Record<string, string> }>(a.aliases) : {};
  const aliasMap: Record<string, string> = { ...(aliasFile.aliases ?? {}), ...(ds.aliases ?? {}) };
  const keyOf = (name: string): string => playerIdentityKey(name, aliasMap);
  const iSeats = ds.fields.indexOf('seats');
  const iId = ds.fields.indexOf('id');
  const iSrc = ds.fields.indexOf('src');
  const iCat = ds.fields.indexOf('cat');
  const iNote = ds.fields.indexOf('note');
  const isBotGame = (row: DatasetTuple): boolean => ds.vocab.category?.[row[iCat] as number] === '百科AI';

  // 併名字：同一個 identity key 的 players 編號一組；顯示名稱 = 那一組裡場數最多的寫法（同網站）。
  const perIndex = new Map<number, number>();
  for (const row of ds.games) {
    if (isBotGame(row)) continue;
    for (const k of new Set(row[iSeats] as number[])) if (k >= 0) perIndex.set(k, (perIndex.get(k) ?? 0) + 1);
  }
  const groups = new Map<string, number[]>();
  ds.players.forEach((name, i) => { const key = keyOf(name); groups.set(key, [...(groups.get(key) ?? []), i]); });
  const gamesOfGroup = (idx: number[]): number => {
    const set = new Set(idx);
    return ds.games.filter((row) => !isBotGame(row) && (row[iSeats] as number[]).some((k) => set.has(k))).length;
  };

  const { cohorts } = loadStrongCohorts({ dataset: a.dataset, analysis: a.analysis });
  const strongOf = new Map<string, string[]>();
  for (const f of FACETS) {
    (cohorts.facets[f] ?? []).slice(0, a.strongTop).forEach((e, r) => {
      const key = keyOf(e.name);
      strongOf.set(key, [...(strongOf.get(key) ?? []), `${f}#${r + 1}`]);
    });
  }

  const dbRows = fs.existsSync(a.gameDb) ? loadJson<{ games: GameDbRow[] }>(a.gameDb).games : [];
  const corrections = fs.existsSync(a.corrections) ? loadJson<{ corrections: Record<string, GameDbCorrection> }>(a.corrections).corrections : {};
  const excluded = excludedDatasetKeys(dbRows, corrections);
  const replayable = new Map<string, ReplayGame>();
  for (const row of ds.games) {
    const gid = String(row[iId]);
    const notes = ((row[iNote] as number[] | undefined) ?? []).map((i) => ds.vocab.noteTags[i]);
    if (isBotGame(row) || excluded.has(`${row[iSrc]}|${gid}`) || notes.includes('flag:badGame')) continue;
    const res = replayGameFromDataset(row, ds);
    if (res.ok) replayable.set(gid, res.value.game);
  }

  const selected: Selected[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  for (const [key, idx] of groups) {
    const games = gamesOfGroup(idx);
    const strong = strongOf.get(key) ?? [];
    if (games < a.minGames && strong.length === 0) continue;
    if (a.exclude.some((x) => keyOf(x) === key)) { skipped.push({ id: ds.players[idx[0]], why: '--exclude' }); continue; }
    const id = idx.slice().sort((x, y) => (perIndex.get(y) ?? 0) - (perIndex.get(x) ?? 0))[0];
    const name = ds.players[id];
    if (!knightNameFits(name)) { skipped.push({ id: name, why: '名字太長，放不進擂台名字（24 字）' }); continue; }
    selected.push({ id: name, games, strong, reason: [games >= a.minGames ? `games>=${a.minGames}` : '', strong.length ? 'strong' : ''].filter(Boolean).join('+'), seats: 0, indices: idx });
  }
  selected.sort((x, y) => y.games - x.games || x.id.localeCompare(y.id));
  const jobs: Job[] = [];
  selected.forEach((p, pi) => {
    const set = new Set(p.indices);
    for (const row of ds.games) {
      const gid = String(row[iId]);
      const game = replayable.get(gid);
      if (!game) continue;
      (row[iSeats] as number[]).forEach((k, i) => {
        if (!set.has(k)) return;
        jobs.push([gid, i + 1, pi, halfOf(gid)]);
        p.seats += 1;
      });
    }
  });
  return { selected, jobs, skipped };
}

// ── 擬合 ───────────────────────────────────────────────────

interface PlayerFit {
  id: string;
  choices: FittedChoices;
  families: Record<string, { fitN: number; heldN: number; heldDefault: number; heldKnight: number }>;
  held: { n: number; default: number; knight: number };
  fit: { n: number; default: number; knight: number };
  realized?: { n: number; default: number; knight: number };
}

function toScored(raw: RawSpot[], jobs: Job[], roleOf: (j: Job) => string): Array<ScoredSpot & { player: number; half: 0 | 1; key: string }> {
  return raw.map(([j, type, round, attempt, redFails, onTeam, human, agent]) => {
    const job = jobs[j];
    return { type, role: roleOf(job), round, redFails, onTeam: onTeam === 1, human, agent, player: job[2], half: job[3], key: `${j}|${type}|${round}|${attempt}` };
  });
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a.shard) { runShard(a); return; }
  if (!a.out) throw new Error('--out DIR is required (outside the repo: players.csv lists player IDs with game counts)');
  if (isInside(a.out, REPO)) throw new Error(`--out must be outside the repo (${REPO})`);
  fs.mkdirSync(a.out, { recursive: true });
  const ds = loadJson<Dataset>(a.dataset);
  const sel = selectPlayers(a, ds);
  const { selected, skipped } = sel;
  const jobs = a.sample ? sel.jobs.filter((_, i) => i % Math.max(1, Math.floor(sel.jobs.length / a.sample!)) === 0) : sel.jobs;
  const csv = ['id,games,reason,strong_facets,seats_replayable', ...selected.map((p) => `${JSON.stringify(p.id)},${p.games},${p.reason},${p.strong.join(' ')},${p.seats}`)];
  fs.writeFileSync(path.join(a.out, 'players.csv'), `${csv.join('\n')}\n`);
  console.error(`selected ${selected.length} players (${selected.filter((p) => p.reason.includes('games')).length} by games, ${selected.filter((p) => p.strong.length).length} strong); ${jobs.length} seats; skipped ${skipped.length}`);
  if (a.selectOnly) return;

  const iId = ds.fields.indexOf('id');
  const roleCache = new Map<string, string[]>();
  const rowOf = new Map(ds.games.map((r) => [String(r[iId]), r]));
  const roleOf = (job: Job): string => {
    let roles = roleCache.get(job[0]);
    if (!roles) {
      const res = replayGameFromDataset(rowOf.get(job[0])!, ds);
      roles = res.ok ? res.value.game.seatRoles : [];
      roleCache.set(job[0], roles);
    }
    return roles[job[1] - 1];
  };

  const probesFile = path.join(a.out, 'probes.json');
  let raw: RawSpot[];
  if (fs.existsSync(probesFile)) {
    const cached = loadJson<{ jobs: Job[]; spots: RawSpot[] }>(probesFile);
    if (JSON.stringify(cached.jobs) !== JSON.stringify(jobs)) throw new Error(`${probesFile} was made for different seats; delete it to recompute`);
    raw = cached.spots;
    console.error(`probes: reused ${raw.length} decision points from ${probesFile}`);
    // 快取之後加的格點值：只補算缺的那幾次重播，併進去。
    const have = new Set<string>();
    for (const r of raw) for (const id of Object.keys(r[7])) have.add(id);
    const missing = buildProbes().map((p) => p.id).filter((id) => !have.has(id));
    if (missing.length) {
      const extra = await runWorkers(a, jobs, ['--probe-ids', missing.join(',')], 'probes-extra');
      const keyOf = (r: RawSpot): string => `${r[0]}|${r[1]}|${r[2]}|${r[3]}`;
      const byKey = new Map(raw.map((r) => [keyOf(r), r]));
      for (const r of extra) {
        const old = byKey.get(keyOf(r));
        if (old) Object.assign(old[7], r[7]);
        else { raw.push(r); byKey.set(keyOf(r), r); }
      }
      fs.writeFileSync(probesFile, JSON.stringify({ jobs, spots: raw }));
      console.error(`probes: added ${missing.join(',')}`);
    }
  } else {
    raw = await runWorkers(a, jobs, [], 'probes');
  }
  const families = buildFamilies();
  const spots = toScored(raw, jobs, roleOf);

  // 每一族：全體（擬合的一半）的候選分數 = 收縮的目標。
  const famSpots = new Map<string, typeof spots>();
  for (const s of spots) {
    const f = familyOf(families, s);
    if (!f) continue;
    famSpots.set(f.id, [...(famSpots.get(f.id) ?? []), s]);
  }
  const population = new Map<string, CandidateScore[]>();
  for (const f of families) population.set(f.id, scoreFamily(f, (famSpots.get(f.id) ?? []).filter((s) => s.half === 0)));

  const fits: PlayerFit[] = selected.map((p, pi) => {
    const fit: PlayerFit = { id: p.id, choices: {}, families: {}, held: { n: 0, default: 0, knight: 0 }, fit: { n: 0, default: 0, knight: 0 } };
    for (const f of families) {
      const mine = (famSpots.get(f.id) ?? []).filter((s) => s.player === pi);
      const fitHalf = mine.filter((s) => s.half === 0);
      const held = mine.filter((s) => s.half === 1);
      const choice = chooseShrunk(scoreFamily(f, fitHalf), population.get(f.id)!, a.kappa);
      if (choice) fit.choices[f.id] = choice;
      const hd = familyAgreement(f, held, null);
      const hk = familyAgreement(f, held, choice);
      const fd = familyAgreement(f, fitHalf, null);
      const fk = familyAgreement(f, fitHalf, choice);
      fit.families[f.id] = { fitN: fitHalf.length, heldN: held.length, heldDefault: hd.sum, heldKnight: hk.sum };
      fit.held.n += hd.n; fit.held.default += hd.sum; fit.held.knight += hk.sum;
      fit.fit.n += fd.n; fit.fit.default += fd.sum; fit.fit.knight += fk.sum;
    }
    return fit;
  });

  // 留下：留出的一半比百科AI 一致；開關和預設一樣的（沒有東西可改）不算。
  const kept = fits.map((f) => {
    const layers = choicesToLayers(families, f.choices);
    const differs = Boolean(layers.sides || layers.roles);
    return { fit: f, layers, keep: differs && f.held.knight > f.held.default };
  });

  // 檢查：留出的一半用合起來的 profile 實際重播。
  const profiles: Record<string, BotProfile> = {};
  const center = styleCenter(kept.filter((k) => k.keep).map((k) => k.layers));
  kept.forEach((k, pi) => { if (k.keep) profiles[String(pi)] = buildKnightProfile(k.fit.id, 1, k.layers, center); });
  const profilesFile = path.join(a.out, 'profiles.json');
  fs.writeFileSync(profilesFile, JSON.stringify(profiles));
  const heldJobs = jobs.filter((j) => j[3] === 1 && profiles[String(j[2])]);
  const realizedRaw = await runWorkers(a, heldJobs, ['--profiles', profilesFile], 'realized');
  const realizedSpots = toScored(realizedRaw, heldJobs, roleOf);
  const dIndex = new Map(spots.filter((s) => s.half === 1).map((s) => {
    const [j, ...rest] = s.key.split('|');
    const job = jobs[Number(j)];
    return [`${job[0]}|${job[1]}|${job[2]}|${rest.join('|')}`, s] as const;
  }));
  for (const s of realizedSpots) {
    const [j, ...rest] = s.key.split('|');
    const job = heldJobs[Number(j)];
    const d = dIndex.get(`${job[0]}|${job[1]}|${job[2]}|${rest.join('|')}`);
    if (!d || d.agent.D === undefined) continue;
    const f = kept[job[2]].fit;
    f.realized ??= { n: 0, default: 0, knight: 0 };
    f.realized.n += 1;
    f.realized.default += d.agent.D === s.human ? 1 : 0;
    f.realized.knight += s.agent.K === s.human ? 1 : 0;
  }

  // 輸出
  fs.writeFileSync(path.join(a.out, 'fit.json'), JSON.stringify({ selected: selected.map(({ indices: _i, ...rest }) => rest), skipped, fits, kept: kept.map((k) => ({ id: k.fit.id, keep: k.keep })) }, null, 1));
  const gain = (x: { n: number; default: number; knight: number }): number => (x.n ? (100 * (x.knight - x.default)) / x.n : 0);
  const knights = kept.filter((k) => k.keep).map((k) => {
    const profile = buildKnightProfile(k.fit.id, 1, k.layers, center);
    const v = validateProfile(profile, knightFolderId(k.fit.id, 1), { house: true });
    if (!v.ok) throw new Error(`${k.fit.id}: generated profile invalid: ${v.errors.join('; ')}`);
    return { folder: knightFolderId(k.fit.id, 1), profile, fit: k.fit };
  });
  const folders = new Set(knights.map((k) => k.folder));
  if (folders.size !== knights.length) throw new Error('duplicate knight folder ids');

  const table = kept.map((k) => ({
    name: k.keep ? buildKnightProfile(k.fit.id, 1, k.layers, center).name : null,
    kept: k.keep,
    tag: k.keep ? buildKnightProfile(k.fit.id, 1, k.layers, center).tag : null,
    heldDecisions: k.fit.held.n,
    heldAgreementDefault: Math.round((1000 * k.fit.held.default) / Math.max(1, k.fit.held.n)) / 10,
    heldAgreementKnight: Math.round((1000 * k.fit.held.knight) / Math.max(1, k.fit.held.n)) / 10,
    heldGainPp: Math.round(100 * gain(k.fit.held)) / 100,
    realizedGainPp: k.fit.realized ? Math.round(100 * gain(k.fit.realized)) / 100 : null,
    fitGainPp: Math.round(100 * gain(k.fit.fit)) / 100,
  }));
  const gains = table.map((t) => t.heldGainPp).sort((x, y) => x - y);
  const q = (p: number): number => gains[Math.min(gains.length - 1, Math.max(0, Math.round(p * (gains.length - 1))))];
  const tagCounts: Record<string, number> = {};
  for (const k of knights) tagCounts[k.profile.tag!] = (tagCounts[k.profile.tag!] ?? 0) + 1;
  const summary = {
    generatedAt: new Date().toISOString(),
    method: '真人局重播（第 1 關／人類 PR 量尺同一套）；局依局號雜湊分兩半，擬合的一半挑開關（往全體收縮，κ = ' + a.kappa + '），留出的一半比一致度；比百科AI 高才留下。',
    players: selected.length,
    kept: knights.length,
    selection: { minGames: a.minGames, strongTop: a.strongTop, byGames: selected.filter((p) => p.reason.includes('games')).length, strong: selected.filter((p) => p.strong.length).length },
    heldGainPp: gains.length ? { min: gains[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: gains[gains.length - 1] } : null,
    tagCounts,
    styleCenter: center,
    knights: table,
  };
  console.log(JSON.stringify({ players: summary.players, kept: summary.kept, heldGainPp: summary.heldGainPp, tagCounts }, null, 1));
  if (a.summary) fs.writeFileSync(a.summary, `${JSON.stringify(summary, null, 1)}\n`);

  if (a.writeKnights) {
    fs.mkdirSync(KNIGHTS_DIR, { recursive: true });
    // 只清掉這支程式以前寫的資料夾（knight-*）。
    for (const e of fs.readdirSync(KNIGHTS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('knight-') && !folders.has(e.name)) fs.rmSync(path.join(KNIGHTS_DIR, e.name), { recursive: true });
    }
    for (const k of knights) {
      const dir = path.join(KNIGHTS_DIR, k.folder);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'profile.json'), `${JSON.stringify(k.profile, null, 2)}\n`);
    }
    console.error(`wrote ${knights.length} knights to ${KNIGHTS_DIR}`);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export type { Probe };
