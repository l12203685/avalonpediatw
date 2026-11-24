/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 72 回合（藍方第 2 局的提議）：人類 PR 量尺的逐決策紀錄（`humanPrBenchmark.ts --roles loyal,percival,merlin --dump`）裡，
 * 第 2 局、第 1 局任務失敗之後的非強制提議（藍方隊長），接回真人局的局面，輸出一行一個決策（JSONL；沒有名字、沒有局號，只有資料集裡的序號）。
 * 交給 `r2LeadStudy72.py` 依「角色 × 隊長在不在第 1 局的隊上 × 第 1 局幾張失敗 × 第幾次」拆量尺落差，或比兩份紀錄（候選 − 對照）。
 *
 *   cd packages/server && npx tsx scripts/r2LeadStudy72.ts pr.jsonl --out r2_A.jsonl [--dataset games_cache.json]
 *
 * 每列：gi、role、att（第幾次）、s（桌上強度）、onR1（隊長在第 1 局的隊上）、f1（第 1 局的失敗張數）、h／b（真人／機器人選擇的優勢，量尺單位：勝率）、
 * agree，以及真人／機器人的隊各自的：self（自己在）、reds（實際紅數）、dirty（會失敗）、t（隊上第 1 局的人，不含自己）、tRed（其中的紅）、
 * cRed（其他人裡的紅）、th（派西：拇指數）、ov（和這一局前面提議的最大重疊人數）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { parseSeatList } from '../src/ai/benchmark/humanPr';

interface Item { gi: number; seat: number; type: string; role: string; human: number; bot: number; agree: boolean; idx?: number; botAction?: string }

const BLUE = new Set(['loyal', 'percival', 'merlin']);
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const input = argv.find((a, i) => a.endsWith('.jsonl') && !(i > 0 && ['--out', '--dataset'].includes(argv[i - 1])));
  const outPath = arg('--out');
  if (!input || !outPath) throw new Error('usage: r2LeadStudy72.ts pr.jsonl --out r2.jsonl');
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8'))).games;
  const lines: string[] = [];
  for (const line of fs.readFileSync(input, 'utf8').split('\n')) {
    if (!line) continue;
    const it = JSON.parse(line) as Item;
    if (it.type !== 'team' || !BLUE.has(it.role)) continue;
    const d = games[it.gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    const p = g.proposals[it.idx ?? 0];
    const q1 = g.quests.find((q) => q.round === 1);
    if (p.round !== 2 || p.forced || !q1 || !q1.failed) continue;
    const seat = p.leaderSeat;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1] as never);
    const thumb = (s: number): boolean => it.role === 'percival' && (g.seatRoles[s - 1] === 'merlin' || g.seatRoles[s - 1] === 'morgana');
    const prev = g.proposals.filter((x) => x.round === 2 && x.attempt < p.attempt);
    const r1 = new Set(q1.teamSeats);
    const desc = (team: readonly number[]): Record<string, number> => {
      const t = team.filter((s) => s !== seat && r1.has(s));
      const c = team.filter((s) => s !== seat && !r1.has(s));
      const reds = team.filter(red).length;
      return {
        self: team.includes(seat) ? 1 : 0, reds, dirty: reds >= 1 ? 1 : 0, t: t.length, tRed: t.filter(red).length, cRed: c.filter(red).length,
        th: team.filter(thumb).length, ov: prev.length === 0 ? 0 : Math.max(...prev.map((x) => team.filter((s) => x.teamSeats.includes(s)).length)),
      };
    };
    const bot = parseSeatList(it.botAction ?? '');
    lines.push(JSON.stringify({
      gi: it.gi, role: it.role, att: p.attempt, s: d.s, onR1: r1.has(seat) ? 1 : 0, f1: q1.failCount, h: it.human, b: it.bot, agree: it.agree ? 1 : 0,
      ht: desc(p.teamSeats), bt: bot.length === p.teamSeats.length ? desc(bot) : null,
    }));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
