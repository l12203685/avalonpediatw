/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 基本邏輯一致性稽核（第 1 階段：只量測，不改策略；`docs/ai/basic_logic_inventory.md`）。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/logicAudit.ts \
 *     [--games 1000] [--seed 20261103] [--shard 0/2] [--human] [--out out.json]
 *   pnpm --filter @avalon/server exec tsx scripts/logicAudit.ts --merge a.json b.json --out all.json
 *
 * 選項：
 *   --games N       自我對打局數（預設 1000；10 人局、每個座位都是 DEFAULT_AGENT_TUNING 的 HeuristicAgent，
 *                   正式路徑 USE_FORWARD_REASONING）
 *   --seed S        主種子（預設 20261103）；第 i 局的座位、角色與每個決策的亂數都由 (S, i) 決定
 *   --shard k/n     只跑 i % n === k 的局（兩個程序平行時用；之後 --merge）
 *   --human         另外量真人牌譜（games_cache.json，`datasetReplay.ts` 的嚴格解析；只量、不重播）
 *   --dataset PATH  真人資料集（預設 ./games_cache.json）
 *   --merge A B …   把幾個 --out 的 JSON 加總（計數直接相加），再輸出表格
 *   --out PATH      JSON 輸出；同名 .md 寫表格
 *   --flag NAME[=V] 十個座位都在 DEFAULT_AGENT_TUNING 上再套這個開關（可重複；第 24 回合：量改法前後的違反率）
 *
 * 做法：每局結束後把整局（每次提議的隊長、隊伍、每個人的黑白球、任務失敗張數、湖與宣告、每個座位的角色）
 * 收成一份「局紀錄」，再用同一組檢查函式算每條規則的「機會數」與「違反數」，依違反者的角色分開記。
 * 真人局用同一組函式，只是票從牌譜重建（`votesReliable` 為假的提議不算投票規則），每個人的任務牌不知道。
 * 一條規則的機會 = 那個人「可以違反」的場合（例如隊長在自己派的隊上的非強制提議），違反 = 真的做了。
 *
 * 每條規則的主觀視角都是「那個人當時知道的」：自己的角色視野（梅林看到莫德雷德以外的紅、派西兩拇指恰好
 * 一紅、相認紅互見）、之前每次任務的失敗張數、自己湖到的結果。第一人稱的世界列舉在這個檔案裡自己做，
 * 不呼叫機器人的確定性層，所以它是獨立的檢查（和 `invariants/*` 重疊的規則見盤點文件）。
 *
 * 公開 repo：輸出只有彙總計數，沒有玩家名、聊天或座位。
 */

import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import type { PlayerObservation } from '../src/ai/types';

// ── 局紀錄（自我對打與真人共用） ────────────────────────────────

export type Camp = 'good' | 'evil';

export interface TraceProposal {
  round: number;
  /** 本局第幾次提議（1..5）。 */
  attempt: number;
  /** 座位索引（0..n-1）。 */
  leader: number;
  team: number[];
  /** votes[seat] = 贊成？；強制提議或重建不可信 = null。 */
  votes: boolean[] | null;
  approved: boolean;
  /** 第 5 次強制提議（沒有投票）。 */
  forced: boolean;
}

export interface TraceQuest {
  round: number;
  team: number[];
  failCount: number;
  /** 自我對打才有：cards[seat] = 這個座位出的牌（不在隊上 = undefined）。 */
  cards?: Array<'success' | 'fail' | undefined>;
}

export interface TraceLake {
  /** 在第幾局任務之後用的湖。 */
  round: number;
  holder: number;
  target: number;
  /** 公開宣告；null = 沒有宣告。 */
  claim: Camp | null;
  /** 被湖者的真實陣營（= 持湖者私下看到的）。 */
  result: Camp;
}

export interface GameTrace {
  n: number;
  roles: Role[];
  proposals: TraceProposal[];
  quests: TraceQuest[];
  lakes: TraceLake[];
  /** false = 湖鏈對不起來（真人紀錄），湖的規則略過這一局。 */
  lakesValid: boolean;
}

const EVIL: ReadonlySet<Role> = new Set<Role>(['assassin', 'morgana', 'mordred', 'oberon', 'minion' as Role]);

export function campOfRole(r: Role): Camp {
  return EVIL.has(r) ? 'evil' : 'good';
}

export function failsRequired(n: number, round: number): number {
  return AVALON_CONFIG[n]?.questFailsRequired[round - 1] ?? 1;
}

/** 一次任務「失敗」= 失敗牌達到該局所需張數。 */
function questFailed(n: number, q: TraceQuest): boolean {
  return q.failCount >= failsRequired(n, q.round);
}

function teamKey(team: readonly number[]): string {
  return [...team].sort((a, b) => a - b).join(',');
}

// ── 計數 ──────────────────────────────────────────────────────

/** key = `規則|角色|局段` → [機會, 違反]。局段 = 'R1-2' / 'R3+'。 */
export type Counts = Record<string, [number, number]>;

export class Tally {
  readonly counts: Counts = {};
  add(rule: string, role: string, round: number, violated: boolean): void {
    const key = `${rule}|${role}|${round <= 2 ? 'R1-2' : 'R3+'}`;
    const c = this.counts[key] ?? (this.counts[key] = [0, 0]);
    c[0] += 1;
    if (violated) c[1] += 1;
  }
}

export function mergeCounts(into: Counts, from: Counts): void {
  for (const [k, [o, v]] of Object.entries(from)) {
    const c = into[k] ?? (into[k] = [0, 0]);
    c[0] += o;
    c[1] += v;
  }
}

// ── 第一人稱的知識 ─────────────────────────────────────────────

/** 座位一開局就知道的紅（梅林：莫德雷德以外的紅；相認紅：奧伯倫以外的隊友）與派西的兩拇指。 */
export function sightOf(trace: GameTrace, seat: number): { knownRed: number[]; thumbs: number[] } {
  const role = trace.roles[seat];
  const seats = trace.roles.map((_, i) => i).filter((i) => i !== seat);
  if (role === 'merlin') return { knownRed: seats.filter((i) => EVIL.has(trace.roles[i]) && trace.roles[i] !== 'mordred'), thumbs: [] };
  if (role === 'percival') return { knownRed: [], thumbs: seats.filter((i) => trace.roles[i] === 'merlin' || trace.roles[i] === 'morgana') };
  if (role === 'assassin' || role === 'morgana' || role === 'mordred') {
    return { knownRed: seats.filter((i) => EVIL.has(trace.roles[i]) && trace.roles[i] !== 'oberon'), thumbs: [] };
  }
  return { knownRed: [], thumbs: [] };
}

function popcount(x: number): number {
  let c = 0;
  for (let v = x; v; v &= v - 1) c++;
  return c;
}

function maskOf(seats: readonly number[]): number {
  return seats.reduce((m, s) => m | (1 << s), 0);
}

/**
 * 好人座位 `seat` 在第 `round` 局開始時的一致世界（紅方座位的位元遮罩）：自己是藍、視野、之前每次任務
 * 「x 張失敗 ⇒ 至少 x 紅」、自己湖到的結果。不用任何人的宣告（L0；藍方說實話的約定不算）。
 */
export class FirstPerson {
  private readonly all: number[];
  private readonly cache = new Map<string, number[]>();
  constructor(private readonly trace: GameTrace) {
    const n = trace.n;
    const k = trace.roles.filter((r) => EVIL.has(r)).length;
    const out: number[] = [];
    const rec = (start: number, m: number, left: number): void => {
      if (left === 0) { out.push(m); return; }
      for (let i = start; i <= n - left; i++) rec(i + 1, m | (1 << i), left - 1);
    };
    rec(0, 0, k);
    this.all = out;
  }

  worlds(seat: number, round: number): number[] {
    const key = `${seat}|${round}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const t = this.trace;
    const me = 1 << seat;
    const { knownRed, thumbs } = sightOf(t, seat);
    const seen = maskOf(knownRed);
    const thumbMask = maskOf(thumbs);
    const quests = t.quests.filter((q) => q.round < round && q.failCount > 0).map((q) => [maskOf(q.team), q.failCount] as const);
    const lakes = t.lakesValid ? t.lakes.filter((l) => l.holder === seat && l.round < round) : [];
    const out = this.all.filter((w) => {
      if (w & me) return false;
      if ((w & seen) !== seen) return false;
      if (thumbs.length === 2 && popcount(w & thumbMask) !== 1) return false;
      for (const [m, f] of quests) if (popcount(w & m) < f) return false;
      for (const l of lakes) if (((w >> l.target) & 1) !== (l.result === 'evil' ? 1 : 0)) return false;
      return true;
    });
    this.cache.set(key, out);
    return out;
  }

  /** 在這個座位眼中，`team` 至少有幾個紅（所有一致世界的最小值；沒有世界 = -1）。 */
  minReds(seat: number, round: number, team: readonly number[]): number {
    const ws = this.worlds(seat, round);
    if (ws.length === 0) return -1;
    const m = maskOf(team);
    let min = Infinity;
    for (const w of ws) min = Math.min(min, popcount(w & m));
    return min;
  }
}

// ── 規則 ──────────────────────────────────────────────────────

export interface RuleInfo {
  id: string;
  label: string;
  /** 違反者的陣營範圍（表格依這個分列）。 */
  camps: Camp[] | 'mission';
}

export const RULES: readonly RuleInfo[] = [
  { id: 'a_leader_rejects_own', label: '(a) 隊長在自己派、自己在隊上的非強制提議投黑（自派自黑）', camps: ['good', 'evil'] },
  { id: 'a2_leader_rejects_own_off', label: '(a″) 隊長在自己派、自己不在隊上的非強制提議投黑（第 25 回合）', camps: ['good', 'evil'] },
  { id: 'b_repropose_inside_rejected', label: '(b) 隊長在非強制提議重派本局自己內黑過的同一隊', camps: ['good', 'evil'] },
  { id: 'b_forced_repropose_inside_rejected', label: '(b′) 同 (b)，但是第 5 次強制提議', camps: ['good', 'evil'] },
  { id: 'b2_reapprove_inside_rejected', label: '(b2) 本局內黑過的同一隊，之後（不是隊長）改投白', camps: ['good', 'evil'] },
  { id: 'b3_reject_own_earlier_team', label: '(b3) 別人照派自己本局派過的同一隊、自己在隊上卻投黑', camps: ['good', 'evil'] },
  { id: 'c0_good_lake_lie', label: '(c0) 好人持湖宣告和自己湖到的結果相反', camps: ['good'] },
  { id: 'c0_good_lake_silent', label: '(c0′) 好人持湖不宣告', camps: ['good'] },
  { id: 'cd_propose_declared_red', label: '(c/d) 持湖者之後當隊長，把自己宣紅的人派進隊', camps: ['good', 'evil'] },
  { id: 'cd_approve_declared_red', label: '(c/d) 持湖者之後對有自己宣紅者的非強制隊投白', camps: ['good', 'evil'] },
  { id: 'cd_propose_omit_declared_blue', label: '(c/d) 持湖者之後派自己在隊上的隊，卻漏掉自己宣藍的人', camps: ['good', 'evil'] },
  { id: 'e_approve_iron_bite_on_me', label: '(e) 失敗任務的隊員，對「鐵咬」自己的非強制隊投白（認壞）', camps: ['good', 'evil'] },
  { id: 'e_next_round_bite', label: '(e″) 同 (e)，而且是那次失敗任務的下一局（第 25 回合）', camps: ['good', 'evil'] },
  { id: 'e2_propose_iron_bite_self', label: '(e2) 失敗任務的隊員當隊長，派出鐵咬自己的隊', camps: ['good', 'evil'] },
  { id: 'f_red_approves_blue_win', label: '(f) 藍方已兩藍，紅方不在隊上、對全藍的非強制隊投白', camps: ['evil'] },
  { id: 'f2_red_pivotal_blue_win', label: '(f′) 同 (f)，而且這顆白球剛好讓隊伍過半', camps: ['evil'] },
  { id: 'g_approve_failed_rest', label: '(g) 好人出過失敗任務，對包含其餘全部隊員、確定會失敗的非強制隊投白', camps: ['good'] },
  { id: 'g_propose_failed_rest', label: '(g) 好人出過失敗任務，當隊長派出包含其餘全部隊員、確定會失敗的隊', camps: ['good'] },
  { id: 'g_soft_failed_rest', label: '(g′) 同 (g) 投白，但這局要兩張失敗、只確定有紅（第 4 局）', camps: ['good'] },
  { id: 'h_approve_must_fail', label: '(h) 好人對自己視角確定會失敗的非強制隊投白（含梅林看到的紅、自己湖到的紅）', camps: ['good'] },
  { id: 'h_propose_must_fail', label: '(h) 好人當隊長派出自己視角確定會失敗的隊', camps: ['good'] },
  { id: 'h2_approve_certain_red', label: '(h′) 好人對有自己視角確定紅的非強制隊投白（第 4 局一紅不一定失敗也算）', camps: ['good'] },
  { id: 'o_red_forced_leader_no_load', label: '(o) 紅方已兩紅，紅隊長的強制提議沒放夠自己知道的紅', camps: ['evil'] },
  { id: 'p_red_match_point_not_closed', label: '(p) 紅方已兩紅，隊上紅方夠讓任務失敗，任務卻成功（紅方沒收尾）', camps: 'mission' },
];

function proposalsBefore(t: GameTrace, idx: number): TraceProposal[] {
  return t.proposals.slice(0, idx);
}

function winsBefore(t: GameTrace, round: number): { blue: number; red: number } {
  let blue = 0;
  let red = 0;
  for (const q of t.quests) {
    if (q.round >= round) continue;
    if (questFailed(t.n, q)) red++; else blue++;
  }
  return { blue, red };
}

/** 一局的全部規則。 */
export function auditTrace(t: GameTrace, tally: Tally): void {
  const role = (s: number): string => t.roles[s];
  const camp = (s: number): Camp => campOfRole(t.roles[s]);
  const fp = new FirstPerson(t);
  const majority = Math.floor(t.n / 2) + 1;

  t.proposals.forEach((p, idx) => {
    const r = p.round;
    const earlier = proposalsBefore(t, idx).filter((e) => e.round === r);
    const teamSet = new Set(p.team);
    const key = teamKey(p.team);
    const votes = p.forced ? null : p.votes;
    const L = p.leader;

    // (a) 自派自黑。
    if (votes && teamSet.has(L)) tally.add('a_leader_rejects_own', role(L), r, votes[L] === false);
    if (votes && !teamSet.has(L)) tally.add('a2_leader_rejects_own_off', role(L), r, votes[L] === false);

    // (b) 重派自己內黑過的隊（強制提議也算：隊長仍自己選人）。
    const insideRejected = new Set(earlier.filter((e) => e.votes && !e.forced && e.team.includes(L) && e.votes[L] === false).map((e) => teamKey(e.team)));
    if (insideRejected.size > 0) {
      tally.add(p.forced ? 'b_forced_repropose_inside_rejected' : 'b_repropose_inside_rejected', role(L), r, insideRejected.has(key));
    }

    if (votes) {
      for (let v = 0; v < t.n; v++) {
        if (v === L) continue;
        // (b2) 內黑過的同一隊之後改投白。
        const rejectedSame = earlier.some((e) => e.votes && !e.forced && e.team.includes(v) && e.votes[v] === false && teamKey(e.team) === key);
        if (rejectedSame) tally.add('b2_reapprove_inside_rejected', role(v), r, votes[v] === true);
        // (b3) 自己派過的同一隊被照派、自己在隊上卻投黑。
        if (teamSet.has(v) && earlier.some((e) => e.leader === v && teamKey(e.team) === key)) {
          tally.add('b3_reject_own_earlier_team', role(v), r, votes[v] === false);
        }
      }
    }

    // (c/d) 持湖者之後的派隊與投票和自己的宣告一致。
    if (t.lakesValid) {
      for (const l of t.lakes) {
        if (l.round >= r || l.claim === null) continue;
        const H = l.holder;
        const X = l.target;
        if (L === H) {
          if (l.claim === 'evil') tally.add('cd_propose_declared_red', role(H), r, teamSet.has(X));
          if (l.claim === 'good' && teamSet.has(H)) tally.add('cd_propose_omit_declared_blue', role(H), r, !teamSet.has(X));
        } else if (votes && l.claim === 'evil' && teamSet.has(X)) {
          tally.add('cd_approve_declared_red', role(H), r, votes[H] === true);
        }
      }
    }

    // (e) 鐵咬：之前有失敗牌的任務 q（f 張），這隊只沿用 q 的 |q| − f 人，被拿掉的人投白 = 認壞。
    const bitten = new Set<number>();
    const bittenNext = new Set<number>();
    for (const q of t.quests) {
      if (q.round >= r || q.failCount < 1) continue;
      const kept = q.team.filter((s) => teamSet.has(s)).length;
      if (kept !== q.team.length - q.failCount) continue;
      for (const s of q.team) if (!teamSet.has(s)) { bitten.add(s); if (q.round === r - 1) bittenNext.add(s); }
    }
    for (const s of bitten) {
      if (s === L) continue;
      if (votes) tally.add('e_approve_iron_bite_on_me', role(s), r, votes[s] === true);
      if (votes && bittenNext.has(s)) tally.add('e_next_round_bite', role(s), r, votes[s] === true);
    }
    // (e2) 失敗任務的隊員當隊長：機會 = 他之前出過有失敗牌的任務，違反 = 這隊鐵咬他自己。
    if (t.quests.some((q) => q.round < r && q.failCount >= 1 && q.team.includes(L) && q.team.length > 1)) {
      tally.add('e2_propose_iron_bite_self', role(L), r, bitten.has(L));
    }

    // (f) 藍方已兩藍、全藍的隊：不在隊上的紅方投白。
    const wins = winsBefore(t, r);
    if (votes && wins.blue === 2 && p.team.every((s) => camp(s) === 'good')) {
      const approvals = votes.filter(Boolean).length;
      for (let s = 0; s < t.n; s++) {
        if (camp(s) !== 'evil' || teamSet.has(s)) continue;
        tally.add('f_red_approves_blue_win', role(s), r, votes[s] === true);
        tally.add('f2_red_pivotal_blue_win', role(s), r, votes[s] === true && approvals === majority);
      }
    }

    // (g) 好人 g 出過有失敗牌的任務 q：之後的隊包含 q 裡除了 g 以外的全部人。
    const need = failsRequired(t.n, r);
    for (let g = 0; g < t.n; g++) {
      if (camp(g) !== 'good') continue;
      const qs = t.quests.filter((q) => q.round < r && q.failCount >= 1 && q.team.includes(g) && q.team.length > 1);
      if (qs.length === 0) continue;
      const restIn = qs.filter((q) => q.team.every((s) => s === g || teamSet.has(s)));
      const hard = restIn.some((q) => q.failCount >= need);
      if (g === L) tally.add('g_propose_failed_rest', role(g), r, hard);
      else if (votes && restIn.length > 0) {
        if (hard) tally.add('g_approve_failed_rest', role(g), r, votes[g] === true);
        else tally.add('g_soft_failed_rest', role(g), r, votes[g] === true);
      }
    }

    // (h) 好人第一人稱：確定會失敗 / 確定有紅。
    for (let v = 0; v < t.n; v++) {
      if (camp(v) !== 'good') continue;
      const min = fp.minReds(v, r, p.team);
      if (min < 0) continue; // 沒有一致世界（真人紀錄的瑕疵）
      if (v === L) {
        // 機會 = 隊長的每次提議（含強制：隊長仍自己選人）。
        tally.add('h_propose_must_fail', role(v), r, min >= need);
        continue;
      }
      if (!votes) continue;
      if (min >= need) tally.add('h_approve_must_fail', role(v), r, votes[v] === true);
      if (min >= 1) tally.add('h2_approve_certain_red', role(v), r, votes[v] === true);
    }

    // (o) 紅方已兩紅：紅隊長的強制提議放夠自己知道的紅（自己 + 看得到的隊友）。
    if (p.forced && camp(L) === 'evil' && wins.red === 2) {
      const known = new Set([L, ...sightOf(t, L).knownRed]);
      if (known.size >= need && p.team.length >= need) {
        tally.add('o_red_forced_leader_no_load', role(L), r, p.team.filter((s) => known.has(s)).length < need);
      }
    }
  });

  // (p) 紅方已兩紅的任務：隊上的紅夠讓任務失敗，卻成功。
  for (const q of t.quests) {
    const wins = winsBefore(t, q.round);
    if (wins.red !== 2) continue;
    const reds = q.team.filter((s) => camp(s) === 'evil').length;
    const need = failsRequired(t.n, q.round);
    if (reds >= need) tally.add('p_red_match_point_not_closed', 'mission', q.round, q.failCount < need);
  }

  // (c0) 好人持湖說謊 / 不宣告。
  if (t.lakesValid) {
    for (const l of t.lakes) {
      if (camp(l.holder) !== 'good') continue;
      tally.add('c0_good_lake_silent', role(l.holder), l.round, l.claim === null);
      if (l.claim !== null) tally.add('c0_good_lake_lie', role(l.holder), l.round, l.claim !== l.result);
    }
  }
}

/**
 * `--why`：這一票（決策當下的觀測）是不是 (a) / (e) / (f) 的違反；是的話回傳規則名。`campOf` = 真實陣營
 * （只有稽核用，機器人看不到）。和 `auditTrace` 同一個定義，只是在投票當下判斷。
 */
export function whyRule(obs: PlayerObservation, vote: boolean, campOf: (id: string) => Camp | undefined): string | null {
  if (obs.failCount >= 4) return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const onTeam = team.includes(me);
  if (!vote && onTeam && obs.currentLeader === me) return 'a_leader_rejects_own';
  if (!vote || onTeam) return null;
  const blueWins = obs.questHistory.filter((q) => q.failCount < failsRequired(obs.playerCount, q.round)).length;
  if (obs.myTeam === 'evil' && blueWins === 2 && team.every((id) => campOf(id) === 'good')) return 'f_red_approves_blue_win';
  if (obs.currentLeader === me) return null;
  const bitten = obs.questHistory.some((q) => q.failCount >= 1 && q.team.includes(me)
    && q.team.filter((id) => team.includes(id)).length === q.team.length - q.failCount);
  return bitten ? 'e_approve_iron_bite_on_me' : null;
}

// ── 彙總與表格 ────────────────────────────────────────────────

export interface Cell { opp: number; viol: number }

const ROLE_ORDER = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon', 'mission'];
const ROLE_ZH: Record<string, string> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫', mission: '任務',
};

export function cellOf(counts: Counts, rule: string, filter: (role: string, group: string) => boolean): Cell {
  let opp = 0;
  let viol = 0;
  for (const [k, [o, v]] of Object.entries(counts)) {
    const [r, role, group] = k.split('|');
    if (r !== rule || !filter(role, group)) continue;
    opp += o;
    viol += v;
  }
  return { opp, viol };
}

function fmt(c: Cell): string {
  if (c.opp === 0) return '—';
  return `${((100 * c.viol) / c.opp).toFixed(1)}% (${c.viol}/${c.opp})`;
}

const isGoodRole = (role: string): boolean => campOfRole(role as Role) === 'good' && role !== 'mission';

export function markdownReport(bot: Counts, human: Counts | null, meta: Record<string, unknown>, why?: Record<string, number> | null): string {
  const lines: string[] = [];
  lines.push(`# 基本邏輯一致性稽核`);
  lines.push('');
  lines.push(`- ${Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n- ')}`);
  lines.push('');
  lines.push('格式：違反率（違反 / 機會）。真人欄：牌譜（`games_cache.json`），票只用重建可信的提議。');
  lines.push('');
  lines.push('## 依陣營');
  lines.push('');
  lines.push('| 規則 | 陣營 | 機器人 全部 | 機器人 R3+ | 真人 全部 | 真人 R3+ |');
  lines.push('|---|---|---|---|---|---|');
  for (const rule of RULES) {
    const camps: Array<{ name: string; f: (role: string) => boolean }> = rule.camps === 'mission'
      ? [{ name: '任務', f: (role) => role === 'mission' }]
      : rule.camps.map((c) => ({ name: c === 'good' ? '藍' : '紅', f: (role: string) => role !== 'mission' && (c === 'good' ? isGoodRole(role) : !isGoodRole(role)) }));
    for (const c of camps) {
      const all = (counts: Counts): string => fmt(cellOf(counts, rule.id, (role) => c.f(role)));
      const late = (counts: Counts): string => fmt(cellOf(counts, rule.id, (role, g) => c.f(role) && g === 'R3+'));
      lines.push(`| ${rule.label} | ${c.name} | ${all(bot)} | ${late(bot)} | ${human ? all(human) : '—'} | ${human ? late(human) : '—'} |`);
    }
  }
  lines.push('');
  lines.push('## 依角色（全部局段；機器人 / 真人）');
  lines.push('');
  lines.push(`| 規則 | ${ROLE_ORDER.slice(0, 7).map((r) => ROLE_ZH[r]).join(' | ')} |`);
  lines.push(`|---|${ROLE_ORDER.slice(0, 7).map(() => '---').join('|')}|`);
  for (const rule of RULES) {
    if (rule.camps === 'mission') continue;
    const cells = ROLE_ORDER.slice(0, 7).map((role) => {
      const inCamp = rule.camps !== 'mission' && rule.camps.includes(campOfRole(role as Role));
      if (!inCamp) return '';
      const b = cellOf(bot, rule.id, (r) => r === role);
      const h = human ? cellOf(human, rule.id, (r) => r === role) : { opp: 0, viol: 0 };
      return `${fmt(b)} / ${fmt(h)}`;
    });
    lines.push(`| ${rule.label} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  if (why && Object.keys(why).length > 0) {
    lines.push('## 違反的那一票是哪一條規則決定的（`--why`；機器人）');
    lines.push('');
    lines.push('| 規則 | 角色 | 正式路徑的決策 | 票數 |');
    lines.push('|---|---|---|---|');
    const rows = Object.entries(why).map(([k, c]) => [...k.split('|'), c] as [string, string, string, number]);
    rows.sort((a, b) => a[0].localeCompare(b[0]) || b[3] - a[3]);
    for (const [rule, role, reason, c] of rows) lines.push(`| ${rule} | ${ROLE_ZH[role] ?? role} | ${reason} | ${c} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── 自我對打 ──────────────────────────────────────────────────

interface Args {
  games: number;
  seed: number;
  shard: [number, number];
  human: boolean;
  /** 記下 (a)(e)(f) 違反的那一票是正式路徑的哪一條規則決定的（多算一次決策）。 */
  why: boolean;
  dataset: string;
  merge: string[];
  out?: string;
  flags: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    games: 1000, seed: 20261103, shard: [0, 1], human: false, why: false,
    dataset: path.resolve(__dirname, '..', 'games_cache.json'), merge: [], flags: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--games': args.games = Number.parseInt(next(), 10); break;
      case '--seed': args.seed = Number.parseInt(next(), 10); break;
      case '--shard': {
        const [k, n] = next().split('/').map((x) => Number.parseInt(x, 10));
        if (!(n > 0 && k >= 0 && k < n)) throw new Error('--shard k/n');
        args.shard = [k, n];
        break;
      }
      case '--human': args.human = true; break;
      case '--why': args.why = true; break;
      case '--dataset': args.dataset = path.resolve(next()); break;
      case '--merge':
        while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.merge.push(path.resolve(argv[++i]));
        break;
      case '--out': args.out = path.resolve(next()); break;
      case '--flag': args.flags.push(next()); break;
      case '--help': case '-h':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return args;
}

async function runSelfPlay(args: Args, tally: Tally, why: Record<string, number> | null): Promise<{ games: number; elapsedSec: number; forward: { totalDecisions: number; fallbacks: number } }> {
  // 延遲載入：測試只用上面的純函式。
  const { HeuristicAgent } = await import('../src/ai/HeuristicAgent');
  const { SelfPlayEngine } = await import('../src/ai/SelfPlayEngine');
  const { DEFAULT_AGENT_TUNING, parseTuningFlag } = await import('../src/ai/AgentTuning');
  const tuning = { ...DEFAULT_AGENT_TUNING };
  for (const f of args.flags) Object.assign(tuning, parseTuningFlag(f));
  const { seededRandom, withSeededRandom } = await import('../src/ai/benchmark/agreement');
  const { getForwardTelemetry, ForwardAgent } = await import('../src/ai/forward/ForwardAgent');
  type Obs = import('../src/ai/types').PlayerObservation;
  type Act = import('../src/ai/types').AgentAction;

  class AuditSeat {
    readonly agentType = 'heuristic' as const;
    private readonly inner: InstanceType<typeof HeuristicAgent>;
    gameSeed = '';
    role: Role = 'loyal';
    cards = new Map<number, 'success' | 'fail'>();
    final: Obs | null = null;
    constructor(readonly agentId: string) {
      this.inner = new HeuristicAgent(agentId, undefined, undefined, { ...tuning });
    }
    private seedFor(obs: Obs, extra = ''): string {
      return [this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
        `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`,
        obs.proposedTeam.join(','), extra].join('|');
    }
    onStart: (id: string, c: Camp) => void = () => undefined;
    onGameStart(obs: Obs): void {
      this.role = obs.myRole;
      this.onStart(obs.myPlayerId, obs.myTeam);
      this.cards = new Map();
      this.final = null;
      this.inner.onGameStart(obs);
    }
    act(obs: Obs): Act {
      const a = withSeededRandom(this.seedFor(obs), () => this.inner.act(obs));
      if (a.type === 'quest_vote') this.cards.set(obs.currentRound, a.vote);
      if (why && a.type === 'team_vote') {
        const rule = whyRule(obs, a.vote, this.campOf);
        if (rule) {
          // 同一個種子重算一次正式路徑的決策，只為了拿到它的理由（ingest 是冪等的，結果和上面那一票相同）。
          const d = withSeededRandom(this.seedFor(obs), () => new ForwardAgent(this.agentId, this.inner).decide(obs));
          const reason = d.action.type === 'team_vote' && d.action.vote === a.vote
            ? d.reasoningTrace.summary.replace(/\s*\(score=[^)]*\)/, '').replace(/\s*\(round=\d+\)/, '')
            : '(re-run differs)';
          const key = `${rule}|${obs.myRole}|${reason}`;
          why[key] = (why[key] ?? 0) + 1;
        }
      }
      return a;
    }
    campOf: (id: string) => Camp | undefined = () => undefined;
    pickLakeTarget(obs: Obs, valid?: readonly string[]): string {
      return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, valid));
    }
    declareLake(obs: Obs, target: string, truth: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
      return withSeededRandom(this.seedFor(obs, `claim-${target}`), () => this.inner.declareLake(obs, target, truth));
    }
    onGameEnd(obs: Obs, won: boolean): void {
      this.final = obs;
      this.inner.onGameEnd(obs, won);
    }
  }

  const engine = new SelfPlayEngine();
  const started = Date.now();
  const originalLog = console.log;
  const originalRandom = Math.random;
  let played = 0;
  console.log = (): void => undefined; // GameEngine 每個事件都印 JSON
  try {
    for (let i = args.shard[0]; i < args.games; i += args.shard[1]) {
      const agents = Array.from({ length: 10 }, (_, s) => new AuditSeat(`P${s + 1}`));
      const gameSeed = `${args.seed}|${i}`;
      const camps = new Map<string, Camp>();
      for (const a of agents) {
        a.gameSeed = gameSeed;
        a.campOf = (id) => camps.get(id);
        a.onStart = (id, c) => camps.set(id, c);
      }
      Math.random = seededRandom(`${gameSeed}|setup`);
      try {
        await engine.runGame(agents, false);
      } finally {
        Math.random = originalRandom;
      }
      auditTrace(traceFromSelfPlay(agents), tally);
      played++;
      if (played % 50 === 0) {
        process.stderr.write(`[logicAudit ${args.shard.join('/')}] ${played} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
      }
    }
  } finally {
    console.log = originalLog;
  }
  const tel = getForwardTelemetry();
  return { games: played, elapsedSec: (Date.now() - started) / 1000, forward: { totalDecisions: tel.totalDecisions, fallbacks: tel.fallbacks } };

  function traceFromSelfPlay(agents: AuditSeat[]): GameTrace {
    const obs = agents[0].final;
    if (!obs) throw new Error('game did not end');
    const ids = obs.allPlayerIds;
    const seatOf = new Map(ids.map((id, i) => [id, i]));
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const roles = ids.map((id) => byId.get(id)!.role);
    const n = ids.length;
    const proposals: TraceProposal[] = obs.voteHistory.map((v) => {
      const forced = v.attempt >= 5;
      return {
        round: v.round,
        attempt: v.attempt,
        leader: seatOf.get(v.leader)!,
        team: v.team.map((id) => seatOf.get(id)!),
        votes: forced ? null : ids.map((id) => v.votes[id] === true),
        approved: v.approved,
        forced,
      };
    });
    const quests: TraceQuest[] = obs.questHistory.map((q) => ({
      round: q.round,
      team: q.team.map((id) => seatOf.get(id)!),
      failCount: q.failCount,
      cards: ids.map((id) => (q.team.includes(id) ? byId.get(id)!.cards.get(q.round) : undefined)),
    }));
    const lakes: TraceLake[] = (obs.lakeHistory ?? []).map((l) => ({
      round: l.round,
      holder: seatOf.get(l.holderId)!,
      target: seatOf.get(l.targetId)!,
      claim: l.declaredClaim === 'none' ? null : l.declaredClaim,
      result: campOfRole(roles[seatOf.get(l.targetId)!]),
    }));
    return { n, roles, proposals, quests, lakes, lakesValid: true };
  }
}

// ── 真人牌譜 ──────────────────────────────────────────────────

async function runHuman(datasetPath: string, tally: Tally): Promise<{ games: number; skipped: Record<string, number>; total: number; lakeChainInvalid: number }> {
  const { replayGamesFromDataset } = await import('../src/ai/benchmark/datasetReplay');
  const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const { games, skipped } = replayGamesFromDataset(raw);
  let invalid = 0;
  for (const dg of games) {
    const g = dg.game;
    const trace: GameTrace = {
      n: g.playerCount,
      roles: [...g.seatRoles],
      proposals: g.proposals.map((p) => ({
        round: p.round,
        attempt: p.attempt,
        leader: p.leaderSeat - 1,
        team: p.teamSeats.map((s) => s - 1),
        votes: p.votesReliable ? [...p.votes] : null,
        approved: p.wentOnMission,
        forced: p.forced,
      })),
      quests: g.quests.map((q) => ({ round: q.round, team: q.teamSeats.map((s) => s - 1), failCount: q.failCount })),
      lakes: g.lakes.map((l) => ({
        round: l.round,
        holder: l.holderSeat - 1,
        target: l.targetSeat - 1,
        claim: l.claim,
        result: campOfRole(g.seatRoles[l.targetSeat - 1]),
      })),
      lakesValid: g.lakeChainValid,
    };
    if (!g.lakeChainValid) invalid++;
    auditTrace(trace, tally);
  }
  return { games: games.length, skipped, total: raw.games.length, lakeChainInvalid: invalid };
}

// ── main ─────────────────────────────────────────────────────

interface Output {
  meta: Record<string, unknown>;
  bot: Counts;
  human: Counts | null;
  /** `--why`：`規則|角色|正式路徑的理由` → 票數。 */
  why?: Record<string, number> | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let out: Output;
  if (args.merge.length > 0) {
    out = { meta: { merged: args.merge.map((f) => path.basename(f)) }, bot: {}, human: null };
    let games = 0;
    let elapsed = 0;
    for (const f of args.merge) {
      const part = JSON.parse(fs.readFileSync(f, 'utf8')) as Output;
      mergeCounts(out.bot, part.bot);
      if (part.why) { out.why = out.why ?? {}; for (const [k, c] of Object.entries(part.why)) out.why[k] = (out.why[k] ?? 0) + c; }
      if (part.human) { out.human = out.human ?? {}; mergeCounts(out.human, part.human); out.meta.human = part.meta.human; }
      games += Number((part.meta.selfplay as { games?: number } | undefined)?.games ?? 0);
      elapsed = Math.max(elapsed, Number((part.meta.selfplay as { elapsedSec?: number } | undefined)?.elapsedSec ?? 0));
      if (part.meta.seed !== undefined) out.meta.seed = part.meta.seed;
      if (part.meta.tuning !== undefined) out.meta.tuning = part.meta.tuning;
    }
    out.meta.selfplay = { games, elapsedSec: elapsed };
  } else {
    const botTally = new Tally();
    const why: Record<string, number> | null = args.why ? {} : null;
    const selfplay = args.games > 0 ? await runSelfPlay(args, botTally, why) : null;
    let human: Counts | null = null;
    let humanMeta: unknown = null;
    if (args.human) {
      const t = new Tally();
      humanMeta = await runHuman(args.dataset, t);
      human = t.counts;
    }
    out = {
      meta: { seed: args.seed, shard: args.shard.join('/'), tuning: args.flags.length > 0 ? `DEFAULT_AGENT_TUNING + ${args.flags.join(' ')}` : 'DEFAULT_AGENT_TUNING', selfplay, human: humanMeta },
      bot: botTally.counts,
      why,
      human,
    };
  }
  const md = markdownReport(out.bot, out.human, out.meta, out.why);
  console.log(md);
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
    fs.writeFileSync(args.out.replace(/\.json$/, '') + '.md', `${md}\n`);
    console.log(`wrote ${args.out}`);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
