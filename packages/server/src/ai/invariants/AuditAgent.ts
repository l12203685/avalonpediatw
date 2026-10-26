/**
 * AuditAgent — wraps the production bot and records every decision with the
 * observation it was made on (logic-first plan §5.2; same pattern as
 * `SwitchAgent` in scripts/selfPlayStrength.ts).
 *
 * The decision is exactly the production one: `HeuristicAgent.act` ingests
 * the public history into the agent's memory and routes the decision to a
 * fresh, stateless `ForwardAgent` (USE_FORWARD_REASONING). Here the
 * ForwardAgent is called directly — identical decisions, and it also works
 * under vitest, where the lazy `require` behind `HeuristicAgent.act` cannot
 * load the module and would silently fall back to the baseline. The lake
 * decisions go through the agent-level lake API (`pickLakeTarget` /
 * `declareLake`), which `SelfPlayEngine` and `GameServer` call the same way.
 *
 * Math.random is reseeded per decision from (game seed, seat, decision
 * context), so a run is deterministic and the same observation always gets
 * the same draws.
 */

import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../HeuristicAgent';
import { ForwardAgent } from '../forward/ForwardAgent';
import { withSeededRandom } from '../benchmark/agreement';
import type { AgentTuning } from '../AgentTuning';
import { goodLakeAvoidSet } from '../LakePolicy';
import type { AgentAction, AvalonAgent, PlayerObservation } from '../types';

export type DecisionKind = 'team_select' | 'team_vote' | 'quest_vote' | 'assassinate' | 'lake_target' | 'lake_claim';

export interface DecisionRecord {
  kind: DecisionKind;
  obs: PlayerObservation;
  /** team_select / team_vote / quest_vote / assassinate. */
  action?: AgentAction;
  /** lake_target: the chosen target; lake_claim: the inspected target. */
  lakeTarget?: string;
  /** lake_target: the legal targets offered. */
  validTargets?: readonly string[];
  /** lake_target, good holder: the avoid set the deciding agent's tuning uses (INV-PL, structural). */
  lakeAvoid?: readonly string[];
  /**
   * lake_target, Percival: the target the same lake policy picks, under the
   * same draws, for a LOYAL holding Percival's built-in fact (the same
   * observation with the role loyal, the thumbs kept as the "exactly one is
   * red" constraint) — INV-PL2, the behavioural check of the blue lake.
   */
  lakeAsLoyal?: string;
  /** lake_claim: the public claim (`null` = no declaration). */
  lakeClaim?: 'good' | 'evil' | null;
  /** lake_claim: the target's real camp (what the holder saw). */
  lakeTruth?: 'good' | 'evil';
  /** team_select: seats the ForwardAgent hard-excluded (seat → severity). */
  exclusions?: ReadonlyMap<string, number>;
  usedFallback?: boolean;
  /** Replay only: what the human did at the same point. */
  human?: { team?: readonly string[]; vote?: boolean; claim?: 'good' | 'evil' | null; target?: string };
  /** Replay only: the decision point's vote record was reconstructed. */
  unreliable?: boolean;
}

export class AuditAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  readonly base: HeuristicAgent;
  private readonly fwd: ForwardAgent;
  /** Recorded decisions of the current game. */
  readonly records: DecisionRecord[] = [];
  /** Prefix of every decision seed (self-play: `${seed}|${game}`). */
  gameSeed = '';
  role: Role | undefined;
  team: 'good' | 'evil' | undefined;

  constructor(agentId: string, tuning: AgentTuning) {
    this.agentId = agentId;
    this.base = new HeuristicAgent(agentId, undefined, undefined, tuning);
    this.fwd = new ForwardAgent(agentId, this.base);
  }

  onGameStart(obs: PlayerObservation): void {
    this.records.length = 0;
    this.role = obs.myRole;
    this.team = obs.myTeam;
    this.fwd.onGameStart(obs);
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    this.base.onGameEnd(obs, won);
  }

  /** Self-play seed of an observation (same fields as SwitchAgent). */
  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [
      this.gameSeed,
      obs.myPlayerId,
      obs.gamePhase,
      `R${obs.currentRound}`,
      `A${obs.failCount}`,
      `V${obs.voteHistory.length}`,
      `Q${obs.questHistory.length}`,
      `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','),
      extra,
    ].join('|');
  }

  /** The production decision on `obs` under the PRNG seeded from `seed`. */
  decideSeeded(obs: PlayerObservation, seed: string): DecisionRecord {
    return withSeededRandom(seed, () => {
      this.base._ingestForTesting(obs);
      const d = this.fwd.decide(obs);
      const rec: DecisionRecord = {
        kind: obs.gamePhase === 'assassination' ? 'assassinate' : obs.gamePhase,
        obs,
        action: d.action,
        usedFallback: d.reasoningTrace.usedFallback,
      };
      if (obs.gamePhase === 'team_select') rec.exclusions = this.fwd.lastTeamExclusions();
      this.records.push(rec);
      return rec;
    });
  }

  act(obs: PlayerObservation): AgentAction {
    const rec = this.decideSeeded(obs, this.seedFor(obs));
    return rec.action as AgentAction;
  }

  pickLakeTargetSeeded(obs: PlayerObservation, validTargets: readonly string[] | undefined, seed: string): DecisionRecord {
    const target = withSeededRandom(seed, () => this.base.pickLakeTarget(obs, validTargets));
    const rec: DecisionRecord = {
      kind: 'lake_target',
      obs,
      lakeTarget: target,
      validTargets: validTargets ? [...validTargets] : undefined,
      lakeAvoid: obs.myTeam === 'good' ? [...goodLakeAvoidSet(obs, this.base.tuning)] : undefined,
    };
    if (obs.myRole === 'percival') {
      const asLoyal: PlayerObservation = { ...obs, myRole: 'loyal' };
      rec.lakeAsLoyal = withSeededRandom(seed, () => this.base.pickLakeTarget(asLoyal, validTargets));
    }
    this.records.push(rec);
    return rec;
  }

  declareLakeSeeded(
    obs: PlayerObservation,
    targetId: string,
    trueFaction: 'good' | 'evil' | undefined,
    seed: string,
  ): DecisionRecord {
    const claim = withSeededRandom(seed, () => this.base.declareLake(obs, targetId, trueFaction));
    const rec: DecisionRecord = { kind: 'lake_claim', obs, lakeTarget: targetId, lakeClaim: claim, lakeTruth: trueFaction };
    this.records.push(rec);
    return rec;
  }

  // Agent-level lake API (`LakePolicy.hasLakeApi`), used by SelfPlayEngine.
  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    return this.pickLakeTargetSeeded(obs, validTargets, this.seedFor(obs, 'lake')).lakeTarget as string;
  }

  declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    return this.declareLakeSeeded(obs, targetId, trueFaction, this.seedFor(obs, `claim-${targetId}`)).lakeClaim ?? null;
  }
}
