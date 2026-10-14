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
  missionRelation,
  readableProposals,
  releasePanel,
  sightReasonFor,
} from '../bots/simulation/reading';
import { proposalFeatures } from '../bots/simulation/human';
import { releaseLines } from '../bots/simulation/replies';
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
    // 任務前、忠臣：結構上只有「其他 9 人 *4」一組（區間要從派票讀）。
    expect(panel.groups).toEqual([{ seats: [1, 2, 3, 5, 6, 7, 8, 9, 10], min: 4, max: 4, kind: 'rest' }]);
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
    // 「1、3」「2、3」兩組都有 3：你其實在說 3家 的讀法錯。
    expect(r.rejectCommon).toBe(3);
  });

  it('延伸／部分／打對邊 compare whole readings (leader + team): picking an earlier leader, or a proposal that picked you, is shared', () => {
    // 123：選了 1（460 的隊長），460 也選了你（4）→ 共同 1 4 = 延伸，回選 1；選 2、3 同理。
    const r = releasePanel(view, [1, 2, 3]);
    expect(r.vs.map((v) => [v.proposal.leaderSeat, v.label, v.shared, v.recall])).toEqual([
      [1, '延伸', [1, 4], true],
      [2, '部分', [2], true],
      [3, '部分', [3], true],
    ]);
    // 對照：只共用對方隊長 2 → 換掉 2 才打對邊；換完一定沒有共同的人。
    for (const team of [[1, 2, 3], [4, 6, 9], [2, 5, 8], [1, 5, 8]]) {
      const c = releasePanel(view, team).contrast;
      if (c) expect(maskOf([...c.alternative, 4]) & claimMaskOf(c.proposal)).toBe(0);
    }
  });

  it('解讀 tags: 2家 279 opposes 1家 460; 3家 370 straddles them (picks 0 from 460, 7 from 279)', () => {
    const tags = panel.tags;
    expect(tags.map((t) => t.proposal.leaderSeat)).toEqual([1, 2, 3]);
    expect(tags[1].opposite.map((p) => p.leaderSeat)).toEqual([1]);
    expect(tags[2].straddle).toMatchObject({ fromA: [10], fromB: [7] });
    expect([tags[2].straddle?.a.leaderSeat, tags[2].straddle?.b.leaderSeat]).toEqual([1, 2]);
    expect(tags[0].straddle).toBeUndefined();
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
    // 0家 說 4家（你，好人）是好人：說實話的好人本來就會這樣說，什麼都沒驗證到 → 不印。
    expect(logicPanel(view, logicModel).lakes).toEqual([]);
    // Other people's lake claims are readings, not facts: 5家 sees both claims as readings.
    const v5 = viewAt(WIKI, 5, eventIndexOfProposal(events, d), events);
    expect(logicPanel(v5, logicModel).lakes.map((l) => [l.holderSeat, l.targetSeat, l.claimEvil])).toEqual([[10, 4, false], [4, 3, true]]);
    expect(v5.ownLakes).toEqual([]);
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

describe('role branches and private checks (Edward 2026-10-14 review fixes)', () => {
  it('派西 2家（拇指 1 5）: 「若 1 是梅林 → 460 全好 → 紅 5＋3 7 8 9 *3」 and 「若 5 是梅林 → 460 是娜派的」', () => {
    const panel = logicPanel(firstView(WIKI, 2), logicModel);
    expect(panel.thumbs.map((b) => [b.merlin, b.morgana])).toEqual([[1, 5], [5, 1]]);
    expect(panel.thumbs[0].merlinRead?.summary).toEqual({ count: 4, reds: [5], rest: [3, 7, 8, 9], min: 3, max: 3 });
    expect(panel.thumbs[1].morganaRead).toMatchObject({ min: 0, max: 3 });
    expect(panel.thumbs[1].morganaRead?.proposal.leaderSeat).toBe(1);
  });

  it('派西 opposing a thumb\'s proposal is flagged: 279 vs 1家 460 → read as 「信 1 是娜」', () => {
    const r = releasePanel(firstView(WIKI, 2), [2, 7, 9]);
    expect(r.thumbStances.map((t) => [t.thumb, t.label])).toEqual([[1, '打對邊']]);
    const text = releaseLines(r, 2).map((p) => p.text).join('\n');
    expect(text).toContain('・你跟拇指 1 的 460 打對邊 → 後面的人會讀成你信 1 是娜');
  });

  it('派西 thumb odds come from the same analysis (not always 一半)', () => {
    const view = firstView(WIKI, 2);
    const worlds = logicModel.worlds(view);
    // 讓 5 是紅的世界佔 3/4：其中三個 5 紅、一個 1 紅。
    const red5 = worlds.filter((w) => (w.redMask & maskOf([5])) !== 0).slice(0, 3);
    const red1 = worlds.filter((w) => (w.redMask & maskOf([1])) !== 0).slice(0, 1);
    const r = releasePanel(view, [2, 5, 9], analyze([...red5, ...red1]));
    expect(r.privateCheck).toEqual({ kind: 'percival', thumbsOnTeam: [5], odds: [0.75] });
    expect(releaseLines(r, 2).map((p) => p.text)).toContain('・你派了拇指 5：依目前邏輯 75% 是莫甘娜');
    const half = releasePanel(view, [2, 5, 9]);
    expect(releaseLines(half, 2).map((p) => p.text)).toContain('・你派了拇指 5：一半機率是莫甘娜');
  });

  it('紅方找梅林: 3家莫德雷德 sees 1家 460 avoid every visible red, 2家 279 hit 7', () => {
    const panel = logicPanel(firstView(WIKI, 3), logicModel);
    expect(panel.hunt.map((h) => [h.proposal.leaderSeat, h.hits, h.ours])).toEqual([[1, [], false], [2, [7], false]]);
    expect(logicPanel(firstView(WIKI, 5), logicModel).hunt.map((h) => [h.proposal.leaderSeat, h.hits])).toEqual([[1, []], [2, [7]], [3, [3, 7]], [4, []]]);
  });

  it('why a 全好讀法 is impossible: a known red, both thumbs, too many good players, or one thumb short', () => {
    const loyal = firstView(WIKI, 4);
    expect(sightReasonFor(loyal, maskOf([1, 2, 3, 5, 6, 7]))).toEqual({ kind: 'good-count', goods: 7, extra: [4] });
    const merlin = firstView(WIKI, 1);
    expect(sightReasonFor(merlin, maskOf([2, 5, 8]))).toEqual({ kind: 'known-red', seats: [5] });
    const percival = firstView(WIKI, 2);
    expect(sightReasonFor(percival, maskOf([1, 5, 6]))).toEqual({ kind: 'thumbs', seats: [1, 5] });
    // 3 4 6 7 8 + 你 2 = 6 好，兩根拇指 1 5 都在外面 → 其中梅林那根也是好人 → 7 好。
    expect(sightReasonFor(percival, maskOf([3, 4, 6, 7, 8]))).toEqual({ kind: 'thumb-count', goods: 6 });
    // 一根拇指在讀法裡不是「你知道的紅」。
    expect(sightReasonFor(percival, maskOf([1, 3, 4, 6, 7, 8]))).toEqual({ kind: 'good-count', goods: 7, extra: [2] });
  });

  it('structural 區間 after a failed mission: the failed team (minus you) and the rest', () => {
    const panel = logicPanel(firstView(WIKI, 6), logicModel); // R2，157 oox
    expect(panel.groups).toEqual([
      { seats: [1, 5, 7], min: 1, max: 3, kind: 'mission', round: 1 },
      { seats: [2, 3, 4, 8, 9, 10], min: 1, max: 3, kind: 'rest' },
    ]);
  });

  it('mission relations: 3+1, 外撒, 拆車, 全換, 原隊', () => {
    expect(missionRelation([1, 5, 7, 4], 4, [1, 5, 7])).toEqual({ relation: 'plus-self', kept: [1, 5, 7] });
    expect(missionRelation([1, 5, 7, 9], 4, [1, 5, 7])).toEqual({ relation: 'spread', kept: [1, 5, 7] });
    expect(missionRelation([1, 2, 4, 6], 4, [1, 5, 7])).toEqual({ relation: 'split', kept: [1] });
    expect(missionRelation([2, 4, 6, 8], 4, [1, 5, 7])).toEqual({ relation: 'swap', kept: [] });
    expect(missionRelation([1, 4, 6, 10], 1, [1, 4, 6, 10])).toEqual({ relation: 'same', kept: [1, 4, 6, 10] });
  });

  it('「派到失敗任務的人」 counts failed missions only (an R4 mission with one fail succeeded)', () => {
    const game = {
      ...WIKI,
      proposals: [{ ...WIKI.proposals[0], round: 5, globalIndex: 0, leaderSeat: 6, teamSeats: [1, 2, 6, 7, 8] }],
      quests: [{ round: 4, teamSeats: [1, 2, 3, 4, 5], successCount: 4, failCount: 1, failed: false }],
    } as SimGame;
    expect(proposalFeatures(game, 0).failedMember).toBeNull();
    const failed = { ...game, quests: [{ ...game.quests[0], failCount: 2, successCount: 3, failed: true }] } as SimGame;
    expect(proposalFeatures(failed, 0).failedMember).toBe(true);
  });
});
