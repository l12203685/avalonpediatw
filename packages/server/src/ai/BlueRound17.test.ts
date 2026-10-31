/**
 * 優化迴圈第 17 回合・藍方：`beliefKeyVoteCells`（關鍵局的票讀機器人表的 `voteKey` 格子）與 `merlinReuseNorm`（梅林照派成功的隊）。
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { merlinLoyalStyleTeam, merlinReuseNormTeam } from './MerlinLoyalStyle';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const vote = (round: number, attempt: number, leader: string, team: string[], yes: string[]) => ({
  round, attempt, leader, team, approved: false, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])),
});

// R4 after two fails (a key round): P2 proposes P2 P3 P4 P5 P6; off-team P7 approves.
const keyObs = {
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P3', failCount: 1, questResults: ['fail', 'success', 'fail'], gamePhase: 'team_select',
  questHistory: [], lakeHistory: [], proposedTeam: [],
  voteHistory: [vote(4, 1, 'P2', ['P2', 'P3', 'P4', 'P5', 'P6'], ['P2', 'P3', 'P4', 'P5', 'P6', 'P7'])],
} as unknown as PlayerObservation;

describe('beliefKeyVoteCells', () => {
  it('off: the same posterior as before (the key cells are read only with the switch)', () => {
    const base = bayesRedShare(keyObs, { botTables: 1 });
    const off = bayesRedShare(keyObs, { botTables: 1, keyVoteCells: false });
    for (const id of IDS) expect(off.get(id)).toBeCloseTo(base.get(id) ?? 0, 12);
  });
  it('a table without voteKey cells reads as before with the switch on (falls back to the R3+ cells)', () => {
    // The human table has no voteKey cells: weight 0 reads it alone.
    const off = bayesRedShare(keyObs, { botTables: 0 });
    const on = bayesRedShare(keyObs, { botTables: 0, keyVoteCells: true });
    for (const id of IDS) expect(on.get(id)).toBeCloseTo(off.get(id) ?? 0, 12);
  });
  it('a non-key round is unchanged with the switch on', () => {
    const r3 = { ...keyObs, questResults: ['fail', 'success', 'success'] } as PlayerObservation;
    const off = bayesRedShare(r3, { botTables: 1, botTablesNext: true });
    const on = bayesRedShare(r3, { botTables: 1, botTablesNext: true, keyVoteCells: true });
    for (const id of IDS) expect(on.get(id)).toBeCloseTo(off.get(id) ?? 0, 12);
  });
  it('bayesOptionsOf carries the switch', () => {
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, beliefKeyVoteCells: true }).keyVoteCells).toBe(true);
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).keyVoteCells).toBe(DEFAULT_AGENT_TUNING.beliefKeyVoteCells);
  });
});

describe('merlinReuseNorm (Edward: 任務成功後照派是常態；梅林可以隨局勢派拇指，不能為了躲刺)', () => {
  // R1 P2 P3 P4 succeeded with the assassin P3 hiding; Merlin P1 sees P3 P7 P9.
  const mobs = {
    myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P3', 'P7', 'P9'],
    currentRound: 2, currentLeader: 'P1', failCount: 1, questResults: ['success'], gamePhase: 'team_select',
    questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }],
    voteHistory: [], proposedTeam: [], lakeHistory: [],
  } as unknown as PlayerObservation;
  const ON = { ...DEFAULT_AGENT_TUNING, merlinLoyalStyle: true, merlinReuseNorm: 1 };
  const draft = { type: 'team_select' as const, teamIds: ['P1', 'P2', 'P4', 'P5'] };
  it('on a doomed R2 proposal Merlin re-proposes the successful R1 team (plus himself), seen red and all', () => {
    const a = merlinLoyalStyleTeam(ON, mobs, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect([...a.teamIds].sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
  });
  it('off: Merlin never sends a seen red', () => {
    const a = merlinLoyalStyleTeam({ ...ON, merlinReuseNorm: 0 }, mobs, draft);
    if (a.type !== 'team_select') throw new Error(a.type);
    expect(a.teamIds.some((id) => ['P3', 'P7', 'P9'].includes(id))).toBe(false);
  });
  it('not on the forced fifth proposal, not from R3, not after a failed mission, not when the team holds no seen red', () => {
    expect(merlinReuseNormTeam(ON, { ...mobs, failCount: 4 } as PlayerObservation, 4)).toBeNull();
    expect(merlinReuseNormTeam(ON, { ...mobs, currentRound: 3, questResults: ['success', 'success'] } as PlayerObservation, 4)).toBeNull();
    expect(merlinReuseNormTeam(ON, { ...mobs, questResults: ['fail'], questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 }] } as unknown as PlayerObservation, 4)).toBeNull();
    expect(merlinReuseNormTeam(ON, { ...mobs, knownEvils: ['P5', 'P7', 'P9'] } as PlayerObservation, 4)).toBeNull();
  });
  it('Merlin already on the successful team: the team plus the cleanest public pick without a seen red', () => {
    const t = merlinReuseNormTeam(ON, { ...mobs, questHistory: [{ round: 1, team: ['P1', 'P2', 'P3'], result: 'success', failCount: 0 }] } as unknown as PlayerObservation, 4);
    expect(t?.slice(0, 3)).toEqual(['P1', 'P2', 'P3']);
    expect(t?.length).toBe(4);
    expect(['P3', 'P7', 'P9'].includes(t?.[3] ?? 'P3')).toBe(false);
  });
});

describe('percivalMorganaR1 (round 16: a lone Morgana fails R1)', () => {
  // Thumbs P2 / P5; R1 P2 P3 P4 succeeded. If P2 were Morgana she would be a lone red there only if P3, P4 are blue.
  const pobs = {
    myPlayerId: 'P1', myRole: 'percival', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [], knownWizards: ['P2', 'P5'],
    currentRound: 2, currentLeader: 'P6', failCount: 0, questResults: ['success'], gamePhase: 'team_select',
    questHistory: [{ round: 1, team: ['P2', 'P3', 'P4'], result: 'success', failCount: 0 }], voteHistory: [], proposedTeam: [], lakeHistory: [],
  } as unknown as PlayerObservation;
  const base = { botTables: 1, strictMerlin: true };
  it('the thumb on the successful R1 team reads more like Merlin', () => {
    const off = bayesRedShare(pobs, base);
    const on = bayesRedShare(pobs, { ...base, morganaR1: true });
    expect(on.get('P2') ?? 1).toBeLessThan((off.get('P2') ?? 0) - 0.05);
    expect(on.get('P5') ?? 0).toBeGreaterThan(off.get('P5') ?? 1);
  });
  it('Percival only: a loyal reads the same', () => {
    const lobs = { ...pobs, myRole: 'loyal', knownWizards: undefined } as unknown as PlayerObservation;
    const off = bayesRedShare(lobs, base);
    const on = bayesRedShare(lobs, { ...base, morganaR1: true });
    for (const id of IDS) expect(on.get(id)).toBeCloseTo(off.get(id) ?? 0, 12);
  });
});
