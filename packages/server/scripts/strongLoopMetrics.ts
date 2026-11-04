/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 優化迴圈每回合的 LOOP 行（強者分面版，Edward 2026-11-04；docs/ai/strong_metrics.md）＋異常票報告（真人 vs 機器人）。
 * 取代 `inflLoopMetrics.ts` 的「角色王」群組（原始角色勝率）；舊腳本保留做對照。
 *
 *   cd packages/server && nice npx tsx scripts/strongLoopMetrics.ts [--selfplay sp.json] [--json out.json] [--replay-votes votes.json]
 *   cd packages/server && npx tsx scripts/strongLoopMetrics.ts --merge a.json b.json
 *
 * 選項：
 *   --dataset PATH       每局資料集（預設 ./games_cache.json；`datasetReplay` 嚴格解析）
 *   --analysis PATH      分析快取（預設 ./analysis_cache.json；Elo）
 *   --flag NAME[=V]      AgentTuning 開關（預設 = 正式預設）
 *   --sample-seats K     每局另外抽 K 個座位（局 id 雜湊）重播，當「全體真人的決策點」的機器人對照（預設 1；0 = 不抽）
 *   --selfplay PATH      `strongSelfPlay.ts` 的輸出：加自我對打的異常票欄
 *   --no-replay          不重播（只算真人與自我對打的異常票）
 *   --shard k/n          只跑第 k 份局（局的索引 mod n）
 *   --limit N            只用前 N 局
 *   --replay-votes PATH  強者決策點上機器人的票（局 id、提議索引、座位、票；沒有名字），給 strongGap.ts
 *   --json PATH          可合併的累加器
 *
 * 群組（`src/ai/infl/strongCohort.ts`）：每一種決策比對它的分面——藍方角色（忠臣、派西）派隊／投票／湖 → 藍方任務王；
 * 梅林 → 梅林存活王；紅方角色派隊／投票／湖／任務牌 → 紅方任務王；刺殺 → 刺客刺中王。前 3／前 5 兩組，
 * 每組再分「全部局」與「高強度局」兩欄。輸出只寫分面與名次，不寫名字。
 *
 * 決策點與 `agreement.replayGame` 相同（只給那個座位當時知道的東西）：
 *   派隊（完全相同、Jaccard）、投票 R1／R2／R3+、異常票（真人投內黑／外白時機器人同票）、成功後第一個提議、
 *   湖的目標與宣告、紅方任務牌（可確定的牌）、刺殺目標。
 */
import * as fs from 'fs';
import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { describeAgentTuning, parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { replayGame, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import type { DatasetHeader, DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { Acc, fmtNum, fmtPct, table, type AccStore } from '../src/ai/infl/acc';
import { inFacetTop, type DecisionKind, type StrongCohorts } from '../src/ai/infl/strongCohort';
import { humanGamesFromDataset, isRedRole, laterBlueInclusion, sampledSeats, votesOf, type VoteRow } from '../src/ai/infl/strongData';
import { cellKey, isPivotal } from '../src/ai/infl/abnormalVotes';
import { ROLE_ZH } from '../src/ai/infl/roleKings';
import { loadStrongCohorts } from './strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);

const seatsKey = (seats: readonly number[]): string => [...seats].sort((a, b) => a - b).join(',');

const kindOf = (t: DecisionOutcome['type']): DecisionKind => t;

/** 一個座位會用到的所有分面（任一個前 5 就要重播那個座位）。 */
function seatIsStrong(c: StrongCohorts, role: Role, name: string, k: number): boolean {
  if (!name) return false;
  const kinds: DecisionKind[] = role === 'assassin' ? ['vote', 'assassinate'] : ['vote'];
  return kinds.some((kind) => inFacetTop(c, role, kind, name, k));
}

const TOPS = [5, 3] as const;
const SCOPES = ['全部', '高強度'] as const;

/** LOOP 指標：一個決策 → key 的尾巴是 `前k|範圍`。 */
function addOutcome(acc: Acc, game: ReplayGame, o: DecisionOutcome, tags: readonly string[]): void {
  const keys = (name: string): string[] => tags.flatMap((t) => [`${name}|${t}`, `${name}|${t}|${o.role}`]);
  if (o.type === 'vote') {
    const band = o.round <= 2 ? `R${o.round}` : 'R3+';
    acc.add(keys(`vote ${band}`), { agree: o.match ? 1 : 0, humanAbnormal: o.humanNonDefault ? 1 : 0, agentAbnormal: o.agentNonDefault ? 1 : 0 });
    if (o.humanNonDefault) {
      const kind = o.human === 'approve' ? '外白' : '內黑';
      acc.add([...keys(`abnormal ${kind}`), ...keys('abnormal all'), ...(o.round >= 3 ? keys('abnormal R3+') : [])], { agree: o.match ? 1 : 0 });
    }
  } else if (o.type === 'team') {
    acc.add(keys('team all'), { exact: o.match ? 1 : 0, jaccard: o.jaccard ?? null });
    if (o.round >= 2) acc.add(keys('team R2+'), { exact: o.match ? 1 : 0, jaccard: o.jaccard ?? null });
    const prev = game.quests.find((q) => q.round === o.round - 1);
    if (o.round >= 2 && o.attempt === 1 && prev && !prev.failed) {
      const reuse = seatsKey(prev.teamSeats);
      acc.add(keys('afterSuccess'), {
        exact: o.match ? 1 : 0, jaccard: o.jaccard ?? null, humanReuse: o.human === reuse ? 1 : 0, agentReuse: o.agent === reuse ? 1 : 0,
      });
    }
  } else if (o.type === 'lakeTarget') {
    acc.add(keys(`lake ${o.side}`), { agree: o.match ? 1 : 0, chance: o.defaultMatch });
  } else if (o.type === 'lakeClaim') {
    acc.add(keys(`claim ${o.side}`), { agree: o.match ? 1 : 0, humanTruth: o.defaultMatch, agentTruth: null });
  } else if (o.type === 'quest') {
    acc.add(keys('quest'), { agree: o.match ? 1 : 0, humanFail: o.human === 'fail' ? 1 : 0, agentFail: o.agent === 'fail' ? 1 : 0 });
  } else if (o.type === 'assassinate') {
    acc.add(keys('assassinate'), { agree: o.match ? 1 : 0, humanHit: o.humanHitMerlin ? 1 : 0, agentHit: o.agentHitMerlin ? 1 : 0, chance: o.defaultMatch });
  }
}

// ── 異常票報告 ─────────────────────────────────────────────

const GROUPS = (role: Role): string[] => [isRedRole(role) ? '紅方' : '藍方', ROLE_ZH[role] ?? role];
const CELLS = (round: number, attempt: number): string[] => [cellKey(round, attempt), `R${round}`, round >= 3 ? 'R3+' : 'R1-2', '全部'];

/** 一張票 → 異常票報告的指標（`bot`：機器人的票，不算之後被讀成紅）。 */
function addVote(acc: Acc, src: string, scope: string, game: ReplayGame, v: VoteRow, bot: boolean): void {
  const keys: string[] = [];
  for (const c of CELLS(v.round, v.attempt)) for (const g of GROUPS(v.role)) keys.push(`${src}|${scope}|${c}|${g}`);
  const red = isRedRole(v.role);
  const j = v.judgement;
  const abnormal = j.kind !== 'normal';
  const prop = game.proposals[v.p];
  const humanVote = prop.votes[v.seat - 1];
  const approveCount = prop.approveCount - (humanVote ? 1 : 0) + (v.approve ? 1 : 0);
  const later = !bot && red ? laterBlueInclusion(game, v.p, v.seat) : null;
  acc.add(keys, {
    abn: abnormal ? 1 : 0,
    inner: v.onTeam ? (j.kind === '內黑' ? 1 : 0) : null,
    outer: !v.onTeam ? (j.kind === '外白' ? 1 : 0) : null,
    innerRight: j.kind === '內黑' && !red ? (j.right ? 1 : 0) : null,
    outerRight: j.kind === '外白' && !red ? (j.right ? 1 : 0) : null,
    baseRedOn: !red && v.onTeam ? (v.teamHasRed ? 1 : 0) : null,
    baseCleanOff: !red && !v.onTeam ? (v.teamHasRed ? 0 : 1) : null,
    pushAlly: j.redKind === '推隊友' ? 1 : j.redKind === '貼藍' ? 0 : null,
    innerAlly: j.redKind === '反對有隊友' ? 1 : j.redKind === '落單反對' ? 0 : null,
    pivotal: abnormal ? (isPivotal(approveCount, game.playerCount, v.approve) ? 1 : 0) : null,
    laterAbn: abnormal ? later : null,
    laterNormal: !abnormal ? later : null,
  });
}

function reportAbnormal(acc: Acc, srcs: readonly [string, string][]): void {
  const cell = (k: string, m: string, pct = true): string => {
    const n = acc.count(k, m);
    return n > 0 ? `${pct ? fmtPct(acc.mean(k, m)) : fmtNum(acc.mean(k, m), 2)}/${n}` : '—';
  };
  console.log('\n=== 異常票（內黑 = 在隊上反對；外白 = 不在隊上贊成）===');
  console.log('率：異常票 / 全部票；內黑 / 隊上的票；外白 / 隊外的票。藍方準度：外白對 = 隊伍沒有紅、內黑對 = 隊伍有紅；基準 = 同一組點的隊外乾淨率／隊上有紅率。');
  for (const scope of SCOPES) {
    for (const group of ['藍方', '紅方']) {
      const rows: string[][] = [[`${group}·${scope}`, ...srcs.map(([, l]) => l)]];
      const metrics: [string, string, string][] = group === '藍方'
        ? [['異常票率', '全部', 'abn'], ['R1-2 異常票率', 'R1-2', 'abn'], ['R3+ 異常票率', 'R3+', 'abn'], ['R3+ 內黑率', 'R3+', 'inner'], ['R3+ 外白率', 'R3+', 'outer'],
          ['內黑 準度', '全部', 'innerRight'], ['（隊上有紅 基準）', '全部', 'baseRedOn'], ['外白 準度', '全部', 'outerRight'], ['（隊外乾淨 基準）', '全部', 'baseCleanOff'],
          ['R3+ 內黑 準度', 'R3+', 'innerRight'], ['R3+ 外白 準度', 'R3+', 'outerRight'], ['異常票是關鍵票', '全部', 'pivotal']]
        : [['異常票率', '全部', 'abn'], ['R1-2 異常票率', 'R1-2', 'abn'], ['R3+ 異常票率', 'R3+', 'abn'], ['R3+ 內黑率', 'R3+', 'inner'], ['R3+ 外白率', 'R3+', 'outer'],
          ['外白裡推隊友（vs 貼藍）', '全部', 'pushAlly'], ['內黑裡隊上有隊友（vs 落單）', '全部', 'innerAlly'], ['異常票是關鍵票', '全部', 'pivotal'],
          ['之後藍方隊長選他：異常票', '全部', 'laterAbn'], ['之後藍方隊長選他：正常票', '全部', 'laterNormal']];
      for (const [label, c, m] of metrics) rows.push([label, ...srcs.map(([s]) => cell(`${s}|${scope}|${c}|${group}`, m))]);
      console.log(`\n${table(rows)}`);
    }
  }
  // 回合 × 次數（陣營）：異常票率與藍方準度（真人強者 vs 機器人在同一點 vs 自我對打）
  for (const scope of ['全部'] as const) {
    for (const group of ['藍方', '紅方']) {
      console.log(`\n回合 × 次數（${group}·${scope}）：異常票率（內黑率／外白率）${group === '藍方' ? '｜準度 內黑／外白' : ''}`);
      const rows: string[][] = [['格', ...srcs.map(([, l]) => l)]];
      for (let r = 1; r <= 5; r++) for (let a = 1; a <= 4; a++) {
        const c = cellKey(r, a);
        rows.push([c, ...srcs.map(([s]) => {
          const k = `${s}|${scope}|${c}|${group}`;
          const n = acc.count(k, 'abn');
          if (n === 0) return '—';
          const base = `${fmtPct(acc.mean(k, 'abn'), 0)}(${fmtPct(acc.mean(k, 'inner'), 0)}/${fmtPct(acc.mean(k, 'outer'), 0)}) n${n}`;
          return group === '藍方' ? `${base}｜${fmtPct(acc.mean(k, 'innerRight'), 0)}/${fmtPct(acc.mean(k, 'outerRight'), 0)}` : base;
        })]);
      }
      console.log(table(rows));
    }
  }
  console.log('\n各角色（全部局）：R3+ 異常票率｜藍方 內黑準度／外白準度');
  const rr: string[][] = [['角色', ...srcs.map(([, l]) => l)]];
  for (const role of ['loyal', 'percival', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon']) {
    const g = ROLE_ZH[role];
    rr.push([g, ...srcs.map(([s]) => {
      const k = `${s}|全部|R3+|${g}`;
      const n = acc.count(k, 'abn');
      if (n === 0) return '—';
      const kk = `${s}|全部|全部|${g}`;
      return `${fmtPct(acc.mean(k, 'abn'))} n${n}${isRedRole(role as Role) ? '' : `｜${fmtPct(acc.mean(kk, 'innerRight'), 0)}/${fmtPct(acc.mean(kk, 'outerRight'), 0)}`}`;
    })]);
  }
  console.log(table(rr));
}

// ── LOOP 報表 ─────────────────────────────────────────────

function reportLoop(acc: Acc, meta: Record<string, unknown>): void {
  console.log(`\n資料：${JSON.stringify(meta).slice(0, 1500)}`);
  const cols = TOPS.flatMap((k) => SCOPES.map((s) => `前${k}|${s}`)).concat(SCOPES.map((s) => `抽樣|${s}`));
  const rows: [string, string, string][] = [
    ['派隊 完全相同（全部回合）', 'team all', 'exact'],
    ['派隊 Jaccard（全部回合）', 'team all', 'jaccard'],
    ['派隊 完全相同 R2+', 'team R2+', 'exact'],
    ['成功後第一個提議 完全相同', 'afterSuccess', 'exact'],
    ['成功後第一個提議 Jaccard', 'afterSuccess', 'jaccard'],
    ['成功後照派 機器人', 'afterSuccess', 'agentReuse'],
    ['成功後照派 真人', 'afterSuccess', 'humanReuse'],
    ['投票一致 R1', 'vote R1', 'agree'],
    ['投票一致 R2', 'vote R2', 'agree'],
    ['投票一致 R3+', 'vote R3+', 'agree'],
    ['異常票同票（全部）', 'abnormal all', 'agree'],
    ['內黑同票', 'abnormal 內黑', 'agree'],
    ['外白同票', 'abnormal 外白', 'agree'],
    ['異常票率 R3+ 機器人', 'vote R3+', 'agentAbnormal'],
    ['異常票率 R3+ 真人', 'vote R3+', 'humanAbnormal'],
    ['湖目標一致 藍方持湖', 'lake good', 'agree'],
    ['（隨機）', 'lake good', 'chance'],
    ['湖目標一致 紅方持湖', 'lake evil', 'agree'],
    ['（隨機）', 'lake evil', 'chance'],
    ['湖宣告一致 藍方', 'claim good', 'agree'],
    ['湖宣告一致 紅方', 'claim evil', 'agree'],
    ['（紅方真人照實宣告）', 'claim evil', 'humanTruth'],
    ['紅方任務牌一致', 'quest', 'agree'],
    ['任務牌出失敗 機器人', 'quest', 'agentFail'],
    ['任務牌出失敗 真人', 'quest', 'humanFail'],
    ['刺殺目標一致', 'assassinate', 'agree'],
    ['（隨機）', 'assassinate', 'chance'],
    ['刺中梅林 機器人', 'assassinate', 'agentHit'],
    ['刺中梅林 真人', 'assassinate', 'humanHit'],
  ];
  const out: string[][] = [['指標', ...cols.map((c) => c.replace('|', '·'))]];
  for (const [label, k, m] of rows) {
    out.push([label, ...cols.map((c) => {
      const n = acc.count(`${k}|${c}`, m);
      return n > 0 ? `${m === 'jaccard' ? fmtNum(acc.mean(`${k}|${c}`, m), 3) : fmtPct(acc.mean(`${k}|${c}`, m))} (${n})` : '—';
    })]);
  }
  console.log(table(out));
  console.log(`\n（前 k = 決策對到的分面前 k 名：藍方角色→藍方任務王、梅林→梅林存活王、紅方→紅方任務王、刺殺→刺客刺中王；抽樣 = 每局抽的座位＝全體真人的決策點）`);
  console.log('\n各角色（前5·全部）：投票 R3+ / 異常票同票 / 派隊完全相同 / 湖目標');
  const rr: string[][] = [['角色', '投票 R3+', '異常票同票', '派隊完全相同', '湖目標', '任務牌', '刺殺']];
  for (const role of ['loyal', 'percival', 'merlin', 'assassin', 'morgana', 'mordred', 'oberon']) {
    const g = (k: string, m: string): string => {
      const n = acc.count(`${k}|前5|全部|${role}`, m);
      return n > 0 ? `${fmtPct(acc.mean(`${k}|前5|全部|${role}`, m))}/${n}` : '—';
    };
    rr.push([ROLE_ZH[role], g('vote R3+', 'agree'), g('abnormal all', 'agree'), g('team all', 'exact'),
      g(`lake ${isRedRole(role as Role) ? 'evil' : 'good'}`, 'agree'), g('quest', 'agree'), g('assassinate', 'agree')]);
  }
  console.log(table(rr));
  const two = (k: string, m: string, top = 5): string => {
    const a = acc.mean(`${k}|前${top}|全部`, m);
    const b = acc.mean(`${k}|前${top}|高強度`, m);
    const f = (x: number | null): string => (x === null ? '—' : m === 'jaccard' ? x.toFixed(2) : (100 * x).toFixed(1));
    return `${f(a)}/${f(b)}${m === 'jaccard' ? '' : '%'}`;
  };
  console.log(`\nLOOP（強者分面前5，全部局/高強度局）：派隊 完全 ${two('team all', 'exact')}、Jaccard ${two('team all', 'jaccard')}`
    + `；投票 R1 ${two('vote R1', 'agree')}、R2 ${two('vote R2', 'agree')}、R3+ ${two('vote R3+', 'agree')}`
    + `；異常票同票 ${two('abnormal all', 'agree')}（內黑 ${two('abnormal 內黑', 'agree')}、外白 ${two('abnormal 外白', 'agree')}）`
    + `；R3+ 異常票率 機器人 ${two('vote R3+', 'agentAbnormal')} / 真人 ${two('vote R3+', 'humanAbnormal')}`
    + `；成功後第一個提議 完全 ${two('afterSuccess', 'exact')}、照派 機器人 ${two('afterSuccess', 'agentReuse')} / 真人 ${two('afterSuccess', 'humanReuse')}`
    + `；湖目標 藍 ${two('lake good', 'agree')}、紅 ${two('lake evil', 'agree')}；湖宣告 藍 ${two('claim good', 'agree')}、紅 ${two('claim evil', 'agree')}`
    + `；紅方任務牌 ${two('quest', 'agree')}；刺殺目標 ${two('assassinate', 'agree')}（刺中 機器人 ${two('assassinate', 'agentHit')} / 真人 ${two('assassinate', 'humanHit')}）`);
}

const ABN_SRCS: [string, string][] = [
  ['h·強者', '真人強者'], ['b·強者', '機器人@強者點'], ['h·抽樣', '真人抽樣'], ['b·抽樣', '機器人@抽樣點'], ['h·全體', '真人全體'], ['sp', '自我對打'],
];

function main(): void {
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    const acc = new Acc();
    const abn = new Acc();
    let meta: Record<string, unknown> = {};
    const end = argv.findIndex((a, i) => i > mergeAt && a.startsWith('--'));
    for (const f of argv.slice(mergeAt + 1, end < 0 ? undefined : end)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { acc: AccStore; abn: AccStore; meta: Record<string, unknown> };
      acc.merge(j.acc);
      abn.merge(j.abn);
      meta = { ...j.meta, shards: [...((meta.shards as string[]) ?? []), String(j.meta.shard)] };
    }
    reportLoop(acc, meta);
    reportAbnormal(abn, ABN_SRCS);
    return;
  }
  const started = Date.now();
  const { cohorts, dataset } = loadStrongCohorts({ dataset: arg('--dataset'), analysis: arg('--analysis') });
  const { games: allGames, skipped } = humanGamesFromDataset(dataset as unknown as DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] }, cohorts.threshold);
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const games = (limit !== undefined ? allGames.slice(0, limit) : allGames).filter((_, i) => i % shardN === shardK);
  const flags: Partial<AgentTuning> = {};
  argv.forEach((a, i) => { if (a === '--flag') Object.assign(flags, parseTuningFlag(argv[i + 1])); });
  const tuning = resolveAgentTuning(flags);
  const sampleK = Number(arg('--sample-seats') ?? 1);
  const replay = !has('--no-replay');
  const acc = new Acc();
  const abn = new Acc();
  const botVotes: [string, number, number, number][] = [];
  let decisions = 0;
  let replayedSeats = 0;
  games.forEach(({ game, hi }, gi) => {
    const scopes = hi ? SCOPES : ['全部'];
    // 真人全體：每一張可信的票。
    for (const v of votesOf(game)) for (const s of scopes) addVote(abn, 'h·全體', s, game, v, false);
    const strongSeats = new Set<number>();
    const tagsOf = new Map<number, (kind: DecisionKind) => string[]>();
    for (let seat = 1; seat <= game.playerCount; seat++) {
      const name = game.names[seat - 1];
      const role = game.seatRoles[seat - 1];
      if (seatIsStrong(cohorts, role, name, 5)) strongSeats.add(seat);
      tagsOf.set(seat, (kind) => TOPS.filter((k) => inFacetTop(cohorts, role, kind, name, k)).flatMap((k) => scopes.map((s) => `前${k}|${s}`)));
    }
    const sample = new Set(sampledSeats(game.id, sampleK, game.playerCount));
    // 真人的強者票與抽樣票（投票對到的分面前 5）。
    const strongVoteSeats = new Set([...strongSeats].filter((s) => inFacetTop(cohorts, game.seatRoles[s - 1], 'vote', game.names[s - 1], 5)));
    for (const v of votesOf(game, strongVoteSeats)) for (const s of scopes) addVote(abn, 'h·強者', s, game, v, false);
    for (const v of votesOf(game, sample)) for (const s of scopes) addVote(abn, 'h·抽樣', s, game, v, false);
    if (!replay) return;
    const seats = [...new Set([...strongSeats, ...sample])];
    if (seats.length === 0) return;
    replayedSeats += seats.length;
    const outcomes = replayGame(game, seats, { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    const botVote = new Map<string, boolean>();
    const propIndex = new Map(game.proposals.map((p, i) => [`${p.round}|${p.attempt}`, i]));
    for (const o of outcomes) {
      decisions++;
      const tags = [...(tagsOf.get(o.seat)?.(kindOf(o.type)) ?? []), ...(sample.has(o.seat) ? scopes.map((s) => `抽樣|${s}`) : [])];
      if (tags.length > 0) addOutcome(acc, game, o, tags);
      if (o.type === 'vote') {
        const p = propIndex.get(`${o.round}|${o.attempt}`);
        if (p === undefined) continue;
        botVote.set(`${p}|${o.seat}`, o.agent === 'approve');
        if (strongVoteSeats.has(o.seat)) botVotes.push([game.id, p, o.seat, o.agent === 'approve' ? 1 : 0]);
      }
    }
    const override = (p: number, seat: number): boolean | undefined => botVote.get(`${p}|${seat}`);
    for (const v of votesOf(game, strongVoteSeats, override)) for (const s of scopes) addVote(abn, 'b·強者', s, game, v, true);
    for (const v of votesOf(game, sample, override)) for (const s of scopes) addVote(abn, 'b·抽樣', s, game, v, true);
    if ((gi + 1) % 100 === 0) process.stderr.write(`[strongLoopMetrics ${shardK}/${shardN}] ${gi + 1}/${games.length} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  const sp = arg('--selfplay');
  let spGames = 0;
  if (sp && shardK === 0) {
    const j = JSON.parse(fs.readFileSync(sp, 'utf8')) as { games: ReplayGame[] };
    for (const g of j.games) { spGames++; for (const v of votesOf(g)) addVote(abn, 'sp', '全部', g, v, true); }
  }
  const meta = {
    games: games.length, hiGames: games.filter((g) => g.hi).length, skipped, shard: `${shardK}/${shardN}`, replayedSeats, decisions, sampleK, spGames,
    pool: cohorts.pool.length, threshold: Math.round(cohorts.threshold * 10) / 10, tuning: describeAgentTuning(tuning).slice(0, 200),
    minutes: Math.round((Date.now() - started) / 6000) / 10,
  };
  if (replay) reportLoop(acc, meta); else console.log(`資料：${JSON.stringify(meta)}`);
  reportAbnormal(abn, ABN_SRCS);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ meta, acc: acc.store, abn: abn.store }));
  const rv = arg('--replay-votes');
  if (rv) fs.writeFileSync(rv, JSON.stringify(botVotes));
}

if (require.main === module) main();
