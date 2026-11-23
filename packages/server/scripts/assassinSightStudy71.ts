/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 71 回合（紅方・刺客）：刺殺模型的特徵用「刺客自己的隊友」與「梅林看得到的紅」兩種參照，在真人刺殺點與自我對打紀錄上匯出，
 * 給 `assassinSightStudy71.py` 交叉擬合（偶數號／奇數號）比較刺中率。只有座位、分數與特徵，沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/assassinSightStudy71.ts --export-human OUT [--flag k=v ...]
 *   npx tsx scripts/assassinSightStudy71.ts --export-bot NORM.jsonl OUT [--flag k=v ...]
 *
 * 每列：局序號、桌上 S、任務順序、梅林座位、真人（或紀錄）的目標、機器人目標；每個候選人：座位、在不在分層的第一層、
 * 現行刺殺分數的各項（模型、投票、湖、隊長、照派）、模型特徵 x（舊參照）與 xs（梅林看得到的紅）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { missionOrder61 } from '../src/ai/RedRound61';
import { assassinCandidateFeatures } from '../src/ai/assassin/AssassinModel';
import { assassinSight71 } from '../src/ai/Round71';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)));
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

interface Spot { gi: number; s: number | null; game: ReplayGame; logged?: number | null }

function row(sp: Spot): Record<string, unknown> | null {
  const g = sp.game;
  if (g.playerCount !== 10 || g.assassinTargetSeat === undefined) return null;
  const aSeat = g.seatRoles.indexOf('assassin') + 1;
  const mSeat = g.seatRoles.indexOf('merlin') + 1;
  if (aSeat <= 0 || mSeat <= 0) return null;
  const obs = buildReplayObservation(g, aSeat, { kind: 'assassination' });
  const agent = new HeuristicAgent(seatId(aSeat), undefined, undefined, tuning);
  const read = agent.assassinationReadout(obs);
  if (!read) return null;
  const act = withSeededRandom(`${g.id}|${aSeat}|assassinate`, () => agent.act(obs));
  const bot = act.type === 'assassinate' ? seatOfId(act.targetId) : null;
  const sight = assassinSight71({ ...tuning, assassinSight71: 7 }, obs);
  const front = new Set(read.front);
  const cands = read.candidates.map((id) => {
    const t = read.terms.get(id)!;
    return {
      seat: seatOfId(id), front: front.has(id) ? 1 : 0, total: r4(read.scores.get(id) ?? 0),
      model: r4(t.model), vote: r4(t.vote), lake: r4(t.lake), lead: r4(t.lead), reuse: r4(t.reuse),
      x: assassinCandidateFeatures(obs, id).map(r4), xs: assassinCandidateFeatures(obs, id, sight).map(r4),
    };
  });
  return { gi: sp.gi, s: sp.s, order: missionOrder61(obs), merlin: mSeat, human: g.assassinTargetSeat, bot, logged: sp.logged, cands };
}

function write(out: string, spots: Iterable<Spot>): void {
  const fd = fs.openSync(out, 'w');
  let n = 0;
  for (const sp of spots) {
    const r = row(sp);
    if (r) { fs.writeSync(fd, JSON.stringify(r) + '\n'); n++; }
  }
  fs.closeSync(fd);
  console.error(`wrote ${n} assassination spots → ${out}`);
}

function* humanSpots(): Generator<Spot> {
  const root = path.resolve(__dirname, '..');
  const { games } = replayGamesFromDataset(JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')));
  for (let gi = 0; gi < games.length; gi++) {
    const d = games[gi];
    if (d.noteTags.some((t) => EXCLUDED_TAGS.has(t))) continue;
    yield { gi, s: d.s, game: d.game };
  }
}

/** `keySpotStudy.ts --export-bot` 的一局（同 `assassinPathStudy.ts`）。 */
interface NormGame {
  gi: number; roles: string[];
  props: [number, number, number, number[], number[] | null, boolean, boolean][];
  quests: [number, number[], number][];
  lakes: [number, number, number, string][];
  at: number | null;
}

function replayOfNorm(n: NormGame): ReplayGame {
  const seats = Array.from({ length: 10 }, (_, i) => i + 1);
  return {
    id: `bot${n.gi}`, playerCount: 10, seatRoles: n.roles as Role[], names: Array(10).fill(''),
    proposals: n.props.map(([round, attempt, leader, team, appr, forced, went], gi) => {
      const votes = seats.map((s) => (forced ? team.includes(s) : (appr ?? []).includes(s)));
      return {
        round, attempt, globalIndex: gi, leaderSeat: leader, teamSeats: [...team],
        plusSeats: forced ? [] : seats.filter((s) => votes[s - 1] && !team.includes(s)),
        minusSeats: forced ? [] : team.filter((s) => !votes[s - 1]),
        votes, approveCount: votes.filter(Boolean).length, forced, wentOnMission: went, votesReliable: !forced,
      };
    }),
    quests: n.quests.map(([round, team, fails]) => ({ round, teamSeats: [...team], successCount: team.length - fails, failCount: fails, failed: fails >= (round === 4 ? 2 : 1) })),
    lakes: n.lakes.map(([round, holder, target, claim]) => ({ round, holderSeat: holder, targetSeat: target, claim: claim === 'o' ? 'good' : claim === 'x' ? 'evil' : null })),
    lakeChainValid: true, assassinTargetSeat: n.at ?? undefined, winner: 'good',
  };
}

function* botSpots(file: string): Generator<Spot> {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const n = JSON.parse(line) as NormGame;
    if (n.at === null || n.at === undefined) continue;
    const g = replayOfNorm(n);
    if (!g.seatRoles.every((r) => campOf(r as Role))) continue;
    yield { gi: n.gi, s: null, game: g, logged: n.at };
  }
}

function main(): void {
  const h = arg('--export-human');
  if (h) return write(h, humanSpots());
  const bi = argv.indexOf('--export-bot');
  if (bi >= 0) return write(argv[bi + 2], botSpots(argv[bi + 1]));
  throw new Error('--export-human OUT | --export-bot NORM.jsonl OUT');
}

main();
