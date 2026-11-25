/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 73 回合（節點分支的拆解）：把人類 PR 量尺的逐決策紀錄（`humanPrBenchmark.ts --dump`，全部座位）接回真人局，
 * 輸出第 60 回合 `keySpotStudy.ts --replay` 同一個格式的決策點（多兩欄量尺的優勢），給 `keySpotStudy73.py` 在局勢樹的每個節點上
 * 同時算「選到較好動作的比例」（第 60 回合的落差）與人類 PR 量尺的落差（第 1H 節）。這樣一次重播就涵蓋全部真人局、全部座位，
 * 基準線與真人桌讀法（`--tier-profile`：每一桌照自己的強度層）各跑一次。
 *
 *   cd packages/server
 *   npx tsx scripts/humanPrBenchmark.ts --workers 4 --boot 0 --dump pr_A.jsonl                    # 基準線
 *   npx tsx scripts/humanPrBenchmark.ts --workers 4 --boot 0 --tier-profile --dump pr_H.jsonl     # 真人桌（分層）
 *   npx tsx scripts/keySpotStudy73.ts pr_A.jsonl --out rep_A.jsonl
 *
 * 每列（只有資料集序號、座位、角色、動作，沒有玩家名）：gi、s（桌上強度）、seat、role、type、round、attempt、rel（票可靠）、
 * human／agent（隊 = "1,4,7"、票 = approve／reject、任務牌 = success／fail、湖 = 座位或 good／evil、刺殺 = 座位）、
 * h／b（真人／機器人的量尺優勢，勝率）。gi 和 `keySpotStudy.ts --export-human` 的 gi 相同。
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { pinnedQuestCard } from '../src/ai/benchmark/agreement';

interface Item { gi: number; seat: number; type: string; role: string; human: number; bot: number; agree: boolean; idx?: number; botAction?: string }

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const input = argv.find((a, i) => a.endsWith('.jsonl') && !(i > 0 && ['--out', '--dataset'].includes(argv[i - 1])));
  const outPath = arg('--out');
  if (!input || !outPath) throw new Error('usage: keySpotStudy73.ts pr.jsonl --out rep.jsonl [--dataset games_cache.json]');
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8'))).games;
  const fd = fs.openSync(outPath, 'w');
  let n = 0;
  for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
    if (!line) continue;
    const it = JSON.parse(line) as Item;
    const d = games[it.gi];
    const g = d.game;
    if (g.playerCount !== 10 || it.botAction === undefined) continue;
    const base = { gi: it.gi, s: d.s, seat: it.seat, role: it.role, type: it.type, h: it.human, b: it.bot };
    let row: Record<string, unknown> | null = null;
    if (it.type === 'team' || it.type === 'vote') {
      const p = g.proposals[it.idx ?? 0];
      const human = it.type === 'team' ? p.teamSeats.join(',') : p.votes[it.seat - 1] ? 'approve' : 'reject';
      row = { ...base, round: p.round, attempt: p.attempt, rel: p.votesReliable ? 1 : 0, human, agent: it.botAction };
    } else if (it.type === 'quest') {
      const round = it.idx ?? 0;
      const human = pinnedQuestCard(g, round, it.seat);
      if (human !== null) row = { ...base, round, attempt: null, human, agent: it.botAction };
    } else if (it.type === 'lakeTarget' || it.type === 'lakeClaim') {
      const l = g.lakes[it.idx ?? 0];
      const human = it.type === 'lakeTarget' ? String(l.targetSeat) : l.claim;
      if (human !== null) row = { ...base, round: l.round, attempt: null, human, agent: it.botAction };
    } else if (it.type === 'assassinate' && g.assassinTargetSeat !== undefined) {
      row = { ...base, round: 0, attempt: null, human: String(g.assassinTargetSeat), agent: it.botAction };
    }
    if (row) { fs.writeSync(fd, JSON.stringify(row) + '\n'); n++; }
  }
  fs.closeSync(fd);
  console.error(`wrote ${n} decisions → ${outPath}`);
}

main();
