import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import type { Role, VoteRecord } from '@avalon/shared';
import { GameEngine } from '../game/GameEngine';
import { RoomManager } from '../game/RoomManager';
import { HeuristicAgent } from './HeuristicAgent';
import { SelfPlayEngine } from './SelfPlayEngine';
import type { AvalonAgent, PlayerObservation } from './types';

/**
 * Edward 2026-04-24 batch 8 — R1-R2 zero-anomaly invariant.
 *
 * Verbatim:「R1~R2 是不能有異常票的」(22:38).
 *
 * Batch 2 installed the good-faction R1-R2 guard; batch 4 promoted it
 * cross-faction (evil also suppressed). Batch 7 wired Oberon's strategy.
 * Batch 8 asserts the invariant holds over a 100-game self-play sample:
 *   - Every R1-R2 vote record must be zero-anomaly:
 *       * On-team players approve (no inner-black rejects)
 *       * Off-team players reject (no outer-white approves)
 *
 * Rationale: this is the single "uncommon distraction" signal Edward
 * pointed to — a single outer-white or inner-black in R1-R2 poisons
 * suspicion-model training data. By asserting 0/0 across 100 games
 * × 10 players × up-to-5 attempts/round × 2 rounds, we catch any
 * residual branch that leaks anomalies.
 */

interface AnomalyReport {
  gameIdx: number;
  roomId:  string;
  round:   number;
  attempt: number;
  leader:  string;
  team:    string[];
  innerBlacks: string[];
  outerWhites: string[];
}

/**
 * Run a single 10-player heuristic self-play game and return the full
 * voteHistory + roomId. Uses GameEngine + RoomManager directly so we
 * get access to the raw voteHistory after the game ends.
 */
async function runOneR1R2Game(gameIdx: number): Promise<{ roomId: string; voteHistory: VoteRecord[] }> {
  const agents: AvalonAgent[] = Array.from(
    { length: 10 },
    (_, i) => new HeuristicAgent(`H-${String(i + 1).padStart(2, '0')}`, 'hard'),
  );

  const roomManager = new RoomManager();
  const roomId = `AI-${uuidv4().slice(0, 8).toUpperCase()}`;
  const hostId = agents[0].agentId;
  const room = roomManager.createRoom(roomId, `AI-${hostId}`, hostId);
  for (const a of agents.slice(1)) {
    room.players[a.agentId] = {
      id: a.agentId,
      name: a.agentId,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    };
  }
  room.roleOptions = {
    ...(room.roleOptions ?? { percival: true, morgana: true, oberon: true, mordred: true }),
    ladyOfTheLake: true,
    ladyStart: 'seat0',
  };

  const engine = new GameEngine(room);
  engine.startGame();

  const lakePicker = new SelfPlayEngine();

  const roleMap = new Map<string, Role>();
  const teamMap = new Map<string, 'good' | 'evil'>();
  for (const [pid, p] of Object.entries(room.players)) {
    if (p.role) roleMap.set(pid, p.role);
    if (p.team) teamMap.set(pid, p.team as 'good' | 'evil');
  }

  const voteHistory: VoteRecord[] = [];
  const questHistory = room.questHistory;

  for (const a of agents) a.onGameStart(buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory));

  let safety = 0;
  while (room.state !== 'ended' && safety < 500) {
    safety++;
    if (room.state === 'voting' && room.questTeam.length === 0) {
      const leaderId = engine.getCurrentLeaderId();
      const leader = agents.find(a => a.agentId === leaderId)!;
      const obs = buildObs(leader.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      const action = leader.act({ ...obs, gamePhase: 'team_select' });
      if (action.type !== 'team_select') throw new Error('Expected team_select');
      engine.selectQuestTeam(action.teamIds);

      // Forced-mission jump support (batch 8).
      if ((room.state as string) === 'quest') {
        const latest = room.voteHistory[room.voteHistory.length - 1];
        if (latest) voteHistory.push(latest);
      }
      continue;
    }
    if (room.state === 'voting' && room.questTeam.length > 0) {
      const votes: Record<string, boolean> = {};
      for (const a of agents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'team_vote' });
        if (action.type !== 'team_vote') throw new Error('Expected team_vote');
        votes[a.agentId] = action.vote;
      }
      for (const [pid, v] of Object.entries(votes)) {
        engine.submitVote(pid, v);
        if ((room.state as string) !== 'voting') break;
      }
      const latest = room.voteHistory[room.voteHistory.length - 1];
      if (latest) voteHistory.push(latest);
      continue;
    }
    if (room.state === 'quest') {
      const teamAgents = agents.filter(a => room.questTeam.includes(a.agentId));
      for (const a of teamAgents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'quest_vote' });
        if (action.type !== 'quest_vote') throw new Error('Expected quest_vote');
        engine.submitQuestVote(a.agentId, action.vote);
        if ((room.state as string) !== 'quest') break;
      }
      continue;
    }
    if (room.state === 'lady_of_the_lake') {
      const holderId = room.ladyOfTheLakeHolder!;
      const used = new Set(room.ladyOfTheLakeUsed ?? []);
      const validTargets = Object.keys(room.players).filter(id => id !== holderId && !used.has(id));
      if (validTargets.length > 0) {
        const obs = buildObs(holderId, room, roleMap, teamMap, voteHistory, questHistory);
        const holderTeam = teamMap.get(holderId);
        const targetId = lakePicker.pickLadyTarget(holderTeam, obs, validTargets);
        engine.submitLadyOfTheLakeTarget(holderId, targetId);
        const actualTeam = teamMap.get(targetId);
        const claim = lakePicker.decideLakeAnnouncement(holderTeam, targetId, obs, actualTeam);
        if (claim !== null) {
          try { engine.declareLakeResult(holderId, claim); } catch { /* best-effort */ }
        }
        engine.completeLadyPhase();
      } else {
        engine.completeLadyPhase();
      }
      continue;
    }
    if (room.state === 'discussion') {
      const assassin = agents.find(a => roleMap.get(a.agentId) === 'assassin');
      if (!assassin) break;
      const obs = buildObs(assassin.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      const action = assassin.act({ ...obs, gamePhase: 'assassination' });
      if (action.type !== 'assassinate') throw new Error('Expected assassinate');
      engine.submitAssassination(assassin.agentId, action.targetId);
      break;
    }
  }

  void gameIdx;
  const fullVoteHistory = [...room.voteHistory];
  roomManager.deleteRoom(roomId);
  roomManager.destroy();
  return { roomId, voteHistory: fullVoteHistory };
}

function buildObs(
  playerId: string,
  room: ReturnType<RoomManager['createRoom']>,
  roleMap: Map<string, Role>,
  teamMap: Map<string, 'good' | 'evil'>,
  voteHistory: VoteRecord[],
  questHistory: typeof room.questHistory,
): PlayerObservation {
  const myRole = roleMap.get(playerId) ?? 'loyal';
  const myTeam = teamMap.get(playerId) ?? 'good';
  const playerIds = Object.keys(room.players);
  const currentLeader = playerIds[room.leaderIndex % playerIds.length];
  const knownEvils = getKnownEvils(playerId, myRole, roleMap, teamMap);
  const knownWizards = myRole === 'percival'
    ? Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== playerId)
        .map(([id]) => id)
    : undefined;

  let gamePhase: PlayerObservation['gamePhase'] = 'team_select';
  if (room.state === 'discussion') gamePhase = 'assassination';
  else if (room.state === 'quest') gamePhase = 'quest_vote';
  else if (room.questTeam.length > 0) gamePhase = 'team_vote';

  const allEvilIds = myRole === 'assassin' && gamePhase === 'assassination'
    ? Array.from(teamMap.entries()).filter(([, t]) => t === 'evil').map(([id]) => id)
    : undefined;

  return {
    myPlayerId: playerId,
    myRole,
    myTeam,
    playerCount: playerIds.length,
    allPlayerIds: playerIds,
    knownEvils,
    knownWizards,
    allEvilIds,
    currentRound: room.currentRound,
    currentLeader,
    failCount: room.failCount,
    questResults: room.questResults.filter((r): r is 'success' | 'fail' => r !== 'pending'),
    gamePhase,
    voteHistory: [...voteHistory],
    questHistory: [...questHistory],
    proposedTeam: [...room.questTeam],
  };
}

function getKnownEvils(
  pid: string,
  role: Role,
  roleMap: Map<string, Role>,
  teamMap: Map<string, 'good' | 'evil'>,
): string[] {
  switch (role) {
    case 'merlin':
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && id !== pid && roleMap.get(id) !== 'oberon' && roleMap.get(id) !== 'mordred')
        .map(([id]) => id);
    case 'percival':
      return Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== pid)
        .map(([id]) => id);
    case 'assassin':
    case 'morgana':
    case 'mordred':
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && roleMap.get(id) !== 'oberon' && id !== pid)
        .map(([id]) => id);
    default:
      return [];
  }
}

describe('HeuristicAgent · batch 8 R1-R2 zero-anomaly assertion (100 games)', () => {
  it('0 anomalies across 100 heuristic self-play games in R1 and R2', async () => {
    const GAMES = 100;
    const anomalies: AnomalyReport[] = [];

    for (let g = 0; g < GAMES; g++) {
      const { roomId, voteHistory } = await runOneR1R2Game(g);
      for (const v of voteHistory) {
        if (v.round > 2) continue;
        // Skip forced missions (5th proposal). Edward batch 8:
        // 「強制局也不用投票」— the engine synthesises a unanimous-approve
        // record for these; off-team approves there are FORCED, not
        // agent-driven anomalies. Same invariant already codified in
        // selfplay_10p_1game.ts TSV renderer (attempt < 5 gate).
        if (v.attempt >= 5) continue;
        const teamSet = new Set(v.team);
        const innerBlacks: string[] = [];
        const outerWhites: string[] = [];
        for (const [pid, approved] of Object.entries(v.votes)) {
          if (teamSet.has(pid) && approved === false) innerBlacks.push(pid);
          if (!teamSet.has(pid) && approved === true) outerWhites.push(pid);
        }
        if (innerBlacks.length > 0 || outerWhites.length > 0) {
          anomalies.push({
            gameIdx: g,
            roomId,
            round: v.round,
            attempt: v.attempt,
            leader: v.leader,
            team: [...v.team],
            innerBlacks,
            outerWhites,
          });
        }
      }
    }

    if (anomalies.length > 0) {
      const preview = anomalies.slice(0, 5).map(a =>
        `game#${a.gameIdx} room=${a.roomId} R${a.round}-P${a.attempt} ` +
        `leader=${a.leader} team=[${a.team.join(',')}] ` +
        `inner-black=[${a.innerBlacks.join(',')}] ` +
        `outer-white=[${a.outerWhites.join(',')}]`
      ).join('\n');
      throw new Error(
        `R1-R2 anomaly invariant violated: ${anomalies.length} anomaly vote(s) across ${GAMES} games.\n` +
        `First 5:\n${preview}`,
      );
    }

    expect(anomalies.length).toBe(0);
  }, 180_000);
});
