/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 優化迴圈每回合要報的「強者一致度」幾個數字（資訊流研究，2026-11-04；docs/ai/infl_research.md 第 4 節）。
 *
 *   cd packages/server && nice -n 10 npx tsx scripts/inflLoopMetrics.ts [--shard 0/2] [--json out.json] [--flag 開關=值]
 *   cd packages/server && npx tsx scripts/inflLoopMetrics.ts --merge a.json b.json
 *
 * 選項：
 *   --cache PATH     牌譜快取（預設 ./sheets_cache.json）
 *   --top N          角色王取前 N（預設 5；同時報前 3）
 *   --min-games N    角色王門檻：該角色至少 N 場（預設 30）
 *   --no-ed          不算 ED 那一欄
 *   --exclude A,B    角色王名單排除這些名字（只在命令列給，不寫進檔案）；排除後由下一名遞補
 *   --population     另外算全體（很慢）
 *   --shard k/n      只跑第 k 份（局的索引 mod n；兩個子行程各跑一半再 --merge）
 *   --limit N        只用前 N 局
 *   --flag NAME[=V]  AgentTuning 開關（同 agreementBenchmark；預設 = 正式預設）
 *   --legacy         從全關的舊表開始
 *   --json PATH      輸出可合併的累加器
 *
 * 群組（Edward 2026-11-04）：「角色王」= 每個角色勝率最高的前 3／前 5 名（該角色 ≥ 門檻場數），只比他們玩那個角色的局；
 * 輸出只寫「角色王」與角色，不寫名字。ED 是額外的一欄（可關）。
 *
 * 決策點（重播與 agreementBenchmark 相同：`agreement.replayGame`，只給那個座位當時知道的東西）：
 *   1. 異常票：真人投內黑（在隊上反對）／外白（不在隊上贊成）時，機器人投一樣的比例；第 3 局起的異常票率（機器人 vs 真人）；
 *   2. 成功後的第一個提議（第 2 局起、上一局任務成功、第 1 次提議）：完全相同、Jaccard、照派（= 上一局任務的隊）的比例；
 *   3. 第 1、2 局的投票一致；
 *   4. 湖的目標一致（藍方持湖 / 紅方持湖）。
 * 最後印一行 `LOOP` 給回合紀錄貼。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { rowsFromSheet, parseReplayGame, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGame, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import { BENCHMARK_ROLES, cohortKey } from '../src/ai/benchmark/cohorts';
import { roleKings, ROLE_ZH, overlap } from '../src/ai/infl/roleKings';
import { Acc, fmtNum, fmtPct, table, type AccStore } from '../src/ai/infl/acc';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

function loadGames(cache: string): ReplayGame[] {
  const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as Record<string, string[][]>;
  const out: ReplayGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (r.ok) out.push(r.game);
  }
  return out;
}

const seatsKey = (seats: readonly number[]): string => [...seats].sort((a, b) => a - b).join(',');

/** 一個決策的指標（key 的尾巴是群組）。 */
function addOutcome(acc: Acc, game: ReplayGame, o: DecisionOutcome, cohorts: readonly string[]): void {
  const keys = (name: string): string[] => cohorts.flatMap((c) => [`${name}|${c}`, `${name}|${c}|${o.role}`]);
  if (o.type === 'vote') {
    const human = o.human === 'approve';
    if (o.round <= 2) acc.add(keys(`vote R${o.round}`), { agree: o.match ? 1 : 0 });
    else acc.add(keys('vote R3+'), { agree: o.match ? 1 : 0, humanAbnormal: o.humanNonDefault ? 1 : 0, agentAbnormal: o.agentNonDefault ? 1 : 0 });
    if (o.humanNonDefault) {
      const kind = human ? '外白' : '內黑';
      acc.add([...keys(`abnormal ${kind}`), ...keys('abnormal all'), ...(o.round >= 3 ? keys('abnormal R3+') : [])], { agree: o.match ? 1 : 0 });
    }
  } else if (o.type === 'team') {
    if (o.round >= 2) acc.add(keys('team R2+'), { exact: o.match ? 1 : 0, jaccard: o.jaccard ?? null });
    const prev = game.quests.find((q) => q.round === o.round - 1);
    if (o.round >= 2 && o.attempt === 1 && prev && !prev.failed) {
      const reuse = seatsKey(prev.teamSeats);
      acc.add(keys('afterSuccess'), {
        exact: o.match ? 1 : 0,
        jaccard: o.jaccard ?? null,
        humanReuse: o.human === reuse ? 1 : 0,
        agentReuse: o.agent === reuse ? 1 : 0,
      });
    }
  } else if (o.type === 'lakeTarget') {
    acc.add(keys(`lake ${o.side}`), { agree: o.match ? 1 : 0, chance: o.defaultMatch });
  }
}

function report(acc: Acc, cohorts: readonly string[], meta: Record<string, unknown>): void {
  console.log(`\n資料：${JSON.stringify(meta)}`);
  const rows: [string, string, string][] = [
    ['異常票同票（全部）', 'abnormal all', 'agree'],
    ['異常票同票 R3+', 'abnormal R3+', 'agree'],
    ['內黑同票', 'abnormal 內黑', 'agree'],
    ['外白同票', 'abnormal 外白', 'agree'],
    ['異常票率 R3+ 機器人', 'vote R3+', 'agentAbnormal'],
    ['異常票率 R3+ 真人', 'vote R3+', 'humanAbnormal'],
    ['投票一致 R1', 'vote R1', 'agree'],
    ['投票一致 R2', 'vote R2', 'agree'],
    ['投票一致 R3+', 'vote R3+', 'agree'],
    ['成功後第一個提議 完全相同', 'afterSuccess', 'exact'],
    ['成功後第一個提議 Jaccard', 'afterSuccess', 'jaccard'],
    ['成功後照派 機器人', 'afterSuccess', 'agentReuse'],
    ['成功後照派 真人', 'afterSuccess', 'humanReuse'],
    ['派隊完全相同 R2+', 'team R2+', 'exact'],
    ['湖目標一致 藍方持湖', 'lake good', 'agree'],
    ['（隨機）', 'lake good', 'chance'],
    ['湖目標一致 紅方持湖', 'lake evil', 'agree'],
    ['（隨機）', 'lake evil', 'chance'],
  ];
  const out: string[][] = [['指標', ...cohorts]];
  for (const [label, k, m] of rows) {
    out.push([label, ...cohorts.map((c) => {
      const n = acc.count(`${k}|${c}`, m);
      return n > 0 ? `${m === 'jaccard' ? fmtNum(acc.mean(`${k}|${c}`, m), 3) : fmtPct(acc.mean(`${k}|${c}`, m))} (${n})` : '—';
    })]);
  }
  console.log(table(out));
  // 各角色（角色王前 5）：異常票同票、成功後第一個提議完全相同、R1–R2 投票、湖目標
  const main = cohorts.find((c) => c.startsWith('角色王前5')) ?? cohorts[0];
  console.log(`\n各角色（${main}）：異常票同票 / 成功後第一個提議完全相同 / 投票 R1 / 投票 R2 / 湖目標`);
  const rr: string[][] = [['角色', '異常票同票', '內黑', '外白', '成功後完全相同', '照派 機器人/真人', 'R1 票', 'R2 票', '湖目標']];
  for (const role of BENCHMARK_ROLES) {
    const g = (k: string, m: string): string => {
      const n = acc.count(`${k}|${main}|${role}`, m);
      return n > 0 ? `${fmtPct(acc.mean(`${k}|${main}|${role}`, m))}/${n}` : '—';
    };
    rr.push([ROLE_ZH[role], g('abnormal all', 'agree'), g('abnormal 內黑', 'agree'), g('abnormal 外白', 'agree'), g('afterSuccess', 'exact'),
      `${g('afterSuccess', 'agentReuse')} vs ${g('afterSuccess', 'humanReuse')}`, g('vote R1', 'agree'), g('vote R2', 'agree'),
      g(`lake ${['assassin', 'morgana', 'mordred', 'oberon'].includes(role) ? 'evil' : 'good'}`, 'agree')]);
  }
  console.log(table(rr));
  const m = (k: string, met: string): string => fmtPct(acc.mean(`${k}|${main}`, met));
  console.log(`\nLOOP（${main}）：異常票同票 ${m('abnormal all', 'agree')}（內黑 ${m('abnormal 內黑', 'agree')}、外白 ${m('abnormal 外白', 'agree')}）`
    + `；R3+ 異常票率 機器人 ${m('vote R3+', 'agentAbnormal')} / 真人 ${m('vote R3+', 'humanAbnormal')}`
    + `；成功後第一個提議 完全相同 ${m('afterSuccess', 'exact')}、照派 機器人 ${m('afterSuccess', 'agentReuse')} / 真人 ${m('afterSuccess', 'humanReuse')}`
    + `；投票 R1 ${m('vote R1', 'agree')}、R2 ${m('vote R2', 'agree')}`
    + `；湖目標 藍 ${m('lake good', 'agree')}、紅 ${m('lake evil', 'agree')}`);
}

function main(): void {
  const cohortsOf = (ed: boolean, pop: boolean, top: number): string[] => [`角色王前3`, `角色王前${top}`, ...(ed ? ['ED'] : []), ...(pop ? ['全體'] : [])];
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    const acc = new Acc();
    let meta: Record<string, unknown> = {};
    const mergeEnd = argv.findIndex((a, i) => i > mergeAt && a.startsWith('--'));
    for (const f of argv.slice(mergeAt + 1, mergeEnd < 0 ? undefined : mergeEnd)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { acc: AccStore; meta: Record<string, unknown> };
      acc.merge(j.acc);
      meta = { ...j.meta, shards: [...((meta.shards as string[]) ?? []), String(j.meta.shard)] };
    }
    report(acc, (meta.cohorts as string[]) ?? cohortsOf(true, false, 5), meta);
    return;
  }
  const started = Date.now();
  const cache = path.resolve(arg('--cache') ?? path.resolve(__dirname, '..', 'sheets_cache.json'));
  const top = Number(arg('--top') ?? 5);
  const minGames = Number(arg('--min-games') ?? 30);
  const ed = !has('--no-ed');
  const population = has('--population');
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const flags: Partial<AgentTuning> = {};
  argv.forEach((a, i) => { if (a === '--flag') Object.assign(flags, parseTuningFlag(argv[i + 1])); });
  const tuning = resolveAgentTuning(flags, has('--legacy') ? { ...LEGACY_AGENT_TUNING } : undefined);
  const all = loadGames(cache);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const games = (limit !== undefined ? all.slice(0, limit) : all).filter((_, i) => i % shardN === shardK);
  // 角色王：原始勝率（priorStrength 0）取前 N；敏感度：門檻 50 場、收縮勝率（同 cohorts.ts 的 top/role）。
  const excluded = new Set((arg('--exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  // 排除的名字當成沒有名字（不進角色王排名，由下一名遞補）。
  const ranked = excluded.size === 0 ? all : all.map((g) => ({ ...g, names: g.names.map((n) => (excluded.has(n) ? '' : n)) }));
  const k3 = roleKings(ranked, 3, minGames);
  const kN = roleKings(ranked, top, minGames);
  const kN50 = roleKings(ranked, top, 50);
  const kNshrunk = roleKings(ranked, top, minGames, 'auto');
  const sensitivity = Object.fromEntries(BENCHMARK_ROLES.map((r) => [ROLE_ZH[r], {
    [`前${top}`]: kN.byRole[r].map((x) => `${x.games}場 ${(100 * x.winRate).toFixed(1)}%`),
    [`門檻50場時前${top}仍在`]: overlap(kN, kN50, r),
    [`收縮勝率時前${top}仍在`]: overlap(kN, kNshrunk, r),
  }]));
  const cohorts = cohortsOf(ed, population, top);
  const acc = new Acc();
  let decisions = 0;
  for (const game of games) {
    const seatCohorts = new Map<number, string[]>();
    for (let seat = 1; seat <= game.playerCount; seat++) {
      const name = game.names[seat - 1] ?? '';
      const role = game.seatRoles[seat - 1];
      const c: string[] = [];
      const kingName = excluded.has(name) ? '' : name;
      if (kingName && k3.rank.has(cohortKey(kingName, role))) c.push('角色王前3');
      if (kingName && kN.rank.has(cohortKey(kingName, role))) c.push(`角色王前${top}`);
      if (ed && name === 'ED') c.push('ED');
      if (population) c.push('全體');
      if (c.length > 0) seatCohorts.set(seat, c);
    }
    if (seatCohorts.size === 0) continue;
    const outcomes = replayGame(game, [...seatCohorts.keys()], { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    for (const o of outcomes) { addOutcome(acc, game, o, seatCohorts.get(o.seat) ?? []); decisions++; }
  }
  const meta = { games: games.length, excluded: excluded.size, shard: `${shardK}/${shardN}`, top, minGames, decisions, cohorts, tuning: describeAgentTuning(tuning), minutes: Math.round((Date.now() - started) / 6000) / 10, sensitivity };
  report(acc, cohorts, meta);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ meta, acc: acc.store }));
}

main();
