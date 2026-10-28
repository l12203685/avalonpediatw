/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 任務階段的診斷（優化迴圈用，2026-10-28）：全機器人自我對打 N 局 vs 真人牌譜（10 人局），逐局比較
 * 出任務的隊伍有沒有紅、是不是第 5 次強制提議、隊長陣營，與任務成功率。開關用環境變數（AVALON_TUNING_*）。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/missionDiagnosis.ts 600
 *
 * 輸出（每局 R1–R5）：到這一局的局數、出任務的隊有紅的比例（藍隊長／紅隊長）、強制提議比例、任務成功率。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { campOf, parseReplayGame, rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import type { PlayerObservation } from '../src/ai/types';

const EVIL = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

interface Tally { n: number; redTeam: number; blueLead: number; blueLeadRed: number; redLead: number; redLeadRed: number; forced: number; success: number }
const blank = (): Tally => ({ n: 0, redTeam: 0, blueLead: 0, blueLeadRed: 0, redLead: 0, redLeadRed: 0, forced: 0, success: 0 });

function add(t: Tally, hasRed: boolean, redLeader: boolean, forced: boolean, success: boolean): void {
  t.n++;
  if (hasRed) t.redTeam++;
  if (redLeader) { t.redLead++; if (hasRed) t.redLeadRed++; } else { t.blueLead++; if (hasRed) t.blueLeadRed++; }
  if (forced) t.forced++;
  if (success) t.success++;
}

function report(label: string, rows: Tally[]): void {
  const pct = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)}%` : '—').padStart(6);
  console.log(`\n${label}`);
  console.log('局 | 局數 | 隊上有紅 | 藍隊長隊上有紅 | 紅隊長比例 | 紅隊長隊上有紅 | 強制 | 任務成功');
  rows.forEach((t, i) => {
    console.log(`R${i + 1} | ${String(t.n).padStart(5)} | ${pct(t.redTeam, t.n)} | ${pct(t.blueLeadRed, t.blueLead)} | ${pct(t.redLead, t.n)} | ${pct(t.redLeadRed, t.redLead)} | ${pct(t.forced, t.n)} | ${pct(t.success, t.n)}`);
  });
}

class Rec extends HeuristicAgent {
  last?: PlayerObservation;
  role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}

(async () => {
  // Humans: the replayable 10-player games.
  const human = Array.from({ length: 5 }, blank);
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
  for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    const r = parseReplayGame(row);
    if (!r.ok || r.game.playerCount !== 10) continue;
    const g = r.game;
    const red = (seat: number): boolean => campOf(g.seatRoles[seat - 1]) === 'evil';
    for (const q of g.quests) {
      const p = g.proposals.find((x) => x.round === q.round && x.wentOnMission);
      if (!p) continue;
      add(human[q.round - 1], q.teamSeats.some(red), red(p.leaderSeat), p.forced, !q.failed);
    }
  }

  // Bots: self-play with the current defaults (env overrides apply).
  const N = Number(process.argv[2] ?? 600);
  const bots = Array.from({ length: 5 }, blank);
  const engine = new SelfPlayEngine();
  const log = console.log;
  const orig = Math.random;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`missiondiag|${i}`);
    console.log = () => undefined;
    try { await engine.runGame(agents, false); } finally { console.log = log; Math.random = orig; }
    const roles = Object.fromEntries(agents.map((a) => [a.agentId, a.role]));
    const o = agents[0].last;
    if (!o) continue;
    for (const q of o.questHistory) {
      const v = o.voteHistory.find((x) => x.round === q.round && x.approved);
      if (!v) continue;
      const hasRed = q.team.some((id) => EVIL.has(roles[id]));
      add(bots[q.round - 1], hasRed, EVIL.has(roles[v.leader]), v.attempt >= 5, q.result === 'success');
    }
  }
  report('真人牌譜（10 人局）', human);
  report(`機器人自我對打（${N} 局）`, bots);
})();
