/**
 * 決策點的局面欄位（站長 2026-11-25：把指定玩家的決策點和百科AI 的選擇分情境比較；同日擴到所有角色）。純函式，只讀 `ReplayGame`。
 *
 * `scripts/playerAgreement.ts --dump-spots` 把這些欄位附在每一個決策點上，方便在 repo 外做分情境的統計
 * （哪一局、比數、隊伍的組成、湖中的對象是哪一種人……）。欄位分兩種：
 *   公開紀錄   當時桌上每個人都看得到的（出過失敗任務、上一隊、湖中宣告……）
 *   事後真相   牌譜的角色（隊上有幾個紅方、隊長是不是紅方、湖中的對象是不是紅方）——只用來事後比誰比較準，機器人決策時看不到
 * 座位一律 1..10（10 = 0家）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import { campOf, type ReplayGame, type ReplayProposal } from './sheetsReplay';
import { roleKnowledge, seatOfId, validLakeTargetSeats } from './replayObservation';

const isRed = (game: ReplayGame, seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';

/**
 * 這個座位開局就認得的人（同 `replayObservation.roleKnowledge`，機器人拿到的也是這一份）：
 * `reds` = 認得的紅方（梅林：莫德雷德以外的紅方；刺客／莫甘娜／莫德雷德：奧伯倫以外的隊友；其他角色沒有）；
 * `thumbs` = 派西維爾看到的兩個拇指（梅林與莫甘娜，分不出誰是誰）。
 */
export function seatKnowledge(game: ReplayGame, seat: number): { reds: number[]; thumbs: number[] } {
  const k = roleKnowledge(game, seat);
  return { reds: k.knownEvils.map(seatOfId), thumbs: (k.knownWizards ?? []).map(seatOfId) };
}

function scoreAfter(game: ReplayGame, round: number): { blueWins: number; redWins: number } {
  const quests = game.quests.filter((q) => q.round <= round);
  const blueWins = quests.filter((q) => !q.failed).length;
  return { blueWins, redWins: quests.length - blueWins };
}

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
  /** 出過失敗任務的座位、出過成功任務的座位（兩種都出過的人兩邊都有）。 */
  failedSeats: number[];
  successSeats: number[];
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
    successSeats: [...new Set(successes.flatMap((q) => q.teamSeats))].sort((a, b) => a - b),
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
  /** 隊上只出過成功任務的別人。 */
  successOnlyOthers: number;
  /** 隊上自己開局就認得的紅方（梅林看到的紅方、紅方看到的隊友）／派西維爾的拇指，各有幾個。 */
  knownRedOthers: number;
  thumbOthers: number;
  /** 最近一次成功任務的隊伍全部留在隊上（沒有成功任務 = null）。 */
  keepsLastSuccess: boolean | null;
  /** 隊上被湖中宣告是藍／紅的別人。 */
  lakeGoodOthers: number;
  lakeEvilOthers: number;
  /** 帶上一次提議的隊長（沒有上一次提議、或上一位隊長就是自己 = null）。 */
  hasPrevLeader: boolean | null;
  /** 和上一次提議的隊伍重疊幾人（沒有 = null）。 */
  overlapPrev: number | null;
  /** 事後真相：隊上的紅方人數、隊上每個人的角色（照座位排）。 */
  reds: number;
  roles: string[];
}

export function teamFeatures(game: ReplayGame, frame: ProposalFrame, team: readonly number[], selfSeat: number): TeamFeatures {
  const set = new Set(team);
  const others = team.filter((s) => s !== selfSeat);
  const count = (xs: readonly number[]): number => others.filter((s) => xs.includes(s)).length;
  const known = seatKnowledge(game, selfSeat);
  return {
    hasSelf: set.has(selfSeat),
    failedOthers: count(frame.failedSeats),
    successOnlyOthers: count(frame.successSeats.filter((s) => !frame.failedSeats.includes(s))),
    knownRedOthers: count(known.reds),
    thumbOthers: count(known.thumbs),
    keepsLastSuccess: frame.lastSuccessTeam ? frame.lastSuccessTeam.every((s) => set.has(s)) : null,
    lakeGoodOthers: count(frame.lakeGoodSeats),
    lakeEvilOthers: count(frame.lakeEvilSeats),
    hasPrevLeader: frame.prevLeaderSeat === null || frame.prevLeaderSeat === selfSeat ? null : set.has(frame.prevLeaderSeat),
    overlapPrev: frame.prevTeam ? frame.prevTeam.filter((s) => set.has(s)).length : null,
    reds: team.filter((s) => isRed(game, s)).length,
    roles: [...team].sort((a, b) => a - b).map((s) => game.seatRoles[s - 1]),
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
  /** 持湖者開局就認得這個人是紅方／這個人是派西維爾（持湖者）的拇指。 */
  knownRed: boolean;
  thumb: boolean;
  /** 事後真相：這個人是紅方、這個人的角色。 */
  red: boolean;
  role: string;
}

export function lakeTargetFeatures(game: ReplayGame, lakeIndex: number, targetSeat: number): LakeTargetFeatures {
  const lake = game.lakes[lakeIndex];
  const quests = game.quests.filter((q) => q.round <= lake.round);
  const on = quests.filter((q) => q.teamSeats.includes(targetSeat));
  const proposals = game.proposals.filter((p) => p.round <= lake.round);
  const clockwise = (targetSeat - lake.holderSeat + game.playerCount) % game.playerCount;
  const known = seatKnowledge(game, lake.holderSeat);
  return {
    seat: targetSeat,
    missions: on.some((q) => q.failed) ? 'failed' : on.length ? 'successOnly' : 'none',
    ledFailedMission: quests.some((q) => q.failed && proposals.some((p) => p.round === q.round && p.wentOnMission && p.leaderSeat === targetSeat)),
    onHolderProposals: proposals.some((p) => p.leaderSeat === lake.holderSeat && p.teamSeats.includes(targetSeat)),
    clockwise,
    ring: Math.min(clockwise, game.playerCount - clockwise),
    knownRed: known.reds.includes(targetSeat),
    thumb: known.thumbs.includes(targetSeat),
    red: isRed(game, targetSeat),
    role: game.seatRoles[targetSeat - 1],
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
  /** 可以驗的座位裡，持湖者開局就認得的紅方／派西維爾的拇指各有幾個。 */
  validKnownReds: number;
  validThumbs: number;
  /** 可以驗的座位裡，出過失敗任務／只出過成功任務／沒出過任務的各有幾個（亂驗會驗到哪一種的基準）。 */
  validMissions: Record<LakeTargetFeatures['missions'], number>;
  human: LakeTargetFeatures;
  agent: LakeTargetFeatures | null;
}

export function lakeContext(game: ReplayGame, lakeIndex: number, agentTarget: number | null): LakeContext {
  const lake = game.lakes[lakeIndex];
  const valid = validLakeTargetSeats(game, lakeIndex);
  const known = seatKnowledge(game, lake.holderSeat);
  const validMissions: LakeContext['validMissions'] = { failed: 0, successOnly: 0, none: 0 };
  for (const s of valid) validMissions[lakeTargetFeatures(game, lakeIndex, s).missions] += 1;
  return {
    afterRound: lake.round,
    ...scoreAfter(game, lake.round),
    valid,
    validReds: valid.filter((s) => isRed(game, s)).length,
    validKnownReds: valid.filter((s) => known.reds.includes(s)).length,
    validThumbs: valid.filter((s) => known.thumbs.includes(s)).length,
    validMissions,
    human: lakeTargetFeatures(game, lakeIndex, lake.targetSeat),
    agent: agentTarget ? lakeTargetFeatures(game, lakeIndex, agentTarget) : null,
  };
}

/** 湖中宣告的決策點：驗到的人（玩家實際驗的那一位）與當時比數；宣告了什麼在決策點的 human／agent。 */
export interface LakeClaimContext {
  afterRound: number;
  blueWins: number;
  redWins: number;
  target: LakeTargetFeatures;
}

export function lakeClaimContext(game: ReplayGame, lakeIndex: number): LakeClaimContext {
  const lake = game.lakes[lakeIndex];
  return { afterRound: lake.round, ...scoreAfter(game, lake.round), target: lakeTargetFeatures(game, lakeIndex, lake.targetSeat) };
}

/** 任務牌的決策點（紅方在任務隊上）：第幾局、比數、隊上的紅方。 */
export interface QuestContext {
  round: number;
  /** 這一局之前藍方／紅方拿下的任務數。 */
  blueWins: number;
  redWins: number;
  size: number;
  /** 這一局要幾張失敗才算失敗（第 4 局 2 張）。 */
  failsRequired: number;
  isLeader: boolean;
  /** 隊上自己開局就認得的紅方隊友人數（奧伯倫一律 0）。 */
  knownRedOthers: number;
  /** 事後真相：隊上的紅方人數（含自己）、實際的失敗張數、任務有沒有失敗。 */
  redsOnTeam: number;
  failCount: number;
  missionFailed: boolean;
}

export function questContext(game: ReplayGame, round: number, seat: number): QuestContext | null {
  const q = game.quests.find((x) => x.round === round);
  const p = game.proposals.find((x) => x.round === round && x.wentOnMission);
  if (!q || !p) return null;
  const known = seatKnowledge(game, seat);
  return {
    round,
    ...scoreAfter(game, round - 1),
    size: q.teamSeats.length,
    failsRequired: AVALON_CONFIG[game.playerCount].questFailsRequired[round - 1],
    isLeader: p.leaderSeat === seat,
    knownRedOthers: q.teamSeats.filter((s) => s !== seat && known.reds.includes(s)).length,
    redsOnTeam: q.teamSeats.filter((s) => isRed(game, s)).length,
    failCount: q.failCount,
    missionFailed: q.failed,
  };
}

/** 刺殺對象的種類：公開紀錄＋事後真相（角色）。 */
export interface AssassinTargetFeatures {
  seat: number;
  /** 出過的任務：成功幾次、失敗幾次。 */
  successMissions: number;
  failedMissions: number;
  /** 當隊長而且隊伍出任務成功的次數。 */
  ledSuccess: number;
  /** 內黑（在隊上投反對）、外白（不在隊上投贊成）的次數（第 1～4 次提議、票數對得上結果的）。 */
  innerBlack: number;
  outerWhite: number;
  /** 持過湖；被湖中宣告成藍／紅（沒被驗過 = null）。 */
  heldLake: boolean;
  lakeClaimed: 'good' | 'evil' | 'none' | null;
  /** 事後真相：角色。 */
  role: string;
}

export function assassinTargetFeatures(game: ReplayGame, seat: number): AssassinTargetFeatures {
  const on = game.quests.filter((q) => q.teamSeats.includes(seat));
  const votes = game.proposals.filter((p) => !p.forced && p.votesReliable);
  const laked = game.lakes.find((l) => l.targetSeat === seat);
  return {
    seat,
    successMissions: on.filter((q) => !q.failed).length,
    failedMissions: on.filter((q) => q.failed).length,
    ledSuccess: game.proposals.filter((p) => p.wentOnMission && p.leaderSeat === seat && !game.quests.find((q) => q.round === p.round)?.failed).length,
    innerBlack: votes.filter((p) => p.teamSeats.includes(seat) && !p.votes[seat - 1]).length,
    outerWhite: votes.filter((p) => !p.teamSeats.includes(seat) && p.votes[seat - 1]).length,
    heldLake: game.lakes.some((l) => l.holderSeat === seat),
    lakeClaimed: laked ? laked.claim ?? 'none' : null,
    role: game.seatRoles[seat - 1],
  };
}

/** 刺殺的決策點：這一局怎麼走到三藍的，實際刺的人與機器人會刺的人。 */
export interface AssassinContext {
  /** 任務結果的順序（B 藍／R 紅），例如 "BRBB"。 */
  path: string;
  redWins: number;
  lakes: number;
  human: AssassinTargetFeatures;
  agent: AssassinTargetFeatures | null;
}

export function assassinContext(game: ReplayGame, agentTarget: number | null): AssassinContext | null {
  if (game.assassinTargetSeat === undefined) return null;
  return {
    path: game.quests.map((q) => (q.failed ? 'R' : 'B')).join(''),
    redWins: game.quests.filter((q) => q.failed).length,
    lakes: game.lakes.length,
    human: assassinTargetFeatures(game, game.assassinTargetSeat),
    agent: agentTarget ? assassinTargetFeatures(game, agentTarget) : null,
  };
}

export type SpotContext = TeamContext | VoteContext | LakeContext | LakeClaimContext | QuestContext | AssassinContext;

/** 一個決策點（type／round／attempt／座位／機器人的選擇）→ 局面欄位；對不上牌譜 = null。 */
export function spotContext(
  game: ReplayGame,
  spot: { type: string; seat: number; round: number; attempt?: number; agent: string },
): SpotContext | null {
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
  if (spot.type === 'lakeClaim') {
    const li = game.lakes.findIndex((l) => l.round === spot.round);
    return li < 0 ? null : lakeClaimContext(game, li);
  }
  if (spot.type === 'quest' || spot.type === 'questOpen') return questContext(game, spot.round, spot.seat);
  if (spot.type === 'assassinate') {
    const t = Number(spot.agent);
    return assassinContext(game, Number.isInteger(t) && t >= 1 ? t : null);
  }
  return null;
}
