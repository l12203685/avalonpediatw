import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import {
  forcedThumbGate64,
  forecastView64,
  goodLeadersCanGoClean64,
  oberonR1Card64,
  oneThumbTeam64,
  round64MerlinOn,
  temperedPick64,
  upcomingGoodLeaders64,
} from './Round64';
import { PROFILE_OVERRIDES } from './humanProfile';

const ids = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);

function merlinObs(over: Partial<PlayerObservation> = {}): PlayerObservation {
  return {
    myPlayerId: 'P3', myRole: 'merlin', myTeam: 'good', playerCount: 10, allPlayerIds: ids, knownEvils: ['P5', 'P8', 'P9'],
    currentRound: 1, currentLeader: 'P3', failCount: 1, questResults: [], gamePhase: 'team_select',
    voteHistory: [], questHistory: [], proposedTeam: [], myLakeResults: [{ round: 2, targetId: 'P1', result: 'good' }] as never,
    ...over,
  } as PlayerObservation;
}

describe('round 64 switches', () => {
  it('default off in the default and the legacy tables; flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.merlinForecast64).toBe(0);
      expect(t.merlinForcedThumbGate64).toBe(0);
      expect(t.oberonR1AlwaysFail64).toBe(0);
    }
    expect(parseTuningFlag('merlinForecast64')).toEqual({ merlinForecast64: 1 });
    expect(parseTuningFlag('merlinForecast64=5')).toEqual({ merlinForecast64: 5 });
    expect(parseTuningFlag('merlinForcedThumbGate64')).toEqual({ merlinForcedThumbGate64: 0.12 });
    expect(parseTuningFlag('oberonR1AlwaysFail64=1')).toEqual({ oberonR1AlwaysFail64: 1 });
    expect(round64MerlinOn(DEFAULT_AGENT_TUNING)).toBe(false);
    expect(round64MerlinOn(resolveAgentTuning({ merlinForecast64: 1 }))).toBe(true);
  });

  it('no opponent profile turns a round-64 switch on', () => {
    for (const o of Object.values(PROFILE_OVERRIDES)) {
      expect(o.merlinForecast64 ?? 0).toBe(0);
      expect(o.merlinForcedThumbGate64 ?? 0).toBe(0);
    }
  });
});

describe('G4 forecast: upcoming good leaders', () => {
  it('lists the later leaders of the round through proposal 5, minus the reds Merlin sees', () => {
    // Merlin P3 leads proposal 2 (fc 1): proposals 3, 4, 5 go to P4, P5 (seen red), P6.
    expect(upcomingGoodLeaders64(merlinObs())).toEqual([{ leader: 'P4', fc: 2 }, { leader: 'P6', fc: 4 }]);
    expect(upcomingGoodLeaders64(merlinObs({ failCount: 3 }))).toEqual([{ leader: 'P4', fc: 4 }]);
    expect(upcomingGoodLeaders64(merlinObs({ failCount: 4 }))).toEqual([]);
  });

  it('the forecast view is the public loyal of that seat: no sight, no private lake, that seat leads', () => {
    const v = forecastView64(merlinObs(), 'P6', 4);
    expect(v.myPlayerId).toBe('P6');
    expect(v.currentLeader).toBe('P6');
    expect(v.failCount).toBe(4);
    expect(v.myRole).toBe('loyal');
    expect(v.knownEvils).toEqual([]);
    expect(v.myLakeResults).toEqual([]);
    expect(v.seatTeam).toBe('good');
  });

  it('any / all modes', () => {
    const teams: Record<string, string[]> = { P4: ['P4', 'P5', 'P1'], P6: ['P6', 'P1', 'P2'] };
    const forecast = (v: PlayerObservation): string[] => teams[v.myPlayerId];
    expect(goodLeadersCanGoClean64(resolveAgentTuning({ merlinForecast64: 1 }), merlinObs(), forecast)).toBe(true);
    expect(goodLeadersCanGoClean64(resolveAgentTuning({ merlinForecast64: 2 }), merlinObs(), forecast)).toBe(false);
    teams.P4 = ['P4', 'P2', 'P1'];
    expect(goodLeadersCanGoClean64(resolveAgentTuning({ merlinForecast64: 2 }), merlinObs(), forecast)).toBe(true);
    teams.P4 = ['P4', 'P8', 'P1'];
    teams.P6 = ['P6', 'P9', 'P2'];
    expect(goodLeadersCanGoClean64(resolveAgentTuning({ merlinForecast64: 1 }), merlinObs(), forecast)).toBe(false);
  });

  it('tempered pick: deterministic, inside the publicly reasonable set', () => {
    const pub = [
      { team: ['P3', 'P5', 'P1'], p: 0.3, score: Math.log(0.3) },
      { team: ['P3', 'P8', 'P1'], p: 0.28, score: Math.log(0.28) },
      { team: ['P3', 'P2', 'P1'], p: 0.1, score: Math.log(0.1) },
    ];
    const a = temperedPick64(merlinObs(), pub, 0.21, () => true);
    expect(a).toEqual(temperedPick64(merlinObs(), pub, 0.21, () => true));
    expect([['P3', 'P5', 'P1'], ['P3', 'P8', 'P1']]).toContainEqual(a);
  });
});

describe('G5 forced-thumb gate', () => {
  const pub = Array.from({ length: 20 }, (_, i) => ({ team: ['P3', `P${(i % 7) + 4}`, 'P1'], p: 0.4 - i * 0.015, score: Math.log(0.4 - i * 0.015) }));
  it('thumb only when the clean best is far below the public best and out of the top 35%', () => {
    expect(forcedThumbGate64(0.12, merlinObs(), { pub, clean: [{ team: ['P3', 'P2', 'P1'], p: 0.25 }] })).toBe('thumb');
    expect(forcedThumbGate64(0.12, merlinObs(), { pub, clean: [{ team: ['P3', 'P2', 'P1'], p: 0.35 }] })).toBe('clean');
    expect(forcedThumbGate64(0.2, merlinObs(), { pub, clean: [{ team: ['P3', 'P2', 'P1'], p: 0.25 }] })).toBe('clean');
    // red at match point (two fails, not R4) or R5: never
    expect(forcedThumbGate64(0.12, merlinObs({ currentRound: 3, questResults: ['fail', 'fail'] }), { pub, clean: [{ team: ['P3', 'P2', 'P1'], p: 0.25 }] })).toBe('clean');
  });
  it('one thumb at most: the best team holding exactly one red Merlin sees', () => {
    const p2 = [
      { team: ['P3', 'P5', 'P8'], p: 0.5, score: 0 },
      { team: ['P3', 'P5', 'P1'], p: 0.4, score: -1 },
      { team: ['P3', 'P8', 'P2'], p: 0.3, score: -2 },
    ];
    expect(oneThumbTeam64(merlinObs(), p2)).toEqual(['P3', 'P5', 'P1']);
  });
});

describe('G7 oberon R1', () => {
  const q = (over: Partial<PlayerObservation>): PlayerObservation =>
    merlinObs({ myPlayerId: 'P9', myRole: 'oberon', myTeam: 'evil', knownEvils: [], gamePhase: 'quest_vote', proposedTeam: ['P9', 'P1', 'P2'], ...over });
  it('fails on R1 only when switched on', () => {
    expect(oberonR1Card64(DEFAULT_AGENT_TUNING, q({}))).toBeNull();
    const on = resolveAgentTuning({ oberonR1AlwaysFail64: 1 });
    expect(oberonR1Card64(on, q({}))).toBe('fail');
    expect(oberonR1Card64(on, q({ currentRound: 2 }))).toBeNull();
    expect(oberonR1Card64(on, q({ myRole: 'morgana' }))).toBeNull();
    expect(oberonR1Card64(on, q({ proposedTeam: ['P1', 'P2', 'P4'] }))).toBeNull();
  });
});
