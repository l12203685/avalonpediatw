/**
 * Regression tests for the 2026-10-26 review of logic-first batches 1C–1G
 * (docs/ai/logic_first.md 第 10 節). One block per finding; fake games, seat
 * ids only.
 *
 *   - the assassinator: Mordred at 7 players (no plain assassin), Morgana
 *     when neither is dealt — engine, self-play, observations, INV-OBS;
 *   - INV-A2: a tier-2 policy rule with its own classifier;
 *   - INV-K2: the viewer's own contradicted red declaration binds nothing;
 *   - INV-PL2: Percival lakes as a loyal holding the thumb constraint;
 *   - the practice review: Percival's blue lake, no English identifiers,
 *     the reason for a red holder's silence and for a gated team;
 *   - the bot fallback team uses the engine's quest sizes.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import type { Player, Role, Room } from '@avalon/shared';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { SelfPlayEngine } from './SelfPlayEngine';
import { seededRandom, withSeededRandom } from './benchmark/agreement';
import { buildCertainty } from './belief/Certainty';
import { analyzeLakeChain, findTeamHardRuleViolations } from './baseline/lakeChainTracker';
import { explainLakeClaim, explainLakeTarget, replayRule } from './explain';
import { INVARIANTS, invariantById } from './invariants/catalog';
import { checkDecision, checkObservation } from './invariants/checks';
import { Ledger } from './invariants/ledger';
import { AuditAgent } from './invariants/AuditAgent';
import { truthFromRoles } from './invariants/context';
import { visibleRedEvidence } from './assassin/VisibleRedProposals';
import { assassinatorRole, isAssassinator } from '../game/assassinator';
import { fitTeamToSize } from '../game/teamSize';
import { GameServer } from '../socket/GameServer';
import type { GameEngine } from '../game/GameEngine';
import type { AgentAction, AvalonAgent, LakePublicRecord, PlayerObservation, QuestRecord, VoteRecord } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
const ON: AgentTuning = { ...DEFAULT_AGENT_TUNING };

function quest(round: number, team: string[], failCount: number): QuestRecord {
  const need = round === 4 ? 2 : 1;
  return { round, team, failCount, result: failCount >= need ? 'fail' : 'success' };
}

function passed(round: number, leader: string, team: string[], ids = IDS): VoteRecord {
  return { round, attempt: 1, leader, team, approved: true, votes: Object.fromEntries(ids.map((id) => [id, team.includes(id)])) };
}

function goodObs(p: {
  me: string; role: PlayerObservation['myRole']; phase: PlayerObservation['gamePhase']; round: number;
  quests: QuestRecord[]; lakes?: LakePublicRecord[]; myLakeResults?: PlayerObservation['myLakeResults'];
  knownWizards?: string[];
}): PlayerObservation {
  return {
    myPlayerId: p.me, myRole: p.role, myTeam: 'good', playerCount: 10, allPlayerIds: IDS,
    knownEvils: [], knownWizards: p.knownWizards,
    currentRound: p.round, currentLeader: p.me, failCount: 0,
    questResults: p.quests.map((q) => q.result), gamePhase: p.phase,
    voteHistory: p.quests.map((q) => passed(q.round, q.team[0], q.team)), questHistory: p.quests,
    proposedTeam: [], lakeHistory: p.lakes ?? [], myLakeResults: p.myLakeResults,
  };
}

// ── The assassinator ───────────────────────────────────────────


/**
 * The r5_must_fail_reuse fixture with R1 turned into a success. In the recorded game R1 and R2 failed, so since
 * A1 (Edward 2026-10-26: no stalling after two fails) R3's four are certainly good, P5 is R4's red and the
 * gates-off bot no longer re-proposes the R4 team. With one failed mission before R3, A1 does not apply and the
 * fixture shows the breach the gates bar, as recorded.
 */
function withoutNoStall(o: PlayerObservation): PlayerObservation {
  const quests = o.questHistory.map((q, i) => (i === 0 ? { ...q, result: 'success' as const, failCount: 0 } : q));
  return { ...o, questHistory: quests, questResults: quests.map((q) => q.result) };
}

describe('review: the assassinator is Mordred at 7 players, Morgana when neither is dealt', () => {
  const r7: Role[] = ['merlin', 'percival', 'loyal', 'loyal', 'morgana', 'mordred', 'oberon'];

  it('assassinatorRole: assassin > mordred > morgana', () => {
    expect(assassinatorRole(['merlin', 'assassin', 'morgana', 'mordred'])).toBe('assassin');
    expect(assassinatorRole(r7)).toBe('mordred');
    expect(assassinatorRole(['merlin', 'loyal', 'morgana', 'minion', 'oberon'])).toBe('morgana');
    expect(assassinatorRole(['merlin', 'loyal', 'minion'])).toBeUndefined();
    expect(isAssassinator('mordred', r7)).toBe(true);
    expect(isAssassinator('mordred', [...r7, 'assassin'])).toBe(false);
  });

  it('7-player self-play: the Mordred bot assassinates with the full red roster (it used to be skipped)', async () => {
    const seen: PlayerObservation[] = [];
    class Spy extends HeuristicAgent {
      act(obs: PlayerObservation): AgentAction {
        if (obs.gamePhase === 'assassination') seen.push(obs);
        return super.act(obs);
      }
    }
    const engine = new SelfPlayEngine();
    const quiet = console.log;
    const random = Math.random;
    console.log = (): void => undefined;
    try {
      for (let i = 0; i < 40 && seen.length === 0; i++) {
        Math.random = seededRandom(`review-7p|${i}`);
        const agents: AvalonAgent[] = Array.from({ length: 7 }, (_, k) => new Spy(`P${k + 1}`, undefined, undefined, ON));
        await engine.runGame(agents, false);
      }
    } finally {
      console.log = quiet;
      Math.random = random;
    }
    expect(seen.length).toBeGreaterThan(0);
    const o = seen[0];
    expect(o.myRole).toBe('mordred');
    expect(o.allEvilIds).toHaveLength(3);
    expect([...(o.lobbyRoles ?? [])].sort()).toEqual([...r7].sort());
  });

  it('GameServer: a 7-player Mordred bot gets the red roster and the lobby roles at the assassination', () => {
    const players: Record<string, Player> = {};
    r7.forEach((role, i) => {
      const evil = ['morgana', 'mordred', 'oberon'].includes(role);
      players[`p${i + 1}`] = { id: `p${i + 1}`, name: `p${i + 1}`, role, team: evil ? 'evil' : 'good', status: 'active', isBot: true } as Player;
    });
    const room = {
      id: 'room-7p', state: 'discussion', players, host: 'p1', leaderIndex: 0, currentRound: 4, questTeam: [],
      questResults: ['success', 'success', 'success'], questHistory: [], voteHistory: [], votes: {}, failCount: 0,
      maxPlayers: 7, createdAt: Date.now(), isPrivate: false, ladyOfTheLakeHistory: [],
    } as unknown as Room;
    const server = new GameServer(new SocketIOServer(createServer())) as unknown as {
      buildBotObservation(r: Room, botId: string, engine: GameEngine, phase: PlayerObservation['gamePhase']): PlayerObservation;
    };
    const engine = { getCurrentLeaderId: () => 'p1' } as unknown as GameEngine;
    const mordred = server.buildBotObservation(room, 'p6', engine, 'assassination');
    expect([...(mordred.allEvilIds ?? [])].sort()).toEqual(['p5', 'p6', 'p7']);
    expect([...(mordred.lobbyRoles ?? [])].sort()).toEqual([...r7].sort());
    expect(server.buildBotObservation(room, 'p5', engine, 'assassination').allEvilIds).toBeUndefined();
  });

  it('INV-OBS: the roster may reach the 7-player Mordred, never anyone else; the lobby roles must be the dealt ones', () => {
    const ids7 = IDS.slice(0, 7);
    const roles = new Map<string, Role>(ids7.map((id, i) => [id, r7[i]]));
    const truth = truthFromRoles(roles);
    const base: PlayerObservation = {
      myPlayerId: 'P6', myRole: 'mordred', myTeam: 'evil', playerCount: 7, allPlayerIds: ids7,
      knownEvils: ['P5'], allEvilIds: ['P5', 'P6', 'P7'], lobbyRoles: [...r7],
      currentRound: 4, currentLeader: 'P1', failCount: 0, questResults: ['success', 'success', 'success'],
      gamePhase: 'assassination', voteHistory: [], questHistory: [], proposedTeam: [], lakeHistory: [],
    };
    const violations = (o: PlayerObservation): number => {
      const L = new Ledger();
      checkObservation(o, L, truth);
      return L.tallies.get('INV-OBS')?.violations ?? -1;
    };
    expect(violations(base)).toBe(0);
    expect(violations({ ...base, myPlayerId: 'P5', myRole: 'morgana', knownEvils: ['P6'] })).toBe(1);
    expect(violations({ ...base, lobbyRoles: [...r7.slice(0, 6), 'minion'] })).toBe(1);
  });
});

// ── INV-A2 ─────────────────────────────────────────────────────

describe('review: INV-A2 is a tier-2 policy rule with its own classifier', () => {
  it('catalog: kind policy, tier 2; INV-PL2 added', () => {
    const a2 = invariantById('INV-A2');
    expect(a2.kind).toBe('policy');
    expect(a2.tier).toBe(2);
    expect(a2.rule).toMatch(/^TIER 2/);
    expect(INVARIANTS.filter((s) => s.tier === 2).map((s) => s.id)).toEqual(['INV-A2']);
    expect(invariantById('INV-PL2').kind).toBe('metamorphic');
  });

  // Assassin P1 sees P2 / P3; Oberon P4. P5 led a team with P2 only, P6 with Oberon.
  const obsWith = (lobbyRoles?: Role[]): PlayerObservation => ({
    myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
    knownEvils: ['P2', 'P3'], allEvilIds: ['P1', 'P2', 'P3', 'P4'], lobbyRoles,
    currentRound: 4, currentLeader: 'P9', failCount: 0, questResults: ['success', 'success', 'success'],
    gamePhase: 'assassination', proposedTeam: [], lakeHistory: [], questHistory: [],
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P5', team: ['P5', 'P2', 'P7'], approved: false, votes: {} },
      { round: 1, attempt: 2, leader: 'P6', team: ['P6', 'P4', 'P7'], approved: false, votes: {} },
    ],
  });
  const tally = (o: PlayerObservation, target: string): { violations: number; opportunities: number } => {
    const L = new Ledger();
    checkDecision({ kind: 'assassinate', obs: o, action: { type: 'assassinate', targetId: target } }, L);
    const t = L.tallies.get('INV-A2');
    return { violations: t?.violations ?? 0, opportunities: t?.opportunities ?? 0 };
  };

  it('standard lobby: only the Oberon captain is flagged, in agreement with the agent', () => {
    const o = obsWith(['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon']);
    expect(tally(o, 'P6')).toEqual({ violations: 1, opportunities: 1 });
    expect(tally(o, 'P5')).toEqual({ violations: 0, opportunities: 1 });
    expect(visibleRedEvidence(o, ['P5', 'P6']).get('P5')?.tier).toBe(0);
  });

  it('Mordred switched off: P2 is surely seen, so the P2 captain is flagged too — by the check and by the agent', () => {
    const o = obsWith(['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'minion', 'oberon']);
    expect(tally(o, 'P5')).toEqual({ violations: 1, opportunities: 1 });
    expect(visibleRedEvidence(o, ['P5', 'P6']).get('P5')?.tier).toBe(1);
  });

  it('a roster that does not fit the lobby is counted, not checked', () => {
    const o = obsWith(['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred']);
    const L = new Ledger();
    checkDecision({ kind: 'assassinate', obs: o, action: { type: 'assassinate', targetId: 'P6' } }, L);
    expect(L.get('A2.rosterMismatch')).toBe(1);
    expect(L.tallies.get('INV-A2')?.opportunities ?? 0).toBe(0);
  });
});

// ── INV-K2 ─────────────────────────────────────────────────────

describe('review: INV-K2 — the viewer\'s own contradicted red declaration binds nothing', () => {
  // P10 (good, here: the human's lie in a replay) declared P3 red after R2 but saw P3 blue.
  const lakes: LakePublicRecord[] = [{ round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'evil' }];
  const o = goodObs({
    me: 'P10', role: 'loyal', phase: 'team_select', round: 3, lakes,
    myLakeResults: [{ round: 2, targetId: 'P3', result: 'good' }],
    quests: [quest(1, ['P1', 'P2', 'P4'], 0), quest(2, ['P1', 'P2', 'P4', 'P7'], 0)],
  });
  const team = ['P10', 'P3', 'P1', 'P2'];

  it('the certainty layer and the strict 硬2 list agree: not bound', () => {
    const view = buildCertainty(o);
    expect(view.redPairBinds('P10', 'P3')).toBe(false);
    expect(view.provablyFailable(team, 3)).toBe(false);
    expect(findTeamHardRuleViolations(analyzeLakeChain(o), team, { view, round: 3 }).filter((v) => v.rule === 2)).toEqual([]);
    // Without the private result the pair binds as usual.
    const plain = { ...o, myLakeResults: [] };
    expect(buildCertainty(plain).redPairBinds('P10', 'P3')).toBe(true);
    expect(findTeamHardRuleViolations(analyzeLakeChain(plain), team, { view: buildCertainty(plain), round: 3 })
      .filter((v) => v.rule === 2)).toHaveLength(1);
  });

  it('INV-K2 does not charge the team; it still charges a bound pair', () => {
    const count = (obs: PlayerObservation): number => {
      const L = new Ledger();
      checkDecision({ kind: 'team_select', obs, action: { type: 'team_select', teamIds: team } }, L);
      return L.tallies.get('INV-K2')?.violations ?? 0;
    };
    expect(count(o)).toBe(0);
    expect(count({ ...o, myLakeResults: [] })).toBe(1);
  });
});

// ── Percival's lake ────────────────────────────────────────────

describe('review: Percival\'s lake — INV-PL2 and the practice review', () => {
  // Percival P6 holds the lake after R2; thumbs P2 / P5.
  const o = goodObs({
    me: 'P6', role: 'percival', phase: 'team_select', round: 3, knownWizards: ['P2', 'P5'],
    lakes: [{ round: 2, holderId: 'P10', targetId: 'P1', declaredClaim: 'good' }],
    quests: [quest(1, ['P1', 'P3', 'P4'], 0), quest(2, ['P1', 'P3', 'P7', 'P8'], 1)],
  });
  const eligible = IDS.filter((id) => id !== 'P6' && id !== 'P10');

  it('INV-PL2: Percival picks what a loyal holding the thumb constraint picks', () => {
    const a = new AuditAgent('P6', ON);
    const rec = a.pickLakeTargetSeeded(o, eligible, 'review-pl2');
    expect(rec.lakeAsLoyal).toBe(rec.lakeTarget);
    const L = new Ledger();
    checkDecision(rec, L);
    expect(L.tallies.get('INV-PL2')).toMatchObject({ opportunities: 1, violations: 0 });
  });

  it('a lake on a thumb is explained with the info-max model, never as "a seat it already knows"', () => {
    for (const thumb of ['P2', 'P5']) {
      const ex = explainLakeTarget(o, thumb, eligible, ON);
      expect(ex.rule).toBe('好人湖：共同資訊極大化');
      expect(ex.reason).not.toContain('自己已知身分');
    }
    // With the blue lake off (legacy), the thumbs are avoided and called known.
    const legacy = explainLakeTarget(o, 'P2', eligible, { ...ON, percivalBlueLake: false });
    expect(legacy.reason).toContain('自己已知身分');
  });
});

// ── Practice-review texts ──────────────────────────────────────

describe('review: practice-review texts', () => {
  it('the legacy Percival on-team approval is described without an English identifier', () => {
    const quests = [quest(1, ['P1', 'P3', 'P4'], 0), quest(2, ['P1', 'P3', 'P7', 'P8'], 0)];
    const o: PlayerObservation = {
      ...goodObs({ me: 'P6', role: 'percival', phase: 'team_vote', round: 3, knownWizards: ['P2', 'P5'], quests }),
      currentLeader: 'P1', proposedTeam: ['P1', 'P6', 'P3', 'P7'],
    };
    const agent = new HeuristicAgent('P6', undefined, undefined, { ...ON, percivalLoyalVote: false });
    const r = replayRule(o, agent, { type: 'team_vote', vote: true }, { forwardActive: true });
    expect(r?.rule).toBeDefined();
    expect(r?.rule).not.toMatch(/[A-Za-z]/);
  });

  it('a red holder that cannot make any possible claim says why it declares nothing', () => {
    // R1 {P1, P2, P3} showed three fail cards: all three are publicly red; P1 lakes P2.
    const o: PlayerObservation = {
      myPlayerId: 'P1', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: IDS,
      knownEvils: ['P2', 'P3'], currentRound: 2, currentLeader: 'P4', failCount: 0, questResults: ['fail'],
      gamePhase: 'team_select', voteHistory: [passed(1, 'P1', ['P1', 'P2', 'P3'])],
      questHistory: [quest(1, ['P1', 'P2', 'P3'], 3)], proposedTeam: [], lakeHistory: [],
    };
    const ex = explainLakeClaim(o, 'P2', 'evil', null, ON);
    expect(ex.rule).toMatch(/^紅方只做可能為真的宣告/);
    expect(explainLakeClaim(o, 'P2', 'evil', null, { ...ON, redPossibleClaimsOnly: false }).rule).toBeUndefined();
  });

  it('a good leader whose top team the gates barred gets the gate as the reason', () => {
    const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../__tests__/fixtures/logic_gates/r5_must_fail_reuse.json'), 'utf8')) as {
      seed: string; obs: PlayerObservation;
    };
    const o = withoutNoStall(fx.obs);
    // On the pyramid (the scorer this fixture came from); with `bayesBelief` (2026-10-28) the top team is no
    // longer a must-fail one, so no gate has to bar it.
    const agent = new HeuristicAgent(o.myPlayerId, undefined, undefined, { ...ON, bayesBelief: false });
    const view = buildCertainty(o);
    const r = withSeededRandom(fx.seed, () => replayRule(o, agent, { type: 'team_select', teamIds: [] }, { forwardActive: true }));
    expect(r?.rule).toMatch(/^邏輯閘門（好人隊長）：前向推理原本最高分的隊 .*（必敗隊） → 不派/);
    expect(view.l1Empty).toBe(false);
  });
});

// ── The engine's quest sizes ───────────────────────────────────

describe('review: the bot fallback team fits the engine\'s quest size', () => {
  const seats = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  it('keeps the leader and the agent\'s pick, trims or pads to the size', () => {
    expect(fitTeamToSize(['c', 'a', 'd'], 4, 'c', seats)).toEqual(['c', 'a', 'd', 'b']); // swapR1R2 / 9p variant: one more
    expect(fitTeamToSize(['c', 'a', 'd', 'e'], 3, 'c', seats)).toEqual(['c', 'a', 'd']); // one fewer
    expect(fitTeamToSize([], 3, 'e', seats)).toEqual(['e', 'a', 'b']); // the old fallback shape
    expect(fitTeamToSize(['x', 'a', 'a'], 2, 'e', seats)).toEqual(['a', 'e']); // unknown ids and duplicates dropped
  });
});
