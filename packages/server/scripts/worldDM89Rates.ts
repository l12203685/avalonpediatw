/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 89 回合（路線圖 Phase B，`(W, D, M)` 聯合世界）：真人局的基準比例，時間切分（照日期，前 2/3 = 擬合、後 1/3 = 驗證；沒有日期的局放擬合那一半）。
 *
 *   cd packages/server && npx tsx scripts/worldDM89Rates.ts [--dataset games_cache.json] [--json out.json]
 *
 * 只輸出合計數字（沒有玩家名）。V = 梅林看得到的紅 = 紅方 W 拿掉莫德雷德 D。
 *  1. 梅林當隊長的提議「避開 V」的比例（第 1、2 局非強制／第 3 局起非強制／強制局），對照忠臣、派西當隊長時同一個 V 的避開比例；
 *     混合權重 a = (梅林 − 一般藍方) / (1 − 一般藍方)：「梅林 = a × 只派避開 V 的隊 + (1 − a) × 一般藍方」。
 *  2. 梅林持湖查 V 裡的人的比例，對照忠臣、派西持湖；紅方持湖宣告分第 1 湖／之後的湖。
 *  3. 梅林第 3 局起對有 V 的隊投贊成的比例（不在隊上／在隊上），對照一般藍方對有紅的隊。
 *  4. 任務一張失敗時隊上有兩個紅的比例（超幾何先驗的對照）；忠臣當隊長的提議有莫德雷德的比例。
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple, type DatasetReplayGame } from '../src/ai/benchmark/datasetReplay';
import { campOf } from '../src/ai/benchmark/sheetsReplay';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** Time split: games sorted by date (missing dates first); the last third is the test half. */
export function timeSplit(games: readonly DatasetReplayGame[]): { train: DatasetReplayGame[]; test: DatasetReplayGame[]; cut: string } {
  const ten = games.filter((g) => g.game.playerCount === 10);
  const sorted = [...ten].sort((a, b) => (a.date || '0000').localeCompare(b.date || '0000'));
  const k = Math.floor((2 * sorted.length) / 3);
  return { train: sorted.slice(0, k), test: sorted.slice(k), cut: sorted[k]?.date ?? '' };
}

type Cnt = [number, number];
const add = (m: Record<string, Cnt>, k: string, hit: boolean): void => { const c = (m[k] ??= [0, 0]); if (hit) c[0]++; c[1]++; };

export function rates(games: readonly DatasetReplayGame[]): Record<string, Cnt> {
  const m: Record<string, Cnt> = {};
  for (const { game } of games) {
    const role = (s: number): string => game.seatRoles[s - 1];
    const red = (s: number): boolean => campOf(game.seatRoles[s - 1] as never) === 'evil';
    const seats = Array.from({ length: game.playerCount }, (_, i) => i + 1);
    const V = new Set(seats.filter((s) => red(s) && role(s) !== 'mordred'));
    const D = seats.find((s) => role(s) === 'mordred');
    if (V.size !== 3 || D === undefined) continue;
    for (const p of game.proposals) {
      const r = role(p.leaderSeat);
      const seg = p.forced ? 'forced' : p.round <= 2 ? 'r12' : 'r3';
      const avoid = p.teamSeats.every((s) => !V.has(s));
      if (r === 'merlin') add(m, `prop|merlin|${seg}`, avoid);
      if (r === 'loyal' || r === 'percival') {
        add(m, `prop|blue|${seg}`, avoid);
        add(m, `prop|${r}|${seg}`, avoid);
        add(m, `mordred|${r}|${seg}`, p.teamSeats.includes(D));
      }
      // Votes: Merlin R3+ non-forced on a team holding a seen red vs the generic blue on a team holding any red.
      if (!p.forced && p.round >= 3 && p.votesReliable) {
        const hasV = p.teamSeats.some((s) => V.has(s));
        const hasRed = p.teamSeats.some((s) => red(s));
        for (const s of seats) {
          if (s === p.leaderSeat) continue;
          const on = p.teamSeats.includes(s) ? 'on' : 'off';
          if (role(s) === 'merlin' && hasV) add(m, `vote|merlin|V|${on}`, p.votes[s - 1]);
          if (role(s) === 'merlin' && !hasV) add(m, `vote|merlin|noV|${on}`, p.votes[s - 1]);
          if ((role(s) === 'loyal' || role(s) === 'percival') && hasRed) add(m, `vote|blue|red|${on}`, p.votes[s - 1]);
          if ((role(s) === 'loyal' || role(s) === 'percival') && !hasRed) add(m, `vote|blue|clean|${on}`, p.votes[s - 1]);
        }
      }
    }
    game.lakes.forEach((l, i) => {
      const r = role(l.holderSeat);
      const nth = i === 0 ? 'first' : 'later';
      if (r === 'merlin') { add(m, `lakeT|merlin|V`, V.has(l.targetSeat)); add(m, `lakeT|merlin|D`, l.targetSeat === D); }
      if (r === 'loyal' || r === 'percival') { add(m, `lakeT|blue|V`, V.has(l.targetSeat)); add(m, `lakeT|blue|D`, l.targetSeat === D); }
      if (red(l.holderSeat) && l.claim !== null) add(m, `lakeClaim|red|${nth}|${red(l.targetSeat) ? 'tRed' : 'tBlue'}`, l.claim === 'evil');
      if (!red(l.holderSeat) && l.claim !== null) add(m, `lakeClaim|blue|${nth}|${red(l.targetSeat) ? 'tRed' : 'tBlue'}`, l.claim === 'evil');
    });
    for (const q of game.quests) {
      if (q.round > 2 || q.failCount !== 1) continue;
      const reds = q.teamSeats.filter((s) => red(s)).length;
      add(m, `oneFail|R${q.round}|2red`, reds >= 2);
    }
  }
  return m;
}

const pc = (c: Cnt | undefined): string => (c && c[1] ? `${((100 * c[0]) / c[1]).toFixed(1)}%（${c[1]}）` : '—');
export const mixWeight = (merlin: Cnt | undefined, blue: Cnt | undefined): number => {
  if (!merlin || !blue || !merlin[1] || !blue[1]) return NaN;
  const rm = merlin[0] / merlin[1];
  const rg = blue[0] / blue[1];
  return rg < 1 ? Math.max(0, (rm - rg) / (1 - rg)) : NaN;
};

function main(): void {
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  const { train, test, cut } = timeSplit(replayGamesFromDataset(dataset).games);
  const halves: [string, DatasetReplayGame[]][] = [['擬合（前 2/3）', train], ['驗證（後 1/3）', test]];
  const out: Record<string, unknown> = { cut, train: train.length, test: test.length };
  console.log(`時間切分：${train.length} 局擬合、${test.length} 局驗證（${cut} 起）`);
  for (const [name, gs] of halves) {
    const m = rates(gs);
    out[name] = m;
    console.log(`\n## ${name}`);
    for (const seg of ['r12', 'r3', 'forced']) {
      console.log(`提議避開 V ${seg}：梅林 ${pc(m[`prop|merlin|${seg}`])}、一般藍方 ${pc(m[`prop|blue|${seg}`])}（忠臣 ${pc(m[`prop|loyal|${seg}`])}、派西 ${pc(m[`prop|percival|${seg}`])}）→ a = ${mixWeight(m[`prop|merlin|${seg}`], m[`prop|blue|${seg}`]).toFixed(3)}；`
        + `忠臣的隊有莫德雷德 ${pc(m[`mordred|loyal|${seg}`])}、派西 ${pc(m[`mordred|percival|${seg}`])}`);
    }
    console.log(`湖：梅林查 V ${pc(m['lakeT|merlin|V'])}、查 D ${pc(m['lakeT|merlin|D'])}；一般藍方查 V ${pc(m['lakeT|blue|V'])}、查 D ${pc(m['lakeT|blue|D'])}`);
    for (const nth of ['first', 'later']) console.log(`紅方持湖說壞（${nth}）：目標藍 ${pc(m[`lakeClaim|red|${nth}|tBlue`])}、目標紅 ${pc(m[`lakeClaim|red|${nth}|tRed`])}；藍方持湖說壞：目標藍 ${pc(m[`lakeClaim|blue|${nth}|tBlue`])}、目標紅 ${pc(m[`lakeClaim|blue|${nth}|tRed`])}`);
    console.log(`第 3 局起投贊成：梅林 有 V 不在隊上 ${pc(m['vote|merlin|V|off'])}、在隊上 ${pc(m['vote|merlin|V|on'])}；沒有 V ${pc(m['vote|merlin|noV|off'])}／${pc(m['vote|merlin|noV|on'])}；一般藍方 有紅 ${pc(m['vote|blue|red|off'])}／${pc(m['vote|blue|red|on'])}、乾淨 ${pc(m['vote|blue|clean|off'])}／${pc(m['vote|blue|clean|on'])}`);
    console.log(`一張失敗隊上兩個紅以上：R1 ${pc(m['oneFail|R1|2red'])}、R2 ${pc(m['oneFail|R2|2red'])}`);
  }
  const j = arg('--json');
  if (j) fs.writeFileSync(j, JSON.stringify(out, null, 1));
}

if (require.main === module) main();
