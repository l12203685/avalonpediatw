/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 機器人 vs 真人強桌：同一套行為指標（Edward 2026-10-29：「分析一下跟真人強桌的差別在哪，接下來優化的方向比較好抓；
 * 可以參考該角色強的玩家的玩法」）。真人 10 人局分四欄：
 *   - 全部；
 *   - 強桌：同桌玩家超額勝率平均最高的 1/4（`strongTableOutcomes.ts` 的分法）；
 *   - 強角色：只看「這個角色勝率在前 1/4 的玩家」（該角色至少 15 場）做的動作——派隊、投票、任務牌、湖中都照動作者的角色篩；
 *   - 機器人：全機器人自我對打 N 局（正式預設）。
 * 只輸出彙總數字（不輸出玩家名字或單局紀錄）。
 *
 *   USE_FORWARD_REASONING=true npx tsx scripts/strongTableGap.ts 400
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { campOf, parseReplayGame, rowsFromSheet } from '../src/ai/benchmark/sheetsReplay';
import type { PlayerObservation, Role } from '../src/ai/types';

interface P { round: number; attempt: number; leader: number; team: number[]; votes: boolean[] | null; forced: boolean; sent: boolean }
interface Q { round: number; team: number[]; fails: number }
interface L { round: number; holder: number; target: number; claim: 'good' | 'evil' | null }
interface G { roles: Role[]; strong: boolean[]; proposals: P[]; quests: Q[]; lakes: L[]; threeBlue: boolean; merlinKilled: boolean | null }

const ZH: Record<string, Role> = { 刺客: 'assassin', 莫甘娜: 'morgana', 莫德雷德: 'mordred', 奧伯倫: 'oberon', 派西維爾: 'percival', 梅林: 'merlin', 忠臣: 'loyal' };
const evil = (r: Role): boolean => campOf(r) === 'evil';

// ── Humans ───────────────────────────────────────────────────
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../sheets_cache.json'), 'utf8')) as Record<string, string[][]>;
const cache = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../analysis_cache.json'), 'utf8'));
const aliases: Record<string, string> = cache.players?.aliases ?? {};
const key = (n: string): string => (aliases[n] ?? aliases[n.toLowerCase()] ?? n).toLowerCase();
type CachedPlayer = { name: string; totalGames: number; excessWinRate: number | null; rawRoleGames?: Record<string, number>; roleWinRates?: Record<string, number | null> };
const players = cache.players.players as CachedPlayer[];
const tableStrength = new Map<string, number>();
for (const p of players) if (p.totalGames >= 30 && typeof p.excessWinRate === 'number') tableStrength.set(p.name.toLowerCase(), p.excessWinRate);
// Strong in a role: top quarter of that role's win rate among players with ≥ 15 games in it.
const strongIn = new Map<Role, Set<string>>();
for (const [zh, role] of Object.entries(ZH)) {
  const ranked = players
    .filter((p) => (p.rawRoleGames?.[zh] ?? 0) >= 15 && typeof p.roleWinRates?.[zh] === 'number')
    .sort((a, b) => (b.roleWinRates![zh] as number) - (a.roleWinRates![zh] as number));
  strongIn.set(role, new Set(ranked.slice(0, Math.max(1, Math.floor(ranked.length / 4))).map((p) => p.name.toLowerCase())));
}

const humans: { g: G; tableMean: number | null }[] = [];
for (const row of rowsFromSheet(data['牌譜'] ?? [])) {
  if (!(row['文字記錄'] ?? '').trim()) continue;
  const r = parseReplayGame(row);
  if (!r.ok || r.game.playerCount !== 10) continue;
  const h = r.game;
  const vals = h.names.map((n) => tableStrength.get(key(n))).filter((v): v is number => typeof v === 'number');
  const merlin = h.seatRoles.indexOf('merlin') + 1;
  const threeBlue = h.quests.filter((q) => !q.failed).length >= 3;
  humans.push({
    tableMean: vals.length >= 8 ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    g: {
      roles: h.seatRoles,
      strong: h.names.map((n, i) => strongIn.get(h.seatRoles[i])?.has(key(n)) ?? false),
      proposals: h.proposals.map((p) => ({ round: p.round, attempt: p.attempt, leader: p.leaderSeat, team: p.teamSeats, votes: p.votesReliable ? p.votes : null, forced: p.forced, sent: p.wentOnMission })),
      quests: h.quests.map((q) => ({ round: q.round, team: q.teamSeats, fails: q.failCount })),
      lakes: h.lakes.map((l) => ({ round: l.round, holder: l.holderSeat, target: l.targetSeat, claim: l.claim })),
      threeBlue,
      merlinKilled: threeBlue && h.assassinTargetSeat !== undefined ? h.assassinTargetSeat === merlin : null,
    },
  });
}

// ── Metrics ──────────────────────────────────────────────────
type Acc = Map<string, [number, number]>;
const add = (m: Acc, k: string, hit: boolean, n = 1): void => { const v = m.get(k) ?? [0, 0]; v[0] += hit ? n : 0; v[1] += n; m.set(k, v); };
const addVal = (m: Acc, k: string, x: number): void => { const v = m.get(k) ?? [0, 0]; v[0] += x; v[1] += 1; m.set(k, v); };
const ROLE_ZH: Record<Role, string> = { loyal: '忠臣', percival: '派西', merlin: '梅林', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德', oberon: '奧伯倫' } as Record<Role, string>;
const stage = (round: number): string => (round <= 2 ? `R${round}` : 'R3+');

/** `actorOk(seat)`: only actions by these seats count for the per-role metrics (all seats for the table-level ones). */
function measure(g: G, m: Acc, actorOk: (seat: number) => boolean): void {
  const role = (s: number): Role => g.roles[s - 1];
  const red = (s: number): boolean => evil(role(s));
  const seenByMerlin = (s: number): boolean => red(s) && role(s) !== 'mordred';
  const thumbs = (s: number): boolean => role(s) === 'merlin' || role(s) === 'morgana';
  const mates = (s: number, t: number): boolean => red(s) && red(t) && s !== t && role(s) !== 'oberon' && role(t) !== 'oberon';
  // Outcomes (table level).
  add(m, 'A 三紅', g.quests.filter((q) => q.fails >= (q.round === 4 ? 2 : 1)).length >= 3);
  if (g.merlinKilled !== null) add(m, 'A 三藍後刺中梅林', g.merlinKilled);
  for (const q of g.quests) add(m, `A 任務成功 R${q.round}`, q.fails < (q.round === 4 ? 2 : 1));
  // Proposal flow (table level).
  const rounds = new Map<number, P[]>();
  for (const p of g.proposals) rounds.set(p.round, [...(rounds.get(p.round) ?? []), p]);
  for (const [r, ps] of rounds) {
    addVal(m, `B 每局提議次數 ${stage(r)}`, ps.length);
    add(m, `B 走到第 5 次強制 ${stage(r)}`, ps.some((p) => p.forced));
    const sent = ps.find((p) => p.sent);
    if (sent) {
      add(m, `B 出任務的隊是紅隊長派的 ${stage(r)}`, red(sent.leader));
      add(m, `B 出任務的隊有紅 ${stage(r)}`, sent.team.some(red));
    }
  }
  // Leaders by role.
  for (const p of g.proposals) {
    if (!actorOk(p.leader)) continue;
    const r = role(p.leader);
    const st = p.forced ? '強制' : stage(p.round);
    if (!evil(r)) {
      add(m, `C ${ROLE_ZH[r]}當隊長：隊上有紅 ${st}`, p.team.some(red));
      if (r === 'merlin') add(m, `C 梅林當隊長：隊上有看得到的紅 ${st}`, p.team.some(seenByMerlin));
      if (r === 'percival' && p.round <= 2 && !p.forced) add(m, 'C 派西當隊長 R1–R2：隊上有拇指', p.team.some((s) => s !== p.leader && thumbs(s)));
    } else if (r !== 'oberon') {
      const n = p.team.filter((s) => s === p.leader || mates(p.leader, s)).length;
      addVal(m, `C ${ROLE_ZH[r]}當隊長：隊上相認紅人數 ${st}`, n);
      add(m, `C ${ROLE_ZH[r]}當隊長：派 2 個以上相認紅 ${st}`, n >= 2);
    }
  }
  // Votes (R3+, non-forced, reliable records only).
  for (const p of g.proposals) {
    if (p.round < 3 || p.forced || !p.votes) continue;
    const hasRed = p.team.some(red);
    for (let s = 1; s <= g.roles.length; s++) {
      if (!actorOk(s)) continue;
      const r = role(s);
      const on = p.team.includes(s);
      const yes = p.votes[s - 1];
      if (!evil(r)) {
        if (r === 'merlin') {
          const seen = p.team.some(seenByMerlin);
          add(m, `D 梅林 ${on ? '在隊上' : '不在隊上'}：有看得到的紅的隊贊成`, yes && seen, seen ? 1 : 0);
          add(m, `D 梅林 ${on ? '在隊上' : '不在隊上'}：看得到的都乾淨的隊贊成`, yes && !seen, seen ? 0 : 1);
        } else {
          add(m, `D ${ROLE_ZH[r]} ${on ? '在隊上' : '不在隊上'}：有紅的隊贊成`, yes && hasRed, hasRed ? 1 : 0);
          add(m, `D ${ROLE_ZH[r]} ${on ? '在隊上' : '不在隊上'}：乾淨的隊贊成`, yes && !hasRed, hasRed ? 0 : 1);
        }
      } else if (r !== 'oberon' && !on) {
        const mate = p.team.some((t) => mates(s, t));
        add(m, `D ${ROLE_ZH[r]} 不在隊上：有隊友的隊贊成（外白）`, yes && mate, mate ? 1 : 0);
        add(m, `D ${ROLE_ZH[r]} 不在隊上：沒有隊友的隊贊成`, yes && !mate, mate ? 0 : 1);
      } else if (r !== 'oberon' && on) {
        add(m, `D ${ROLE_ZH[r]} 在隊上：贊成`, yes);
      }
    }
  }
  // Quest cards (table level: the fail count against the reds on the team).
  for (const q of g.quests) {
    const reds = q.team.filter(red).length;
    if (reds === 0) continue;
    const need = q.round === 4 ? 2 : 1;
    add(m, `E 隊上 ${reds >= 2 ? '2+' : '1'} 紅：0 張失敗（藏） ${stage(q.round)}`, q.fails === 0);
    if (reds >= 2) add(m, `E 隊上 2+ 紅：失敗張數 > 需要（多爆） ${stage(q.round)}`, q.fails > need);
  }
  // Lake.
  for (const l of g.lakes) {
    if (!actorOk(l.holder) || l.claim === null) continue;
    const tRed = red(l.target);
    if (!red(l.holder)) {
      add(m, 'F 藍方持湖：照實宣告', (l.claim === 'evil') === tRed);
      add(m, 'F 藍方持湖：湖到紅方', tRed);
    } else {
      add(m, `F 紅方持湖：湖${tRed ? '紅（隊友等）' : '藍'}時說謊`, (l.claim === 'evil') !== tRed);
    }
  }
}

class Rec extends HeuristicAgent {
  last?: PlayerObservation; role = '';
  onGameStart(o: PlayerObservation): void { this.role = o.myRole; super.onGameStart(o); }
  onGameEnd(o: PlayerObservation, w: boolean): void { this.last = o; super.onGameEnd(o, w); }
}

(async () => {
  const all: Acc = new Map(); const strongT: Acc = new Map(); const strongR: Acc = new Map(); const bots: Acc = new Map();
  const tables = humans.filter((h) => h.tableMean !== null).sort((a, b) => (a.tableMean as number) - (b.tableMean as number));
  const strongTables = new Set(tables.slice(Math.floor(tables.length * 0.75)).map((h) => h.g));
  for (const { g } of humans) {
    measure(g, all, () => true);
    if (strongTables.has(g)) measure(g, strongT, () => true);
    measure(g, strongR, (s) => g.strong[s - 1]);
  }

  const N = Number(process.argv[2] ?? 400);
  const engine = new SelfPlayEngine();
  const log = console.log; const orig = Math.random;
  for (let i = 0; i < N; i++) {
    const agents = Array.from({ length: 10 }, (_, k) => new Rec(`P${k + 1}`));
    Math.random = seededRandom(`gap|${i}`);
    console.log = () => undefined;
    let res: { merlinKilled?: boolean; threeBlue?: boolean } = {};
    try { res = await engine.runGame(agents, false) as typeof res; } finally { console.log = log; Math.random = orig; }
    const o = agents[0].last;
    if (!o) continue;
    const seat = (id: string): number => Number(id.slice(1));
    const roles = agents.map((a) => a.role as Role);
    const byRound = new Map<number, number>();
    const g: G = {
      roles,
      strong: roles.map(() => true),
      proposals: o.voteHistory.map((v) => {
        byRound.set(v.round, (byRound.get(v.round) ?? 0) + 1);
        return { round: v.round, attempt: v.attempt, leader: seat(v.leader), team: v.team.map(seat), votes: agents.map((a) => v.votes[a.agentId] === true), forced: v.attempt >= 5, sent: v.approved || v.attempt >= 5 };
      }),
      quests: o.questHistory.map((q) => ({ round: q.round, team: q.team.map(seat), fails: q.failCount ?? 0 })),
      lakes: (o.lakeHistory ?? []).map((l) => ({ round: l.round, holder: seat(l.holderId), target: seat(l.targetId), claim: l.declaredClaim === 'none' ? null : l.declaredClaim })),
      threeBlue: res.threeBlue === true,
      merlinKilled: res.threeBlue ? res.merlinKilled === true : null,
    };
    measure(g, bots, () => true);
  }

  const fmt = (v?: [number, number], mean = false): string => {
    if (!v || v[1] === 0) return '—';
    return mean ? (v[0] / v[1]).toFixed(2) : `${((100 * v[0]) / v[1]).toFixed(1)}%`;
  };
  const keys = [...new Set([...all.keys(), ...bots.keys()])].sort();
  console.log(`真人 10 人局 ${humans.length} 局（強桌 ${strongTables.size} 局）；機器人 ${N} 局（正式預設）`);
  console.log('| 指標 | 真人全部 | 真人強桌 | 強角色玩家 | 機器人 | 機器人 − 參考（A/B/E 對強桌，其餘對強角色） |');
  console.log('|---|---|---|---|---|---|');
  for (const k of keys) {
    const mean = k.includes('次數') || k.includes('人數');
    // Table-level metrics (outcomes, proposal flow, quest cards) compare with the strong tables; per-role ones with the strong players.
    const tableLevel = /^[ABE] /.test(k);
    const ref = tableLevel ? strongT.get(k) : strongR.get(k);
    const b = bots.get(k);
    const diff = ref && b && ref[1] && b[1]
      ? (mean ? (b[0] / b[1] - ref[0] / ref[1]).toFixed(2) : `${(100 * (b[0] / b[1] - ref[0] / ref[1])).toFixed(1)}pp`)
      : '—';
    const n = (v?: [number, number]): string => (v ? ` (${v[1]})` : '');
    const roleCol = tableLevel ? '—' : `${fmt(strongR.get(k), mean)}${n(strongR.get(k))}`;
    console.log(`| ${k} | ${fmt(all.get(k), mean)} | ${fmt(strongT.get(k), mean)}${tableLevel ? n(strongT.get(k)) : ''} | ${roleCol} | ${fmt(b, mean)}${n(b)} | ${diff} |`);
  }
})();
