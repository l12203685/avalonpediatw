/**
 * 第 54 回合（網站玩家回報＋站長 11/19「這種 bug 蠻嚴重的」）：梅林當隊長時把自己看得到的紅放上隊、大家一起照派失敗過的「3+1」。
 * 描述一支隊在某次提議當下的公開／梅林視角特徵（不看隊長以外的身分，真相另外算）。純函式，真人局重播與自我對打紀錄共用。
 *
 * 用語：
 *   - 看得到的紅：梅林看得到的紅方（紅方除了莫德雷德；奧伯倫梅林看得到）。
 *   - 成功隊 S、失敗隊 F：這次提議之前的任務隊。
 *   - 失敗過的照派（contaminated）：有一個成功隊 S 和一個之後的失敗隊 F，S 整隊在 F 裡（第 1 局 457 成功、第 2 局 4570 失敗）。
 */

export interface KnownRedQuest {
  round: number;
  teamSeats: readonly number[];
  failed: boolean;
}

export interface KnownRedFeatures {
  /** 隊上梅林看得到的紅的人數。 */
  seenOn: number;
  /** 隊上有梅林看得到的紅、而且他出過之前失敗的任務。 */
  seenFailedOn: boolean;
  /** 隊上有梅林看得到的紅、而且他在一個「之後失敗的任務整隊包含它」的成功隊上（失敗過的照派帶進來的紅）。 */
  seenContaminatedOn: boolean;
  /** 隊伍整隊包含之前某一個成功的任務隊。 */
  reuseAny: boolean;
  /** 隊伍整隊包含之前「最近一次」成功的任務隊。 */
  reuseLast: boolean;
  /** 隊伍整隊包含一個失敗過的照派的成功隊 S（S ⊆ 之後的失敗隊 F）。 */
  reuseContaminated: boolean;
  /** 隊伍包含上一次失敗任務的人數（沒有失敗任務 = null）。 */
  lastFailOverlap: number | null;
  /** 上一次失敗任務的人數（沒有 = null）。 */
  lastFailSize: number | null;
}

const subset = (a: readonly number[], b: readonly number[]): boolean => a.every((x) => b.includes(x));

/** 失敗過的照派的成功隊（S ⊆ 之後的失敗隊 F）；`quests` 是這次提議之前的任務。 */
export function contaminatedSuccessTeams(quests: readonly KnownRedQuest[]): (readonly number[])[] {
  return quests.filter((s) => !s.failed && quests.some((f) => f.failed && f.round > s.round && subset(s.teamSeats, f.teamSeats))).map((s) => s.teamSeats);
}

/**
 * `team` 在一次提議的特徵。`quests` = 這次提議之前的任務（照回合）；`seen` = 梅林看得到的紅的座位
 * （隊長不是梅林時也可以算：量「梅林看得到的紅」在別人的隊上的比例）。
 */
export function knownRedFeatures(team: readonly number[], quests: readonly KnownRedQuest[], seen: ReadonlySet<number>): KnownRedFeatures {
  const succ = quests.filter((q) => !q.failed);
  const fails = quests.filter((q) => q.failed);
  const lastSucc = succ.length ? succ[succ.length - 1] : null;
  const lastFail = fails.length ? fails[fails.length - 1] : null;
  const contaminated = contaminatedSuccessTeams(quests);
  const seenOnTeam = team.filter((s) => seen.has(s));
  return {
    seenOn: seenOnTeam.length,
    seenFailedOn: seenOnTeam.some((s) => fails.some((f) => f.teamSeats.includes(s))),
    seenContaminatedOn: seenOnTeam.some((s) => contaminated.some((c) => c.includes(s))),
    reuseAny: succ.some((q) => subset(q.teamSeats, team)),
    reuseLast: lastSucc !== null && subset(lastSucc.teamSeats, team),
    reuseContaminated: contaminated.some((c) => subset(c, team)),
    lastFailOverlap: lastFail ? team.filter((s) => lastFail.teamSeats.includes(s)).length : null,
    lastFailSize: lastFail ? lastFail.teamSeats.length : null,
  };
}
