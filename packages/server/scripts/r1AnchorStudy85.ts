/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 85 回合（藍方提議・第 1 局隊伍的錨定）：人類 PR 量尺的逐決策紀錄（`humanPrBenchmark.ts --roles loyal,percival,merlin --dump`）裡，
 * 第 1 局任務成功之後的藍方非強制提議，接回真人局的局面，輸出一行一個決策（JSONL；沒有名字、沒有局號，只有資料集裡的序號）。
 * 交給 `r1AnchorStudy85.py --pr` 依「格 × 角色 × 隊長在不在第 1 局的隊上」比真人與機器人「整個第 1 局的隊都在」的比例與量尺落差，或比兩份紀錄（候選 − 對照）。
 *
 *   cd packages/server && npx tsx scripts/r1AnchorStudy85.ts pr.jsonl --out a_X.jsonl [--dataset games_cache.json]
 *
 * 格（spot）：A2 = 第 2 局；A3o／A3x = 第 3 局、第 2 局成功／失敗（第 2 局的隊沒有包含整個第 1 局的隊）；
 * B = 前一局的任務隊包含整個第 1 局的隊而且失敗（第 3–5 局）。
 * 每列：gi、role、spot、rd、att、s、on（隊長在第 1 局的隊上；2 = 隊長是失敗那一隊加進來的人）、h／b（真人／機器人選擇的優勢）、agree，
 * 真人／機器人的隊各自的：sup（整個第 1 局的隊都在）、k（第 1 局的人數，不含自己）、reds（實際紅數）、dirty（會失敗）、r1red（第 1 局的隊上真的有紅）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
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
  if (!input || !outPath) throw new Error('usage: r1AnchorStudy85.ts pr.jsonl --out a.jsonl');
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
    if (p.forced || p.round < 2) continue;
    // 站長 11/26「非尾派忠臣/派西維爾也應該要找前一局開紅的」：前一局任務失敗之後的非尾派提議（忠臣／派西），隊上有幾個失敗那一隊的人（自己以外）。
    const prevF = g.quests.find((q) => q.round === p.round - 1);
    if (prevF && prevF.failed && (it.role === 'loyal' || it.role === 'percival')) {
      const seatF = p.leaderSeat;
      const F = prevF.teamSeats.filter((x) => x !== seatF);
      const redF = (x: number): boolean => EVIL_ROLES.has(g.seatRoles[x - 1] as never);
      const needF = (AVALON_CONFIG[10]?.questFailsRequired ?? [1, 1, 1, 2, 1])[p.round - 1] ?? 1;
      const descF = (team: readonly number[]): Record<string, number> => {
        const o = team.filter((x) => F.includes(x)).length;
        const reds = team.filter(redF).length;
        return { sup: o === 0 ? 0 : o === F.length ? 2 : 1, k: o, reds, dirty: reds >= needF ? 1 : 0 };
      };
      const botF = parseSeatList(it.botAction ?? '');
      lines.push(JSON.stringify({
        gi: it.gi, role: it.role, spot: 'F', rd: p.round, att: p.attempt, s: d.s, on: prevF.teamSeats.includes(seatF) ? 1 : 0, r1red: 0,
        h: it.human, b: it.bot, agree: it.agree ? 1 : 0, ht: descF(p.teamSeats), bt: botF.length === p.teamSeats.length ? descF(botF) : null,
      }));
    }
    const q1 = g.quests.find((q) => q.round === 1);
    if (!q1 || q1.failed) continue;
    const r1 = new Set(q1.teamSeats);
    const prevQ = g.quests.find((q) => q.round === p.round - 1);
    if (!prevQ) continue;
    const need = (AVALON_CONFIG[10]?.questFailsRequired ?? [1, 1, 1, 2, 1])[prevQ.round - 1] ?? 1;
    let spot = '';
    let extra = new Set<number>();
    if (prevQ.round >= 2 && prevQ.failed && [...r1].every((s) => prevQ.teamSeats.includes(s))) {
      spot = 'B';
      extra = new Set(prevQ.teamSeats.filter((s) => !r1.has(s)));
    } else if (p.round === 2) spot = 'A2';
    else if (p.round === 3) spot = prevQ.failed ? 'A3x' : 'A3o';
    else continue;
    void need;
    const seat = p.leaderSeat;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1] as never);
    const r1red = [...r1].some(red) ? 1 : 0;
    const teamNeed = (AVALON_CONFIG[10]?.questFailsRequired ?? [1, 1, 1, 2, 1])[p.round - 1] ?? 1;
    const desc = (team: readonly number[]): Record<string, number> => {
      const reds = team.filter(red).length;
      return {
        sup: [...r1].every((s) => team.includes(s)) ? 1 : 0, k: team.filter((s) => s !== seat && r1.has(s)).length,
        reds, dirty: reds >= teamNeed ? 1 : 0,
      };
    };
    const bot = parseSeatList(it.botAction ?? '');
    lines.push(JSON.stringify({
      gi: it.gi, role: it.role, spot, rd: p.round, att: p.attempt, s: d.s, on: r1.has(seat) ? 1 : extra.has(seat) ? 2 : 0, r1red,
      h: it.human, b: it.bot, agree: it.agree ? 1 : 0, ht: desc(p.teamSeats), bt: bot.length === p.teamSeats.length ? desc(bot) : null,
    }));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
