/**
 * SelfPlayEngine — Runs Avalon games with AI agents
 *
 * This engine:
 * 1. Directly drives GameEngine without any Socket.IO overhead
 * 2. Builds PlayerObservation for each agent at each decision point
 * 3. Saves the complete game event log to Supabase for AI training
 *
 * Architecture for future RL:
 * - Replace RandomAgent with NeuralAgent (calls Python inference server)
 * - Add reward signals from game outcome + discovery probability
 * - Accumulate replay buffer in Supabase game_events table
 */

import { v4 as uuidv4 } from 'uuid';
import { Room, AVALON_CONFIG, Role } from '@avalon/shared';
import { GameEngine } from '../game/GameEngine';
import { RoomManager } from '../game/RoomManager';
import { saveGameEvents } from '../services/supabase';
import {
  AvalonAgent,
  PlayerObservation,
  VoteRecord,
  QuestRecord,
  SelfPlayResult,
} from './types';

export class SelfPlayEngine {
  private roomManager = new RoomManager();

  /**
   * Run a single self-play game with the provided agents.
   * @param agents  Array of agents (length must be 5–10)
   * @param persist Whether to save events to Supabase
   */
  async runGame(agents: AvalonAgent[], persist = true): Promise<SelfPlayResult> {
    const playerCount = agents.length;
    if (playerCount < 5 || playerCount > 10) {
      throw new Error(`Invalid player count: ${playerCount}`);
    }

    const roomId  = `AI-${uuidv4().slice(0, 8).toUpperCase()}`;
    const hostId  = agents[0].agentId;

    const room = this.roomManager.createRoom(roomId, `AI-${agents[0].agentId}`, hostId);

    // Add remaining agents as players
    for (const agent of agents.slice(1)) {
      room.players[agent.agentId] = {
        id:        agent.agentId,
        name:      agent.agentId,
        role:      null,
        team:      null,
        status:    'active',
        createdAt: Date.now(),
      };
    }

    const engine = new GameEngine(room);
    engine.startGame();

    // Build role knowledge map from game state
    const roleMap   = new Map<string, Role>();
    const teamMap   = new Map<string, 'good' | 'evil'>();
    for (const [pid, player] of Object.entries(room.players)) {
      if (player.role) roleMap.set(pid, player.role);
      if (player.team) teamMap.set(pid, player.team as 'good' | 'evil');
    }

    // Notify agents of their assignments
    for (const agent of agents) {
      const obs = this.buildObservation(agent.agentId, room, roleMap, teamMap, [], []);
      agent.onGameStart(obs);
    }

    const voteHistory:  VoteRecord[]  = [];
    const questHistory: QuestRecord[] = [];
    let   voteAttempt = 0;

    // ── Game loop ──────────────────────────────────────────────
    while (room.state !== 'ended') {
      const currentLeaderId = engine.getCurrentLeaderId();

      // ── Team selection phase ───────────────────────────────
      if (room.state === 'voting' && room.questTeam.length === 0) {
        const leader = agents.find(a => a.agentId === currentLeaderId)!;
        const obs    = this.buildObservation(leader.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = leader.act({ ...obs, gamePhase: 'team_select' });

        if (action.type !== 'team_select') throw new Error('Expected team_select action');
        engine.selectQuestTeam(action.teamIds);
      }

      // ── Team vote phase ────────────────────────────────────
      if (room.state === 'voting' && room.questTeam.length > 0) {
        voteAttempt++;
        const votes: Record<string, boolean> = {};

        for (const agent of agents) {
          const obs    = this.buildObservation(agent.agentId, room, roleMap, teamMap, voteHistory, questHistory);
          const action = agent.act({ ...obs, gamePhase: 'team_vote' });
          if (action.type !== 'team_vote') throw new Error('Expected team_vote action');
          votes[agent.agentId] = action.vote;
        }

        // Submit votes to engine
        for (const [pid, vote] of Object.entries(votes)) {
          engine.submitVote(pid, vote);
          if ((room.state as string) !== 'voting') break; // state changed, stop
        }

        // Use the engine-resolved vote record (already pushed to room.voteHistory)
        const latestVoteRecord = room.voteHistory[room.voteHistory.length - 1];
        if (latestVoteRecord) {
          voteHistory.push(latestVoteRecord);
        } else {
          // Fallback: compute locally
          const approved = Object.values(votes).filter(Boolean).length > agents.length / 2;
          voteHistory.push({
            round:    room.currentRound,
            attempt:  voteAttempt,
            leader:   currentLeaderId,
            team:     [...room.questTeam],
            approved,
            votes,
          });
        }

        const approved = latestVoteRecord?.approved ?? (Object.values(votes).filter(Boolean).length > agents.length / 2);
        if (approved) voteAttempt = 0;
        if ((room.state as string) === 'ended') break;
      }

      // ── Quest vote phase ────────────────────────────────────
      if (room.state === 'quest') {
        const teamAgents = agents.filter(a => room.questTeam.includes(a.agentId));
        const preRound   = room.currentRound;
        const preTeam    = [...room.questTeam];

        let failCount = 0;
        for (const agent of teamAgents) {
          const obs    = this.buildObservation(agent.agentId, room, roleMap, teamMap, voteHistory, questHistory);
          const action = agent.act({ ...obs, gamePhase: 'quest_vote' });
          if (action.type !== 'quest_vote') throw new Error('Expected quest_vote action');
          if (action.vote === 'fail') failCount++;
          engine.submitQuestVote(agent.agentId, action.vote);
          if ((room.state as string) !== 'quest') break;
        }

        // Use the engine-resolved result (respects 2-fail rule for round 4 in 7+ player games)
        const result = room.questResults[preRound - 1] ?? (failCount > 0 ? 'fail' : 'success');
        questHistory.push({ round: preRound, team: preTeam, result: result as 'success' | 'fail', failCount });

        if ((room.state as string) === 'ended') break;
      }

      // ── Assassination phase ─────────────────────────────────
      if (room.state === 'discussion') {
        const assassin = agents.find(a => roleMap.get(a.agentId) === 'assassin');
        if (!assassin) {
          // No assassin role (shouldn't happen) — resolve to good win
          break;
        }
        const obs    = this.buildObservation(assassin.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = assassin.act({ ...obs, gamePhase: 'assassination' });
        if (action.type !== 'assassinate') throw new Error('Expected assassinate action');
        engine.submitAssassination(assassin.agentId, action.targetId);
        break;
      }
    }

    // ── Notify agents of outcome ───────────────────────────────
    const evilWins = room.evilWins === true;
    for (const agent of agents) {
      const won = evilWins ? teamMap.get(agent.agentId) === 'evil' : teamMap.get(agent.agentId) === 'good';
      const obs = this.buildObservation(agent.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      agent.onGameEnd(obs, won);
    }

    // ── Persist event log ─────────────────────────────────────
    const events = engine.getEventLog();
    if (persist && events.length > 0) {
      await saveGameEvents(events.map(e => ({
        room_id:    roomId,
        seq:        e.seq,
        event_type: e.event_type,
        actor_id:   e.actor_id,
        event_data: e.event_data,
      })));
    }

    this.roomManager.deleteRoom(roomId);

    return {
      roomId,
      winner:      evilWins ? 'evil' : 'good',
      rounds:      room.currentRound,
      playerCount,
      eventCount:  events.length,
    };
  }

  /**
   * Run N games in sequence and return aggregate stats
   */
  async runBatch(agents: AvalonAgent[], n: number, persist = true): Promise<{
    total: number;
    goodWins: number;
    evilWins: number;
    avgRounds: number;
  }> {
    let goodWins = 0, evilWins = 0, totalRounds = 0;

    for (let i = 0; i < n; i++) {
      const result = await this.runGame(agents, persist);
      if (result.winner === 'good') goodWins++;
      else evilWins++;
      totalRounds += result.rounds;
    }

    return {
      total: n,
      goodWins,
      evilWins,
      avgRounds: Math.round(totalRounds / n * 10) / 10,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────

  private buildObservation(
    playerId:     string,
    room:         Room,
    roleMap:      Map<string, Role>,
    teamMap:      Map<string, 'good' | 'evil'>,
    voteHistory:  VoteRecord[],
    questHistory: QuestRecord[],
  ): PlayerObservation {
    const myRole  = roleMap.get(playerId) ?? 'loyal';
    const myTeam  = teamMap.get(playerId) ?? 'good';

    // Determine which other players this role can identify as evil
    const knownEvils = this.getKnownEvils(playerId, myRole, roleMap, teamMap);

    return {
      myPlayerId:    playerId,
      myRole,
      myTeam,
      playerCount:   Object.keys(room.players).length,
      knownEvils,
      currentRound:  room.currentRound,
      currentLeader: this.getCurrentLeader(room),
      failCount:     room.failCount,
      questResults:  room.questResults.filter((r): r is 'success' | 'fail' => r !== 'pending'),
      gamePhase:     this.getPhase(room),
      voteHistory:   [...voteHistory],
      questHistory:  [...questHistory],
      proposedTeam:  [...room.questTeam],
    };
  }

  private getKnownEvils(
    playerId: string,
    role:     Role,
    roleMap:  Map<string, Role>,
    teamMap:  Map<string, 'good' | 'evil'>,
  ): string[] {
    switch (role) {
      case 'merlin': {
        // Merlin sees all evil except Oberon and Mordred
        return Array.from(teamMap.entries())
          .filter(([id, team]) => team === 'evil' && id !== playerId
            && roleMap.get(id) !== 'oberon' && roleMap.get(id) !== 'mordred')
          .map(([id]) => id);
      }
      case 'percival': {
        // Percival sees Merlin and Morgana (can't tell which)
        return Array.from(roleMap.entries())
          .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== playerId)
          .map(([id]) => id);
      }
      case 'assassin':
      case 'morgana':
      case 'mordred': {
        // Evil sees other evil (except Oberon)
        return Array.from(teamMap.entries())
          .filter(([id, team]) => team === 'evil' && roleMap.get(id) !== 'oberon' && id !== playerId)
          .map(([id]) => id);
      }
      default:
        return [];
    }
  }

  private getCurrentLeader(room: Room): string {
    const playerIds = Object.keys(room.players);
    return playerIds[room.leaderIndex % playerIds.length];
  }

  private getPhase(room: Room): PlayerObservation['gamePhase'] {
    if (room.state === 'discussion') return 'assassination';
    if (room.state === 'quest')     return 'quest_vote';
    if (room.questTeam.length > 0) return 'team_vote';
    return 'team_select';
  }
}
