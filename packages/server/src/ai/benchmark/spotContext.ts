/**
 * 決策點的局面欄位（站長 2026-11-25：把指定玩家的決策點和百科AI 的選擇分情境比較）。純函式，只讀 `ReplayGame`。
 *
 * `scripts/playerAgreement.ts --dump-spots` 把這些欄位附在每一個決策點上，方便在 repo 外做分情境的統計
 * （哪一局、比數、隊伍的組成、湖中的對象是哪一種人……）。欄位分兩種：
 *   公開紀錄   當時桌上每個人都看得到的（出過失敗任務、上一隊、湖中宣告……）
 *   事後真相   牌譜的角色（隊上有幾個紅方、隊長是不是紅方、湖中的對象是不是紅方）——只用來事後比誰比較準，機器人決策時看不到
 * 座位一律 1..10（10 = 0家）。
 */
import { campOf, type ReplayGame, type ReplayProposal } from './sheetsReplay';
import { validLakeTargetSeats } from './replayObservation';

const isRed = (game: ReplayGame, seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';

/** 一次提議當下的公開局面。 */
export interface ProposalFrame {
  round: number;
  attempt: number;
  forced: boolean;
  leaderSeat: number;
  size: number;
  /** 這一局之前藍方／紅方拿下的任務數。 */
  blueWins: number;
  redWins: number;
  /** 出過失敗任務的座位。 */
  failedSeats: number[];
  /** 最近一次成功任務的隊伍（沒有 = null）；`lastMissionSucceeded` = 上一個任務就是成功的。 */
  lastSuccessTeam: number[] | null;
  lastMissionSucceeded: boolean;
  /** 湖中公開宣告是藍／紅的座位。 */
  lakeGoodSeats: number[];
  lakeEvilSeats: number[];
  /** 上一次提議的隊長與隊伍（整局的第一次提議 = null）；`prevSameRound` = 同一局裡被否決的上一隊。 */
  prevLeaderSeat: number | null;
  prevTeam: number[] | null;
  prevSameRound: boolean;
}

export function proposalFrame(game: ReplayGame, proposalIndex: number): ProposalFrame {
  const p = game.proposals[proposalIndex];
  const before = game.quests.filter((q) => q.round < p.round);
  const failedSeats = new Set<number>();
  for (const q of before) if (q.failed) for (const s of q.teamSeats) failedSeats.add(s);
  const successes = before.filter((q) => !q.failed);
  const lakes = game.lakes.filter((l) => l.round < p.round);
  const prev: ReplayProposal | undefined = proposalIndex > 0 ? game.proposals[proposalIndex - 1] : undefined;
  return {
    round: p.round,
    attempt: p.attempt,
    forced: p.forced,
    leaderSeat: p.leaderSeat,
    size: p.teamSeats.length,
    blueWins: successes.length,
    redWins: before.length - successes.length,
    failedSeats: [...failedSeats].sort((a, b) => a - b),
    lastSuccessTeam: successes.length ? [...successes[successes.length - 1].teamSeats] : null,
    lastMissionSucceeded: before.length > 0 && !before[before.length - 1].failed,
    lakeGoodSeats: lakes.filter((l) => l.claim === 'good').map((l) => l.targetSeat),
    lakeEvilSeats: lakes.filter((l) => l.claim === 'evil').map((l) => l.targetSeat),
    prevLeaderSeat: prev ? prev.leaderSeat : null,
    prevTeam: prev ? [...prev.teamSeats] : null,
    prevSameRound: !!prev && prev.round === p.round,
  };
}

/** 一支隊伍（玩家派的或機器人派的）在那個局面的特徵；「別人」= 不算 `selfSeat`。 */
export interface TeamFeatures {
  hasSelf: boolean;
  /** 隊上出過失敗任務的別人。 */
  failedOthers: number;
  /** 最近一次成功任務的隊伍全部留在隊上（沒有成功任務 = null）。 */
  keepsLastSuccess: boolean | null;
  /** 隊上被湖中宣告是藍／紅的別人。 */
  lakeGoodOthers: number;
  lakeEvilOthers: number;
  /** 帶上一次提議的隊長（沒有上一次提議、或上一位隊長就是自己 = null）。 */
  hasPrevLeader: boolean | null;
  /** 和上一次提議的隊伍重疊幾人（沒有 = null）。 */
  overlapPrev: number | null;
  /** 事後真相：隊上的紅方人數。 */
  reds: number;
}

export function teamFeatures(game: ReplayGame, frame: ProposalFrame, team: readonly number[], selfSeat: number): TeamFeatures {
  const set = new Set(team);
  const others = team.filter((s) => s !== selfSeat);
  const count = (xs: readonly number[]): number => others.filter((s) => xs.includes(s)).length;
  return {
    hasSelf: set.has(selfSeat),
    failedOthers: count(frame.failedSeats),
    keepsLastSuccess: frame.lastSuccessTeam ? frame.lastSuccessTeam.every((s) => set.has(s)) : null,
    lakeGoodOthers: count(frame.lakeGoodSeats),
    lakeEvilOthers: count(frame.lakeEvilSeats),
    hasPrevLeader: frame.prevLeaderSeat === null || frame.prevLeaderSeat === selfSeat ? null : set.has(frame.prevLeaderSeat),
    overlapPrev: frame.prevTeam ? frame.prevTeam.filter((s) => set.has(s)).length : null,
    reds: team.filter((s) => isRed(game, s)).length,
  };
}

/** 投票的決策點：`seat` 對這次提議投票時的局面。 */
export interface VoteContext {
  frame: ProposalFrame;
  onTeam: boolean;
  isLeader: boolean;
  /** 提議的隊伍（公開）與它的特徵（別人 = 不算投票的人）。 */
  team: number[];
  features: TeamFeatures;
  /** 事後真相：隊長是紅方。 */
  leaderRed: boolean;
  /** 這次提議有沒有過、過了以後任務有沒有失敗（沒過 = null）。 */
  approved: boolean;
  missionFailed: boolean | null;
}

export function voteContext(game: ReplayGame, proposalIndex: number, seat: number): VoteContext {
  const p = game.proposals[proposalIndex];
  const frame = proposalFrame(game, proposalIndex);
  const quest = p.wentOnMission ? game.quests.find((q) => q.round === p.round) : undefined;
  return {
    frame,
    onTeam: p.teamSeats.includes(seat),
    isLeader: p.leaderSeat === seat,
    team: [...p.teamSeats].sort((a, b) => a - b),
    features: teamFeatures(game, frame, p.teamSeats, seat),
    leaderRed: isRed(game, p.leaderSeat),
    approved: p.wentOnMission,
    missionFailed: quest ? quest.failed : null,
  };
}

/** 派隊的決策點：隊長的局面＋玩家的隊伍與機器人的隊伍各自的特徵。 */
export interface TeamContext {
  frame: ProposalFrame;
  human: TeamFeatures;
  agent: TeamFeatures;
  /** 玩家的隊伍裡機器人沒選的人數（兩隊人數相同時 = 差幾個座位）。 */
  seatsDiffer: number;
}

export function teamContext(game: ReplayGame, proposalIndex: number, agentTeam: readonly number[]): TeamContext {
  const p = game.proposals[proposalIndex];
  const frame = proposalFrame(game, proposalIndex);
  const a = new Set(agentTeam);
  return {
    frame,
    human: teamFeatures(game, frame, p.teamSeats, p.leaderSeat),
    agent: teamFeatures(game, frame, agentTeam, p.leaderSeat),
    seatsDiffer: p.teamSeats.filter((s) => !a.has(s)).length,
  };
}

/** 湖中對象的種類（公開紀錄）。 */
export interface LakeTargetFeatures {
  seat: number;
  /** 出過任務的紀錄：出過失敗任務／只出過成功任務／沒出過任務。 */
  missions: 'failed' | 'successOnly' | 'none';
  /** 當過失敗任務的隊長。 */
  ledFailedMission: boolean;
  /** 持湖者自己當隊長時派過這個人。 */
  onHolderProposals: boolean;
  /** 順位：從持湖者往下數第幾家（1..9）；`ring` = 兩邊取近的（1..5）。 */
  clockwise: number;
  ring: number;
  /** 事後真相：這個人是紅方。 */
  red: boolean;
}

export function lakeTargetFeatures(game: ReplayGame, lakeIndex: number, targetSeat: number): LakeTargetFeatures {
  const lake = game.lakes[lakeIndex];
  const quests = game.quests.filter((q) => q.round <= lake.round);
  const on = quests.filter((q) => q.teamSeats.includes(targetSeat));
  const proposals = game.proposals.filter((p) => p.round <= lake.round);
  const clockwise = (targetSeat - lake.holderSeat + game.playerCount) % game.playerCount;
  return {
    seat: targetSeat,
    missions: on.some((q) => q.failed) ? 'failed' : on.length ? 'successOnly' : 'none',
    ledFailedMission: quests.some((q) => q.failed && proposals.some((p) => p.round === q.round && p.wentOnMission && p.leaderSeat === targetSeat)),
    onHolderProposals: proposals.some((p) => p.leaderSeat === lake.holderSeat && p.teamSeats.includes(targetSeat)),
    clockwise,
    ring: Math.min(clockwise, game.playerCount - clockwise),
    red: isRed(game, targetSeat),
  };
}

/** 湖中的決策點：第幾次湖中、當時比數、可以驗的人，玩家的對象與機器人的對象各自的種類。 */
export interface LakeContext {
  /** 第幾局任務之後用湖（2／3／4）。 */
  afterRound: number;
  blueWins: number;
  redWins: number;
  /** 可以驗的座位，以及其中的紅方人數（事後真相：亂驗會驗到紅的機率 = validReds / valid.length）。 */
  valid: number[];
  validReds: number;
  /** 可以驗的座位裡，出過失敗任務／只出過成功任務／沒出過任務的各有幾個（亂驗會驗到哪一種的基準）。 */
  validMissions: Record<LakeTargetFeatures['missions'], number>;
  human: LakeTargetFeatures;
  agent: LakeTargetFeatures | null;
}

export function lakeContext(game: ReplayGame, lakeIndex: number, agentTarget: number | null): LakeContext {
  const lake = game.lakes[lakeIndex];
  const quests = game.quests.filter((q) => q.round <= lake.round);
  const valid = validLakeTargetSeats(game, lakeIndex);
  const validMissions: LakeContext['validMissions'] = { failed: 0, successOnly: 0, none: 0 };
  for (const s of valid) validMissions[lakeTargetFeatures(game, lakeIndex, s).missions] += 1;
  return {
    afterRound: lake.round,
    blueWins: quests.filter((q) => !q.failed).length,
    redWins: quests.filter((q) => q.failed).length,
    valid,
    validReds: valid.filter((s) => isRed(game, s)).length,
    validMissions,
    human: lakeTargetFeatures(game, lakeIndex, lake.targetSeat),
    agent: agentTarget ? lakeTargetFeatures(game, lakeIndex, agentTarget) : null,
  };
}

/** 一個決策點（type／round／attempt／座位／機器人的選擇）→ 局面欄位；出任務、湖中宣告、刺殺不附（null）。 */
export function spotContext(
  game: ReplayGame,
  spot: { type: string; seat: number; round: number; attempt?: number; agent: string },
): TeamContext | VoteContext | LakeContext | null {
  if (spot.type === 'team' || spot.type === 'vote') {
    const idx = game.proposals.findIndex((p) => p.round === spot.round && p.attempt === spot.attempt);
    if (idx < 0) return null;
    return spot.type === 'team'
      ? teamContext(game, idx, spot.agent.split(',').filter(Boolean).map(Number))
      : voteContext(game, idx, spot.seat);
  }
  if (spot.type === 'lakeTarget') {
    const li = game.lakes.findIndex((l) => l.round === spot.round);
    if (li < 0) return null;
    const t = Number(spot.agent);
    return lakeContext(game, li, Number.isInteger(t) && t >= 1 ? t : null);
  }
  return null;
}
