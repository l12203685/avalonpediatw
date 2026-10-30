/**
 * Invariant checks (logic-first plan §5; catalog in `catalog.ts`).
 *
 * Every verdict reads only the deciding seat's own observation, through the
 * certainty layer (`belief/Certainty.ts`). Ground truth (`Truth`) is used
 * for diagnostic columns and for choosing which holders are "honest blue"
 * (INV-H3b) — never to decide what a seat could have known.
 *
 * Every check that reads the pyramid or the 硬3 rule takes the belief
 * switches of the tuning under test (`BeliefOptions`, batch 1C), so the
 * harness measures the agent it runs.
 *
 * Besides the catalog tallies the checks keep diagnostic counters named
 * after `logic_audit.md`'s script (`T.*`, `V.*`, `O.*`, `R3.*`, `L.*`,
 * `A.*`, `Q.*`, `B.*`, `order.*`, `X5chk.*`). They are computed with the
 * audit's own world model (no own lake results, A0 on the seat's own
 * declarations too) so a first run can be checked against the audit's
 * numbers line by line.
 */

import { doomedProposal } from '../MerlinCover';
import { computePyramidScores } from '../baseline/pyramidScorer';
import {
  analyzeLakeChain,
  findRule3Violators,
  findTeamHardRuleViolations,
  setRule3DiagnosticOptions,
} from '../baseline/lakeChainTracker';
import {
  CERTAINTY_EPS,
  CertaintyView,
  certaintyParamsFor,
  claimPossibleForGoodHolder,
  declaredLakes,
  enumerateWorlds,
  popcount,
} from '../belief/Certainty';
import { defaultBeliefOptions, type BeliefOptions } from '../belief/BeliefOptions';
import { goodLakeAvoidSet } from '../LakePolicy';
import {
  PERCIVAL_NO_THUMBS_R1_MAX_PLAYERS,
  PERCIVAL_NO_THUMBS_R1_MIN_PLAYERS,
  percivalR1IncludedThumb,
} from '../PercivalThumbs';
import { inferRedsFromTaskFails } from '../forward/ForwardAgent';
import { AVALON_CONFIG } from '@avalon/shared';
import { isAssassinator } from '../../game/assassinator';
import type { PlayerObservation } from '../types';
import type { DecisionRecord } from './AuditAgent';
import { certaintyOf, cutAtLake, isForcedProposal, publicCertaintyOf, type Truth } from './context';
import type { Ledger } from './ledger';

/** ε of INV-B2 (the pin value of `pyramidScorer` and the check share `Certainty.CERTAINTY_EPS`). */
export { CERTAINTY_EPS };

const rb = (round: number): string => (round <= 2 ? 'R1-2' : 'R3+');
const R12 = 'R1-R2 normal vote (D3)';
const FORCED = 'forced 5th proposal';
const TWO_FAILS = 'two fails needed (R4)';
/** Edward 2026-10-30：梅林「正常票內白」（自己在隊上時照忠臣贊成）沒有任何問題 — INV-V1 不算違規。 */
const MERLIN_ON_TEAM = 'Merlin on-team normal vote (owner 10/30)';
const L1_EMPTY = 'L1 empty (L0 fallback)';
/** The 10/26 conventions contradicted the table and were dropped (`enumerateL1`): what they proved is not proved. */
const CONVENTIONS_DROPPED = 'A1/A2 contradicted (A0 only)';
const PINNED = 'pinned by a certainty';

// ── The audit's world model (diagnostics only) ─────────────────

interface AuditViews { v0: CertaintyView; v1: CertaintyView }
const auditCache = new WeakMap<PlayerObservation, AuditViews>();

/** logicAudit.ts `viewOf`: own camp + role sight + fail counts (+ A0 on every declared lake). */
function auditViews(obs: PlayerObservation): AuditViews {
  let v = auditCache.get(obs);
  if (!v) {
    const params = certaintyParamsFor(obs);
    const l0 = enumerateWorlds(obs, { self: 'own', sight: true, ownLakeResults: false, lakes: false }, params);
    const l1 = enumerateWorlds(obs, { self: 'own', sight: true, ownLakeResults: false, lakes: true }, params);
    v = { v0: new CertaintyView(obs, l0, l0, params), v1: new CertaintyView(obs, l1, l1, params) };
    auditCache.set(obs, v);
  }
  return v;
}

function minRedsOrNone(view: CertaintyView, team: readonly string[]): number {
  return view.minReds(team, 'L1');
}

// ── Shared predicates ──────────────────────────────────────────

/** The owner's R1 no-thumb rule applies (6–10 players, two thumbs, R1). */
export function percivalR1RuleApplies(obs: PlayerObservation): boolean {
  return (
    obs.myRole === 'percival' &&
    obs.playerCount >= PERCIVAL_NO_THUMBS_R1_MIN_PLAYERS &&
    obs.playerCount <= PERCIVAL_NO_THUMBS_R1_MAX_PLAYERS &&
    (obs.currentRound ?? 1) === 1 &&
    (obs.knownWizards?.length ?? 0) === 2
  );
}

/** Seats that declared this seat red (an accuser is red under A0, P3). */
function accusersOf(obs: PlayerObservation): string[] {
  return declaredLakes(obs.lakeHistory)
    .filter((l) => l.targetId === obs.myPlayerId && l.declaredClaim === 'evil')
    .map((l) => l.holderId);
}

/** Seats this seat itself declared red. */
function ownDeclaredRed(obs: PlayerObservation): string[] {
  return declaredLakes(obs.lakeHistory)
    .filter((l) => l.holderId === obs.myPlayerId && l.declaredClaim === 'evil')
    .map((l) => l.targetId);
}

/** The vote-rule exemptions shared by the voting invariants. */
function voteExemption(obs: PlayerObservation, view: CertaintyView, needOneFail: boolean): string | undefined {
  if (isForcedProposal(obs)) return FORCED;
  if (obs.currentRound <= 2) return R12;
  if (needOneFail && view.failsRequired(obs.currentRound) !== 1) return TWO_FAILS;
  return undefined;
}

// ── INV-W1: the certainty layer itself ─────────────────────────

/** Recheck every kept world from scratch (C2, sight, own results; L1 ⊆ L0). */
function worldsSound(obs: PlayerObservation, view: CertaintyView): boolean {
  const self = view.bitOf(obs.myPlayerId);
  const known = view.maskOf(obs.knownEvils);
  const thumbs = obs.knownWizards ?? [];
  const thumbMask = view.maskOf(thumbs);
  const quests = obs.questHistory.map((q) => ({ m: view.maskOf(q.team), f: q.failCount ?? 0 }));
  const own = (obs.myLakeResults ?? []).map((r) => ({ t: view.bitOf(r.targetId), evil: r.result === 'evil' }));
  const l0 = new Set(view.l0);
  const ok = (w: number): boolean => {
    if (obs.myTeam === 'good' ? (w & self) !== 0 : (w & self) === 0) return false;
    if ((w & known) !== known) return false;
    if (thumbs.length >= 2 && popcount(w & thumbMask) !== 1) return false;
    if (thumbs.length === 1 && (w & thumbMask) !== 0) return false;
    for (const q of quests) if (popcount(w & q.m) < q.f) return false;
    for (const r of own) if (r.t !== 0 && ((w & r.t) !== 0) !== r.evil) return false;
    return popcount(w) === view.params.evilCount;
  };
  for (const w of view.l0) if (!ok(w)) return false;
  for (const w of view.l1) if (!ok(w) || !l0.has(w)) return false;
  return true;
}

function checkWorlds(obs: PlayerObservation, L: Ledger, truth?: Truth): CertaintyView {
  const view = certaintyOf(obs);
  let violated = !worldsSound(obs, view);
  if (truth) {
    const t = view.maskOf([...truth.evil]);
    if (!view.l0.includes(t)) violated = true;
    if (!view.l1Empty && !view.l1.includes(t)) L.inc('W1.truthOutsideL1 (A0 broken by a good holder)');
  }
  L.record('INV-W1', { violated });
  if (obs.myTeam === 'good') {
    L.inc('W1.goodDecisions');
    if (view.l1Empty) L.inc('W1.goodDecisions.l1Empty');
  }
  return view;
}

// ── INV-A2's own classifier ────────────────────────────────────

const EVIL_ROLE_NAMES: ReadonlySet<string> = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

/** Distinct orderings of a multiset (small: at most four reds). */
function multisetPermutations(items: readonly string[]): string[][] {
  if (items.length <= 1) return [[...items]];
  const out: string[][] = [];
  const seen = new Set<string>();
  items.forEach((x, i) => {
    if (seen.has(x)) return;
    seen.add(x);
    for (const rest of multisetPermutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * The candidates INV-A2 flags, computed WITHOUT the agent's classifier
 * (2026-10-26 review: the check used `visibleRedEvidence`, so 0 violations
 * only showed that the tier is wired in). Written from the game rules: the
 * assassinator sees its teammates (every red but Oberon) without their roles
 * and, at the assassination, the whole red roster (`allEvilIds`); Merlin sees
 * every red but Mordred. Every assignment of the lobby's red roles
 * (`lobbyRoles`, else the standard table) to the seen teammates is
 * enumerated; a lead certainly holds a red Merlin sees iff it does in every
 * assignment. Leads count from R1 on every proposal, the forced fifth included
 * (Edward 2026-10-26).
 * `null` when the roster does not fit the lobby (counted, not checked).
 */
function a2FlaggedIndependently(obs: PlayerObservation, candidates: readonly string[], ignoreDoomed = false): Set<string> | null {
  // Edward 2026-10-28 (round 2, B): the non-forced R1–R2 proposals the normal votes always reject do not count.
  if (ignoreDoomed) obs = { ...obs, voteHistory: obs.voteHistory.filter((v) => !(v.round <= 2 && v.attempt < 5)) };
  // 刺殺階段紅方開牌相認 (Edward 2026-10-26): with the reds' roles known, a lead certainly holds a red
  // Merlin sees iff it holds a red who is not Mordred.
  if (obs.allEvilRoles) {
    const seen = new Set(Object.entries(obs.allEvilRoles).filter(([, r]) => r !== 'mordred').map(([id]) => id));
    const flagged = new Set<string>();
    const cand = new Set(candidates);
    for (const v of obs.voteHistory) if (cand.has(v.leader) && v.team.some((id) => seen.has(id))) flagged.add(v.leader);
    return flagged;
  }
  const me = obs.myPlayerId;
  const reds = new Set<string>([...(obs.allEvilIds ?? []), ...obs.knownEvils, me]);
  const mates = obs.knownEvils.filter((id) => id !== me);
  const hidden = [...reds].filter((id) => id !== me && !mates.includes(id));
  const pool = [...(obs.lobbyRoles ?? AVALON_CONFIG[obs.playerCount]?.roles ?? [])].filter((r) => EVIL_ROLE_NAMES.has(r));
  const drop = (role: string): boolean => {
    const i = pool.indexOf(role as never);
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  if (!drop(obs.myRole)) return null;
  for (let i = 0; i < hidden.length; i++) if (!drop('oberon')) return null;
  if (pool.length !== mates.length) return null;
  const visibleSets = multisetPermutations(pool.map(String)).map((roles) => {
    const vis = new Set<string>();
    if (obs.myRole !== 'mordred') vis.add(me);
    for (const id of hidden) vis.add(id); // Oberon: Merlin sees him
    mates.forEach((id, i) => { if (roles[i] !== 'mordred') vis.add(id); });
    return vis;
  });
  const flagged = new Set<string>();
  const cand = new Set(candidates);
  for (const v of obs.voteHistory) {
    if (!cand.has(v.leader)) continue;
    if (visibleSets.every((vis) => v.team.some((id) => vis.has(id)))) flagged.add(v.leader);
  }
  return flagged;
}

// ── Decision checks ────────────────────────────────────────────

/**
 * Check one recorded decision. Returns whether the seat's L1 was empty (the
 * source logs INV-W2 per game).
 */
export function checkDecision(
  rec: DecisionRecord,
  L: Ledger,
  truth?: Truth,
  opts: Readonly<BeliefOptions> = defaultBeliefOptions(),
): boolean {
  const obs = rec.obs;
  const view = checkWorlds(obs, L, truth);
  const good = obs.myTeam === 'good';
  const round = obs.currentRound;
  const me = obs.myPlayerId;
  const unreliable = rec.unreliable === true;
  if (rec.usedFallback) L.inc('forward.fallbacks');

  switch (rec.kind) {
    case 'quest_vote': {
      const card = rec.action?.type === 'quest_vote' ? rec.action.vote : 'success';
      L.inc(`Q.${obs.myTeam}.n`);
      if (good) {
        L.record('INV-Q1', { violated: card === 'fail' });
        if (card === 'fail') L.inc('Q.good.fail');
      }
      break;
    }

    case 'team_select': {
      if (!good || rec.action?.type !== 'team_select') break;
      const team = rec.action.teamIds;
      const human = rec.human?.team;

      // INV-T1. 派拇指躲刺 (Edward 2026-10-28, `merlinDoomedRed`): Merlin may put a seen red on a proposal the
      // R1–R2 normal votes always reject (non-forced) — it never goes on a mission.
      if (obs.myRole === 'merlin' && doomedProposal(obs) && view.provablyFailable(team, round)) {
        L.record('INV-T1', { exempt: 'Merlin cover on a doomed R1-R2 proposal (派拇指躲刺)' });
      } else L.record('INV-T1', { violated: view.provablyFailable(team, round), unreliable });
      if (view.provablyFailable(team, round)) L.inc(`T1.${rb(round)}.botMustFail`);
      if (human) L.human('INV-T1', view.provablyFailable(human, round));

      // INV-K1 (declared-blue pairs only exist after a lake)
      if (declaredLakes(obs.lakeHistory).some((l) => l.declaredClaim === 'good')) {
        if (view.l1Empty) L.record('INV-K1', { exempt: L1_EMPTY });
        else {
          L.record('INV-K1', { violated: view.strictlyDominated(team) !== null, unreliable });
          if (human) L.human('INV-K1', view.strictlyDominated(human) !== null);
        }
      }

      // INV-K2
      // Only pairs that bind in this view (2026-10-26: the viewer's own red
      // declaration of a seat it privately saw blue binds nothing — the
      // declared-red twin of INV-K1's `vouches` exception).
      const redPairs = declaredLakes(obs.lakeHistory)
        .filter((l) => l.declaredClaim === 'evil' && view.redPairBinds(l.holderId, l.targetId));
      if (redPairs.length > 0) {
        const both = (t: readonly string[]): boolean => redPairs.some((l) => t.includes(l.holderId) && t.includes(l.targetId));
        if (both(team) && view.failsRequired(round) !== 1) L.record('INV-K2', { exempt: TWO_FAILS });
        else if (both(team) && view.l1Empty) L.record('INV-K2', { exempt: L1_EMPTY });
        else L.record('INV-K2', { violated: both(team), unreliable });
        if (human) L.human('INV-K2', both(human) && view.failsRequired(round) === 1);
      }

      // INV-M1 (proposals)
      if (obs.myRole === 'merlin') {
        const visible = team.some((id) => obs.knownEvils.includes(id));
        if (visible && doomedProposal(obs)) L.record('INV-M1', { exempt: 'Merlin cover on a doomed R1-R2 proposal (派拇指躲刺)' });
        else L.record('INV-M1', { violated: visible });
        if (visible) L.inc('T.merlin.knownRedOnTeam');
      }

      if (obs.myRole === 'percival') {
        const thumbs = obs.knownWizards ?? [];
        // INV-R1NT
        if (percivalR1RuleApplies(obs)) {
          const keep = percivalR1IncludedThumb(obs);
          const bad = (t: readonly string[]): boolean => t.some((id) => thumbs.includes(id) && id !== keep);
          L.record('INV-R1NT', { violated: bad(team) });
          if (keep && team.includes(keep)) L.inc('R1NT.exceptionThumbIncluded');
          if (keep) L.inc('R1NT.exceptionCases');
          if (human) L.human('INV-R1NT', bad(human));
        }
        // INV-Pe2
        for (const [id] of rec.exclusions ?? new Map<string, number>()) {
          if (percivalR1RuleApplies(obs) && thumbs.includes(id)) L.record('INV-Pe2', { exempt: 'owner R1 no-thumb ruling' });
          else L.record('INV-Pe2', { violated: !view.isCertRed(id), unreliable });
        }
      }

      teamSelectDiagnostics(rec, team, L, truth, opts);
      break;
    }

    case 'team_vote': {
      if (!good || rec.action?.type !== 'team_vote') break;
      const approve = rec.action.vote;
      const team = obs.proposedTeam;
      const humanVote = rec.human?.vote;

      // INV-V1
      if (view.provablyFailable(team, round)) {
        const exempt = voteExemption(obs, view, false)
          ?? (obs.myRole === 'merlin' && (team ?? []).includes(obs.myPlayerId) ? MERLIN_ON_TEAM : undefined);
        L.record('INV-V1', { exempt, violated: approve, unreliable });
        if (!exempt && humanVote !== undefined) L.human('INV-V1', humanVote);
      }
      // INV-K1V (batch 1D): 硬1 for votes — no approval of a strictly
      // dominated team (only exists once a declared-blue pair does; never
      // with L1 empty).
      if (view.strictlyDominated(team) !== null) {
        const exempt = voteExemption(obs, view, false);
        L.record('INV-K1V', { exempt, violated: approve, unreliable });
        if (!exempt && humanVote !== undefined) L.human('INV-K1V', humanVote);
      }
      // INV-P3
      const accusers = accusersOf(obs);
      if (accusers.some((id) => team.includes(id))) {
        const exempt = voteExemption(obs, view, true);
        L.record('INV-P3', { exempt, violated: approve, unreliable });
        if (!exempt && humanVote !== undefined) L.human('INV-P3', humanVote);
      }
      // INV-L1
      if (ownDeclaredRed(obs).some((id) => team.includes(id))) {
        const exempt = voteExemption(obs, view, true);
        L.record('INV-L1', { exempt, violated: approve, unreliable });
        if (!exempt && humanVote !== undefined) L.human('INV-L1', humanVote);
      }
      // INV-Pe1
      if (obs.myRole === 'percival') {
        const thumbs = obs.knownWizards ?? [];
        if (thumbs.length === 2 && thumbs.every((id) => team.includes(id))) {
          const exempt = voteExemption(obs, view, true);
          L.record('INV-Pe1', { exempt, violated: approve, unreliable });
          if (!exempt && humanVote !== undefined) L.human('INV-Pe1', humanVote);
        }
      }
      // Percival on the team (not leading), non-forced R3+ (batch 1E): how
      // often the bot and the human at the same point reject — all teams,
      // teams holding a certain red (L1*), teams with no thumb (the dropped
      // "no thumb ⇒ reject" rule).
      if (
        obs.myRole === 'percival' && round >= 3 && !isForcedProposal(obs) &&
        team.includes(me) && obs.currentLeader !== me
      ) {
        const thumbs = obs.knownWizards ?? [];
        const cells = ['all'];
        if (team.some((id) => id !== me && view.isCertRed(id))) cells.push('certRed');
        if (!team.some((id) => thumbs.includes(id))) cells.push('noThumb');
        if (view.failsRequired(round) !== 1) cells.push('twoFails');
        for (const c of cells) {
          L.inc(`Pe.onTeam.${c}.n`);
          if (!approve) L.inc(`Pe.onTeam.${c}.botReject`);
          if (humanVote !== undefined && !unreliable) {
            L.inc(`Pe.onTeam.${c}.humanN`);
            if (!humanVote) L.inc(`Pe.onTeam.${c}.humanReject`);
          }
        }
      }
      // INV-M1 (votes)
      if (obs.myRole === 'merlin' && team.some((id) => obs.knownEvils.includes(id))) {
        const exempt = voteExemption(obs, view, false);
        L.record('INV-M1', { exempt, violated: approve });
      }
      teamVoteDiagnostics(rec, approve, L, truth);
      break;
    }

    case 'assassinate': {
      if (rec.action?.type !== 'assassinate') break;
      const target = rec.action.targetId;
      const known = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, me]);
      const hit = known.has(target);
      L.record('INV-A1', { violated: hit });
      L.inc('A.n');
      if (truth?.evil.has(target)) L.inc('A.targetEvil');
      // INV-A2 (batch 1G; a tier-2 policy since the review): a candidate who,
      // as captain on any proposal (the forced fifth too), certainly put a red Merlin sees
      // on the team is not preferred over one who never did (opportunity =
      // some candidate did; every candidate did = exempt, the scores decide).
      // Classified by the harness's own brute force (`a2FlaggedIndependently`).
      const candidates = obs.allPlayerIds.filter((id) => !known.has(id));
      const flaggedSet = a2FlaggedIndependently(obs, candidates, rec.assassinIgnoreDoomed === true);
      if (flaggedSet === null) L.inc('A2.rosterMismatch');
      const flagged = candidates.filter((id) => flaggedSet?.has(id) ?? false);
      const humanTarget = rec.human?.target;
      L.inc(`A.${obs.playerCount}p.${obs.myRole}`);
      if (flagged.length > 0) {
        if (flagged.length === candidates.length) L.record('INV-A2', { exempt: 'every candidate proposed a seen red' });
        else {
          L.record('INV-A2', { violated: flagged.includes(target) });
          if (humanTarget !== undefined) L.human('INV-A2', flagged.includes(humanTarget));
        }
      }
      if (truth) {
        const merlin = [...truth.roles].find(([, r]) => r === 'merlin')?.[0];
        if (target === merlin) L.inc('A.hitMerlin');
        // Recorded with 0 too, so a source where Merlin is never flagged says so
        // (self-play: bot Merlins never propose a red they see, INV-M1).
        L.inc('A2.merlinFlagged', merlin !== undefined && flagged.includes(merlin) ? 1 : 0);
        if (merlin !== undefined && flagged.includes(merlin) && target === merlin) L.inc('A2.merlinFlaggedButHit');
        if (humanTarget !== undefined) {
          L.inc('A.human.n');
          if (humanTarget === merlin) L.inc('A.human.hitMerlin');
          if (flagged.includes(humanTarget)) L.inc('A2.human.targetFlagged');
        }
      }
      if (flagged.length > 0) L.inc('A2.someFlagged');
      break;
    }

    case 'lake_claim': {
      const claim = rec.lakeClaim ?? null;
      const target = rec.lakeTarget as string;
      if (obs.myTeam === 'evil') {
        if (claim !== null) {
          const possible = claimPossibleForGoodHolder(obs, me, target, claim);
          L.record('INV-R1', { violated: !possible });
        } else {
          // Batch 1F: a holder already publicly certain red has no possible
          // claim and leaves the lake undeclared.
          L.inc('R1.undeclared');
          if (!claimPossibleForGoodHolder(obs, me, target, 'good') && !claimPossibleForGoodHolder(obs, me, target, 'evil')) {
            L.inc('R1.undeclared.noPossibleClaim');
          }
        }
        const humanClaim = rec.human?.claim;
        if (humanClaim) L.human('INV-R1', !claimPossibleForGoodHolder(obs, me, target, humanClaim));
        redClaimDiagnostics(rec, L);
      }
      break;
    }

    case 'lake_target': {
      if (obs.myRole !== 'percival') break;
      const thumbs = obs.knownWizards ?? [];
      const legalThumb = (rec.validTargets ?? []).some((id) => thumbs.includes(id));
      if (thumbs.length >= 1 && legalThumb) {
        // Structural: the avoid set the deciding agent's tuning used (the
        // AuditAgent records it); the production default's when absent.
        const avoid = new Set(rec.lakeAvoid ?? goodLakeAvoidSet(obs));
        L.record('INV-PL', { violated: thumbs.some((id) => avoid.has(id)) });
        L.inc('PL.n');
        if (rec.lakeTarget && thumbs.includes(rec.lakeTarget)) {
          L.inc('PL.botLakedThumb');
          if (truth?.roles.get(rec.lakeTarget) === 'merlin') L.inc('PL.botLakedThumb.merlin');
        }
        if (rec.human?.target && thumbs.includes(rec.human.target)) {
          L.inc('PL.humanLakedThumb');
          if (truth?.roles.get(rec.human.target) === 'merlin') L.inc('PL.humanLakedThumb.merlin');
        }
        if (rec.human?.target && rec.lakeTarget === rec.human.target) L.inc('PL.sameTargetAsHuman');
      }
      // INV-PL2 (2026-10-26 review, behavioural): Percival lakes the seat a
      // loyal holding the thumb constraint would lake (same draws).
      if (rec.lakeAsLoyal !== undefined && rec.lakeTarget !== undefined) {
        L.record('INV-PL2', { violated: rec.lakeAsLoyal !== rec.lakeTarget });
      }
      break;
    }
  }
  return good && view.l1Empty;
}

// ── Diagnostics (reproduce logic_audit.md) ─────────────────────

function teamSelectDiagnostics(
  rec: DecisionRecord,
  team: readonly string[],
  L: Ledger,
  truth: Truth | undefined,
  opts: Readonly<BeliefOptions>,
): void {
  const obs = rec.obs;
  const round = obs.currentRound;
  const role = obs.myRole;
  const k = `T.${role}.${rb(round)}`;
  const { v0, v1 } = auditViews(obs);
  const human = rec.human?.team;
  L.inc(`${k}.n`);
  L.inc(`T.all.${rb(round)}.n`);
  if (v0.minReds(team, 'L1') >= 1) { L.inc(`${k}.certRedL0`); L.inc(`T.all.${rb(round)}.certRedL0`); }
  if (human && v0.minReds(human, 'L1') >= 1) L.inc(`T.all.${rb(round)}.human.certRedL0`);
  if (v1.l1.length > 0) {
    L.inc(`T.all.${rb(round)}.l1ok`);
    if (minRedsOrNone(v1, team) >= 1) { L.inc(`${k}.certRedL1`); L.inc(`T.all.${rb(round)}.certRedL1`); }
    if (human && minRedsOrNone(v1, human) >= 1) L.inc(`T.all.${rb(round)}.human.certRedL1`);
    const tMask = v1.maskOf(team);
    const certGood = v1.certGoodMask('L1');
    if ((tMask & ~certGood) && (certGood & ~tMask)) { L.inc(`${k}.dominanceL1`); L.inc(`T.all.${rb(round)}.dominanceL1`); }
  } else L.inc(`T.all.${rb(round)}.l1inconsistent`);
  if ((obs.lakeHistory ?? []).some((l) => l.declaredClaim !== 'none')) {
    const chain = analyzeLakeChain(obs);
    const viol = findTeamHardRuleViolations(chain, team);
    L.inc(`T.all.${rb(round)}.withLakes`);
    if (viol.some((v) => v.rule === 1)) { L.inc(`T.all.${rb(round)}.hard1`); L.inc(`${k}.hard1`); }
    if (viol.some((v) => v.rule === 2)) { L.inc(`T.all.${rb(round)}.hard2`); L.inc(`${k}.hard2`); }
    if (human) {
      const hv = findTeamHardRuleViolations(chain, human);
      if (hv.some((v) => v.rule === 1)) L.inc(`T.all.${rb(round)}.human.hard1`);
      if (hv.some((v) => v.rule === 2)) L.inc(`T.all.${rb(round)}.human.hard2`);
    }
  }
  if (role === 'percival') {
    const inferred = inferRedsFromTaskFails(obs, opts);
    L.inc('T.percival.decisions');
    if (inferred.length > 0) L.inc('T.percival.inferDecisions');
    for (const s of inferred) {
      L.inc('T.percival.inferredSeats');
      if (!v0.isCertRed(s, 'L1')) L.inc('T.percival.inferred.notCertainRedL0');
      if (truth && !truth.evil.has(s)) L.inc('T.percival.inferred.actuallyGood');
      if (truth?.roles.get(s) === 'merlin') L.inc('T.percival.inferred.actuallyMerlin');
    }
    const thumbs = obs.knownWizards ?? [];
    if (thumbs.length === 2 && thumbs.every((id) => team.includes(id))) L.inc('T.percival.bothThumbs');
    if (round === 1) {
      L.inc('T.percival.R1.n');
      if (team.some((id) => thumbs.includes(id))) L.inc('T.percival.R1.withThumb');
    }
  }
  // Pyramid order on the leader's own picture (audit O.*), R3+.
  if (round >= 3) {
    const pyr = computePyramidScores(obs, opts);
    for (const l of declaredLakes(obs.lakeHistory)) {
      const a = l.holderId;
      const b = l.targetId;
      if (l.declaredClaim !== 'good' || a === obs.myPlayerId || b === obs.myPlayerId) continue;
      if (obs.knownEvils.includes(a) || obs.knownEvils.includes(b)) continue;
      L.inc('O.pairs');
      if ((pyr.scores.get(b) ?? 0.5) > (pyr.scores.get(a) ?? 0.5) + 1e-9) L.inc('O.inverted');
      if (team.includes(a) && !team.includes(b)) L.inc('O.teamHasAwithoutB');
    }
  }
}

function teamVoteDiagnostics(rec: DecisionRecord, approve: boolean, L: Ledger, truth?: Truth): void {
  const obs = rec.obs;
  const round = obs.currentRound;
  const role = obs.myRole;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam;
  const onTeam = team.includes(me);
  const isLeader = obs.currentLeader === me;
  const pos = isLeader ? 'leader' : onTeam ? 'on' : 'off';
  const { v0, v1 } = auditViews(obs);
  const need = v1.failsRequired(round);
  const k = `V.${rb(round)}`;
  const humanApprove = rec.human?.vote;
  const red0 = v0.minReds(team, 'L1') >= 1;
  const red1 = v1.l1.length > 0 && v1.minReds(team, 'L1') >= 1;
  if (red0) {
    L.inc(`${k}.certRedL0.n`);
    L.inc(`${k}.certRedL0.${role}.${pos}.n`);
    if (approve) { L.inc(`${k}.certRedL0.approve`); L.inc(`${k}.certRedL0.${role}.${pos}.approve`); }
    if (humanApprove) L.inc(`${k}.certRedL0.humanApprove`);
    if (v0.minReds(team, 'L1') >= need) { L.inc(`${k}.certFailableL0.n`); if (approve) L.inc(`${k}.certFailableL0.approve`); }
  }
  if (red1) {
    L.inc(`${k}.certRedL1.n`);
    L.inc(`${k}.certRedL1.${role}.${pos}.n`);
    if (approve) { L.inc(`${k}.certRedL1.approve`); L.inc(`${k}.certRedL1.${role}.${pos}.approve`); }
    if (humanApprove) L.inc(`${k}.certRedL1.humanApprove`);
    if (v1.minReds(team, 'L1') >= need) {
      L.inc(`${k}.certFailableL1.n`);
      if (approve) L.inc(`${k}.certFailableL1.approve`);
      if (humanApprove) L.inc(`${k}.certFailableL1.humanApprove`);
    }
    if (pos !== 'leader') {
      L.inc(`${k}.certRedL1.nonLeader.n`);
      if (approve) L.inc(`${k}.certRedL1.nonLeader.approve`);
      if (humanApprove) L.inc(`${k}.certRedL1.nonLeader.humanApprove`);
    }
  }
  for (const l of declaredLakes(obs.lakeHistory)) {
    if (l.targetId === me && l.declaredClaim === 'evil' && team.includes(l.holderId)) {
      L.inc(`${k}.accuserOnTeam.n`);
      if (approve) L.inc(`${k}.accuserOnTeam.approve`);
    }
    if (l.holderId === me && l.declaredClaim === 'evil' && team.includes(l.targetId)) {
      L.inc(`${k}.ownRedOnTeam.${pos}.n`);
      if (approve) L.inc(`${k}.ownRedOnTeam.${pos}.approve`);
    }
  }
  if (role === 'percival') {
    const th = obs.knownWizards ?? [];
    const both = th.length === 2 && th.every((id) => team.includes(id));
    if (both) {
      L.inc(`${k}.percBothThumbs.${pos}.n`);
      if (approve) L.inc(`${k}.percBothThumbs.${pos}.approve`);
      const r4 = need >= 2 ? 'R4' : 'nonR4';
      L.inc(`${k}.percBothThumbs.${pos}.${r4}.n`);
      if (approve) L.inc(`${k}.percBothThumbs.${pos}.${r4}.approve`);
    }
    if (th.length === 2 && !team.some((id) => th.includes(id)) && onTeam && !isLeader && round >= 3) {
      L.inc('V.percNoThumbOnTeam.n');
      if (!approve) L.inc('V.percNoThumbOnTeam.reject');
      if (!approve && truth && !team.some((id) => truth.evil.has(id))) L.inc('V.percNoThumbOnTeam.rejectActuallyClean');
    }
  }
  if (role === 'merlin' && team.some((id) => obs.knownEvils.includes(id))) {
    L.inc(`${k}.merlinKnownRed.${pos}.n`);
    if (approve) L.inc(`${k}.merlinKnownRed.${pos}.approve`);
  }
}

function redClaimDiagnostics(rec: DecisionRecord, L: Ledger): void {
  const obs = rec.obs;
  const target = rec.lakeTarget as string;
  const truth = rec.lakeTruth;
  const claim = rec.lakeClaim ?? null;
  const pub = publicCertaintyOf(obs);
  const pubOk = pub.l1.length > 0;
  const certGood = pubOk && pub.isCertGood(target, 'L1');
  const certRed = pubOk && pub.isCertRed(target, 'L1');
  L.inc('L.red.claims');
  if (claim === 'evil') L.inc('L.red.claimEvil');
  if (claim === 'evil' && truth === 'good') {
    L.inc('L.red.frames');
    if (certGood) L.inc('L.red.frame.selfIncriminating');
  }
  if (claim === 'good' && certRed) L.inc('L.red.claimGood.selfIncriminating');
  const human = rec.human?.claim;
  if (human === 'evil' && truth === 'good') {
    L.inc('L.redHuman.frames');
    if (certGood) L.inc('L.redHuman.frame.selfIncriminating');
  }
}

// ── Observation checks (a seat's picture at a round opening) ───

/**
 * Belief, metamorphic and privacy checks on one seat's observation at the
 * opening of a round (R2+). `truth` drives INV-OBS and the diagnostics.
 */
export function checkObservation(
  obs: PlayerObservation,
  L: Ledger,
  truth?: Truth,
  opts: Readonly<BeliefOptions> = defaultBeliefOptions(),
): void {
  checkWorlds(obs, L, truth);
  if (truth) checkPrivacy(obs, L, truth);
  if (obs.myTeam !== 'good') return;
  const view = certaintyOf(obs);
  const pyr = computePyramidScores(obs, opts);
  const score = (id: string): number => pyr.scores.get(id) ?? 0.5;
  const me = obs.myPlayerId;
  const role = obs.myRole;
  const round = obs.currentRound;

  // INV-B2
  if (!view.l1Empty || view.l0.length > 0) {
    for (const id of view.certRed('L1*')) {
      if (id === me || obs.knownEvils.includes(id)) continue;
      L.record('INV-B2', { violated: score(id) < 1 - CERTAINTY_EPS });
    }
    for (const id of view.certGood('L1*')) {
      if (id === me) continue;
      L.record('INV-B2', { violated: score(id) > CERTAINTY_EPS });
    }
  }
  // Audit counters (beliefAudit.ts, L1 with the audit's world model).
  const { v1 } = auditViews(obs);
  if (v1.l1.length > 0) {
    const k = `B.L1.R${round}.${role}`;
    L.inc(`${k}.points`);
    for (const id of v1.certRed('L1')) {
      if (obs.knownEvils.includes(id)) continue;
      L.inc(`${k}.certRed.deduced`);
      if (score(id) < 0.85) L.inc(`${k}.certRed.deduced.below085`);
    }
    for (const id of v1.certGood('L1')) {
      if (id === me) continue;
      L.inc(`${k}.certGood`);
      if (score(id) >= 0.85) L.inc(`${k}.certGood.atLeast085`);
    }
    for (const l of declaredLakes(obs.lakeHistory)) {
      if (l.declaredClaim !== 'good' || l.holderId === me || l.targetId === me) continue;
      L.inc('order.pairs');
      if (score(l.targetId) > score(l.holderId) + 1e-9) L.inc('order.pyramidInverted');
    }
  }

  // INV-B1: the order of the *uncertain* seats. A pair with a seat the
  // certainty layer pins is settled there (K5 reversals, ε pins of L1-only
  // facts against exact L0 pins) and is counted as exempt.
  const pinned = (id: string): boolean => view.isCertRed(id, 'L1*') || view.isCertGood(id, 'L1*');
  for (const l of declaredLakes(obs.lakeHistory)) {
    if (l.declaredClaim !== 'good' || l.holderId === me || l.targetId === me) continue;
    if (view.l1Empty) { L.record('INV-B1', { exempt: L1_EMPTY }); continue; }
    if (pinned(l.holderId) || pinned(l.targetId)) { L.record('INV-B1', { exempt: PINNED }); continue; }
    L.record('INV-B1', { violated: score(l.targetId) > score(l.holderId) + 1e-9 });
  }

  // INV-F0: flipping the synthetic votes of forced proposals must not matter.
  if (obs.voteHistory.some((v) => v.attempt >= 5)) {
    const flipped: PlayerObservation = {
      ...obs,
      voteHistory: obs.voteHistory.map((v) => (v.attempt >= 5
        ? { ...v, votes: Object.fromEntries(Object.entries(v.votes).map(([id, x]) => [id, !x])) }
        : v)),
    };
    const alt = computePyramidScores(flipped, opts);
    const changed = obs.allPlayerIds.some((id) => Math.abs((alt.scores.get(id) ?? 0.5) - score(id)) > 1e-9);
    L.record('INV-F0', { violated: changed });
  }

  // INV-R2: after an impossible declaration, the holder is certainly red.
  for (const l of declaredLakes(obs.lakeHistory)) {
    if (l.holderId === me) continue;
    const before = cutAtLake(obs, l.round);
    if (claimPossibleForGoodHolder(before, l.holderId, l.targetId, l.declaredClaim)) continue;
    if (view.l1Empty) L.record('INV-R2', { exempt: L1_EMPTY });
    else if (view.conventionsDropped) L.record('INV-R2', { exempt: CONVENTIONS_DROPPED });
    else L.record('INV-R2', { violated: !view.isCertRed(l.holderId, 'L1') });
  }
}

/** INV-OBS: the observation carries exactly the private fields its seat may see. */
function checkPrivacy(obs: PlayerObservation, L: Ledger, truth: Truth): void {
  const me = obs.myPlayerId;
  const role = obs.myRole;
  const evil = [...truth.evil];
  const sorted = (xs: readonly string[] | undefined): string => [...(xs ?? [])].sort().join(',');
  let expectedEvils: string[] = [];
  if (role === 'merlin') expectedEvils = evil.filter((id) => truth.roles.get(id) !== 'mordred');
  else if (truth.evil.has(me) && role !== 'oberon') expectedEvils = evil.filter((id) => id !== me && truth.roles.get(id) !== 'oberon');
  let ok = sorted(obs.knownEvils) === sorted(expectedEvils);
  if (role === 'percival') {
    const wiz = [...truth.roles].filter(([, r]) => r === 'merlin' || r === 'morgana').map(([id]) => id);
    ok = ok && sorted(obs.knownWizards) === sorted(wiz);
  } else ok = ok && obs.knownWizards === undefined;
  // The red roster reaches the assassinator only (the assassin; Mordred /
  // Morgana when no assassin is dealt — 2026-10-26: the 7-player Mordred).
  if (obs.allEvilIds !== undefined) ok = ok && isAssassinator(role, truth.roles.values()) && obs.gamePhase === 'assassination';
  // The lobby roles are public, but must be the roles actually dealt.
  if (obs.lobbyRoles !== undefined) ok = ok && sorted(obs.lobbyRoles) === sorted([...truth.roles.values()]);
  for (const r of obs.myLakeResults ?? []) {
    const camp = truth.evil.has(r.targetId) ? 'evil' : 'good';
    if (r.result !== camp) ok = false;
    // Someone else's lake must never show up as mine.
    if ((obs.lakeHistory ?? []).some((l) => l.round === r.round && l.targetId === r.targetId && l.holderId !== me)) ok = false;
  }
  L.record('INV-OBS', { violated: !ok });
}

// ── Public checks at a round opening (rule 3) ──────────────────

/**
 * The 硬3 scores under `opts`; `postLakeOnly` = the post-lake reading (the
 * S1-2 rule when it is on, the legacy rule cut at the declaration otherwise;
 * diagnostics column).
 */
function ruleThreeScores(obs: PlayerObservation, opts: Readonly<BeliefOptions>, postLakeOnly: boolean): Map<string, number> {
  setRule3DiagnosticOptions(postLakeOnly && !opts.rule3PostLake ? { postLakeOnly: true } : undefined);
  try {
    return findRule3Violators(analyzeLakeChain(obs), obs, opts);
  } finally {
    setRule3DiagnosticOptions(undefined);
  }
}

/**
 * Rule-3 (硬3) checks on the public record at the opening of `obs.currentRound`
 * (R3+): INV-H3a (pre-lake leader records must not matter) and INV-H3b
 * (an honest blue holder is flagged only by a post-lake omission).
 */
export function checkPublicRound(
  obs: PlayerObservation,
  L: Ledger,
  truth?: Truth,
  opts: Readonly<BeliefOptions> = defaultBeliefOptions(),
): void {
  const chain = analyzeLakeChain(obs);
  if (chain.declaredBlueByHolder.size === 0) return;
  const round = obs.currentRound;
  const def = ruleThreeScores(obs, opts, false);
  const post = ruleThreeScores(obs, opts, true);
  for (const [holder, targets] of chain.declaredBlueByHolder) {
    const declRound = Math.min(...chain.records.filter((r) => r.holderId === holder && r.declaredClaim === 'good').map((r) => r.round));
    const d = def.get(holder) ?? 0;
    const p = post.get(holder) ?? 0;
    // INV-H3a
    const preLed = obs.voteHistory.some((v) => v.leader === holder && v.round <= declRound);
    if (preLed) {
      const without: PlayerObservation = {
        ...obs,
        voteHistory: obs.voteHistory.filter((v) => !(v.leader === holder && v.round <= declRound)),
      };
      const alt = ruleThreeScores(without, opts, false);
      L.record('INV-H3a', { violated: Math.abs((alt.get(holder) ?? 0) - d) > 1e-9 });
    }
    // Diagnostics (audit R3.*), camp by truth.
    if (truth) {
      const camp = truth.evil.has(holder) ? 'evil' : 'good';
      const kk = `R3.atR${round}.${camp}`;
      L.inc(`${kk}.holders`);
      if (d >= 0.85) L.inc(`${kk}.flag085.default`);
      if (p >= 0.85) L.inc(`${kk}.flag085.postLake`);
      if (d >= 0.85 && p < 0.85) L.inc(`${kk}.flag085.preOnly`);
      if (d >= 0.5 && d < 0.85) L.inc(`${kk}.flag05only.default`);
      if (truth.roles.get(holder) === 'merlin' && d >= 0.85) L.inc(`R3.atR${round}.merlinHolderFlagged`);
      // INV-H3b: honest blue holders only.
      const honest = camp === 'good' && [...targets].every((t) => !truth.evil.has(t));
      if (honest) {
        const justified = obs.voteHistory.some((v) => v.leader === holder && v.round > declRound
          && [...targets].some((t) => !v.team.includes(t)));
        if (d >= 0.85 && justified) L.record('INV-H3b', { exempt: 'post-lake omission' });
        else L.record('INV-H3b', { violated: d >= 0.85 });
      }
    }
  }
}
