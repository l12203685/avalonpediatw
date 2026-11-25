/**
 * 第 78 回合：紅方的任務牌（`r4KeyFail78` 第 4 局紅方已兩勝、看得到的紅不夠；`redPairOne78`／`redPairAlways78` 兩個相認紅同隊；Round78.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, type AgentTuning } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';
import { redMatchPointFailCard } from './RedRound29';
import { enoughRedsProb78, inR4KeyCell78, lastJointHid78, pairCard78, pairMate78, pairStatus78, r4KeyFailCard78, round78On } from './Round78';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const asObs = (o: object) => o as unknown as PlayerObservation;
/** the baseline with every round-78 switch off (the baseline adopts `redPairOne78=4`; the tests switch things on from here). */
const OFF: AgentTuning = { ...DEFAULT_AGENT_TUNING, redPairOne78: 0 };
const on = (over: Partial<AgentTuning>): AgentTuning => ({ ...OFF, ...over });

// 紅方：P7 刺客、P8 莫甘娜、P9 莫德雷德、P10 奧伯倫。
const RED: Record<string, { role: string; sees: string[] }> = {
  P7: { role: 'assassin', sees: ['P8', 'P9'] },
  P8: { role: 'morgana', sees: ['P7', 'P9'] },
  P9: { role: 'mordred', sees: ['P7', 'P8'] },
  P10: { role: 'oberon', sees: [] },
};
type Quest = { round: number; team: string[]; result: 'success' | 'fail'; failCount: number };
const card = (me: string, round: number, team: string[], quests: Quest[], extra: object = {}) => asObs({
  myPlayerId: me, myRole: RED[me].role, myTeam: 'evil', playerCount: 10, allPlayerIds: IDS, knownEvils: RED[me].sees,
  currentRound: round, currentLeader: team[0], failCount: 0, questResults: quests.map((q) => q.result), gamePhase: 'quest_vote',
  questHistory: quests, voteHistory: [], proposedTeam: team, lakeHistory: [], myLakeResults: [], ...extra,
});
const q = (round: number, team: string[], failCount: number, need = 1): Quest => ({ round, team, result: failCount >= need ? 'fail' : 'success', failCount });
// 比分 1:2 的第 4 局：第 1 局 P1 P2 P7 失敗、第 2 局成功、第 3 局 P3 P4 P5 P9 失敗。
const KEY_HISTORY = [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P1', 'P2', 'P3', 'P4'], 0), q(3, ['P3', 'P4', 'P5', 'P9'], 1)];
// 比分 2:1 的第 4 局。
const OPEN_HISTORY = [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P1', 'P2', 'P3', 'P4'], 0), q(3, ['P1', 'P2', 'P3', 'P4'], 0)];
const R4_TEAM = ['P1', 'P2', 'P3', 'P4', 'P10'];

const play = (tuning: AgentTuning, obs: PlayerObservation): string => {
  // The production path (ForwardAgent around the baseline agent), as GameServer runs it.
  const agent = new ForwardAgent(obs.myPlayerId, new HeuristicAgent(obs.myPlayerId, undefined, undefined, tuning));
  const act = withSeededRandom('round78', () => agent.act(obs));
  return act.type === 'quest_vote' ? act.vote : '?';
};

describe('round 78 tuning fields', () => {
  it('off in the legacy table and on every human profile, redPairOne78=4 on the baseline; flags parse and describe', () => {
    for (const k of ['r4KeyFail78', 'r4KeyFail78Roles', 'redPairOne78', 'redPairOne78Who', 'redPairAlways78'] as const) {
      expect(DEFAULT_AGENT_TUNING[k]).toBe(k === 'redPairOne78' ? 4 : 0); // round 78: baseline adopts redPairOne78=4 (R3 only)
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
    }
    expect(round78On(LEGACY_AGENT_TUNING)).toBe(false);
    expect(round78On(DEFAULT_AGENT_TUNING)).toBe(true);
    expect(round78On({ ...DEFAULT_AGENT_TUNING, redPairOne78: 0 })).toBe(false);
    // human tables keep the rank order (the seat convention needs a bot teammate); the ai profile is the baseline itself
    for (const t of OPPONENT_TYPES) expect(round78On(tuningForOpponent(t, DEFAULT_AGENT_TUNING))).toBe(t === 'ai');
    expect(parseTuningFlag('r4KeyFail78')).toEqual({ r4KeyFail78: 1 });
    expect(parseTuningFlag('r4KeyFail78=0.3')).toEqual({ r4KeyFail78: 0.3 });
    expect(parseTuningFlag('r4KeyFail78Roles=1')).toEqual({ r4KeyFail78Roles: 1 });
    expect(parseTuningFlag('redPairOne78')).toEqual({ redPairOne78: 6 });
    expect(parseTuningFlag('redPairOne78Who=2')).toEqual({ redPairOne78Who: 2 });
    expect(parseTuningFlag('redPairAlways78=2')).toEqual({ redPairAlways78: 2 });
    expect(() => parseTuningFlag('r4KeyFail78=1.5')).toThrow();
    expect(() => parseTuningFlag('r4KeyFail78Roles=4')).toThrow();
    expect(() => parseTuningFlag('redPairOne78=8')).toThrow();
    expect(describeAgentTuning(on({ redPairOne78: 6, redPairOne78Who: 2 }))).toContain('redPairOne78=6');
    expect(describeAgentTuning(on({ r4KeyFail78: 0.3 }))).toContain('r4KeyFail78=0.3');
  });
});

describe('r4KeyFail78: the two-fail mission at red match point with too few reds in sight', () => {
  const oberon = card('P10', 4, R4_TEAM, KEY_HISTORY);
  const lone = card('P8', 4, ['P1', 'P2', 'P3', 'P4', 'P8'], KEY_HISTORY);

  it('the cell: two fails needed, red has two wins, the reds this seat sees cannot fail it alone', () => {
    expect(inR4KeyCell78(oberon)).toBe(true);
    expect(inR4KeyCell78(lone)).toBe(true);
    // Two recognised reds on the team: `redMatchPointFail` (the hard constraint) owns it.
    const pair = card('P8', 4, ['P1', 'P2', 'P3', 'P7', 'P8'], KEY_HISTORY);
    expect(inR4KeyCell78(pair)).toBe(false);
    expect(redMatchPointFailCard(OFF, pair)).toBe('fail');
    // Blue has two wins (2:1), one-fail rounds, off the team, blue seats: not the cell.
    expect(inR4KeyCell78(card('P10', 4, R4_TEAM, OPEN_HISTORY))).toBe(false);
    expect(inR4KeyCell78(card('P10', 3, ['P1', 'P2', 'P3', 'P10'], KEY_HISTORY.slice(0, 2)))).toBe(false);
    expect(inR4KeyCell78(card('P10', 4, ['P1', 'P2', 'P3', 'P4', 'P5'], KEY_HISTORY))).toBe(false);
    expect(inR4KeyCell78(asObs({ ...(oberon as unknown as object), myTeam: 'good', myRole: 'loyal' }))).toBe(false);
  });

  it('off: the lone red hides as before (redHideR4Solo); 1: fails; the role mask picks Oberon or the recognised reds', () => {
    expect(r4KeyFailCard78(OFF, oberon)).toBeNull();
    expect(play(OFF, oberon)).toBe('success');
    expect(play(OFF, lone)).toBe('success');
    expect(play(on({ r4KeyFail78: 1 }), oberon)).toBe('fail');
    expect(play(on({ r4KeyFail78: 1 }), lone)).toBe('fail');
    expect(play(on({ r4KeyFail78: 1, r4KeyFail78Roles: 1 }), oberon)).toBe('fail');
    expect(play(on({ r4KeyFail78: 1, r4KeyFail78Roles: 1 }), lone)).toBe('success');
    expect(play(on({ r4KeyFail78: 1, r4KeyFail78Roles: 2 }), oberon)).toBe('success');
    expect(play(on({ r4KeyFail78: 1, r4KeyFail78Roles: 2 }), lone)).toBe('fail');
  });

  it('a threshold reads the seat\'s own posterior that the team can fail the mission', () => {
    const p = enoughRedsProb78(OFF, oberon);
    expect(p).not.toBeNull();
    const prob = p as number;
    expect(prob).toBeGreaterThan(0);
    expect(prob).toBeLessThan(1);
    expect(r4KeyFailCard78(on({ r4KeyFail78: Math.max(0.001, prob - 0.01) }), oberon)).toBe('fail');
    expect(r4KeyFailCard78(on({ r4KeyFail78: Math.min(0.999, prob + 0.01) }), oberon)).toBeNull();
  });

  it('leaves every other card alone: 2:1, the match-point hard constraint, blue seats', () => {
    const t = on({ r4KeyFail78: 1 });
    const open = card('P10', 4, R4_TEAM, OPEN_HISTORY);
    expect(r4KeyFailCard78(t, open)).toBeNull();
    expect(play(t, open)).toBe(play(OFF, open));
    const r3 = card('P10', 3, ['P1', 'P2', 'P3', 'P10'], [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P3', 'P4', 'P5', 'P9'], 1)]);
    expect(play(t, r3)).toBe('fail');
    expect(play(OFF, r3)).toBe('fail');
  });
});

describe('redPairOne78 / redPairAlways78: two recognised reds on a one-fail mission', () => {
  const R2_TEAM = ['P1', 'P2', 'P8', 'P9'];
  const dmR2 = (me: string, quests: Quest[] = [q(1, ['P1', 'P2', 'P3'], 0)]) => card(me, 2, R2_TEAM, quests);

  it('the cell: R1–R3, one fail needed, neither side at two wins, exactly one recognised teammate on the team', () => {
    expect(pairMate78(dmR2('P8'))).toBe('P9');
    expect(pairMate78(dmR2('P9'))).toBe('P8');
    expect(pairMate78(card('P8', 2, ['P1', 'P2', 'P3', 'P8'], [q(1, ['P1', 'P2', 'P3'], 0)]))).toBeNull();
    expect(pairMate78(card('P8', 2, ['P1', 'P7', 'P8', 'P9'], [q(1, ['P1', 'P2', 'P3'], 0)]))).toBeNull();
    expect(pairMate78(card('P10', 2, ['P1', 'P2', 'P8', 'P10'], [q(1, ['P1', 'P2', 'P3'], 0)]))).toBeNull();
    // Red already has two wins: the match-point rule owns it.
    expect(pairMate78(card('P8', 3, R2_TEAM, [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P3', 'P4', 'P5', 'P10'], 1)]))).toBeNull();
    expect(pairMate78(card('P8', 4, ['P1', 'P2', 'P3', 'P8', 'P9'], OPEN_HISTORY))).toBeNull();
  });

  it('off: the rank order (Morgana + Mordred on R2 both hide, the assassin + Morgana on R3 both fail)', () => {
    expect(pairCard78(OFF, dmR2('P8'))).toBeNull();
    expect([play(OFF, dmR2('P8')), play(OFF, dmR2('P9'))]).toEqual(['success', 'success']);
    const h = [q(1, ['P1', 'P2', 'P3'], 0), q(2, ['P1', 'P2', 'P3', 'P10'], 1)];
    const am = (me: string) => card(me, 3, ['P1', 'P2', 'P7', 'P8'], h);
    expect([play(OFF, am('P7')), play(OFF, am('P8'))]).toEqual(['fail', 'fail']);
  });

  it('seat order (Who 1): exactly one fail from every pair, the earlier seat', () => {
    const t = on({ redPairOne78: 6 });
    expect([play(t, dmR2('P8')), play(t, dmR2('P9'))]).toEqual(['fail', 'success']);
    const h = [q(1, ['P1', 'P2', 'P3'], 0), q(2, ['P1', 'P2', 'P3', 'P10'], 1)];
    for (const [a, b] of [['P7', 'P8'], ['P7', 'P9'], ['P8', 'P9']] as const) {
      const team = ['P1', 'P2', a, b];
      expect([play(t, card(a, 3, team, h)), play(t, card(b, 3, team, h))]).toEqual(['fail', 'success']);
    }
    // The round mask: R3 only leaves R2 to the rank order.
    expect(pairCard78(on({ redPairOne78: 4 }), dmR2('P8'))).toBeNull();
    // R1 only with bit 1.
    const r1 = (me: string) => card(me, 1, ['P1', 'P8', 'P9'], []);
    expect(pairCard78(t, r1('P8'))).toBeNull();
    expect([pairCard78(on({ redPairOne78: 7 }), r1('P8')), pairCard78(on({ redPairOne78: 7 }), r1('P9'))]).toEqual(['fail', 'success']);
  });

  it('the public record of the two reds: F failed alone before, H hid alone before, N neither', () => {
    // P9 was the only recognised red on a mission with a fail card; P8 has no mission of her own.
    const failed = dmR2('P8', [q(1, ['P1', 'P2', 'P9'], 1)]);
    expect(pairStatus78(failed, 'P8', 'P9')).toEqual(['N', 'F']);
    expect(pairStatus78(dmR2('P9', [q(1, ['P1', 'P2', 'P9'], 1)]), 'P9', 'P8')).toEqual(['F', 'N']);
    expect(pairStatus78(dmR2('P8', [q(1, ['P1', 'P2', 'P9'], 0)]), 'P8', 'P9')).toEqual(['N', 'H']);
    // Together on a mission: none failed → both hid; one fail card with equal records → cannot tell who.
    expect(pairStatus78(dmR2('P8', [q(1, ['P1', 'P8', 'P9'], 0)]), 'P8', 'P9')).toEqual(['H', 'H']);
    expect(pairStatus78(dmR2('P8', [q(1, ['P1', 'P8', 'P9'], 1)]), 'P8', 'P9')).toEqual(['N', 'N']);
    expect(pairStatus78(dmR2('P8', [q(1, ['P1', 'P8', 'P9'], 2)]), 'P8', 'P9')).toEqual(['F', 'F']);
    // The earlier failer keeps failing through a joint mission with one fail card.
    const h3 = [q(1, ['P1', 'P2', 'P9'], 1), q(2, ['P1', 'P2', 'P8', 'P9'], 1)];
    expect(pairStatus78(card('P8', 3, R2_TEAM, h3), 'P8', 'P9')).toEqual(['N', 'F']);
    // Both seats compute the same pair (mirrored).
    const [a, b] = pairStatus78(card('P9', 3, R2_TEAM, h3), 'P9', 'P8');
    expect([b, a]).toEqual(['N', 'F']);
    expect(lastJointHid78(dmR2('P8', [q(1, ['P1', 'P8', 'P9'], 0)]), 'P8', 'P9')).toBe(true);
    expect(lastJointHid78(dmR2('P8', [q(1, ['P1', 'P8', 'P9'], 1)]), 'P8', 'P9')).toBe(false);
    expect(lastJointHid78(dmR2('P8'), 'P8', 'P9')).toBe(false);
  });

  it('the record first (Who 2): the earlier failer fails and the other hides; the earlier hider hides and the other fails', () => {
    const t = on({ redPairOne78: 6, redPairOne78Who: 2 });
    const f = [q(1, ['P1', 'P2', 'P9'], 1)];
    expect([play(t, dmR2('P8', f)), play(t, dmR2('P9', f))]).toEqual(['success', 'fail']);
    const h = [q(1, ['P1', 'P2', 'P9'], 0)];
    expect([play(t, dmR2('P8', h)), play(t, dmR2('P9', h))]).toEqual(['fail', 'success']);
    // The assassin who failed alone before keeps failing and Morgana hides on R3 (the rank order: both fail).
    const h3 = [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P1', 'P2', 'P3', 'P4'], 0)];
    const am = (me: string) => card(me, 3, ['P1', 'P2', 'P7', 'P8'], h3);
    expect([play(t, am('P7')), play(t, am('P8'))]).toEqual(['fail', 'success']);
    expect([play(OFF, am('P7')), play(OFF, am('P8'))]).toEqual(['fail', 'fail']);
  });

  it('equal records (Who 2): the rank order as before, except Morgana fails after the pair hid together', () => {
    const t = on({ redPairOne78: 6, redPairOne78Who: 2 });
    // No record: unchanged.
    expect(pairCard78(t, dmR2('P8'))).toBeNull();
    expect([play(t, dmR2('P8')), play(t, dmR2('P9'))]).toEqual(['success', 'success']);
    // Hid together on R1 (only Morgana + Mordred do under the rank order): Morgana fails on R2, Mordred still hides.
    const joint = [q(1, ['P1', 'P8', 'P9'], 0)];
    expect([play(t, dmR2('P8', joint)), play(t, dmR2('P9', joint))]).toEqual(['fail', 'success']);
    expect([play(OFF, dmR2('P8', joint)), play(OFF, dmR2('P9', joint))]).toEqual(['success', 'success']);
    // Who 3: equal records fall back to the seat order.
    const x = on({ redPairOne78: 6, redPairOne78Who: 3 });
    expect([play(x, dmR2('P8')), play(x, dmR2('P9'))]).toEqual(['fail', 'success']);
  });

  it('redPairAlways78: this red fails whatever the teammate does; redPairOne78 wins on a round both cover', () => {
    const t = on({ redPairAlways78: 2 });
    expect([play(t, dmR2('P8')), play(t, dmR2('P9'))]).toEqual(['fail', 'fail']);
    const h = [q(1, ['P1', 'P2', 'P3'], 0), q(2, ['P1', 'P2', 'P3', 'P10'], 1)];
    expect(pairCard78(t, card('P9', 3, ['P1', 'P2', 'P8', 'P9'], h))).toBeNull();
    const both = on({ redPairAlways78: 6, redPairOne78: 2 });
    expect([play(both, dmR2('P8')), play(both, dmR2('P9'))]).toEqual(['fail', 'success']);
  });

  it('red already at two wins: every recognised red still fails (the hard constraint is ahead of these switches)', () => {
    const t = on({ redPairOne78: 7, redPairOne78Who: 1, redPairAlways78: 7, r4KeyFail78: 1 });
    const h = [q(1, ['P1', 'P2', 'P7'], 1), q(2, ['P3', 'P4', 'P5', 'P10'], 1)];
    for (const me of ['P8', 'P9']) expect(play(t, card(me, 3, R2_TEAM, h))).toBe('fail');
    const r4 = (me: string) => card(me, 4, ['P1', 'P2', 'P3', 'P8', 'P9'], KEY_HISTORY);
    for (const me of ['P8', 'P9']) expect(play(t, r4(me))).toBe('fail');
  });
});
