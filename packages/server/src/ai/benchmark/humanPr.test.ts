import { describe, expect, it } from 'vitest';
import { deriveLeaderStart, replayGameFromDataset, seatOfChar, type DatasetHeader } from './datasetReplay';
import {
  advantage,
  equivalentPr,
  fitAdvantageTable,
  fitLogistic,
  foldOf,
  humanSlopePer10,
  isReuse,
  prBucket,
  scoreBefore,
  taintedBefore,
  teamKeys,
  voteKeys,
  type AdvantageSample,
} from './humanPr';

const HEADER: DatasetHeader = {
  fields: ['id', 'src', 'date', 'cat', 'slot', 'note', 'config', 'outcome', 'kill', 'seats', 'missions', 'rounds', 'state',
    'firstTeam', 'lakes', 'claims', 'captains', 'votes', 'lineup'],
  vocab: { outcome: ['三紅', '三藍死', '三藍活', '', '其他'], noteTags: ['flag:x'] },
};

/**
 * 配置 123456：1 刺客、2 莫甘娜、3 莫德雷德、4 奧伯倫、5 派西、6 梅林。三藍、刺客刺 6 號（梅林）= 三藍死。
 * R1：第 1 次 789 被否決、第 2 次 890 通過成功；R2 7890 成功；R3 1789 失敗（1 張）；R4 67890 成功。
 */
function tuple(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const base: Record<string, unknown> = {
    id: '42', src: 0, date: '2025-01-01', cat: 0, slot: 1, note: [0], config: '123456', outcome: 1, kill: '6',
    seats: [], missions: 'ooo|oooo|ooox|ooooo|', rounds: 'BBRB-', state: 0, firstTeam: '789', lakes: '0778--',
    claims: '07o78x', captains: '',
    votes: [
      [1, 1, '789', '1'],
      [1, 2, '890', '2890'],
      [2, 1, '7890', '7890'],
      [3, 1, '1789', '17890'],
      [4, 1, '67890', '1267890'],
    ],
    lineup: [57, 500, [10, 20, 30, 40, 50, 60, 70, 80, 90, 95], 0b1, [15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000, 15000]],
    ...overrides,
  };
  return HEADER.fields.map((f) => base[f]);
}

describe('datasetReplay', () => {
  it('seat chars map 0 to seat 10', () => {
    expect(seatOfChar('0')).toBe(10);
    expect(seatOfChar('7')).toBe(7);
    expect(seatOfChar('?')).toBeNull();
  });

  it('rebuilds proposals, votes, quests, lakes and the result', () => {
    const res = replayGameFromDataset(tuple(), HEADER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { game, prs, prov, s } = res.value;
    expect(game.seatRoles.slice(0, 6)).toEqual(['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin']);
    expect(game.proposals.map((p) => p.leaderSeat)).toEqual([1, 2, 3, 4, 5]);
    expect(game.proposals[0].votes[0]).toBe(true);
    expect(game.proposals[0].plusSeats).toEqual([1]);
    expect(game.proposals[0].wentOnMission).toBe(false);
    expect(game.proposals[0].votesReliable).toBe(true);
    expect(game.proposals[1].wentOnMission).toBe(true);
    expect(game.quests.map((q) => q.failed)).toEqual([false, false, true, false]);
    expect(game.lakes).toEqual([
      { round: 2, holderSeat: 10, targetSeat: 7, claim: 'good' },
      { round: 3, holderSeat: 7, targetSeat: 8, claim: 'evil' },
    ]);
    expect(game.lakeChainValid).toBe(true);
    expect(game.assassinTargetSeat).toBe(6);
    expect(game.winner).toBe('evil');
    expect(game.names.every((n) => n === '')).toBe(true);
    expect(prs?.[9]).toBe(95);
    expect(prov?.[0]).toBe(true);
    expect(prov?.[1]).toBe(false);
    expect(s).toBe(50);
  });

  it('forced 5th proposals keep the literal default votes', () => {
    const votes = [
      [1, 1, '123', ''], [1, 2, '234', ''], [1, 3, '345', ''], [1, 4, '456', ''], [1, 5, '890', ''],
      [2, 1, '7890', '7890'], [3, 1, '1789', '17890'], [4, 1, '67890', '1267890'],
    ];
    const res = replayGameFromDataset(tuple({ votes }), HEADER);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const forced = res.value.game.proposals[4];
    expect(forced.forced).toBe(true);
    expect(forced.votesReliable).toBe(false);
    expect(forced.votes.filter(Boolean).length).toBe(3);
  });

  it('rejects inconsistent records', () => {
    expect(replayGameFromDataset(tuple({ outcome: 0 }), HEADER)).toEqual({ ok: false, reason: 'outcome mismatch' });
    expect(replayGameFromDataset(tuple({ missions: 'ooo|oooo|oooo|ooooo|' }), HEADER).ok).toBe(false);
    expect(replayGameFromDataset(tuple({ kill: '7' }), HEADER)).toEqual({ ok: false, reason: 'kill / outcome mismatch' });
    expect(replayGameFromDataset(tuple({ config: '112345' }), HEADER)).toEqual({ ok: false, reason: 'bad role code' });
  });

  it('infers the leader rotation of Discord games from team coverage', () => {
    const teams = Array.from({ length: 12 }, (_, k) => {
      const leader = ((3 + k) % 10) + 1;
      return [leader, leader === 1 ? 2 : 1];
    });
    expect(deriveLeaderStart(teams)).toBe(4);
    expect(deriveLeaderStart([[1, 2]])).toBeNull();
  });
});

describe('humanPr keys', () => {
  const res = replayGameFromDataset(tuple(), HEADER);
  if (!res.ok) throw new Error('fixture');
  const game = res.value.game;

  it('public state: score, tainted seats, reuse', () => {
    expect(scoreBefore(game, 1)).toBe('0-0');
    expect(scoreBefore(game, 4)).toBe('1-2');
    expect([...taintedBefore(game, 4)].sort((a, b) => a - b)).toEqual([1, 7, 8, 9]);
    expect(isReuse(game, 2, [7, 8, 9, 10])).toBe(true);
    expect(isReuse(game, 1, [7, 8, 9])).toBe(false);
  });

  it('vote and team keys use the true red count for grading', () => {
    const v = voteKeys(game, 3, 6, false);
    expect(v.levels[0][0]).toBe('merlin|R3|a1|0-2|off|r1|t0|u0');
    expect(v.levels[0][1]).toBe('R');
    const t = teamKeys(game, 4, [6, 7, 8, 9, 10]);
    expect(t.levels[0]).toEqual(['percival|R4|a1|1-2', 's0r0t2u1']);
  });
});

describe('advantage table', () => {
  const key = (a: string): AdvantageSample['keys'] => ({ levels: [['s', a], ['coarse', a]] });

  it('shrinks toward the coarser level and 0', () => {
    const samples: AdvantageSample[] = [
      ...Array.from({ length: 100 }, () => ({ keys: key('A'), residual: 0.2 })),
      ...Array.from({ length: 100 }, () => ({ keys: key('B'), residual: -0.2 })),
    ];
    const table = fitAdvantageTable(samples, 30);
    const a = advantage(table, key('A'));
    expect(a).toBeGreaterThan(0.1);
    expect(a).toBeLessThan(0.2);
    expect(advantage(table, key('B'))).toBeCloseTo(-a, 10);
    expect(advantage(table, key('C'))).toBe(0);
  });

  it('folds are stable and logistic recovers a slope', () => {
    expect(foldOf('123')).toBe(foldOf('123'));
    expect(foldOf('123')).toBeLessThan(5);
    const xs = Array.from({ length: 400 }, (_, i) => (i % 40) / 20 - 1);
    const ys = xs.map((x, i) => ((i * 7919) % 100) / 100 < 1 / (1 + Math.exp(-2 * x)) ? 1 : 0);
    const [, b] = fitLogistic(xs, ys);
    expect(b).toBeGreaterThan(1);
  });
});

describe('equivalent PR', () => {
  it('buckets PR and skips provisional seats', () => {
    expect(prBucket(100, false)).toBe(90);
    expect(prBucket(37, false)).toBe(30);
    expect(prBucket(37, true)).toBeNull();
    expect(prBucket(null, false)).toBeNull();
  });

  it('finds where bot − human crosses zero', () => {
    const rows = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((b) => ({ bucket: b, n: 100, human: (b + 5) / 1000, bot: 0.05 }));
    const e = equivalentPr(rows);
    expect(e.pr).toBeCloseTo(50, 6);
    expect(e.clamped).toBe(false);
    expect(humanSlopePer10(rows)).toBeCloseTo(0.01, 6);
  });

  it('returns null without a human gradient and clamps outside 0..100', () => {
    const flat = [0, 50, 90].map((b) => ({ bucket: b, n: 10, human: 0.1, bot: 0.2 }));
    expect(equivalentPr(flat).pr).toBeNull();
    const strong = [0, 50, 90].map((b) => ({ bucket: b, n: 10, human: b / 100, bot: 5 }));
    const e = equivalentPr(strong);
    expect(e.pr).toBe(100);
    expect(e.clamped).toBe(true);
  });
});
