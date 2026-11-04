/**
 * 異常票的分類與準度、尾家（第 5 次強制局隊長）的座位（Edward 2026-11-04；docs/ai/strong_metrics.md）。純函式。
 *
 * **異常票**：內黑 = 在隊上投反對；外白 = 不在隊上投贊成（隊長算在隊上）。其餘是正常票。強制局（第 5 次）沒有投票、不算。
 *
 * **準度**（只對藍方有「對錯」）：
 *   - 藍方外白「對」= 那隊沒有紅（贊成了一支乾淨的隊）；
 *   - 藍方內黑「對」= 那隊有紅（反對了一支有紅的隊）。
 *   基準：同一組決策點裡，那種處境（隊外／隊上）的隊伍本來就乾淨／有紅的比例（`baseClean`），準度要和基準比。
 * **紅方**（沒有對錯，只報比率）：
 *   - 外白：隊上有紅（推隊友的隊）或全藍（貼藍、裝成好人）；
 *   - 內黑：隊上有其他紅（反對有隊友的隊）或只有自己（落單反對）；
 *   - 後來有沒有被讀成紅：之後幾局（下一局起）藍方隊長派的隊有沒有選他（`laterInclusion`），和同一次提議投正常票的紅方比；
 *   - 關鍵票：改投就會翻轉結果（`pivotal`）。
 */

export type VoteKind = 'normal' | '內黑' | '外白';

export function voteKind(onTeam: boolean, approve: boolean): VoteKind {
  if (onTeam && !approve) return '內黑';
  if (!onTeam && approve) return '外白';
  return 'normal';
}

export interface VoteContext {
  onTeam: boolean;
  approve: boolean;
  voterRed: boolean;
  /** 隊上有沒有紅（真相）。 */
  teamHasRed: boolean;
  /** 隊上有沒有投票者以外的紅（真相；紅方用）。 */
  teamHasOtherRed: boolean;
}

export interface VoteJudgement {
  kind: VoteKind;
  /** 藍方異常票的對錯；紅方或正常票 = null。 */
  right: boolean | null;
  /** 紅方異常票的類型（藍方或正常票 = null）。 */
  redKind: '推隊友' | '貼藍' | '反對有隊友' | '落單反對' | null;
}

export function judgeVote(c: VoteContext): VoteJudgement {
  const kind = voteKind(c.onTeam, c.approve);
  if (kind === 'normal') return { kind, right: null, redKind: null };
  if (!c.voterRed) return { kind, right: kind === '外白' ? !c.teamHasRed : c.teamHasRed, redKind: null };
  if (kind === '外白') return { kind, right: null, redKind: c.teamHasRed ? '推隊友' : '貼藍' };
  return { kind, right: null, redKind: c.teamHasOtherRed ? '反對有隊友' : '落單反對' };
}

/** 改投這一票會不會翻轉結果（過半 = 贊成數 × 2 > 人數）。 */
export function isPivotal(approveCount: number, playerCount: number, approve: boolean): boolean {
  const passed = approveCount * 2 > playerCount;
  const flipped = (approveCount + (approve ? -1 : 1)) * 2 > playerCount;
  return passed !== flipped;
}

/**
 * 第 attempt 次提議（1..4）時，第 5 次（強制局）的隊長座位（1..n）：隊長每次往下一個座位輪，
 * 所以 = 現任隊長往後 5 − attempt 個座位。
 */
export function tailLeaderSeat(leaderSeat: number, attempt: number, playerCount = 10): number {
  return ((leaderSeat - 1 + (5 - attempt)) % playerCount) + 1;
}

/** 機率的校準格：[0, 0.1)、[0.1, 0.2) …、[0.9, 1]。 */
export function calibrationBucket(p: number, width = 0.1): number {
  const k = Math.floor(Math.min(0.999999, Math.max(0, p)) / width);
  return Math.round(k * width * 1000) / 1000;
}

export function bucketLabel(lo: number, width = 0.1): string {
  return `${lo.toFixed(1)}–${(lo + width).toFixed(1)}`;
}

/** 回合 × 次數的鍵：R3A2；角色群組：藍方細分（忠臣／派西／梅林）、紅方細分（刺客／莫甘娜／莫德雷德／奧伯倫）。 */
export function cellKey(round: number, attempt: number): string {
  return `R${round}A${attempt}`;
}
