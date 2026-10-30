/**
 * Optimization loop round 13 (blue) `goodKeyVote`: red has two wins — a loyal / Percival rejects a team whose clean
 * posterior is below the key-round threshold, on or off the team; `merlinLakeLoyal`: Merlin picks the lake target a
 * public-view loyal would.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING } from './AgentTuning';
import { goodKeyVoteReject } from './GoodCleanVote';
import { pickLakeTargetForTeam } from './LakePolicy';

const IDS = Array.from({ length: 10 }, (_, i) => `P${i + 1}`);
const obs = (partial: Partial<PlayerObservation> = {}): PlayerObservation => ({
  myPlayerId: 'P1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS, knownEvils: [],
  currentRound: 4, currentLeader: 'P2', failCount: 0, questResults: ['fail', 'success', 'fail'], gamePhase: 'team_vote',
  questHistory: [
    { round: 1, team: ['P2', 'P3', 'P4'], result: 'fail', failCount: 1 },
    { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
    { round: 3, team: ['P2', 'P5', 'P9', 'P10'], result: 'fail', failCount: 1 },
  ],
  voteHistory: [], proposedTeam: ['P1', 'P2', 'P3', 'P4', 'P9'], lakeHistory: [], ...partial,
} as unknown as PlayerObservation);
const on = (tau: number) => ({ ...DEFAULT_AGENT_TUNING, goodKeyVote: tau });

describe('goodKeyVote', () => {
  it('red has two wins and the team is below the threshold: reject, on or off the team', () => {
    expect(goodKeyVoteReject(on(0.99), obs())).toBe(true);
    expect(goodKeyVoteReject(on(0.99), obs({ proposedTeam: ['P2', 'P3', 'P4', 'P9', 'P10'] }))).toBe(true);
    expect(goodKeyVoteReject(on(0.99), obs({ myRole: 'percival' } as Partial<PlayerObservation>))).toBe(true);
  });
  it('a team clean enough for the threshold: no change', () => {
    expect(goodKeyVoteReject(on(0.001), obs({ proposedTeam: ['P1', 'P6', 'P7', 'P8', 'P5'] }))).toBe(false);
  });
  it('not applicable: off, fewer than two red wins, Merlin, R1–R2, forced', () => {
    expect(goodKeyVoteReject(on(0), obs())).toBe(false);
    expect(goodKeyVoteReject(on(0.99), obs({ questResults: ['fail', 'success', 'success'] }))).toBe(false);
    expect(goodKeyVoteReject(on(0.99), obs({ myRole: 'merlin' } as Partial<PlayerObservation>))).toBe(false);
    expect(goodKeyVoteReject(on(0.99), obs({ currentRound: 2, questResults: ['fail'] }))).toBe(false);
    expect(goodKeyVoteReject(on(0.99), obs({ failCount: 4 }))).toBe(false);
  });
});

describe('merlinLakeLoyal', () => {
  const lake = (tuning: typeof DEFAULT_AGENT_TUNING, o: PlayerObservation) =>
    pickLakeTargetForTeam('good', { ...o, gamePhase: 'lady_of_the_lake' } as PlayerObservation, IDS.filter((id) => id !== 'P1'), tuning);
  it('off: Merlin never lakes a red he sees', () => {
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P3', 'P9'] } as Partial<PlayerObservation>);
    expect(['P2', 'P3', 'P9']).not.toContain(lake(DEFAULT_AGENT_TUNING, merlin));
  });
  it('on: Merlin lakes the seat a loyal in his seat would', () => {
    const merlin = obs({ myRole: 'merlin', knownEvils: ['P2', 'P3', 'P9'] } as Partial<PlayerObservation>);
    const loyal = obs();
    expect(lake({ ...DEFAULT_AGENT_TUNING, merlinLakeLoyal: true }, merlin)).toBe(lake(DEFAULT_AGENT_TUNING, loyal));
  });
});
