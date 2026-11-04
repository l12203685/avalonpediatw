/**
 * 資訊流（INFL）——研究原型的資料層（2026-11-04；docs/ai/infl_research.md）。
 *
 * Edward 的定義：每一個動作都是「到那一刻為止的整條資訊流 + 自己的私訊」的函數：
 *   INFL_{1-2} = INFL_{1-1} + team_{1-1} + votes_{1-1}；
 *   INFL_{3-1} = INFL_{2-5} + team_{2-5} + votes_{2-5}（強制、全白）+ 任務結果 + 湖的使用與宣告。
 *
 * 這裡把一局的公開紀錄存成 `Flow`（每次提議與完整票型、任務、湖的宣告），並提供「第 i 次提議當下、j 座位看得到的 INFL」：
 *   - `seatViewObs(flow, i, j, w)`：把 j 當成忠臣（沒有角色視野）的觀察，私訊只有 j 自己在世界 w 裡湖到的結果；
 *   - `lakeSig(flow, i, j, w)`：j 在第 i 次提議之前湖過的人在世界 w 裡的陣營（私訊隨世界變的部分）。
 * 世界 w = 紅方座位的位元遮罩（P1 = 1、P2 = 2、…、P10 = 512，和 `belief/Certainty` 的 bitOf 相同）。
 * 純函式，正式流程沒有讀它。
 */
import type { LakePublicRecord, PlayerObservation, PrivateLakeResult, QuestRecord, VoteRecord } from '../types';
import type { ReplayGame } from '../benchmark/sheetsReplay';
import { buildReplayObservation } from '../benchmark/replayObservation';

export interface Flow {
  ids: string[];
  /** 每一次提議（含強制的第 5 次：票是合成的全白）。 */
  votes: VoteRecord[];
  quests: QuestRecord[];
  lakes: LakePublicRecord[];
  evilCount: number;
  playerCount: number;
  /** 票型可信（非強制、票數和結果相符；只有重播的局知道）。缺 = 非強制都當可信。 */
  reliable?: boolean[];
}

export function flowOfGame(game: ReplayGame): Flow {
  const o = buildReplayObservation(game, 1, { kind: 'assassination' });
  return {
    ids: o.allPlayerIds,
    votes: o.voteHistory,
    quests: o.questHistory,
    lakes: o.lakeHistory ?? [],
    evilCount: o.evilCount ?? 4,
    playerCount: o.playerCount,
    reliable: game.proposals.map((p) => !p.forced && p.votesReliable),
  };
}

/** 從一個觀察取出它看得到的資訊流（線上用：只含到目前為止的紀錄）。 */
export function flowOfObs(obs: PlayerObservation): Flow {
  return {
    ids: obs.allPlayerIds,
    votes: obs.voteHistory,
    quests: obs.questHistory,
    lakes: obs.lakeHistory ?? [],
    evilCount: obs.evilCount ?? 4,
    playerCount: obs.playerCount,
  };
}

export function popcount(x: number): number {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

export function bitOf(flow: Flow, id: string): number {
  const k = flow.ids.indexOf(id);
  return k < 0 ? 0 : 1 << k;
}

export function maskOf(flow: Flow, ids: readonly string[]): number {
  let m = 0;
  for (const id of ids) m |= bitOf(flow, id);
  return m;
}

export function questsBefore(flow: Flow, round: number): QuestRecord[] {
  return flow.quests.filter((q) => q.round < round);
}

/** 第 `round` 局開始前已經用過的湖（第 r 局之後的湖在第 r + 1 局的提議前公開）。 */
export function lakesBefore(flow: Flow, round: number): LakePublicRecord[] {
  return flow.lakes.filter((l) => l.round < round);
}

/** j 在第 i 次提議之前湖過的人在世界 w 裡是不是紅（每個湖一個位元，依時間）。 */
export function lakeSig(flow: Flow, i: number, j: string, w: number): number {
  const round = flow.votes[i].round;
  let sig = 0;
  let k = 0;
  for (const l of flow.lakes) {
    if (l.round >= round) break;
    if (l.holderId !== j) continue;
    if ((w & bitOf(flow, l.targetId)) !== 0) sig |= 1 << k;
    k++;
  }
  return sig | (k << 8);
}

/** j 在第 i 次提議之前湖到的結果（世界 w 裡的真相）。 */
export function lakeResultsUnder(flow: Flow, i: number, j: string, w: number): PrivateLakeResult[] {
  const round = flow.votes[i].round;
  return lakesBefore(flow, round)
    .filter((l) => l.holderId === j)
    .map((l) => ({ round: l.round, targetId: l.targetId, result: (w & bitOf(flow, l.targetId)) !== 0 ? 'evil' : 'good' }));
}

/**
 * j 座位在第 i 次提議投票時看得到的 INFL，當成忠臣（沒有角色視野）：公開紀錄到第 i − 1 次提議、第 i 次的隊伍，
 * 加上 j 自己在世界 w 裡湖到的結果。紅方的 j 也用這個視角（他「該裝成」的忠臣視角）。
 */
export function seatViewObs(flow: Flow, i: number, j: string, w: number): PlayerObservation {
  const v = flow.votes[i];
  const quests = questsBefore(flow, v.round);
  return {
    myPlayerId: j,
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: flow.playerCount,
    allPlayerIds: flow.ids,
    knownEvils: [],
    currentRound: v.round,
    currentLeader: v.leader,
    failCount: v.attempt - 1,
    questResults: quests.map((q) => q.result),
    gamePhase: 'team_vote',
    voteHistory: flow.votes.slice(0, i),
    questHistory: quests,
    proposedTeam: v.team,
    lakeHistory: lakesBefore(flow, v.round),
    myLakeResults: lakeResultsUnder(flow, i, j, w),
    evilCount: flow.evilCount,
  };
}

/** 第 i 次提議的下一任隊長（第 4 次提議時 = 強制局的隊長）。 */
export function nextLeader(flow: Flow, i: number): string {
  const ids = flow.ids;
  return ids[(ids.indexOf(flow.votes[i].leader) + 1) % ids.length];
}
