/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 尾家報告（Edward 2026-11-04 D3 分階段解除；docs/ai/strong_metrics.md）：第 1–4 次提議時，第 5 次（強制局）的隊長是誰、
 * 機器人的忠臣視角（現行預設的貝氏信念 `bayesOptionsOf(DEFAULT_AGENT_TUNING)`，站在一個藍方座位、當成沒有角色視野的忠臣，
 * 只有他自己湖到的結果；= 「同樣公開資訊的忠臣」）估「尾家是紅」的機率，和真相比（校準）。
 * 尾家看起來很紅（≥ --high，預設 0.7）時：真人（強者／全體）在前面的提議外白（不在隊上贊成）的比例，以及
 * 「前面的隊過了」vs「拖到強制局」的任務與終局結果。沒有「注定否決的提議」：每一個提議都可能出任務。
 *
 *   cd packages/server && nice npx tsx scripts/strongTailLeader.ts [--selfplay sp.json] [--views 2] [--json out.json]
 *
 * 選項：
 *   --views K     每次提議除了強者座位，另外取 K 個藍方座位（雜湊）算忠臣視角（預設 2；0 = 只算強者座位）
 *   --high X      「尾家很紅」門檻（預設 0.7）
 *   --limit N     只用前 N 局
 *   --selfplay P  加自我對打（機器人的投票行為與校準）
 *   --json PATH   可合併的累加器（--merge a.json b.json）
 *
 * 強者 = 那個座位的投票分面前 5（忠臣、派西 → 藍方任務王；梅林 → 梅林存活王）。輸出沒有名字。
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare } from '../src/ai/belief/BayesBelief';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import type { DatasetHeader, DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { flowOfGame, seatViewObs } from '../src/ai/infl/flow';
import { truthOf } from '../src/ai/infl/policyModel';
import { Acc, fmtNum, fmtPct, table, type AccStore } from '../src/ai/infl/acc';
import { inFacetTop } from '../src/ai/infl/strongCohort';
import { humanGamesFromDataset, isRedRole, sampledSeats } from '../src/ai/infl/strongData';
import { bucketLabel, calibrationBucket, tailLeaderSeat } from '../src/ai/infl/abnormalVotes';
import { loadStrongCohorts } from './strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const OPTS = bayesOptionsOf(DEFAULT_AGENT_TUNING);
const band = (p: number, high: number): string => (p >= high ? `≥${high}` : p >= 0.3 ? `0.3–${high}` : '<0.3');

interface Ctx { acc: Acc; high: number }

/**
 * 一局：每次提議（第 1–4 次、有可信的票）在 `viewSeats(i)` 的座位算忠臣視角的 P(尾家紅)；
 * `src` = h（真人）或 sp（自我對打）；`strong(seat)` = 那個座位是不是強者。
 */
function scanGame(ctx: Ctx, src: string, game: ReplayGame, hi: boolean, viewSeats: (i: number) => number[], strong: (seat: number) => boolean): void {
  const { acc, high } = ctx;
  const flow = flowOfGame(game);
  const truth = truthOf(game, flow);
  const scopes = hi ? ['全部', '高強度'] : ['全部'];
  // 每回合：第一次「尾家很紅」的提議、之後怎麼收場。
  const flagged = new Map<number, { attempt: number; tailRed: boolean }>();
  game.proposals.forEach((prop, i) => {
    if (prop.forced || prop.attempt > 4) return;
    const tail = tailLeaderSeat(prop.leaderSeat, prop.attempt, game.playerCount);
    const tailRed = isRedRole(game.seatRoles[tail - 1]);
    const team = new Set(prop.teamSeats);
    const teamHasRed = prop.teamSeats.some((s) => isRedRole(game.seatRoles[s - 1]));
    const ps: number[] = [];
    for (const j of viewSeats(i)) {
      if (j === tail || isRedRole(game.seatRoles[j - 1])) continue;
      const obs = seatViewObs(flow, i, `P${j}`, truth.w);
      const p = bayesRedShare(obs, OPTS).get(`P${tail}`) ?? 0.5;
      ps.push(p);
      const b = calibrationBucket(p);
      for (const s of scopes) {
        acc.add([`cal|${src}|${s}|${b}`, `cal|${src}|${s}|all`, `calA|${src}|${s}|A${prop.attempt}`], {
          p, red: tailRed ? 1 : 0, brier: (p - (tailRed ? 1 : 0)) ** 2, ll: -Math.log2(Math.max(1e-6, tailRed ? p : 1 - p)),
        });
      }
      if (!prop.votesReliable) continue;
      const on = team.has(j);
      const approve = prop.votes[j - 1];
      const who = [src === 'h' ? 'h·取樣' : 'sp', ...(src === 'h' && strong(j) ? ['h·強者'] : [])];
      const bd = band(p, high);
      for (const w of who) for (const s of scopes) {
        const keys = [`vote|${w}|${s}|${bd}`, `vote|${w}|${s}|${bd}|A${prop.attempt}`, `vote|${w}|${s}|${bd}|${tailRed ? '尾紅' : '尾藍'}`];
        acc.add(keys, {
          outer: on ? null : approve ? 1 : 0,
          inner: on ? (approve ? 0 : 1) : null,
          outerRight: !on && approve ? (teamHasRed ? 0 : 1) : null,
          offClean: on ? null : teamHasRed ? 0 : 1,
          tailRed: tailRed ? 1 : 0,
        });
      }
    }
    if (ps.length === 0) return;
    const pm = ps.reduce((a, x) => a + x, 0) / ps.length;
    if (pm >= high && !flagged.has(prop.round)) flagged.set(prop.round, { attempt: prop.attempt, tailRed });
    if (pm < 0.3 && !flagged.has(-prop.round)) flagged.set(-prop.round, { attempt: prop.attempt, tailRed });
  });
  for (const [key, f] of flagged) {
    const round = Math.abs(key);
    const roundProps = game.proposals.filter((p) => p.round === round);
    const last = roundProps[roundProps.length - 1];
    if (!last) continue;
    const forced = last.forced;
    const quest = game.quests.find((q) => q.round === round);
    if (!quest) continue;
    const kind = key > 0 ? `≥${high}` : '<0.3';
    const how = forced ? '拖到強制局' : '前面的隊過了';
    for (const s of scopes) {
      acc.add([`out|${src}|${s}|${kind}|${how}`, `out|${src}|${s}|${kind}|all`], {
        mission: quest.failed ? 0 : 1,
        blueWin: game.winner === 'good' ? 1 : 0,
        tailRed: f.tailRed ? 1 : 0,
        missionRed: last.teamSeats.some((x) => isRedRole(game.seatRoles[x - 1])) ? 1 : 0,
      });
    }
  }
}

function report(acc: Acc, high: number, meta: Record<string, unknown>): void {
  console.log(`資料：${JSON.stringify(meta)}`);
  const c = (k: string, m: string, pct = true): string => {
    const n = acc.count(k, m);
    return n > 0 ? (pct ? fmtPct(acc.mean(k, m)) : fmtNum(acc.mean(k, m), 3)) : '—';
  };
  for (const src of ['h', 'sp']) {
    for (const s of ['全部', '高強度']) {
      if (acc.count(`cal|${src}|${s}|all`) === 0) continue;
      console.log(`\n校準（${src === 'h' ? '真人局' : '自我對打'}·${s}）：忠臣視角 P(尾家紅) vs 真相`);
      const rows: string[][] = [['P 格', 'n', '平均 P', '真的是紅']];
      for (let b = 0; b < 10; b++) {
        const kk = `cal|${src}|${s}|${b / 10}`;
        const n = acc.count(kk);
        if (n > 0) rows.push([bucketLabel(b / 10), String(n), c(kk, 'p'), c(kk, 'red')]);
      }
      const all = `cal|${src}|${s}|all`;
      rows.push(['全部', String(acc.count(all)), c(all, 'p'), c(all, 'red')]);
      console.log(table(rows));
      console.log(`Brier ${c(all, 'brier', false)}、log2 損失 ${c(all, 'll', false)}（常數 = 紅方比例的基準：Brier ${fmtNum((acc.mean(all, 'red') ?? 0) * (1 - (acc.mean(all, 'red') ?? 0)), 3)}）`);
      console.log(`各次提議 平均 P / 真的是紅：${[1, 2, 3, 4].map((a) => `A${a} ${c(`calA|${src}|${s}|A${a}`, 'p')} / ${c(`calA|${src}|${s}|A${a}`, 'red')}`).join('、')}`);
    }
  }
  console.log(`\n藍方投票者（忠臣視角的 P(尾家紅) 分段）：外白率（隊外贊成）｜外白準度（那隊乾淨）／隊外乾淨基準｜內黑率`);
  const who: [string, string][] = [['h·強者', '真人強者'], ['h·取樣', '真人全體（取樣座位）'], ['sp', '機器人自我對打']];
  for (const s of ['全部', '高強度']) {
    const rows: string[][] = [[`分段·${s}`, ...who.map(([, l]) => l)]];
    for (const bd of ['<0.3', `0.3–${high}`, `≥${high}`]) {
      for (const sub of ['', '|A1', '|A2', '|A3', '|A4', '|尾紅', '|尾藍']) {
        rows.push([`${bd}${sub.replace('|', ' ')}`, ...who.map(([w]) => {
          const k = `vote|${w}|${s}|${bd}${sub}`;
          const n = acc.count(k, 'outer');
          return n > 0 ? `${c(k, 'outer')}（n${n}）｜${c(k, 'outerRight')}/${c(k, 'offClean')}｜${c(k, 'inner')}` : '—';
        })]);
      }
    }
    console.log(`\n${table(rows)}`);
  }
  console.log(`\n收場（每回合第一次「尾家很紅 ≥${high}」或「尾家很藍 <0.3」的提議之後；提議層 P = 取的藍方座位平均）：任務成功｜藍方終局贏（三藍活）｜尾家真的是紅｜出任務的隊有紅`);
  for (const src of ['h', 'sp']) for (const s of ['全部', '高強度']) {
    const rows: string[][] = [[`${src === 'h' ? '真人局' : '自我對打'}·${s}`, 'n', '任務成功', '藍方終局贏', '尾家是紅', '任務隊有紅']];
    for (const kind of [`≥${high}`, '<0.3']) for (const how of ['前面的隊過了', '拖到強制局', 'all']) {
      const k = `out|${src}|${s}|${kind}|${how}`;
      const n = acc.count(k);
      if (n > 0) rows.push([`${kind} ${how === 'all' ? '全部' : how}`, String(n), c(k, 'mission'), c(k, 'blueWin'), c(k, 'tailRed'), c(k, 'missionRed')]);
    }
    if (rows.length > 1) console.log(`\n${table(rows)}`);
  }
}

function main(): void {
  const high = Number(arg('--high') ?? 0.7);
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    const acc = new Acc();
    let meta: Record<string, unknown> = {};
    for (const f of argv.slice(mergeAt + 1).filter((x) => !x.startsWith('--'))) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { acc: AccStore; meta: Record<string, unknown> };
      acc.merge(j.acc); meta = { ...meta, ...j.meta };
    }
    report(acc, high, meta);
    return;
  }
  const started = Date.now();
  const views = Number(arg('--views') ?? 2);
  const { cohorts, dataset } = loadStrongCohorts();
  const { games: all } = humanGamesFromDataset(dataset as unknown as DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] }, cohorts.threshold);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const games = limit !== undefined ? all.slice(0, limit) : all;
  const ctx: Ctx = { acc: new Acc(), high };
  games.forEach(({ game, hi }, gi) => {
    const strong = (seat: number): boolean => inFacetTop(cohorts, game.seatRoles[seat - 1], 'vote', game.names[seat - 1], 5) && !isRedRole(game.seatRoles[seat - 1]);
    const strongSeats = Array.from({ length: game.playerCount }, (_, k) => k + 1).filter(strong);
    scanGame(ctx, 'h', game, hi, (i) => [...new Set([...strongSeats, ...sampledSeats(`${game.id}|${i}`, 10).filter((s) => !isRedRole(game.seatRoles[s - 1])).slice(0, views)])], strong);
    if ((gi + 1) % 100 === 0) process.stderr.write(`[strongTailLeader] ${gi + 1}/${games.length} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  const sp = arg('--selfplay');
  let spGames = 0;
  if (sp) {
    const j = JSON.parse(fs.readFileSync(sp, 'utf8')) as { games: ReplayGame[] };
    for (const g of j.games) {
      spGames++;
      scanGame(ctx, 'sp', g, false, (i) => sampledSeats(`${g.id}|${i}`, 10).filter((s) => !isRedRole(g.seatRoles[s - 1])).slice(0, Math.max(views, 2)), () => false);
    }
  }
  const meta = { games: games.length, spGames, views, high, minutes: Math.round((Date.now() - started) / 6000) / 10 };
  report(ctx.acc, high, meta);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ meta, acc: ctx.acc.store }));
}

main();
