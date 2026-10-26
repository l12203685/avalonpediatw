/**
 * Certainty layer (S1-0, 2026-10-14; docs/ai/logic_first.md). Fixtures from
 * logic_audit.md §2 / §3 plus property tests over random histories:
 *   - every kept world satisfies C2 (and the role sight), the truth is always
 *     kept at L0 and — with truthful good holders — at L1;
 *   - K1 / K3 ordering and K2 under ANY belief supported on the L1 worlds;
 *   - C4 / C5 / C6, P1, P2, P3, M2, Pe1 / Pe2 deductions;
 *   - 5 / 7 / 9 / 10 players, Morgana off, the 9-player Oberon variant;
 *   - X1 (R4 needs two certain reds), X4 (strict dominance), the L1-empty
 *     fallback, undeclared lakes.
 */
import { describe, expect, it } from 'vitest';
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import type { PlayerObservation, QuestRecord, LakePublicRecord, PrivateLakeResult } from '../types';
import {
  buildCertainty,
  buildPublicCertainty,
  certaintyParamsFor,
  claimPossibleForGoodHolder,
  evilCountFor,
  popcount,
  returnLakeOptions,
} from './Certainty';
import { seededRandom } from '../benchmark/agreement';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `P${i + 1}`);
const P = (...seats: number[]): string[] => seats.map((s) => `P${s}`);

function quest(round: number, team: string[], failCount: number): QuestRecord {
  return { round, team, result: failCount > 0 ? 'fail' : 'success', failCount };
}

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P10',
    myRole: 'loyal',
    myTeam: 'good',
    playerCount: 10,
    allPlayerIds: ids(10),
    knownEvils: [],
    currentRound: 3,
    currentLeader: 'P10',
    failCount: 0,
    questResults: [],
    gamePhase: 'team_select',
    voteHistory: [],
    questHistory: [],
    proposedTeam: [],
    lakeHistory: [],
    ...partial,
  };
}

describe('Certainty — parameters', () => {
  it('player count, reds and fails required come from the game, not from a 10-player assumption', () => {
    expect(certaintyParamsFor(obs({}))).toEqual({ playerCount: 10, evilCount: 4, failsRequired: [1, 1, 1, 2, 1] });
    for (const n of [5, 6, 7, 8, 9]) {
      const p = certaintyParamsFor(obs({ playerCount: n, allPlayerIds: ids(n) }));
      expect(p.evilCount).toBe(evilCountFor(n));
      expect(p.failsRequired).toEqual(AVALON_CONFIG[n].questFailsRequired);
    }
    // The lobby's role setup overrides the table (9-player Oberon variant: 4 reds).
    expect(certaintyParamsFor(obs({ playerCount: 9, allPlayerIds: ids(9), evilCount: 4 })).evilCount).toBe(4);
    // World counts: a loyal sees C(9,4) = 126 at the start of a 10p game, C(8,3) = 56 in 9p, C(4,2) = 6 in 5p.
    expect(buildCertainty(obs({})).l0).toHaveLength(126);
    expect(buildCertainty(obs({ playerCount: 9, allPlayerIds: ids(9), myPlayerId: 'P9' })).l0).toHaveLength(56);
    expect(buildCertainty(obs({ playerCount: 9, allPlayerIds: ids(9), myPlayerId: 'P9', evilCount: 4 })).l0).toHaveLength(70);
    expect(buildCertainty(obs({ playerCount: 5, allPlayerIds: ids(5), myPlayerId: 'P5' })).l0).toHaveLength(6);
  });
});

describe('Certainty — deductions (logic_audit.md §2)', () => {
  it('P1 / C4: a loyal on a 3-player team with 2 fails knows the other two are red', () => {
    const v = buildCertainty(obs({ myPlayerId: 'P2', questHistory: [quest(1, P(2, 5, 8), 2)] }));
    expect(v.certRed().sort()).toEqual(P(5, 8).sort());
    expect(v.isCertGood('P2')).toBe(true);
  });

  it('C6: two disjoint failed teams with two fails each hold all four reds; everyone else is good', () => {
    const v = buildCertainty(obs({ questHistory: [quest(1, P(1, 2, 3), 2), quest(2, P(4, 5, 6, 7), 2)] }));
    expect(v.certGood().sort()).toEqual(P(8, 9, 10).sort());
    expect(v.minReds(P(1, 2, 3))).toBe(2);
    expect(v.entropyBits()).toBeCloseTo(Math.log2(3 * 6), 9);
  });

  it('C5: an R4 success with a fail card still proves a red on the team', () => {
    const r4 = { round: 4, team: P(1, 2, 3, 4, 5), result: 'success' as const, failCount: 1 };
    const v = buildCertainty(obs({ currentRound: 5, questHistory: [r4] }));
    expect(v.minReds(P(1, 2, 3, 4, 5))).toBe(1);
    // A success without a fail card proves nothing (C3).
    const clean = buildCertainty(obs({ currentRound: 5, questHistory: [{ ...r4, failCount: 0 }] }));
    expect(clean.minReds(P(1, 2, 3, 4, 5))).toBe(0);
  });

  it('M2: Merlin localises Mordred to a failed mission; the unseen seats off it are certainly good', () => {
    const merlin = obs({ myPlayerId: 'P7', myRole: 'merlin', knownEvils: P(1, 3, 9), questHistory: [quest(1, P(2, 4, 6), 1)] });
    const v = buildCertainty(merlin);
    expect(v.certRed().sort()).toEqual(P(1, 3, 9).sort());
    expect(v.certGood().sort()).toEqual(P(5, 7, 8, 10).sort());
    expect(v.l0).toHaveLength(3);
  });

  it('Pe1 / Pe2: exactly one thumb is red — both thumbs on a team hold a red; no thumb tells nothing', () => {
    const perc = obs({ myPlayerId: 'P6', myRole: 'percival', knownWizards: P(1, 9) });
    const v = buildCertainty(perc);
    expect(v.l0).toHaveLength(70);
    expect(v.minReds(P(1, 9, 6))).toBe(1);
    expect(v.minReds(P(2, 3, 6))).toBe(0);
    expect(v.certRed()).toEqual([]);
    // A lake on one thumb resolves both (P2 + Pe1).
    const laked = buildCertainty({ ...perc, myLakeResults: [{ round: 2, targetId: 'P1', result: 'good' }] });
    expect(laked.isCertGood('P1')).toBe(true);
    expect(laked.isCertRed('P9')).toBe(true);
  });

  it('Morgana off in the lobby: a lone thumb is Merlin, certainly good', () => {
    const v = buildCertainty(obs({ myPlayerId: 'P6', myRole: 'percival', knownWizards: ['P1'] }));
    expect(v.isCertGood('P1')).toBe(true);
  });

  it('P2: the holder\'s own lake result is a fact at L0 (no A0 needed)', () => {
    const own: PrivateLakeResult[] = [{ round: 2, targetId: 'P4', result: 'evil' }];
    const v = buildCertainty(obs({ myLakeResults: own }));
    expect(v.isCertRed('P4', 'L0')).toBe(true);
  });

  it('P3: whoever declared me red is red (A0 at L1), not at L0', () => {
    const lakes: LakePublicRecord[] = [{ round: 2, holderId: 'P3', targetId: 'P10', declaredClaim: 'evil' }];
    const v = buildCertainty(obs({ lakeHistory: lakes }));
    expect(v.isCertRed('P3', 'L1')).toBe(true);
    expect(v.isCertRed('P3', 'L0')).toBe(false);
  });

  it('a red viewer: self and the seen teammates are red; Oberon is among the rest', () => {
    const v = buildCertainty(obs({ myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', knownEvils: P(5, 8) }));
    expect(v.certRed().sort()).toEqual(P(2, 5, 8).sort());
    expect(v.l0).toHaveLength(7);
  });
});

describe('Certainty — X1 provably failable, X4 strict dominance, fallback, undeclared lakes', () => {
  it('X1: R4 needs two certain reds (10p), one fail suffices elsewhere; 7p R4 likewise, 5p never', () => {
    const v = buildCertainty(obs({ myPlayerId: 'P2', questHistory: [quest(1, P(2, 5, 8), 2)] }));
    expect(v.provablyFailable(P(5, 1, 3, 4), 3)).toBe(true);
    expect(v.provablyFailable(P(5, 1, 3, 4, 6), 4)).toBe(false);
    expect(v.provablyFailable(P(5, 8, 3, 4, 6), 4)).toBe(true);
    const seven = buildCertainty(obs({ playerCount: 7, allPlayerIds: ids(7), myPlayerId: 'P2', questHistory: [quest(1, P(2, 5), 1)] }));
    expect(seven.failsRequired(4)).toBe(2);
    expect(seven.provablyFailable(P(5, 1, 3, 4), 4)).toBe(false);
    expect(seven.provablyFailable(P(5, 1, 3), 3)).toBe(true);
    const five = buildCertainty(obs({ playerCount: 5, allPlayerIds: ids(5), myPlayerId: 'P2', questHistory: [quest(1, P(2, 5), 1)] }));
    expect(five.failsRequired(4)).toBe(1);
    expect(five.provablyFailable(P(5, 1, 3), 4)).toBe(true);
  });

  it('K1′ / K3 (the owner\'s A→B→C example): choosing A forces B, choosing B forces C — strictly, and pairwise so the chain closes', () => {
    const lakes: LakePublicRecord[] = [
      { round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' },
      { round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'good' },
    ];
    const v = buildCertainty(obs({ currentRound: 4, lakeHistory: lakes }));
    expect(v.strictlyDominated(P(10, 1, 5, 6))).toMatchObject({ holder: 'P1', target: 'P2' });
    expect(v.strictlyDominated(P(10, 1, 2, 6))).toMatchObject({ holder: 'P2', target: 'P3' });
    expect(v.strictlyDominated(P(10, 1, 2, 3))).toBeNull();
    expect(v.strictlyDominated(P(10, 4, 5, 6))).toBeNull();
  });

  it('X4: no violation when every other member is certainly good (swapping in B cannot help)', () => {
    // Reds are 2 of {2,3,4} and 2 of {5,6,9}: seats 1, 7, 8, 10 are certainly good.
    const base = buildCertainty(obs({ questHistory: [quest(1, P(2, 3, 4), 2), quest(2, P(5, 6, 9), 2)] }));
    expect(base.certGood().sort()).toEqual(P(1, 7, 8, 10).sort());
    const lakes: LakePublicRecord[] = [{ round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' }];
    const v = buildCertainty(obs({ questHistory: [quest(1, P(2, 3, 4), 2), quest(2, P(5, 6, 9), 2)], lakeHistory: lakes }));
    expect(v.isCertGood('P2')).toBe(true); // a certainly-good holder's word is a fact under A0
    expect(v.strictlyDominated(P(10, 1, 7, 8))).toBeNull();
    expect(v.strictlyDominated(P(10, 1, 7, 5))).toMatchObject({ holder: 'P1', target: 'P2', swap: 'P5' });
  });

  it('A0 contradiction: L1 is empty and L1* falls back to L0', () => {
    // 7 and 8 are certainly good (C6); 7 declaring 8 red cannot be true for a good 7.
    const o = obs({
      questHistory: [quest(1, P(1, 2, 3), 2), quest(2, P(4, 5, 6, 9), 2)],
      lakeHistory: [{ round: 2, holderId: 'P7', targetId: 'P8', declaredClaim: 'evil' }],
    });
    const v = buildCertainty(o);
    expect(v.l1Empty).toBe(true);
    expect(v.worlds('L1*')).toBe(v.l0);
    expect(v.certRed('L1')).toEqual([]);
    expect(v.strictlyDominated(P(10, 7, 4, 5))).toBeNull();
    expect(claimPossibleForGoodHolder({ ...o, lakeHistory: [] }, 'P7', 'P8', 'evil')).toBe(false);
  });

  it('undeclared lakes (declaredClaim none, S1-9c) add nothing', () => {
    const lakes: LakePublicRecord[] = [{ round: 2, holderId: 'P3', targetId: 'P10', declaredClaim: 'none' }];
    const v = buildCertainty(obs({ lakeHistory: lakes }));
    expect(v.l1).toEqual(v.l0);
    expect(buildPublicCertainty(obs({ lakeHistory: lakes })).l1).toHaveLength(210);
  });
});

// ── Property tests over random histories ───────────────────────

const EVIL = new Set<Role>(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

interface RandomGame { roles: Role[]; quests: QuestRecord[]; lakes: Array<LakePublicRecord & { result: 'good' | 'evil' }> }

function randomGame(n: number, rnd: () => number, evilCount?: number): RandomGame {
  const cfg = AVALON_CONFIG[n];
  let roles = [...cfg.roles] as Role[];
  if (evilCount === 4 && n === 9) roles = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  const all = ids(n);
  const quests: QuestRecord[] = [];
  const lakes: RandomGame['lakes'] = [];
  const rounds = 1 + Math.floor(rnd() * 5);
  let holder = all[n - 1];
  const used = new Set<string>([holder]);
  let failed = 0;
  for (let r = 1; r <= rounds; r++) {
    const size = cfg.questTeams[r - 1];
    const pool = [...all].sort(() => rnd() - 0.5).slice(0, size);
    const reds = pool.filter((id) => EVIL.has(roles[all.indexOf(id)])).length;
    // A1 (Edward 2026-10-26): after two failed missions the reds on a team all fail it (no stalling).
    const fails = failed >= 2 ? reds : Math.floor(rnd() * (reds + 1));
    quests.push(quest(r, pool, fails));
    if (fails > 0) failed += 1;
    if (n >= 7 && r >= 2 && r <= 4 && r < rounds) {
      const targets = all.filter((id) => !used.has(id));
      // 還湖 / A2 (Edward 2026-10-26): a good holder the previous lake declared red returns the lake to a
      // publicly certainly-good seat when there is one (a red holder does what it likes: refusing only
      // admits what is true).
      const publicSoFar = obs({
        playerCount: n, allPlayerIds: all, myPlayerId: holder, evilCount, questHistory: [...quests],
        lakeHistory: lakes.map(({ round, holderId, targetId, declaredClaim }) => ({ round, holderId, targetId, declaredClaim })),
      });
      const back = EVIL.has(roles[all.indexOf(holder)]) ? [] : returnLakeOptions(publicSoFar, holder, targets);
      const target = back.length > 0 ? back[0] : targets[Math.floor(rnd() * targets.length)];
      const result: 'good' | 'evil' = EVIL.has(roles[all.indexOf(target)]) ? 'evil' : 'good';
      const holderRed = EVIL.has(roles[all.indexOf(holder)]);
      const claim: 'good' | 'evil' | 'none' = holderRed
        ? (['good', 'evil', 'none'] as const)[Math.floor(rnd() * 3)]
        : result;
      lakes.push({ round: r, holderId: holder, targetId: target, declaredClaim: claim, result });
      used.add(target);
      holder = target;
    }
  }
  return { roles, quests, lakes };
}

function viewerObs(g: RandomGame, seat: number, n: number, evilCount?: number): PlayerObservation {
  const all = ids(n);
  const me = all[seat];
  const role = g.roles[seat];
  const evil = all.filter((_, i) => EVIL.has(g.roles[i]));
  let knownEvils: string[] = [];
  if (role === 'merlin') knownEvils = evil.filter((id) => g.roles[all.indexOf(id)] !== 'mordred');
  else if (EVIL.has(role) && role !== 'oberon') knownEvils = evil.filter((id) => id !== me && g.roles[all.indexOf(id)] !== 'oberon');
  const knownWizards = role === 'percival' ? all.filter((_, i) => g.roles[i] === 'merlin' || g.roles[i] === 'morgana') : undefined;
  return obs({
    myPlayerId: me,
    myRole: role,
    myTeam: EVIL.has(role) ? 'evil' : 'good',
    playerCount: n,
    allPlayerIds: all,
    knownEvils,
    knownWizards,
    evilCount,
    currentRound: Math.min(5, g.quests.length + 1),
    questHistory: g.quests,
    lakeHistory: g.lakes.map(({ round, holderId, targetId, declaredClaim }) => ({ round, holderId, targetId, declaredClaim })),
    myLakeResults: g.lakes.filter((l) => l.holderId === me).map((l) => ({ round: l.round, targetId: l.targetId, result: l.result })),
  });
}

describe('Certainty — properties over random histories (5 / 7 / 9 / 10 players)', () => {
  const rnd = seededRandom('certainty-properties-2026-10-14');
  const cases: Array<[number, number | undefined]> = [[5, undefined], [7, undefined], [9, undefined], [9, 4], [10, undefined]];

  it('kept worlds satisfy C2 and the role sight; the truth is always kept (L0, and L1 with truthful good holders)', () => {
    let checked = 0;
    for (const [n, evilCount] of cases) {
      for (let k = 0; k < 120; k++) {
        const g = randomGame(n, rnd, evilCount);
        const seat = Math.floor(rnd() * n);
        const o = viewerObs(g, seat, n, evilCount);
        const v = buildCertainty(o);
        const truth = v.maskOf(ids(n).filter((_, i) => EVIL.has(g.roles[i])));
        expect(v.l0).toContain(truth);
        expect(v.l1).toContain(truth);
        for (const w of [...v.l0, ...v.l1]) {
          expect(popcount(w)).toBe(v.params.evilCount);
          for (const q of o.questHistory) expect(popcount(w & v.maskOf(q.team))).toBeGreaterThanOrEqual(q.failCount ?? 0);
          expect(w & v.maskOf(o.knownEvils)).toBe(v.maskOf(o.knownEvils));
        }
        // certRed / certGood agree with the truth.
        for (const id of v.certRed()) expect(truth & v.bitOf(id)).not.toBe(0);
        for (const id of v.certGood()) expect(truth & v.bitOf(id)).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(600);
  }, 30_000);

  it('K1 / K3: P(B red) <= P(A red) along every declared-blue pair, and K2: P(A red) + P(B red) >= 1, under any belief on L1', () => {
    let pairs = 0;
    for (const [n, evilCount] of cases) {
      if (n < 7) continue;
      for (let k = 0; k < 150; k++) {
        const g = randomGame(n, rnd, evilCount);
        const o = viewerObs(g, Math.floor(rnd() * n), n, evilCount);
        const v = buildCertainty(o);
        if (v.l1Empty) continue;
        const weights = v.l1.map(() => 0.01 + rnd());
        const total = weights.reduce((a, b) => a + b, 0);
        const pRed = (id: string): number => v.l1.reduce((s, w, i) => s + ((w & v.bitOf(id)) ? weights[i] : 0), 0) / total;
        for (const l of o.lakeHistory ?? []) {
          if (l.declaredClaim === 'good') { expect(pRed(l.targetId)).toBeLessThanOrEqual(pRed(l.holderId) + 1e-12); pairs++; }
          if (l.declaredClaim === 'evil') { expect(pRed(l.targetId) + pRed(l.holderId)).toBeGreaterThanOrEqual(1 - 1e-12); pairs++; }
        }
      }
    }
    expect(pairs).toBeGreaterThan(100);
  }, 30_000);
});
