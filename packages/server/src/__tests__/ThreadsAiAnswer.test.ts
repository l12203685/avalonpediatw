/**
 * Threads 每日一題的「百科AI 答案」（2026-11-18，src/bots/threads/aiAnswer.ts）：
 *   - 出題那一刻重建的觀察跟牌譜一致（只到那一刻、大廳角色不照座位）；
 *   - 輸出的欄位齊全、數字合理；同一個種子結果一樣，而且跟模擬瓦 /區間 派的一樣；
 *   - 刺殺題：目標是藍方、P(梅林) 加起來是 1、照它真的排序（前排優先），分數的組成加起來等於排序用的分數；
 *   - threads:draft 的貼文不含百科AI 的答案。
 * 用 commit 進 repo 的題庫 sim_bank.json（實戰的局，沒有名字）。
 */

import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { aiReading, decisionObservation, defaultBot } from '../bots/simulation/aiRead';
import { isRed } from '../bots/simulation/scenario';
import { seatId, seatOfId } from '../ai/benchmark/replayObservation';
import { ThreadsGenerator } from '../bots/threads/generate';
import { AI_ANSWER_SCHEMA, AI_ANSWER_TOP, aiAnswerSummary, targetOfExercise, threadsAiAnswer, traceText, type ThreadsAiAnswer } from '../bots/threads/aiAnswer';

const serverRoot = path.resolve(__dirname, '..', '..');
let bank: SimBank;

beforeAll(() => {
  const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!file) throw new Error('sim_bank.json missing');
  bank = buildSimBank(file, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
});

/**
 * 11/18–11/24 主控台選的題（週三 1-5、週四 3-5、週六 4-5、週日第五局、週一刺殺、週二派西）。
 * 2026-11-21：JSD3E（備註：有一家重新登入後沒看到拇指）和 G85S5（備註標了事件）是紀錄異常的局，題庫不再收
 * （bots/simulation/quality.ts），改用題庫裡另外的 4-5 和刺殺題。
 */
const TEAM_IDS = ['SV1Q8-1-5', 'SV1Q8-3-5', '010HP-4-5', 'DMH6Q-5-1', 'TMQ2M-3-4'];
const KILL_ID = '007TB-A';

function resolve(id: string) {
  const t = targetOfExercise(bank, id);
  if (!t) throw new Error(`exercise ${id} not in sim_bank.json`);
  return t;
}

describe('targetOfExercise', () => {
  it('resolves staged, assassination and first-decision ids; unknown ones are null', () => {
    const tail = resolve('SV1Q8-3-5');
    const p = tail.game.proposals[tail.target.proposal as number];
    expect([p.round, p.attempt]).toEqual([3, 5]);
    expect(tail.target.seat).toBe(p.leaderSeat);
    const kill = resolve(KILL_ID);
    expect(kill.target.proposal).toBeNull();
    expect(kill.game.seatRoles[kill.target.seat - 1]).toBe('assassin');
    const first = targetOfExercise(bank, 'SV1Q8-4');
    if (first) expect(first.game.proposals[first.target.proposal as number].leaderSeat).toBe(4);
    expect(targetOfExercise(bank, 'ZZZZZ-1-5')).toBeNull();
    expect(targetOfExercise(bank, 'not an id')).toBeNull();
  });
});

describe('replay at the decision point', () => {
  it('team decision: the observation holds the record up to that proposal and nothing after', () => {
    for (const id of TEAM_IDS) {
      const { game, target } = resolve(id);
      const p = game.proposals[target.proposal as number];
      const obs = decisionObservation(game, target.seat, { kind: 'team_select', proposal: p.globalIndex });
      expect(obs.gamePhase).toBe('team_select');
      expect(obs.myPlayerId).toBe(seatId(target.seat));
      expect(obs.myRole).toBe(game.seatRoles[target.seat - 1]);
      expect(obs.currentRound).toBe(p.round);
      expect(obs.currentLeader).toBe(seatId(p.leaderSeat));
      expect(obs.failCount).toBe(p.attempt - 1);
      // Every earlier proposal, in order, with the record's leader and team; none of this one or later.
      expect(obs.voteHistory).toHaveLength(p.globalIndex);
      obs.voteHistory.forEach((v, i) => {
        const q = game.proposals[i];
        expect([v.round, v.attempt, v.leader]).toEqual([q.round, q.attempt, seatId(q.leaderSeat)]);
        expect(v.team.map(seatOfId)).toEqual(q.teamSeats);
        expect(v.approved).toBe(q.wentOnMission);
      });
      // Missions of earlier rounds only, with the record's fail cards.
      const quests = game.quests.filter((q) => q.round < p.round);
      expect(obs.questHistory.map((q) => [q.round, q.failCount])).toEqual(quests.map((q) => [q.round, q.failCount]));
      expect(obs.questResults).toEqual(quests.map((q) => (q.failed ? 'fail' : 'success')));
      // Lakes of earlier rounds; the viewer's own lake results only.
      expect((obs.lakeHistory ?? []).map((l) => l.round)).toEqual(game.lakes.filter((l) => l.round < p.round).map((l) => l.round));
      for (const l of obs.myLakeResults ?? []) expect(game.lakes.some((x) => x.holderSeat === target.seat && seatId(x.targetSeat) === l.targetId)).toBe(true);
      // The lobby lists the roles dealt, not who holds them.
      expect(obs.lobbyRoles).toEqual([...game.seatRoles].sort());
      expect(obs.allEvilIds).toBeUndefined();
    }
  });

  it('assassination: the whole record plus every red (and role) for the assassin', () => {
    const { game, target } = resolve(KILL_ID);
    const obs = decisionObservation(game, target.seat, { kind: 'assassination' });
    expect(obs.gamePhase).toBe('assassination');
    expect(obs.voteHistory).toHaveLength(game.proposals.length);
    expect(obs.questHistory).toHaveLength(game.quests.length);
    const reds = game.seatRoles.flatMap((r, i) => (isRed(r) ? [seatId(i + 1)] : []));
    expect([...(obs.allEvilIds ?? [])].sort()).toEqual([...reds].sort());
  });
});

function checkSchema(a: ThreadsAiAnswer): void {
  expect(a.schema).toBe(AI_ANSWER_SCHEMA);
  expect(typeof a.exerciseId).toBe('string');
  expect(a.belief.seats.map((b) => b.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const b of a.belief.seats) expect(b.p).toBeGreaterThanOrEqual(0);
  for (const b of a.belief.seats) expect(b.p).toBeLessThanOrEqual(1);
  expect(a.top.items.length).toBeGreaterThan(0);
  expect(a.top.items.length).toBeLessThanOrEqual(AI_ANSWER_TOP);
  expect(a.top.metric.length).toBeGreaterThan(0);
  expect(a.reasons.length).toBeGreaterThan(0);
  for (const r of a.reasons) {
    expect(['knowledge', 'rule', 'trace', 'review', 'facts', 'terms', 'driver']).toContain(r.source);
    expect(r.label.length).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
  }
  expect(a.pick.seats.length).toBeGreaterThan(0);
  expect(a.real.seats.length).toBeGreaterThan(0);
  expect(a.real.sameAsAi).toBe(a.real.seats.join() === a.pick.seats.join());
  expect(a.policy.agent).toBe('ForwardAgent(HeuristicAgent)');
  expect(a.policy.tuning).toBe('DEFAULT_AGENT_TUNING');
  expect(a.policy.tuningHash).toMatch(/^[0-9a-f]{10}$/);
  expect(a.policy.seed.length).toBeGreaterThan(0);
  expect(typeof a.policy.forwardRouting).toBe('boolean');
  expect(aiAnswerSummary(a)).toContain(a.exerciseId);
}

describe('threadsAiAnswer — team decisions', () => {
  it('has the documented shape, the record\'s real team and a sorted top list', () => {
    for (const id of TEAM_IDS) {
      const { game, target } = resolve(id);
      const p = game.proposals[target.proposal as number];
      const a = threadsAiAnswer(game, target, { exerciseId: id, gitSha: 'abc123' });
      checkSchema(a);
      expect(a.exerciseId).toBe(id);
      expect(a.decision).toMatchObject({ kind: 'team', round: p.round, attempt: p.attempt, teamSize: p.teamSeats.length, forced: p.forced });
      expect(a.decision.failsRequired).toBe(p.round === 4 ? 2 : 1);
      expect(a.viewer.seat).toBe(target.seat);
      expect(a.pick.seats).toHaveLength(p.teamSeats.length);
      expect(new Set(a.pick.seats).size).toBe(a.pick.seats.length);
      expect(a.real.seats).toEqual([...p.teamSeats].sort((x, y) => x - y));
      expect(a.real.approved).toBe(p.wentOnMission);
      expect(a.belief.seats.find((b) => b.seat === target.seat)?.p).toBe(0);
      const ps = a.top.items.map((t) => t.p);
      expect([...ps].sort((x, y) => y - x)).toEqual(ps);
      expect(a.top.options).toBeGreaterThanOrEqual(a.top.items.length);
      expect(a.pick.rank).toBeGreaterThanOrEqual(1);
      expect(a.top.items.filter((t) => t.chosen).every((t) => t.seats.join() === a.pick.seats.join())).toBe(true);
      // Hindsight reads the dealt roles.
      expect(a.hindsight.aiPickReds).toEqual(a.pick.seats.filter((s) => isRed(game.seatRoles[s - 1])));
      expect(a.policy.gitSha).toBe('abc123');
      expect(a.reasons.some((r) => r.source === 'trace')).toBe(true);
    }
  });

  it('is deterministic for a seed and matches the 模擬瓦 /區間 pick with the default seed', () => {
    for (const id of TEAM_IDS) {
      const { game, target } = resolve(id);
      const once = JSON.stringify(threadsAiAnswer(game, target, { exerciseId: id }));
      const twice = JSON.stringify(threadsAiAnswer(game, target, { exerciseId: id }));
      expect(twice).toBe(once);
      const seeded = threadsAiAnswer(game, target, { exerciseId: id, seed: 'fixed-seed' });
      expect(JSON.stringify(threadsAiAnswer(game, target, { exerciseId: id, seed: 'fixed-seed' }))).toBe(JSON.stringify(seeded));
      expect(seeded.policy.seed).toBe('fixed-seed');
      const sim = aiReading(game, target.seat, target.proposal as number);
      expect(sim.teams[0].seats).toEqual((JSON.parse(once) as ThreadsAiAnswer).pick.seats);
    }
  });

  it('a 10-player round 4 ranks teams by "fewer than 2 reds" and lists both probabilities', () => {
    const { game, target } = resolve('010HP-4-5');
    const a = threadsAiAnswer(game, target);
    expect(a.decision.failsRequired).toBe(2);
    expect(a.top.metric).toContain('少於 2');
    expect(a.reasons.some((r) => r.source === 'facts' && r.text.includes('P(沒有紅)'))).toBe(true);
  });
});

describe('threadsAiAnswer — assassination', () => {
  it('stabs a blue seat, P(merlin) sums to 1 over the blues, the order is front tier first', () => {
    const { game, target } = resolve(KILL_ID);
    const a = threadsAiAnswer(game, target, { exerciseId: KILL_ID });
    checkSchema(a);
    expect(a.decision.kind).toBe('assassination');
    expect(a.belief.metric).toBe('P(merlin)');
    expect(a.pick.seats).toHaveLength(1);
    const stab = a.pick.seats[0];
    expect(isRed(game.seatRoles[stab - 1])).toBe(false);
    expect(stab).not.toBe(target.seat);
    for (const b of a.belief.seats) if (isRed(game.seatRoles[b.seat - 1])) expect(b.p).toBe(0);
    expect(a.belief.seats.reduce((s, b) => s + b.p, 0)).toBeCloseTo(1, 2);
    // The pick is the first of the agent's own order; the front tier comes before the rest.
    expect(a.top.items[0].seats).toEqual([stab]);
    expect(a.top.items[0].chosen).toBe(true);
    const fronts = a.top.items.map((t) => t.front);
    expect(fronts.indexOf(false) === -1 || fronts.slice(fronts.indexOf(false)).every((f) => f === false)).toBe(true);
    expect(a.real.seats).toEqual([game.assassinTargetSeat]);
    expect(a.real.hit).toBe(game.seatRoles[(game.assassinTargetSeat as number) - 1] === 'merlin');
    expect(game.seatRoles[(a.hindsight.merlinSeat as number) - 1]).toBe('merlin');
    expect(a.hindsight.aiHit).toBe(stab === a.hindsight.merlinSeat);
    expect(a.reasons.some((r) => r.source === 'terms')).toBe(true);
    expect(JSON.stringify(threadsAiAnswer(game, target, { exerciseId: KILL_ID }))).toBe(JSON.stringify(a));
  });

  it('the readout ranks exactly like the agent: the best front-tier score is the target, terms add up', () => {
    const { game, target } = resolve(KILL_ID);
    const obs = decisionObservation(game, target.seat, { kind: 'assassination' });
    const { agent, base } = defaultBot(game, target.seat);
    const action = agent.act(obs);
    const readout = base.assassinationReadout(obs);
    expect(readout).not.toBeNull();
    if (!readout || action.type !== 'assassinate') return;
    const best = [...readout.front].sort((x, y) => (readout.scores.get(y) ?? 0) - (readout.scores.get(x) ?? 0) || obs.allPlayerIds.indexOf(x) - obs.allPlayerIds.indexOf(y))[0];
    expect(action.targetId).toBe(best);
    for (const id of readout.candidates) {
      const t = readout.terms.get(id);
      expect(t).toBeDefined();
      if (t) expect(t.model + t.vote + t.lake + t.lead + t.reuse).toBeCloseTo(readout.scores.get(id) ?? NaN, 10);
    }
  });
});

describe('traceText', () => {
  it('writes seats as N家 and flags a later step that replaced the scored team', () => {
    expect(traceText('team_select → team [P5,P6,P4] (score=0.283) → blue clean-lead team', [4, 5, 6], null)).toBe(
      'team_select → team [4、5、6家] (score=0.283) → blue clean-lead team',
    );
    const swapped = traceText('team_select → team [P10,P1,P4,P8,P2] (score=1.092) → blue clean-lead team', [1, 4, 6, 8, 10], null);
    expect(swapped).toContain('[1、2、4、8、0家]');
    expect(swapped).toContain('改成最後派的 14680');
    expect(traceText('baseline assassinate', [3], 'boom')).toContain('改用基準策略：boom');
  });
});

describe('drafts', () => {
  it('the generated draft (what the publish workflow posts) carries no AI answer', () => {
    const gen = new ThreadsGenerator({ bank, titles: new Map(), readSaved: () => null, startDate: '2026-11-18' });
    const draft = gen.draftFor('2026-11-19');
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect('aiAnswer' in draft).toBe(false);
    expect(draft.post.text).not.toContain('百科AI');
  });
});
