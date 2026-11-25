import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, getDefaultAgentTuning, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { applyWorldLine75, setWorldLineTables75, worldLineReadout75, worldLineTables75 } from './Round75';
import { HeuristicAgent } from './HeuristicAgent';
import { HUMAN_TABLE_READING, tuningForOpponent } from './humanProfile';
import { WORLD_LINE_COMPS, WORLD_LINE_TABLES_75, worldLines75, type WorldLineTables } from './assassin/WorldLines75';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const votes = (yes: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, yes.includes(id)]));
const roles = { P2: 'assassin', P3: 'morgana', P7: 'mordred', P9: 'oberon' } as const;
const reds = ['P2', 'P3', 'P7', 'P9'];
const blues = ['P1', 'P4', 'P5', 'P6', 'P8', 'P10'];

/**
 * The assassination after 藍紅藍藍. Reds: P2 assassin, P3 Morgana, P7 Mordred, P9 Oberon.
 * R1 P1 led P1 P4 P5 (passed). R2 P4 led P4 P5 P3 P6 (rejected: P4 put Morgana, not P1), then P5 led P1 P4 P5 P9 (failed).
 * R3 P6 led P1 P4 P5 P6 (passed); R4 P8 led P1 P4 P5 P6 P8 (passed). One lake: P10 looked at P3 and called her red.
 */
function obs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  const r1 = ['P1', 'P4', 'P5'];
  const r2a = ['P4', 'P5', 'P3', 'P6'];
  const r2 = ['P1', 'P4', 'P5', 'P9'];
  const r3 = ['P1', 'P4', 'P5', 'P6'];
  const r4 = ['P1', 'P4', 'P5', 'P6', 'P8'];
  return {
    myPlayerId: 'P2', myRole: 'assassin', myTeam: 'evil', playerCount: 10, allPlayerIds: ids, knownEvils: ['P3', 'P7'],
    allEvilIds: reds, allEvilRoles: { ...roles },
    currentRound: 4, currentLeader: 'P8', failCount: 0, questResults: ['success', 'fail', 'success', 'success'], gamePhase: 'assassination',
    voteHistory: [
      { round: 1, attempt: 1, leader: 'P1', team: r1, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P8', 'P10']) },
      { round: 2, attempt: 1, leader: 'P4', team: r2a, approved: false, votes: votes(['P4', 'P3', 'P2', 'P7']) },
      { round: 2, attempt: 2, leader: 'P5', team: r2, approved: true, votes: votes(['P1', 'P4', 'P5', 'P9', 'P2', 'P3']) },
      { round: 3, attempt: 1, leader: 'P6', team: r3, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P8', 'P10']) },
      { round: 4, attempt: 1, leader: 'P8', team: r4, approved: true, votes: votes(['P1', 'P4', 'P5', 'P6', 'P8', 'P10']) },
    ],
    questHistory: [
      { round: 1, team: r1, result: 'success', failCount: 0 }, { round: 2, team: r2, result: 'fail', failCount: 1 },
      { round: 3, team: r3, result: 'success', failCount: 0 }, { round: 4, team: r4, result: 'success', failCount: 0 },
    ],
    proposedTeam: [], myLakeResults: [],
    lakeHistory: [{ round: 2, holderId: 'P10', targetId: 'P3', declaredClaim: 'evil' }],
    ...over,
  } as PlayerObservation;
}

/** A table with nothing in it but the listed cells: every other cell reads 0.5 for both the role and the role-free reference (no evidence). */
function tablesOf(bin: Record<string, [number, number]>, weights = [1, 1, 1, 1, 1, 1, 1, 1, 1]): WorldLineTables {
  return { version: 'test', kappa: 10, comps: [...WORLD_LINE_COMPS], weights, bin, lake: {} };
}

const sumExp = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, v) => a + Math.exp(v), 0);
const same: [number, number] = [1000, 300];

describe('round 75 assassinWorldLine75', () => {
  afterEach(() => setWorldLineTables75(null));

  it('round 79: the baseline has it on (inside the tier only, own score × 0); the legacy table keeps it off; the flags parse', () => {
    // Round 79 (the coordinator's decision under the site owner's 2026-11-25 delegation; one line to turn back:
    // `assassinWorldLine75: 0` in DEFAULT_AGENT_TUNING, or AVALON_TUNING_ASSASSIN_WORLD_LINE_75=0 on the server).
    expect(DEFAULT_AGENT_TUNING.assassinWorldLine75).toBe(1);
    expect(DEFAULT_AGENT_TUNING.assassinWorldLineOwn75).toBe(0);
    expect(LEGACY_AGENT_TUNING.assassinWorldLine75).toBe(0);
    expect(LEGACY_AGENT_TUNING.assassinWorldLineOwn75).toBe(0);
    expect(tuningForOpponent('ai', DEFAULT_AGENT_TUNING).assassinWorldLine75).toBe(1);
    // Human tables: the shared reading does not set it (it follows the baseline); a tier turns it back off only through its own override.
    expect(HUMAN_TABLE_READING.assassinWorldLine75).toBeUndefined();
    expect(tuningForOpponent('avgHuman', DEFAULT_AGENT_TUNING).assassinWorldLine75).toBe(1);
    expect(tuningForOpponent('weakHuman', DEFAULT_AGENT_TUNING).assassinWorldLine75).toBe(0);
    expect(tuningForOpponent('strongHuman', DEFAULT_AGENT_TUNING).assassinWorldLine75).toBe(0);
    // The server-side switch turns the baseline and the tables that follow it back to the old assassin.
    const off = getDefaultAgentTuning({ AVALON_TUNING_ASSASSIN_WORLD_LINE_75: '0' } as NodeJS.ProcessEnv);
    expect(off.assassinWorldLine75).toBe(0);
    for (const k of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(k, off).assassinWorldLine75).toBe(0);
    expect(parseTuningFlag('assassinWorldLine75')).toEqual({ assassinWorldLine75: 1 });
    expect(parseTuningFlag('assassinWorldLine75=0.75')).toEqual({ assassinWorldLine75: 0.75 });
    expect(parseTuningFlag('assassinWorldLineOwn75=0.25')).toEqual({ assassinWorldLineOwn75: 0.25 });
    expect(() => parseTuningFlag('assassinWorldLine75=-1')).toThrow();
    expect(() => parseTuningFlag('assassinWorldLineOwn75=2')).toThrow();
  });

  it('30 ordered (Percival, Merlin) world lines over the six blue seats; both marginals are probabilities', () => {
    const read = worldLines75(obs())!;
    expect(read.worlds).toHaveLength(30);
    expect(new Set(read.worlds.map((w) => `${w.percival}>${w.merlin}`)).size).toBe(30);
    for (const w of read.worlds) {
      expect(blues).toContain(w.percival);
      expect(blues).toContain(w.merlin);
      expect(w.percival).not.toBe(w.merlin);
      expect(w.comps).toHaveLength(WORLD_LINE_COMPS.length);
      expect(Number.isFinite(w.score)).toBe(true);
    }
    expect([...read.merlin.keys()].sort()).toEqual([...blues].sort());
    expect(sumExp(read.merlin)).toBeCloseTo(1, 9);
    expect(sumExp(read.percival)).toBeCloseTo(1, 9);
  });

  it('applies only after the reds show their cards, at a 10-player table with the four red roles', () => {
    expect(worldLines75(obs({ allEvilRoles: undefined }))).toBeNull();
    expect(worldLines75(obs({ playerCount: 9 }))).toBeNull();
    expect(worldLines75(obs({ allEvilRoles: { P2: 'assassin', P3: 'morgana', P7: 'mordred', P9: 'minion' } as never }))).toBeNull();
    const on = resolveAgentTuning({ assassinWorldLine75: 1 });
    expect(worldLineReadout75(resolveAgentTuning({ assassinWorldLine75: 0 }), obs())).toBeNull();
    expect(worldLineReadout75(on, obs({ allEvilRoles: undefined }))).toBeNull();
    expect(worldLineReadout75(on, obs())).not.toBeNull();
  });

  it('reads the public record and the red roles only: no blue seat\'s private view, and it does not depend on who asks', () => {
    const a = worldLines75(obs())!;
    const b = worldLines75(obs({ myPlayerId: 'P3', myRole: 'morgana', knownEvils: ['P2', 'P7'], knownWizards: ['P1', 'P3'], myLakeResults: [{ round: 2, targetId: 'P3', result: 'evil' }] } as never))!;
    expect([...b.merlin]).toEqual([...a.merlin]);
  });

  it('Morgana is the other thumb: a Percival captain who puts exactly one of the two points at Merlin', () => {
    // Only cell: a Percival captain puts Merlin on the team when Morgana is not on it (extra = 0) 90% of the time; the role-free captain 50%.
    const t = tablesOf({ 'k|P|merlin|0': [1000, 900], 'k|B|blue': [1000, 500] });
    const read = worldLines75(obs(), t)!;
    const score = (x: string, y: string): number => read.worlds.find((w) => w.percival === x && w.merlin === y)!.score;
    // P1 led P1 P4 P5 (no Morgana): the worlds where P1 is Percival and P4 / P5 is Merlin beat the ones where Merlin is off P1's team.
    expect(score('P1', 'P4')).toBeGreaterThan(score('P1', 'P6'));
    expect(score('P1', 'P5')).toBeGreaterThan(score('P1', 'P10'));
    expect(score('P1', 'P4')).toBeCloseTo(score('P1', 'P5'), 9);
    // P4 led P4 P5 P3 P6 — Morgana is on it, so that proposal is the other cell (extra = 1, no data → no evidence about P5 / P6 / P1).
    expect(score('P4', 'P5')).toBeCloseTo(score('P4', 'P1'), 9);
    // The Percival side alone moves Merlin's marginal: P4 gains on P10.
    expect(read.merlin.get('P4')!).toBeGreaterThan(read.merlin.get('P10')!);
    // Swap who is Morgana and who is Mordred: P4's proposal now holds no Morgana — it becomes evidence.
    const swapped = worldLines75(obs({ allEvilRoles: { ...roles, P3: 'mordred', P7: 'morgana' } }), t)!;
    const s2 = (x: string, y: string): number => swapped.worlds.find((w) => w.percival === x && w.merlin === y)!.score;
    expect(s2('P4', 'P5')).toBeGreaterThan(s2('P4', 'P1'));
  });

  it('Merlin side: a captain who avoids the reds Merlin sees; Mordred does not count as seen', () => {
    // A Merlin captain puts Oberon (seen) on the team 2% of the time; a Percival, a loyal and the role-free captain 30%.
    const t = tablesOf({ 'k|M|oberon': [1000, 20], 'k|B|oberon': same, 'k|P|oberon': same, 'k|L|oberon': same });
    const read = worldLines75(obs(), t)!;
    // P5 led the R2 team with Oberon: least likely Merlin.
    for (const id of blues) if (id !== 'P5') expect(read.merlin.get(id)!).toBeGreaterThan(read.merlin.get('P5')!);
    // The same table keyed on Mordred finds nothing against P5: nobody put Mordred on a team.
    const m = worldLines75(obs(), tablesOf({ 'k|M|mordred': [1000, 20], 'k|B|mordred': same, 'k|P|mordred': same, 'k|L|mordred': same }))!;
    expect(m.merlin.get('P5')!).toBeCloseTo(m.merlin.get('P1')!, 9);
  });

  it('small cells shrink to the level above; forced proposals and inconsistent vote counts are not read as votes', () => {
    // Level-3 cell at 0.6; a deeper cell with no data reads the same.
    const t = tablesOf({ 'v|M|0': [1000, 600], 'v|B|0': [1000, 500] });
    const base = worldLines75(obs(), t)!;
    const deeper = worldLines75(obs(), tablesOf({ 'v|M|0': [1000, 600], 'v|M|0|0': [0, 0], 'v|B|0': [1000, 500] }))!;
    expect([...deeper.merlin]).toEqual([...base.merlin]);
    // Off-team approvals now look a little like Merlin: P10 approved three teams off them and rejected two.
    expect(base.merlin.get('P10')!).toBeGreaterThan(base.merlin.get('P4')!);
    // Mark P1's R1 proposal as a forced fifth: its votes are synthesised — not read.
    const forced = obs();
    forced.voteHistory[0] = { ...forced.voteHistory[0], attempt: 5 };
    // A vote count that contradicts the outcome (a logging error in a real record): not read either.
    const broken = obs();
    broken.voteHistory[0] = { ...broken.voteHistory[0], votes: votes(['P1', 'P6', 'P8', 'P10']) };
    for (const o of [forced, broken]) {
      const r = worldLines75(o, t)!;
      expect(r.merlin.get('P10')! - r.merlin.get('P4')!).toBeLessThan(base.merlin.get('P10')! - base.merlin.get('P4')!);
    }
  });

  it('the stacking weights scale the components', () => {
    const cells = { 'k|M|oberon': [1000, 20] as [number, number], 'k|B|oberon': same, 'k|P|oberon': same, 'k|L|oberon': same };
    const one = worldLines75(obs(), tablesOf(cells))!;
    const none = worldLines75(obs(), tablesOf(cells, [1, 1, 1, 0, 1, 1, 1, 1, 1]))!;
    expect(one.merlin.get('P5')!).toBeLessThan(one.merlin.get('P1')!);
    expect(none.merlin.get('P5')!).toBeCloseTo(none.merlin.get('P1')!, 9);
  });

  it('the fitted table: nine weights, counts only, and the two thumbs are told apart', () => {
    const t = WORLD_LINE_TABLES_75;
    expect(t.comps).toEqual([...WORLD_LINE_COMPS]);
    expect(t.weights).toHaveLength(9);
    for (const [key, cell] of Object.entries(t.bin)) {
      expect(cell[0]).toBeGreaterThanOrEqual(cell[1]);
      expect(/^[kv]\|[BLPM]\|/.test(key)).toBe(true);
    }
    // A real Percival captain puts Merlin on the team far less often when Morgana is already on it (one thumb at a time).
    const rate = (k: string): number => t.bin[k][1] / t.bin[k][0];
    expect(rate('k|P|merlin|0')).toBeGreaterThan(5 * rate('k|P|merlin|1'));
    // A real Merlin captain puts a red he sees on the team far less often than the role-free blue captain; Mordred he does not avoid.
    expect(rate('k|M|assassin')).toBeLessThan(0.5 * rate('k|B|assassin'));
    expect(rate('k|M|mordred')).toBeGreaterThan(rate('k|M|assassin'));
  });

  it('the agent: off = the current scores and pick; on = own × current + w × log P(Merlin), inside the same first tier', () => {
    const o = obs();
    const base = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinWorldLine75: 0 }));
    const zero = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinWorldLine75: 0, assassinWorldLineOwn75: 0.5 }));
    const wl = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinWorldLine75: 1, assassinWorldLineOwn75: 0 }));
    const mix = new HeuristicAgent('P2', undefined, undefined, resolveAgentTuning({ assassinWorldLine75: 0.75, assassinWorldLineOwn75: 0.25 }));
    const rb = base.assassinationReadout(o)!;
    const rz = zero.assassinationReadout(o)!;
    const rw = wl.assassinationReadout(o)!;
    const rm = mix.assassinationReadout(o)!;
    // Off: bit-identical, whatever the own-score multiplier says.
    expect([...rz.scores]).toEqual([...rb.scores]);
    expect(zero.act(o)).toEqual(base.act(o));
    // On: the tier is untouched, the terms are untouched, the score is the mix.
    expect(rw.front).toEqual(rb.front);
    expect(rm.front).toEqual(rb.front);
    const read = worldLines75(o)!;
    for (const id of blues) {
      // The five terms are unchanged; round 79 adds the world line's own term (score = own × five terms + worldLine).
      const { worldLine, ...five } = rw.terms.get(id)!;
      expect(five).toEqual(rb.terms.get(id));
      expect(worldLine!).toBeCloseTo(read.merlin.get(id)!, 9);
      expect(rw.scores.get(id)!).toBeCloseTo(read.merlin.get(id)!, 9);
      expect(rm.scores.get(id)!).toBeCloseTo(0.25 * rb.scores.get(id)! + 0.75 * read.merlin.get(id)!, 9);
    }
    const act = wl.act(o);
    expect(act.type).toBe('assassinate');
    if (act.type === 'assassinate') {
      expect(rw.front).toContain(act.targetId);
      expect(reds).not.toContain(act.targetId);
      const best = [...rw.front].sort((x, y) => rw.scores.get(y)! - rw.scores.get(x)!)[0];
      expect(act.targetId).toBe(best);
    }
    // No red reveal (an older observation): the switch does nothing.
    const blind = obs({ allEvilRoles: undefined });
    expect([...wl.assassinationReadout(blind)!.scores]).toEqual([...base.assassinationReadout(blind)!.scores]);
  });

  it('applyWorldLine75 returns the same Map when off; study scripts can swap the table and put the fitted one back', () => {
    const scores = new Map(blues.map((id, i) => [id, i]));
    expect(applyWorldLine75(resolveAgentTuning({ assassinWorldLine75: 0 }), obs(), scores)).toBe(scores);
    const on = resolveAgentTuning({ assassinWorldLine75: 1, assassinWorldLineOwn75: 0 });
    const fitted = applyWorldLine75(on, obs(), scores);
    expect(fitted).not.toBe(scores);
    setWorldLineTables75(tablesOf({}));
    expect(worldLineTables75().version).toBe('test');
    // An empty table: every world line scores the same, every blue seat is Merlin with probability 1/6.
    for (const v of applyWorldLine75(on, obs(), scores).values()) expect(v).toBeCloseTo(Math.log(1 / 6), 9);
    setWorldLineTables75(null);
    expect(worldLineTables75()).toBe(WORLD_LINE_TABLES_75);
    expect([...applyWorldLine75(on, obs(), scores)]).toEqual([...fitted]);
  });
});
