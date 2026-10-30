/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 貝氏信念的概似表（優化迴圈第 1 回合・第三階段信念引擎，2026-10-28）：從真人牌譜（1970 局可重播 10 人局）統計
 * 「在某種身分分配下，一個人做出這個動作」的機率，只存彙總次數（不含名字、不含單局紀錄）。
 *
 *   npx tsx scripts/fitBeliefLikelihoods.ts [--out src/ai/belief/likelihoods.json]
 *   USE_FORWARD_REASONING=true npx tsx scripts/fitBeliefLikelihoods.ts --bots 600 [--out src/ai/belief/likelihoods_bot.json]
 *
 * `--bots N`（優化迴圈，Edward 2026-10-30：「舊的藍方沒有從派票或投票直接分辨出誰是藍誰是紅，所以紅方根本不需要隱藏」）：
 * 改從全機器人自我對打 N 局（正式預設）統計同一組表，給 `AgentTuning.beliefBotTables` 用——藍方照「目前的對手實際怎麼做」
 * 讀派隊、投票與任務牌；紅方之後得學會偽裝。每個回合採用新預設後重新擬合。
 *
 * 表（key → [次數, 總數] 或分布）：
 *   - vote：`陣營|在隊上|隊上有紅|回合段` → 贊成次數 / 總票數（非強制、票型可信的提議；回合段 r12 / r3）。
 *   - proposal：`隊長陣營|回合段|隊上紅數（不含隊長）` → 次數（隊長在自己隊上的提議）。
 *   - mission：`回合|隊上紅數` → 失敗牌張數的分布。
 *   - redLake：`目標陣營` → 紅方持湖者宣告「紅」的次數 / 總數。
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

/** The fields the tables read (a `ReplayGame` has them; bot games are converted to it). */
interface FitGame {
  seatRoles: Role[];
  proposals: { round: number; leaderSeat: number; teamSeats: number[]; forced: boolean; votesReliable: boolean; votes: boolean[] }[];
  quests: { round: number; teamSeats: number[]; failCount: number }[];
  lakes: { holderSeat: number; targetSeat: number; claim: 'good' | 'evil' | null }[];
}

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const botGames = Number(arg('--bots') ?? 0);
const out = arg('--out') ?? path.resolve(__dirname, botGames > 0 ? '../src/ai/belief/likelihoods_bot.json' : '../src/ai/belief/likelihoods.json');

class Rec extends HeuristicAgent {
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
    Math.random = seededRandom(`fitbot|${i}`);
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

(async () => {
const games: FitGame[] = botGames > 0 ? await loadBotGames(botGames) : loadHumanGames();

const vote: Record<string, [number, number]> = {};
const proposal: Record<string, number> = {};
const mission: Record<string, number[]> = {};
const redLake: Record<string, [number, number]> = {};
const voteRole: Record<string, [number, number]> = {};
const proposalRole: Record<string, number> = {};
const bump = (t: Record<string, [number, number]>, k: string, hit: boolean) => { const v = (t[k] ??= [0, 0]); if (hit) v[0]++; v[1]++; };
const bucket = (round: number) => (round <= 2 ? 'r12' : 'r3');

for (const g of games) {
  const red = (seat: number) => campOf(g.seatRoles[seat - 1]) === 'evil';
  for (const p of g.proposals) {
    const reds = p.teamSeats.filter(red).length;
    if (p.teamSeats.includes(p.leaderSeat)) {
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
    for (let seat = 1; seat <= 10; seat++) {
      const key = `${red(seat) ? 'evil' : 'good'}|${p.teamSeats.includes(seat) ? 'on' : 'off'}|${reds > 0 ? 'red' : 'clean'}|${bucket(p.round)}`;
      bump(vote, key, p.votes[seat - 1]);
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
    if (!red(l.holderSeat) || l.claim === null) continue;
    bump(redLake, red(l.targetSeat) ? 'evil' : 'good', l.claim === 'evil');
  }
}

const table = { source: botGames > 0 ? 'self-play (production defaults)' : 'sheets_cache.json 牌譜', games: games.length, fittedAt: new Date().toISOString().slice(0, 10), vote, proposal, mission, redLake, voteRole, proposalRole };
fs.writeFileSync(out, JSON.stringify(table, null, 1) + '\n');
console.log(`wrote ${out}: ${games.length} games`);
for (const [k, [a, n]] of Object.entries(vote).sort()) console.log(`  vote ${k.padEnd(22)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, d] of Object.entries(mission).sort()) console.log(`  mission ${k} fails ${d.join('/')}`);
for (const [k, [a, n]] of Object.entries(voteRole).sort()) console.log(`  voteRole ${k.padEnd(26)} ${(100 * a / n).toFixed(1)}% (${n})`);
for (const [k, [a, n]] of Object.entries(redLake)) console.log(`  redLake target ${k}: declared red ${(100 * a / n).toFixed(1)}% (${n})`);
// The self-play engine leaves timers behind: exit once the table is written.
process.exit(0);
})();
