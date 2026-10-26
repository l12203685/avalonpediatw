/**
 * Edward 2026-10-26 (two table conventions, certainty layer L1, and the lake policy):
 *   - A1 "no stalling":「任務已經兩局失敗 … 任務是 CDEF 四位玩家出去且任務成功，此時因為不會刻意拖延遊戲，
 *     CDEF 必為四好」— after two failed missions a success holds fewer reds than that round's fails required;
 *   - 還湖 / A2:「A>B 壞 … B 該做的就是把湖中女神湖給 CDEF 任一位玩家，稱為還湖；如果 B 不這麼做 = 認壞
 *     （但不代表 A 為好人）」.
 *
 * 10 players (4 reds), seats P1..P10. R1 and R2 failed (P7 P8 P9 / P7 P8 P9 P10 with one fail each),
 * R3 (P3 P4 P5 P6, the CDEF of the example) succeeded. Lake 1 after R2: P1 → P2, declared red.
 */
import { describe, expect, it } from 'vitest';
import type { LakePublicRecord, PlayerObservation, QuestRecord } from './types';
import { admittedReds, buildPublicCertainty, noStallCaps, returnLakeOptions } from './belief/Certainty';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING } from './AgentTuning';
import { pickLakeTargetForTeam } from './LakePolicy';
import { explainLakeTarget } from './explain';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function quest(round: number, team: string[], failCount: number): QuestRecord {
  return { round, team, result: failCount > 0 ? 'fail' : 'success', failCount };
}

const QUESTS = [quest(1, ['P7', 'P8', 'P9'], 1), quest(2, ['P7', 'P8', 'P9', 'P10'], 1), quest(3, ['P3', 'P4', 'P5', 'P6'], 0)];
const ACCUSED: LakePublicRecord = { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'evil' };

function obs(partial: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P2', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
    currentRound: 3, currentLeader: 'P2', failCount: 0, questResults: ['fail', 'fail', 'success'],
    gamePhase: 'team_select', voteHistory: [], questHistory: QUESTS, proposedTeam: [], lakeHistory: [ACCUSED],
    ...partial,
  };
}

describe('A1 — no stalling after two failed missions', () => {
  it('a success after two fails caps its reds below the fails required: the four of R3 are certainly good', () => {
    expect(noStallCaps(obs(), { failsRequired: [1, 1, 1, 2, 1] })).toEqual([{ team: ['P3', 'P4', 'P5', 'P6'], max: 0 }]);
    const v = buildPublicCertainty(obs());
    expect(v.certGood('L1*').sort()).toEqual(['P3', 'P4', 'P5', 'P6']);
    // Only at L1: L0 is the game rules alone.
    expect(v.certGood('L0')).toEqual([]);
  });

  it('a two-fail round caps at one red; a success before the second fail caps nothing', () => {
    const r4 = [quest(1, ['P7', 'P8', 'P9'], 1), quest(2, ['P7', 'P8', 'P9', 'P10'], 1), quest(3, ['P3', 'P4', 'P5', 'P6'], 0), quest(4, ['P1', 'P3', 'P4', 'P5', 'P6'], 0)];
    expect(noStallCaps({ questHistory: r4 }, { failsRequired: [1, 1, 1, 2, 1] }).map((c) => c.max)).toEqual([0, 1]);
    const early = [quest(1, ['P7', 'P8', 'P9'], 1), quest(2, ['P3', 'P4', 'P5', 'P6'], 0)];
    expect(noStallCaps({ questHistory: early }, { failsRequired: [1, 1, 1, 2, 1] })).toEqual([]);
  });
});

describe('還湖 — the accused holder returns the lake to a certainly-good seat', () => {
  const valid = IDS.filter((id) => id !== 'P1' && id !== 'P2');

  it('the options are the certainly-good seats it may lake; none unless the previous lake declared it red', () => {
    expect(returnLakeOptions(obs(), 'P2', valid)).toEqual(['P3', 'P4', 'P5', 'P6']);
    expect(returnLakeOptions(obs({ lakeHistory: [{ ...ACCUSED, declaredClaim: 'good' }] }), 'P2', valid)).toEqual([]);
    expect(returnLakeOptions(obs(), 'P5', valid)).toEqual([]); // not the accused
  });

  it('good and red holders both return it (first by seat order) when the switch is on; off = the old rules', () => {
    for (const team of ['good', 'evil'] as const) {
      const o = obs({ myTeam: team, myRole: team === 'good' ? 'loyal' : 'morgana', knownEvils: team === 'evil' ? ['P7', 'P8', 'P9'] : [] });
      expect(pickLakeTargetForTeam(team, o, valid, DEFAULT_AGENT_TUNING)).toBe('P3');
    }
    expect(DEFAULT_AGENT_TUNING.returnLake).toBe(true);
    expect(LEGACY_AGENT_TUNING.returnLake).toBe(false);
  });

  it('the practice review says it returned the lake', () => {
    const ex = explainLakeTarget(obs(), 'P3', valid, DEFAULT_AGENT_TUNING);
    expect(ex.rule).toMatch(/^還湖/);
    expect(ex.reason).toContain('還湖');
    expect(explainLakeTarget(obs(), 'P3', valid, LEGACY_AGENT_TUNING).rule ?? '').not.toMatch(/^還湖/);
  });
});

describe('A2 — not returning the lake admits being red, and says nothing about the accuser', () => {
  it('lakes someone outside the certainly-good four: red at L1; the accuser is not cleared', () => {
    const o = obs({ myPlayerId: 'P10', lakeHistory: [ACCUSED, { round: 3, holderId: 'P2', targetId: 'P7', declaredClaim: 'good' }] });
    expect(admittedReds(o)).toEqual(['P2']);
    const v = buildPublicCertainty(o);
    expect(v.isCertRed('P2', 'L1*')).toBe(true);
    expect(v.isCertGood('P1', 'L1*')).toBe(false);
  });

  it('returned the lake (or had nobody certain to return it to): no admission', () => {
    expect(admittedReds(obs({ lakeHistory: [ACCUSED, { round: 3, holderId: 'P2', targetId: 'P4', declaredClaim: 'good' }] }))).toEqual([]);
    // Before the R3 success nobody is certainly good: lake 2 right after R2 cannot be a refusal.
    const noR3 = obs({ questHistory: QUESTS.slice(0, 2), lakeHistory: [ACCUSED, { round: 2, holderId: 'P2', targetId: 'P7', declaredClaim: 'good' }] });
    expect(admittedReds(noR3)).toEqual([]);
  });
});
