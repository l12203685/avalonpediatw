/**
 * Invariant harness sources (logic-first plan §5.2):
 *
 *   - replay   — every decision point of the logged human games
 *                (`sheets_cache.json`, the agreement benchmark's strict
 *                parser): the production bot decides from the reconstructed
 *                observation of that seat, and the human's actual decision
 *                is checked too, as a reference column. Decision points whose
 *                vote record was reconstructed are flagged unreliable. Same
 *                seeds and order as `logic_audit.md`'s script, so its
 *                numbers reproduce.
 *   - probe    — the counterfactual of `belief_engine.md` §1.4: at the first
 *                proposal of R2..R5 every loyal seat is made the leader
 *                (INV-T1's "1685 / 22976").
 *   - selfplay — bot-vs-bot games (`SelfPlayEngine`, fixed seeds), every
 *                seat an `AuditAgent` with the given tuning.
 *
 * Aggregates only; nothing here prints or returns names or seats.
 */

import { AVALON_CONFIG, type Role } from '@avalon/shared';
import { SelfPlayEngine } from '../SelfPlayEngine';
import { HeuristicAgent } from '../HeuristicAgent';
import { ForwardAgent } from '../forward/ForwardAgent';
import { withSeededRandom, seededRandom } from '../benchmark/agreement';
import { campOf, type ReplayGame } from '../benchmark/sheetsReplay';
import {
  buildReplayObservation,
  missionProposal,
  seatId,
  validLakeTargetSeats,
  type DecisionPoint,
} from '../benchmark/replayObservation';
import { CertaintyView, certaintyParamsFor, enumerateWorlds } from '../belief/Certainty';
import type { AgentTuning } from '../AgentTuning';
import type { PlayerObservation } from '../types';
import { AuditAgent, type DecisionRecord } from './AuditAgent';
import { checkDecision, checkObservation, checkPublicRound } from './checks';
import { truthFromRoles, type Truth } from './context';
import { Ledger } from './ledger';

export interface HarnessResult {
  replay: Ledger;
  probe: Ledger;
  selfplay: Ledger;
  /** Games with at least one good seat whose L1 was empty (INV-W2), per source. */
  l1EmptyGames: { replay: number; replayGames: number; selfplay: number; selfplayGames: number };
}

export function emptyResult(): HarnessResult {
  return {
    replay: new Ledger(),
    probe: new Ledger(),
    selfplay: new Ledger(),
    l1EmptyGames: { replay: 0, replayGames: 0, selfplay: 0, selfplayGames: 0 },
  };
}

// ── Replay ─────────────────────────────────────────────────────

function replayTruth(game: ReplayGame): Truth {
  const roles = new Map<string, Role>();
  game.seatRoles.forEach((r, i) => roles.set(seatId(i + 1), r));
  return truthFromRoles(roles);
}

/** The vote records `point` sees include a reconstructed (non-forced, unreliable) one. */
function unreliableInput(game: ReplayGame, point: DecisionPoint): boolean {
  let until: number;
  switch (point.kind) {
    case 'team_select':
    case 'team_vote':
      until = point.proposal;
      break;
    case 'quest_vote':
      until = missionProposal(game, point.round).globalIndex + 1;
      break;
    case 'lake':
      until = missionProposal(game, game.lakes[point.lake].round).globalIndex + 1;
      break;
    case 'assassination':
      until = game.proposals.length;
      break;
  }
  return game.proposals.slice(0, until).some((p) => !p.forced && !p.votesReliable);
}

export interface ReplayOptions {
  tuning: AgentTuning;
  /** Belief / metamorphic / privacy checks at every round opening (R2+). */
  observationChecks: boolean;
  /** The counterfactual loyal-leader probe. */
  probe: boolean;
}

/** Audit one replayed game into `result`. */
export function auditReplayGame(game: ReplayGame, opts: ReplayOptions, result: HarnessResult): void {
  const truth = replayTruth(game);
  const L = result.replay;
  let l1Empty = false;
  result.l1EmptyGames.replayGames++;

  // Public rule-3 checks at the openings of R3..R5 (seat 1's observation; public part only).
  for (let r = 3; r <= game.quests.length; r++) {
    const pIdx = game.proposals.findIndex((p) => p.round === r);
    if (pIdx < 0) continue;
    checkPublicRound(buildReplayObservation(game, 1, { kind: 'team_select', proposal: pIdx }), L, truth);
  }
  // Every seat's picture at the openings of R2..R5.
  if (opts.observationChecks) {
    for (let r = 2; r <= game.quests.length; r++) {
      const pIdx = game.proposals.findIndex((p) => p.round === r);
      if (pIdx < 0) continue;
      for (let seat = 1; seat <= game.playerCount; seat++) {
        checkObservation(buildReplayObservation(game, seat, { kind: 'team_select', proposal: pIdx }), L, truth);
      }
    }
  }

  for (let seat = 1; seat <= game.playerCount; seat++) {
    const id = seatId(seat);
    const role = game.seatRoles[seat - 1];
    const agent = new AuditAgent(id, opts.tuning);
    agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
    const seed = (key: string): string => `${game.id}|${seat}|${key}`;
    const check = (rec: DecisionRecord): void => {
      if (checkDecision(rec, L, truth)) l1Empty = true;
    };

    let proposalIdx = 0;
    for (const quest of game.quests) {
      const round = quest.round;
      for (; proposalIdx < game.proposals.length && game.proposals[proposalIdx].round === round; proposalIdx++) {
        const p = game.proposals[proposalIdx];
        if (p.leaderSeat === seat) {
          const point: DecisionPoint = { kind: 'team_select', proposal: proposalIdx };
          const rec = agent.decideSeeded(buildReplayObservation(game, seat, point), seed(`team-${proposalIdx}`));
          rec.human = { team: p.teamSeats.map(seatId) };
          rec.unreliable = unreliableInput(game, point);
          check(rec);
        }
        if (!p.forced) {
          const point: DecisionPoint = { kind: 'team_vote', proposal: proposalIdx };
          const rec = agent.decideSeeded(buildReplayObservation(game, seat, point), seed(`vote-${proposalIdx}`));
          rec.human = { vote: p.votes[seat - 1] };
          rec.unreliable = unreliableInput(game, point) || !p.votesReliable;
          check(rec);
        }
      }
      if (quest.teamSeats.includes(seat)) {
        const point: DecisionPoint = { kind: 'quest_vote', round };
        const rec = agent.decideSeeded(buildReplayObservation(game, seat, point), seed(`quest-${round}`));
        rec.unreliable = unreliableInput(game, point);
        check(rec);
      }
      const lakeIdx = game.lakes.findIndex((l) => l.round === round);
      if (lakeIdx >= 0 && game.lakeChainValid && game.lakes[lakeIdx].holderSeat === seat) {
        const lake = game.lakes[lakeIdx];
        const point: DecisionPoint = { kind: 'lake', lake: lakeIdx };
        const obs = buildReplayObservation(game, seat, point);
        const valid = validLakeTargetSeats(game, lakeIdx).map(seatId);
        const t = agent.pickLakeTargetSeeded(obs, valid, seed(`lake-${lakeIdx}`));
        t.human = { target: seatId(lake.targetSeat) };
        check(t);
        const truthCamp = campOf(game.seatRoles[lake.targetSeat - 1]);
        const c = agent.declareLakeSeeded(obs, seatId(lake.targetSeat), truthCamp, seed(`claim-${lakeIdx}`));
        c.human = { claim: lake.claim };
        check(c);
      }
    }
    if (role === 'assassin' && game.assassinTargetSeat !== undefined) {
      const point: DecisionPoint = { kind: 'assassination' };
      const rec = agent.decideSeeded(buildReplayObservation(game, seat, point), seed('assassinate'));
      rec.human = { target: seatId(game.assassinTargetSeat) };
      check(rec);
    }
  }
  if (l1Empty) result.l1EmptyGames.replay++;
  if (opts.probe) probeGame(game, opts.tuning, result.probe, truth);
}

/**
 * INV-T1 probe (`belief_engine.md` §1.4 / `publicEntropy.ts` X5): every loyal
 * seat made the leader at the first proposal of R2..R5. Counted twice: the
 * audit's "HARD" model (fail counts + "I am good", no lakes, no own lake
 * results — reproduces 1685 / 22976) and the invariant's L1*.
 */
function probeGame(game: ReplayGame, tuning: AgentTuning, L: Ledger, truth: Truth): void {
  for (let round = 2; round <= game.quests.length; round++) {
    const pIdx = game.proposals.findIndex((p) => p.round === round);
    if (pIdx < 0) continue;
    game.seatRoles.forEach((r, i) => {
      if (r !== 'loyal') return;
      const seat = i + 1;
      const id = seatId(seat);
      const base = new HeuristicAgent(id, undefined, undefined, tuning);
      const fwd = new ForwardAgent(id, base);
      fwd.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
      const obs: PlayerObservation = { ...buildReplayObservation(game, seat, { kind: 'team_select', proposal: pIdx }), currentLeader: id };
      const d = withSeededRandom(`${game.id}|${seat}|x5|${pIdx}`, () => {
        base._ingestForTesting(obs);
        return fwd.decide(obs);
      });
      if (d.reasoningTrace.usedFallback) L.inc('forward.fallbacks');
      if (d.action.type !== 'team_select') return;
      const team = d.action.teamIds;
      const params = certaintyParamsFor(obs);
      const hardWorlds = enumerateWorlds(obs, { self: 'own', sight: true, ownLakeResults: false, lakes: false }, params);
      const hard = new CertaintyView(obs, hardWorlds, hardWorlds, params);
      L.inc('X5chk.n');
      L.inc(`X5chk.n.R${round}`);
      if (hard.minReds(team, 'L1') >= hard.failsRequired(round)) { L.inc('X5chk.provablyFailable'); L.inc(`X5chk.provablyFailable.R${round}`); }
      if (hard.minReds(team, 'L1') >= 1) { L.inc('X5chk.provablyTainted'); L.inc(`X5chk.provablyTainted.R${round}`); }
      if (!team.some((x) => truth.evil.has(x))) L.inc('X5chk.clean');
      checkDecision({ kind: 'team_select', obs, action: d.action, usedFallback: d.reasoningTrace.usedFallback }, L, truth);
    });
  }
}

// ── Self-play ──────────────────────────────────────────────────

export interface SelfPlayOptions {
  tuning: AgentTuning;
  seed: number;
  games: number;
  playerCount: number;
  observationChecks: boolean;
}

/** Bot-vs-bot games, every decision recorded and checked. */
export async function auditSelfPlay(opts: SelfPlayOptions, result: HarnessResult): Promise<void> {
  if (!AVALON_CONFIG[opts.playerCount]) throw new Error(`no config for ${opts.playerCount} players`);
  const engine = new SelfPlayEngine();
  const L = result.selfplay;
  for (let i = 0; i < opts.games; i++) {
    const agents = Array.from({ length: opts.playerCount }, (_, k) => new AuditAgent(`P${k + 1}`, opts.tuning));
    const gameSeed = `${opts.seed}|${i}`;
    for (const a of agents) a.gameSeed = gameSeed;
    const originalRandom = Math.random;
    // GameEngine prints every event as JSON on stdout; keep the run quiet.
    // eslint-disable-next-line no-console
    const originalLog = console.log;
    Math.random = seededRandom(`${gameSeed}|setup`);
    // eslint-disable-next-line no-console
    console.log = (): void => undefined;
    try {
      await engine.runGame(agents, false);
    } finally {
      Math.random = originalRandom;
      // eslint-disable-next-line no-console
      console.log = originalLog;
    }
    result.l1EmptyGames.selfplayGames++;
    L.inc(`games.${opts.playerCount}p`);
    const roles = new Map<string, Role>();
    for (const a of agents) if (a.role) roles.set(a.agentId, a.role);
    const truth = truthFromRoles(roles);
    let l1Empty = false;
    const firstVoteOfRound = new Map<string, PlayerObservation>();
    const roundOpenings = new Map<number, PlayerObservation>();
    for (const a of agents) {
      for (const rec of a.records) {
        if (checkDecision(rec, L, truth)) l1Empty = true;
        if (rec.kind === 'team_vote' && rec.obs.currentRound >= 2) {
          const key = `${a.agentId}|${rec.obs.currentRound}`;
          if (!firstVoteOfRound.has(key)) firstVoteOfRound.set(key, rec.obs);
          if (rec.obs.currentRound >= 3 && !roundOpenings.has(rec.obs.currentRound)) roundOpenings.set(rec.obs.currentRound, rec.obs);
        }
      }
    }
    if (opts.observationChecks) for (const obs of firstVoteOfRound.values()) checkObservation(obs, L, truth);
    for (const obs of roundOpenings.values()) checkPublicRound(obs, L, truth);
    if (l1Empty) result.l1EmptyGames.selfplay++;
  }
}
