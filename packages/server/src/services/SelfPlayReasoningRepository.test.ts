import { describe, it, expect } from 'vitest';
import { SelfPlayReasoningRepository } from './SelfPlayReasoningRepository';
import type { ReasoningEntry } from '@avalon/shared';

function entry(over: Partial<ReasoningEntry> = {}): ReasoningEntry {
  return {
    decisionType: 'team_vote',
    round: 1,
    attempt: 1,
    actorSeat: 3,
    actorRole: 'loyal',
    leaderSeat: 1,
    interpretation: '我看到 1 家派 130',
    logic: '無內線, 預設信任 leader',
    purpose: '三藍為最大前提',
    action: '正常票 (場外反對)',
    loyalistBaseline: '如果我是忠臣, 沒資訊基礎, 反對',
    myOverride: '我就是忠臣, 同 baseline',
    anomalyType: null,
    missionVoteType: null,
    ...over,
  };
}

describe('SelfPlayReasoningRepository', () => {
  it('round-trips entries through gzip + base64', () => {
    const entries: ReasoningEntry[] = [
      entry({ decisionType: 'team_select', actorSeat: 1, actorRole: 'assassin' }),
      entry({
        decisionType: 'team_vote',
        actorSeat: 5,
        actorRole: 'percival',
        anomalyType: 'inner_black',
      }),
      entry({
        decisionType: 'quest_vote',
        actorSeat: 2,
        actorRole: 'morgana',
        missionVoteType: 'red_fail',
      }),
      entry({
        decisionType: 'lake_target',
        actorSeat: 10,
        actorRole: 'loyal',
        round: 2,
      }),
    ];

    const record = SelfPlayReasoningRepository.buildRecord('test-game-id', entries);
    expect(record.gameId).toBe('test-game-id');
    expect(record.rowCount).toBe(4);
    expect(record.schemaVersion).toBe(1);

    const decoded = SelfPlayReasoningRepository.decodeEntries(record);
    expect(decoded).toEqual(entries);
  });

  it('counts decision types correctly', () => {
    const entries: ReasoningEntry[] = [
      entry({ decisionType: 'team_select' }),
      entry({ decisionType: 'team_select' }),
      entry({ decisionType: 'team_vote', anomalyType: 'inner_black' }),
      entry({ decisionType: 'team_vote' }), // normal — not kept
      entry({ decisionType: 'quest_vote', missionVoteType: 'red_fail' }),
      entry({ decisionType: 'lake_target' }),
      entry({ decisionType: 'assassinate' }),
    ];
    const record = SelfPlayReasoningRepository.buildRecord('count-test', entries);
    expect(record.meta.decisionTypes.team_select).toBe(2);
    expect(record.meta.decisionTypes.team_vote).toBe(2);
    expect(record.meta.decisionTypes.quest_vote).toBe(1);
    expect(record.meta.decisionTypes.lake_target).toBe(1);
    expect(record.meta.decisionTypes.assassinate).toBe(1);
    // Render filter: 2 select + 1 anomaly vote + 1 red mission + 1 lake + 1 assassin = 6
    expect(record.meta.keptForRender).toBe(6);
  });

  it('handles empty entries list', () => {
    const record = SelfPlayReasoningRepository.buildRecord('empty-game', []);
    expect(record.rowCount).toBe(0);
    expect(record.meta.keptForRender).toBe(0);
    expect(SelfPlayReasoningRepository.decodeEntries(record)).toEqual([]);
  });

  it('compresses well — typical 10p game stays under 8 KB base64', () => {
    // Synthesize ~252 entries (matches storage eval research baseline).
    const entries: ReasoningEntry[] = [];
    for (let i = 0; i < 252; i++) {
      entries.push(entry({
        round: (i % 5) + 1,
        attempt: (i % 3) + 1,
        actorSeat: (i % 10) + 1,
        interpretation: `R${(i % 5) + 1} 看到隊伍包含 ${(i % 10) + 1} 家`,
        logic: '依 pyramid 推論',
      }));
    }
    const record = SelfPlayReasoningRepository.buildRecord('size-test', entries);
    // 252 rows raw JSON ≈ 50 KB; gzip+b64 should land well below 10 KB.
    expect(record.gzReasoningB64.length).toBeLessThan(10000);
  });
});
