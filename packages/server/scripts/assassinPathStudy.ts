/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 61 回合（紅方・刺客）：刺殺點的資料整理，統計與擬合在 `assassinPathStudy.py`。
 *
 * 每一個刺殺點（真人局或自我對打）一列：任務順序、梅林的座位、真人刺客（或自我對打紀錄）的目標、機器人刺客（現行預設或 --flag）的目標，
 * 以及每個候選人（非紅、非刺客）的刺殺分數各項（`HeuristicAgent.assassinationReadout`）、是不是在分層的第一層、`RedRound61` 的特徵。
 * 只有座位、角色、分數，沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/assassinPathStudy.ts --export-human OUT [--flag k=v ...]
 *   npx tsx scripts/assassinPathStudy.ts --export-bot NORM.jsonl OUT [--flag k=v ...] [--limit N]
 *   npx tsx scripts/assassinPathStudy.ts --export-cards OUT [--flag k=v ...]
 *     第 2 局出牌：真人局第 1 局成功之後，第 2 局任務隊上每一個紅方座位，機器人（同一個時間點、只用那個座位的資訊）出的牌與真人的牌
 *     （真人的牌只有推得出來時才有：任務 0 張失敗 = 全部成功、失敗張數 = 紅數 = 全部失敗）。
 *     NORM.jsonl = `keySpotStudy.ts --export-bot` 的輸出（自我對打 detail=1 的整局紀錄，座位以 1-1 隊長為 1 家）。
 *
 * 刺殺是一局的最後一個動作，前面的局面不受刺客怎麼刺影響，所以同一份自我對打紀錄可以直接比「現行」和「候選」的刺殺（逐局配對、沒有抽樣差）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { pinnedQuestCard, withSeededRandom } from '../src/ai/benchmark/agreement';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { assassinPathFeatures61, missionOrder61 } from '../src/ai/RedRound61';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)));
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);

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
  const reds = obs.allEvilIds ?? [];
  const front = new Set(read.front);
  const cands = read.candidates.map((id) => {
    const t = read.terms.get(id)!;
    return { seat: seatOfId(id), front: front.has(id) ? 1 : 0, total: read.scores.get(id) ?? 0, ...t, f: assassinPathFeatures61(obs, id, reds) };
  });
  return { gi: sp.gi, s: sp.s, order: missionOrder61(obs), merlin: mSeat, human: g.assassinTargetSeat, bot, logged: sp.logged, cands };
}

function write(out: string, spots: Iterable<Spot>): void {
  const fd = fs.openSync(out, 'w');
  let n = 0;
  let k = 0;
  for (const sp of spots) {
    k++;
    const r = row(sp);
    if (r) { fs.writeSync(fd, JSON.stringify(r) + '\n'); n++; }
    if (k % 2000 === 0) console.error(`${k} games, ${n} spots`);
  }
  fs.closeSync(fd);
  console.error(`wrote ${n} assassination spots → ${out}`);
}

function* humanSpots(): Generator<Spot> {
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  for (let gi = 0; gi < games.length; gi++) {
    const d = games[gi];
    if (d.noteTags.some((t) => EXCLUDED_TAGS.has(t))) continue;
    yield { gi, s: d.s, game: d.game };
  }
}

/** `keySpotStudy.ts --export-bot` 的一局 → ReplayGame（10 人、座位 1..10、隊長從 1 家輪）。 */
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
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let k = 0;
  for (const line of lines) {
    if (!line) continue;
    const n = JSON.parse(line) as NormGame;
    if (n.at === null || n.at === undefined) continue;
    if (k++ >= limit) return;
    const g = replayOfNorm(n);
    if (!g.seatRoles.every((r) => campOf(r as Role))) continue;
    yield { gi: n.gi, s: null, game: g, logged: n.at };
  }
}

function exportCards(out: string): void {
  const lines: string[] = [];
  for (const sp of humanSpots()) {
    const g = sp.game;
    if (g.playerCount !== 10) continue;
    const q1 = g.quests.find((q) => q.round === 1);
    const q2 = g.quests.find((q) => q.round === 2);
    if (!q1 || !q2 || q1.failed) continue;
    const reds = q2.teamSeats.filter((s) => campOf(g.seatRoles[s - 1]) === 'evil');
    for (const seat of reds) {
      const agent = new HeuristicAgent(seatId(seat), undefined, undefined, tuning);
      agent.onGameStart(buildReplayObservation(g, seat, { kind: 'team_select', proposal: 0 }));
      const obs = buildReplayObservation(g, seat, { kind: 'quest_vote', round: 2 });
      const act = withSeededRandom(`${g.id}|${seat}|quest-2`, () => agent.act(obs));
      lines.push(JSON.stringify({
        gi: sp.gi, s: sp.s, seat, role: g.seatRoles[seat - 1], reds: reds.length,
        mates: obs.proposedTeam.filter((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id)).length,
        fails: q2.failCount, human: pinnedQuestCard(g, 2, seat), agent: act.type === 'quest_vote' ? act.vote : null,
      }));
    }
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} R2 red cards → ${out}`);
}

function main(): void {
  const c = arg('--export-cards');
  if (c) return exportCards(c);
  const h = arg('--export-human');
  if (h) return write(h, humanSpots());
  const bi = argv.indexOf('--export-bot');
  if (bi >= 0) return write(argv[bi + 2], botSpots(argv[bi + 1], Number(arg('--limit') ?? Infinity)));
  throw new Error('--export-human OUT | --export-bot NORM.jsonl OUT');
}

main();
