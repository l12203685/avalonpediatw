/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 51 回合 B（站長 11/18「我覺得你的全忠臣不夠強是因為 忠臣本身的思考能力不夠」）：機器人忠臣和真人忠臣在同一批決策點的差在哪裡。
 *
 * 輸入：`humanPrBenchmark.ts --dump` 的逐決策評分（JSONL：gi、seat、type、role、bucket（座位 PR 十分位）、human／bot 優勢、agree、idx、botAction）。
 * 每個忠臣決策分局面（派隊：第幾局 × 一般／強制局；投票：第幾局 × 在不在隊上 × 一般／尾家前一次；湖的目標），報
 *   n、不一致率、機器人 − 人類的平均優勢（pp）、每個忠臣座位局的合計（pp；= 頻率 × 平均差，排序用）、用真相打分數的對照（派的隊乾淨、投票對、湖驗到紅），
 * 分全部真人與強者（PR ≥ 80；`--strong-bucket`）。沒有玩家名。
 *
 *   cd packages/server && npx tsx scripts/loyalGapStudy.ts --dump scored.jsonl [--role loyal] [--strong-bucket 8] [--md out.md]
 */
import * as fs from 'fs';
import * as path from 'path';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { lakeTargetKeys, parseSeatList, teamKeys, voteKeys } from '../src/ai/benchmark/humanPr';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

interface Row { gi: number; seat: number; type: string; role: string; bucket: number | null; human: number; bot: number; agree: boolean; idx?: number; botAction?: string }
interface Acc { n: number; dis: number; dH: number; dB: number; tH: number; tB: number; tn: number; actH: Map<string, number>; actB: Map<string, number> }
const newAcc = (): Acc => ({ n: 0, dis: 0, dH: 0, dB: 0, tH: 0, tB: 0, tn: 0, actH: new Map(), actB: new Map() });
const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };

function main(): void {
  const dump = arg('--dump');
  if (!dump) throw new Error('--dump PATH');
  const role = arg('--role') ?? 'loyal';
  const sb = Number(arg('--strong-bucket') ?? 8);
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  const games = replayGamesFromDataset(dataset).games.map((d) => d.game);
  const red = (g: (typeof games)[number], s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
  const accs = { all: new Map<string, Acc>(), strong: new Map<string, Acc>() };
  const seatGames = { all: new Set<string>(), strong: new Set<string>() };
  for (const line of fs.readFileSync(dump, 'utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line) as Row;
    if (r.role !== role || r.idx === undefined) continue;
    const g = games[r.gi];
    let cell: string | null = null;
    let truthH: number | null = null;
    let truthB: number | null = null;
    let actH = '';
    let actB = '';
    if (r.type === 'team') {
      const p = g.proposals[r.idx];
      cell = `派隊 第${p.round}局 ${p.forced ? '強制局（第 5 次）' : p.attempt === 1 ? '第 1 次' : '第 2–4 次'}`;
      const bot = (r.botAction ?? '').split(',').map(Number);
      truthH = p.teamSeats.some((s) => red(g, s)) ? 0 : 1;
      truthB = bot.some((s) => red(g, s)) ? 0 : 1;
      actH = teamKeys(g, r.idx, p.teamSeats).levels[0][1];
      if (bot.length === p.teamSeats.length) actB = teamKeys(g, r.idx, parseSeatList(r.botAction ?? '')).levels[0][1];
    } else if (r.type === 'vote') {
      const p = g.proposals[r.idx];
      const on = p.teamSeats.includes(r.seat);
      cell = `投票 第${p.round <= 2 ? '1–2' : p.round}局 ${on ? '在隊上' : '不在隊上'} ${p.attempt === 4 ? '第 4 次（尾家前）' : '第 1–3 次'}`;
      const clean = !p.teamSeats.some((s) => red(g, s));
      const human = p.votes[r.seat - 1];
      const bot = r.botAction === 'approve';
      truthH = human === clean ? 1 : 0;
      truthB = bot === clean ? 1 : 0;
      const lv = voteKeys(g, r.idx, r.seat, human).levels[0][0].split('|');
      actH = `${lv[5]}${lv[6]}:${human ? 'A' : 'R'}`;
      actB = `${lv[5]}${lv[6]}:${bot ? 'A' : 'R'}`;
    } else if (r.type === 'lakeTarget') {
      const l = g.lakes[r.idx];
      cell = `湖的目標 第${l.round}局後`;
      truthH = red(g, l.targetSeat) ? 1 : 0;
      const b = Number(r.botAction);
      truthB = Number.isFinite(b) && b >= 1 ? (red(g, b) ? 1 : 0) : null;
      actH = lakeTargetKeys(g, r.idx, l.targetSeat).levels[0][1];
      if (Number.isFinite(b) && b >= 1) actB = lakeTargetKeys(g, r.idx, b).levels[0][1];
    } else continue;
    for (const [k, on] of [['all', true], ['strong', r.bucket !== null && r.bucket >= sb * 10]] as const) {
      if (!on) continue;
      seatGames[k].add(`${r.gi}|${r.seat}`);
      const a = accs[k].get(cell) ?? newAcc();
      a.n++;
      if (!r.agree) a.dis++;
      a.dH += r.human;
      a.dB += r.bot;
      if (truthH !== null && truthB !== null) { a.tH += truthH; a.tB += truthB; a.tn++; }
      if (actH && actB) { bump(a.actH, actH); bump(a.actB, actB); }
      accs[k].set(cell, a);
    }
  }
  const out: string[] = [];
  for (const k of ['all', 'strong'] as const) {
    const sg = seatGames[k].size;
    out.push(`\n### ${role}：${k === 'all' ? '全部真人' : `強者（PR ≥ ${sb * 10}）`}（${sg.toLocaleString()} 個座位局）\n`);
    out.push('| 決策點 | n | 不一致 | 機器人 − 人類（pp／決策） | 每座位局合計（pp） | 真相對照：人類 → 機器人 |');
    out.push('|---|---|---|---|---|---|');
    const rows = [...accs[k].entries()].map(([c, a]) => ({ c, a, per: (100 * (a.dB - a.dH)) / sg }));
    rows.sort((x, y) => x.per - y.per);
    for (const { c, a, per } of rows) {
      const truth = a.tn ? `${((100 * a.tH) / a.tn).toFixed(1)}% → ${((100 * a.tB) / a.tn).toFixed(1)}%` : '—';
      out.push(`| ${c} | ${a.n.toLocaleString()} | ${((100 * a.dis) / a.n).toFixed(1)}% | ${((100 * (a.dB - a.dH)) / a.n).toFixed(2)} | **${per.toFixed(3)}** | ${truth} |`);
    }
    // 不一致最大的動作（同一批決策點，人類 vs 機器人的動作分布；派隊 = 自己在不在隊上 s、隊上實際紅數 r、出過失敗任務的人數 t、照派 u；
    // 投票 = 隊上實際紅數、隊上有沒有出過失敗任務的人：贊成 A／反對 R；湖 = 目標陣營、出過失敗任務 t）
    out.push('\n| 決策點（每座位局合計最負的 6 個） | 動作：人類 → 機器人（占比） |');
    out.push('|---|---|');
    for (const { c, a } of rows.slice(0, 6)) {
      const tot = (m: Map<string, number>): number => [...m.values()].reduce((x, y) => x + y, 0);
      const nh = tot(a.actH);
      const nb = tot(a.actB);
      const keys = new Set([...a.actH.keys(), ...a.actB.keys()]);
      const diffs = [...keys].map((k) => ({ k, h: (a.actH.get(k) ?? 0) / Math.max(nh, 1), b: (a.actB.get(k) ?? 0) / Math.max(nb, 1) }))
        .sort((x, y) => Math.abs(y.b - y.h) - Math.abs(x.b - x.h)).slice(0, 4);
      out.push(`| ${c} | ${diffs.map((d) => `${d.k} ${(100 * d.h).toFixed(0)}% → ${(100 * d.b).toFixed(0)}%`).join('；')} |`);
    }
  }
  const text = out.join('\n') + '\n';
  console.log(text);
  const md = arg('--md');
  if (md) fs.writeFileSync(md, text);
}

main();
