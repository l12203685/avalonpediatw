/**
 * 優化迴圈第 25 回合・紅方（2026-11-03）：奧伯倫的票、紅方持湖者的言行一致、紅方隊長照派。
 *
 * Edward 2026-11-03：「這些思考邏輯應該都蠻基本的 包括鐵咬 隊內 隊外 主觀視角應該都會知道…還有自己的湖中 到派的隊伍跟 黑白球投票 都要有一致性」；
 * 練習台：「派 2350 就是代表在鐵咬 6 家，6 還開白球就代表 6 是認壞了」，之後已暴露的奧伯倫又對第 4 局、藍方已兩藍的全藍隊外白，那一隊過了就進刺殺。
 * `docs/ai/basic_logic_inventory.md` 的 E3、G3、K8、S2、S5，稽核 (e)、(f′)、(c/d)、(b)。
 *
 * 硬約束（一直開；`AgentTuning` 的欄位只為了量測與舊表）：
 *   - `oberonMatchPoint`（G3）：藍方已兩藍時，不在隊上的奧伯倫不對「自己視角沒有確定的紅能讓它失敗」的隊投白——相認紅早就照
 *     `RedVoteCamouflage.redVoteCritical`（沒有隊友、藍方兩藍 → 反對），奧伯倫看不到隊友，等於藍方兩藍時不外白；只有確定性層
 *     （自己湖到的紅、失敗張數推出來的紅）說這隊一定有夠多的紅時才照原本的票。奧伯倫自己是隊長時不適用（自己的提議）。
 *     投票是同時的，奧伯倫無從知道自己那一白會不會剛好過半——「不做決定性的外白」做得到的唯一方式就是不外白。
 *   - `redVouchConsistent`（K8、S2）：紅方持湖者 (1) 自己派的隊照自己的宣告——第 4 回合的 `redCleanLook`（派藍方看起來最乾淨的隊）
 *     是在 `evilVouchFollowUp` 的派隊約束之後換隊，換掉了自己宣藍的人；(2) 在隊上、隊上有自己宣紅的人 → 反對
 *     （非強制、紅方未滿兩紅；紅方已兩紅時自己一張失敗就三紅，宣告已經沒有意義）。隊外的那一半早就是 `evilVouchVoteRule`。
 *
 *
 * 開關（預設關，走勝率協定）：
 *   - `redMatchPointApprove`（L7、G1；稽核 (q)）：紅方已兩紅、自己在非強制的隊上、自己＋看得到的隊友就夠讓這隊失敗 → 投白（wiki-11「紅方在車上內黑 = 放棄一次出失敗」）。
 *     稽核：莫德雷德 13.1%、奧伯倫 9.2%，刺客／莫甘娜 0%；真人紅方 17.3%（這隊反正會過時內黑沒有代價）——不是純粹的矛盾，所以是開關。1 = 一律；2 = 50%。
 *   - `oberonBiteReject`（E3）：奧伯倫出過失敗任務後第 3 局起「贊成」一律加 1.5（`RoleStrategy.biasForOberon`，舊的「出過失敗就無限開白」），
 *     被鐵咬（這隊保留那次失敗任務的 |隊伍| − 失敗張數 人、拿掉的人裡有他，他不是隊長、不在隊上）也投白：稽核 71–76%，真人奧伯倫 22.7%、
 *     紅方 18.5%（失敗之後的下一局 7.4%、更後面 42.4%）。1 = 被鐵咬一律反對；2 = 只有失敗任務的下一局反對（更後面照舊）；3 = 1 的 50%（第 1C 節）。
 *   - `redLeadConsistent`（S5、稽核 (b)）：紅方隊長的照派加分（`TeamReuse`）不拿這一局「自己在隊上、投了黑」的被否決隊當參考
 *     （藍方第 24 回合 `goodLeadConsistent` 的紅方版；稽核紅方 55%、奧伯倫 90%，真人 4.2%）。
 *   - `redReuseExact`（第 24 回合 `goodReuseExact` 的紅方版；真人紅方隊長多半這樣做）：上一局任務成功、沒有失敗牌、這一局還沒有人派過那一隊，
 *     紅方隊長不在那一隊上：1 = 人數相同照原樣派、多一人派那一隊＋自己；2 = 只有多一人時（自己一定在隊上）；3 = 1 的 50%（第 1C 節）。藍方已兩藍時不適用
 *     （紅方隊長不派自己視角沒有紅的隊）；仍守住自己的湖宣告。照原樣派、自己不在隊上的那一手，隊長自己投白是硬約束 `leaderSelfApproveOffTeam`（`GoodLeadConsistent.ts`）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { certaintyFor } from './LogicGates';
import { evilVouchFollowUpActive, evilVouchTeamConstraint, ownLakeDeclarations } from './RedLakeFollowUp';

const key = (team: readonly string[]): string => [...team].sort().join(',');

function failsRequired(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 第 1C 節的 50%：同一個局面（雜湊文字）每次一樣。 */
export function halfOf(text: string): boolean {
  return hash01(text) < 0.5;
}

/**
 * Hard constraint `oberonMatchPoint` (G3): blue has two wins, Oberon is off a non-forced team he did not propose, and in his
 * own view the team need not hold enough reds to fail — his white could only end the mission phase in blue's favour → reject.
 */
export function oberonMatchPointReject(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!tuning.oberonMatchPoint || obs.gamePhase !== 'team_vote' || obs.myRole !== 'oberon') return false;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId)) return false;
  if (obs.questResults.filter((r) => r === 'success').length < 2) return false;
  const round = obs.currentRound ?? 1;
  let min = 0;
  try {
    min = certaintyFor(obs).minReds(team);
  } catch {
    min = 0;
  }
  // Own lake: a seat Oberon saw red is red (the certainty layer reads it too; kept explicit for the no-world case).
  if (min < 0) min = 0;
  const lakeRed = (obs.myLakeResults ?? []).filter((l) => l.result === 'evil' && team.includes(l.targetId)).length;
  return Math.max(min, lakeRed) < failsRequired(obs, round);
}

/**
 * The failed missions whose kept part this team is (it keeps exactly |team| − fail cards of that mission's members) with
 * `seat` among the dropped members — 鐵咬 in the wiki's sense (wiki-204). Public record only.
 */
export function bitingQuests(obs: PlayerObservation, team: readonly string[], seat: string): PlayerObservation['questHistory'] {
  const set = new Set(team);
  return obs.questHistory.filter((q) => (q.failCount ?? 0) >= 1 && q.team.includes(seat) && !set.has(seat)
    && q.team.filter((id) => set.has(id)).length === q.team.length - q.failCount);
}

/** Knob `oberonBiteReject` (E3): the bitten Oberon (off the team, not the leader, non-forced) rejects the biting team. */
export function oberonBiteRejectNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.oberonBiteReject ?? 0;
  if (mode <= 0 || obs.gamePhase !== 'team_vote' || obs.myRole !== 'oberon') return false;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const round = obs.currentRound ?? 1;
  const bites = bitingQuests(obs, team, me);
  if (bites.length === 0) return false;
  if (mode === 2 && !bites.some((q) => q.round === round - 1)) return false;
  if (mode === 3 && hash01(`${me}|${round}|${obs.failCount ?? 0}|${key(team)}|oberonbite`) >= 0.5) return false;
  return true;
}

/**
 * Hard constraint `redVouchConsistent` (K8), vote side: a red lake holder on a non-forced team (not the leader) that holds a
 * seat it declared red rejects it — outside red's match point (two fails: its own fail card ends the game).
 */
export function redVouchOnTeamReject(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!tuning.redVouchConsistent || !evilVouchFollowUpActive(tuning) || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId)) return false;
  if (obs.questResults.filter((r) => r === 'fail').length >= 2) return false;
  return ownLakeDeclarations(obs).red.some((id) => team.includes(id));
}

/** Whether `team` keeps this red leader's own lake word (declared blue on, declared red off). */
export function keepsRedVouch(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[]): boolean {
  if (!evilVouchFollowUpActive(tuning)) return true;
  const c = evilVouchTeamConstraint(obs);
  if (!c) return true;
  const size = team.length;
  // The proposal can only hold `size − 1` declared-blue seats besides the leader (`ForwardAgent`'s fixedMembers rule).
  const required = c.required.filter((id) => id !== obs.myPlayerId).slice(0, Math.max(0, size - 1));
  return required.every((id) => team.includes(id)) && !c.banned.some((id) => team.includes(id));
}

/**
 * Hard constraint `redVouchConsistent` (S2), pick side: a red leader's post-pipeline swap (`redCleanLook`) keeps its lake word —
 * when the swapped team breaks it and the pipeline's own team keeps it, the pipeline's team stays.
 */
export function redVouchKeptTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, before: AgentAction, after: AgentAction): AgentAction {
  if (!tuning.redVouchConsistent || obs.myTeam !== 'evil' || after === before) return after;
  if (after.type !== 'team_select' || before.type !== 'team_select') return after;
  if (keepsRedVouch(tuning, obs, after.teamIds) || !keepsRedVouch(tuning, obs, before.teamIds)) return after;
  return before;
}

/** Knob `redReuseExact`: the red leader re-proposes the last successful mission team as it was (or grown by one with itself). */
export function redReuseExactTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction): AgentAction {
  const mode = tuning.redReuseExact ?? 0;
  if (mode <= 0 || action.type !== 'team_select' || obs.myTeam !== 'evil') return action;
  if ((obs.failCount ?? 0) >= 4) return action;
  const round = obs.currentRound ?? 1;
  if (round < 2) return action;
  if (obs.questResults.filter((r) => r === 'success').length >= 2) return action;
  const last = obs.questHistory.find((q) => q.round === round - 1);
  if (!last || obs.questResults[round - 2] !== 'success' || (last.failCount ?? 0) > 0) return action;
  const me = obs.myPlayerId;
  if (last.team.includes(me)) return action;
  const size = action.teamIds.length;
  let team: string[] | null = null;
  if (mode === 3 && !halfOf(`${me}|${round}|${obs.failCount ?? 0}|redreuseexact`)) return action;
  if ((mode === 1 || mode === 3) && last.team.length === size) team = [...last.team];
  else if (last.team.length + 1 === size) team = [me, ...last.team];
  if (!team) return action;
  const k = key(team);
  if (obs.voteHistory.some((v) => v.round === round && key(v.team) === k)) return action;
  if (key(action.teamIds) === k || !keepsRedVouch(tuning, obs, team)) return action;
  return { type: 'team_select', teamIds: team };
}

/**
 * Knob `redMatchPointApprove` (L7 / G1, audit (q)): red has two fails and this red sits on a non-forced team whose reds
 * it knows (itself and the teammates it sees) can fail it on their own → white (the team passing ends the game for red).
 */
export function redMatchPointApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.redMatchPointApprove ?? 0;
  if (mode <= 0 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  const team = obs.proposedTeam ?? [];
  const me = obs.myPlayerId;
  if (mode === 2 && !halfOf(`${me}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|${key(team)}|redmatchpoint`)) return false;
  if (!team.includes(me)) return false;
  if (obs.questResults.filter((r) => r === 'fail').length < 2) return false;
  const known = new Set([me, ...obs.knownEvils]);
  return team.filter((id) => known.has(id)).length >= failsRequired(obs, obs.currentRound ?? 1);
}
