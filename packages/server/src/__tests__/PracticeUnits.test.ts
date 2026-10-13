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

  it('caps rooms server-wide and evicts the review that ended first', () => {
    let now = 0;
    const s = new PracticeSessions(() => now);
    for (let i = 0; i < PRACTICE_LIMITS.maxConcurrentRooms; i++) {
      now += 1;
      s.create(`R${i}`, `u${i}`, { seat: null, role: null }, [`b${i}`]);
    }
    expect(s.isFull()).toBe(true);
    expect(s.oldestEnded()).toBeUndefined(); // all still playing → refuse
    now += 1; s.markEnded('R7');
    now += 1; s.markEnded('R3');
    expect(s.oldestEnded()).toBe('R7');
    expect(s.get('R7')?.botIds).toEqual(['b7']);
    s.delete('R7');
    expect(s.isFull()).toBe(false);
    expect(s.roomIds()).toHaveLength(PRACTICE_LIMITS.maxConcurrentRooms - 1);
  });

  it('caps flags per hour server-wide and per player per day', () => {
    let now = 10_000_000;
    const s = new PracticeSessions(() => now);
    const fill = (roomId: string, owner: string): void => {
      s.create(roomId, owner, { seat: null, role: null });
      for (let i = 0; i < PRACTICE_LIMITS.maxFlagsPerRoom; i++) s.record(roomId, entry);
      s.markEnded(roomId);
    };
    /** Flag every step of `roomId` until refused; returns the refusal. */
    const flagAll = (roomId: string, owner: string): string | undefined => {
      for (let id = 1; id <= PRACTICE_LIMITS.maxFlagsPerRoom; id++) {
        now += PRACTICE_LIMITS.minFlagIntervalMs + 1;
        const c = s.checkFlag(roomId, id, owner);
        if (!c.ok) return c.error;
        s.commitFlag(roomId, id);
      }
      return undefined;
    };
    // Server-wide hourly cap, reached by several players.
    let refusal: string | undefined;
    for (let r = 0; r < 5 && !refusal; r++) {
      fill(`H${r}`, `player${r}`);
      refusal = flagAll(`H${r}`, `player${r}`);
    }
    expect(refusal).toMatch(/這一小時的回報已達上限/);
    // An hour later the hourly window has room again.
    now += 60 * 60 * 1000;
    fill('H-next', 'player-next');
    expect(s.checkFlag('H-next', 1, 'player-next').ok).toBe(true);

    // Per-player daily cap: one player, many rooms, flagging just under the hourly cap.
    const u = new PracticeSessions(() => now);
    let refusedDaily: string | undefined;
    for (let r = 0; r < 10 && !refusedDaily; r++) {
      u.create(`E${r}`, 'heavy', { seat: null, role: null });
      for (let i = 0; i < PRACTICE_LIMITS.maxFlagsPerRoom; i++) u.record(`E${r}`, entry);
      u.markEnded(`E${r}`);
      for (let id = 1; id <= PRACTICE_LIMITS.maxFlagsPerRoom; id++) {
        now += 37 * 1000; // ~97 per hour: just under the hourly cap
        const c = u.checkFlag(`E${r}`, id, 'heavy');
        if (!c.ok) { refusedDaily = c.error; break; }
        u.commitFlag(`E${r}`, id);
      }
    }
    expect(refusedDaily).toBe(`每人每天最多回報 ${PRACTICE_LIMITS.maxFlagsPerUserPerDay} 步`);
    // A failed write gives the quota back.
    const v = new PracticeSessions(() => now);
    v.create('F', 'f', { seat: null, role: null });
    v.record('F', entry);
    v.markEnded('F');
    expect(v.checkFlag('F', 1, 'f').ok).toBe(true);
    v.commitFlag('F', 1);
    v.releaseFlag('F', 1);
    now += PRACTICE_LIMITS.minFlagIntervalMs + 1;
    expect(v.checkFlag('F', 1, 'f').ok).toBe(true);
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

  it('ties are not shown as a ranking; Oberon gets the public view', () => {
    // Round 1, no history: every pyramid score is the 0.50 prior.
    const fresh = obs({ currentRound: 1, questResults: [], voteHistory: [], questHistory: [], gamePhase: 'team_select', proposedTeam: [] });
    const prop = explainTeamProposal(fresh, ['s1', 's2', 's3']);
    expect(prop.suspects).toEqual([]);
    expect(prop.suspectsNote).toBe('尚無區分（全員 0.50）');
    expect(prop.reason).toContain('隊上最可疑：尚無區分（全員 0.50）');
    expect(prop.reason).not.toMatch(/2家 0\.50、3家 0\.50/);

    const oberon = { myRole: 'oberon', myTeam: 'evil', knownEvils: [] } as Partial<PlayerObservation>;
    const vote = explainTeamVote(obs({ ...oberon }), true);
    expect(vote.reason).toContain('奧伯倫不認識隊友，只能看公開紀錄');
    expect(vote.reason).toMatch(/隊上最可疑 \d家 \d\.\d\d/);
    expect(vote.suspectsLabel).toBe('紅方嫌疑（公開紀錄）');
    expect(vote.suspects.length).toBe(3);
    const lake = explainLakeTarget(obs({ ...oberon, currentRound: 1, questResults: [], voteHistory: [], questHistory: [] }), 's4', IDS.slice(1));
    expect(lake.reason).toContain('金字塔紅方嫌疑：尚無區分（全員 0.50）');
    expect(lake.reason).not.toContain('像梅林');

    // Partial ties: the list stays, with a note that seat order broke the tie.
    // Here seats 5 and 6 (both on the failed R1 team) tie for third place.
    const failed = explainTeamVote(obs({}), false);
    expect(failed.suspects.map((x) => x.seat)).toEqual([2, 8, 5]);
    expect(failed.suspectsNote).toBe('另有 1 人同為 0.65，依座位順序只列前 3 位');

    // Red bot, no history: every Merlin-likeness ties too.
    const red = explainLakeTarget(obs({ myPlayerId: 's2', myRole: 'assassin', myTeam: 'evil', knownEvils: ['s5'], currentRound: 1, questResults: [], voteHistory: [], questHistory: [] }), 's4', IDS);
    expect(red.reason).toContain('像梅林分數：尚無區分');
    expect(red.suspects).toEqual([]);
  });

  it('quest card, lake and assassination texts', () => {
    const good = explainQuestCard(obs({ gamePhase: 'quest_vote' }), 'success');
    expect(good.reason).toMatch(/^好人只能出成功/);
    expect(good.rule).toBe('好人只能出成功'); // the review adds the「規則：」label itself
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
