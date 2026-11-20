/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 51 回合（站長 11/18「當局沒有機會當隊長派任務的玩家 開外白的傾向上升／當局還有機會當隊長派任務的玩家 開內黑的傾向上升」）：
 * 真人局每一張可信的票（非強制提議、票數和結果相符、投票者不是這次的隊長），記
 *   局序號、桌上強度 S ≥ 55、投票者是不是強者（Elo 母體前 20%、生涯 ≥ 50 場，`strongCohort.strongPool`）、角色、第幾局、第幾次提議、
 *   在不在隊上、這一局之後還會不會當隊長（第 k+1..5 次提議；另外標是不是第 5 次強制局的隊長＝尾家）、贊成、隊上有沒有紅、隊長是不是紅、比分
 * → `--out rows.csv`（沒有玩家名、沒有局號，只有資料集裡的序號），分析在 `leaderVoteStudy.py`。
 * 機器人的同一張表由 `leaderVoteStudy.py --bot` 直接讀自我對打的 `detail=1` 結果。
 *
 *   cd packages/server && npx tsx scripts/leaderVoteStudy.ts --out rows.csv [--strong-s 55]
 */
import { DEFAULT_COHORT_CUTS } from '@avalon/shared/stats';
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { strongPool, type RatingRow } from '../src/ai/infl/strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const ROLE_CODE: Record<string, number> = { loyal: 0, percival: 1, merlin: 2, assassin: 3, morgana: 4, mordred: 5, oberon: 6 };

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const strongS = Number(arg('--strong-s') ?? DEFAULT_COHORT_CUTS.sHi); // 高端桌：網站分組的 S 上切點（第 1G 節）
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] };
  const analysis = JSON.parse(fs.readFileSync(arg('--analysis') ?? path.join(root, 'analysis_cache.json'), 'utf8')) as { rating: { players: RatingRow[] } };
  const pool = new Set(strongPool(analysis.rating.players, { topShare: 0.2, minGames: 50 }));
  const iId = dataset.fields.indexOf('id');
  const iSeats = dataset.fields.indexOf('seats');
  const seatsOf = new Map<string, number[]>();
  for (const row of dataset.games) seatsOf.set(String(row[iId]), (row[iSeats] as number[] | undefined) ?? []);
  const games = replayGamesFromDataset(dataset).games.filter((g) => g.game.playerCount === 10);
  const lines = ['g,st,sp,role,round,att,on,fut,tail,ahead,app,tred,lred,succ,fail'];
  let votes = 0;
  games.forEach((dg, gi) => {
    const game = dg.game;
    const seats = seatsOf.get(game.id) ?? [];
    const strongSeat = (s: number): boolean => seats[s - 1] !== undefined && seats[s - 1] >= 0 && pool.has(dataset.players[seats[s - 1]] ?? '');
    const st = dg.s !== null && dg.s >= strongS ? 1 : 0;
    for (const prop of game.proposals) {
      if (prop.forced || !prop.votesReliable) continue;
      const before = game.quests.filter((q) => q.round < prop.round);
      const succ = before.filter((q) => !q.failed).length;
      const fail = before.filter((q) => q.failed).length;
      const team = new Set(prop.teamSeats);
      const tred = prop.teamSeats.some((s) => EVIL_ROLES.has(game.seatRoles[s - 1])) ? 1 : 0;
      const lred = EVIL_ROLES.has(game.seatRoles[prop.leaderSeat - 1]) ? 1 : 0;
      const left = 5 - prop.attempt; // later proposals of this round: attempt+1 .. 5 (the 5th is the forced one)
      for (let seat = 1; seat <= 10; seat++) {
        if (seat === prop.leaderSeat) continue;
        const off = ((seat - prop.leaderSeat + 10) % 10); // seats ahead of the leader (1..9)
        const fut = off >= 1 && off <= left ? 1 : 0;
        const tail = off === left ? 1 : 0;
        const role = game.seatRoles[seat - 1];
        lines.push([gi, st, strongSeat(seat) ? 1 : 0, ROLE_CODE[role] ?? -1, prop.round, prop.attempt, team.has(seat) ? 1 : 0, fut, tail, off,
          prop.votes[seat - 1] ? 1 : 0, tred, lred, succ, fail].join(','));
        votes++;
      }
    }
  });
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`${games.length} games, ${votes} votes → ${out}`);
}

main();
