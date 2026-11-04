/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 貝氏信念的概似表（優化迴圈第 1 回合・第三階段信念引擎，2026-10-28）：從真人牌譜（1970 局可重播 10 人局）統計
 * 「在某種身分分配下，一個人做出這個動作」的機率，只存彙總次數（不含名字、不含單局紀錄）。
 *
 *   npx tsx scripts/fitBeliefLikelihoods.ts [--out src/ai/belief/likelihoods.json]
 *   USE_FORWARD_REASONING=true npx tsx scripts/fitBeliefLikelihoods.ts --bots 600 [--out src/ai/belief/likelihoods_bot.json]
 *     [--flag NAME[=V] ...] [--seed-prefix fitbot]
 *   npx tsx scripts/fitBeliefLikelihoods.ts --merge a.json b.json [...] --out merged.json
 *   npx tsx scripts/fitBeliefLikelihoods.ts --strong [--strong-k 200] [--out src/ai/belief/likelihoods_strong.json]
 *
 * `--flag`（第 17 回合）：自我對打的十個座位都在正式預設上再套這些開關（例如用上一回合的紅方擬合）；`--seed-prefix` 換種子。
 * `--merge`（第 17 回合）：把幾張用同一個腳本擬合的表的次數加起來（例如幾個最近的紅方策略各擬合一張再合併，
 * 讓藍方的讀法不只貼著單一個紅方版本）。
 *
 * `--bots N`（優化迴圈，Edward 2026-10-30：「舊的藍方沒有從派票或投票直接分辨出誰是藍誰是紅，所以紅方根本不需要隱藏」）：
 * 改從全機器人自我對打 N 局（正式預設）統計同一組表，給 `AgentTuning.beliefBotTables` 用——藍方照「目前的對手實際怎麼做」
 * 讀派隊、投票與任務牌；紅方之後得學會偽裝。每個回合採用新預設後重新擬合。
 *
 * `--strong`（第 26 回合，Edward 2026-11-04「一套讀人模型，擬合強者」）：資料改用 `games_cache.json`（`datasetReplay` 嚴格重播），
 * 每個動作只數「那個動作對到的強者分面前 5」的座位（`infl/strongCohort.ts`：藍方角色的派隊／投票／湖 → 藍方任務王、梅林 → 梅林存活王、
 * 紅方角色 → 紅方任務王），再向全體真人的同一格收縮（後退）：投票格 [強者贊成 + K·p全體, 強者票數 + K]，派隊每個 (陣營, 回合段) 加 K 個依全體分布的虛擬次數，
 * 湖 K/10；任務牌（隊上紅數 × 失敗張數）用全體真人（一張牌是全隊紅方一起決定的）。K = `--strong-k`（預設 200）。給 `AgentTuning.beliefStrongTables`。
 *
 * 表（key → [次數, 總數] 或分布）：
 *   - vote：`陣營|在隊上|隊上有紅|回合段` → 贊成次數 / 總票數（非強制、票型可信的提議；回合段 r12 / r3）。
 *   - proposal：`隊長陣營|回合段|隊上紅數（不含隊長）` → 次數（隊長在自己隊上的提議）。
 *   - mission：`回合|隊上紅數` → 失敗牌張數的分布。
 *   - redLake：`目標陣營` → 紅方持湖者宣告「紅」的次數 / 總數。
 *   - voteKey（第 17 回合）：同 vote，但只算第 3 局起、紅方已兩紅的提議（關鍵局；`陣營|在隊上|隊上有紅`）——第 16 回合起紅方
 *     不在隊上的關鍵隊外白只在這隊過得了時開，關鍵局的票和一般第 3 局起的票分開讀（`AgentTuning.beliefKeyVoteCells`）。
 *   - voteAlone（第 24 回合）：紅方在隊上的票，分「隊上沒有其他紅」（alone）／「有」（ally）：`evil|alone|r3`、`evil|ally|r3`，關鍵局另記 `evil|alone|key`／`evil|ally|key`
 *     （`AgentTuning.beliefRedAloneCells`；莫德雷德在隊上沒有隊友時多半內黑，刺客／莫甘娜不會——同一格平均起來，內黑被讀成忠臣的票型）。
 *   - voteBite（第 24 回合）：鐵咬——非強制的提議保留最近一次失敗任務的全部隊員、只拿掉一人 X（X 不是隊長），X 的票：`陣營` → 贊成次數 / 總數
 *     （無辜的人知道失敗來自其他人，投白 = 認壞；`AgentTuning.beliefBiteCell`）。
 *   - voteRole / proposalRole：同 vote / proposal，但只算梅林與莫甘娜（`角色|…`）——派西分辨兩根拇指用
 *     （第 3 回合，2026-10-28）。proposalRole 的紅數不含隊長自己。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { campOf, parseReplayGame, rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import type { PlayerObservation, Role } from '../src/ai/types';
import { parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';

/** The fields the tables read (a `ReplayGame` has them; bot games are converted to it). */
interface FitGame {
  seatRoles: Role[];
  proposals: { round: number; leaderSeat: number; teamSeats: number[]; forced: boolean; votesReliable: boolean; votes: boolean[] }[];
  quests: { round: number; teamSeats: number[]; failCount: number }[];
  lakes: { holderSeat: number; targetSeat: number; claim: 'good' | 'evil' | null }[];
}

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const botGames = Number(arg('--bots') ?? 0);
const flags: Partial<AgentTuning> = {};
process.argv.forEach((a, i) => { if (a === '--flag') Object.assign(flags, parseTuningFlag(process.argv[i + 1])); });
const seedPrefix = arg('--seed-prefix') ?? 'fitbot';
const mergeAt = process.argv.indexOf('--merge');
const mergeFiles = mergeAt >= 0 ? process.argv.slice(mergeAt + 1).filter((_, i, xs) => !xs.slice(0, i + 1).some((x) => x.startsWith('--'))) : [];
const out = arg('--out') ?? path.resolve(__dirname, botGames > 0 ? '../src/ai/belief/likelihoods_bot.json' : process.argv.includes('--strong') ? '../src/ai/belief/likelihoods_strong.json' : '../src/ai/belief/likelihoods.json');

class Rec extends HeuristicAgent {
  constructor(id: string) { super(id, undefined, undefined, flags); }
  last?: PlayerObservation; role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}

async function loadBotGames(n: number): Promise<FitGame[]> {
  const engine = new SelfPlayEngine();
  const log = console.log; const orig = Math.random;
  const games: FitGame[] = [];
  for (let i = 0; i < n; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`${seedPrefix}|${i}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const o = agents[0].last;
    if (!o) continue;
    const seat = (id: string): number => Number(id.slice(1));
    games.push({
      seatRoles: agents.map((a) => a.role as Role),
      proposals: o.voteHistory.map((v) => ({ round: v.round, leaderSeat: seat(v.leader), teamSeats: v.team.map(seat), forced: v.attempt >= 5, votesReliable: v.attempt < 5, votes: agents.map((a) => v.votes[a.agentId] === true) })),
      quests: o.questHistory.map((q) => ({ round: q.round, teamSeats: q.team.map(seat), failCount: q.failCount ?? 0 })),
      lakes: (o.lakeHistory ?? []).map((l) => ({ holderSeat: seat(l.holderId), targetSeat: seat(l.targetId), claim: l.declaredClaim === 'none' ? null : l.declaredClaim })),
    });
  }
  return games;
}

function loadHumanGames(): FitGame[] {
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
  const games: FitGame[] = [];
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (r.ok && r.game.playerCount === 10) games.push(r.game);
  }
  return games;
}

/** `--strong`: games_cache.json replayed games with names, and the strong-facet filters (top 5 of the facet each action maps to). */
interface Selector { vote: (g: number, seat: number) => boolean; lead: (g: number, seat: number) => boolean; lake: (g: number, seat: number) => boolean }
async function loadStrongGames(): Promise<{ games: FitGame[]; strong: Selector }> {
  const { loadStrongCohorts } = await import('./strongCohort');
  const { humanGamesFromDataset } = await import('../src/ai/infl/strongData');
  const { inFacetTop } = await import('../src/ai/infl/strongCohort');
  const { cohorts, dataset } = loadStrongCohorts({});
  const { games: hg } = humanGamesFromDataset(dataset as never, cohorts.threshold);
  const games = hg.map((h) => h.game).filter((g) => g.playerCount === 10);
  const top = (kind: 'vote' | 'team' | 'lakeClaim') => (g: number, seat: number): boolean =>
    inFacetTop(cohorts, games[g].seatRoles[seat - 1], kind, games[g].names?.[seat - 1] ?? '', 5);
  return { games, strong: { vote: top('vote'), lead: top('team'), lake: top('lakeClaim') } };
}

/** `--merge`: add up the counts of tables fitted by this script. */
function mergeTables(files: string[]): void {
  const sum: Record<string, unknown> & { games: number } = { source: `merged: ${files.map((f) => path.basename(f)).join(' + ')}`, games: 0, fittedAt: new Date().toISOString().slice(0, 10) };
  for (const f of files) {
    const t = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
    sum.games += Number(t.games ?? 0);
    for (const name of ['vote', 'proposal', 'mission', 'redLake', 'voteRole', 'proposalRole', 'voteKey', 'voteAlone', 'voteBite']) {
      const acc = (sum[name] ??= {}) as Record<string, number | number[]>;
      for (const [k, v] of Object.entries((t[name] ?? {}) as Record<string, number | number[]>)) {
        if (typeof v === 'number') acc[k] = ((acc[k] as number | undefined) ?? 0) + v;
        else { const a = (acc[k] ??= v.map(() => 0)) as number[]; v.forEach((x, j) => { a[j] = (a[j] ?? 0) + x; }); }
      }
    }
  }
  fs.writeFileSync(out, JSON.stringify(sum, null, 1) + '\n');
  console.log(`wrote ${out}: ${sum.games} games from ${files.length} tables`);
}

type Tables = ReturnType<typeof fitTables>;
const ALL: Selector = { vote: () => true, lead: () => true, lake: () => true };

function fitTables(games: readonly FitGame[], sel: Selector = ALL) {
const vote: Record<string, [number, number]> = {};
const proposal: Record<string, number> = {};
const mission: Record<string, number[]> = {};
const redLake: Record<string, [number, number]> = {};
const voteRole: Record<string, [number, number]> = {};
const voteKey: Record<string, [number, number]> = {};
const voteAlone: Record<string, [number, number]> = {};
const voteBite: Record<string, [number, number]> = {};
const proposalRole: Record<string, number> = {};
const bump = (t: Record<string, [number, number]>, k: string, hit: boolean) => { const v = (t[k] ??= [0, 0]); if (hit) v[0]++; v[1]++; };
const bucket = (round: number) => (round <= 2 ? 'r12' : 'r3');

games.forEach((g, gi) => {
  const red = (seat: number) => campOf(g.seatRoles[seat - 1]) === 'evil';
  // 10 人局：第 4 局要兩張失敗才算失敗。
  const failsBefore = (round: number) => g.quests.filter((q) => q.round < round && q.failCount >= (q.round === 4 ? 2 : 1)).length;
  for (const p of g.proposals) {
    const reds = p.teamSeats.filter(red).length;
    if (p.teamSeats.includes(p.leaderSeat) && sel.lead(gi, p.leaderSeat)) {
      const k = p.teamSeats.filter((s) => s !== p.leaderSeat && red(s)).length;
      const key = `${red(p.leaderSeat) ? 'evil' : 'good'}|${bucket(p.round)}|${k}`;
      proposal[key] = (proposal[key] ?? 0) + 1;
      const role = g.seatRoles[p.leaderSeat - 1];
      if (role === 'merlin' || role === 'morgana') {
        const rk = `${role}|${bucket(p.round)}|${k}`;
        proposalRole[rk] = (proposalRole[rk] ?? 0) + 1;
      }
    }
    if (p.forced || !p.votesReliable) continue;
    // 鐵咬: the most recent failed mission before this round keeps all but one member X (off the team, not the leader).
    const failedBefore = g.quests.filter((q) => q.round < p.round && q.failCount >= (q.round === 4 ? 2 : 1));
    const lastFail = failedBefore[failedBefore.length - 1];
    const bitten = lastFail ? lastFail.teamSeats.filter((s) => !p.teamSeats.includes(s)) : [];
    if (bitten.length === 1 && bitten[0] !== p.leaderSeat && sel.vote(gi, bitten[0])) bump(voteBite, red(bitten[0]) ? 'evil' : 'good', p.votes[bitten[0] - 1]);
    for (let seat = 1; seat <= 10; seat++) {
      if (!sel.vote(gi, seat)) continue;
      const key = `${red(seat) ? 'evil' : 'good'}|${p.teamSeats.includes(seat) ? 'on' : 'off'}|${reds > 0 ? 'red' : 'clean'}|${bucket(p.round)}`;
      bump(vote, key, p.votes[seat - 1]);
      if (p.round >= 3 && failsBefore(p.round) >= 2) bump(voteKey, key.split('|').slice(0, 3).join('|'), p.votes[seat - 1]);
      if (p.round >= 3 && red(seat) && p.teamSeats.includes(seat)) {
        const cell = `evil|${reds === 1 ? 'alone' : 'ally'}`;
        bump(voteAlone, `${cell}|r3`, p.votes[seat - 1]);
        if (failsBefore(p.round) >= 2) bump(voteAlone, `${cell}|key`, p.votes[seat - 1]);
      }
      const role = g.seatRoles[seat - 1];
      if (role === 'merlin' || role === 'morgana') bump(voteRole, `${role}|${key.split('|').slice(1).join('|')}`, p.votes[seat - 1]);
    }
  }
  for (const q of g.quests) {
    const key = `${q.round}|${q.teamSeats.filter(red).length}`;
    const dist = (mission[key] ??= [0, 0, 0, 0, 0, 0]);
    dist[Math.min(5, q.failCount)]++;
  }
  for (const l of g.lakes) {
    if (!red(l.holderSeat) || l.claim === null || !sel.lake(gi, l.holderSeat)) continue;
    bump(redLake, red(l.targetSeat) ? 'evil' : 'good', l.claim === 'evil');
  }
});
return { vote, proposal, mission, redLake, voteRole, proposalRole, voteKey, voteAlone, voteBite };
}

/**
 * `--strong`: the strong counts backed off to the all-human cell — [hit + K·p, n + K] for the vote-like cells, K pseudo-proposals per
 * (camp, bucket) spread by the all-human distribution, K / 10 for the red lake; the mission cells are the all-human ones.
 */
function backoff(strong: Tables, all: Tables, k: number): Tables {
  const cells = (s: Record<string, [number, number]>, a: Record<string, [number, number]>, kk: number): Record<string, [number, number]> => {
    const out: Record<string, [number, number]> = {};
    for (const key of new Set([...Object.keys(s), ...Object.keys(a)])) {
      const [sh, sn] = s[key] ?? [0, 0];
      const [ah, an] = a[key] ?? [0, 0];
      const pa = an > 0 ? ah / an : 0.5;
      out[key] = [Number((sh + kk * pa).toFixed(3)), sn + kk];
    }
    return out;
  };
  const dist = (s: Record<string, number>, a: Record<string, number>): Record<string, number> => {
    const tot = new Map<string, number>();
    for (const [key, c] of Object.entries(a)) { const pre = key.split('|').slice(0, -1).join('|'); tot.set(pre, (tot.get(pre) ?? 0) + c); }
    const out: Record<string, number> = {};
    for (const key of new Set([...Object.keys(s), ...Object.keys(a)])) {
      const pre = key.split('|').slice(0, -1).join('|');
      const t = tot.get(pre) ?? 0;
      out[key] = Number(((s[key] ?? 0) + (t > 0 ? k * (a[key] ?? 0) / t : 0)).toFixed(3));
    }
    return out;
  };
  return {
    vote: cells(strong.vote, all.vote, k), voteRole: cells(strong.voteRole, all.voteRole, k), voteKey: cells(strong.voteKey, all.voteKey, k),
    voteAlone: cells(strong.voteAlone, all.voteAlone, k), voteBite: cells(strong.voteBite, all.voteBite, k / 4), redLake: cells(strong.redLake, all.redLake, k / 10),
    proposal: dist(strong.proposal, all.proposal), proposalRole: dist(strong.proposalRole, all.proposalRole), mission: all.mission,
  };
}

(async () => {
if (mergeFiles.length > 0) { mergeTables(mergeFiles); return; }
const strongMode = process.argv.includes('--strong');
let tables: Tables;
let games: readonly FitGame[];
let source: string;
if (strongMode) {
  const k = Number(arg('--strong-k') ?? 200);
  const loaded = await loadStrongGames();
  games = loaded.games;
  const all = fitTables(games);
  const strong = fitTables(games, loaded.strong);
  const n = (t: Record<string, [number, number]>) => Object.values(t).reduce((a, [, x]) => a + x, 0);
  console.log(`strong votes ${n(strong.vote)} of ${n(all.vote)}; strong proposals ${Object.values(strong.proposal).reduce((a, b) => a + b, 0)} of ${Object.values(all.proposal).reduce((a, b) => a + b, 0)}; K = ${k}`);
  tables = backoff(strong, all, k);
  source = `games_cache.json 強者分面前 5（向全體真人收縮，K = ${k}）`;
} else {
  games = botGames > 0 ? await loadBotGames(botGames) : loadHumanGames();
  tables = fitTables(games);
  source = botGames > 0 ? '' : 'sheets_cache.json 牌譜';
}
const { vote, proposal, mission, redLake, voteRole, proposalRole, voteKey, voteAlone, voteBite } = tables;

const flagText = Object.entries(flags).map(([k, v]) => `${k}=${String(v)}`).join(' ');
const table = { source: botGames > 0 ? `self-play (production defaults${flagText ? ` + ${flagText}` : ''})` : source, games: games.length, fittedAt: new Date().toISOString().slice(0, 10), vote, proposal, mission, redLake, voteRole, proposalRole, voteKey, voteAlone, voteBite };
fs.writeFileSync(out, JSON.stringify(table, null, 1) + '\n');
console.log(`wrote ${out}: ${games.length} games`);
for (const [k, [a, n]] of Object.entries(vote).sort()) console.log(`  vote ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, d] of Object.entries(mission).sort()) console.log(`  mission ${k} fails ${d.join('/')}`);
for (const [k, [a, n]] of Object.entries(voteKey).sort()) console.log(`  voteKey ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, [a, n]] of Object.entries(voteBite).sort()) console.log(`  voteBite ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, [a, n]] of Object.entries(voteAlone).sort()) console.log(`  voteAlone ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, [a, n]] of Object.entries(voteRole).sort()) console.log(`  voteRole ${k.padEnd(26)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, [a, n]] of Object.entries(redLake)) console.log(`  redLake target ${k}: declared red ${(100 * a / n).toFixed(1)}% (${n})`);
// The self-play engine leaves timers behind: exit once the table is written.
process.exit(0);
})();
