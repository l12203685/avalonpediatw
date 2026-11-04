/**
 * 優化迴圈第 27 回合・紅方（2026-11-04）：機器人紅方往強者紅方收斂。
 *
 * Edward 2026-11-04：「如果機器人跟真人（而且是強的真人）一樣的話 兩者應該要類似或接近相同」——讀人的模型只有一套（擬合強者），
 * 第 26 回合量到藍方換成強者表在自我對打 −8～−13pp，主要是機器人紅方的行為不像真人（票、幾乎不藏牌）：強者表讀錯機器人紅方。
 * 這一回合把紅方的行為往強者紅方移，強者表才能同時讀對兩者。同局面比較見 `scripts/strongRedGap.ts`（紅方任務王前 5 的座位，
 * 真人局換成機器人重播；`docs/ai/optimization_loop.md` 第 27 回合）。
 *
 * 開關（預設關，走勝率協定；往真人移的開關另外回報「離強者多近、自我對打代價多少」）：
 *   - `redHideR4Solo`：第 4 局（10 人局要兩張失敗）自己是隊上唯一看得到的紅 → 出成功藏身。一張失敗讓不了任務失敗（除非奧伯倫剛好也在隊上），
 *     只會讓這一隊被讀成有紅。強者紅方：紅方兩紅（第 4 局過了是 2-2、還有第 5 局）藏 85%（n 27）；藍方兩紅（過了就進刺殺，身分已經沒用）
 *     藏 21%、出失敗賭奧伯倫。機器人一律出失敗。1 = 只在紅方兩紅時藏（任務過了遊戲還沒結束）；2 = 一律藏；3 = 1 的 50%（第 1C 節）。
 *   - `redHideHuman`：第 1、2 局自己是隊上唯一看得到的紅時，照強者紅方各角色的藏牌比例出成功（照座位、局、隊伍雜湊，同一個局面每次一樣），
 *     取代 `mordredHideR1`（莫德雷德一律藏，真人 11%）、`redHideR1`（刺客一律藏，真人 33%）與真人規則的「第 1 局落單莫甘娜出失敗」（真人 28% 藏）。
 *   - `redHumanVote`：投票照強者紅方的同局面比例（局 × 在不在隊上 × 隊上有沒有看得到的隊友 × 比分，`HUMAN_VOTE_FLIP`），在現行的票上以比例 f
 *     改投另一邊（往強者的方向；照座位、局、第幾次提議、隊伍雜湊）。改投的那一票違反紅方利益（這隊會不會失敗）時，只在估計自己那一票
 *     **不會決定結果**時才改（wiki-21「你知道開這顆白球不會讓任務出去」才開擾亂白；wiki-11 先算票）：估其他九人的票（隊長贊成、
 *     看得到的隊友照紅方利益、其他人在隊上照忠臣的後驗門檻、不在隊上反對），離過半至少差一票才算不會決定。硬約束（隊長自己的提議、
 *     奧伯倫藍方兩藍不外白、紅方持湖者言行一致）照舊。1 = 刺客／莫甘娜／莫德雷德；2 = 只有奧伯倫；3 = 全部。
 *   - `redMatchPointApprove=3`（第 25 回合開關的新模式；莫德雷德「只有那一白會決定時才贊成」）：紅方已兩紅、自己在隊上、自己知道的紅夠讓任務失敗時，
 *     只有估計自己那一白會決定結果時投白，其他時候照原本的票（真人紅方在這一格內黑 17%，多半是這隊反正會過的時候）。
 *   - `redLakeLoyal`：紅方持湖時照「坐在這個位置、只看公開紀錄的忠臣」挑湖目標（宣告照舊：隊友、看不到的紅宣好，藍方照真人比例嫁禍）。
 *     強者紅方湖隊友 17%、湖藍方 66%（出過失敗的藍方 36%、沒出過任務的 23%），機器人照 Edward 2026-10-13 的裁定「盡量湖隊友」湖隊友 75%；
 *     **這一條改的是 Edward 的裁定，只量、不採用，交給 Edward 決定**。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';

const key = (team: readonly string[]): string => [...team].sort().join(',');

function failsRequired(obs: PlayerObservation, round: number): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[round - 1] ?? 1;
}

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

const fails = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;
const wins = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'success').length;

// ── 任務牌 ─────────────────────────────────────────────────

/**
 * `redHideR4Solo`: 'success' (hide) when this red is the only red it sees on a mission that needs more fail cards than that
 * (10 players: R4 needs two); null = no opinion. Mode 1 only while the mission passing does not end the game (blue has fewer than
 * two wins — the cover still matters for R5); mode 2 always; mode 3 = mode 1 for half of the states.
 */
export function redHideR4SoloCard(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | null {
  const mode = tuning.redHideR4Solo ?? 0;
  if (mode <= 0 || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(me)) return null;
  const round = obs.currentRound ?? 1;
  const required = failsRequired(obs, round);
  if (required < 2) return null;
  const known = new Set([me, ...obs.knownEvils]);
  if (team.filter((id) => known.has(id)).length >= required) return null;
  if (mode !== 2 && wins(obs) >= 2) return null;
  if (fails(obs) >= 3 || wins(obs) >= 3) return null;
  if (mode === 3 && hash01(`${me}|${round}|${key(team)}|redhider4`) >= 0.5) return null;
  return 'success';
}

/** 強者紅方第 1、2 局隊上唯一看得到的紅時的藏牌比例（`strongRedGap.ts`，紅方任務王前 5；第 2 局分第 1 局成功／失敗）。 */
export const HUMAN_HIDE_RATE: Readonly<Record<string, readonly [number, number, number]>> = {
  // [R1, R2 after an R1 success, R2 after an R1 fail]
  assassin: [0.33, 0.14, 0],
  morgana: [0.28, 0.08, 0],
  mordred: [0.11, 0.05, 0],
  oberon: [0.45, 0.4, 0.11],
};

/**
 * `redHideHuman`: on R1–R2, when this red is the only red it sees on the mission, 'success' at the strong human red rate of its
 * role (hash of seat, round, team: the same state always gets the same card), otherwise 'fail'; null = the rule does not apply.
 */
export function redHideHumanCard(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'success' | 'fail' | null {
  if (!tuning.redHideHuman || obs.gamePhase !== 'quest_vote' || obs.myTeam !== 'evil') return null;
  const round = obs.currentRound ?? 1;
  if (round > 2) return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(me)) return null;
  if (team.some((id) => id !== me && obs.knownEvils.includes(id))) return null;
  const rates = HUMAN_HIDE_RATE[obs.myRole];
  if (!rates) return null;
  const rate = round === 1 ? rates[0] : fails(obs) === 0 ? rates[1] : rates[2];
  return hash01(`${me}|${round}|${key(team)}|redhidehuman`) < rate ? 'success' : 'fail';
}

// ── 投票 ─────────────────────────────────────────────────

/**
 * 強者紅方 vs 機器人@強者點（現行預設）的同局面贊成率換成的改投比例 f（`scripts/strongRedGap.ts` → 第 27 回合 `r27_camo_table2.py`；
 * 格子向同一局、同位置、同「有沒有隊友」的粗格收縮 K = 20）。f > 0：反對改成贊成的比例 (h − b) / (1 − b)；f < 0：贊成改成反對的比例 (b − h) / b。
 * 鍵：R（刺客／莫甘娜／莫德雷德）或 O（奧伯倫）｜局｜隊外／隊上｜有隊友／沒隊友｜其他／紅兩勝／藍兩勝。|f| < 0.02 的格子不列。
 */
export const HUMAN_VOTE_FLIP: Readonly<Record<string, number>> = {
  'R|R1|隊外|有隊友|其他': 0.02, 'R|R1|隊外|沒隊友|其他': 0.03,
  'R|R2|隊外|有隊友|其他': 0.07, 'R|R2|隊外|沒隊友|其他': 0.08, 'R|R2|隊上|有隊友|其他': -0.06, 'R|R2|隊上|沒隊友|其他': -0.06,
  'R|R3|隊外|有隊友|其他': 0.11, 'R|R3|隊外|有隊友|紅兩勝': 0.14, 'R|R3|隊外|有隊友|藍兩勝': 0.07,
  'R|R3|隊外|沒隊友|其他': 0.19, 'R|R3|隊外|沒隊友|紅兩勝': 0.1, 'R|R3|隊外|沒隊友|藍兩勝': 0.62,
  'R|R3|隊上|有隊友|其他': -0.15, 'R|R3|隊上|有隊友|紅兩勝': -0.37, 'R|R3|隊上|有隊友|藍兩勝': -0.26,
  'R|R3|隊上|沒隊友|其他': 0.59, 'R|R3|隊上|沒隊友|紅兩勝': 0.27, 'R|R3|隊上|沒隊友|藍兩勝': 0.47,
  'R|R4|隊外|有隊友|紅兩勝': 0.16, 'R|R4|隊外|有隊友|藍兩勝': 0.43, 'R|R4|隊外|沒隊友|紅兩勝': 0.28, 'R|R4|隊外|沒隊友|藍兩勝': 0.49,
  'R|R4|隊上|有隊友|紅兩勝': -0.38, 'R|R4|隊上|有隊友|藍兩勝': -0.26, 'R|R4|隊上|沒隊友|紅兩勝': 0.16, 'R|R4|隊上|沒隊友|藍兩勝': 0.08,
  'R|R5|隊外|有隊友|紅兩勝': 0.17, 'R|R5|隊外|沒隊友|紅兩勝': 0.44, 'R|R5|隊上|有隊友|紅兩勝': -0.48,
  'O|R1|隊外|沒隊友|其他': 0.04, 'O|R1|隊上|沒隊友|其他': -0.03, 'O|R2|隊外|沒隊友|其他': 0.09, 'O|R2|隊上|沒隊友|其他': -0.07,
  'O|R3|隊外|沒隊友|其他': -0.5, 'O|R3|隊外|沒隊友|紅兩勝': -0.69, 'O|R3|隊外|沒隊友|藍兩勝': 0.22,
  'O|R3|隊上|沒隊友|其他': 0.74, 'O|R3|隊上|沒隊友|紅兩勝': 0.44, 'O|R3|隊上|沒隊友|藍兩勝': 0.81,
  'O|R4|隊外|沒隊友|紅兩勝': -0.54, 'O|R4|隊外|沒隊友|藍兩勝': 0.4, 'O|R4|隊上|沒隊友|紅兩勝': 0.68, 'O|R4|隊上|沒隊友|藍兩勝': 0.3,
  'O|R5|隊外|沒隊友|紅兩勝': 0.47, 'O|R5|隊上|沒隊友|紅兩勝': -0.31,
};

/** 這一票的格子（`HUMAN_VOTE_FLIP` 的鍵）；隊長、強制局 = null。 */
export function humanVoteCell(obs: PlayerObservation): string | null {
  if (obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return null;
  if ((obs.failCount ?? 0) >= 4 || obs.currentLeader === obs.myPlayerId) return null;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const on = team.includes(me);
  const mate = team.some((id) => id !== me && obs.knownEvils.includes(id));
  const state = fails(obs) >= 2 ? '紅兩勝' : wins(obs) >= 2 ? '藍兩勝' : '其他';
  return `${obs.myRole === 'oberon' ? 'O' : 'R'}|R${obs.currentRound ?? 1}|${on ? '隊上' : '隊外'}|${mate ? '有隊友' : '沒隊友'}|${state}`;
}

/** 紅方利益：自己知道的紅（含在隊上的自己）夠讓這隊失敗 → 贊成；否則反對。 */
export function redInterestVote(obs: PlayerObservation): boolean {
  const known = new Set([obs.myPlayerId, ...obs.knownEvils]);
  const team = obs.proposedTeam ?? [];
  return team.filter((id) => known.has(id)).length >= failsRequired(obs, obs.currentRound ?? 1);
}

/**
 * 其他九人預計的贊成票數（紅方視角的估計，用來判斷自己那一票會不會決定結果）：隊長贊成（自己的提議）；看得到的隊友在隊上贊成、
 * 不在隊上照紅方利益（隊上有自己知道的紅而且紅方已兩紅才贊成）；其他人在隊上——第 1、2 局贊成，第 3 局起照忠臣視角的後驗
 * （`bayesTeamClean` ≥ `goodCleanVote`／關鍵局 `goodKeyVote`）——不在隊上反對。
 */
export function othersApprovalEstimate(tuning: Readonly<AgentTuning>, obs: PlayerObservation): number {
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  const mates = new Set(obs.knownEvils);
  const round = obs.currentRound ?? 1;
  const key3 = fails(obs) >= 2;
  const knownRedOn = team.some((id) => id === me || mates.has(id));
  const threshold = key3 ? (tuning.goodKeyVote > 0 ? tuning.goodKeyVote : 0.5) : (tuning.goodCleanVote > 0 ? tuning.goodCleanVote : 0.45);
  const opts = bayesOptionsOf(tuning);
  let a = 0;
  for (const id of obs.allPlayerIds) {
    if (id === me) continue;
    const on = team.includes(id);
    if (id === obs.currentLeader) { a++; continue; }
    if (mates.has(id)) { if (on || (knownRedOn && key3)) a++; continue; }
    if (!on) continue;
    if (round <= 2) { a++; continue; }
    const view = { ...obs, myPlayerId: id, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, myLakeResults: [] } as PlayerObservation;
    if ((bayesTeamClean(view, team, opts) ?? 0) >= threshold) a++;
  }
  return a;
}

/** 自己那一票不會決定結果（其他人的贊成數離「剛好差我一票」至少再差一票）。 */
export function voteNotDecisive(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const majority = Math.floor(obs.playerCount / 2) + 1;
  const a = othersApprovalEstimate(tuning, obs);
  return a >= majority + 1 || a <= majority - 3;
}

/** 自己那一白會決定結果（其他人的贊成數剛好差一票，含一票誤差）。 */
export function approveDecisive(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const majority = Math.floor(obs.playerCount / 2) + 1;
  const a = othersApprovalEstimate(tuning, obs);
  return a >= majority - 2 && a <= majority - 1;
}

/**
 * `redHumanVote`: the vote after the strong-human flip — `vote` itself when the cell has no flip, the hash misses, or the flipped vote
 * goes against red's interest and this red's vote may decide the outcome.
 */
export function redHumanVoteFlip(tuning: Readonly<AgentTuning>, obs: PlayerObservation, vote: boolean): boolean {
  const mode = tuning.redHumanVote ?? 0;
  if (mode <= 0) return vote;
  const isOberon = obs.myRole === 'oberon';
  if ((isOberon && (mode & 2) === 0) || (!isOberon && (mode & 1) === 0)) return vote;
  const cell = humanVoteCell(obs);
  if (cell === null) return vote;
  const f = HUMAN_VOTE_FLIP[cell] ?? 0;
  if (f === 0 || (f > 0 && vote) || (f < 0 && !vote)) return vote;
  const team = obs.proposedTeam ?? [];
  if (hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|${key(team)}|redhumanvote`) >= Math.abs(f)) return vote;
  const flipped = !vote;
  if (flipped !== redInterestVote(obs) && !voteNotDecisive(tuning, obs)) return vote;
  return flipped;
}

/**
 * `redMatchPointApprove=3`: red has two fails, this red sits on a non-forced team its known reds can fail on their own — white only when
 * its white may decide the outcome (true); false = keep the vote it would cast.
 */
export function redMatchPointDecisiveApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if ((tuning.redMatchPointApprove ?? 0) !== 3 || obs.gamePhase !== 'team_vote' || obs.myTeam !== 'evil') return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  const team = obs.proposedTeam ?? [];
  if (!team.includes(obs.myPlayerId) || fails(obs) < 2 || !redInterestVote(obs)) return false;
  return approveDecisive(tuning, obs);
}
