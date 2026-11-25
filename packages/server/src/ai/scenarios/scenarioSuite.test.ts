/**
 * 情境題庫（第 74 回合）：
 *   - 題目檔的格式對、每一題都建得起來（輪序、人數、失敗牌不比紅多、湖的順序）；
 *   - 硬規則的題目（A0 好人持湖說實話、A1 紅方已兩勝紅一定出失敗、站長寫死的裁定）在基準線和三種真人桌都要過，每一個種子都過；
 *   - 題目的觀察只有那一家當下看得到的東西；
 *   - 題庫的題目（每日一題）抽幾題確認對得上。
 * 其他類別（站長的糾正、百科原則、其他 AI 的提案、每日一題題庫）只量不擋，數字在 docs/ai/gap/r74-scenarios.md。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_TUNING } from '../AgentTuning';
import { OPPONENT_TYPES, tuningForOpponent } from '../humanProfile';
import { buildSimBank, readSimBankFile } from '../../bots/simulation/bank';
import { bankScenarios } from './bankScenarios';
import {
  SCENARIO_SCHEMA, answerScenario, buildScenario, checkAnswer, observationOf, recordText, rolesOfCode, runScenario, seatDiagram, teamText, validateFile,
  type ScenarioFile, type ScenarioFixture,
} from './scenarioSuite';

vi.setConfig({ testTimeout: 120_000 });

const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8')) as ScenarioFile;
const own = file.scenarios.filter((fx) => !fx.bank);
const SEEDS = ['', 's1', 's2'];

describe('fixtures.json', () => {
  it('is well formed: unique ids, every scenario builds, at least the two hard invariants are covered', () => {
    expect(file.schema).toBe(SCENARIO_SCHEMA);
    expect(() => validateFile(file)).not.toThrow();
    const hard = file.scenarios.filter((fx) => fx.hard);
    expect(hard.filter((fx) => fx.cls === 'A0').length).toBeGreaterThanOrEqual(10);
    expect(hard.filter((fx) => fx.cls === 'A1').length).toBeGreaterThanOrEqual(8);
    // Only A0, A1 and the owner's written-down rulings may be hard.
    for (const fx of hard) expect(['A0', 'A1', 'ruling']).toContain(fx.cls);
  });

  it('holds seats only: no player names, no chat (ids, titles and notes are seats, roles and record lines)', () => {
    for (const fx of file.scenarios) {
      for (const line of fx.record ?? []) expect(line).toMatch(/^[0-9oxOX>+\-? ]*$/);
      if (fx.roles) expect(fx.roles).toMatch(/^[0-9]{6}$/);
      if (fx.bank) expect(fx.bank).toMatch(/^[0-9A-Z]+-(A|[1-5]-[1-5])$/);
    }
  });
});

describe('building a scenario', () => {
  const base: ScenarioFixture = { id: 't', cls: 'x', title: 't', source: 's', roles: '789053', record: ['123 456+', 'ooo', '2345 16+', 'oooo'], ask: { kind: 'lakeTarget' }, expect: [{ targetNot: '0' }] };

  it('reads the role code and the record the way the paipu parser does', () => {
    expect(rolesOfCode('789053')).toEqual(['loyal', 'loyal', 'merlin', 'loyal', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon']);
    const b = buildScenario(base);
    expect(b.seat).toBe(10); // the first lake is seat 10's
    expect(b.game.proposals.map((p) => [p.round, p.attempt, p.leaderSeat, p.approveCount, p.wentOnMission])).toEqual([[1, 1, 1, 6, true], [2, 1, 2, 6, true]]);
    expect(b.game.quests.map((q) => [q.round, q.failCount, q.failed])).toEqual([[1, 0, false], [2, 0, false]]);
  });

  it('rejects records that cannot happen', () => {
    const bad = (patch: Partial<ScenarioFixture>): (() => unknown) => () => buildScenario({ ...base, ...patch });
    expect(bad({ record: ['1234'] })).toThrow(/要派 3 人/);
    expect(bad({ record: ['123', 'ooo'] })).toThrow(/沒有過半/);
    expect(bad({ record: ['123 456+', 'oox'] })).toThrow(/失敗牌比隊上的紅多/);
    expect(bad({ record: ['123 456+', 'ooo', '2345 16+', 'oooo', '3>4 o'] })).toThrow(/持湖的應該是 0 家/);
    expect(bad({ record: [], ask: { kind: 'team', seat: '2' } })).toThrow(/隊長是 1 家/);
    expect(bad({ record: [], ask: { kind: 'card', seat: '4', team: '123 456+' } })).toThrow(/不在出任務的隊上/);
    expect(bad({ record: [], ask: { kind: 'card', seat: '1', team: '123' } })).toThrow(/沒有過半/);
    expect(bad({ record: [], ask: { kind: 'kill' } })).toThrow(/還沒有三藍/);
  });

  it('gives the deciding seat only what it can see at that moment', () => {
    const fx = own.find((x) => x.id === 'OWN-Q2-thumb-3-4') as ScenarioFixture;
    const b = buildScenario(fx);
    const obs = observationOf(b);
    expect(obs.myRole).toBe('percival');
    expect([...(obs.knownWizards ?? [])].sort()).toEqual(['P1', 'P8']);
    expect(obs.knownEvils).toEqual([]);
    expect(obs.allEvilIds).toBeUndefined();
    expect(obs.voteHistory).toHaveLength(13);
    expect(obs.questHistory.map((q) => q.failCount)).toEqual([1, 1]);
    expect(obs.lobbyRoles).toEqual([...b.game.seatRoles].sort());
    expect(recordText(b).split('\n')).toHaveLength(3);
    expect(seatDiagram(b, null)).toContain('| 這一家看到 | 拇指 |');
  });
});

describe('checks', () => {
  it('team, vote, card, target and belief checks say why they fail', () => {
    const b = buildScenario({ id: 't', cls: 'x', title: 't', source: 's', roles: '789053', record: [], ask: { kind: 'team' }, expect: [{ teamHas: '1' }] });
    const ans = { team: [1, 2, 7], text: '派 127', pRed: [0, 0.2, 0.1, 0.3, 0.3, 0.3, 0.9, 0.5, 0.5, 0.5] };
    expect(checkAnswer(b, ans, { teamHas: '12' })).toBe('');
    expect(checkAnswer(b, ans, { teamLacks: '7' })).toContain('不該帶 7');
    expect(checkAnswer(b, ans, { teamIs: ['127', '123'] })).toBe('');
    expect(checkAnswer(b, ans, { teamNot: ['721'] })).toContain('不該派');
    expect(checkAnswer(b, ans, { teamRedsMax: 0 })).toContain('隊上的紅：7');
    expect(checkAnswer(b, ans, { pRedBelow: ['3', '2'] })).toBe('');
    expect(checkAnswer(b, ans, { pRedBelow: ['3', '2'], margin: 0.2 })).not.toBe('');
    expect(checkAnswer(b, ans, { pRedTop: { seat: '7', n: 1 } })).toBe('');
    expect(checkAnswer(b, ans, { pRedTop: { seat: '8', n: 1 } })).toContain('排第 2');
    expect(checkAnswer(b, ans, { pRedAtLeast: { seat: '7', p: 0.99 } })).not.toBe('');
    expect(checkAnswer(b, { text: '刺 3 家', target: 3 }, { hitsMerlin: true })).toBe('');
    expect(checkAnswer(b, { text: '刺 5 家', target: 5 }, { hitsMerlin: true })).toContain('梅林是 3 家');
    expect(teamText([10, 2, 5])).toBe('250');
  });
});

describe('hard scenarios stay green (A0, A1, written-down rulings)', () => {
  const hard = own.filter((fx) => fx.hard);
  for (const type of OPPONENT_TYPES) {
    it(`every hard scenario passes on every seed — ${type}`, () => {
      const tuning = tuningForOpponent(type, DEFAULT_AGENT_TUNING);
      const failed: string[] = [];
      for (const fx of hard) {
        const r = runScenario(fx, buildScenario(fx), tuning, SEEDS);
        if (r.pass < 1) failed.push(`${fx.id}: ${r.answer.text}（${r.why.join('；')}）`);
      }
      expect(failed).toEqual([]);
    });
  }

  it('the same seed gives the same answer', () => {
    const fx = own.find((x) => x.id === 'RUL-leader-on-own-team-loyal') as ScenarioFixture;
    const b = buildScenario(fx);
    expect(answerScenario(b, DEFAULT_AGENT_TUNING, 's1')).toEqual(answerScenario(b, DEFAULT_AGENT_TUNING, 's1'));
  });
});

describe('daily-question bank', () => {
  it('turns every question the daily plan can ask into a scenario; pinned ids resolve', () => {
    const bankFile = readSimBankFile([path.resolve(__dirname, '..', '..', '..', 'sim_bank.json')]);
    if (!bankFile) throw new Error('sim_bank.json missing');
    const all = bankScenarios(buildSimBank(bankFile));
    expect(all.length).toBeGreaterThan(5000);
    expect(new Set(all.map((s) => s.fixture.id)).size).toBe(all.length);
    for (const fx of file.scenarios.filter((x) => x.bank)) expect(all.some((s) => s.fixture.bank === fx.bank)).toBe(true);
    // Blue viewers only on team questions, the assassin on kill questions; answers are scored against the true roles.
    for (const s of all) {
      const role = s.game.seatRoles[s.seat - 1];
      if (s.point.kind === 'assassination') expect(role).toBe('assassin');
      else expect(['loyal', 'percival', 'merlin']).toContain(role);
    }
    const thumb = all.find((s) => s.fixture.id === 'thumb:TMQ2M-3-4');
    expect(thumb?.fixture.expect).toEqual([{ pRedBelow: ['3', '7'] }]);
  });
});
