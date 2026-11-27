/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 88 回合（`src/ai/Round88.ts`）：梅林的「被刺機率」估計器的資料整理，校準與彙總在 `merlinEvStudy88.py`。
 *
 * 每一個梅林當隊長的提議（真人局或自我對打）一列：局號、第幾局／第幾次、強制局、隊上看得到的紅數、
 * 梅林估的「刺客的世界線認我是梅林」的機率——派之前（eb）、派了實際這一隊之後（ea）、候選隊（第 80 回合說得通的範圍＋實際的隊）裡最低／最高（emin、emax）——
 * 以及這一局的結果（三藍才有刺殺）、刺客有沒有刺中梅林、刺殺時刺客的世界線（四個紅方開牌，真的視角）認梅林的機率（wlEnd）。
 * 只有座位、角色、比例，沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/merlinEvStudy88.ts --human OUT.jsonl [--shard k/n]
 *   npx tsx scripts/merlinEvStudy88.ts --bot NORM.jsonl OUT.jsonl [--limit N] [--shard k/n]
 *     NORM.jsonl = `keySpotStudy.ts --export-bot` 的輸出（自我對打 detail=1 的整局紀錄）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Role } from '@avalon/shared';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { bayesOptionsOf, bayesRedShare } from '../src/ai/belief/BayesBelief';
import { merlinExposure88 } from '../src/ai/Round88';
import { loyalFree80Set } from '../src/ai/Round80';
import { worldLines75 } from '../src/ai/assassin/WorldLines75';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)), DEFAULT_AGENT_TUNING);
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);
const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
const r4 = (x: number): number => Math.round(x * 10000) / 10000;

interface Spot { gi: number; s: number | null; game: ReplayGame }

function rows(sp: Spot): string[] {
  const g = sp.game;
  if (g.playerCount !== 10) return [];
  const mSeat = g.seatRoles.indexOf('merlin') + 1;
  const aSeat = g.seatRoles.indexOf('assassin') + 1;
  if (mSeat <= 0 || aSeat <= 0) return [];
  const fails = g.quests.filter((q) => q.failed).length;
  const succ = g.quests.length - fails;
  const three = succ >= 3 && g.assassinTargetSeat !== undefined;
  const out = fails >= 3 ? 'red3' : three ? (g.assassinTargetSeat === mSeat ? 'blueDead' : 'blueAlive') : null;
  if (out === null) return [];
  let wlEnd: number | null = null;
  if (three) {
    const aObs = buildReplayObservation(g, aSeat, { kind: 'assassination' });
    const wl = worldLines75(aObs);
    if (wl) wlEnd = r4(Math.exp(wl.merlin.get(seatId(mSeat)) ?? Number.NEGATIVE_INFINITY));
  }
  const ownOpts = bayesOptionsOf(tuning);
  const lines: string[] = [];
  g.proposals.forEach((p, idx) => {
    if (p.leaderSeat !== mSeat) return;
    const obs = buildReplayObservation(g, mSeat, { kind: 'team_select', proposal: idx });
    const own = bayesRedShare(obs, ownOpts);
    const team = p.teamSeats.map(seatId);
    const set = loyalFree80Set(tuning, obs, team.length, 0.5, () => true, []);
    const cands = set ? set.teams.filter((t) => t.plausible).map((t) => t.team) : [];
    const ex = merlinExposure88(obs, [team, ...cands], own);
    if (!ex) return;
    const seen = new Set(obs.knownEvils);
    const candE = ex.after.slice(1);
    const cleanE = candE.filter((_, i) => !cands[i].some((id) => seen.has(id)));
    const thumbE = candE.filter((_, i) => cands[i].filter((id) => seen.has(id)).length === 1);
    lines.push(JSON.stringify({
      gi: sp.gi, s: sp.s, round: p.round, attempt: p.attempt, forced: p.forced, went: p.wentOnMission,
      thumbs: team.filter((id) => seen.has(id)).length, eb: r4(ex.base), ea: r4(ex.after[0]),
      emin: candE.length ? r4(Math.min(...candE)) : null, emax: candE.length ? r4(Math.max(...candE)) : null,
      ecMin: cleanE.length ? r4(Math.min(...cleanE)) : null, ecMax: cleanE.length ? r4(Math.max(...cleanE)) : null,
      etMin: thumbE.length ? r4(Math.min(...thumbE)) : null, nC: cleanE.length, nT: thumbE.length,
      out, hit: three ? g.assassinTargetSeat === mSeat : null, wlEnd, score: [succ, fails],
    }));
  });
  return lines;
}

function* humanSpots(): Generator<Spot> {
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    if (d.noteTags.some((t) => EXCLUDED_TAGS.has(t))) continue;
    yield { gi, s: d.s, game: d.game };
  }
}

interface NormGame {
  gi: number; roles: string[];
  props: [number, number, number, number[], number[] | null, boolean, boolean][];
  quests: [number, number[], number][];
  lakes: [number, number, number, string][];
  at: number | null;
}

/** 同 `assassinPathStudy.ts` 的 `replayOfNorm`。 */
function replayOfNorm(n: NormGame): ReplayGame {
  const seats = Array.from({ length: 10 }, (_, i) => i + 1);
  return {
    id: `bot${n.gi}`,
    playerCount: 10,
    seatRoles: n.roles as Role[],
    names: Array(10).fill(''),
    proposals: n.props.map(([round, attempt, leader, team, appr, forced, went], gi) => {
      const votes = seats.map((s) => (forced ? team.includes(s) : (appr ?? []).includes(s)));
      return {
        round, attempt, globalIndex: gi, leaderSeat: leader, teamSeats: [...team],
        plusSeats: forced ? [] : seats.filter((s) => votes[s - 1] && !team.includes(s)),
        minusSeats: forced ? [] : team.filter((s) => !votes[s - 1]),
        votes, approveCount: votes.filter(Boolean).length, forced, wentOnMission: went, votesReliable: !forced,
      };
    }),
    quests: n.quests.map(([round, team, fails]) => ({
      round, teamSeats: [...team], successCount: team.length - fails, failCount: fails, failed: fails >= (round === 4 ? 2 : 1),
    })),
    lakes: n.lakes.map(([round, holder, target, claim]) => ({
      round, holderSeat: holder, targetSeat: target, claim: claim === 'o' ? 'good' : claim === 'x' ? 'evil' : null,
    })),
    lakeChainValid: true,
    assassinTargetSeat: n.at ?? undefined,
    winner: 'good',
  };
}

function* botSpots(file: string, limit: number): Generator<Spot> {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (let k = shardK; k < Math.min(lines.length, limit); k += shardN) {
    const n = JSON.parse(lines[k]) as NormGame;
    const g = replayOfNorm(n);
    if (!g.seatRoles.every((r) => campOf(r as Role))) continue;
    yield { gi: n.gi, s: null, game: g };
  }
}

function write(out: string, spots: Iterable<Spot>): void {
  const lines: string[] = [];
  let n = 0;
  for (const sp of spots) {
    lines.push(...rows(sp));
    if (++n % 200 === 0) console.error(`${n} games, ${lines.length} rows`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${out}`);
}

function main(): void {
  const h = arg('--human');
  if (h) return write(h, humanSpots());
  const bi = argv.indexOf('--bot');
  if (bi >= 0) return write(argv[bi + 2], botSpots(argv[bi + 1], Number(arg('--limit') ?? Infinity)));
  throw new Error('--human OUT | --bot NORM.jsonl OUT');
}

main();
