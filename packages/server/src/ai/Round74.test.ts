/**
 * 第 74 回合（情境題庫的派西類；`Round74.ts`）：`percivalNoInfo74`、`thumbBlend74`。
 *   - 預設關（現行預設、舊表、每一種對手類型），解析；
 *   - `blendThumbSplit74`：權重 0 = 後驗、1 = 讀法、確定的一邊照舊確定；
 *   - `noInfoPlan74`：分不出來（信心低於門檻、計畫本來就不帶）才兩根都擋，其他照原本；
 *   - 後驗：只動派西兩根拇指誰是紅的比例，其他角色、開關關著時逐位相同；
 *   - 機器人：關的時候和現行預設同一個答案；開的時候「第 2 局只有一根拇指被一張失敗的任務沾到」不帶拇指。
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag, resolveAgentTuning } from './AgentTuning';
import { percivalRead39, percivalThumbPlan39 } from './BlueRound39Percival';
import { bayesOptionsOf, bayesRedShare } from './belief/BayesBelief';
import { OPPONENT_TYPES, tuningForOpponent } from './humanProfile';
import { blendThumbSplit74, noInfoPlan74, noInfoThreshold74 } from './Round74';
import { answerScenario, buildScenario, observationOf, type ScenarioFixture } from './scenarios/scenarioSuite';

vi.setConfig({ testTimeout: 60_000 });

const fx = (patch: Partial<ScenarioFixture>): ScenarioFixture => ({ id: 'r74', cls: 'x', title: 't', source: 's', roles: '798063', record: [], ask: { kind: 'team' }, expect: [{ teamHas: '6' }], ...patch });
/** 第 2 局第 1 次：6 家派西，拇指 3（梅林）、9（莫甘娜）；第 1 局強制局 358 一張失敗（8 家莫德雷德），只有 3 家被沾到。 */
const STAINED = fx({ record: ['124', '235', '346', '457', '358', 'oox'], ask: { kind: 'team', seat: '6' } });
/** 同一局、4 家忠臣在 1-4 派隊。 */
const LOYAL = fx({ record: ['124', '235', '346'], ask: { kind: 'team', seat: '4' } });

describe('round 74 switches', () => {
  it('are off in the baseline and the legacy table; the human tables use thumbBlend74 = 0.25 (adopted this round); flags parse', () => {
    for (const t of [DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING]) {
      expect(t.percivalNoInfo74).toBe(0);
      expect(t.thumbBlend74).toBe(0);
    }
    for (const k of OPPONENT_TYPES) {
      expect(tuningForOpponent(k, DEFAULT_AGENT_TUNING).percivalNoInfo74).toBe(0);
      expect(tuningForOpponent(k, DEFAULT_AGENT_TUNING).thumbBlend74).toBe(k === 'ai' ? 0 : 0.25);
    }
    expect(parseTuningFlag('percivalNoInfo74')).toEqual({ percivalNoInfo74: 0.6 });
    expect(parseTuningFlag('percivalNoInfo74=0.7')).toEqual({ percivalNoInfo74: 0.7 });
    expect(parseTuningFlag('thumbBlend74')).toEqual({ thumbBlend74: 0.5 });
    expect(parseTuningFlag('thumbBlend74=1')).toEqual({ thumbBlend74: 1 });
    expect(() => parseTuningFlag('thumbBlend74=1.5')).toThrow();
    expect(() => parseTuningFlag('percivalNoInfo74=-1')).toThrow();
    expect(describeAgentTuning(resolveAgentTuning({ percivalNoInfo74: 0.6 }, LEGACY_AGENT_TUNING))).toBe('percivalNoInfo74=0.6');
    expect(noInfoThreshold74({})).toBe(0);
    expect(noInfoThreshold74({ percivalNoInfo74: 0.6 })).toBe(0.6);
    expect(bayesOptionsOf(DEFAULT_AGENT_TUNING).thumbBlend74).toBeUndefined();
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, thumbBlend74: 0.5 }).thumbBlend74).toBe(0.5);
    // The round-40 switch already is weight 1: the two are not stacked.
    expect(bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, percivalRead39: 1, thumbBlend74: 0.5 }).thumbBlend74).toBeUndefined();
  });
});

describe('blendThumbSplit74', () => {
  it('mixes on log-odds: 0 = the posterior, 1 = the read; a certain side stays certain', () => {
    expect(blendThumbSplit74(0.7, 0.3, 0)).toBe(0.7);
    expect(blendThumbSplit74(0.7, 0.3, 1)).toBeCloseTo(0.3, 12);
    expect(blendThumbSplit74(0.7, 0.3, 0.5)).toBeCloseTo(0.5, 12);
    expect(blendThumbSplit74(0.8, 0.6, 0.5)).toBeGreaterThan(0.6);
    expect(blendThumbSplit74(0.8, 0.6, 0.5)).toBeLessThan(0.8);
    expect(blendThumbSplit74(0.7, 1, 0.25)).toBe(1);
    expect(blendThumbSplit74(0.7, 0, 0.25)).toBe(0);
    expect(blendThumbSplit74(1, 0.2, 0.9)).toBe(1);
    expect(blendThumbSplit74(0.7, 0.3, 5)).toBeCloseTo(0.3, 12);
  });
});

describe('noInfoPlan74', () => {
  const built = buildScenario(STAINED);
  const obs = observationOf(built);
  const plan = percivalThumbPlan39(DEFAULT_AGENT_TUNING, obs);

  it('bars both thumbs only when the read cannot tell and the plan carried none', () => {
    expect(plan).not.toBeNull();
    const read = percivalRead39(obs);
    expect(read?.conf).toBeLessThan(0.63);
    expect(plan?.carryFav).toBe(false);
    expect(plan?.soft).toBe(true);
    // Off: the very same object.
    expect(noInfoPlan74(DEFAULT_AGENT_TUNING, obs, plan)).toBe(plan);
    expect(noInfoPlan74({ percivalNoInfo74: 0.6 }, obs, null)).toBeNull();
    const barred = noInfoPlan74({ percivalNoInfo74: 0.99 }, obs, plan);
    expect(barred?.soft).toBeUndefined();
    expect([...(barred?.barred ?? [])].sort()).toEqual(['P3', 'P9']);
    expect(barred?.carryFav).toBe(false);
    // The read is confident enough for this threshold: the plan as it is.
    expect(noInfoPlan74({ percivalNoInfo74: (read?.conf ?? 1) - 0.001 }, obs, plan)).toBe(plan);
    // A plan that carries the likelier thumb is left alone whatever the threshold.
    const carrying = plan ? { ...plan, carryFav: true } : null;
    expect(noInfoPlan74({ percivalNoInfo74: 0.99 }, obs, carrying)).toBe(carrying);
    // Not Percival's team pick: untouched.
    expect(noInfoPlan74({ percivalNoInfo74: 0.99 }, { ...obs, gamePhase: 'team_vote' }, plan)).toBe(plan);
    expect(noInfoPlan74({ percivalNoInfo74: 0.99 }, { ...obs, currentRound: 1 }, plan)).toBe(plan);
  });
});

describe('thumbBlend74 in the posterior', () => {
  const obs = observationOf(buildScenario(STAINED));
  const share = (flags: Partial<typeof DEFAULT_AGENT_TUNING>, o = obs): Map<string, number> => bayesRedShare(o, bayesOptionsOf({ ...DEFAULT_AGENT_TUNING, ...flags }));

  it('moves only the thumb split: weight 1 is the read, weights between lie between, the two thumbs still sum to one red', () => {
    const base = share({});
    const read = percivalRead39(obs);
    if (!read) throw new Error('no read');
    const first = read.thumbs[0];
    const pRead = 1 - read.pFirst;
    const full = share({ thumbBlend74: 1 });
    const half = share({ thumbBlend74: 0.5 });
    expect(full.get(first)).toBeCloseTo(pRead, 9);
    expect(full.get(first)).toBeCloseTo(share({ percivalRead39: 1 }).get(first) as number, 9);
    const lo = Math.min(base.get(first) as number, pRead);
    const hi = Math.max(base.get(first) as number, pRead);
    expect(half.get(first)).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(half.get(first)).toBeLessThanOrEqual(hi + 1e-9);
    for (const m of [base, half, full]) expect((m.get('P3') as number) + (m.get('P9') as number)).toBeCloseTo(1, 9);
    expect([...share({ thumbBlend74: 0 })]).toEqual([...base]);
  });

  it('leaves every other role alone', () => {
    const loyal = observationOf(buildScenario(LOYAL));
    expect([...share({ thumbBlend74: 1 }, loyal)]).toEqual([...share({}, loyal)]);
    const merlin = observationOf(buildScenario(fx({ record: ['124', '235'], ask: { kind: 'team', seat: '3' } })));
    expect([...share({ thumbBlend74: 1 }, merlin)]).toEqual([...share({}, merlin)]);
  });
});

describe('the agent', () => {
  it('answers the same with the switches at their current values written out (baseline: both 0; human tables: thumbBlend74 as adopted)', () => {
    for (const type of OPPONENT_TYPES) {
      const base = tuningForOpponent(type, DEFAULT_AGENT_TUNING);
      const off = { ...base, percivalNoInfo74: 0, thumbBlend74: type === 'ai' ? 0 : 0.25 };
      for (const f of [STAINED, LOYAL]) {
        const b = buildScenario(f);
        expect(answerScenario(b, off, 's1')).toEqual(answerScenario(b, base, 's1'));
      }
    }
  });

  it('percivalNoInfo74: a round-2 Percival who cannot tell the thumbs apart sends neither (he still leads his own team)', () => {
    const b = buildScenario(STAINED);
    for (const type of OPPONENT_TYPES) {
      const on = { ...tuningForOpponent(type, DEFAULT_AGENT_TUNING), percivalNoInfo74: 0.99 };
      for (const seed of ['', 's1', 's2']) {
        const team = answerScenario(b, on, seed).team ?? [];
        expect(team).toHaveLength(4);
        expect(team).toContain(6);
        expect(team).not.toContain(3);
        expect(team).not.toContain(9);
      }
    }
  });

  it('percivalNoInfo74 does not touch other roles or round 1', () => {
    const on = { ...DEFAULT_AGENT_TUNING, percivalNoInfo74: 0.99, thumbBlend74: 1 };
    const loyal = buildScenario(LOYAL);
    expect(answerScenario(loyal, on, 's1')).toEqual(answerScenario(loyal, DEFAULT_AGENT_TUNING, 's1'));
    const r1 = buildScenario(fx({ record: ['124'], ask: { kind: 'vote', seat: '6', team: '235' } }));
    expect(answerScenario(r1, { ...DEFAULT_AGENT_TUNING, percivalNoInfo74: 0.99 }, 's1').vote).toEqual(answerScenario(r1, DEFAULT_AGENT_TUNING, 's1').vote);
  });
});
