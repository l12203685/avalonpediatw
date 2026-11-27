/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 90 回合（路線圖 Phase C）第 2 號模型的資料：每一個刺殺點（三藍之後，真人局或自我對打）一列，每個候選人（非紅、非刺客）的特徵
 * （`ASSASSIN_FEATURES_90`）、是不是梅林、現行刺客的分層與世界線分數、現行刺客（`DEFAULT_AGENT_TUNING`）刺誰、候選設定（--flag）刺誰。
 * 只有座位、角色、特徵，沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/ml/exportAssassin90.ts --export-human OUT.jsonl [--flag k=v ...]
 *   npx tsx scripts/ml/exportAssassin90.ts --export-bot NORM.jsonl OUT.jsonl [--flag k=v ...] [--limit N] [--model X.json]
 *     NORM.jsonl = `keySpotStudy.ts --export-bot` 的輸出（自我對打 detail=1 的整局紀錄，座位以 1-1 隊長為 1 家）。
 *
 * 時間切分（`late`）：十人局照日期排序，後 1/3 = 驗證（同 `exportBelief90.ts`、第 89 回合）。
 * 刺殺是一局的最後一個動作，前面的局面不受刺客怎麼刺影響，所以同一份自我對打紀錄可以逐局配對比較「現行」與「候選」的刺殺（第 61、75 回合的做法）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../../src/ai/HeuristicAgent';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from '../../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId, seatOfId } from '../../src/ai/benchmark/replayObservation';
import { withSeededRandom } from '../../src/ai/benchmark/agreement';
import { campOf, type ReplayGame } from '../../src/ai/benchmark/sheetsReplay';
import { ASSASSIN_FEATURES_90, assassinFeatures90 } from '../../src/ai/ml/assassinFeatures90';
import { timeSplit } from './exportBelief90';
import { setAssassinModel90 } from '../../src/ai/Round90';
import type { ModelJson } from '../../src/ai/ml/mlModel90';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

const baseTuning = resolveAgentTuning({ ...DEFAULT_AGENT_TUNING });
const candFlags = args('--flag');
const candTuning = candFlags.length ? resolveAgentTuning(Object.assign({ ...DEFAULT_AGENT_TUNING }, ...candFlags.map(parseTuningFlag))) : null;
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);
// --model X.json：第 2 號換成這一份（交叉擬合時，量哪一組機器人局就用沒看過它的那一份）。
const modelPath = arg('--model');
if (modelPath) setAssassinModel90(JSON.parse(fs.readFileSync(modelPath, 'utf8')) as ModelJson);

interface Spot { gi: number; late: number; s: number | null; game: ReplayGame; logged?: number | null }

function pick(g: ReplayGame, aSeat: number, tuning: ReturnType<typeof resolveAgentTuning>): number | null {
  const obs = buildReplayObservation(g, aSeat, { kind: 'assassination' });
  const agent = new HeuristicAgent(seatId(aSeat), undefined, undefined, tuning);
  const act = withSeededRandom(`${g.id}|${aSeat}|assassinate`, () => agent.act(obs));
  return act.type === 'assassinate' ? seatOfId(act.targetId) : null;
}

function row(sp: Spot): Record<string, unknown> | null {
  const g = sp.game;
  if (g.playerCount !== 10 || g.assassinTargetSeat === undefined) return null;
  const aSeat = g.seatRoles.indexOf('assassin') + 1;
  const mSeat = g.seatRoles.indexOf('merlin') + 1;
  if (aSeat <= 0 || mSeat <= 0) return null;
  const obs = buildReplayObservation(g, aSeat, { kind: 'assassination' });
  const agent = new HeuristicAgent(seatId(aSeat), undefined, undefined, baseTuning);
  const read = agent.assassinationReadout(obs);
  if (!read) return null;
  const fx = assassinFeatures90(obs, read.candidates, new Set(read.front));
  if (!fx) return null;
  const cur = pick(g, aSeat, baseTuning);
  const cand = candTuning ? pick(g, aSeat, candTuning) : null;
  const cands = fx.ids.map((id, i) => ({
    seat: seatOfId(id), front: read.front.includes(id) ? 1 : 0, wl: read.terms.get(id)?.worldLine ?? null,
    x: Array.from(fx.rows[i], (v) => Number(v.toFixed(5))),
  }));
  return { gi: sp.gi, late: sp.late, s: sp.s, merlin: mSeat, human: g.assassinTargetSeat, logged: sp.logged ?? null, cur, cand, cands };
}

function write(out: string, spots: Iterable<Spot>): void {
  const fd = fs.openSync(out, 'w');
  let n = 0;
  let k = 0;
  for (const sp of spots) {
    k++;
    const r = row(sp);
    if (r) { fs.writeSync(fd, JSON.stringify(r) + '\n'); n++; }
    if (k % 1000 === 0) console.error(`${k} games, ${n} spots`);
  }
  fs.closeSync(fd);
  fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.meta.json', JSON.stringify({ features: ASSASSIN_FEATURES_90, spots: n, flags: candFlags }));
  console.error(`wrote ${n} assassination spots → ${out}`);
}

function* humanSpots(): Generator<Spot> {
  const root = path.resolve(__dirname, '..', '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const games = replayGamesFromDataset(raw).games.filter((g) => g.game.playerCount === 10);
  const late = timeSplit(games.map((g) => g.date));
  for (let gi = 0; gi < games.length; gi++) {
    const d = games[gi];
    if (d.noteTags.some((t) => EXCLUDED_TAGS.has(t))) continue;
    yield { gi, late: late[gi] ? 1 : 0, s: d.s, game: d.game };
  }
}

/** `keySpotStudy.ts --export-bot` 的一局 → ReplayGame（10 人、座位 1..10、隊長從 1 家輪；同 `assassinPathStudy.ts`）。 */
interface NormGame {
  gi: number; roles: string[];
  props: [number, number, number, number[], number[] | null, boolean, boolean][];
  quests: [number, number[], number][];
  lakes: [number, number, number, string][];
  at: number | null;
}

export function replayOfNorm(n: NormGame): ReplayGame {
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
    yield { gi: n.gi, late: 0, s: null, game: g, logged: n.at };
  }
}

function main(): void {
  const h = arg('--export-human');
  if (h) return write(h, humanSpots());
  const bi = argv.indexOf('--export-bot');
  if (bi >= 0) return write(argv[bi + 2], botSpots(argv[bi + 1], Number(arg('--limit') ?? Infinity)));
  throw new Error('--export-human OUT | --export-bot NORM.jsonl OUT');
}

if (require.main === module) main();
