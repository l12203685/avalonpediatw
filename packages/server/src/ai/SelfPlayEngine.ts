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

      // ── Lady of the Lake phase ─────────────────────────────
      if (room.state === 'lady_of_the_lake') {
        const holderId  = room.ladyOfTheLakeHolder!;
        const used      = new Set(room.ladyOfTheLakeUsed ?? []);
        const holder    = agents.find(a => a.agentId === holderId);
        const validTargets = Object.keys(room.players).filter(id => id !== holderId && !used.has(id));
        if (holder && validTargets.length > 0) {
          const obs = this.buildObservation(holderId, room, roleMap, teamMap, voteHistory, questHistory);
          const holderTeam = teamMap.get(holderId);
          const targetId = this.pickLadyTarget(holderTeam, obs, validTargets);
          engine.submitLadyOfTheLakeTarget(holderId, targetId);
          // Optional public declaration (Edward 2026-04-22 12:39 +08 — evil may
          // announce "good" for a just-laked ally to wash pressure).
          const actualTargetTeam = teamMap.get(targetId);
          const claim = this.decideLakeAnnouncement(holderTeam, targetId, obs, actualTargetTeam);
          if (claim !== null) {
            try {
              engine.declareLakeResult(holderId, claim);
            } catch {
              // Declaration is best-effort in self-play; never block the phase
              // transition if the engine guard rejects the call.
            }
          }
          // Skip the 3-second display delay used in real-time games
          engine.completeLadyPhase();
        } else {
          // No valid targets — force-advance to avoid hang
          engine.completeLadyPhase();
        }
        if ((room.state as string) === 'ended') break;
        continue;
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
   * Run N games in sequence and return per-game results plus aggregate stats
   */
  async runBatch(agents: AvalonAgent[], n: number, persist = true): Promise<{
    results: SelfPlayResult[];
    total: number;
    goodWins: number;
    evilWins: number;
    avgRounds: number;
  }> {
    const results: SelfPlayResult[] = [];
    let goodWins = 0, evilWins = 0, totalRounds = 0;

    for (let i = 0; i < n; i++) {
      const result = await this.runGame(agents, persist);
      results.push(result);
      if (result.winner === 'good') goodWins++;
      else evilWins++;
      totalRounds += result.rounds;
    }

    return {
      results,
      total: n,
      goodWins,
      evilWins,
      avgRounds: Math.round(totalRounds / n * 10) / 10,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Feature flag: smart lake targeting (default on).
   *
   * - `true`  → good filters out knownEvils + knownGoods (self-included) and picks
   *             highest suspicion among unknown-camp candidates; evil filters out
   *             knownEvils (allies) + self and picks highest "likely Merlin" candidate.
   * - `false` → legacy behavior (good picks knownEvils[0]; evil picks random).
   *
   * Read per-call from `process.env.AVALON_USE_SMART_LAKE` so tests can toggle it
   * without re-loading the module.
   */
  private isSmartLakeEnabled(): boolean {
    return process.env.AVALON_USE_SMART_LAKE !== '0';
  }

  /**
   * Feature flag: evil holder may strategically lake (and publicly clear) an
   * already-suspected ally. Default on per Edward 2026-04-22 12:39 +08:
   *
   *   「紅方湖中女神當然可以湖隊友並宣告隊友是好人 / 不用刻意避開」
   *
   * When off, the evil branch falls back to the Fix #2 commit `9bdff755`
   * behaviour of filtering out `knownEvils` before scoring (old heuristic
   * that Edward flagged as too timid).
   */
  private isEvilLakeBringFriendEnabled(): boolean {
    return process.env.AVALON_EVIL_LAKE_BRING_FRIEND !== '0';
  }

  /**
   * Pick a lady-of-the-lake target for the holder.
   *
   * Good holder  — target MUST NOT be in `knownEvils` (wastes the lake;
   * SSoT §4.3 / §6.9 / §8.3). Prefer the highest-suspicion unknown-camp player;
   * fallback to any unlaked player.
   *
   * Evil holder  — with `AVALON_EVIL_LAKE_BRING_FRIEND=1` (default) the holder
   * does NOT filter out allies (Edward 2026-04-22 12:39 +08: "不用刻意避開").
   * A strategic choice is made:
   *   1. If any known-evil ally is currently the *most-suspected* non-ally
   *      in public history (`estimateSuspicionFromHistory` exceeds the most
   *      Merlin-like opponent), lake the ally and plan to declare "good" —
   *      this is a proactive wash of pressure. (See `decideLakeAnnouncement`.)
   *   2. Otherwise lake the most Merlin-like opponent (original Fix #2 heuristic).
   *   3. When the flag is off, restore Fix #2 behaviour of filtering knownEvils
   *      before scoring (preserved for regression comparison).
   *
   * Legacy (pre-smart) path is kept behind `USE_SMART_LAKE === false` for
   * comparison runs.
   *
   * @internal Exposed as `public` for unit testing only; not part of the stable API.
   */
  public pickLadyTarget(
    holderTeam: 'good' | 'evil' | undefined,
    obs:        PlayerObservation,
    validTargets: string[],
  ): string {
    if (!this.isSmartLakeEnabled()) {
      // Legacy: good picks knownEvils[0] (useless), evil picks random.
      if (holderTeam === 'good') {
        const knownEvilTarget = obs.knownEvils.find(id => validTargets.includes(id));
        return knownEvilTarget ?? validTargets[Math.floor(Math.random() * validTargets.length)];
      }
      return validTargets[Math.floor(Math.random() * validTargets.length)];
    }

    const knownEvilSet = new Set(obs.knownEvils);

    if (holderTeam === 'good') {
      // Edward 2026-04-24 batch 2 fix #7: all good players avoid lake-
      // ing their viewpoint-known bad/ambiguous targets:
      //   • merlin   — knownEvils = assassin+morgana (Oberon/Mordred
      //                invisible → lake-probe allowed)
      //   • percival — knownEvils = [] (engine wires this as empty for
      //                percival); knownWizards = [merlin, morgana]
      //                (ambiguous — can't distinguish); avoid both so
      //                we never waste the lake on them.
      //   • loyal    — knownEvils = [], knownWizards = undefined → no
      //                filter (loyal must rely on suspicion ranking
      //                alone).
      // The filter set is knownEvils ∪ knownWizards so each role's view
      // is honoured without branching on myRole.
      const avoidSet = new Set<string>(obs.knownEvils);
      for (const wizardId of obs.knownWizards ?? []) avoidSet.add(wizardId);
      const unknownCandidates = validTargets.filter(id => !avoidSet.has(id));
      if (unknownCandidates.length === 0) {
        return validTargets[0];
      }
      return this.rankByDescendingScore(
        unknownCandidates,
        id => this.estimateSuspicionFromHistory(id, obs),
        obs.allPlayerIds,
      )[0];
    }

    // Evil branch — Edward 2026-04-22 12:39 +08 correction.
    if (this.isEvilLakeBringFriendEnabled()) {
      // Consider every valid target (including allies) — do not filter knownEvils.
      const opponents = validTargets.filter(id => !knownEvilSet.has(id));
      const allies    = validTargets.filter(id =>  knownEvilSet.has(id));

      // Rank opponents by Merlin-likeness, allies by how suspected they currently look
      // (allies publicly look risky → washing them with "good" declaration has high payoff).
      const bestOpponent = opponents.length === 0 ? null : this.rankByDescendingScore(
        opponents,
        id => this.estimateMerlinLikenessFromHistory(id, obs),
        obs.allPlayerIds,
      )[0];
      const mostPressuredAlly = allies.length === 0 ? null : this.rankByDescendingScore(
        allies,
        id => this.estimateSuspicionFromHistory(id, obs),
        obs.allPlayerIds,
      )[0];

      const opponentScore = bestOpponent === null
        ? Number.NEGATIVE_INFINITY
        : this.estimateMerlinLikenessFromHistory(bestOpponent, obs);
      const allyPressure = mostPressuredAlly === null
        ? Number.NEGATIVE_INFINITY
        : this.estimateSuspicionFromHistory(mostPressuredAlly, obs);

      // Heuristic: if an ally is visibly under suspicion (positive pressure)
      // and the best opponent does not read strongly as Merlin
      // (≤ ally pressure), wash the ally. Otherwise pin the Merlin-like opponent.
      if (
        mostPressuredAlly !== null &&
        allyPressure > 0 &&
        allyPressure >= opponentScore
      ) {
        return mostPressuredAlly;
      }
      if (bestOpponent !== null) {
        return bestOpponent;
      }
      // Only allies remain (no opponents valid) → wash the most pressured one.
      if (mostPressuredAlly !== null) {
        return mostPressuredAlly;
      }
      // Extremely degenerate: no valid targets after partitioning (shouldn't happen).
      return validTargets[0];
    }

    // Flag off → Fix #2 (`9bdff755`) regression behaviour: filter allies then rank.
    const unknownCandidates = validTargets.filter(id => !knownEvilSet.has(id));
    if (unknownCandidates.length === 0) {
      return validTargets[0];
    }
    return this.rankByDescendingScore(
      unknownCandidates,
      id => this.estimateMerlinLikenessFromHistory(id, obs),
      obs.allPlayerIds,
    )[0];
  }

  /**
   * Decide what (if anything) the holder will publicly claim about the
   * target right after the lake — Edward 2026-04-22 12:39 +08:
   *
   *   「紅方湖中女神當然可以湖隊友並宣告隊友是好人」
   *
   * Good holder  — announce the truth (can also keep private, but honest claim
   * is the textbook default; return the real team).
   *
   * Evil holder  — always announce "good" for an ally (wash) and for an
   * opponent announce the role that best furthers the evil narrative:
   *   - If the opponent reads strongly as Merlin (positive score), publicly
   *     call them "good" — confirms them as safe and disguises the assassin
   *     intel.
   *   - Otherwise call them "evil" to seed confusion on a clean opponent.
   *
   * Returns `null` when no declaration should be made (holderTeam unknown
   * or target not present). Actual `GameEngine.declareLakeResult` call sits
   * at the socket / orchestrator layer; this method just decides intent.
   */
  public decideLakeAnnouncement(
    holderTeam: 'good' | 'evil' | undefined,
    targetId:   string,
    obs:        PlayerObservation,
    actualTargetTeam: 'good' | 'evil' | undefined,
  ): 'good' | 'evil' | null {
    if (holderTeam !== 'good' && holderTeam !== 'evil') return null;

    if (holderTeam === 'good') {
      // Good holder tells the truth when a team is known.
      if (actualTargetTeam === 'good' || actualTargetTeam === 'evil') {
        return actualTargetTeam;
      }
      return null;
    }

    // Evil holder.
    const knownEvilSet = new Set(obs.knownEvils);
    if (knownEvilSet.has(targetId)) {
      // Ally → always publicly wash as good.
      return 'good';
    }
    // Opponent branch: score Merlin-likeness; if Merlin-like, call them good to
    // disguise the intel. Otherwise call them evil to muddy the water.
    const merlinScore = this.estimateMerlinLikenessFromHistory(targetId, obs);
    return merlinScore > 0 ? 'good' : 'evil';
  }

  /**
   * Deterministic descending rank: primary by score desc, tiebreak by
   * `tiebreakOrder` ascending index (stable under identical input).
   */
  private rankByDescendingScore(
    ids:            string[],
    score:          (id: string) => number,
    tiebreakOrder:  string[],
  ): string[] {
    const orderIdx = new Map(tiebreakOrder.map((id, i) => [id, i]));
    return [...ids].sort((a, b) => {
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0);
    });
  }

  /**
   * Cheap suspicion proxy built only from public history (no HeuristicAgent dep):
   *   +2 per fail-quest appearance
   *   +1 per approve of a later-failed team
   *   -0.5 per appearance on a successful quest
   *   -0.3 per reject of a later-failed team
   * Good holders use this to find unknown-camp players most likely to be evil.
   */
  private estimateSuspicionFromHistory(playerId: string, obs: PlayerObservation): number {
    let score = 0;
    const failedRounds = new Set<number>();
    for (const q of obs.questHistory) {
      if (q.result === 'fail') {
        failedRounds.add(q.round);
        if (q.team.includes(playerId)) score += 2;
      } else if (q.result === 'success' && q.team.includes(playerId)) {
        score -= 0.5;
      }
    }
    for (const v of obs.voteHistory) {
      if (!failedRounds.has(v.round)) continue;
      const approved = v.votes[playerId];
      if (approved === true)  score += 1;
      if (approved === false) score -= 0.3;
    }
    return score;
  }

  /**
   * "Looks like Merlin" proxy from evil holder's view: players who rejected teams
   * containing knownEvils, and never appeared on fail quests. Higher = stronger
   * Merlin suspicion. Evil holders use this to lake the most likely Merlin and
   * confirm their target for assassination.
   */
  private estimateMerlinLikenessFromHistory(playerId: string, obs: PlayerObservation): number {
    let score = 0;
    const knownEvilSet = new Set(obs.knownEvils);

    // Rejected teams containing knownEvils → Merlin signal
    for (const v of obs.voteHistory) {
      const teamHasKnownEvil = v.team.some(id => knownEvilSet.has(id));
      if (!teamHasKnownEvil) continue;
      const approved = v.votes[playerId];
      if (approved === false) score += 1.5;
      if (approved === true)  score -= 0.5;
    }

    // Appeared on fail quests → NOT Merlin (loyal players including Merlin never fail on purpose,
    // but Merlin tends to avoid being proposed to suspicious teams)
    for (const q of obs.questHistory) {
      if (q.result === 'fail' && q.team.includes(playerId)) score -= 2;
    }

    return score;
  }

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

    // Edward 2026-04-24 batch 2 fix #7: wire knownWizards for Percival so
    // the Percival-specific lake avoid and thumb-picking heuristics have
    // the two wizard candidates in observation scope. Non-Percival roles
    // stay `undefined` (schema-compatible).
    const knownWizards = myRole === 'percival'
      ? Array.from(roleMap.entries())
          .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== playerId)
          .map(([id]) => id)
      : undefined;

    // Edward 2026-04-24 batch 3 fix — assassin hard-filter: at
    // assassination phase only, inject the full evil roster so the
    // assassin cannot pick Oberon/Mordred (hidden from `knownEvils`
    // mid-game). Narrow-scope field — `undefined` in all other phases
    // and roles.
    const allEvilIds = myRole === 'assassin' && this.getPhase(room) === 'assassination'
      ? Array.from(teamMap.entries())
          .filter(([, t]) => t === 'evil')
          .map(([id]) => id)
      : undefined;

    return {
      myPlayerId:    playerId,
      myRole,
      myTeam,
      playerCount:   Object.keys(room.players).length,
      allPlayerIds:  Object.keys(room.players),
      knownEvils,
      knownWizards,
      allEvilIds,
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
