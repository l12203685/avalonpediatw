/**
 * 網站「與機器人練習」— unit pieces: engine forced seat/role, session
 * registry (trace, flags, TTL), option parsing, and the read-only
 * decision explanations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Player, Role, Room } from '@avalon/shared';
import { GameEngine } from '../game/GameEngine';
import { PracticeSessions, PRACTICE_LIMITS, sanitizeFlagNote } from '../practice/PracticeSessions';
import { isPracticeRoomId, parsePracticeOptions, seatLabelZh } from '../practice/types';
import {
  describeKnowledge,
  explainAssassination,
  explainLakeClaim,
  explainLakeTarget,
  explainQuestCard,
  explainTeamProposal,
  explainTeamVote,
  isForwardRoutingActive,
  replayRule,
} from '../ai/explain';
import { ForwardAgent } from '../ai/forward';
import { HeuristicAgent } from '../ai/HeuristicAgent';
import { DEFAULT_AGENT_TUNING } from '../ai/AgentTuning';
import type { PlayerObservation } from '../ai/types';

function makeRoom(ids: string[]): Room {
  const players: Record<string, Player> = {};
  for (const id of ids) {
    players[id] = { id, name: id, role: null, team: null, status: 'active', createdAt: 0 } as Player;
  }
  return {
    id: 'PRACTICE-TEST', name: 't', host: ids[0], state: 'lobby', players, maxPlayers: 10, currentRound: 0,
    maxRounds: 5, votes: {}, questTeam: [], questResults: [], failCount: 0, evilWins: null, leaderIndex: 0,
    voteHistory: [], questHistory: [], questVotedCount: 0,
    roleOptions: { percival: true, morgana: true, oberon: true, mordred: true },
    readyPlayerIds: [], timerConfig: { multiplier: null }, createdAt: 0, updatedAt: 0,
  } as Room;
}

const TEN = ['human', ...Array.from({ length: 9 }, (_, i) => `bot${i + 1}`)];

afterEach(() => vi.restoreAllMocks());

describe('GameEngine practice overrides', () => {
  const ROLES: Role[] = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
  for (const role of ROLES) {
    for (const seat of [1, 4, 10]) {
      it(`forces ${role} at seat ${seat}`, () => {
        const engine = new GameEngine(makeRoom(TEN));
        engine.configurePractice({ playerId: 'human', seatIndex: seat - 1, role, quietEventLog: true });
        engine.startGame();
        const room = engine.getRoom();
        expect(Object.keys(room.players).indexOf('human') + 1).toBe(seat);
        expect(room.players.human.role).toBe(role);
        // Still a legal 10-player deal.
        const dealt = Object.values(room.players).map((p) => p.role).sort();
        expect(dealt).toEqual(['assassin', 'loyal', 'loyal', 'loyal', 'loyal', 'merlin', 'mordred', 'morgana', 'oberon', 'percival']);
        engine.cleanup();
      });
    }
  }

  it('random seat/role when not given; quiet log silences event lines', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const engine = new GameEngine(makeRoom(TEN));
    engine.configurePractice({ playerId: 'human', quietEventLog: true });
    engine.startGame();
    expect(engine.isPractice()).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(engine.getEventLog().length).toBeGreaterThan(0);
    engine.cleanup();
  });

  it('normal rooms are untouched (no overrides, events still logged)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const engine = new GameEngine(makeRoom(TEN));
    engine.startGame();
    expect(engine.isPractice()).toBe(false);
    expect(log).toHaveBeenCalled();
    engine.cleanup();
  });
});

describe('practice options + labels', () => {
  it('parses tolerant options', () => {
    expect(parsePracticeOptions({ seat: 3, role: 'merlin' })).toEqual({ seat: 3, role: 'merlin' });
    expect(parsePracticeOptions({ seat: '10', role: 'oberon' })).toEqual({ seat: 10, role: 'oberon' });
    expect(parsePracticeOptions({ seat: 11, role: 'minion' })).toEqual({ seat: null, role: null });
    expect(parsePracticeOptions(null)).toEqual({ seat: null, role: null });
    expect(isPracticeRoomId('PRACTICE-ABC')).toBe(true);
    expect(isPracticeRoomId('1234')).toBe(false);
    expect(seatLabelZh(10)).toBe('0家');
    expect(seatLabelZh(3)).toBe('3家');
  });
});

describe('PracticeSessions', () => {
  const entry = {
    round: 1, attempt: 1, kind: 'team_vote' as const, botSeat: 2, botRole: 'loyal' as Role, botTeam: 'good' as const,
    action: '贊成', detail: { vote: true }, reason: 'r', source: 'agent' as const,
  };

  it('records, ends once, and rate-limits flags', () => {
    let now = 1_000_000;
    const s = new PracticeSessions(() => now);
    s.create('P1', 'owner', { seat: null, role: null });
    expect(s.record('P1', entry)?.id).toBe(1);
    expect(s.record('P1', entry)?.id).toBe(2);
    expect(s.checkFlag('P1', 1, 'owner')).toMatchObject({ ok: false, error: '對局結束後才能回報' });
    expect(s.markEnded('P1')).toBe(true);
    expect(s.markEnded('P1')).toBe(false);
    expect(s.record('P1', entry)).toBeNull(); // nothing after the end
    expect(s.checkFlag('P1', 1, 'someone-else')).toMatchObject({ ok: false });
    expect(s.checkFlag('P1', 99, 'owner')).toMatchObject({ ok: false, error: '找不到這一步' });
    const ok = s.checkFlag('P1', 1, 'owner');
    expect(ok.ok).toBe(true);
    s.commitFlag('P1', 1);
    expect(s.checkFlag('P1', 1, 'owner')).toMatchObject({ ok: false, error: '這一步已經回報過了' });
    expect(s.checkFlag('P1', 2, 'owner')).toMatchObject({ ok: false });
    now += PRACTICE_LIMITS.minFlagIntervalMs + 1;
    expect(s.checkFlag('P1', 2, 'owner').ok).toBe(true);
    s.commitFlag('P1', 2);
    s.releaseFlag('P1', 2);
    expect(s.flagsLeft('P1')).toBe(PRACTICE_LIMITS.maxFlagsPerRoom - 1);
  });

  it('expires ended and idle rooms', () => {
    let now = 0;
    const s = new PracticeSessions(() => now);
    s.create('ENDED', 'a', { seat: null, role: null });
    s.create('IDLE', 'b', { seat: null, role: null });
    s.create('BUSY', 'c', { seat: null, role: null });
    s.markEnded('ENDED');
    now = PRACTICE_LIMITS.idleTtlMs - 1000;
    s.touch('BUSY');
    expect(s.expired()).toEqual([]);
    now = PRACTICE_LIMITS.idleTtlMs + 1;
    expect(s.expired().sort()).toEqual(['ENDED', 'IDLE']);
    expect(s.findByOwner('c').map((x) => x.roomId)).toEqual(['BUSY']);
  });

  it('sanitizes notes', () => {
    expect(sanitizeFlagNote('  hi\u0000\u0007 there ')).toBe('hi there');
    expect(sanitizeFlagNote(42)).toBe('');
    expect(sanitizeFlagNote('x'.repeat(900))).toHaveLength(PRACTICE_LIMITS.maxNoteChars);
  });
});

// ── explain ────────────────────────────────────────────────────

const IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];

function obs(over: Partial<PlayerObservation>): PlayerObservation {
  return {
    myPlayerId: 's1', myRole: 'loyal', myTeam: 'good', playerCount: 10, allPlayerIds: IDS,
    knownEvils: [], currentRound: 2, currentLeader: 's3', failCount: 0, questResults: ['fail'],
    gamePhase: 'team_vote',
    voteHistory: [{
      round: 1, attempt: 1, leader: 's2', team: ['s2', 's5', 's6'], approved: true,
      votes: Object.fromEntries(IDS.map((id) => [id, ['s2', 's5', 's6', 's8'].includes(id)])),
    }],
    questHistory: [{ round: 1, team: ['s2', 's5', 's6'], result: 'fail', failCount: 1 }],
    proposedTeam: ['s3', 's5', 's7', 's9'],
    lakeHistory: [],
    ...over,
  } as PlayerObservation;
}

describe('explain (read-only reasons)', () => {
  it('describes role knowledge', () => {
    expect(describeKnowledge(obs({ myRole: 'merlin', knownEvils: ['s2', 's10'] }))).toBe('梅林：看到紅方 2、0家（看不到莫德雷德）');
    expect(describeKnowledge(obs({ myRole: 'percival', knownWizards: ['s4', 's9'] }))).toContain('4、9家');
    expect(describeKnowledge(obs({ myRole: 'oberon', myTeam: 'evil' }))).toContain('不認識隊友');
    expect(describeKnowledge(obs({ myRole: 'assassin', myTeam: 'evil', knownEvils: ['s3'] }))).toContain('紅方隊友：3家');
  });

  it('team vote: suspects from the public pyramid, rule from the agent trace', () => {
    const o = obs({});
    const agent = new HeuristicAgent('s1', undefined, undefined, { ...DEFAULT_AGENT_TUNING });
    const ex = explainTeamVote(o, false, agent);
    expect(ex.reason).toMatch(/^反對：自己不在隊上/);
    expect(ex.suspectsLabel).toBe('紅方嫌疑');
    expect(ex.suspects).toHaveLength(3);
    expect(ex.suspects.map((s) => s.seat).some((seat) => [2, 5, 6].includes(seat))).toBe(true);
    // Under vitest HeuristicAgent's lazy forward require fails → baseline path, and the text says so.
    expect(isForwardRoutingActive()).toBe(false);
    expect(ex.rule).toBe('基準策略（HeuristicAgent；前向推理未啟用）');
    // With forward routing (the compiled server), an R2 vote is the R1–R2 delegation.
    expect(replayRule(o, agent, { type: 'team_vote', vote: false }, { forwardActive: true })?.rule)
      .toBe('R1–R2 只投正常票（在隊上贊成、不在隊上反對）');
  });

  it('forward replay reports the pipeline score and flags a mismatching action', () => {
    const o = obs({ myPlayerId: 's3', gamePhase: 'team_select', proposedTeam: [] });
    const agent = new HeuristicAgent('s3', undefined, undefined, { ...DEFAULT_AGENT_TUNING });
    const fa = new ForwardAgent('s3', new HeuristicAgent('s3', undefined, undefined, { ...DEFAULT_AGENT_TUNING }));
    const real = fa.decide(o).action;
    const same = replayRule(o, agent, real, { forwardActive: true });
    expect(same?.rule).toMatch(/^前向推理：評估 \d+ 個選項，取分數最高者/);
    expect(same?.mismatch).toBe(false);
    const other = replayRule(o, agent, { type: 'team_select', teamIds: ['s9', 's8', 's7', 's6'] }, { forwardActive: true });
    expect(other?.mismatch).toBe(true);
    const ex = explainTeamProposal(o, real.type === 'team_select' ? real.teamIds : [], agent);
    expect(ex.reason).toContain('隊上');
  });

  it('quest card, lake and assassination texts', () => {
    expect(explainQuestCard(obs({ gamePhase: 'quest_vote' }), 'success').reason).toMatch(/^好人只能出成功/);
    const red = explainQuestCard(
      obs({ myPlayerId: 's5', myRole: 'morgana', myTeam: 'evil', knownEvils: ['s2'], gamePhase: 'quest_vote', proposedTeam: ['s2', 's5', 's7', 's9'] }),
      'fail',
    );
    expect(red.reason).toContain('出失敗：隊上看得到的紅方 2 人');
    expect(red.reason).toContain('本局需要 1 張失敗');
    expect(red.suspectsLabel).toBe('像梅林');

    const lake = explainLakeTarget(obs({ myPlayerId: 's10' }), 's7', ['s1', 's2', 's7', 's8']);
    expect(lake.reason).toMatch(/^湖 7家：候選 4 人/);
    expect(lake.reason).toContain('還沒出過任務');
    const lie = explainLakeClaim(obs({ myPlayerId: 's2', myRole: 'assassin', myTeam: 'evil', knownEvils: ['s5'] }), 's5', 'evil', 'good');
    expect(lie.reason).toBe('看到 5家 是壞人，宣告好人（說謊）；對象是紅方隊友。');
    expect(explainLakeClaim(obs({}), 's4', 'good', 'good').rule).toBe('好人照實宣告');

    const kill = explainAssassination(
      obs({ myPlayerId: 's2', myRole: 'assassin', myTeam: 'evil', knownEvils: ['s5', 's6'], allEvilIds: ['s2', 's5', 's6', 's8'], gamePhase: 'assassination' }),
      's4',
    );
    expect(kill.reason).toMatch(/^刺 4家：候選 6 人（排除紅方）/);
    expect(kill.suspects.every((s) => ![2, 5, 6, 8].includes(s.seat))).toBe(true);
  });
});
