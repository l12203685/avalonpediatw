import { describe, it, expect, afterEach } from 'vitest';
import {
  AGENT_TUNING_ENV,
  AGENT_TUNING_KEYS,
  DEFAULT_AGENT_TUNING,
  LEGACY_AGENT_TUNING,
  describeAgentTuning,
  getDefaultAgentTuning,
  humanQuestCardRule,
  parseTuningFlag,
  resolveAgentTuning,
  tuningFromEnv,
} from './AgentTuning';
import type { PlayerObservation } from './types';

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];

function obs(partial: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 'P1',
    myRole: 'assassin',
    myTeam: 'evil',
    playerCount: 10,
    allPlayerIds: IDS,
    knownEvils: ['P2', 'P3'],
    currentRound: 4,
    currentLeader: 'P1',
    failCount: 0,
    // 1-1: nobody listening. A real R4 is always 2-1 / 1-2 (someone is
    // listening), so the R4 success branch never fires in a standard game;
    // the fixture keeps the pure rule testable.
    questResults: ['success', 'fail'],
    gamePhase: 'quest_vote',
    voteHistory: [],
    questHistory: [],
    proposedTeam: ['P1', 'P4', 'P5', 'P6', 'P7'],
    ...partial,
  };
}

describe('AgentTuning — flags', () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
  });
  const setEnv = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  it('legacy tuning has every switch off', () => {
    expect(LEGACY_AGENT_TUNING.r3NormalVotePrior).toBe(0);
    for (const key of AGENT_TUNING_KEYS) {
      if (key !== 'r3NormalVotePrior') expect(LEGACY_AGENT_TUNING[key]).toBe(false);
    }
    expect(describeAgentTuning(LEGACY_AGENT_TUNING)).toBe('legacy');
  });

  it('parseTuningFlag handles bare names, values and rejects unknown names', () => {
    expect(parseTuningFlag('r3NormalVotePrior')).toEqual({ r3NormalVotePrior: 0.6 });
    expect(parseTuningFlag('r3NormalVotePrior=1.0')).toEqual({ r3NormalVotePrior: 1 });
    expect(parseTuningFlag('evilLakeClaimAlwaysGood')).toEqual({ evilLakeClaimAlwaysGood: true });
    expect(parseTuningFlag('assassinModel=0')).toEqual({ assassinModel: false });
    expect(parseTuningFlag('r3NormalVotePriorEvilOnly')).toEqual({ r3NormalVotePriorEvilOnly: true });
    expect(parseTuningFlag('humanQuestCardRules=false')).toEqual({ humanQuestCardRules: false });
    expect(() => parseTuningFlag('nope')).toThrow(/unknown tuning flag/);
    expect(() => parseTuningFlag('r3NormalVotePrior=abc')).toThrow(/needs a number/);
    expect(() => parseTuningFlag('assassinModel=maybe')).toThrow(/needs a boolean/);
  });

  it('environment variables override the production default; bad values are ignored', () => {
    for (const key of AGENT_TUNING_KEYS) setEnv(AGENT_TUNING_ENV[key], undefined);
    expect(getDefaultAgentTuning()).toEqual(DEFAULT_AGENT_TUNING);

    setEnv(AGENT_TUNING_ENV.r3NormalVotePrior, '0.3');
    setEnv(AGENT_TUNING_ENV.goodLakeTargetMostSuspicious, '1');
    setEnv(AGENT_TUNING_ENV.assassinModel, 'garbage');
    expect(tuningFromEnv()).toEqual({ r3NormalVotePrior: 0.3, goodLakeTargetMostSuspicious: true });
    const t = getDefaultAgentTuning();
    expect(t.r3NormalVotePrior).toBe(0.3);
    expect(t.goodLakeTargetMostSuspicious).toBe(true);
    expect(t.assassinModel).toBe(DEFAULT_AGENT_TUNING.assassinModel);
  });

  it('evilLakeHumanStrategy (2026-10-13): on in the default (owner decision), off in legacy, flag, env var and description', () => {
    // Measured −0.6pp as red, but Edward decided on 2026-10-13 to turn it on
    // anyway (先像真人，變弱從其他地方補) — strength_benchmark.md 第 6、8 節.
    expect(DEFAULT_AGENT_TUNING.evilLakeHumanStrategy).toBe(true);
    expect(LEGACY_AGENT_TUNING.evilLakeHumanStrategy).toBe(false);
    expect(parseTuningFlag('evilLakeHumanStrategy')).toEqual({ evilLakeHumanStrategy: true });
    expect(parseTuningFlag('evilLakeHumanStrategy=0')).toEqual({ evilLakeHumanStrategy: false });
    expect(AGENT_TUNING_ENV.evilLakeHumanStrategy).toBe('AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY');
    expect(tuningFromEnv({ AVALON_TUNING_EVIL_LAKE_HUMAN_STRATEGY: 'on' })).toEqual({ evilLakeHumanStrategy: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, evilLakeHumanStrategy: true })).toBe('evilLakeHumanStrategy');
  });

  it('2026-10-13 round-2 red switches: default on/off, flags, env vars, off in legacy', () => {
    // strength_benchmark.md 第 8 節: the vouch follow-up is adopted (window-follow version,
    // +0.54pp over the lake strategy alone, team / R3+ votes more human-like); the human framing rate is on
    // provisionally (strength unchanged, frequency closer to humans but lower claim
    // agreement — Edward to choose); the Oberon teammate search is not adopted
    // (lakes red more often than humans and is slightly weaker).
    const round2 = [
      ['evilVouchFollowUp', 'AVALON_TUNING_EVIL_VOUCH_FOLLOW_UP', true],
      ['evilLakeFrameHumanRate', 'AVALON_TUNING_EVIL_LAKE_FRAME_HUMAN_RATE', true],
      ['oberonLakeSeeksTeammates', 'AVALON_TUNING_OBERON_LAKE_SEEKS_TEAMMATES', false],
    ] as const;
    for (const [key, env, inDefault] of round2) {
      expect(DEFAULT_AGENT_TUNING[key]).toBe(inDefault);
      expect(LEGACY_AGENT_TUNING[key]).toBe(false);
      expect(parseTuningFlag(key)).toEqual({ [key]: true });
      expect(AGENT_TUNING_ENV[key]).toBe(env);
      expect(tuningFromEnv({ [env]: '0' })).toEqual({ [key]: false });
      expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, [key]: true })).toBe(key);
    }
  });

  it('2026-10-13 round-3 teamReuse: default, flag, env var, off in legacy', () => {
    // strength_benchmark.md 第 11 節.
    expect(DEFAULT_AGENT_TUNING.teamReuse).toBe(true);
    expect(LEGACY_AGENT_TUNING.teamReuse).toBe(false);
    expect(parseTuningFlag('teamReuse')).toEqual({ teamReuse: true });
    expect(AGENT_TUNING_ENV.teamReuse).toBe('AVALON_TUNING_TEAM_REUSE');
    expect(tuningFromEnv({ AVALON_TUNING_TEAM_REUSE: '1' })).toEqual({ teamReuse: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, teamReuse: true })).toBe('teamReuse');
  });

  it('resolveAgentTuning layers overrides on top of a base', () => {
    const t = resolveAgentTuning({ assassinModel: true }, { ...LEGACY_AGENT_TUNING });
    expect(t).toEqual({ ...LEGACY_AGENT_TUNING, assassinModel: true });
    expect(describeAgentTuning(t)).toBe('assassinModel');
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, r3NormalVotePrior: 0.6, humanQuestCardRules: true }))
      .toBe('r3NormalVotePrior=0.6,humanQuestCardRules');
  });
});

describe('AgentTuning — humanQuestCardRule', () => {
  it('good players and off-team players are not covered', () => {
    expect(humanQuestCardRule(obs({ myTeam: 'good', myRole: 'loyal', knownEvils: [] }))).toBeNull();
    expect(humanQuestCardRule(obs({ proposedTeam: ['P4', 'P5', 'P6', 'P7', 'P8'] }))).toBeNull();
  });

  it('R4 (two fails needed) with only one visible red on the team → success', () => {
    expect(humanQuestCardRule(obs({}))).toBe('success');
    // Oberon sees nobody → also alone.
    expect(humanQuestCardRule(obs({ myRole: 'oberon', knownEvils: [] }))).toBe('success');
  });

  it('R4 lone visible red while either side is listening → rule yields to §0 (null)', () => {
    // 10p: Oberon is invisible to the other reds and sees nobody, so
    // assassin + Oberon on one R4 team both count "visible red = 1"; two
    // fails there flip the quest (red listening: win outright; blue
    // listening: block the third blue). §0 must win in both states.
    const redListening = ['fail', 'fail', 'success'] as ('success' | 'fail')[];
    const blueListening = ['success', 'success', 'fail'] as ('success' | 'fail')[];
    for (const questResults of [redListening, blueListening]) {
      expect(humanQuestCardRule(obs({ questResults }))).toBeNull();
      expect(humanQuestCardRule(obs({ questResults, myRole: 'oberon', knownEvils: [] }))).toBeNull();
    }
  });

  it('R4 with an ally on the team → rule does not apply', () => {
    expect(humanQuestCardRule(obs({ proposedTeam: ['P1', 'P2', 'P5', 'P6', 'P7'] }))).toBeNull();
  });

  it('R1 lone Morgana → fail; R1 lone assassin / Morgana with ally → no rule', () => {
    const r1 = { currentRound: 1, questResults: [] as ('success' | 'fail')[], proposedTeam: ['P1', 'P4', 'P5'] };
    expect(humanQuestCardRule(obs({ ...r1, myRole: 'morgana' }))).toBe('fail');
    expect(humanQuestCardRule(obs({ ...r1, myRole: 'assassin' }))).toBeNull();
    expect(humanQuestCardRule(obs({ ...r1, myRole: 'morgana', proposedTeam: ['P1', 'P2', 'P5'] }))).toBeNull();
  });

  it('5-player R4 needs one fail → no R4 rule', () => {
    expect(humanQuestCardRule(obs({
      playerCount: 5,
      allPlayerIds: IDS.slice(0, 5),
      knownEvils: ['P2'],
      proposedTeam: ['P1', 'P3', 'P4'],
    }))).toBeNull();
  });
});
