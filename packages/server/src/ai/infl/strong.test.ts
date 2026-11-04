/**
 * 強者分面群組、異常票分類、尾家座位、自我對打局轉換、差距處境的單元測試（2026-11-04；docs/ai/strong_metrics.md）。
 * 全部是捏造的資料（假名字、假局），不用任何真人紀錄。
 */
import { describe, it, expect } from 'vitest';
import type { Role } from '@avalon/shared';
import type { PlayerObservation, VoteRecord } from '../types';
import {
  cohortGamesFromDataset,
  computeStrongCohorts,
  decisionFacet,
  facetLabel,
  inFacetTop,
  intensityThreshold,
  isHighIntensity,
  missionStageWin,
  publicSummary,
  rankIn,
  strongPool,
  topOf,
  type CohortGame,
} from './strongCohort';
import { bucketLabel, calibrationBucket, isPivotal, judgeVote, tailLeaderSeat, voteKind } from './abnormalVotes';
import { laterBlueInclusion, replayGameFromSelfPlay, sampledSeats, votesOf } from './strongData';
import { BASE_FEATURES, EXTRA_FEATURES, N_BASE, N_EXTRA } from './voteFeatures';
import { bernoulliKL, coarseSituation, GapTable, situationOf } from './gap';

// ── 強者分面 ─────────────────────────────────────────────

describe('strongPool', () => {
  it('takes the top share of non-provisional players with enough games, by Elo', () => {
    const rows = [
      { name: 'Ann', elo: 1600, games: 40, provisional: false }, // 場數不夠
      { name: 'Bob', elo: 1590, games: 300, provisional: true }, // 暫定
      ...Array.from({ length: 10 }, (_, i) => ({ name: `P${i}`, elo: 1550 - i, games: 100, provisional: false })),
    ];
    expect(strongPool(rows, { topShare: 0.2, minGames: 50 })).toEqual(['P0', 'P1']);
    expect(strongPool(rows, { topShare: 0.35, minGames: 30 })).toEqual(['Ann', 'P0', 'P1']);
  });
});

describe('intensityThreshold', () => {
  it('is the value at the (1 − share) quantile of table-average Elo; games without Elo are never high-intensity', () => {
    const gs = [1490, 1495, 1500, 1505, 1510, 1515, 1520, 1525, 1530, 1535].map((e) => ({ avgElo: e }));
    const thr = intensityThreshold([...gs, { avgElo: null }] as CohortGame[], 0.3);
    expect(thr).toBe(1525);
    expect(gs.filter((g) => isHighIntensity(g, thr)).length).toBe(3);
    expect(isHighIntensity({ avgElo: null }, thr)).toBe(false);
  });
});

describe('cohortGamesFromDataset', () => {
  it('maps the config string to seats (0 = seat 10), skips 百科AI and unknown players, averages Elo×10', () => {
    const fields = ['id', 'src', 'date', 'cat', 'slot', 'note', 'config', 'outcome', 'kill', 'seats', 'lineup'];
    const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const elo = Array.from({ length: 10 }, () => 15000);
    const d = {
      fields,
      vocab: { category: ['線瓦', '百科AI'], outcome: ['三紅', '三藍死', '三藍活', '', '其他'] },
      players: ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'],
      games: [
        ['g1', 0, '', 0, 0, [], '012345', 2, '', seats, [0, 0, [], 0, elo]],
        ['g2', 0, '', 1, 0, [], '012345', 2, '', seats, null], // 百科AI
        ['g3', 0, '', 0, 0, [], '012345', 2, '', [...seats.slice(0, 9), -1], null], // 未知玩家
        ['g4', 0, '', 0, 0, [], '012345', 4, '', seats, null], // 沒有結果
      ],
    };
    const gs = cohortGamesFromDataset(d);
    expect(gs.map((g) => g.id)).toEqual(['g1']);
    const g = gs[0];
    // config '012345'：刺客在 10 號位（'0'）、莫甘娜 1 號、莫德雷德 2、奧伯倫 3、派西 4、梅林 5
    expect(g.roles[9]).toBe('assassin');
    expect(g.roles.slice(0, 5)).toEqual(['morgana', 'mordred', 'oberon', 'percival', 'merlin']);
    expect(g.roles.slice(5, 9)).toEqual(['loyal', 'loyal', 'loyal', 'loyal']);
    expect(g.names[9]).toBe('n9');
    expect(g.avgElo).toBe(1500);
  });
});

/** 捏造的局：座位 1..10 = 名字 names，角色固定（1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫、5 派西、6 梅林、7–10 忠臣）。 */
const ROLES: Role[] = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin', 'loyal', 'loyal', 'loyal', 'loyal'];
function fake(id: string, names: string[], outcome: 0 | 1 | 2, avgElo: number | null = 1600): CohortGame {
  return { id, names, roles: [...ROLES], outcome, avgElo };
}

describe('computeStrongCohorts', () => {
  // 'Red' 一直坐刺客、'Blue' 一直坐忠臣、'Mid' 坐 7 號忠臣；其他是不在母體的路人。
  const filler = ['x2', 'x3', 'x4', 'x5', 'x6'];
  const names = (seat1: string, seat8: string, seat7 = 'Mid'): string[] => [seat1, ...filler, seat7, seat8, 'x9', 'x10'];
  const games: CohortGame[] = [];
  // 高強度局：Red 當刺客 → 三紅 6 次、三藍死 2 次、三藍活 2 次；Blue 當忠臣同一批局（紅贏就是藍輸）。
  for (let i = 0; i < 6; i++) games.push(fake(`r${i}`, names('Red', 'Blue'), 0));
  for (let i = 0; i < 2; i++) games.push(fake(`d${i}`, names('Red', 'Blue'), 1));
  for (let i = 0; i < 2; i++) games.push(fake(`a${i}`, names('Red', 'Blue'), 2));
  // 低強度局：Blue 當刺客、三藍死 10 次（只算刺中率的全部局）
  for (let i = 0; i < 10; i++) games.push(fake(`low${i}`, names('Blue', 'y8', 'y7'), 1, 1400));
  const pool = ['Red', 'Blue', 'Mid'];
  const c = computeStrongCohorts(games, pool, 1500, { shrinkK: 10, rateShrinkK: 5, minRateSample: 5 });

  it('role averages and excess are measured in high-intensity games only', () => {
    expect(c.hiGames).toBe(10);
    // 高強度局 紅方任務階段贏 6/10、藍方 4/10
    expect(c.roleAverage.assassin).toBeCloseTo(0.6);
    expect(c.roleAverage.loyal).toBeCloseTo(0.4);
    expect(missionStageWin('assassin', 0)).toBe(1);
    expect(missionStageWin('loyal', 1)).toBe(1); // 三藍死也是藍方任務階段贏
  });

  it('camp excess is shrunk toward 0 and role excess toward the camp excess', () => {
    // 每個玩家的超額都是 0（他們就是平均），所以收縮後也是 0；Mid 在高強度局也是忠臣：同樣 0。
    const red = c.facets.redMission.find((e) => e.name === 'Red')!;
    expect(red.n).toBe(10);
    expect(red.value).toBeCloseTo(0);
    // 沒有樣本的角色 = 陣營超額
    const merlinOfRed = c.facets['mission:merlin'].find((e) => e.name === 'Red')!;
    expect(merlinOfRed.n).toBe(0);
    expect(merlinOfRed.value).toBeCloseTo(c.facets.blueMission.find((e) => e.name === 'Red')!.value);
  });

  it('ranks a winning red above an average one, and shrinks small samples', () => {
    const extra: CohortGame[] = [...games];
    // 'Star' 在高強度局坐刺客 4 次全部三紅（超額 +0.4 × 4 = 1.6，K = 10 → 1.6 / 14）
    for (let i = 0; i < 4; i++) extra.push(fake(`s${i}`, names('Star', 'z8', 'z7'), 0));
    const cc = computeStrongCohorts(extra, [...pool, 'Star'], 1500, { shrinkK: 10 });
    const avg = cc.roleAverage.assassin;
    const star = cc.facets.redMission[0];
    expect(star.name).toBe('Star');
    expect(star.raw).toBeCloseTo(1 - avg);
    expect(star.value).toBeCloseTo((4 * (1 - avg)) / 14);
    expect(rankIn(cc, 'redMission', 'Star')).toBe(1);
    expect(topOf(cc, 'redMission', 1)).toEqual(['Star']);
    expect(rankIn(cc, 'redMission', 'nobody')).toBe(0);
  });

  it('assassin hit rate falls back to all games when the high-intensity sample is small', () => {
    const hit = c.facets.assassinHit;
    const red = hit.find((e) => e.name === 'Red')!;
    // 高強度局只有 4 次刺殺（三藍死 2、三藍活 2）< 5 → 改用全部局（也是這 4 次）
    expect(red.basis).toBe('all');
    expect(red.n).toBe(4);
    expect(red.raw).toBeCloseTo(0.5);
  });
});

describe('computeStrongCohorts — rate facets', () => {
  it('uses the hi set when large enough, otherwise all games; value = average + shrunk excess', () => {
    const names = (s1: string): string[] => [s1, 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'];
    const gs: CohortGame[] = [];
    for (let i = 0; i < 6; i++) gs.push(fake(`h${i}`, names('Hi'), i < 4 ? 1 : 2, 1600)); // 高強度 6 次刺殺、刺中 4
    for (let i = 0; i < 3; i++) gs.push(fake(`l${i}`, names('Lo'), 1, 1400)); // 低強度 3 次全中
    gs.push(fake('h9', names('Lo'), 2, 1600)); // 高強度 1 次沒中
    const c = computeStrongCohorts(gs, ['Hi', 'Lo'], 1500, { rateShrinkK: 2, minRateSample: 5 });
    const hi = c.facets.assassinHit.find((e) => e.name === 'Hi')!;
    const lo = c.facets.assassinHit.find((e) => e.name === 'Lo')!;
    expect(hi.basis).toBe('hi');
    expect(lo.basis).toBe('all');
    const avgHi = c.rateAverage.assassinHit.hi; // 4 / 7
    expect(avgHi).toBeCloseTo(4 / 7);
    expect(hi.value).toBeCloseTo(avgHi + (4 - avgHi * 6) / (6 + 2));
    const avgAll = c.rateAverage.assassinHit.all; // 7 / 10
    expect(lo.raw).toBeCloseTo(3 / 4);
    expect(lo.value).toBeCloseTo(avgAll + (3 - avgAll * 4) / (4 + 2));
  });
});

describe('decision → facet', () => {
  it('maps each decision kind to its reference cohort', () => {
    expect(decisionFacet('loyal', 'vote')).toBe('blueMission');
    expect(decisionFacet('percival', 'team')).toBe('blueMission');
    expect(decisionFacet('merlin', 'vote')).toBe('merlinSurvival');
    expect(decisionFacet('morgana', 'quest')).toBe('redMission');
    expect(decisionFacet('assassin', 'vote')).toBe('redMission');
    expect(decisionFacet('assassin', 'assassinate')).toBe('assassinHit');
  });

  it('labels never contain names, and the public summary has no names', () => {
    expect(facetLabel('redMission', 1)).toBe('紅方任務王#1');
    expect(facetLabel('assassinHit', 2)).toBe('刺客刺中王#2');
    expect(facetLabel('mission:mordred', 3)).toBe('莫德雷德任務王#3');
    const c = computeStrongCohorts([fake('g', ['SecretName', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], 0)], ['SecretName'], 1500);
    expect(JSON.stringify(publicSummary(c))).not.toContain('SecretName');
    expect(inFacetTop(c, 'assassin', 'vote', 'SecretName', 1)).toBe(true);
    expect(inFacetTop(c, 'loyal', 'vote', 'SecretName', 1)).toBe(true);
    expect(inFacetTop(c, 'loyal', 'vote', 'Other', 5)).toBe(false);
  });
});

// ── 異常票 ───────────────────────────────────────────────

describe('abnormal-vote classification', () => {
  it('內黑 = on-team reject, 外白 = off-team approve', () => {
    expect(voteKind(true, false)).toBe('內黑');
    expect(voteKind(false, true)).toBe('外白');
    expect(voteKind(true, true)).toBe('normal');
    expect(voteKind(false, false)).toBe('normal');
  });

  it('blue accuracy: 外白 right iff the team is clean, 內黑 right iff the team has a red', () => {
    const base = { voterRed: false, teamHasOtherRed: false };
    expect(judgeVote({ ...base, onTeam: false, approve: true, teamHasRed: false }).right).toBe(true);
    expect(judgeVote({ ...base, onTeam: false, approve: true, teamHasRed: true }).right).toBe(false);
    expect(judgeVote({ ...base, onTeam: true, approve: false, teamHasRed: true, teamHasOtherRed: true }).right).toBe(true);
    expect(judgeVote({ ...base, onTeam: true, approve: false, teamHasRed: false }).right).toBe(false);
    expect(judgeVote({ ...base, onTeam: true, approve: true, teamHasRed: true }).right).toBeNull();
  });

  it('red abnormal votes get a kind, not a right/wrong', () => {
    const r = { voterRed: true };
    expect(judgeVote({ ...r, onTeam: false, approve: true, teamHasRed: true, teamHasOtherRed: true })).toEqual({ kind: '外白', right: null, redKind: '推隊友' });
    expect(judgeVote({ ...r, onTeam: false, approve: true, teamHasRed: false, teamHasOtherRed: false }).redKind).toBe('貼藍');
    expect(judgeVote({ ...r, onTeam: true, approve: false, teamHasRed: true, teamHasOtherRed: true }).redKind).toBe('反對有隊友');
    expect(judgeVote({ ...r, onTeam: true, approve: false, teamHasRed: true, teamHasOtherRed: false }).redKind).toBe('落單反對');
  });

  it('pivotal = flipping the vote flips the majority', () => {
    expect(isPivotal(6, 10, true)).toBe(true); // 6 → 5：不過半
    expect(isPivotal(7, 10, true)).toBe(false);
    expect(isPivotal(5, 10, false)).toBe(true); // 5 → 6：過半
    expect(isPivotal(4, 10, false)).toBe(false);
  });
});

describe('tail leader and calibration buckets', () => {
  it('the 5th leader is 5 − attempt seats after the current leader', () => {
    expect(tailLeaderSeat(3, 1)).toBe(7);
    expect(tailLeaderSeat(9, 2)).toBe(2);
    expect(tailLeaderSeat(10, 4)).toBe(1);
    expect(tailLeaderSeat(6, 4)).toBe(7);
  });

  it('buckets probabilities by tenths', () => {
    expect(calibrationBucket(0)).toBe(0);
    expect(calibrationBucket(0.71)).toBe(0.7);
    expect(calibrationBucket(1)).toBe(0.9);
    expect(bucketLabel(0.7)).toBe('0.7–0.8');
  });
});

// ── 自我對打局 → ReplayGame、逐票 ─────────────────────────

const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'];
function vote(round: number, attempt: number, leader: string, team: string[], yes: string[], approved: boolean): VoteRecord {
  return { round, attempt, leader, team, approved, votes: Object.fromEntries(IDS.map((id) => [id, yes.includes(id)])) };
}
/** 捏造的一局：1-1 被否決、1-2 出任務失敗、2-1 出任務成功、3-1 P4 當隊長、隊上沒有他。 */
function fakeFinal(): Pick<PlayerObservation, 'allPlayerIds' | 'voteHistory' | 'questHistory' | 'lakeHistory'> {
  return {
    allPlayerIds: IDS,
    voteHistory: [
      // 1-1：P5（派西）內黑、P3（莫德雷德）外白推隊友、P7（忠臣）外白（錯：隊上有紅）
      vote(1, 1, 'P1', ['P1', 'P2', 'P5'], ['P1', 'P2', 'P3', 'P7'], false),
      vote(1, 2, 'P2', ['P2', 'P6', 'P7'], IDS.filter((x) => x !== 'P4'), true),
      // 2-1：全藍的隊，P9 外白（對）
      vote(2, 1, 'P3', ['P5', 'P6', 'P7', 'P8'], ['P5', 'P6', 'P7', 'P8', 'P9', 'P3'], true),
      vote(3, 1, 'P4', ['P2', 'P8', 'P9', 'P10'], ['P2', 'P8', 'P9', 'P10', 'P4', 'P1'], true),
    ],
    questHistory: [
      { round: 1, team: ['P2', 'P6', 'P7'], result: 'fail', failCount: 1 },
      { round: 2, team: ['P5', 'P6', 'P7', 'P8'], result: 'success', failCount: 0 },
      { round: 3, team: ['P2', 'P8', 'P9', 'P10'], result: 'fail', failCount: 1 },
    ],
    lakeHistory: [],
  };
}
const roleOf = (id: string): Role => ROLES[IDS.indexOf(id)];

describe('replayGameFromSelfPlay', () => {
  it('converts a finished self-play record into a ReplayGame with seat-indexed votes', () => {
    const g = replayGameFromSelfPlay('SP0', fakeFinal(), roleOf)!;
    expect(g).not.toBeNull();
    expect(g.seatRoles).toEqual(ROLES);
    expect(g.proposals.map((p) => p.leaderSeat)).toEqual([1, 2, 3, 4]);
    expect(g.proposals[0].minusSeats).toEqual([5]);
    expect(g.proposals[0].plusSeats).toEqual([3, 7]);
    expect(g.proposals[0].approveCount).toBe(4);
    expect(g.quests.map((q) => q.failed)).toEqual([true, false, true]);
    expect(g.names.every((n) => n === '')).toBe(true);
  });

  it('rejects a record whose leaders do not rotate seat by seat', () => {
    const f = fakeFinal();
    f.voteHistory = [f.voteHistory[0], { ...f.voteHistory[1], leader: 'P5' }];
    expect(replayGameFromSelfPlay('SP1', f, roleOf)).toBeNull();
  });
});

describe('votesOf', () => {
  const g = replayGameFromSelfPlay('SP0', fakeFinal(), roleOf)!;
  const rows = votesOf(g);
  const at = (p: number, seat: number) => rows.find((r) => r.p === p && r.seat === seat)!;

  it('classifies every reliable vote with the truth of the team', () => {
    expect(rows.length).toBe(40);
    expect(at(0, 5).judgement).toEqual({ kind: '內黑', right: true, redKind: null });
    expect(at(0, 3).judgement.redKind).toBe('推隊友');
    expect(at(0, 7).judgement).toEqual({ kind: '外白', right: false, redKind: null });
    expect(at(2, 9).judgement).toEqual({ kind: '外白', right: true, redKind: null });
    expect(at(2, 3).judgement.redKind).toBe('貼藍');
    expect(at(1, 4).judgement.kind).toBe('normal');
    expect(at(0, 1).leader).toBe(true);
  });

  it('can restrict to seats and override votes (bot at the same point)', () => {
    const only = votesOf(g, new Set([7]), (p, seat) => (p === 0 && seat === 7 ? false : undefined));
    expect(only.length).toBe(4);
    expect(only[0].judgement.kind).toBe('normal');
  });

  it('later blue-leader inclusion counts later rounds led by blue leaders only', () => {
    // 第 1 局之後：2-1 隊長 P3（紅，不算）、3-1 隊長 P4（紅，不算）→ 沒有藍方隊長
    expect(laterBlueInclusion(g, 0, 8)).toBeNull();
    const f = fakeFinal();
    f.voteHistory.push(vote(3, 2, 'P5', ['P1', 'P5', 'P6', 'P7'], [], false));
    const g2 = replayGameFromSelfPlay('SP2', f, roleOf)!;
    expect(laterBlueInclusion(g2, 0, 1)).toBe(1);
    expect(laterBlueInclusion(g2, 0, 9)).toBe(0);
  });

  it('sampled seats are distinct and stable', () => {
    const a = sampledSeats('G1', 3);
    expect(new Set(a).size).toBe(3);
    expect(sampledSeats('G1', 3)).toEqual(a);
    expect(a.every((s) => s >= 1 && s <= 10)).toBe(true);
  });
});

// ── 差距處境 ─────────────────────────────────────────────

describe('gap situations', () => {
  const x = new Float64Array(N_BASE + N_EXTRA);
  const set = (name: string, v: number): void => {
    const b = (BASE_FEATURES as readonly string[]).indexOf(name);
    if (b >= 0) x[b] = v; else x[N_BASE + (EXTRA_FEATURES as readonly string[]).indexOf(name)] = v;
  };
  set('bias', 1); set('r3', 1); set('att4', 1); set('pClean', 0.1); set('keyRound', 1); set('allyAny', 1);

  it('reads the situation from the feature vector', () => {
    expect(situationOf(x, 'morgana')).toBe('R3-4·紅·隊外·乾淨10–30%·紅兩勝·有隊友');
    expect(coarseSituation(x, 'blue')).toBe('R3·隊外·藍');
    set('on', 1); set('leader', 1); set('provRed', 1);
    expect(situationOf(x, 'blue')).toBe('R3-4·藍·隊長·必有紅·紅兩勝');
  });

  it('KL is 0 for equal probabilities and positive otherwise; the top list is ordered by n × |Δp|', () => {
    expect(bernoulliKL(0.3, 0.3)).toBeCloseTo(0);
    expect(bernoulliKL(0.9, 0.1)).toBeGreaterThan(2);
    const t = new GapTable();
    for (let i = 0; i < 40; i++) t.add('A', 0.9, 0.1, true);
    for (let i = 0; i < 100; i++) t.add('B', 0.6, 0.4, false, true);
    for (let i = 0; i < 5; i++) t.add('C', 1, 0, true);
    expect(t.top(3, 30).map(([k]) => k)).toEqual(['A', 'B']);
    expect(t.cells.get('B')!.botReplayN).toBe(100);
    // 經驗版：B 的強者 0% vs 重播 100%，A、C 沒有重播
    expect(t.topEmpirical(3, 30).map(([k]) => k)).toEqual(['B']);
  });
});
