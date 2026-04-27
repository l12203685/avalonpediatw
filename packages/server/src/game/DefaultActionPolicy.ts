/**
 * Default-action policy registry + resolver for async ("棋瓦" / Avalon
 * Chess) games.
 *
 * Async games can pause indefinitely between phases (Edward 永不棄局).
 * To prevent a single absentee from freezing the table, players opt
 * in to a default policy: "if I'm not back in T_DEFAULT_GRACE, apply
 * this default automatically and advance the phase."
 *
 * This module is **pure**: it owns the in-memory registry and a
 * single resolver function. The engine wiring (when to call
 * `resolveDefaultAction`, how to emit `vote_auto_filled`, how to
 * trigger a phase-advance check) is intentionally NOT done here so
 * P3 can ship without conflicting with the parallel P2 AsyncNotifier
 * work that touches the GameEngine event emit path.
 *
 * Safety invariants — DO NOT WEAKEN:
 *   1. Evil players are NEVER auto-defaulted on a quest vote. Every
 *      branch returns `null` (= must prompt) when the actor's role is
 *      on the evil side. Auto-failing as evil silently leaks role
 *      information; auto-succeeding as evil removes a strategic
 *      choice. Both are unacceptable. See spec section 4 of
 *      `staging/subagent_results/async_avalon_design_2026-04-26.md`.
 *   2. `voteOnTeam = 'normal'` MUST mirror the realtime AFK fallback
 *      rule (`team_in_approve_team_out_reject`, GameEngine
 *      `handleVoteTimeout`). If that rule changes upstream, update
 *      this resolver in lock-step.
 *   3. `T_DEFAULT_GRACE_MS` is a soft window; the engine decides
 *      WHEN to actually call the resolver. The resolver itself does
 *      not check the grace — it returns the policy decision (or
 *      null) for the caller to act on.
 *
 * Memory: feedback_avalon_async_default_safety.md (to be written if
 * this rule is ever questioned).
 */

import type {
  DefaultActionPolicy,
  DefaultActionScope,
  GameState,
  Role,
  Team,
} from '@avalon/shared';

/**
 * Default grace window between phase open and auto-default firing.
 * Configurable per room in a future change; hard-coded for P3 ship.
 *
 * 6 hours = enough for one work day's gap, short enough that abandoned
 * games still progress. Edward original example: "我不在的時候投正常票,
 * 直到該回合任務結果出來".
 */
export const T_DEFAULT_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * Sides for safety classification. Mirrors `@avalon/shared` Role groups
 * but kept local to avoid pulling in the full role catalogue here.
 *
 * Loyal side: merlin, percival, loyal.
 * Evil side : assassin, morgana, mordred, oberon, minion.
 */
const EVIL_ROLES: ReadonlySet<Role> = new Set<Role>([
  'assassin',
  'morgana',
  'mordred',
  'oberon',
  'minion',
]);

/** Returns 'good' or 'evil' for any canonical (or legacy) Avalon role. */
export function teamForRole(role: Role): Team {
  return EVIL_ROLES.has(role) ? 'evil' : 'good';
}

/**
 * Phase the engine is asking about. Subset of GameState that admits an
 * auto-default action. (LADY / ASSASSINATE never auto-default — those
 * are intrinsically high-information actions.)
 */
export type DefaultActionPhase = 'team_vote' | 'quest_vote';

/**
 * Result of resolving a default-action decision.
 *
 *   - `null`: the resolver declines — engine MUST prompt the player
 *     (covers safety blocks, expired policies, missing fields, etc.).
 *   - `{ kind: 'team_vote', vote: boolean }`: apply this team-vote.
 *   - `{ kind: 'quest_vote', vote: 'success' | 'fail' }`: apply this
 *     quest-vote.
 */
export type ResolvedDefaultAction =
  | { kind: 'team_vote'; vote: boolean }
  | { kind: 'quest_vote'; vote: 'success' | 'fail' };

/**
 * Reason the resolver returned `null`. Useful for engine logging /
 * UI surfacing without leaking role info to other players.
 */
export type DeclineReason =
  | 'no_policy'
  | 'expired'
  | 'no_field_for_phase'
  | 'evil_quest_safety'
  | 'one_shot_consumed';

export interface DeclineDetail {
  reason: DeclineReason;
  message: string;
}

/**
 * In-memory policy registry. Keyed by `${gameId}:${playerId}` so a
 * player can hold different policies in concurrent async games (Edward
 * 多局並行 P2 future use). The `gameId` may be the room id today; the
 * key prefix exists so the future Firestore-backed registry can shard
 * the same way.
 */
type PolicyKey = string;
const registry: Map<PolicyKey, DefaultActionPolicy> = new Map();

function makeKey(gameId: string, playerId: string): PolicyKey {
  return `${gameId}:${playerId}`;
}

/**
 * Set / replace a player's policy in `gameId`. Returns the stored
 * policy (echoed back so callers can confirm `setAt`).
 *
 * Immutability: the stored object is a fresh shallow copy — callers
 * may mutate their input freely after the call.
 */
export function setPolicy(
  gameId: string,
  policy: Omit<DefaultActionPolicy, 'setAt'> & { setAt?: number },
): DefaultActionPolicy {
  const stored: DefaultActionPolicy = {
    playerId: policy.playerId,
    voteOnTeam: policy.voteOnTeam,
    questVote: policy.questVote,
    scope: policy.scope,
    expiresAt: policy.expiresAt,
    setAt: policy.setAt ?? Date.now(),
  };
  registry.set(makeKey(gameId, policy.playerId), stored);
  return stored;
}

/** Returns the active policy for `playerId` in `gameId`, or undefined. */
export function getPolicy(
  gameId: string,
  playerId: string,
): DefaultActionPolicy | undefined {
  return registry.get(makeKey(gameId, playerId));
}

/**
 * Drop the policy for `playerId` in `gameId`. Returns true if a policy
 * was removed (idempotent — false if none was set).
 */
export function clearPolicy(gameId: string, playerId: string): boolean {
  return registry.delete(makeKey(gameId, playerId));
}

/**
 * Drop EVERY policy stored against `gameId`. Called when an async game
 * ends so we don't leak state across game lifecycles.
 */
export function clearGamePolicies(gameId: string): void {
  for (const key of registry.keys()) {
    if (key.startsWith(`${gameId}:`)) {
      registry.delete(key);
    }
  }
}

/**
 * Test-only helper: nuke the entire registry. Production code MUST NOT
 * call this — it would wipe live games.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}

/**
 * Snapshot of game progress used by the resolver to evaluate scope
 * expiration. Engine passes this rather than the full Room so the
 * resolver stays decoupled from Room shape evolution.
 */
export interface PolicyContext {
  gameId: string;
  /** Current quest round (1..5). */
  currentRound: number;
  /**
   * True iff the current quest's result has been recorded (quest
   * succeeded or failed). The engine sets this AFTER the quest vote
   * resolves. Used by `until_quest_result` scope.
   */
  questResultKnown: boolean;
  /**
   * True iff the game has reached terminal state ('ended'). Used to
   * short-circuit the resolver — no auto-default ever applies after
   * the game has ended.
   */
  gameEnded: boolean;
  /** `Date.now()` at decision time, injected for testability. */
  now: number;
}

/**
 * Decide whether `policy` is still active given `ctx`.
 *
 * Returns `null` if active. Returns a `DeclineDetail` describing why
 * the policy is stale otherwise. Callers downstream return that same
 * decline (so the engine can prompt + optionally clear the policy).
 */
function checkScope(
  policy: DefaultActionPolicy,
  ctx: PolicyContext,
): DeclineDetail | null {
  if (ctx.gameEnded) {
    return { reason: 'expired', message: 'Game ended' };
  }
  if (policy.expiresAt !== undefined && ctx.now > policy.expiresAt) {
    return { reason: 'expired', message: 'Absolute expiresAt elapsed' };
  }
  switch (policy.scope) {
    case 'until_quest_result':
      return ctx.questResultKnown
        ? { reason: 'expired', message: 'Quest result known' }
        : null;
    case 'until_round_end':
      // until_round_end scope auto-clears at round transition; the
      // engine MUST call clearPolicy() in that hook. We treat
      // questResultKnown as a proxy here for the resolver layer (the
      // round ends exactly after the quest result is recorded — a
      // round in Avalon = one resolved quest).
      return ctx.questResultKnown
        ? { reason: 'expired', message: 'Round ended' }
        : null;
    case 'until_game_end':
      // Stays active until the game ends; the gameEnded check above
      // handles termination.
      return null;
    case 'one_shot':
      // The resolver itself does not consume one_shot — the engine
      // does so by calling clearPolicy() after acting on the
      // returned decision. This branch always reports active.
      return null;
    default: {
      // Defensive: unknown scope = decline.
      const exhaustive: never = policy.scope;
      return {
        reason: 'expired',
        message: `Unknown scope: ${exhaustive as string}`,
      };
    }
  }
}

/**
 * Pure resolver — given a policy, role, phase, and current quest team
 * membership, return the action to apply OR `null` if the engine must
 * prompt.
 *
 * SAFETY: evil quest votes ALWAYS return null (with reason
 * 'evil_quest_safety') regardless of the policy `questVote` value.
 * This is the single line that prevents an evil silently auto-failing
 * a quest. Removing or weakening this branch is a security regression.
 *
 * @param policy   The player's stored policy.
 * @param role     Their assigned role this game (used for safety side).
 * @param phase    Which decision the engine is asking about.
 * @param ctx      Game-progress snapshot for scope checks.
 * @param isOnTeam For `team_vote`: whether the player is on the
 *                 currently proposed quest team. Required for
 *                 `voteOnTeam = 'normal'`. Ignored for `quest_vote`.
 * @returns        The action to apply, or null + DeclineDetail if not.
 */
export function resolveDefaultAction(
  policy: DefaultActionPolicy | undefined,
  role: Role,
  phase: DefaultActionPhase,
  ctx: PolicyContext,
  isOnTeam: boolean = false,
): { action: ResolvedDefaultAction } | { decline: DeclineDetail } {
  if (!policy) {
    return { decline: { reason: 'no_policy', message: 'No policy set' } };
  }

  const scopeDecline = checkScope(policy, ctx);
  if (scopeDecline) {
    return { decline: scopeDecline };
  }

  if (phase === 'team_vote') {
    if (policy.voteOnTeam === undefined) {
      return {
        decline: {
          reason: 'no_field_for_phase',
          message: 'No voteOnTeam in policy',
        },
      };
    }
    let vote: boolean;
    switch (policy.voteOnTeam) {
      case 'approve':
        vote = true;
        break;
      case 'reject':
        vote = false;
        break;
      case 'normal':
        // Mirror realtime AFK rule (GameEngine.handleVoteTimeout):
        // team-in → approve, team-out → reject.
        vote = isOnTeam;
        break;
      default: {
        const exhaustive: never = policy.voteOnTeam;
        return {
          decline: {
            reason: 'no_field_for_phase',
            message: `Unknown voteOnTeam: ${exhaustive as string}`,
          },
        };
      }
    }
    return { action: { kind: 'team_vote', vote } };
  }

  // phase === 'quest_vote'
  if (policy.questVote === undefined) {
    return {
      decline: {
        reason: 'no_field_for_phase',
        message: 'No questVote in policy',
      },
    };
  }

  // SAFETY GATE: evil players are NEVER auto-defaulted on quest votes.
  // Engine MUST prompt; do not log the role to avoid leaking it
  // through any error surface.
  const side = teamForRole(role);
  if (side === 'evil') {
    return {
      decline: {
        reason: 'evil_quest_safety',
        message: 'Evil players are never auto-defaulted on quest votes',
      },
    };
  }

  // Loyal side from here on.
  let questVote: 'success' | 'fail';
  switch (policy.questVote) {
    case 'success':
      questVote = 'success';
      break;
    case 'fail':
      // Loyal cannot vote fail (engine rejects). A loyal policy
      // requesting 'fail' is nonsensical — decline so the player is
      // prompted and can correct it.
      return {
        decline: {
          reason: 'no_field_for_phase',
          message: 'Loyal cannot quest-vote fail',
        },
      };
    case 'role_aware':
      // Loyal default: success. (Evil branch was already handled above.)
      questVote = 'success';
      break;
    default: {
      const exhaustive: never = policy.questVote;
      return {
        decline: {
          reason: 'no_field_for_phase',
          message: `Unknown questVote: ${exhaustive as string}`,
        },
      };
    }
  }
  return { action: { kind: 'quest_vote', vote: questVote } };
}

/**
 * Convenience: phase the engine is opening, mapped to the resolver's
 * phase enum. Returns null for phases that never auto-default.
 */
export function gameStateToDefaultPhase(
  state: GameState,
  questTeamPicked: boolean,
): DefaultActionPhase | null {
  if (state === 'voting' && questTeamPicked) return 'team_vote';
  if (state === 'quest') return 'quest_vote';
  return null;
}

/**
 * Build the snapshot payload the engine will eventually emit alongside
 * the auto-applied action. The engine wires this into a
 * `vote_auto_filled` event with `reason: 'async_default_policy'` so
 * replay / analytics can distinguish human submissions from policy
 * defaults.
 *
 * Pure: no side effects, no event emission. Engine owns the actual
 * `logEvent` call to keep this module wiring-free.
 */
export interface AutoFillEventPayload {
  playerId: string;
  phase: DefaultActionPhase;
  action: ResolvedDefaultAction;
  policyScope: DefaultActionScope;
  reason: 'async_default_policy';
  appliedAt: number;
}

export function buildAutoFillEvent(
  policy: DefaultActionPolicy,
  phase: DefaultActionPhase,
  action: ResolvedDefaultAction,
  appliedAt: number,
): AutoFillEventPayload {
  return {
    playerId: policy.playerId,
    phase,
    action,
    policyScope: policy.scope,
    reason: 'async_default_policy',
    appliedAt,
  };
}
