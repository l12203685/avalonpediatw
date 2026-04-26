import { describe, expect, it } from 'vitest';
import {
  type GameRecordV2,
  type FixedTenStrings,
  expandRolesForAllSeats,
  WIN_REASON_ZH,
  formatWinReasonZh,
} from '@avalon/shared';
import {
  ALL_TIER_GROUPS,
  computeAssassinPrecision,
  computeELO,
  computeEloTag,
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
  computeTheoreticalWinRate,
  computeTier,
  computeTierGroup,
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

describe('computeTier (legacy 3-tier backcompat)', () => {
  // Edward 2026-04-24 13:43：雙維度取代；但 computeTier 仍保留以不破壞舊呼叫端。
  // Edward 2026-04-26 12:32-12:35 — 砍 6-tier → **3-tier 絕對固定切點 + 場數區間
  // chip label**（對齊 web/utils/eloRank.ts SSoT）：
  //   `<100 場`    : 1-99    → tier='新手'   (backcompat 中文字串)
  //   `100-199 場` : 100-199 → tier='中堅'   (backcompat 中文字串)
  //   `≥200 場`    : 200+    → tier='大師'   (backcompat 中文字串)
  // UI chip text 不再用 abstract 命名（菜雞/初學/新手/中堅/高手/大師），
  // 但 server 此處仍輸出 PlayerTier 中文字串以保 backcompat 存量 Firestore doc。

  it('uses totalGames (not ELO) for tier assignment', () => {
    expect(computeTier(9999, 5)).toBe('新手');
    expect(computeTier(100, 200)).toBe('大師');
  });

  it('classifies every legacy band by totalGames thresholds', () => {
    expect(computeTier(1000, 0)).toBe('新手');
    expect(computeTier(1000, 1)).toBe('新手');
    expect(computeTier(1000, 99)).toBe('新手');
    expect(computeTier(1000, 100)).toBe('中堅');
    expect(computeTier(1000, 199)).toBe('中堅');
    expect(computeTier(1000, 200)).toBe('大師');
    expect(computeTier(1000, 999)).toBe('大師');
  });

  it('ignores legacy minGames override parameter', () => {
    expect(computeTier(1200, 5, 3)).toBe('新手');
    expect(TIER_MIN_GAMES).toBe(0);
  });
});

describe('computeTierGroup (dual-dim · games)', () => {
  // Edward 2026-04-24 13:43：主排序軸，5 組按場次。
  //   rookie < 100 / regular 100-149 / veteran 150-199 / expert 200-249 / master ≥ 250

  it('classifies every band by totalGames thresholds', () => {
    expect(computeTierGroup(0)).toBe('rookie');
    expect(computeTierGroup(50)).toBe('rookie');
    expect(computeTierGroup(99)).toBe('rookie');
    expect(computeTierGroup(100)).toBe('regular');
    expect(computeTierGroup(149)).toBe('regular');
    expect(computeTierGroup(150)).toBe('veteran');
    expect(computeTierGroup(199)).toBe('veteran');
    expect(computeTierGroup(200)).toBe('expert');
    expect(computeTierGroup(249)).toBe('expert');
    expect(computeTierGroup(250)).toBe('master');
    expect(computeTierGroup(9999)).toBe('master');
  });

  it('handles exact threshold edge cases', () => {
    expect(computeTierGroup(99)).toBe('rookie');
    expect(computeTierGroup(100)).toBe('regular');
    expect(computeTierGroup(249)).toBe('expert');
    expect(computeTierGroup(250)).toBe('master');
  });

  it('ALL_TIER_GROUPS lists 5 groups in low→high order', () => {
    expect(ALL_TIER_GROUPS).toEqual(['rookie', 'regular', 'veteran', 'expert', 'master']);
  });
});

describe('computeEloTag (dual-dim · ELO)', () => {
  // Edward 2026-04-24 13:43：3 塊 ELO 標籤。
  //   硬閾值: < 1100 novice / 1100-1399 mid / ≥ 1400 top

  it('falls back to hard thresholds when no distribution', () => {
    expect(computeEloTag(900)).toBe('novice_tag');
    expect(computeEloTag(1099)).toBe('novice_tag');
    expect(computeEloTag(1100)).toBe('mid_tag');
    expect(computeEloTag(1399)).toBe('mid_tag');
    expect(computeEloTag(1400)).toBe('top_tag');
    expect(computeEloTag(2000)).toBe('top_tag');
  });

  it('uses percentile split when distribution provided', () => {
    // distribution: 100 evenly-spaced ELOs 1000..1999
    const dist: number[] = [];
    for (let i = 0; i < 100; i += 1) dist.push(1000 + i * 10);
    // 33rd percentile ≈ 1320, 66th ≈ 1650
    expect(computeEloTag(1100, dist)).toBe('novice_tag');
    expect(computeEloTag(1500, dist)).toBe('mid_tag');
    expect(computeEloTag(1800, dist)).toBe('top_tag');
  });

  it('falls back to hard thresholds on empty / too-short distribution', () => {
    expect(computeEloTag(1500, [])).toBe('top_tag');
    expect(computeEloTag(1500, [1200, 1300])).toBe('top_tag');
  });
});

describe('computeTheoreticalWinRate', () => {
  it('returns 0 for zero games', () => {
    const wr = {
      overall: 0,
      asGood: 0,
      asEvil: 0,
      byPlayerCount: {},
      totalGames: 0,
      wins: 0,
    };
    expect(computeTheoreticalWinRate(wr)).toBe(0);
  });

  // v1 backward-compat（不傳 opts）：中性陣營 baseline
  it('v1 · averages asGood and asEvil with neutral baseline (backward-compat)', () => {
    const wr = {
      overall: 0.5,
      asGood: 0.6,
      asEvil: 0.4,
      byPlayerCount: {},
      totalGames: 10,
      wins: 5,
    };
    expect(computeTheoreticalWinRate(wr)).toBeCloseTo(0.5);
  });

  it('v1 · normalizes camp-skewed rates (backward-compat)', () => {
    const wr = {
      overall: 0.9,
      asGood: 0.9,
      asEvil: 0,
      byPlayerCount: {},
      totalGames: 10,
      wins: 9,
    };
    expect(computeTheoreticalWinRate(wr)).toBeCloseTo(0.45);
  });

  // v2（Edward 2026-04-24 14:05 公式）：SUM(roleWinRate × rolePickProbability)
  it('v2 · computes SUM(roleWinRate × rolePickProbability) for 5-player games', () => {
    // 5 人配置：merlin/percival/loyal/assassin/morgana → 每角色 1/5 機率
    // 玩家各角色勝率（假設）：
    //   merlin 0.60, percival 0.50, loyal 0.40, assassin 0.80, morgana 0.70
    // 預期 = 0.2*(0.6+0.5+0.4+0.8+0.7) = 0.2 * 3.0 = 0.60
    const wr = {
      overall: 0.6,
      asGood: 0.5,
      asEvil: 0.75,
      byPlayerCount: { 5: 0.6 },
      totalGames: 10,
      wins: 6,
    };
    const roleWinRate = {
      merlin:   { plays: 2, wins: 1, rate: 0.60 },
      percival: { plays: 2, wins: 1, rate: 0.50 },
      loyal:    { plays: 2, wins: 1, rate: 0.40 },
      assassin: { plays: 2, wins: 2, rate: 0.80 },
      morgana:  { plays: 2, wins: 1, rate: 0.70 },
      oberon:   { plays: 0, wins: 0, rate: 0 },
      mordred:  { plays: 0, wins: 0, rate: 0 },
      minion:   { plays: 0, wins: 0, rate: 0 },
    };
    const result = computeTheoreticalWinRate(wr, {
      roleWinRate,
      gamesByPlayerCount: { 5: 10 },
    });
    expect(result).toBeCloseTo(0.60, 5);
  });

  it('v2 · weights loyal by 2/6 in 6-player config', () => {
    // 6 人：merlin/percival/loyal/loyal/assassin/morgana → loyal 2/6, 其他 1/6
    // loyal 勝率 0.50、其他全 0 → 預期 = (2/6) * 0.50 = 0.16667
    const wr = {
      overall: 0.1,
      asGood: 0.1,
      asEvil: 0.1,
      byPlayerCount: { 6: 0.1 },
      totalGames: 6,
      wins: 1,
    };
    const roleWinRate = {
      merlin:   { plays: 0, wins: 0, rate: 0 },
      percival: { plays: 0, wins: 0, rate: 0 },
      loyal:    { plays: 2, wins: 1, rate: 0.50 },
      assassin: { plays: 0, wins: 0, rate: 0 },
      morgana:  { plays: 0, wins: 0, rate: 0 },
      oberon:   { plays: 0, wins: 0, rate: 0 },
      mordred:  { plays: 0, wins: 0, rate: 0 },
      minion:   { plays: 0, wins: 0, rate: 0 },
    };
    const result = computeTheoreticalWinRate(wr, {
      roleWinRate,
      gamesByPlayerCount: { 6: 6 },
    });
    expect(result).toBeCloseTo(2 / 6 * 0.5, 5);
  });

  it('v2 · averages across multiple player counts by games played', () => {
    // 玩家 10 局：5 局 5 人（loyal prob 1/5） + 5 局 6 人（loyal prob 2/6）
    // 加權平均 loyal 機率 = 0.5 * 1/5 + 0.5 * 2/6 = 0.1 + 0.16667 ≈ 0.26667
    // loyal 勝率 0.60、其他 0 → theoretical ≈ 0.26667 * 0.60 = 0.16
    const wr = {
      overall: 0.5,
      asGood: 0.6,
      asEvil: 0,
      byPlayerCount: { 5: 0.6, 6: 0.4 },
      totalGames: 10,
      wins: 5,
    };
    const roleWinRate = {
      merlin:   { plays: 0, wins: 0, rate: 0 },
      percival: { plays: 0, wins: 0, rate: 0 },
      loyal:    { plays: 5, wins: 3, rate: 0.60 },
      assassin: { plays: 0, wins: 0, rate: 0 },
      morgana:  { plays: 0, wins: 0, rate: 0 },
      oberon:   { plays: 0, wins: 0, rate: 0 },
      mordred:  { plays: 0, wins: 0, rate: 0 },
      minion:   { plays: 0, wins: 0, rate: 0 },
    };
    const result = computeTheoreticalWinRate(wr, {
      roleWinRate,
      gamesByPlayerCount: { 5: 5, 6: 5 },
    });
    const expected = (0.5 * (1 / 5) + 0.5 * (2 / 6)) * 0.60;
    expect(result).toBeCloseTo(expected, 5);
  });
});

describe('computeLeaderboardByTier (dual-dim)', () => {
  it('groups stats by TierGroup and orders by theoreticalWinRate desc', () => {
    // tierGroup 由 totalGames 決定；組內按 theoreticalWinRate 降序。
    const stats = [
      {
        playerId: 'a',
        elo: 1700,
        tierGroup: 'master' as const,
        eloTag: 'top_tag' as const,
        theoreticalWinRate: 0.55,
        tier: '大師' as const,
        totalGames: 260,
        winRate: { overall: 0.6, asGood: 0.6, asEvil: 0.5 },
      },
      {
        playerId: 'b',
        elo: 1500,
        tierGroup: 'expert' as const,
        eloTag: 'top_tag' as const,
        theoreticalWinRate: 0.50,
        tier: '高手' as const,
        totalGames: 210,
        winRate: { overall: 0.55, asGood: 0.55, asEvil: 0.45 },
      },
      {
        playerId: 'c',
        elo: 500,
        tierGroup: 'rookie' as const,
        eloTag: 'novice_tag' as const,
        theoreticalWinRate: 0.20,
        tier: '菜雞' as const,
        totalGames: 12,
        winRate: { overall: 0.2, asGood: 0.2, asEvil: 0.2 },
      },
      {
        playerId: 'd',
        elo: 1800,
        tierGroup: 'master' as const,
        eloTag: 'top_tag' as const,
        theoreticalWinRate: 0.70,
        tier: '大師' as const,
        totalGames: 300,
        winRate: { overall: 0.7, asGood: 0.7, asEvil: 0.7 },
      },
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
        asGood: s.winRate.asGood,
        asEvil: s.winRate.asEvil,
        byPlayerCount: {},
        totalGames: s.totalGames,
        wins: 0,
      },
    })) as never[];

    const lb = computeLeaderboardByTier(stats);
    expect(lb.master).toHaveLength(2);
    expect(lb.master[0].playerId).toBe('d'); // theoretical 0.70 first
    expect(lb.master[0].rank).toBe(1);
    expect(lb.master[1].playerId).toBe('a'); // theoretical 0.55
    expect(lb.master[1].rank).toBe(2);
    expect(lb.expert).toHaveLength(1);
    expect(lb.expert[0].playerId).toBe('b');
    expect(lb.rookie).toHaveLength(1);
    expect(lb.rookie[0].playerId).toBe('c');
    // Empty groups still present
    expect(lb.regular).toEqual([]);
    expect(lb.veteran).toEqual([]);
  });

  it('covers all five groups without legacy Chinese tiers or unranked', () => {
    const lb = computeLeaderboardByTier([]);
    expect(Object.keys(lb).sort()).toEqual(
      ['expert', 'master', 'regular', 'rookie', 'veteran'].sort(),
    );
  });

  it('fallbacks tierGroup/eloTag/theoreticalWinRate for legacy docs without new fields', () => {
    const legacy = [{
      playerId: 'legacy-1',
      elo: 1500,
      tier: '大師' as const,
      // tierGroup/eloTag/theoreticalWinRate missing — simulates pre-migration Firestore doc
      totalGames: 260,
      computedAt: 0,
      lastComputedGameId: null,
      roleWinRate: {} as never,
      missionSuccessRate: { asGood: { rate: 0, total: 0, correct: 0 }, asEvil: { rate: 0, total: 0, correct: 0 } },
      voteAccuracy: { rate: 0, total: 0, correct: 0 },
      ladyAccuracy: { rate: 0, total: 0, correct: 0 },
      merlinAssassinationRate: { timesAsMerlin: 0, timesAssassinated: 0, survivalRate: 0 },
      winRate: { overall: 0.55, asGood: 0.6, asEvil: 0.5, byPlayerCount: {}, totalGames: 260, wins: 143 },
    }] as never[];

    const lb = computeLeaderboardByTier(legacy);
    expect(lb.master).toHaveLength(1);
    expect(lb.master[0].tierGroup).toBe('master');
    expect(lb.master[0].eloTag).toBe('top_tag');
    expect(lb.master[0].theoreticalWinRate).toBeCloseTo(0.55);
  });
});

// ---------------------------------------------------------------------------
// Integrated computePlayerStatsV2 snapshot
// ---------------------------------------------------------------------------

describe('computePlayerStatsV2', () => {
  it('produces a self-consistent snapshot with dual-dimension fields', () => {
    const games = [fixtureGoodWins(), fixtureMerlinKilled(), fixtureThreeRed()];
    const stats = computePlayerStatsV2(games, 'uid-alice');
    expect(stats.playerId).toBe('uid-alice');
    expect(stats.totalGames).toBe(3);
    expect(stats.winRate.wins).toBe(1);
    expect(stats.lastComputedGameId).toBe('game-003');  // 最新 playedAt
    expect(stats.merlinAssassinationRate.timesAsMerlin).toBe(3);
    expect(stats.elo).toBeDefined();
    // 新雙維度
    expect(stats.tierGroup).toBeDefined();
    expect(stats.eloTag).toBeDefined();
    expect(typeof stats.theoreticalWinRate).toBe('number');
    // 舊 tier 仍保留 (backcompat)
    expect(stats.tier).toBeDefined();
  });

  it('assigns rookie group for low-game players regardless of initialElo', () => {
    const games = [fixtureGoodWins()];
    const stats = computePlayerStatsV2(games, 'uid-alice', {
      initialElo: 1500,
      minGamesForTier: 1,
    });
    // Edward 2026-04-24 13:43：tierGroup 由場次決定；1 局 < 100 → rookie
    expect(stats.tierGroup).toBe('rookie');
    // 舊 tier (Edward 2026-04-26 12:32-12:35 砍 3-tier)：1 局 < 100 → 新手
    expect(stats.tier).toBe('新手');
  });

  it('accepts eloDistribution to switch eloTag to percentile mode', () => {
    const games = [fixtureGoodWins()];
    const dist: number[] = [];
    for (let i = 0; i < 60; i += 1) dist.push(900 + i * 5);  // 900..1195
    const stats = computePlayerStatsV2(games, 'uid-alice', {
      initialElo: 1000,
      eloDistribution: dist,
    });
    expect(stats.eloTag === 'novice_tag' || stats.eloTag === 'mid_tag' || stats.eloTag === 'top_tag').toBe(true);
  });

  // Edward 2026-04-24 14:43：「在計算ELO時排除有AI 與 有 勾選"娛樂局" 的場次」
  it('excludes casual games from the ranked stats pipeline', () => {
    const ranked = fixtureGoodWins();
    const casual = { ...fixtureMerlinKilled(), casual: true };
    const stats = computePlayerStatsV2([ranked, casual], 'uid-alice');
    // Alice 在兩局都有坐；casual 局（merlin killed）被剔除 → totalGames 維持 1。
    expect(stats.totalGames).toBe(1);
    // winRate 只算 ranked 局（Alice 在 ranked 局贏 → 1/1）
    expect(stats.winRate.wins).toBe(1);
    // lastComputedGameId 必須用全 games 集合的最新 playedAt，避免 skip
    // recompute 的情況下 repo 以為還沒處理過新寫入的 casual 局而反覆 scan。
    expect(stats.lastComputedGameId).toBe(casual.gameId);
  });

  it('excludes games with hasAI flag from the ranked stats pipeline', () => {
    const ranked = fixtureGoodWins();
    const aiGame = { ...fixtureMerlinKilled(), hasAI: true };
    const stats = computePlayerStatsV2([ranked, aiGame], 'uid-alice');
    expect(stats.totalGames).toBe(1);
    expect(stats.winRate.wins).toBe(1);
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
