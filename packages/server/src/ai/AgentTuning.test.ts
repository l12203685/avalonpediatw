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

  it('2026-10-13 round-3 goodVouchFollowUp: on in the default, flag, env var, off in legacy', () => {
    // strength_benchmark.md 第 10 節: the blue counterpart of evilVouchFollowUp — more
    // human-like and blue +0.57pp [+0.38pp, +0.77pp] over seeds 11111 + 22222 + 33333.
    expect(LEGACY_AGENT_TUNING.goodVouchFollowUp).toBe(false);
    expect(DEFAULT_AGENT_TUNING.goodVouchFollowUp).toBe(true);
    expect(tuningFromEnv({ AVALON_TUNING_GOOD_VOUCH_FOLLOW_UP: '0' })).toEqual({ goodVouchFollowUp: false });
    expect(parseTuningFlag('goodVouchFollowUp')).toEqual({ goodVouchFollowUp: true });
    expect(AGENT_TUNING_ENV.goodVouchFollowUp).toBe('AVALON_TUNING_GOOD_VOUCH_FOLLOW_UP');
    expect(tuningFromEnv({ AVALON_TUNING_GOOD_VOUCH_FOLLOW_UP: '1' })).toEqual({ goodVouchFollowUp: true });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, goodVouchFollowUp: true })).toBe('goodVouchFollowUp');
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

  it('redR1Teammate (2026-10-13 round 3): on in the default, off in legacy, flag, env var and description', () => {
    // strength_benchmark.md 第 12 節: an R1 red leader who sees teammates brings one on the
    // talk proposals at the human rate (10p only); agreement up in expectation for ED / Sin /
    // top (paired, only Sin significant), not weaker as red.
    expect(DEFAULT_AGENT_TUNING.redR1Teammate).toBe(true);
    expect(LEGACY_AGENT_TUNING.redR1Teammate).toBe(false);
    expect(parseTuningFlag('redR1Teammate')).toEqual({ redR1Teammate: true });
    expect(AGENT_TUNING_ENV.redR1Teammate).toBe('AVALON_TUNING_RED_R1_TEAMMATE');
    expect(tuningFromEnv({ AVALON_TUNING_RED_R1_TEAMMATE: '0' })).toEqual({ redR1Teammate: false });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, redR1Teammate: true })).toBe('redR1Teammate');
  });

  it('percivalNoThumbsR1 (2026-10-14): on in the default, off in legacy, flag, env var and description', () => {
    // strength_benchmark.md 第 14 節 / percival_thumbs.md 第 11 節: R1 Percival teams carry no
    // thumb; same thumb set as the human 40.4 → 58.4% (population); blue stance pooled over
    // 515151 + 626262 + 737373 +0.01pp [−0.31pp, +0.32pp] (not weaker), red 0.
    expect(DEFAULT_AGENT_TUNING.percivalNoThumbsR1).toBe(true);
    expect(LEGACY_AGENT_TUNING.percivalNoThumbsR1).toBe(false);
    expect(parseTuningFlag('percivalNoThumbsR1')).toEqual({ percivalNoThumbsR1: true });
    expect(AGENT_TUNING_ENV.percivalNoThumbsR1).toBe('AVALON_TUNING_PERCIVAL_NO_THUMBS_R1');
    expect(tuningFromEnv({ AVALON_TUNING_PERCIVAL_NO_THUMBS_R1: '0' })).toEqual({ percivalNoThumbsR1: false });
    expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, percivalNoThumbsR1: true })).toBe('percivalNoThumbsR1');
  });

  it('round-3 integrated default (strength_benchmark.md 第 13 節) + percivalNoThumbsR1 (第 14 節) + logic-first 1A/1B / 1C / 1D (第 15–17 節)', () => {
    // 第 13 節: the combined self-play variant = the round-3 default (red +3.18pp, blue
    // +4.89pp pooled over the old default); its baseline = that set minus the three
    // round-3 switches. 第 14 節: baseline = the round-3 default (12 switches), variant =
    // + percivalNoThumbsR1. 第 15 節 (logic_first.md batch 1A/1B): baseline = the 13
    // switches of 第 14 節, variant = the full default below.
    const LOGIC_1AB = ['percivalR1ThumbOnThumb', 'goodQuestSuccessGuard', 'assassinHeuristicVisibility'] as const;
    for (const key of LOGIC_1AB) {
      expect(DEFAULT_AGENT_TUNING[key]).toBe(true);
      expect(LEGACY_AGENT_TUNING[key]).toBe(false);
      expect(tuningFromEnv({ [AGENT_TUNING_ENV[key]]: '0' })).toEqual({ [key]: false });
      expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, [key]: true })).toBe(key);
    }
    expect(AGENT_TUNING_ENV.percivalR1ThumbOnThumb).toBe('AVALON_TUNING_PERCIVAL_R1_THUMB_ON_THUMB');
    expect(AGENT_TUNING_ENV.goodQuestSuccessGuard).toBe('AVALON_TUNING_GOOD_QUEST_SUCCESS_GUARD');
    expect(AGENT_TUNING_ENV.assassinHeuristicVisibility).toBe('AVALON_TUNING_ASSASSIN_HEURISTIC_VISIBILITY');
    // Batch 1C (logic_first.md 第 1C 節, 2026-10-22): the four belief switches; baseline of its
    // strength run = the 16 switches of 1A/1B, variant = the full default below.
    const LOGIC_1C = ['beliefCertainFacts', 'rule3PostLakeOnly', 'beliefChainProjection', 'forcedVoteZeroBits'] as const;
    for (const key of LOGIC_1C) {
      expect(DEFAULT_AGENT_TUNING[key]).toBe(true);
      expect(LEGACY_AGENT_TUNING[key]).toBe(false);
      expect(tuningFromEnv({ [AGENT_TUNING_ENV[key]]: '0' })).toEqual({ [key]: false });
      expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, [key]: true })).toBe(key);
    }
    expect(AGENT_TUNING_ENV.beliefCertainFacts).toBe('AVALON_TUNING_BELIEF_CERTAIN_FACTS');
    expect(AGENT_TUNING_ENV.rule3PostLakeOnly).toBe('AVALON_TUNING_RULE3_POST_LAKE_ONLY');
    expect(AGENT_TUNING_ENV.beliefChainProjection).toBe('AVALON_TUNING_BELIEF_CHAIN_PROJECTION');
    expect(AGENT_TUNING_ENV.forcedVoteZeroBits).toBe('AVALON_TUNING_FORCED_VOTE_ZERO_BITS');
    // Batch 1D (logic_first.md 第 7 節, 2026-10-22): the two decision gates; baseline of its
    // strength run = the 20 switches of 1C, variant = the full default below.
    const LOGIC_1D = ['teamDominanceGate', 'mustFailGate'] as const;
    for (const key of LOGIC_1D) {
      expect(DEFAULT_AGENT_TUNING[key]).toBe(true);
      expect(LEGACY_AGENT_TUNING[key]).toBe(false);
      expect(parseTuningFlag(key)).toEqual({ [key]: true });
      expect(tuningFromEnv({ [AGENT_TUNING_ENV[key]]: '0' })).toEqual({ [key]: false });
      expect(describeAgentTuning({ ...LEGACY_AGENT_TUNING, [key]: true })).toBe(key);
    }
    expect(AGENT_TUNING_ENV.teamDominanceGate).toBe('AVALON_TUNING_TEAM_DOMINANCE_GATE');
    expect(AGENT_TUNING_ENV.mustFailGate).toBe('AVALON_TUNING_MUST_FAIL_GATE');
    expect(describeAgentTuning(DEFAULT_AGENT_TUNING)).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax,' +
        'goodVouchFollowUp,teamReuse,redR1Teammate,percivalNoThumbsR1,' +
        'percivalR1ThumbOnThumb,goodQuestSuccessGuard,assassinHeuristicVisibility,' +
        'beliefCertainFacts,rule3PostLakeOnly,beliefChainProjection,forcedVoteZeroBits,' +
        'teamDominanceGate,mustFailGate',
    );
    const before1D = { ...DEFAULT_AGENT_TUNING, teamDominanceGate: false, mustFailGate: false };
    expect(describeAgentTuning(before1D)).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax,' +
        'goodVouchFollowUp,teamReuse,redR1Teammate,percivalNoThumbsR1,' +
        'percivalR1ThumbOnThumb,goodQuestSuccessGuard,assassinHeuristicVisibility,' +
        'beliefCertainFacts,rule3PostLakeOnly,beliefChainProjection,forcedVoteZeroBits',
    );
    const before1C = {
      ...before1D, beliefCertainFacts: false, rule3PostLakeOnly: false, beliefChainProjection: false, forcedVoteZeroBits: false,
    };
    expect(describeAgentTuning(before1C)).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax,' +
        'goodVouchFollowUp,teamReuse,redR1Teammate,percivalNoThumbsR1,' +
        'percivalR1ThumbOnThumb,goodQuestSuccessGuard,assassinHeuristicVisibility',
    );
    const before1AB = { ...before1C, percivalR1ThumbOnThumb: false, goodQuestSuccessGuard: false, assassinHeuristicVisibility: false };
    expect(describeAgentTuning(before1AB)).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax,' +
        'goodVouchFollowUp,teamReuse,redR1Teammate,percivalNoThumbsR1',
    );
    expect(describeAgentTuning({ ...before1AB, percivalNoThumbsR1: false })).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax,' +
        'goodVouchFollowUp,teamReuse,redR1Teammate',
    );
    expect(describeAgentTuning({
      ...before1AB, goodVouchFollowUp: false, teamReuse: false, redR1Teammate: false, percivalNoThumbsR1: false,
    })).toBe(
      'r3NormalVotePrior=0.6,r3NormalVotePriorEvilOnly,goodLakeTargetMostSuspicious,humanQuestCardRules,assassinModel,' +
        'evilLakeHumanStrategy,evilVouchFollowUp,evilLakeFrameHumanRate,goodLakeInfoMax',
    );
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
