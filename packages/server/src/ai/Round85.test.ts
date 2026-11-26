/**
 * 第 85 回合（藍方提議・第 1 局隊伍的錨定）：玩家回報「0家三加一 任務失敗後 所有人還是會直接無腦繼續第一局三加一」——`r1Split85`（預設關）。
 * 局面用情境題庫的寫法（`scenarioSuite.ts`）：一行一次派票（隊上的座位＋異常票 `X+`），一行 `o`／`x` 是任務牌；`roles` = 刺／娜／德／奧／派／梅 的座位。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import { AGENT_TUNING_KEYS, DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, describeAgentTuning, parseTuningFlag } from './AgentTuning';
import { r1Split85Applies, r1Split85Team, r1SplitCore85, round85Stats } from './Round85';
import { tuningForOpponent } from './humanProfile';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { answerScenario, buildScenario, observationOf, runScenario, type ScenarioFile, type ScenarioFixture } from './scenarios/scenarioSuite';
import * as fs from 'fs';
import * as path from 'path';
import { seatId } from './benchmark/replayObservation';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
// 紅：5 刺客、7 莫甘娜、8 莫德雷德、0 奧伯倫；9 派西、6 梅林；1–4 忠臣。
const ROLES = '578096';
const fx = (record: string[]): ScenarioFixture => ({ id: 'r85', cls: 'r85', title: '', source: '', roles: ROLES, record, ask: { kind: 'team' }, expect: [] });
// 第 1 局 123 成功；第 2 局 1235（第 1 局的隊＋5）一張失敗；第 3 局第 1 次是 3 家（在第 1 局的隊上），第 2 次是 4 家（不在）。
const R3_LEAD3 = ['123 456+', 'ooo', '1235 46+', 'ooox'];
const R3_LEAD4 = [...R3_LEAD3, '3456'];
const ids = (s: string): string[] => [...s].map((c) => seatId(c === '0' ? 10 : Number(c)));

describe('round 85 flags', () => {
  it('exist, default off everywhere, parse and describe', () => {
    for (const k of ['r1Split85', 'r1Split85Scope'] as const) {
      expect(AGENT_TUNING_KEYS).toContain(k);
      expect(LEGACY_AGENT_TUNING[k]).toBe(0);
      expect(DEFAULT_AGENT_TUNING[k]).toBe(0);
      for (const type of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) expect(tuningForOpponent(type, DEFAULT_AGENT_TUNING)[k]).toBe(0);
    }
    expect(parseTuningFlag('r1Split85')).toEqual({ r1Split85: 0.9 });
    expect(parseTuningFlag('r1Split85=0.5')).toEqual({ r1Split85: 0.5 });
    expect(parseTuningFlag('r1Split85Scope=7')).toEqual({ r1Split85Scope: 7 });
    expect(() => parseTuningFlag('r1Split85=1.5')).toThrow();
    expect(() => parseTuningFlag('r1Split85Scope=8')).toThrow();
    expect(describeAgentTuning(T({ r1Split85: 0.9 }))).toContain('r1Split85=0.9');
    expect(describeAgentTuning(T())).not.toContain('r1Split85');
  });
});

describe('round 85 spot', () => {
  it('R1 success (no fail card) + the previous mission held the whole R1 team and showed a fail card → the R1 team', () => {
    const o = observationOf(buildScenario(fx(R3_LEAD4)));
    expect([...r1SplitCore85(o)!].sort()).toEqual(ids('123').sort());
    // R2 itself, an R1 fail, a previous mission without the whole R1 team, or a clean previous mission: not the spot
    expect(r1SplitCore85(observationOf(buildScenario(fx(['123 456+', 'ooo']))))).toBeNull();
    expect(r1SplitCore85(observationOf(buildScenario(fx(['125 346+', 'oox', '1253 46+', 'ooox']))))).toBeNull();
    expect(r1SplitCore85(observationOf(buildScenario(fx(['123 456+', 'ooo', '1245 36+', 'ooox']))))).toBeNull();
    expect(r1SplitCore85(observationOf(buildScenario(fx(['123 456+', 'ooo', '1235 46+', 'oooo']))))).toBeNull();
    // bit 2: an earlier failed mission (not only the previous one)
    const r4 = ['123 456+', 'ooo', '1235 46+', 'ooox', '3469 12+', 'oooo'];
    expect(r1SplitCore85(observationOf(buildScenario(fx(r4))))).toBeNull();
    expect(r1SplitCore85(observationOf(buildScenario(fx(r4))), 2)).not.toBeNull();
  });

  it('applies to a loyal / Percival leader only (Merlin with bit 1), only when on', () => {
    const o = observationOf(buildScenario(fx(R3_LEAD4)));
    expect(o.myRole).toBe('loyal');
    expect(r1Split85Applies(T(), o)).toBe(false);
    expect(r1Split85Applies(T({ r1Split85: 0.9 }), o)).toBe(true);
    // seat 6 (Merlin) leads the 4th proposal of R3
    const m = observationOf(buildScenario(fx([...R3_LEAD4, '4567', '5678'])));
    expect(m.myRole).toBe('merlin');
    expect(r1Split85Applies(T({ r1Split85: 0.9 }), m)).toBe(false);
    expect(r1Split85Applies(T({ r1Split85: 0.9, r1Split85Scope: 1 }), m)).toBe(true);
    // a red seat (7, Morgana) never
    const red = observationOf(buildScenario(fx([...R3_LEAD4, '4567', '5678', '6789'])));
    expect(red.myTeam).toBe('evil');
    expect(r1Split85Applies(T({ r1Split85: 0.9 }), red)).toBe(false);
  });
});

describe('round 85 pick', () => {
  it('replaces the R1 team + 1 by the cleanest self-inclusive team without the whole R1 team, within λ', () => {
    const o = observationOf(buildScenario(fx(R3_LEAD4)));
    const team = ids('1234');
    // The leader's own vote rules (`goodCleanVote` 0.3: P(clean) under 0.3 → reject) refuse every alternative on this record — the alternatives are
    // all dirtier than waiting for the next leader — so the switch keeps the R1 team + 1 (an alternative must pass the leader's own vote).
    expect(r1Split85Team(T({ r1Split85: 0.01 }), o, team)).toBeNull();
    const tun = T({ r1Split85: 0.01, goodCleanVote: 0 });
    const alt = r1Split85Team(tun, o, team)!;
    expect(alt).not.toBeNull();
    expect(alt).toContain(o.myPlayerId);
    expect(alt).toHaveLength(4);
    expect(ids('123').every((id) => alt.includes(id))).toBe(false);
    const opts = bayesOptionsOf(tun);
    const pAlt = bayesTeamClean(o, alt, opts)!;
    // it is the cleanest such team
    expect(pAlt).toBeGreaterThan(0);
    // λ = 1: the R1 team + self is cleaner here (each R1 member stays cleaner than an outsider), so it is kept
    const before = round85Stats.keptMath;
    expect(r1Split85Team(T({ r1Split85: 1, goodCleanVote: 0 }), o, team)).toBeNull();
    expect(round85Stats.keptMath).toBe(before + 1);
    expect(pAlt).toBeLessThan(bayesTeamClean(o, team, opts)!);
    // a team that does not hold the whole R1 team, the switch off, or a gate that refuses every alternative: unchanged
    expect(r1Split85Team(tun, o, ids('1246'))).toBeNull();
    expect(r1Split85Team(T(), o, team)).toBeNull();
    expect(r1Split85Team(tun, o, team, () => false)).toBeNull();
  });

  it('off: the agent answers exactly as the default (toggle-off identity on the reported spot)', () => {
    for (const rec of [R3_LEAD3, R3_LEAD4]) {
      const b = buildScenario(fx(rec));
      for (const seed of ['', 'a', 'b']) {
        expect(answerScenario(b, T({ r1Split85: 0 }), seed).team).toEqual(answerScenario(b, DEFAULT_AGENT_TUNING, seed).team);
      }
    }
  });
});

describe('round 85 scenario cases (fixtures.json, cls r85)', () => {
  // Not `hard` (only A0 / A1 / the owner's written rulings may be), but the reported spot is checked here on every profile the site uses.
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios', 'fixtures.json'), 'utf8')) as ScenarioFile;
  const cases = file.scenarios.filter((x) => x.cls === 'r85');
  it('there are four, and the default and every human table answer all of them', () => {
    expect(cases).toHaveLength(4);
    for (const type of ['ai', 'weakHuman', 'avgHuman', 'strongHuman'] as const) {
      for (const c of cases) {
        const r = runScenario(c, buildScenario(c), tuningForOpponent(type, DEFAULT_AGENT_TUNING), ['', 'a', 'b']);
        expect({ id: c.id, type, pass: r.pass, why: r.why }).toEqual({ id: c.id, type, pass: 1, why: [] });
      }
    }
  });
});
