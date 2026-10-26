/**
 * Reconstruct the `PlayerObservation` a seat had at a logged decision point
 * (agreement benchmark, 2026-10-10).
 *
 * Mirrors the production wiring in `GameServer.buildBotObservation`:
 *   - player ids `P1`..`P10` in seat order (seat-derived priors read
 *     `allPlayerIds.indexOf(id) + 1`);
 *   - Merlin sees every evil except Mordred; assassin / Morgana / Mordred
 *     see each other (not Oberon); Oberon, loyal and Percival get
 *     `knownEvils = []`; Percival gets `knownWizards = [Merlin, Morgana]`;
 *   - the assassinator (the assassin; Mordred / Morgana when no assassin is
 *     dealt) additionally gets `allEvilIds` in the assassination phase;
 *   - forced 5th proposals appear as unanimous-approve vote records (what
 *     GameEngine synthesises), other proposals carry the reconstructed votes;
 *   - `lakeHistory` holds the lakes of earlier rounds; an undeclared one
 *     carries `declaredClaim: 'none'` (S1-9c, 2026-10-14 — it used to be
 *     dropped);
 *   - `myLakeResults` holds what this seat saw with the lake (S1-9b,
 *     2026-10-14: the holder's private result; nobody else gets it);
 *   - `evilCount` = the number of reds of the game; `lobbyRoles` = the roles
 *     dealt (the public setup).
 */

import type { Role } from '@avalon/shared';
import type { PlayerObservation, QuestRecord, VoteRecord, LakePublicRecord, PrivateLakeResult } from '../types';
import { isAssassinator } from '../../game/assassinator';
import {
  campOf,
  EVIL_ROLES,
  type ReplayGame,
  type ReplayProposal,
  type ReplayQuest,
} from './sheetsReplay';

export type DecisionPoint =
  /** Leader of `proposals[proposal]` picks the team. */
  | { kind: 'team_select'; proposal: number }
  /** Everyone votes on `proposals[proposal]`. */
  | { kind: 'team_vote'; proposal: number }
  /** Mission members of `round` play their card. */
  | { kind: 'quest_vote'; round: number }
  /** Holder of `lakes[lake]` picks a target (and later declares). */
  | { kind: 'lake'; lake: number }
  | { kind: 'assassination' };

export function seatId(seat: number): string {
  return `P${seat}`;
}

export function seatOfId(id: string): number {
  return Number.parseInt(id.slice(1), 10);
}

export function allSeatIds(game: ReplayGame): string[] {
  return Array.from({ length: game.playerCount }, (_, i) => seatId(i + 1));
}

/** Role-private knowledge for `seat`, production conventions. */
export function roleKnowledge(
  game: ReplayGame,
  seat: number,
): { knownEvils: string[]; knownWizards?: string[] } {
  const role = game.seatRoles[seat - 1];
  const others = game.seatRoles
    .map((r, i) => ({ r, s: i + 1 }))
    .filter(({ s }) => s !== seat);
  if (role === 'merlin') {
    return {
      knownEvils: others.filter(({ r }) => EVIL_ROLES.has(r) && r !== 'mordred').map(({ s }) => seatId(s)),
    };
  }
  if (EVIL_ROLES.has(role) && role !== 'oberon') {
    return {
      knownEvils: others.filter(({ r }) => EVIL_ROLES.has(r) && r !== 'oberon').map(({ s }) => seatId(s)),
    };
  }
  if (role === 'percival') {
    return {
      knownEvils: [],
      knownWizards: others.filter(({ r }) => r === 'merlin' || r === 'morgana').map(({ s }) => seatId(s)),
    };
  }
  return { knownEvils: [] };
}

export function toVoteRecord(game: ReplayGame, p: ReplayProposal): VoteRecord {
  const votes: Record<string, boolean> = {};
  for (let seat = 1; seat <= game.playerCount; seat++) {
    votes[seatId(seat)] = p.forced ? true : p.votes[seat - 1];
  }
  return {
    round: p.round,
    attempt: p.attempt,
    leader: seatId(p.leaderSeat),
    team: p.teamSeats.map(seatId),
    approved: p.wentOnMission,
    votes,
  };
}

export function toQuestRecord(q: ReplayQuest): QuestRecord {
  return {
    round: q.round,
    team: q.teamSeats.map(seatId),
    result: q.failed ? 'fail' : 'success',
    failCount: q.failCount,
  };
}

/** The proposal whose team went on `round`'s mission. */
export function missionProposal(game: ReplayGame, round: number): ReplayProposal {
  const p = game.proposals.find((x) => x.round === round && x.wentOnMission);
  if (!p) throw new Error(`no mission proposal for round ${round} in game ${game.id}`);
  return p;
}

interface Cut {
  /** Proposals visible: `proposals[0 .. votesUntil)`. */
  votesUntil: number;
  /** Quests visible: rounds `< questsBefore`. */
  questsBefore: number;
  /** Lakes visible: `lakes[0 .. lakesUntil)`. */
  lakesUntil: number;
}

function cutFor(game: ReplayGame, point: DecisionPoint): Cut {
  const lakesBeforeRound = (round: number): number =>
    game.lakes.filter((l) => l.round < round).length;
  switch (point.kind) {
    case 'team_select':
    case 'team_vote': {
      const p = game.proposals[point.proposal];
      return { votesUntil: point.proposal, questsBefore: p.round, lakesUntil: lakesBeforeRound(p.round) };
    }
    case 'quest_vote': {
      const m = missionProposal(game, point.round);
      return { votesUntil: m.globalIndex + 1, questsBefore: point.round, lakesUntil: lakesBeforeRound(point.round) };
    }
    case 'lake': {
      const lake = game.lakes[point.lake];
      const m = missionProposal(game, lake.round);
      return { votesUntil: m.globalIndex + 1, questsBefore: lake.round + 1, lakesUntil: point.lake };
    }
    case 'assassination':
      return {
        votesUntil: game.proposals.length,
        questsBefore: Number.POSITIVE_INFINITY,
        lakesUntil: game.lakes.length,
      };
  }
}

/**
 * Observation for `seat` at `point`, containing only what that seat could
 * know at that moment.
 */
export function buildReplayObservation(
  game: ReplayGame,
  seat: number,
  point: DecisionPoint,
): PlayerObservation {
  const role = game.seatRoles[seat - 1];
  const cut = cutFor(game, point);
  const voteHistory = game.proposals.slice(0, cut.votesUntil).map((p) => toVoteRecord(game, p));
  const quests = game.quests.filter((q) => q.round < cut.questsBefore);
  const visibleLakes = game.lakes.slice(0, cut.lakesUntil);
  const lakeHistory: LakePublicRecord[] = visibleLakes.map((l) => ({
    round: l.round,
    holderId: seatId(l.holderSeat),
    targetId: seatId(l.targetSeat),
    declaredClaim: l.claim ?? 'none',
  }));
  const myLakeResults: PrivateLakeResult[] = visibleLakes
    .filter((l) => l.holderSeat === seat)
    .map((l) => ({
      round: l.round,
      targetId: seatId(l.targetSeat),
      result: campOf(game.seatRoles[l.targetSeat - 1]),
    }));

  let currentRound: number;
  let currentLeader: string;
  let failCount = 0;
  let proposedTeam: string[] = [];
  let gamePhase: PlayerObservation['gamePhase'];
  switch (point.kind) {
    case 'team_select':
    case 'team_vote': {
      const p = game.proposals[point.proposal];
      currentRound = p.round;
      currentLeader = seatId(p.leaderSeat);
      failCount = p.attempt - 1;
      if (point.kind === 'team_vote') proposedTeam = p.teamSeats.map(seatId);
      gamePhase = point.kind;
      break;
    }
    case 'quest_vote': {
      const m = missionProposal(game, point.round);
      currentRound = point.round;
      currentLeader = seatId(m.leaderSeat);
      proposedTeam = m.teamSeats.map(seatId);
      gamePhase = 'quest_vote';
      break;
    }
    case 'lake': {
      const lake = game.lakes[point.lake];
      currentRound = lake.round;
      currentLeader = seatId(missionProposal(game, lake.round).leaderSeat);
      gamePhase = 'team_select';
      break;
    }
    case 'assassination': {
      const last = game.proposals[game.proposals.length - 1];
      currentRound = last.round;
      currentLeader = seatId(last.leaderSeat);
      gamePhase = 'assassination';
      break;
    }
  }

  const knowledge = roleKnowledge(game, seat);
  const allEvilIds = isAssassinator(role, game.seatRoles) && point.kind === 'assassination'
    ? game.seatRoles.map((r, i) => (EVIL_ROLES.has(r) ? seatId(i + 1) : null)).filter((x): x is string => x !== null)
    : undefined;
  // 刺殺階段紅方開牌相認 (Edward 2026-10-26): each red's role too.
  const allEvilRoles = allEvilIds
    ? Object.fromEntries(game.seatRoles.flatMap((r, i) => (EVIL_ROLES.has(r) ? [[seatId(i + 1), r as Role]] : [])))
    : undefined;

  return {
    myPlayerId: seatId(seat),
    myRole: role,
    myTeam: campOf(role),
    playerCount: game.playerCount,
    allPlayerIds: allSeatIds(game),
    knownEvils: knowledge.knownEvils,
    knownWizards: knowledge.knownWizards,
    allEvilIds,
    allEvilRoles,
    currentRound,
    currentLeader,
    failCount,
    questResults: quests.map((q) => (q.failed ? 'fail' : 'success')),
    gamePhase,
    voteHistory,
    questHistory: quests.map(toQuestRecord),
    proposedTeam,
    lakeHistory,
    myLakeResults,
    evilCount: game.seatRoles.filter((r) => EVIL_ROLES.has(r)).length,
    lobbyRoles: [...game.seatRoles] as Role[],
  };
}

/**
 * Seats that could still be inspected by the holder of `lakes[lake]`:
 * not the holder, not the first holder (seat 10), not an earlier target.
 */
export function validLakeTargetSeats(game: ReplayGame, lake: number, firstHolderSeat = 10): number[] {
  const used = new Set<number>([firstHolderSeat, game.lakes[lake].holderSeat]);
  for (const l of game.lakes.slice(0, lake)) {
    used.add(l.holderSeat);
    used.add(l.targetSeat);
  }
  return Array.from({ length: game.playerCount }, (_, i) => i + 1).filter((s) => !used.has(s));
}
