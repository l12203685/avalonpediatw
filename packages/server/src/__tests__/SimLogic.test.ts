/**
 * 模擬瓦（2026-10-14）— 世界模型與派票解讀的黃金測試：百科模擬題「753921」
 * （第 1 局 460 1+ / 279 / 370，輪到 4家；刺7娜5莫3奧9派2梅1），後半局是編的（fixtures/simGames.ts）。
 *
 *   - 4家忠臣：126 種；三個全好讀法各 15/126；1家＋2家 7 人＞6 → 0 種；1家＋3家 只剩紅 2589；
 *     2家＋3家 只剩紅 1568；469 跟 370 打對邊 → 只剩紅 1258；468 跟 279 打對邊 → 只剩紅 1350；
 *   - 各角色的世界數：忠臣 126、派西 70（拇指各 50%）、梅林 6、刺／娜／德 7、奧伯倫 84；
 *   - 視角：梅林看不到莫德雷德、紅方看不到奧伯倫、派西的拇指照座位排（看不出誰是梅林）；
 *   - 不變量：每個世界都符合 H1–H3，真正的紅方在每個決定點都還在。
 */
import { describe, expect, it } from 'vitest';
import { parseReplayGame, type ReplayGame } from '../ai/benchmark/sheetsReplay';
import { roleKnowledge, seatOfId } from '../ai/benchmark/replayObservation';
import { combinations, evilCountFor, popcount } from '../ai/worlds';
import {
  ALL_RED_SETS,
  analyze,
  enumerateWorlds,
  logicModel,
  missionConstraints,
  satisfies,
  viewerConstraints,
} from '../bots/simulation/logic';
import {
  claimMaskOf,
  evaluateInterval,
  logicPanel,
  readableProposals,
  releasePanel,
} from '../bots/simulation/reading';
import {
  decisionsOf,
  eventIndexOfProposal,
  firstDecision,
  publicEvents,
  sightFor,
  viewAt,
  type SimGame,
} from '../bots/simulation/scenario';
import { maskDigits, maskOf } from '../bots/simulation/seats';
import { shortRow, wikiRow } from './fixtures/simGames';

function parse(row: ReturnType<typeof wikiRow>): SimGame {
  const r = parseReplayGame(row);
  if (!r.ok) throw new Error(r.reason);
  const g: SimGame & { names?: string[] } = { ...r.game };
  delete g.names;
  return g;
}

const WIKI = parse(wikiRow());
const SHORT = parse(shortRow());

/** 第 seat 家第一個決定當下的視角。 */
function firstView(g: SimGame, seat: number) {
  const d = firstDecision(g, seat);
  if (d === null) throw new Error('no decision');
  const events = publicEvents(g);
  return viewAt(g, seat, eventIndexOfProposal(events, d), events);
}

const redMaskOf = (g: SimGame): number => maskOf(g.seatRoles.map((r, i) => (['assassin', 'morgana', 'mordred', 'oberon'].includes(r) ? i + 1 : 0)).filter(Boolean));

describe('ai/worlds (moved out of GoodLakeInfo, behaviour unchanged)', () => {
  it('210 four-red sets over 10 seats', () => {
    expect(evilCountFor(10)).toBe(4);
    expect(ALL_RED_SETS).toHaveLength(210);
    expect(new Set(ALL_RED_SETS).size).toBe(210);
    expect(ALL_RED_SETS.every((m) => popcount(m) === 4)).toBe(true);
    expect(combinations([0, 1, 2], 2)).toEqual([0b011, 0b101, 0b110]);
  });
});

describe('golden: 百科模擬題 753921, 4家忠臣 at R1', () => {
  const view = firstView(WIKI, 4);
  const panel = logicPanel(view, logicModel);

  it('sees the three earlier R1 proposals in captain order', () => {
    expect(readableProposals(view).map((p) => [p.leaderSeat, p.teamSeats])).toEqual([[1, [4, 6, 10]], [2, [2, 7, 9]], [3, [3, 7, 10]]]);
    expect(view.events.every((e) => e.kind === 'proposal')).toBe(true);
  });

  it('126 worlds, every other seat 4/9, joint entropy log2 126', () => {
    expect(panel.analysis.count).toBe(126);
    expect(panel.analysis.entropyBits).toBeCloseTo(Math.log2(126), 9);
    expect(panel.groups).toEqual([{ seats: [1, 2, 3, 5, 6, 7, 8, 9, 10], marginal: 4 / 9, min: 4, max: 4 }]);
  });

  it('全好讀法 15/126 each; 1+2 impossible (7 > 6), 1+3 → 紅 2589, 2+3 → 紅 1568', () => {
    expect(panel.claims.map((c) => [maskDigits(c.mask), c.weight])).toEqual([['1460', 15], ['279', 15], ['370', 15]]);
    const pair = (a: number, b: number) => panel.pairs.find((p) => p.a === a && p.b === b);
    expect(pair(0, 1)).toMatchObject({ unionSize: 7, tooMany: true, weight: 0 });
    expect(pair(0, 2)?.worlds?.map(maskDigits)).toEqual(['2589']);
    expect(pair(1, 2)?.worlds?.map(maskDigits)).toEqual(['1568']);
  });

  it('469 releases: 35 public worlds; 460 延伸 5, 279 部分 5, 370 打對邊 → 紅 1258; contrast 468 vs 279 → 紅 1350', () => {
    const r = releasePanel(view, [4, 6, 9]);
    expect(r.publicTotal).toBe(210);
    expect(r.weight).toBe(35);
    expect(r.vs.map((v) => [v.label, v.shared, v.weight])).toEqual([['延伸', [4, 6], 5], ['部分', [9], 5], ['打對邊', [], 1]]);
    expect(r.vs[2].worlds?.map(maskDigits)).toEqual(['1258']);
    // 1家＋2家 本身就互斥（7 人），不算你放出的資訊；1+3、2+3 本身各剩 1 種，加上你的 469 就不可能。
    expect(r.rejects.map((x) => [x.a.leaderSeat, x.b.leaderSeat])).toEqual([[1, 3], [2, 3]]);
    expect(r.contrast).toMatchObject({ alternative: [4, 6, 8], weight: 1, yourWeight: 5 });
    expect(r.contrast?.worlds?.map(maskDigits)).toEqual(['1350']);
  });

  it('區間 789=2 460=1: 45/126, reduced to 6 0 一紅 70/126, both 24/126', () => {
    const ev = evaluateInterval(view, [{ seats: [7, 8, 9], min: 2, max: 2 }, { seats: [4, 6, 10], min: 1, max: 1 }], logicModel);
    expect(ev.total).toBe(126);
    expect(ev.groups.map((g) => [g.weight, g.self ?? null, g.seats])).toEqual([[45, null, [7, 8, 9]], [70, 'good', [6, 10]]]);
    expect(ev.jointWeight).toBe(24);
    expect(ev.jointWorlds).toHaveLength(24);
  });
});

describe('view sizes and private sight per role (production conventions)', () => {
  it('忠臣 126, 派西 70, 梅林 6, 刺／娜／德 7, 奧伯倫 84 at R1', () => {
    // 開局（還沒有任何事件）時各家的視角。
    const size = (seat: number): number => logicModel.worlds(viewAt(WIKI, seat, 0)).length;
    expect(size(4)).toBe(126); // 忠臣
    expect(size(2)).toBe(70); // 派西
    expect(size(1)).toBe(6); // 梅林
    expect(size(3)).toBe(7); // 莫德雷德
    expect(size(5)).toBe(7); // 莫甘娜
    expect(size(7)).toBe(7); // 刺客
    expect(size(9)).toBe(84); // 奧伯倫
    expect(enumerateWorlds(viewerConstraints(viewAt(WIKI, 9, 0)))).toHaveLength(84);
  });

  it('派西 at 2: 拇指 1 5 each 50%, others 3/7', () => {
    const a = analyze(logicModel.worlds(firstView(WIKI, 2)));
    expect(a.marginal(1)).toBeCloseTo(0.5, 9);
    expect(a.marginal(5)).toBeCloseTo(0.5, 9);
    expect(a.marginal(3)).toBeCloseTo(3 / 7, 9);
  });

  it('Merlin sees 5 7 9 but not Mordred 3; reds see each other but not Oberon 9; Oberon sees nobody', () => {
    expect(sightFor(WIKI, 1)).toEqual({ kind: 'merlin', seen: [5, 7, 9] });
    expect(sightFor(WIKI, 3)).toEqual({ kind: 'evil', mates: [5, 7] });
    expect(sightFor(WIKI, 5)).toEqual({ kind: 'evil', mates: [3, 7] });
    expect(sightFor(WIKI, 7)).toEqual({ kind: 'evil', mates: [3, 5] });
    expect(sightFor(WIKI, 9)).toEqual({ kind: 'oberon' });
    expect(sightFor(WIKI, 4)).toEqual({ kind: 'loyal' });
  });

  it("Percival's thumbs are listed by seat, never Merlin first (cannot tell which is which)", () => {
    // WIKI: 梅林 1、莫甘娜 5 → 1 5；SHORT: 梅林 4、莫甘娜 2 → still 2 4 (Morgana first by seat).
    expect(sightFor(WIKI, 2)).toEqual({ kind: 'percival', thumbs: [1, 5] });
    expect(sightFor(SHORT, 6)).toEqual({ kind: 'percival', thumbs: [2, 4] });
  });

  it('sight equals roleKnowledge() for every seat of both games', () => {
    for (const g of [WIKI, SHORT]) {
      for (let seat = 1; seat <= 10; seat++) {
        const k = roleKnowledge({ ...g, names: [] } as ReplayGame, seat);
        const s = sightFor(g, seat);
        const seen = s.kind === 'merlin' ? s.seen : s.kind === 'evil' ? s.mates : [];
        expect(seen).toEqual(k.knownEvils.map(seatOfId).sort((a, b) => a - b));
        if (s.kind === 'percival') expect(s.thumbs).toEqual((k.knownWizards ?? []).map(seatOfId).sort((a, b) => a - b));
      }
    }
  });
});

describe('mission facts (H1), own lakes (H3) and invariants', () => {
  it('a failed R1 mission 157 (oox) means ≥ 1 red on it; a success proves nothing', () => {
    const v = firstView(WIKI, 6); // R2, after R1 oox on 1 5 7
    const worlds = logicModel.worlds(v);
    expect(worlds.every((w) => popcount(w.redMask & maskOf([1, 5, 7])) >= 1)).toBe(true);
    // 忠臣 6：C(9,4) = 126，扣掉 1 5 7 都不是紅的 C(6,4) = 15 種。
    expect(worlds.length).toBe(126 - 15);
  });

  it('fail counts: f fail cards → at least f reds on the team; R4 with 1 fail (still a success) → at least 1; a clean success → nothing', () => {
    const quest = (round: number, teamSeats: number[], failCount: number, failed: boolean) => ({
      kind: 'quest' as const, round, teamSeats, successCount: teamSeats.length - failCount, failCount, failed,
    });
    const c = missionConstraints({ events: [quest(2, [1, 2, 3, 4], 2, true), quest(4, [5, 6, 7, 8, 9], 1, false), quest(3, [1, 5, 9, 10], 0, false)] });
    expect(c).toEqual([{ mask: maskOf([1, 2, 3, 4]), fails: 2 }, { mask: maskOf([5, 6, 7, 8, 9]), fails: 1 }]);
    const worlds = enumerateWorlds({ good: 0, red: 0, exactlyOne: [], missions: c });
    expect(worlds.every((w) => popcount(w.redMask & maskOf([1, 2, 3, 4])) >= 2 && popcount(w.redMask & maskOf([5, 6, 7, 8, 9])) >= 1)).toBe(true);
    // 1–4 有 a 紅、5–9 有 b 紅、10 有 c 紅，a ≥ 2、b ≥ 1、a + b + c = 4：
    // (2,2,0) 6·10 + (2,1,1) 6·5 + (3,1,0) 4·5 = 60 + 30 + 20 = 110。
    expect(worlds).toHaveLength(110);
    expect(enumerateWorlds({ good: 0, red: 0, exactlyOne: [], missions: missionConstraints({ events: [quest(1, [1, 2, 3], 0, false)] }) })).toHaveLength(210);
  });

  it('the holder of a lake knows the truth: 4 laked 3 (red) before R4', () => {
    const d = decisionsOf(WIKI, 5)[1]; // 第 4 局第 1 次（5家）
    const events = publicEvents(WIKI);
    const view = viewAt(WIKI, 4, eventIndexOfProposal(events, d), events);
    expect(view.ownLakes).toEqual([{ targetSeat: 3, evil: true }]);
    expect(logicModel.worlds(view).every((w) => (w.redMask & maskOf([3])) !== 0)).toBe(true);
    // Other people's lake claims are readings, not facts.
    const panel = logicPanel(view, logicModel);
    expect(panel.lakes.map((l) => [l.holderSeat, l.targetSeat, l.claimEvil])).toEqual([[10, 4, false]]);
  });

  it('every world satisfies the constraints, and the true red set survives at every decision of every seat', () => {
    for (const g of [WIKI, SHORT]) {
      const events = publicEvents(g);
      const truth = redMaskOf(g);
      for (let seat = 1; seat <= 10; seat++) {
        for (const d of decisionsOf(g, seat)) {
          const view = viewAt(g, seat, eventIndexOfProposal(events, d), events);
          const c = viewerConstraints(view);
          const worlds = logicModel.worlds(view);
          expect(worlds.every((w) => satisfies(w.redMask, c))).toBe(true);
          expect(worlds.some((w) => w.redMask === truth)).toBe(true);
        }
      }
    }
  });

  it('claim masks are captain ∪ team', () => {
    const p = readableProposals(firstView(WIKI, 4))[0];
    expect(maskDigits(claimMaskOf(p))).toBe('1460');
  });
});
