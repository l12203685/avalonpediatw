/**
 * selfplay_5p_1game.ts — 5p baseline alignment verification (Edward 2026-05-06).
 *
 * Edward 22:19 verbatim:
 *   「你還不如好好跑一局有品質的 讓我假設自己是每個角色 玩一場」
 *   「你先從最基本的五人局開始吧」
 *
 * 5-player config: 3 good (Merlin/Percival/Loyal) + 2 evil (Assassin/Morgana).
 *                   teamSizes R1/R2/R3/R4/R5 = 2/3/2/3/3
 *                   questFailsRequired = 1 across all rounds
 *                   No Mordred / Oberon / Lady of the Lake (5p config has none).
 *                   Difficulty: hard.
 *
 * Outputs:
 *   - /mnt/c/Users/admin/staging/selfplay/qualitative_1game_5p_baseline_v1_2026-05-06.md
 *   - One full game with Edward verbatim format: pure rows, lake events inline.
 *
 * Usage: pnpm --filter @avalon/server exec tsx ../../scripts/selfplay_5p_1game.ts
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import { Role, Room, VoteRecord, QuestRecord } from '@avalon/shared';
import { GameEngine } from '../packages/server/src/game/GameEngine';
import { RoomManager } from '../packages/server/src/game/RoomManager';
import { HeuristicAgent } from '../packages/server/src/ai/HeuristicAgent';
import { AvalonAgent, PlayerObservation } from '../packages/server/src/ai/types';

const PLAYER_COUNT = 5;
const DIFFICULTY: 'hard' = 'hard';

interface CapturedGame {
  roomId: string;
  seats: { seat: number; id: string; role: Role; team: 'good' | 'evil' }[];
  voteHistory: VoteRecord[];
  questHistory: QuestRecord[];
  assassinTargetId?: string;
  assassinTargetRole?: Role;
  winner: 'good' | 'evil';
  endReason?: string;
  rounds: number;
  totalVoteAttempts: number;
  eventCount: number;
}

// 5p convention: seat 1..5 → digit '1'..'5' (no seat 10 wrap-around).
function seatDigit5p(seat: number): string {
  return String(seat);
}
function formatSeatsAsc5p(seats: number[]): string {
  return [...seats].sort((a, b) => a - b).map(seatDigit5p).join('');
}

async function runOneGame(agents: AvalonAgent[]): Promise<CapturedGame> {
  const roomManager = new RoomManager();
  const roomId = `AI5-${uuidv4().slice(0, 8).toUpperCase()}`;
  const hostId = agents[0].agentId;

  const room = roomManager.createRoom(roomId, `AI-${hostId}`, hostId);
  for (const a of agents.slice(1)) {
    room.players[a.agentId] = {
      id: a.agentId,
      name: a.agentId,
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    };
  }

  // 5p has no Mordred / Oberon / lady of the lake — config defaults take precedence.
  room.roleOptions = {
    percival: true,
    morgana: true,
    oberon: false,
    mordred: false,
    ladyOfTheLake: false,
  };

  const engine = new GameEngine(room);
  engine.startGame();

  const roleMap = new Map<string, Role>();
  const teamMap = new Map<string, 'good' | 'evil'>();
  for (const [pid, p] of Object.entries(room.players)) {
    if (p.role) roleMap.set(pid, p.role);
    if (p.team) teamMap.set(pid, p.team as 'good' | 'evil');
  }

  for (const a of agents) {
    const obs = buildObs(a.agentId, room, roleMap, teamMap, [], []);
    a.onGameStart(obs);
  }

  const voteHistory: VoteRecord[] = [];
  const questHistory: QuestRecord[] = [];
  let voteAttempt = 0;

  while (room.state !== 'ended') {
    const leaderId = engine.getCurrentLeaderId();

    if (room.state === 'voting' && room.questTeam.length === 0) {
      const leader = agents.find(a => a.agentId === leaderId)!;
      const obs = buildObs(leader.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      const action = leader.act({ ...obs, gamePhase: 'team_select' });
      if (action.type !== 'team_select') throw new Error('Expected team_select');
      engine.selectQuestTeam(action.teamIds);

      if ((room.state as string) === 'quest') {
        const latest = room.voteHistory[room.voteHistory.length - 1];
        if (latest) voteHistory.push(latest);
        voteAttempt = 0;
      }
    }

    if (room.state === 'voting' && room.questTeam.length > 0) {
      voteAttempt++;
      const votes: Record<string, boolean> = {};
      for (const a of agents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'team_vote' });
        if (action.type !== 'team_vote') throw new Error('Expected team_vote');
        votes[a.agentId] = action.vote;
      }
      for (const [pid, v] of Object.entries(votes)) {
        engine.submitVote(pid, v);
        if ((room.state as string) !== 'voting') break;
      }
      const latest = room.voteHistory[room.voteHistory.length - 1];
      if (latest) voteHistory.push(latest);
      const approved = latest?.approved ?? false;
      if (approved) voteAttempt = 0;
      if ((room.state as string) === 'ended') break;
    }

    if (room.state === 'quest') {
      const teamAgents = agents.filter(a => room.questTeam.includes(a.agentId));
      const preRound = room.currentRound;
      const preTeam = [...room.questTeam];
      let failCount = 0;
      for (const a of teamAgents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'quest_vote' });
        if (action.type !== 'quest_vote') throw new Error('Expected quest_vote');
        if (action.vote === 'fail') failCount++;
        engine.submitQuestVote(a.agentId, action.vote);
        if ((room.state as string) !== 'quest') break;
      }
      const result = room.questResults[preRound - 1] ?? (failCount > 0 ? 'fail' : 'success');
      questHistory.push({ round: preRound, team: preTeam, result: result as 'success' | 'fail', failCount });
      if ((room.state as string) === 'ended') break;
    }

    if (room.state === 'discussion') {
      const assassin = agents.find(a => roleMap.get(a.agentId) === 'assassin');
      if (!assassin) break;
      const obs = buildObs(assassin.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      const action = assassin.act({ ...obs, gamePhase: 'assassination' });
      if (action.type !== 'assassinate') throw new Error('Expected assassinate');
      engine.submitAssassination(assassin.agentId, action.targetId);
      break;
    }
  }

  const evilWins = room.evilWins === true;
  for (const a of agents) {
    const won = evilWins ? teamMap.get(a.agentId) === 'evil' : teamMap.get(a.agentId) === 'good';
    const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
    a.onGameEnd(obs, won);
  }

  const playerIds = Object.keys(room.players);
  const seats = playerIds.map((id, i) => ({
    seat: i + 1,
    id,
    role: roleMap.get(id)!,
    team: teamMap.get(id)!,
  }));

  const assassinTargetRole = room.assassinTargetId ? roleMap.get(room.assassinTargetId) : undefined;
  const events = engine.getEventLog();

  const captured: CapturedGame = {
    roomId,
    seats,
    voteHistory: room.voteHistory,
    questHistory: room.questHistory,
    assassinTargetId: room.assassinTargetId,
    assassinTargetRole,
    winner: evilWins ? 'evil' : 'good',
    endReason: room.endReason,
    rounds: room.currentRound,
    totalVoteAttempts: room.voteHistory.length,
    eventCount: events.length,
  };

  roomManager.deleteRoom(roomId);
  roomManager.destroy();
  return captured;
}

function buildObs(
  playerId: string,
  room: Room,
  roleMap: Map<string, Role>,
  teamMap: Map<string, 'good' | 'evil'>,
  voteHistory: VoteRecord[],
  questHistory: QuestRecord[],
): PlayerObservation {
  const myRole = roleMap.get(playerId) ?? 'loyal';
  const myTeam = teamMap.get(playerId) ?? 'good';
  const knownEvils = getKnownEvils(playerId, myRole, roleMap, teamMap);
  const knownWizards = myRole === 'percival'
    ? Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== playerId)
        .map(([id]) => id)
    : undefined;
  const playerIds = Object.keys(room.players);
  const currentLeader = playerIds[room.leaderIndex % playerIds.length];
  let gamePhase: PlayerObservation['gamePhase'] = 'team_select';
  if (room.state === 'discussion') gamePhase = 'assassination';
  else if (room.state === 'quest') gamePhase = 'quest_vote';
  else if (room.questTeam.length > 0) gamePhase = 'team_vote';

  const allEvilIds = myRole === 'assassin' && gamePhase === 'assassination'
    ? Array.from(teamMap.entries())
        .filter(([, t]) => t === 'evil')
        .map(([id]) => id)
    : undefined;

  return {
    myPlayerId: playerId,
    myRole,
    myTeam,
    playerCount: playerIds.length,
    allPlayerIds: playerIds,
    knownEvils,
    knownWizards,
    allEvilIds,
    currentRound: room.currentRound,
    currentLeader,
    failCount: room.failCount,
    questResults: room.questResults.filter((r): r is 'success' | 'fail' => r !== 'pending'),
    gamePhase,
    voteHistory: [...voteHistory],
    questHistory: [...questHistory],
    proposedTeam: [...room.questTeam],
  };
}

function getKnownEvils(
  pid: string,
  role: Role,
  roleMap: Map<string, Role>,
  teamMap: Map<string, 'good' | 'evil'>,
): string[] {
  switch (role) {
    case 'merlin':
      // 5p: Merlin sees both evil (assassin + morgana). No Mordred in 5p.
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && id !== pid)
        .map(([id]) => id);
    case 'percival':
      return Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== pid)
        .map(([id]) => id);
    case 'assassin':
    case 'morgana':
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && id !== pid)
        .map(([id]) => id);
    default:
      return [];
  }
}

// 5-role short codes for 5p (no oberon/mordred).
function roleCode5p(role: Role): string {
  const map: Record<string, string> = {
    assassin: '刺',
    morgana:  '娜',
    percival: '派',
    merlin:   '梅',
    loyal:    '忠',
  };
  return map[role] ?? String(role);
}

function translateEndReason(reason?: string): string {
  if (!reason) return '—';
  const map: Record<string, string> = {
    failed_quests:         '壞人贏 3 輪任務',
    vote_rejections:       '連續 5 次否決 → 壞人勝',
    merlin_assassinated:   '梅林被刺 → 壞人勝',
    assassination_failed:  '刺殺失手 → 好人勝',
    assassination_timeout: '刺殺超時 → 好人勝',
    host_cancelled:        '房主取消',
  };
  return map[reason] ?? reason;
}

function seatOf(game: CapturedGame, playerId: string): number {
  return game.seats.find(s => s.id === playerId)?.seat ?? -1;
}

// Edward verbatim format: pure rows, no headers, lake events inline,
// 5-char role config (no header table), assassination line.
function renderEdwardFormat(game: CapturedGame, completionTs: string): string {
  const lines: string[] = [];

  // Header
  lines.push(`# 5人版 Avalon Self-Play (5p baseline v1)`);
  lines.push(`# 完成於 ${completionTs}`);
  lines.push(`# 5-player config: 3 good (Merlin/Percival/Loyal) + 2 evil (Assassin/Morgana)`);
  lines.push(`# team sizes R1/R2/R3/R4/R5 = 2/3/2/3/3; 1 fail required all rounds`);
  lines.push(`# No Mordred / No Oberon / No Lady of the Lake (5p)`);
  lines.push(`# Difficulty: ${DIFFICULTY}`);
  lines.push(``);

  // Pure牌譜 (Edward format)
  lines.push(`## 牌譜 (純格式 — 一行一 row)`);
  lines.push(`=== Game 1 === room=${game.roomId} winner=${game.winner === 'good' ? '藍方(好人)' : '紅方(壞人)'}`);
  lines.push(``);

  // Group votes by round
  const sortedSeats = [...game.seats].sort((a, b) => a.seat - b.seat);
  const codeStr = sortedSeats.map(s => roleCode5p(s.role)).join(''); // 5-char

  // Per-round emission
  const voteByRound = new Map<number, VoteRecord[]>();
  for (const v of game.voteHistory) {
    const arr = voteByRound.get(v.round) ?? [];
    arr.push(v);
    voteByRound.set(v.round, arr);
  }
  const questByRound = new Map<number, QuestRecord>();
  for (const q of game.questHistory) {
    questByRound.set(q.round, q);
  }

  for (let r = 1; r <= game.rounds; r++) {
    const votes = voteByRound.get(r) ?? [];
    for (const v of votes) {
      const teamSeats = v.team.map(id => seatOf(game, id));
      const teamStr = formatSeatsAsc5p(teamSeats);
      // Anomaly tracking: outer-white = off-team approve, inner-black = on-team reject.
      const teamSet = new Set(v.team);
      const outerWhite: number[] = [];
      const innerBlack: number[] = [];
      for (const [pid, vote] of Object.entries(v.votes)) {
        const onTeam = teamSet.has(pid);
        const seat = seatOf(game, pid);
        if (vote === true && !onTeam) outerWhite.push(seat);
        if (vote === false && onTeam) innerBlack.push(seat);
      }
      let row = teamStr;
      if (outerWhite.length > 0) row += ` ${formatSeatsAsc5p(outerWhite)}+`;
      if (innerBlack.length > 0) row += ` ${formatSeatsAsc5p(innerBlack)}-`;
      lines.push(row);
    }
    // Quest result: ooo / oox / etc., based on team size.
    const q = questByRound.get(r);
    if (q) {
      const teamSize = q.team.length;
      const failCount = q.failCount;
      // o = success bullet, x = fail bullet
      const successBullets = teamSize - failCount;
      const result = 'o'.repeat(successBullets) + 'x'.repeat(failCount);
      lines.push(result);
    }
    lines.push(``);
  }

  // Assassination line — empty if good 3-quest win without assassination chance.
  let assassinSeat = '';
  if (game.assassinTargetId) {
    const seat = seatOf(game, game.assassinTargetId);
    assassinSeat = String(seat);
  }
  lines.push(`刺殺: ${assassinSeat}`);
  lines.push(`配置: ${codeStr}`);
  lines.push(`---`);
  lines.push(``);

  return lines.join('\n');
}

async function main(): Promise<void> {
  const agents: AvalonAgent[] = [];
  for (let i = 1; i <= PLAYER_COUNT; i++) {
    agents.push(new HeuristicAgent(`p${i}`, DIFFICULTY));
  }

  // Persist OFF — we don't want to write to Supabase on every test run.
  const game = await runOneGame(agents);

  const completionTs = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).replace('T', ' ') + ' +08';

  const md = renderEdwardFormat(game, completionTs);
  const outputPath = '/mnt/c/Users/admin/staging/selfplay/qualitative_1game_5p_baseline_v1_2026-05-06.md';
  fs.writeFileSync(outputPath, md, 'utf-8');

  // Also dump the seats for use by perspective files.
  const seatsPath = '/mnt/c/Users/admin/staging/selfplay/qualitative_1game_5p_baseline_v1_2026-05-06.seats.json';
  fs.writeFileSync(seatsPath, JSON.stringify({
    seats: game.seats,
    voteHistory: game.voteHistory,
    questHistory: game.questHistory,
    winner: game.winner,
    endReason: game.endReason,
    rounds: game.rounds,
    assassinTargetId: game.assassinTargetId,
    assassinTargetRole: game.assassinTargetRole,
  }, null, 2), 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`5p game written: ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(`Seats JSON: ${seatsPath}`);
  // eslint-disable-next-line no-console
  console.log(`Winner: ${game.winner === 'good' ? '藍方(好人)' : '紅方(壞人)'}, rounds: ${game.rounds}, endReason: ${game.endReason}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
