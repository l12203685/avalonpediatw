/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 梅林的資訊流（優化迴圈第 5 回合・梅林，2026-10-29）：全機器人自我對打 N 局 vs 真人牌譜（10 人局）。
 *   - 第 3 局起非強制提議，梅林對「隊上有梅林看得到的紅」的隊贊成的比例、對「看起來乾淨」的隊贊成的比例；
 *   - 梅林當隊長（第 3 局起）派的隊有紅的比例；
 *   - 三藍後梅林被刺中的比例。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/merlinDiagnosis.ts 400
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { campOf, parseReplayGame, rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import type { PlayerObservation } from '../src/ai/types';

interface T { visYes: number; visN: number; cleanYes: number; cleanN: number; leadRed: number; leadN: number; three: number; killed: number }
const blank = (): T => ({ visYes: 0, visN: 0, cleanYes: 0, cleanN: 0, leadRed: 0, leadN: 0, three: 0, killed: 0 });
const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const show = (label: string, t: T): void => console.log(`${label}: 有可見紅的隊贊成 ${pct(t.visYes, t.visN)}（${t.visN}）｜乾淨的隊贊成 ${pct(t.cleanYes, t.cleanN)}（${t.cleanN}）｜梅林當隊長隊上有紅 ${pct(t.leadRed, t.leadN)}（${t.leadN}）｜三藍後被刺中 ${pct(t.killed, t.three)}（${t.three}）`);

class Rec extends HeuristicAgent {
  last?: PlayerObservation; role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}

(async () => {
  const human = blank();
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (!r.ok || r.game.playerCount !== 10) continue;
    const g = r.game;
    const merlin = g.seatRoles.indexOf('merlin') + 1;
    const visible = (s: number): boolean => campOf(g.seatRoles[s - 1]) === 'evil' && g.seatRoles[s - 1] !== 'mordred';
    for (const p of g.proposals) {
      if (p.round < 3) continue;
      if (p.leaderSeat === merlin) { human.leadN++; if (p.teamSeats.some((s) => campOf(g.seatRoles[s - 1]) === 'evil')) human.leadRed++; }
      if (p.forced || !p.votesReliable) continue;
      const yes = p.votes[merlin - 1];
      if (p.teamSeats.some(visible)) { human.visN++; if (yes) human.visYes++; } else { human.cleanN++; if (yes) human.cleanYes++; }
    }
    if (g.quests.filter((q) => !q.failed).length >= 3) { human.three++; if (g.assassinTargetSeat === merlin) human.killed++; }
  }

  const N = Number(process.argv[2] ?? 400);
  const bots = blank();
  const engine = new SelfPlayEngine();
  const log = console.log; const orig = Math.random;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`merlindiag|${i}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const roles = Object.fromEntries(agents.map((a) => [a.agentId, a.role]));
    const merlin = Object.keys(roles).find((id) => roles[id] === 'merlin');
    const o = agents[0].last;
    if (!o || !merlin) continue;
    const evil = (id: string): boolean => ['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(roles[id]);
    const visible = (id: string): boolean => evil(id) && roles[id] !== 'mordred';
    for (const v of o.voteHistory) {
      if (v.round < 3) continue;
      if (v.leader === merlin) { bots.leadN++; if (v.team.some(evil)) bots.leadRed++; }
      if (v.attempt >= 5 || v.votes[merlin] === undefined) continue;
      if (v.team.some(visible)) { bots.visN++; if (v.votes[merlin]) bots.visYes++; } else { bots.cleanN++; if (v.votes[merlin]) bots.cleanYes++; }
    }
    // (Kill rate of the bots: the strength screens report it — 刺中率.)
  }
  show('真人（R3 起）', human);
  show(`機器人（${N} 局，R3 起）`, bots);
})();
