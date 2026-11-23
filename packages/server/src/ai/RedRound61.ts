/**
 * 優化迴圈第 61 回合・紅方（2026-11-23）：刺殺與第 2 局出牌。
 *
 * 起點是第 60 回合（`docs/ai/gap/r60-keyspots.md`）：同一批 1,193 個真人刺殺點，機器人刺客的刺中率比真人刺客低 5.4pp，
 * 集中在「第 1 局成功、第 2 局失敗」的三藍局（−10.0pp；藍紅紅藍藍 −18.6pp）；紅方第 2 局（1:0）隊上有紅時，機器人出失敗 73%、強者 88%。
 *
 * 刺殺照現行的規則是四個紅方一起討論：刺殺階段紅方開牌相認（`allEvilIds`／`allEvilRoles`），所以這裡的特徵用完整的紅方名單；
 * 「看得到的紅」= 梅林看得到的三個（扣掉莫德雷德）。讀法站在忠臣的角度：只有忠臣做不出來的動作才算梅林的證據。
 *
 * 開關（`AgentTuning`，預設 0）：
 * - `assassinPath61`：第 1 局成功、第 2 局失敗的三藍局，刺殺分數裡投票、隊長、照派三項讀法乘上較小的倍數（`PATH61_MULTS`）。
 *   倍數在真人局偶數號擬合、奇數號驗證（`scripts/assassinPathStudy.ts` → `.py`）。1 = 開。
 * - `redR2Lead61`：第 2 局（第 1 局成功、1:0）自己在隊上的紅方出牌（`redR2LeadCard61`）。
 */
import type { PlayerObservation, VoteRecord } from './types';
import type { AgentTuning } from './AgentTuning';
import { missionFailed } from './missionFacts';

/** The mission order of the finished game, e.g. 'BR' prefix = R1 success, R2 fail. */
export function missionOrder61(obs: PlayerObservation): string {
  return [...obs.questHistory].sort((a, b) => a.round - b.round).map((q) => (missionFailed(q) ? 'R' : 'B')).join('');
}

/** The proposal that went on round `r`'s mission (the last approved record of that round). */
function missionVote(obs: PlayerObservation, r: number): VoteRecord | undefined {
  const xs = obs.voteHistory.filter((v) => v.round === r && v.approved);
  return xs[xs.length - 1];
}

/** Names of the candidate features (`assassinPathFeatures61`), in order. */
export const PATH61_FEATURES = [
  'onR1', 'onR2', 'ledR1', 'ledR2', 'rejR2Off', 'rejR2On', 'apprR2Off', 'onFail', 'onSucc', 'ledSucc', 'ledFail',
  'rejFailOff', 'apprFailOff', 'rejSuccOff', 'rejR4', 'rejCleanSeenOff', 'apprSeenOff',
] as const;
export type Path61Feature = (typeof PATH61_FEATURES)[number];

/**
 * Per-candidate features at the assassination (the assassin's observation; `reds` = every red, known at the assassination).
 * Mission votes only count non-forced records (a forced 5th proposal carries synthetic votes).
 */
export function assassinPathFeatures61(obs: PlayerObservation, c: string, reds: readonly string[]): Record<Path61Feature, number> {
  const roles = obs.allEvilRoles;
  const red = new Set(reds);
  const seen = new Set(reds.filter((id) => !roles || roles[id] !== 'mordred'));
  const f: Record<Path61Feature, number> = Object.fromEntries(PATH61_FEATURES.map((k) => [k, 0])) as Record<Path61Feature, number>;
  for (const q of obs.questHistory) {
    const on = q.team.includes(c);
    if (q.round === 1 && on) f.onR1 = 1;
    if (q.round === 2 && on) f.onR2 = 1;
    if (on) { if (missionFailed(q)) f.onFail++; else f.onSucc++; }
    const mv = missionVote(obs, q.round);
    if (!mv) continue;
    if (mv.leader === c) {
      if (missionFailed(q)) f.ledFail++; else f.ledSucc++;
      if (q.round === 1) f.ledR1 = 1;
      if (q.round === 2) f.ledR2 = 1;
    }
    if (mv.attempt >= 5) continue;
    const vote = mv.votes[c];
    if (vote === undefined) continue;
    const onTeam = mv.team.includes(c);
    if (q.round === 2) {
      if (!vote && !onTeam) f.rejR2Off = 1;
      if (!vote && onTeam) f.rejR2On = 1;
      if (vote && !onTeam) f.apprR2Off = 1;
    }
    if (q.round === 4 && !vote) f.rejR4 = 1;
    if (!onTeam) {
      if (missionFailed(q)) { if (vote) f.apprFailOff++; else f.rejFailOff++; } else if (!vote) f.rejSuccOff++;
    }
  }
  // every non-forced vote off the team: rejecting a team with no red Merlin sees / approving one with a seen red
  for (const v of obs.voteHistory) {
    if (v.attempt >= 5 || v.team.includes(c)) continue;
    const vote = v.votes[c];
    if (vote === undefined) continue;
    const hasSeen = v.team.some((id) => seen.has(id));
    if (!hasSeen && !v.team.some((id) => red.has(id)) && !vote) f.rejCleanSeenOff++;
    if (hasSeen && vote) f.apprSeenOff++;
  }
  return f;
}

/**
 * 刺殺分數三項讀法的倍數（第 1 局成功、第 2 局失敗的三藍局；`scripts/assassinPathStudy.py`）：
 * 第 3 局起的投票讀法（`assassinMerlinVotes`）、隊長派乾淨隊的讀法（`assassinLeadRead`）、照派的讀法（`assassinReuseRead`）；
 * 條件 logit 的模型分數不變。係數 = 真人局偶數號的刺殺點上，讓「現行分數各項 × 倍數」最接近真人刺客實際選的人（條件 logit，L2 往 1 收縮），
 * 取整到 0.05；奇數號的刺殺點驗證刺中率。這條路上機器人刺客選到的人，投票讀法與隊長讀法的分數都遠高於真梅林（第 61 回合第 2 節）。
 */
export interface Path61Mults { vote: number; lead: number; reuse: number }

export const PATH61_MULTS: Readonly<Record<'BR', Path61Mults>> = { BR: { vote: 0.25, lead: 0.4, reuse: 0.15 } };

/** The multipliers that apply at this assassination (null = none: switch off, or not an R1-success / R2-fail game). */
export function path61Mults(tuning: Readonly<AgentTuning>, obs: PlayerObservation): Path61Mults | null {
  if ((tuning.assassinPath61 ?? 0) <= 0) return null;
  return missionOrder61(obs).startsWith('BR') ? PATH61_MULTS.BR : null;
}

// ── 第 2 局出牌（第 1 局成功、1:0） ─────────────────────────────────

/**
 * 真人局第 1 局成功之後的第 2 局，隊上只有自己一個紅（看不到隊友；奧伯倫一律算）時出成功（藏牌）的比例：
 * `games_cache.json` 嚴格重播 2,234 局，任務隊只有這一個紅的局，任務失敗張數 0 的比例（刺客 4／92、莫甘娜 3／95、莫德雷德 4／155、奧伯倫 24／106）。
 * 高端桌（S ≥ 55）同一格：刺客 0／10、莫甘娜 1／15、莫德雷德 0／26、奧伯倫 3／15。第 27 回合 `redHideHuman` 用的是紅方任務王前 5 的比例
 * （刺客 14%、莫甘娜 8%、莫德雷德 5%、奧伯倫 40%），比全部真人與高端桌都高。
 */
export const R2_LEAD_HIDE_RATE: Readonly<Record<string, number>> = { assassin: 0.04, morgana: 0.03, mordred: 0.03, oberon: 0.23 };

const teamKey = (team: readonly string[]): string => [...team].sort().join(',');

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/**
 * `redR2Lead61`: on R2 after an R1 success (1:0), a red on the mission team that sees no teammate on it plays 'success' at the
 * real-game rate of its role (`R2_LEAD_HIDE_RATE`), otherwise 'fail'; null = the rule does not apply (switch off, another score,
 * a teammate on the team — the rank order decides those). The draw is the same hash as `redHideHuman` (seat, round, team), so
 * every hide here is also a hide there: the switch only turns some of `redHideHuman`'s hides into fails.
 */
export function redR2LeadCard61(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | 'fail' | null {
  if ((tuning.redR2Lead61 ?? 0) <= 0 || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return null;
  if ((obs.currentRound ?? 1) !== 2) return null;
  const res = obs.questResults ?? [];
  if (res.length !== 1 || res[0] !== 'success') return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(me) || team.some((id) => id !== me && obs.knownEvils.includes(id))) return null;
  const rate = R2_LEAD_HIDE_RATE[obs.myRole];
  if (rate === undefined) return null;
  return hash01(`${me}|2|${teamKey(team)}|redhidehuman`) < rate ? 'success' : 'fail';
}
