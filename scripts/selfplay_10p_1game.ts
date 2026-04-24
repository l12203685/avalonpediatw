/**
 * selfplay_10p_1game.ts — batch 3 verification run
 *
 * Edward 2026-04-24 batch 3 origin:
 *   - 批 2 兩場自對弈找到 5 個 bug (logic + display)
 *   - 修完後重跑 1 場新自對弈驗證
 *
 * Differences vs selfplay_10p_5games.ts:
 *   - 1 場（非 5 場）
 *   - 全新 TSV（tab-separated）Sheets 格式
 *   - 省掉「1 德｜2 忠｜3 派 ...」對照行（角色碼 6 位已足）
 *   - 團隊座位、異常票座位升序 1,2,3,4,5,6,7,8,9,0（0 = 第 10 座位排最後）
 *   - 強制局（R=5 第 5 次提案）不列異常票（邏輯上不可能有）
 *
 * 執行：pnpm --filter @avalon/server exec tsx ../../scripts/selfplay_10p_1game.ts
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { Role, Room, VoteRecord, QuestRecord, LadyOfTheLakeRecord } from '@avalon/shared';
import { GameEngine } from '../packages/server/src/game/GameEngine';
import { RoomManager } from '../packages/server/src/game/RoomManager';
import { HeuristicAgent } from '../packages/server/src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../packages/server/src/ai/SelfPlayEngine';
import { AvalonAgent, PlayerObservation } from '../packages/server/src/ai/types';

const PLAYER_COUNT = 10;
const DIFFICULTY: 'hard' = 'hard';

interface CapturedGame {
  gameIndex: number;
  roomId: string;
  seats: { seat: number; id: string; role: Role; team: 'good' | 'evil' }[];
  voteHistory: VoteRecord[];
  questHistory: QuestRecord[];
  ladyOfTheLakeHistory: LadyOfTheLakeRecord[];
  assassinTargetId?: string;
  assassinTargetRole?: Role;
  winner: 'good' | 'evil';
  endReason?: string;
  rounds: number;
  totalVoteAttempts: number;
  eventCount: number;
}

// ── Ascending sort helper (1-9,0 convention) ──────────────────
// Edward 2026-04-24 batch 3 fix #6: seat 10 displays as "0" and
// sorts AFTER 9 (convention: 1,2,3,4,5,6,7,8,9,0). Key function
// maps seat -> sort index where 0 → 10.
function seatSortKey(seatDigit: number): number {
  return seatDigit === 0 ? 10 : seatDigit;
}

/** Seat display digit: seat 10 → '0', else the digit itself. */
function seatDigit(seat: number): string {
  return seat === 10 ? '0' : String(seat);
}

/** Format a list of seats as an ascending-sorted digit string.
 *  Example: [4,5,8,10] → "4580". */
function formatSeatsAsc(seats: number[]): string {
  return [...seats]
    .sort((a, b) => seatSortKey(a) - seatSortKey(b))
    .map(seatDigit)
    .join('');
}

// ── Run one game ──────────────────────────────────────────────

async function runOneGame(
  gameIndex: number,
  agents: AvalonAgent[],
): Promise<CapturedGame> {
  const roomManager = new RoomManager();
  const roomId = `AI-${uuidv4().slice(0, 8).toUpperCase()}`;
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

  room.roleOptions = {
    ...(room.roleOptions ?? { percival: true, morgana: true, oberon: true, mordred: true }),
    ladyOfTheLake: true,
    ladyStart: 'seat1',
  };

  const engine = new GameEngine(room);
  engine.startGame();

  const lakePicker = new SelfPlayEngine();

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

    if (room.state === 'lady_of_the_lake') {
      const holderId = room.ladyOfTheLakeHolder!;
      const used = new Set(room.ladyOfTheLakeUsed ?? []);
      const validTargets = Object.keys(room.players).filter(id => id !== holderId && !used.has(id));
      if (validTargets.length > 0) {
        const holderTeam = teamMap.get(holderId);
        const holderObs = buildObs(holderId, room, roleMap, teamMap, voteHistory, questHistory);
        const targetId = lakePicker.pickLadyTarget(holderTeam, holderObs, validTargets);
        engine.submitLadyOfTheLakeTarget(holderId, targetId);
        const actualTeam = teamMap.get(targetId);
        const claim = lakePicker.decideLakeAnnouncement(holderTeam, targetId, holderObs, actualTeam);
        if (claim !== null) {
          try {
            engine.declareLakeResult(holderId, claim);
          } catch {
            /* declaration best-effort */
          }
        }
        engine.completeLadyPhase();
      } else {
        engine.completeLadyPhase();
      }
      if ((room.state as string) === 'ended') break;
      continue;
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
    const won = evilWins
      ? teamMap.get(a.agentId) === 'evil'
      : teamMap.get(a.agentId) === 'good';
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
    gameIndex,
    roomId,
    seats,
    voteHistory: room.voteHistory,
    questHistory: room.questHistory,
    ladyOfTheLakeHistory: room.ladyOfTheLakeHistory ?? [],
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

  // Edward 2026-04-24 batch 3 fix #1: inject full evil roster for
  // assassin hard-filter (Oberon/Mordred hidden from knownEvils).
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
      return Array.from(teamMap.entries())
        .filter(([id, t]) =>
          t === 'evil' && id !== pid && roleMap.get(id) !== 'oberon' && roleMap.get(id) !== 'mordred',
        )
        .map(([id]) => id);
    case 'percival':
      return Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== pid)
        .map(([id]) => id);
    case 'assassin':
    case 'morgana':
    case 'mordred':
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && roleMap.get(id) !== 'oberon' && id !== pid)
        .map(([id]) => id);
    default:
      return [];
  }
}

// ── TSV (Google Sheet-style) report ─────────────────────────────

/** Role → single-char code (6-role schema). */
function roleCode(role: Role): string {
  const map: Record<string, string> = {
    merlin:   '德',
    loyal:    '忠',
    percival: '派',
    morgana:  '娜',
    assassin: '刺',
    mordred:  '梅',  // Edward batch 2: 梅=Mordred (not Merlin) per 6-code scheme
    oberon:   '奧',
  };
  return map[role] ?? role;
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

function translateRole(role: Role): string {
  const map: Record<string, string> = {
    merlin:  '梅林',
    percival: '派西維爾',
    loyal:   '忠臣',
    assassin: '刺客',
    morgana:  '摩甘娜',
    mordred:  '莫德雷德',
    oberon:   '奧伯倫',
    minion:   '爪牙',
  };
  return map[role] ?? role;
}

function seatOf(game: CapturedGame, playerId: string): number {
  return game.seats.find(s => s.id === playerId)?.seat ?? -1;
}

/**
 * Edward 2026-04-24 batch 3 Sheets TSV output.
 *
 * Conventions:
 *   - tab-separated (paste-ready for Google Sheets)
 *   - 角色碼 6 位 (seats 1..10 in order) — 省對照行
 *   - 座位升序 1,2,3,4,5,6,7,8,9,0 (0 = seat 10 last)
 *   - 強制局 (attempt === 5) 不列異常票（邏輯強制 everyone approve）
 *   - 每輪一段：R# | 提案1 | 提案2 | ... | 任務結果 | 湖 (若有)
 */
function renderTSV(game: CapturedGame, completionTs: string): string {
  const lines: string[] = [];

  // Header block
  lines.push(`強 AI 10 人自對弈 (批 3 驗證) — 完成於 ${completionTs}`);
  lines.push(`房號\t${game.roomId}\t勝方\t${game.winner === 'good' ? '藍方' : '紅方'}\t勝因\t${translateEndReason(game.endReason)}`);
  lines.push('');

  // 角色碼 6 位 (seats 1..10 ordered by seat number)
  const sortedSeats = [...game.seats].sort((a, b) => a.seat - b.seat);
  const codeStr = sortedSeats.map(s => roleCode(s.role)).join('');
  lines.push(`角色碼 (座1→10)\t${codeStr}`);
  lines.push('');

  // Summary row (canonical Sheets layout)
  // 5 round slots: Rx: team (ascending seats) | success/fail | failCount
  const roundLookup = new Map<number, QuestRecord>();
  for (const q of game.questHistory) roundLookup.set(q.round, q);

  lines.push('── 回合摘要 ──');
  lines.push(['輪', '隊伍', '人數', '結果', 'fail 數'].join('\t'));
  for (let r = 1; r <= 5; r++) {
    const q = roundLookup.get(r);
    if (!q) {
      lines.push([`R${r}`, '—', '—', '—', '—'].join('\t'));
      continue;
    }
    const teamSeats = q.team.map(id => seatOf(game, id));
    const teamStr = formatSeatsAsc(teamSeats);
    const resultStr = q.result === 'success' ? '白' : '黑';
    lines.push([`R${r}`, teamStr, String(q.team.length), resultStr, String(q.failCount)].join('\t'));
  }
  lines.push('');

  // Per-round detail (proposals, votes, anomalies, quest, lake)
  for (let r = 1; r <= game.rounds; r++) {
    const votesThisRound = game.voteHistory.filter(v => v.round === r);
    const quest = roundLookup.get(r);
    lines.push(`── R${r} ──`);
    lines.push(['提案', '隊長座', '隊伍', '結果', '同意', '反對', '異常票'].join('\t'));

    for (const v of votesThisRound) {
      const leaderSeat = seatOf(game, v.leader);
      const teamSeats = v.team.map(id => seatOf(game, id));
      const teamStr = formatSeatsAsc(teamSeats);

      const approverSeats: number[] = [];
      const rejecterSeats: number[] = [];
      for (const [pid, approved] of Object.entries(v.votes)) {
        const s = seatOf(game, pid);
        if (approved) approverSeats.push(s);
        else rejecterSeats.push(s);
      }
      const approvesStr = formatSeatsAsc(approverSeats);
      const rejectsStr = formatSeatsAsc(rejecterSeats);

      // Edward batch 3 fix #3: forced mission (attempt === 5) 不列異常票。
      // 邏輯上強制局 everyone approve → 異常票欄永遠空。
      let anomalyStr = '';
      if (v.attempt < 5) {
        const teamSet = new Set(teamSeats);
        const innerBlackSeats = rejecterSeats.filter(s => teamSet.has(s));
        const outerWhiteSeats = approverSeats.filter(s => !teamSet.has(s));
        const parts: string[] = [];
        if (innerBlackSeats.length > 0) parts.push(`${formatSeatsAsc(innerBlackSeats)}-`);
        if (outerWhiteSeats.length > 0) parts.push(`${formatSeatsAsc(outerWhiteSeats)}+`);
        anomalyStr = parts.join(' ');
      }

      const resultStr = v.approved ? '通過' : '否決';
      lines.push([
        String(v.attempt),
        seatDigit(leaderSeat),
        teamStr,
        resultStr,
        approvesStr,
        rejectsStr,
        anomalyStr,
      ].join('\t'));
    }

    if (quest) {
      const teamSeats = quest.team.map(id => seatOf(game, id));
      const teamStr = formatSeatsAsc(teamSeats);
      const resultStr = quest.result === 'success' ? '✅ 成功' : '❌ 失敗';
      lines.push([
        '任務',
        '—',
        teamStr,
        resultStr,
        '—',
        '—',
        `${quest.failCount} 張 fail`,
      ].join('\t'));
    }

    const lakeThisRound = game.ladyOfTheLakeHistory.filter(l => l.round === r);
    for (const l of lakeThisRound) {
      const holder = seatOf(game, l.holderId);
      const target = seatOf(game, l.targetId);
      const truth = l.result === 'good' ? '好人' : '壞人';
      const claim = l.declaredClaim ? (l.declaredClaim === 'good' ? '宣告好人' : '宣告壞人') : '未宣告';
      lines.push(['湖', seatDigit(holder), seatDigit(target), truth, claim, '—', '—'].join('\t'));
    }
    lines.push('');
  }

  if (game.assassinTargetId) {
    const seat = seatOf(game, game.assassinTargetId);
    const role = game.assassinTargetRole ? translateRole(game.assassinTargetRole) : '?';
    const hitMerlin = game.assassinTargetRole === 'merlin';
    lines.push('── 刺殺 ──');
    lines.push(['鎖定座', '實際角色', '結果'].join('\t'));
    lines.push([
      seatDigit(seat),
      role,
      hitMerlin ? '命中梅林，紅方逆轉勝' : '未命中，藍方守下勝利',
    ].join('\t'));
    lines.push('');
  }

  lines.push(`事件數\t${game.eventCount}\t總提案輪次\t${game.totalVoteAttempts}\t湖次數\t${game.ladyOfTheLakeHistory.length}`);
  lines.push('');

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────

async function main() {
  process.env.SELFPLAY_ENABLED = 'false';

  const outDir = path.resolve(__dirname, '../staging/selfplay');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const agents: AvalonAgent[] = Array.from(
    { length: PLAYER_COUNT },
    (_, j) => new HeuristicAgent(`H-${String(j + 1).padStart(2, '0')}`, DIFFICULTY),
  );
  const t0 = Date.now();
  const g = await runOneGame(1, agents);
  const dt = Date.now() - t0;
  console.log(
    `[game 1] winner=${g.winner} rounds=${g.rounds} lakes=${g.ladyOfTheLakeHistory.length} ` +
    `assassin→${g.assassinTargetRole ?? '—'} endReason=${g.endReason ?? '—'} (${dt}ms)`,
  );

  const now = new Date();
  const ts =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} +08`;

  const date = ts.slice(0, 10);
  const jsonPath = path.join(outDir, `selfplay_10p_1game_post_batch3_${date}.json`);
  const mdPath   = path.join(outDir, `selfplay_10p_1game_post_batch3_${date}.md`);

  const tsvReport = renderTSV(g, ts);
  fs.writeFileSync(jsonPath, JSON.stringify(g, null, 2), 'utf8');
  fs.writeFileSync(mdPath, tsvReport, 'utf8');
  console.log(`\n[wrote] ${jsonPath}`);
  console.log(`[wrote] ${mdPath}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
