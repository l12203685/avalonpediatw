/**
 * 第 52 回合：第 1、2 局強制局（第 5 次提議）派的隊，用看得懂的公開特徵描述（站長 11/19「1-5 跟 2-5 的尾派」）。
 * 只用派隊當下公開的紀錄（這一局之前的提議、票、任務結果），不看身分。
 */
import type { ReplayGame } from './sheetsReplay';

export interface TailPickFeatures {
  /** 隊長在自己的隊上。 */
  self: boolean;
  /** 和這一局前面某一次提議的隊完全一樣。 */
  exactPrev: boolean;
  /** 和這一局前面的提議最多重疊幾人。 */
  maxOverlapPrev: number;
  /** 隊員（不含隊長）在這一局前面的提議被選的平均次數。 */
  meanPicked: number;
  /** 隊員（不含隊長）裡，這一局前面的提議被選 ≥ 2 次的人數。 */
  popular: number;
  /** 隊員（不含隊長）裡，這一局前面的提議一次都沒被選的人數。 */
  neverPicked: number;
  /** 隊員（不含隊長）落在「這一局被選最多的 k 人」（k = 隊員數，同分都算）的人數。 */
  topPicked: number;
  /** 隊員（不含隊長）在整局前面的提議被選的平均次數（第 2 局含第 1 局）。 */
  meanPickedGame: number;
  /** 這一局前面可信的票：隊員（不含隊長）的贊成率 − 隊外（不含隊長）的贊成率；沒有可信的票 = null。 */
  approverDiff: number | null;
  /** 隊員（不含隊長）裡，第 4 次提議投贊成的人數（第 4 次的票不可信 = null）。 */
  approvedPrev4: number | null;
  /** 隊員（不含隊長）裡，整局前面投過外白（不在隊上投贊成）的人數。 */
  flaggedOffApprove: number;
  /** 隊員（不含隊長）裡，整局前面投過內黑（在隊上投反對）的人數。 */
  flaggedOnReject: number;
  /** 第 2 局：隊員（不含隊長）裡有幾個第 1 局出任務的人（第 1 局 = null）。 */
  r1In: number | null;
  /** 第 2 局：隊長自己出過第 1 局的任務（第 1 局 = null）。 */
  leaderOnR1: boolean | null;
  /** 第 2 局：第 1 局出任務的隊全部在隊上（3+1）。 */
  r1All: boolean | null;
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

/** `team` 當作 `game.proposals[idx]`（第 1、2 局任何一次提議都可以）的隊時的特徵。 */
export function tailPickFeatures(game: ReplayGame, idx: number, team: readonly number[]): TailPickFeatures {
  const p = game.proposals[idx];
  const leader = p.leaderSeat;
  const earlier = game.proposals.slice(0, idx).filter((x) => x.round === p.round);
  const before = game.proposals.slice(0, idx);
  const seats = Array.from({ length: game.playerCount }, (_, i) => i + 1);
  const mates = team.filter((s) => s !== leader);
  const others = seats.filter((s) => s !== leader && !team.includes(s));
  const cnt = (list: typeof earlier, s: number): number => list.filter((x) => x.teamSeats.includes(s)).length;
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pick = new Map(seats.map((s) => [s, cnt(earlier, s)]));
  const ranked = seats.filter((s) => s !== leader).map((s) => pick.get(s) ?? 0).sort((a, b) => b - a);
  const kth = mates.length ? ranked[Math.min(mates.length, ranked.length) - 1] : Infinity;
  const reliable = earlier.filter((x) => !x.forced && x.votesReliable);
  const rate = (s: number): number => mean(reliable.map((x) => (x.votes[s - 1] ? 1 : 0)));
  const p4 = earlier.find((x) => x.attempt === 4);
  const offApprove = new Set<number>();
  const onReject = new Set<number>();
  for (const x of before) {
    if (x.forced || !x.votesReliable) continue;
    for (const s of seats) {
      const on = x.teamSeats.includes(s);
      if (!on && x.votes[s - 1]) offApprove.add(s);
      if (on && !x.votes[s - 1]) onReject.add(s);
    }
  }
  const r1 = p.round === 2 ? game.quests.find((q) => q.round === 1)?.teamSeats ?? null : null;
  return {
    self: team.includes(leader),
    exactPrev: earlier.some((x) => sameSet(x.teamSeats, team)),
    maxOverlapPrev: Math.max(0, ...earlier.map((x) => x.teamSeats.filter((s) => team.includes(s)).length)),
    meanPicked: mean(mates.map((s) => pick.get(s) ?? 0)),
    popular: mates.filter((s) => (pick.get(s) ?? 0) >= 2).length,
    neverPicked: mates.filter((s) => (pick.get(s) ?? 0) === 0).length,
    topPicked: mates.filter((s) => (pick.get(s) ?? 0) >= kth && (pick.get(s) ?? 0) > 0).length,
    meanPickedGame: mean(mates.map((s) => cnt(before, s))),
    approverDiff: reliable.length && mates.length && others.length ? mean(mates.map(rate)) - mean(others.map(rate)) : null,
    approvedPrev4: p4 && !p4.forced && p4.votesReliable ? mates.filter((s) => p4.votes[s - 1]).length : null,
    flaggedOffApprove: mates.filter((s) => offApprove.has(s)).length,
    flaggedOnReject: mates.filter((s) => onReject.has(s)).length,
    r1In: r1 ? mates.filter((s) => r1.includes(s)).length : null,
    leaderOnR1: r1 ? r1.includes(leader) : null,
    r1All: r1 ? r1.every((s) => team.includes(s)) : null,
  };
}
