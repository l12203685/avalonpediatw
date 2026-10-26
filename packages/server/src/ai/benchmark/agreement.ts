/**
 * Agreement benchmark core (2026-10-10).
 *
 * Replays logged 10-player games seat by seat: at every decision point the
 * seat faced, the agent gets the reconstructed observation
 * (`buildReplayObservation`) and its choice is compared with what the human
 * actually did. Two context baselines are scored on the same points:
 *
 *   default — "do the obvious": vote on-team approve / off-team reject;
 *             re-propose the previous team of the round (or the last
 *             mission team / self + next seats), swapping self in; evil
 *             always fails; lake claim = truth; lake target and
 *             assassination at chance level (1 / #candidates).
 *   rule    — a few public-information rules: avoid failed-mission members
 *             (and known evils) on teams and votes from R3; evil approves
 *             teams with an ally; evil fails unless it cannot break R4
 *             alone; lake the most failed-mission-tainted seat; evil claims
 *             invert the truth (the live GameServer bot rule); assassinate
 *             the seat that most often rejected teams holding a known evil.
 *
 * Determinism: every agent call runs under a `Math.random` replaced by a
 * PRNG seeded from (game id, seat, decision key), so a decision does not
 * depend on which other games / seats were evaluated.
 */

import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../types';
import { estimateMerlinLikenessFromHistory } from '../LakePolicy';
import { LEGACY_BELIEF_OPTIONS } from '../belief/BeliefOptions';
import {
  campOf,
  type Camp,
  type ReplayGame,
} from './sheetsReplay';
import {
  buildReplayObservation,
  seatId,
  seatOfId,
  validLakeTargetSeats,
} from './replayObservation';

// ── Agent contract ─────────────────────────────────────────────

/** What the benchmark needs from an agent (HeuristicAgent satisfies it). */
export interface BenchmarkAgent {
  onGameStart(obs: PlayerObservation): void;
  act(obs: PlayerObservation): AgentAction;
  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string;
  declareLake(obs: PlayerObservation, targetId: string, trueFaction: Camp | undefined): Camp | null;
}

export type AgentFactory = (playerId: string) => BenchmarkAgent;

// ── Deterministic randomness ───────────────────────────────────

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 PRNG seeded from a string. */
export function seededRandom(seed: string): () => number {
  let a = fnv1a(seed);
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `fn` with `Math.random` replaced by a PRNG seeded from `seed`. */
export function withSeededRandom<T>(seed: string, fn: () => T): T {
  const original = Math.random;
  Math.random = seededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

// ── Decision outcomes ──────────────────────────────────────────

export type DecisionType = 'team' | 'vote' | 'quest' | 'lakeTarget' | 'lakeClaim' | 'assassinate';

export interface DecisionOutcome {
  gameId: string;
  seat: number;
  name: string;
  role: string;
  side: Camp;
  type: DecisionType;
  round: number;
  attempt?: number;
  human: string;
  agent: string;
  /** Agent agrees with the human (exact set for teams). */
  match: boolean;
  /** Team only: |A∩H| / |A∪H|. */
  jaccard?: number;
  /** Expected agreement of the default / rule baselines (0..1; fractional = chance level). */
  defaultMatch: number;
  ruleMatch: number;
  defaultJaccard?: number;
  ruleJaccard?: number;
  /** Vote only: human cast an anomaly (off-team approve / on-team reject). */
  humanNonDefault?: boolean;
  /** Vote only: agent cast an anomaly. */
  agentNonDefault?: boolean;
  /** Assassinate only: the human / agent target was Merlin. */
  humanHitMerlin?: boolean;
  agentHitMerlin?: boolean;
  /** Situation bucket (context only, e.g. "vote R3+ good off-team, tainted team"). */
  situation: string;
  /** How the agent diverged ("human reject / agent approve"); "match" when it agreed. */
  divergence: string;
}

// ── Helpers ────────────────────────────────────────────────────

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

function failedMissionMembers(obs: PlayerObservation): Set<string> {
  const out = new Set<string>();
  for (const q of obs.questHistory) if (q.result === 'fail') for (const id of q.team) out.add(id);
  return out;
}

function successfulMissionCount(obs: PlayerObservation, id: string): number {
  return obs.questHistory.filter((q) => q.result === 'success' && q.team.includes(id)).length;
}

/** Seats clockwise after `fromId` (excluding it). */
function clockwiseFrom(obs: PlayerObservation, fromId: string): string[] {
  const ids = obs.allPlayerIds;
  const start = ids.indexOf(fromId);
  return Array.from({ length: ids.length - 1 }, (_, k) => ids[(start + 1 + k) % ids.length]);
}

function teamSizeFor(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount].questTeams[obs.currentRound - 1];
}

function roundBucket(round: number): string {
  return round <= 2 ? `R${round}` : 'R3+';
}

// ── Baselines ──────────────────────────────────────────────────

/** Default team: re-propose the latest team (round or previous mission), self swapped in. */
export function defaultTeam(game: ReplayGame, proposalIndex: number, obs: PlayerObservation): string[] {
  const size = teamSizeFor(obs);
  const self = obs.myPlayerId;
  const prev = proposalIndex > 0 ? game.proposals[proposalIndex - 1] : undefined;
  let team = prev ? prev.teamSeats.map(seatId) : [self];
  if (!team.includes(self)) team = [...team.slice(0, team.length - 1), self];
  for (const id of clockwiseFrom(obs, self)) {
    if (team.length >= size) break;
    if (!team.includes(id)) team.push(id);
  }
  return team.slice(0, size);
}

/** Rule team: self (+ one ally for evil on 4+ teams), then proven-clean seats. */
export function ruleTeam(obs: PlayerObservation): string[] {
  const size = teamSizeFor(obs);
  const self = obs.myPlayerId;
  const tainted = failedMissionMembers(obs);
  const avoid = new Set<string>(tainted);
  if (obs.myTeam === 'good') for (const id of obs.knownEvils) avoid.add(id);
  const order = clockwiseFrom(obs, self);
  const ranked = [...order].sort(
    (a, b) => successfulMissionCount(obs, b) - successfulMissionCount(obs, a)
      || order.indexOf(a) - order.indexOf(b),
  );
  const team = [self];
  if (obs.myTeam === 'evil' && size >= 4) {
    const ally = order.find((id) => obs.knownEvils.includes(id) && !tainted.has(id))
      ?? order.find((id) => obs.knownEvils.includes(id));
    if (ally) team.push(ally);
  }
  for (const id of [...ranked.filter((x) => !avoid.has(x)), ...ranked.filter((x) => avoid.has(x))]) {
    if (team.length >= size) break;
    if (!team.includes(id) && !(obs.myTeam === 'evil' && obs.knownEvils.includes(id))) team.push(id);
  }
  for (const id of ranked) {
    if (team.length >= size) break;
    if (!team.includes(id)) team.push(id);
  }
  return team;
}

export function defaultVote(obs: PlayerObservation): boolean {
  return obs.proposedTeam.includes(obs.myPlayerId);
}

export function ruleVote(obs: PlayerObservation): boolean {
  const team = obs.proposedTeam;
  const self = obs.myPlayerId;
  const onTeam = team.includes(self);
  if (obs.currentRound <= 2) return onTeam;
  if (obs.myTeam === 'evil') return onTeam || team.some((id) => obs.knownEvils.includes(id));
  if (team.some((id) => obs.knownEvils.includes(id))) return false;
  const tainted = failedMissionMembers(obs);
  if (team.some((id) => id !== self && tainted.has(id))) return false;
  if (onTeam) return true;
  return team.every((id) => successfulMissionCount(obs, id) > 0);
}

export function ruleQuest(obs: PlayerObservation): 'success' | 'fail' {
  const config = AVALON_CONFIG[obs.playerCount];
  const required = config.questFailsRequired[obs.currentRound - 1];
  const visibleEvil = 1 + obs.proposedTeam.filter((id) => obs.knownEvils.includes(id)).length;
  return visibleEvil < required ? 'success' : 'fail';
}

export function ruleLakeTarget(obs: PlayerObservation, valid: readonly string[]): string {
  const failCounts = (id: string): number =>
    obs.questHistory.filter((q) => q.result === 'fail' && q.team.includes(id)).length;
  const order = clockwiseFrom(obs, obs.myPlayerId);
  const pool = valid.filter((id) => !obs.knownEvils.includes(id));
  const cands = pool.length > 0 ? pool : [...valid];
  return [...cands].sort((a, b) => failCounts(b) - failCounts(a) || order.indexOf(a) - order.indexOf(b))[0];
}

export function ruleLakeClaim(obs: PlayerObservation, truth: Camp): Camp {
  if (obs.myTeam === 'good') return truth;
  return truth === 'good' ? 'evil' : 'good';
}

export function ruleAssassinate(obs: PlayerObservation): string {
  const evil = new Set(obs.allEvilIds ?? obs.knownEvils);
  const cands = obs.allPlayerIds.filter((id) => id !== obs.myPlayerId && !evil.has(id));
  const failCounts = (id: string): number =>
    obs.questHistory.filter((q) => q.result === 'fail' && q.team.includes(id)).length;
  // The rule baseline is a fixed yardstick: the pre-2026-10-22 reading of the
  // history (every vote, failed missions by outcome), whatever the agents' tuning.
  return [...cands].sort(
    (a, b) => estimateMerlinLikenessFromHistory(b, obs, LEGACY_BELIEF_OPTIONS) - estimateMerlinLikenessFromHistory(a, obs, LEGACY_BELIEF_OPTIONS)
      || failCounts(a) - failCounts(b)
      || obs.allPlayerIds.indexOf(a) - obs.allPlayerIds.indexOf(b),
  )[0];
}

// ── Replay ─────────────────────────────────────────────────────

export interface ReplayOptions {
  makeAgent: AgentFactory;
}

/**
 * Pinned card of an evil seat on `round`'s mission: 0 fails → success,
 * fails == #evil on team → fail, otherwise ambiguous (null).
 */
export function pinnedQuestCard(game: ReplayGame, round: number, seat: number): 'success' | 'fail' | null {
  const q = game.quests.find((x) => x.round === round);
  if (!q || !q.teamSeats.includes(seat) || campOf(game.seatRoles[seat - 1]) !== 'evil') return null;
  const evilOnTeam = q.teamSeats.filter((s) => campOf(game.seatRoles[s - 1]) === 'evil').length;
  if (q.failCount === 0) return 'success';
  if (q.failCount === evilOnTeam) return 'fail';
  return null;
}

/**
 * Replay every decision `seat` faced in `game` through one agent instance
 * (persistent across the game, like a GameServer bot) and score it.
 */
export function replaySeat(game: ReplayGame, seat: number, opts: ReplayOptions): DecisionOutcome[] {
  const out: DecisionOutcome[] = [];
  const id = seatId(seat);
  const role = game.seatRoles[seat - 1];
  const side = campOf(role);
  const name = game.names[seat - 1] ?? '';
  const base = { gameId: game.id, seat, name, role, side };
  const seedOf = (key: string): string => `${game.id}|${seat}|${key}`;

  const agent = opts.makeAgent(id);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));

  const act = (obs: PlayerObservation, key: string): AgentAction =>
    withSeededRandom(seedOf(key), () => agent.act(obs));

  let proposalIdx = 0;
  for (const quest of game.quests) {
    const round = quest.round;
    // ── Proposals of the round ──
    for (; proposalIdx < game.proposals.length && game.proposals[proposalIdx].round === round; proposalIdx++) {
      const p = game.proposals[proposalIdx];
      const humanTeam = p.teamSeats.map(seatId);
      if (p.leaderSeat === seat) {
        const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: proposalIdx });
        const action = act(obs, `team-${proposalIdx}`);
        const agentTeam = action.type === 'team_select' ? action.teamIds : [];
        const dTeam = defaultTeam(game, proposalIdx, obs);
        const rTeam = ruleTeam(obs);
        out.push({
          ...base,
          type: 'team',
          round,
          attempt: p.attempt,
          human: [...p.teamSeats].sort((a, b) => a - b).join(','),
          agent: agentTeam.map(seatOfId).sort((a, b) => a - b).join(','),
          match: sameSet(agentTeam, humanTeam),
          jaccard: jaccard(agentTeam, humanTeam),
          defaultMatch: sameSet(dTeam, humanTeam) ? 1 : 0,
          ruleMatch: sameSet(rTeam, humanTeam) ? 1 : 0,
          defaultJaccard: jaccard(dTeam, humanTeam),
          ruleJaccard: jaccard(rTeam, humanTeam),
          ...teamSituation(obs, humanTeam, agentTeam, p.attempt),
        });
      }
      if (!p.forced && p.votesReliable) {
        const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: proposalIdx });
        const action = act(obs, `vote-${proposalIdx}`);
        const agentVote = action.type === 'team_vote' ? action.vote : defaultVote(obs);
        const humanVote = p.votes[seat - 1];
        const onTeam = p.teamSeats.includes(seat);
        out.push({
          ...base,
          type: 'vote',
          round,
          attempt: p.attempt,
          human: humanVote ? 'approve' : 'reject',
          agent: agentVote ? 'approve' : 'reject',
          match: agentVote === humanVote,
          defaultMatch: defaultVote(obs) === humanVote ? 1 : 0,
          ruleMatch: ruleVote(obs) === humanVote ? 1 : 0,
          humanNonDefault: humanVote !== onTeam,
          agentNonDefault: agentVote !== onTeam,
          ...voteSituation(obs, p.leaderSeat === seat, humanVote, agentVote),
        });
      }
    }

    // ── Quest card ──
    const pinned = pinnedQuestCard(game, round, seat);
    if (pinned !== null) {
      const obs = buildReplayObservation(game, seat, { kind: 'quest_vote', round });
      const action = act(obs, `quest-${round}`);
      const agentCard = action.type === 'quest_vote' ? action.vote : 'success';
      const evilOnTeam = quest.teamSeats.filter((s) => campOf(game.seatRoles[s - 1]) === 'evil').length;
      out.push({
        ...base,
        type: 'quest',
        round,
        human: pinned,
        agent: agentCard,
        match: agentCard === pinned,
        defaultMatch: pinned === 'fail' ? 1 : 0,
        ruleMatch: ruleQuest(obs) === pinned ? 1 : 0,
        situation: `quest R${round} ${role} ${evilOnTeam === 1 ? 'solo' : `${evilOnTeam} evil on team`}`,
        divergence: agentCard === pinned ? 'match' : `human ${pinned} / agent ${agentCard}`,
      });
    }

    // ── Lady of the Lake after this round ──
    const lakeIdx = game.lakes.findIndex((l) => l.round === round);
    if (lakeIdx >= 0 && game.lakeChainValid && game.lakes[lakeIdx].holderSeat === seat) {
      const lake = game.lakes[lakeIdx];
      const obs = buildReplayObservation(game, seat, { kind: 'lake', lake: lakeIdx });
      const valid = validLakeTargetSeats(game, lakeIdx).map(seatId);
      const agentTarget = withSeededRandom(seedOf(`lake-${lakeIdx}`), () => agent.pickLakeTarget(obs, valid));
      const humanTarget = seatId(lake.targetSeat);
      out.push({
        ...base,
        type: 'lakeTarget',
        round,
        human: String(lake.targetSeat),
        agent: String(seatOfId(agentTarget)),
        match: agentTarget === humanTarget,
        defaultMatch: valid.length > 0 ? 1 / valid.length : 0,
        ruleMatch: ruleLakeTarget(obs, valid) === humanTarget ? 1 : 0,
        ...lakeTargetSituation(obs, humanTarget, agentTarget),
      });
      if (lake.claim !== null) {
        const truth = campOf(game.seatRoles[lake.targetSeat - 1]);
        const agentClaim = withSeededRandom(
          seedOf(`claim-${lakeIdx}`),
          () => agent.declareLake(obs, humanTarget, truth),
        );
        const targetKind = side === 'evil'
          ? (obs.knownEvils.includes(humanTarget) ? 'ally' : truth === 'evil' ? 'hidden-evil' : 'opponent')
          : `target ${truth}`;
        out.push({
          ...base,
          type: 'lakeClaim',
          round,
          human: lake.claim,
          agent: agentClaim ?? 'none',
          match: agentClaim === lake.claim,
          defaultMatch: lake.claim === truth ? 1 : 0,
          ruleMatch: ruleLakeClaim(obs, truth) === lake.claim ? 1 : 0,
          situation: `lakeClaim ${side} ${targetKind} (truth ${truth})`,
          divergence: agentClaim === lake.claim ? 'match' : `human ${lake.claim} / agent ${agentClaim ?? 'none'}`,
        });
      }
    }
  }

  // ── Assassination ──
  if (role === 'assassin' && game.assassinTargetSeat !== undefined) {
    const obs = buildReplayObservation(game, seat, { kind: 'assassination' });
    const action = act(obs, 'assassinate');
    const agentTarget = action.type === 'assassinate' ? action.targetId : '';
    const humanTarget = seatId(game.assassinTargetSeat);
    const merlin = seatId(game.seatRoles.indexOf('merlin') + 1);
    const goodCount = game.seatRoles.filter((r) => campOf(r) === 'good').length;
    out.push({
      ...base,
      type: 'assassinate',
      round: game.quests.length,
      human: String(game.assassinTargetSeat),
      agent: agentTarget ? String(seatOfId(agentTarget)) : '',
      match: agentTarget === humanTarget,
      defaultMatch: 1 / goodCount,
      ruleMatch: ruleAssassinate(obs) === humanTarget ? 1 : 0,
      humanHitMerlin: humanTarget === merlin,
      agentHitMerlin: agentTarget === merlin,
      situation: 'assassinate',
      divergence: agentTarget === humanTarget
        ? 'match'
        : `human ${humanTarget === merlin ? 'hit' : 'miss'} / agent ${agentTarget === merlin ? 'hit' : 'miss'}`,
    });
  }
  return out;
}

/** Replay every requested seat of a game. */
export function replayGame(game: ReplayGame, seats: readonly number[], opts: ReplayOptions): DecisionOutcome[] {
  return seats.flatMap((seat) => replaySeat(game, seat, opts));
}

// ── Situation buckets ──────────────────────────────────────────

interface Situated {
  situation: string;
  divergence: string;
}

function teamSituation(
  obs: PlayerObservation,
  human: readonly string[],
  agent: readonly string[],
  attempt: number,
): Situated {
  const situation = `team ${obs.currentRound === 1 ? `R1-P${attempt}` : roundBucket(obs.currentRound)} ${obs.myTeam}`;
  if (sameSet(human, agent)) return { situation, divergence: 'match' };
  const self = obs.myPlayerId;
  if (!human.includes(self)) return { situation, divergence: 'human leaves self off' };
  const tainted = failedMissionMembers(obs);
  const taint = (team: readonly string[]): number => team.filter((id) => id !== self && tainted.has(id)).length;
  if (taint(agent) > taint(human)) return { situation, divergence: 'agent adds failed-mission member' };
  if (taint(human) > taint(agent)) return { situation, divergence: 'human adds failed-mission member' };
  if (obs.myTeam === 'evil') {
    const allies = (team: readonly string[]): number => team.filter((id) => obs.knownEvils.includes(id)).length;
    if (allies(human) > allies(agent)) return { situation, divergence: 'human adds an ally' };
    if (allies(agent) > allies(human)) return { situation, divergence: 'agent adds an ally' };
  }
  const inter = human.filter((id) => agent.includes(id)).length;
  return { situation, divergence: `differs by ${human.length - inter} member(s)` };
}

function voteSituation(
  obs: PlayerObservation,
  isLeader: boolean,
  human: boolean,
  agent: boolean,
): Situated {
  const self = obs.myPlayerId;
  const onTeam = obs.proposedTeam.includes(self);
  const pos = isLeader ? (onTeam ? 'leader' : 'leader off-team') : onTeam ? 'on-team' : 'off-team';
  const tainted = failedMissionMembers(obs);
  const taint = obs.proposedTeam.some((id) => id !== self && tainted.has(id)) ? 'tainted team' : 'clean team';
  const v = (x: boolean): string => (x ? 'approve' : 'reject');
  return {
    situation: `vote ${roundBucket(obs.currentRound)} ${obs.myTeam} ${pos}, ${taint}`,
    divergence: human === agent ? 'match' : `human ${v(human)} / agent ${v(agent)}`,
  };
}

function lakeTargetSituation(obs: PlayerObservation, human: string, agent: string): Situated {
  const tainted = failedMissionMembers(obs);
  const kind = (id: string): string => {
    if (obs.myTeam === 'evil' && obs.knownEvils.includes(id)) return 'ally';
    if (obs.knownWizards?.includes(id)) return 'wizard';
    return tainted.has(id) ? 'failed-mission member' : 'clean seat';
  };
  const situation = `lakeTarget ${obs.myTeam} R${obs.currentRound}`;
  if (human === agent) return { situation, divergence: 'match' };
  return { situation, divergence: `human ${kind(human)} / agent ${kind(agent)}` };
}
