/**
 * Issue #17 (Edward 2026-11-16): 「A>B o，但因為 B 有拇指、A 沒拇指，梅林派 A 沒派 B，A 其實就是莫德雷德。」
 *
 * From Merlin's own view: B is a red he sees, holder A declared B good, A is not one of the reds he sees. Under A0 (a good
 * holder declares the truth) A is red, and with every other red visible A is Mordred. Merlin's own certainty layer already
 * knows this (the must-fail gate keeps A off his loyal-style R3 / R5 teams); the gap was the R3+ re-proposal of a successful
 * mission (`merlinReuseNorm` ≥ 2): its open seats were filled from the public view (only the reds he SEES excluded) and the
 * team was checked by the public gate only, so the fill could add A. Fixtures are synthetic (no real game records).
 */
import { describe, expect, it } from 'vitest';
import { AVALON_CONFIG } from '@avalon/shared';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { certaintyFor } from './LogicGates';
import { merlinKnownReds, merlinReuseNormTeam, merlinReuseProposal } from './MerlinLoyalStyle';
import { provenReds } from './ProvenRed';
import { checkDecision } from './invariants/checks';
import { Ledger } from './invariants/ledger';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

/**
 * Merlin P1 sees P8 / P9 / P10; Mordred is P5 (A). R1 P1 P8 P7 succeeded (P8 = B, a red Merlin sees, did not fail);
 * R2 P2 P9 P1 P5 failed with one card; the R2 lake: P5 lakes P8 and declares good. Merlin leads R3 (4 seats).
 */
const merlinObs = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
  myPlayerId: 'P1', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: ['P9', 'P8', 'P10'],
  currentRound: 3, currentLeader: 'P1', failCount: 0, questResults: ['success', 'fail'], gamePhase: 'team_select',
  questHistory: [
    { round: 1, team: ['P1', 'P8', 'P7'], result: 'success', failCount: 0 },
    { round: 2, team: ['P2', 'P9', 'P1', 'P5'], result: 'fail', failCount: 1 },
  ],
  voteHistory: [
    { round: 1, attempt: 1, leader: 'P1', team: ['P1', 'P8', 'P7'], approved: true, votes: {} },
    { round: 2, attempt: 1, leader: 'P2', team: ['P2', 'P9', 'P1', 'P5'], approved: true, votes: {} },
  ],
  proposedTeam: [],
  lakeHistory: [{ round: 2, holderId: 'P5', targetId: 'P8', declaredClaim: 'good' }],
  ...over,
} as unknown as PlayerObservation);

const decideTeam = (obs: PlayerObservation): string[] => {
  const d = new ForwardAgent('P1', new HeuristicAgent('P1')).decide(obs);
  if (d.action.type !== 'team_select') throw new Error(d.action.type);
  return d.action.teamIds;
};

describe('Issue #17 — Merlin and the holder who declared a red he sees as good', () => {
  it('Merlin\'s own certainty proves A red (A0 + sight); A is the one red he cannot see', () => {
    const obs = merlinObs();
    const v = certaintyFor(obs);
    expect(v.l1Empty).toBe(false);
    expect(v.isCertRed('P5')).toBe(true);
    expect([...merlinKnownReds(obs)].sort()).toEqual(['P10', 'P5', 'P8', 'P9']);
  });

  it('the R3 re-proposal of the successful R1 team never fills an open seat with A (fail before the fix)', () => {
    const obs = merlinObs();
    const reuse = merlinReuseNormTeam(DEFAULT_AGENT_TUNING, obs, 4);
    expect(reuse).not.toBeNull();
    expect(reuse).toEqual(expect.arrayContaining(['P1', 'P8', 'P7']));
    expect(reuse).not.toContain('P5');
    // The full live pipeline (HeuristicAgent → ForwardAgent, default tuning).
    expect(decideTeam(obs)).not.toContain('P5');
  });

  it('the invariant exemption (照派成功的隊) no longer covers a proven red added from outside the successful team', () => {
    const obs = merlinObs();
    expect(merlinReuseProposal(obs, ['P1', 'P8', 'P7', 'P5'])).toBe(false);
    expect(merlinReuseProposal(obs, ['P1', 'P8', 'P7', 'P3'])).toBe(true);
  });

  it('a successful team that held A is no longer re-proposed whole: A leaves, the rest stays, the seat is refilled (owner ruling 11/16)', () => {
    const obs = merlinObs({
      questHistory: [
        { round: 1, team: ['P1', 'P8', 'P5'], result: 'success', failCount: 0 },
        { round: 2, team: ['P2', 'P9', 'P1', 'P4'], result: 'fail', failCount: 1 },
      ],
    } as Partial<PlayerObservation>);
    expect(certaintyFor(obs).isCertRed('P5')).toBe(true);
    expect(provenReds(obs)).toEqual(['P5']);
    const reuse = merlinReuseNormTeam(DEFAULT_AGENT_TUNING, obs, 4);
    expect(reuse).not.toBeNull();
    expect(reuse).toEqual(expect.arrayContaining(['P1', 'P8']));
    expect(reuse).toHaveLength(4);
    expect(reuse).not.toContain('P5');
    expect(decideTeam(obs)).not.toContain('P5');
  });

  it('B not a red Merlin sees: no hard inference that A is Mordred', () => {
    // P8 is now outside Merlin's sight (good or Mordred from his seat); A → P8 good says nothing certain about A.
    const obs = merlinObs({ knownEvils: ['P9', 'P10', 'P6'] } as Partial<PlayerObservation>);
    expect(certaintyFor(obs).isCertRed('P5')).toBe(false);
    expect(merlinKnownReds(obs).has('P5')).toBe(false);
  });

  it('a loyal (no sight) never marks A red from A → B good, and Percival\'s thumbs never reach other seats', () => {
    const loyal = merlinObs({ myRole: 'loyal', knownEvils: [] } as Partial<PlayerObservation>);
    expect(certaintyFor(loyal).isCertRed('P5')).toBe(false);
    // Percival's private thumbs (P8 = Morgana / P3 = Merlin, he cannot tell which) do not make A certainly red either.
    const perc = merlinObs({ myRole: 'percival', knownEvils: [], knownWizards: ['P8', 'P3'] } as Partial<PlayerObservation>);
    expect(certaintyFor(perc).isCertRed('P5')).toBe(false);
    // And Merlin's observation carries no thumbs: the inference comes from his own sight only.
    expect(merlinObs().knownWizards).toBeUndefined();
  });

  it('sweep: no Merlin team in a one-fail round (R3 / R5) holds the proven A unless he sat on the successful team re-proposed', () => {
    let seed = 1;
    const rnd = (): number => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    const pick = <T,>(a: readonly T[], k: number): T[] => { const c = [...a]; const o: T[] = []; while (o.length < k) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
    let checked = 0;
    for (let s = 1; s <= 400; s++) {
      seed = s * 7919;
      const reds = pick(IDS.slice(1), 4);
      const A = reds[3];
      const seen = reds.slice(0, 3);
      const B = seen[Math.floor(rnd() * 3)];
      const round = rnd() < 0.5 ? 3 : 5;
      const questHistory: { round: number; team: string[]; result: 'success' | 'fail'; failCount: number }[] = [];
      for (let q = 1; q < round; q++) {
        const team = pick(IDS, AVALON_CONFIG[10].questTeams[q - 1]);
        const on = team.filter((x) => reds.includes(x)).length;
        const fc = on === 0 ? 0 : Math.floor(rnd() * (on + 1));
        questHistory.push({ round: q, team, result: fc >= AVALON_CONFIG[10].questFailsRequired[q - 1] ? 'fail' : 'success', failCount: fc });
      }
      const questResults = questHistory.map((q) => q.result);
      if (questResults.filter((r) => r === 'fail').length >= 3 || questResults.filter((r) => r === 'success').length >= 3) continue;
      const obs = merlinObs({
        knownEvils: seen, currentRound: round, questResults, questHistory,
        voteHistory: questHistory.map((q) => ({ round: q.round, attempt: 1, leader: q.team[0], team: q.team, approved: true, votes: {} })),
        lakeHistory: [{ round: 2, holderId: A, targetId: B, declaredClaim: 'good' }],
      } as Partial<PlayerObservation>);
      if (!certaintyFor(obs).isCertRed(A)) continue;
      const team = decideTeam(obs);
      checked++;
      if (!team.includes(A)) continue;
      const reusedWithA = questHistory.some((q) => q.result === 'success' && q.team.includes(A) && q.team.every((x) => team.includes(x)));
      expect({ seed: s, team, A, reusedWithA }).toEqual({ seed: s, team, A, reusedWithA: true });
    }
    expect(checked).toBeGreaterThan(100);
  }, 60_000);
});

/**
 * Owner ruling 2026-11-16 (verbatim): 「第4局被湖證明的莫德雷德也不要派 應該說 任何已經被湖中女神+任務證明的壞人 都不該派」.
 * `goodProvenRedBar` (default on): no blue leader sends a player its own certainty proves red from lakes + missions — R4 included,
 * where one red cannot fail the mission, and the re-proposal of a successful team included.
 */
describe('owner ruling 11/16 — no blue team holds a player proven red by lake + missions', () => {
  const decideAs = (obs: PlayerObservation, tuning?: Partial<typeof DEFAULT_AGENT_TUNING>): string[] => {
    const d = new ForwardAgent(obs.myPlayerId, new HeuristicAgent(obs.myPlayerId, undefined, undefined, tuning)).decide(obs);
    if (d.action.type !== 'team_select') throw new Error(d.action.type);
    return d.action.teamIds;
  };
  const vh = (qh: { round: number; team: string[] }[], lead = 0) => qh.map((q) => ({ round: q.round, attempt: 1, leader: q.team[lead], team: q.team, approved: true, votes: {} }));

  it('R4: Merlin no longer sends the lake-proven Mordred, though one red alone cannot fail R4 (fail before the ruling)', () => {
    const qh = [
      { round: 1, team: ['P7', 'P4', 'P1'], result: 'fail' as const, failCount: 1 },
      { round: 2, team: ['P9', 'P5', 'P8', 'P1'], result: 'success' as const, failCount: 0 },
      { round: 3, team: ['P4', 'P3', 'P8', 'P6'], result: 'fail' as const, failCount: 1 },
    ];
    // Merlin sees P5 / P6 / P7; holder P10 declared P5 (a red he sees) good → P10 is Mordred.
    const obs = merlinObs({
      knownEvils: ['P6', 'P5', 'P7'], currentRound: 4, questResults: ['fail', 'success', 'fail'], questHistory: qh, voteHistory: vh(qh),
      lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P5', declaredClaim: 'good' }],
    } as Partial<PlayerObservation>);
    expect(provenReds(obs)).toEqual(['P10']);
    const team = decideAs(obs);
    expect(team).toHaveLength(5);
    expect(team).not.toContain('P10');
    expect(team.some((id) => ['P5', 'P6', 'P7'].includes(id))).toBe(false);
    // The knob off reproduces the old pick (Mordred alone on the R4 team).
    expect(decideAs(obs, { goodProvenRedBar: false })).toContain('P10');
  });

  it('a loyal: his own lake + a failed mission prove a seat red; it stays off his team', () => {
    // R1 P1 P2 P3 failed with one card; P1 laked P2 (good, declared) → P3 is red. P3 then sat on two clean missions.
    const qh = [
      { round: 1, team: ['P1', 'P2', 'P3'], result: 'fail' as const, failCount: 1 },
      { round: 2, team: ['P3', 'P6', 'P7', 'P8'], result: 'success' as const, failCount: 0 },
      { round: 3, team: ['P3', 'P6', 'P7', 'P8'], result: 'success' as const, failCount: 0 },
    ];
    const obs = merlinObs({
      myRole: 'loyal', knownEvils: [], currentRound: 4, questResults: ['fail', 'success', 'success'], questHistory: qh, voteHistory: vh(qh, 1),
      lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' }], myLakeResults: [{ round: 2, targetId: 'P2', result: 'good' }],
    } as Partial<PlayerObservation>);
    expect(provenReds(obs)).toEqual(['P3']);
    expect(decideAs(obs)).not.toContain('P3');
    // Another loyal without the private lake result (only the public declaration of P1) cannot prove it: no bar.
    expect(provenReds({ ...obs, myPlayerId: 'P4' } as PlayerObservation)).toEqual([]);
  });

  it('Percival: thumbs (his private fact) + his lake prove a thumb red; it stays off his team', () => {
    // Thumbs P9 / P10 (exactly one is Morgana); P1 laked P10 and saw good → P9 is Morgana. P9 sat on a clean R2.
    const qh = [
      { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail' as const, failCount: 1 },
      { round: 2, team: ['P9', 'P5', 'P6', 'P1'], result: 'success' as const, failCount: 0 },
    ];
    const obs = merlinObs({
      myRole: 'percival', knownEvils: [], knownWizards: ['P9', 'P10'], currentRound: 3, questResults: ['fail', 'success'], questHistory: qh, voteHistory: vh(qh, 1),
      lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P10', declaredClaim: 'good' }], myLakeResults: [{ round: 2, targetId: 'P10', result: 'good' }],
    } as Partial<PlayerObservation>);
    expect(provenReds(obs)).toEqual(['P9']);
    expect(decideAs(obs)).not.toContain('P9');
    // The same record seen by a loyal (no thumbs): P9 is not proven — Percival's thumbs never reach another seat.
    expect(provenReds({ ...obs, myRole: 'loyal', knownWizards: undefined } as PlayerObservation)).toEqual([]);
  });

  it('Merlin\'s sight-only reds are not "proven" (their own rules stay); a seen red the public record proves is', () => {
    expect(provenReds(merlinObs())).toEqual(['P5']); // P8 / P9 / P10 seen, none publicly proven
    // R1 P8 P9 P10 failed with three cards: every one of them is red in public too.
    const obs = merlinObs({ questHistory: [{ round: 1, team: ['P8', 'P9', 'P10'], result: 'fail', failCount: 3 }, { round: 2, team: ['P2', 'P3', 'P1', 'P4'], result: 'success', failCount: 0 }], questResults: ['fail', 'success'], lakeHistory: [] } as Partial<PlayerObservation>);
    expect(provenReds(obs).sort()).toEqual(['P10', 'P8', 'P9']);
  });

  it('a lake record with no consistent world (a good holder lied) proves nothing from the lakes', () => {
    // Loyal P1 laked P2 himself and saw good; P2 then declared P1 evil — under A0 P2 is red, but P2 is privately good: no L1 world.
    const obs = merlinObs({
      myRole: 'loyal', knownEvils: [],
      lakeHistory: [{ round: 2, holderId: 'P1', targetId: 'P2', declaredClaim: 'good' }, { round: 3, holderId: 'P2', targetId: 'P3', declaredClaim: 'evil' }],
      myLakeResults: [{ round: 2, targetId: 'P2', result: 'good' }],
      questHistory: [{ round: 1, team: ['P1', 'P3', 'P4'], result: 'success', failCount: 0 }, { round: 2, team: ['P1', 'P2', 'P4', 'P5'], result: 'success', failCount: 0 }],
      questResults: ['success', 'success'], currentRound: 3,
    } as Partial<PlayerObservation>);
    const v = certaintyFor(obs);
    // P3 was on a clean R1 with P1 / P4 … the L1 picture holds P3 red only through P2's declaration; whatever the level, the bar is
    // exactly the seat's L1* certain reds — never more than the lakes + missions + own view prove.
    expect(provenReds(obs)).toEqual(v.certRed('L1*').filter((id) => id !== 'P1'));
    if (v.l1Empty) expect(provenReds(obs)).toEqual([]);
  });

  it('the invariant harness flags a blue proposal holding a seat-proven red (INV-PR1), with no re-proposal exemption', () => {
    const count = (obs: PlayerObservation, team: string[]): number => {
      const L = new Ledger();
      checkDecision({ kind: 'team_select', obs, action: { type: 'team_select', teamIds: team } }, L);
      return L.tallies.get('INV-PR1')?.violations ?? 0;
    };
    // Issue #17 fixture: P5 proven; the whole successful R1 team plus P5 used to be exempt as a re-proposal.
    expect(count(merlinObs(), ['P1', 'P8', 'P7', 'P5'])).toBe(1);
    expect(count(merlinObs(), ['P1', 'P8', 'P7', 'P3'])).toBe(0); // the seen red P8 is sight-only: INV-PR1 says nothing (INV-M1 / T1 do)
    const held = merlinObs({ questHistory: [{ round: 1, team: ['P1', 'P8', 'P5'], result: 'success', failCount: 0 }, { round: 2, team: ['P2', 'P9', 'P1', 'P4'], result: 'fail', failCount: 1 }] } as Partial<PlayerObservation>);
    expect(merlinReuseProposal(held, ['P1', 'P8', 'P5', 'P3'])).toBe(true); // the old exemption still matches it …
    expect(count(held, ['P1', 'P8', 'P5', 'P3'])).toBe(1); // … INV-PR1 has none
  });

  it('sweep: no blue team (Merlin, Percival, loyal; R3–R5; forced fifth included) holds a player its seat proves red', () => {
    let seed = 1;
    const rnd = (): number => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
    const pick = <T,>(a: readonly T[], k: number): T[] => { const c = [...a]; const o: T[] = []; while (o.length < k) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
    let checked = 0;
    const roles = ['merlin', 'percival', 'loyal'] as const;
    for (let s = 1; s <= 450; s++) {
      seed = s * 104729;
      const role = roles[s % 3];
      const reds = pick(IDS.slice(1), 4); // assassin, Morgana, Oberon, Mordred
      const merlinSeat = role === 'merlin' ? 'P1' : pick(IDS.slice(1).filter((x) => !reds.includes(x)), 1)[0];
      const round = 3 + Math.floor(rnd() * 3);
      const questHistory: { round: number; team: string[]; result: 'success' | 'fail'; failCount: number }[] = [];
      for (let q = 1; q < round; q++) {
        const team = pick(IDS, AVALON_CONFIG[10].questTeams[q - 1]);
        const on = team.filter((x) => reds.includes(x)).length;
        const fc = on === 0 ? 0 : Math.floor(rnd() * (on + 1));
        questHistory.push({ round: q, team, result: fc >= AVALON_CONFIG[10].questFailsRequired[q - 1] ? 'fail' : 'success', failCount: fc });
      }
      const questResults = questHistory.map((q) => q.result);
      if (questResults.filter((r) => r === 'fail').length >= 3 || questResults.filter((r) => r === 'success').length >= 3) continue;
      const lakeHistory: { round: number; holderId: string; targetId: string; declaredClaim: 'good' | 'evil' }[] = [];
      const myLakeResults: { round: number; targetId: string; result: 'good' | 'evil' }[] = [];
      let holder = pick(IDS, 1)[0];
      const used = [holder];
      for (let lr = 2; lr < round; lr++) {
        const target = pick(IDS.filter((x) => !used.includes(x)), 1)[0];
        const truth = reds.includes(target) ? 'evil' : 'good';
        lakeHistory.push({ round: lr, holderId: holder, targetId: target, declaredClaim: reds.includes(holder) ? (rnd() < 0.5 ? 'good' : 'evil') : truth });
        if (holder === 'P1') myLakeResults.push({ round: lr, targetId: target, result: truth });
        used.push(target);
        holder = target;
      }
      const obs = merlinObs({
        myRole: role, knownEvils: role === 'merlin' ? reds.slice(0, 3) : [],
        knownWizards: role === 'percival' ? [merlinSeat, reds[1]].sort() : undefined,
        currentRound: round, failCount: Math.floor(rnd() * 5), questResults, questHistory, voteHistory: vh(questHistory), lakeHistory, myLakeResults,
      } as Partial<PlayerObservation>);
      const proven = provenReds(obs);
      if (proven.length === 0) continue;
      checked++;
      const team = decideAs(obs);
      expect({ s, role, round, hit: team.filter((id) => proven.includes(id)) }).toEqual({ s, role, round, hit: [] });
    }
    expect(checked).toBeGreaterThan(80);
  }, 300_000);
});
