/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 89 回合（路線圖 Phase B）：`(W, D, M)` 聯合層對忠臣／派西信念的兩個離線量測（真人局、時間切分的驗證那一半；只輸出合計數字）。
 *
 *   cd packages/server && npx tsx scripts/worldDM89Study.ts [--split time-test|time-train|all] [--base-flag k=v ...] [--cand 名字=k=v,k=v ...] [--json out.json]
 *
 * 1. 莫德雷德避雷：每一次真人忠臣／派西當隊長（非強制）的決策點，信念裡「含自己、人數對、沒有紅的機率最高」的那一隊有沒有莫德雷德、是不是全好；
 *    對照真人那一次實際派的隊（同一批決策點）。分第 1 局／第 2 局／第 3 局起。
 * 2. 超幾何校準：第 1、2 局任務一張失敗之後下一局第一次投票，信念說「那一隊有兩個紅以上」的平均機率 vs 真的比例。
 */
import * as fs from 'fs';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesTeamClean, bayesTeamRedsBelow, type BayesOptions } from '../src/ai/belief/BayesBelief';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { loadHuman } from './beliefCalibrationCurve';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function combos<T>(xs: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < xs.length; i++) { acc.push(xs[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

interface Acc { n: number; mordred: number; allGood: number }
const newAcc = (): Acc => ({ n: 0, mordred: 0, allGood: 0 });

function main(): void {
  const base: AgentTuning = { ...DEFAULT_AGENT_TUNING };
  argv.forEach((a, i) => { if (a === '--base-flag') Object.assign(base, parseTuningFlag(argv[i + 1])); });
  const variants: [string, BayesOptions][] = [['預設', bayesOptionsOf(base)]];
  argv.forEach((a, i) => {
    if (a !== '--cand') return;
    const s = argv[i + 1];
    const at = s.indexOf('=');
    const t: AgentTuning = { ...base };
    for (const f of s.slice(at + 1).split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
    variants.push([s.slice(0, at), bayesOptionsOf(t)]);
  });
  const games = loadHuman();
  const split = arg('--split') ?? 'time-test';
  const byDate = games.map((g, gi) => ({ gi, d: g.date || '0000' })).sort((a, b) => a.d.localeCompare(b.d));
  const late = new Set(byDate.slice(Math.floor((2 * byDate.length) / 3)).map((x) => x.gi));
  const keep = (gi: number): boolean => (split === 'time-test' ? late.has(gi) : split === 'time-train' ? !late.has(gi) : true);
  const pick: Record<string, Acc> = {};
  const hyper: Record<string, { n: number; sumP: number; hit: number }> = {};
  let nGames = 0;
  const t0 = Date.now();
  games.forEach((g, gi) => {
    if (!keep(gi)) return;
    nGames++;
    const game: ReplayGame = g.game;
    const red = (s: number): boolean => campOf(game.seatRoles[s - 1]) === 'evil';
    const mordred = game.seatRoles.findIndex((r) => r === 'mordred') + 1;
    // 1. Mordred avoidance at the blue leaders' non-forced picks.
    game.proposals.forEach((p, i) => {
      if (p.forced) return;
      const role = game.seatRoles[p.leaderSeat - 1];
      if (role !== 'loyal' && role !== 'percival') return;
      const seg = p.round === 1 ? 'R1' : p.round === 2 ? 'R2' : 'R3+';
      const obs = hideLobbyOrder(buildReplayObservation(game, p.leaderSeat, { kind: 'team_select', proposal: i }));
      const me = seatId(p.leaderSeat);
      const others = obs.allPlayerIds.filter((id) => id !== me);
      const teams = combos(others, p.teamSeats.length - 1).map((t) => [me, ...t]);
      const human = (pick[`真人|${role}|${seg}`] ??= newAcc());
      human.n++;
      if (p.teamSeats.includes(mordred)) human.mordred++;
      if (p.teamSeats.every((s) => !red(s))) human.allGood++;
      for (const [name, o] of variants) {
        let best: string[] = teams[0];
        let bv = -1;
        for (const t of teams) { const v = bayesTeamClean(obs, t, o) ?? 0; if (v > bv + 1e-12) { bv = v; best = t; } }
        const seats = best.map((id) => obs.allPlayerIds.indexOf(id) + 1);
        const a = (pick[`${name}|${role}|${seg}`] ??= newAcc());
        a.n++;
        if (seats.includes(mordred)) a.mordred++;
        if (seats.every((s) => !red(s))) a.allGood++;
      }
    });
    // 2. Hypergeometric calibration: after an R1/R2 one-fail mission, at the next round's first vote.
    for (const q of game.quests) {
      if (q.round > 2 || q.failCount !== 1) continue;
      const pi = game.proposals.findIndex((p) => p.round === q.round + 1 && !p.forced);
      if (pi < 0) continue;
      const truth = q.teamSeats.filter((s) => red(s)).length >= 2;
      for (let seat = 1; seat <= game.playerCount; seat++) {
        const role = game.seatRoles[seat - 1];
        if (role !== 'loyal' && role !== 'percival') continue;
        if (q.teamSeats.includes(seat)) continue;
        const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: pi }));
        const team = q.teamSeats.map(seatId);
        for (const [name, o] of variants) {
          const below = bayesTeamRedsBelow(obs, team, 2, o);
          if (below === null) continue;
          const h = (hyper[`${name}|R${q.round}`] ??= { n: 0, sumP: 0, hit: 0 });
          h.n++;
          h.sumP += 1 - below;
          if (truth) h.hit++;
        }
      }
    }
    if (nGames % 100 === 0) process.stderr.write(`[dm89] ${nGames} games ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  });
  const pc = (x: number, n: number): string => (n ? `${((100 * x) / n).toFixed(1)}` : '—');
  console.log(`# 第 89 回合：莫德雷德避雷與超幾何校準（${split}，${nGames} 局）\n`);
  console.log('| 讀法 | 角色 | 局 | 決策點 | 最乾淨的隊有莫德雷德 % | 最乾淨的隊全好 % |');
  console.log('|---|---|---|---|---|---|');
  for (const name of ['真人', ...variants.map((v) => v[0])]) {
    for (const role of ['loyal', 'percival']) {
      for (const seg of ['R1', 'R2', 'R3+']) {
        const a = pick[`${name}|${role}|${seg}`];
        if (a) console.log(`| ${name} | ${role === 'loyal' ? '忠臣' : '派西'} | ${seg} | ${a.n} | ${pc(a.mordred, a.n)} | ${pc(a.allGood, a.n)} |`);
      }
    }
  }
  console.log('\n| 讀法 | 任務 | 點數 | 信念說兩紅以上 % | 真的 % |');
  console.log('|---|---|---|---|---|');
  for (const [name] of variants) for (const r of ['R1', 'R2']) {
    const h = hyper[`${name}|${r}`];
    if (h) console.log(`| ${name} | ${r} 一張失敗 | ${h.n} | ${pc(h.sumP, h.n)} | ${pc(h.hit, h.n)} |`);
  }
  const j = arg('--json');
  if (j) fs.writeFileSync(j, JSON.stringify({ split, games: nGames, pick, hyper }, null, 1));
}

main();
