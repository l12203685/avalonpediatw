import { describe, expect, it } from 'vitest';
import {
  type GameRecordV2,
  type FixedTenStrings,
  expandRolesForAllSeats,
  WIN_REASON_ZH,
  formatWinReasonZh,
} from '@avalon/shared';
import {
  computeAssassinPrecision,
  computeELO,
  computeLadyHonesty,
  computeLeaderboardByTier,
  computeMerlinAssassinationRate,
  computeMerlinSurvivalRate,
  computePlayerLadyAccuracy,
  computePlayerMissionSuccess,
  computePlayerQuestSuccessRate,
  computePlayerRoleWinRate,
  computePlayerStatsV2,
  computePlayerVoteAccuracy,
  computePlayerVotingAlignment,
  computePlayerWinRate,
  computeTier,
  recomputeEloFromV2,
  TIER_MIN_GAMES,
} from '../services/GameStatsV2';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function padTen(values: string[]): FixedTenStrings {
  const out: string[] = [...values];
  while (out.length < 10) out.push('');
  return out.slice(0, 10) as unknown as FixedTenStrings;
}

/** 8 人局：三藍活，Alice=梅林，Frank=刺客。Alice 好人贏，Frank 壞人輸。 */
function fixtureGoodWins(): GameRecordV2 {
  return {
    schemaVersion: 2,
    gameId: 'game-001',
    playedAt: 1_745_000_000_000,
    playerSeats: padTen([
      'uid-alice',    // seat 1 — merlin
      'uid-bob',      // seat 2 — loyal
      'uid-carol',    // seat 3 — percival
      'uid-dave',     // seat 4 — loyal
      'uid-eve',      // seat 5 — loyal
      'uid-frank',    // seat 6 — assassin
      'uid-grace',    // seat 7 — morgana
      'uid-henry',    // seat 8 — mordred
    ]),
    finalResult: {
      winnerCamp: 'good',
      winReason: 'threeBlue_merlinAlive',
      assassinTargetSeat: 3,  // 錯刺 percival
      assassinCorrect: false,
      roles: {
        merlin: 1,
        percival: 3,
        assassin: 6,
        morgana: 7,
        mordred: 8,
      },
    },
    missions: [
      {
        round: 1,
        proposalIndex: 1,
        leaderSeat: 1,
        teamSeats: [1, 3, 4],
        votes: ['approve', 'approve', 'approve', 'approve', 'reject', 'reject', 'reject', 'approve'],
        passed: true,
        approveCount: 5,
        rejectCount: 3,
        questResult: { successCount: 3, failCount: 0, success: true },
      },
      {
        round: 2,
        proposalIndex: 1,
        leaderSeat: 2,
        teamSeats: [1, 2, 3, 6],
        votes: ['approve', 'approve', 'approve', 'reject', 'reject', 'approve', 'approve', 'reject'],
        passed: true,
        approveCount: 5,
        rejectCount: 3,
        questResult: { successCount: 3, failCount: 1, success: false },
      },
      {
        round: 3,
        proposalIndex: 1,
        leaderSeat: 3,
        teamSeats: [1, 3, 4, 5],
        votes: null,
        passed: true,
        approveCount: 6,
        rejectCount: 2,
        questResult: { successCount: 4, failCount: 0, success: true },
      },
      {
        round: 4,
        proposalIndex: 1,
        leaderSeat: 4,
        teamSeats: [1, 3, 4, 5, 2],
        votes: null,
        passed: true,
        approveCount: 5,
        rejectCount: 3,
        questResult: { successCount: 4, failCount: 1, success: true },
      },
    ],
    ladyChain: [
      {
        round: 2,
        holderSeat: 1,     // Alice (merlin) 持湖
        targetSeat: 7,     // 查 Grace (morgana) → evil
        declaration: 'evil',
        actual: 'evil',
        truthful: true,
      },
      {
        round: 3,
        holderSeat: 7,     // Grace (morgana) 持湖
        targetSeat: 2,     // 查 Bob (loyal) → good
        declaration: 'evil',    // 壞人說謊
        actual: 'good',
        truthful: false,
      },
    ],
  };
}

/** 8 人局：Alice=梅林被刺。 */
function fixtureMerlinKilled(): GameRecordV2 {
  const base = fixtureGoodWins();
  return {
    ...base,
    gameId: 'game-002',
    playedAt: 1_745_100_000_000,
    finalResult: {
      ...base.finalResult,
      winnerCamp: 'evil',
      winReason: 'threeBlue_merlinKilled',
      assassinTargetSeat: 1,
      assassinCorrect: true,
    },
  };
}

/** 8 人局：三紅，Alice 好人輸。 */
function fixtureThreeRed(): GameRecordV2 {
  const base = fixtureGoodWins();
  return {
    ...base,
    gameId: 'game-003',
    playedAt: 1_745_200_000_000,
    finalResult: {
      ...base.finalResult,
      winnerCamp: 'evil',
      winReason: 'threeRed',
    },
    missions: base.missions.map((m, i) => {
      if (i === 2 || i === 3) {
        return {
          ...m,
          questResult: { successCount: 2, failCount: 2, success: false },
        };
      }
      return m;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests: basic win rate + role distribution
// ---------------------------------------------------------------------------

describe('computePlayerWinRate', () => {
  it('returns overall/good/evil rates and total', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const stats = computePlayerWinRate(games, 'uid-alice');
    // Alice 是 merlin (good)；3 局裡：
    //   - goodWins: 1 (fixtureGoodWins)
    //   - merlinKilled = evil 贏 → alice 輸
    //   - threeRed = evil 贏 → alice 輸
    expect(stats.totalGames).toBe(3);
    expect(stats.wins).toBe(1);
    expect(stats.overall).toBeCloseTo(1 / 3);
    expect(stats.asGood).toBeCloseTo(1 / 3);
    expect(stats.asEvil).toBe(0);
    expect(stats.byPlayerCount[8]).toBeCloseTo(1 / 3);
  });

  it('counts Frank (assassin) evil wins correctly', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const stats = computePlayerWinRate(games, 'uid-frank');
    // Frank=assassin(evil)；第 1 局輸，第 2/3 局贏
    expect(stats.totalGames).toBe(3);
    expect(stats.wins).toBe(2);
    expect(stats.asEvil).toBeCloseTo(2 / 3);
    expect(stats.asGood).toBe(0);
  });

  it('returns zero stats for player not in any game', () => {
    const stats = computePlayerWinRate([fixtureGoodWins()], 'uid-nobody');
    expect(stats.totalGames).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.overall).toBe(0);
  });
});

describe('computePlayerRoleWinRate', () => {
  it('buckets wins by role', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const stats = computePlayerRoleWinRate(games, 'uid-alice');
    expect(stats.merlin.plays).toBe(3);
    expect(stats.merlin.wins).toBe(1);
    expect(stats.merlin.rate).toBeCloseTo(1 / 3);
    expect(stats.loyal.plays).toBe(0);
  });
});

describe('computePlayerMissionSuccess (alias: computePlayerQuestSuccessRate)', () => {
  it('tracks good/evil mission participation', () => {
    const games = [fixtureGoodWins()];
    const alice = computePlayerMissionSuccess(games, 'uid-alice');
    // Alice 參與 mission 1 (success), 2 (fail), 3 (success), 4 (success) = 3 success / 1 fail as good
    expect(alice.asGood.total).toBe(4);
    expect(alice.asGood.correct).toBe(3);
    expect(alice.asGood.rate).toBeCloseTo(3 / 4);
    expect(alice.asEvil.total).toBe(0);

    // Alias works the same
    const aliced = computePlayerQuestSuccessRate(games, 'uid-alice');
    expect(aliced.asGood.total).toBe(alice.asGood.total);
  });

  it('tracks evil (frank) mission correctly (fail = correct for evil)', () => {
    const games = [fixtureGoodWins()];
    const frank = computePlayerMissionSuccess(games, 'uid-frank');
    // Frank 只上第 2 回合（team [1,2,3,6]）；任務 fail → correct=1
    expect(frank.asEvil.total).toBe(1);
    expect(frank.asEvil.correct).toBe(1);
    expect(frank.asGood.total).toBe(0);
  });
});

describe('computePlayerVoteAccuracy (alias: computePlayerVotingAlignment)', () => {
  it('counts correct vote direction per player team', () => {
    const games = [fixtureGoodWins()];
    const alice = computePlayerVoteAccuracy(games, 'uid-alice');
    // missions with votes only = round 1 (success), round 2 (fail)
    //  - alice good: round 1 approve + success → correct; round 2 approve + fail → incorrect
    expect(alice.total).toBe(2);
    expect(alice.correct).toBe(1);
    expect(alice.rate).toBeCloseTo(0.5);

    // alias works
    const a2 = computePlayerVotingAlignment(games, 'uid-alice');
    expect(a2.total).toBe(alice.total);
  });
});

describe('computePlayerLadyAccuracy (alias: computeLadyHonesty)', () => {
  it('counts truthful / total declarations per holder', () => {
    const games = [fixtureGoodWins()];
    const alice = computePlayerLadyAccuracy(games, 'uid-alice'); // seat 1 = holder round 2
    expect(alice.total).toBe(1);
    expect(alice.correct).toBe(1);

    const grace = computePlayerLadyAccuracy(games, 'uid-grace'); // seat 7 = holder round 3
    expect(grace.total).toBe(1);
    expect(grace.correct).toBe(0);

    const alias = computeLadyHonesty(games, 'uid-alice');
    expect(alias.total).toBe(1);
  });
});

describe('computeMerlinAssassinationRate (+ computeMerlinSurvivalRate)', () => {
  it('counts merlin plays and assassinations', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const r = computeMerlinAssassinationRate(games, 'uid-alice');
    expect(r.timesAsMerlin).toBe(3);
    expect(r.timesAssassinated).toBe(1);   // fixtureMerlinKilled
    expect(r.survivalRate).toBeCloseTo(2 / 3);

    expect(computeMerlinSurvivalRate(games, 'uid-alice')).toBeCloseTo(2 / 3);
  });

  it('returns zero when player was never merlin', () => {
    const r = computeMerlinAssassinationRate([fixtureGoodWins()], 'uid-bob');
    expect(r.timesAsMerlin).toBe(0);
    expect(r.survivalRate).toBe(0);
  });
});

describe('computeAssassinPrecision', () => {
  it('returns hit / total-as-assassin', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const frank = computeAssassinPrecision(games, 'uid-frank');
    // 3 局都是 Frank=assassin；只有 fixtureMerlinKilled 刺中 → 1/3
    expect(frank).toBeCloseTo(1 / 3);
  });

  it('returns 0 when never assassin', () => {
    expect(computeAssassinPrecision([fixtureGoodWins()], 'uid-alice')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ELO
// ---------------------------------------------------------------------------

describe('computeELO', () => {
  it('increases when player wins', () => {
    const games = [fixtureGoodWins()];
    const alice = computeELO(games, 'uid-alice');
    expect(alice).toBeGreaterThan(1000);  // good 贏
  });

  it('decreases when player loses', () => {
    const games = [fixtureMerlinKilled()];
    const alice = computeELO(games, 'uid-alice');
    expect(alice).toBeLessThan(1000);
  });

  it('enforces minElo floor 100', () => {
    // Run many losses — should still be >= 100
    const games: GameRecordV2[] = [];
    for (let i = 0; i < 50; i += 1) {
      games.push({
        ...fixtureThreeRed(),
        gameId: `game-loss-${i}`,
        playedAt: 1_745_000_000_000 + i,
      });
    }
    const alice = computeELO(games, 'uid-alice');
    expect(alice).toBeGreaterThanOrEqual(100);
  });
});

describe('recomputeEloFromV2', () => {
  it('returns a map keyed by playerId with ELO per player', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled()];
    const map = recomputeEloFromV2(games);
    expect(map.has('uid-alice')).toBe(true);
    expect(map.has('uid-frank')).toBe(true);
    expect(map.size).toBeGreaterThanOrEqual(8);  // 8 players from fixture
  });
});

// ---------------------------------------------------------------------------
// Tier + Leaderboard
// ---------------------------------------------------------------------------

describe('computeTier', () => {
  it('returns unranked when totalGames < TIER_MIN_GAMES', () => {
    expect(computeTier(2000, 5)).toBe('unranked');
  });

  it('classifies by ELO thresholds', () => {
    const n = TIER_MIN_GAMES;
    expect(computeTier(500, n)).toBe('菜雞');
    expect(computeTier(900, n)).toBe('初學');
    expect(computeTier(1100, n)).toBe('新手');
    expect(computeTier(1300, n)).toBe('中堅');
    expect(computeTier(1500, n)).toBe('高手');
    expect(computeTier(1700, n)).toBe('大師');
  });

  it('respects explicit minGames override', () => {
    expect(computeTier(1200, 5, 3)).toBe('中堅');
  });
});

describe('computeLeaderboardByTier', () => {
  it('groups stats by tier and orders by ELO desc', () => {
    const stats = [
      { playerId: 'a', elo: 1700, tier: '大師' as const, totalGames: 20, winRate: { overall: 0.6 } },
      { playerId: 'b', elo: 1500, tier: '高手' as const, totalGames: 15, winRate: { overall: 0.55 } },
      { playerId: 'c', elo: 500, tier: '菜雞' as const, totalGames: 12, winRate: { overall: 0.2 } },
      { playerId: 'd', elo: 1800, tier: '大師' as const, totalGames: 30, winRate: { overall: 0.7 } },
    ].map((s) => ({
      ...s,
      computedAt: 0,
      lastComputedGameId: null,
      roleWinRate: {} as Record<string, never> as never,
      missionSuccessRate: { asGood: { rate: 0, total: 0, correct: 0 }, asEvil: { rate: 0, total: 0, correct: 0 } },
      voteAccuracy: { rate: 0, total: 0, correct: 0 },
      ladyAccuracy: { rate: 0, total: 0, correct: 0 },
      merlinAssassinationRate: { timesAsMerlin: 0, timesAssassinated: 0, survivalRate: 0 },
      winRate: {
        overall: s.winRate.overall,
        asGood: 0,
        asEvil: 0,
        byPlayerCount: {},
        totalGames: s.totalGames,
        wins: 0,
      },
    })) as never[];

    const lb = computeLeaderboardByTier(stats);
    expect(lb['大師']).toHaveLength(2);
    expect(lb['大師'][0].playerId).toBe('d');   // elo 1800 first
    expect(lb['大師'][0].rank).toBe(1);
    expect(lb['大師'][1].playerId).toBe('a');
    expect(lb['高手']).toHaveLength(1);
    expect(lb['菜雞']).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integrated computePlayerStatsV2 snapshot
// ---------------------------------------------------------------------------

describe('computePlayerStatsV2', () => {
  it('produces a self-consistent snapshot', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const stats = computePlayerStatsV2(games, 'uid-alice');
    expect(stats.playerId).toBe('uid-alice');
    expect(stats.totalGames).toBe(3);
    expect(stats.winRate.wins).toBe(1);
    expect(stats.lastComputedGameId).toBe('game-003');  // 最新 playedAt
    expect(stats.merlinAssassinationRate.timesAsMerlin).toBe(3);
    expect(stats.elo).toBeDefined();
    expect(stats.tier).toBeDefined();
  });

  it('handles custom initialElo + minGamesForTier', () => {
    const games = [fixtureGoodWins()];
    const stats = computePlayerStatsV2(games, 'uid-alice', {
      initialElo: 1500,
      minGamesForTier: 1,
    });
    expect(stats.tier).not.toBe('unranked');  // 1 局 + minGamesForTier=1 → 有排名
  });
});

// ---------------------------------------------------------------------------
// expandRolesForAllSeats (shared function, tested here via re-export)
// ---------------------------------------------------------------------------

describe('expandRolesForAllSeats', () => {
  it('fills remaining seats with loyal when only loyal remains in pool', () => {
    const roles = {
      merlin: 1,
      percival: 3,
      assassin: 6,
      morgana: 7,
      mordred: 8,
    };
    const map = expandRolesForAllSeats(roles, 8);
    expect(map[1]).toBe('merlin');
    expect(map[3]).toBe('percival');
    expect(map[6]).toBe('assassin');
    expect(map[7]).toBe('morgana');
    expect(map[8]).toBe('mordred');
    // seats 2, 4, 5 should be loyal (8-player config: 5 good, 3 evil, 3 special good placed; 2 loyal + 1 more loyal)
    expect(map[2]).toBe('loyal');
    expect(map[4]).toBe('loyal');
    expect(map[5]).toBe('loyal');
  });

  it('returns empty for unknown player counts', () => {
    const map = expandRolesForAllSeats({ merlin: 1 }, 11);
    expect(map[1]).toBe('merlin');
    // Others are null (no config)
  });
});

// ---------------------------------------------------------------------------
// winReason zh i18n
// ---------------------------------------------------------------------------

describe('WIN_REASON_ZH + formatWinReasonZh', () => {
  it('maps all 5 enum values', () => {
    expect(WIN_REASON_ZH.threeBlue_merlinAlive).toBe('三藍勝 - 刺殺失敗');
    expect(WIN_REASON_ZH.threeBlue_merlinKilled).toBe('紅方勝 - 刺殺成功');
    expect(WIN_REASON_ZH.threeRed).toBe('紅方勝 - 三任務失敗');
    expect(WIN_REASON_ZH.fiveRejections).toBe('紅方勝 - 五連否決');
    expect(WIN_REASON_ZH.hostCancelled).toBe('房主取消');
  });

  it('formatWinReasonZh returns empty string for null/undefined', () => {
    expect(formatWinReasonZh(null)).toBe('');
    expect(formatWinReasonZh(undefined)).toBe('');
    expect(formatWinReasonZh('')).toBe('');
  });

  it('formatWinReasonZh falls back to input on unknown keys', () => {
    expect(formatWinReasonZh('foo')).toBe('foo');
  });
});
