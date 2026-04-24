/**
 * selfplay_10p_5games.ts — one-off standalone script
 *
 * 跑 5 場 10 人局，全員 HeuristicAgent(difficulty='hard')（expert tier prior）。
 * 捕獲完整 room 終局快照（含 role/vote/quest/lake/assassin 全部）並輸出
 * JSON + markdown 報告到 staging/selfplay/。
 *
 * 原地址：scripts/selfplay_10p_5games.ts
 * 執行：pnpm --filter @avalon/server exec tsx ../../scripts/selfplay_10p_5games.ts
 *
 * 2026-04-24 Edward 原話：
 *   > 你可以先跑個強AI自對弈10人局 跑個5場的遊戲紀錄出來給我看嗎
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

// ── 設定 ────────────────────────────────────────────────────────
const PLAYER_COUNT = 10;
const GAME_COUNT   = 5;
const DIFFICULTY: 'hard' = 'hard'; // expert tier prior (top 10 win-rate pool)

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

// ── 遊戲循環（抄自 SelfPlayEngine 但保留 room 供 export）────────
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

  // Edward 2026-04-24 selfplay review fix #2: pin the Lady of the Lake
  // starting holder to the first player (deterministic). `seat1` maps to
  // playerIds[0] in the engine's `resolveLadyStartIndex`.
  room.roleOptions = {
    ...(room.roleOptions ?? { percival: true, morgana: true, oberon: true, mordred: true }),
    ladyOfTheLake: true,
    ladyStart: 'seat1',
  };

  const engine = new GameEngine(room);
  engine.startGame();

  // Edward 2026-04-24 selfplay review fix #3: reuse SelfPlayEngine's
  // smart Lady target selection (filters known evils for good holders,
  // picks most Merlin-like opponent) instead of the naive
  // `validTargets[0]` behaviour that let Merlin lake known evils.
  const lakePicker = new SelfPlayEngine();

  const roleMap = new Map<string, Role>();
  const teamMap = new Map<string, 'good' | 'evil'>();
  for (const [pid, p] of Object.entries(room.players)) {
    if (p.role) roleMap.set(pid, p.role);
    if (p.team) teamMap.set(pid, p.team as 'good' | 'evil');
  }

  // Notify agents of assignments
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
        // Edward 2026-04-24 selfplay review fix #3: reuse SelfPlayEngine's
        // `pickLadyTarget` so Merlin (good holder) no longer lakes a
        // known-evil opponent (wasted lake). Evil holders stay on the
        // smart branch (bring-friend / most Merlin-like opponent).
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
            /* declaration is best-effort — swallow engine guard rejections */
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

  // Notify agents
  const evilWins = room.evilWins === true;
  for (const a of agents) {
    const won = evilWins
      ? teamMap.get(a.agentId) === 'evil'
      : teamMap.get(a.agentId) === 'good';
    const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
    a.onGameEnd(obs, won);
  }

  // Build captured snapshot
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

// ── buildObs (抄自 SelfPlayEngine) ─────────────────────────────
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
  const playerIds = Object.keys(room.players);
  const currentLeader = playerIds[room.leaderIndex % playerIds.length];
  let gamePhase: PlayerObservation['gamePhase'] = 'team_select';
  if (room.state === 'discussion') gamePhase = 'assassination';
  else if (room.state === 'quest') gamePhase = 'quest_vote';
  else if (room.questTeam.length > 0) gamePhase = 'team_vote';

  return {
    myPlayerId: playerId,
    myRole,
    myTeam,
    playerCount: playerIds.length,
    allPlayerIds: playerIds,
    knownEvils,
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

// ── 報告生成 ────────────────────────────────────────────────────
function renderMarkdown(games: CapturedGame[]): string {
  const now = new Date();
  const ts =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} +08`;

  const lines: string[] = [];
  lines.push(`# 強 AI 10 人自對弈 5 場紀錄 — ${ts}`);
  lines.push('');
  lines.push(`## 基本資訊`);
  lines.push(`- 完成時間：${ts}`);
  lines.push(`- AI 難度：\`hard\`（expert tier — top 10 win-rate prior pool）`);
  lines.push(`- 人數：${PLAYER_COUNT} 人`);
  lines.push(`- 場數：${GAME_COUNT} 場`);
  lines.push(`- 角色配置（canonical 10p）：merlin + percival + 4× loyal + assassin + morgana + mordred + oberon`);
  lines.push(`- 湖中女神：啟用（≥7 人自動開啟）`);
  lines.push('');
  lines.push('## 5 場概要');
  lines.push('| 場次 | 勝方 | 勝因 | 5 回合結果 | 湖次數 | 總提案輪次 | 刺客目標 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const g of games) {
    // Edward 2026-04-24 selfplay review fix #4: always iterate all 5 mission
    // slots so unused rounds (game ended via assassination or 3-fail) render
    // as "R?—" instead of silently truncating the row. Makes "5 回合結果"
    // label literal.
    const roundLookup = new Map<number, QuestRecord>();
    for (const q of g.questHistory) roundLookup.set(q.round, q);
    const roundSlots: string[] = [];
    for (let r = 1; r <= 5; r += 1) {
      const q = roundLookup.get(r);
      if (q) {
        const teamSize = q.team.length;
        roundSlots.push(`R${r}${q.result === 'success' ? '白' : '黑'}(${q.failCount}f/${teamSize}人)`);
      } else {
        roundSlots.push(`R${r}—`);
      }
    }
    const roundResults = roundSlots.join(' ');
    const targetRole = g.assassinTargetRole ? ` [${translateRole(g.assassinTargetRole)}]` : '';
    const target = g.assassinTargetId ? `座${seatOf(g, g.assassinTargetId)}${targetRole}` : '—';
    lines.push(
      `| ${g.gameIndex} | ${g.winner === 'good' ? '藍方' : '紅方'} | ${translateEndReason(g.endReason)} | ${roundResults} | ${g.ladyOfTheLakeHistory.length} | ${g.totalVoteAttempts} | ${target} |`,
    );
  }
  lines.push('');

  for (const g of games) {
    lines.push(`## 場 ${g.gameIndex} 詳細（${g.roomId}）`);
    lines.push('');
    lines.push(`### 座位 & 角色`);
    lines.push('| 座 | ID | 角色 | 陣營 |');
    lines.push('|---|---|---|---|');
    for (const s of g.seats) {
      lines.push(`| ${s.seat} | ${s.id} | ${translateRole(s.role)} | ${s.team === 'good' ? '藍' : '紅'} |`);
    }
    lines.push('');

    lines.push(`### 回合 & 湖`);
    const questRounds = new Map<number, QuestRecord>();
    for (const q of g.questHistory) questRounds.set(q.round, q);

    // per-round votes
    for (let r = 1; r <= g.rounds; r++) {
      const votesThisRound = g.voteHistory.filter(v => v.round === r);
      const quest = questRounds.get(r);
      lines.push(`#### R${r}`);
      if (votesThisRound.length === 0) {
        lines.push(`- （無紀錄）`);
      } else {
        for (const v of votesThisRound) {
          const leaderSeat = seatOf(g, v.leader);
          const teamSeats = v.team.map(id => seatOf(g, id)).join(',');
          const approves = Object.entries(v.votes).filter(([, a]) => a).map(([id]) => seatOf(g, id)).sort((a, b) => a - b);
          const rejects  = Object.entries(v.votes).filter(([, a]) => !a).map(([id]) => seatOf(g, id)).sort((a, b) => a - b);
          // Edward 2026-04-24 selfplay review fix #5: compact anomaly-vote
          // inline tag per proposal — `{inner-black}- {outer-white}+`
          //   inner-black = on-team rejectors  (seat rejects own team)
          //   outer-white = off-team approvers (seat approves w/o skin in game)
          // Sample: `345- 12+` (seats 3,4,5 inner-black · seats 1,2 outer-white).
          // Omit side if empty; omit whole tag if both empty.
          const teamSet = new Set(v.team.map(id => seatOf(g, id)));
          const innerBlack = rejects.filter(s => teamSet.has(s));
          const outerWhite = approves.filter(s => !teamSet.has(s));
          const anomalyParts: string[] = [];
          if (innerBlack.length > 0) anomalyParts.push(`${innerBlack.join('')}-`);
          if (outerWhite.length > 0) anomalyParts.push(`${outerWhite.join('')}+`);
          const anomalyTag = anomalyParts.length > 0 ? `｜異常票 ${anomalyParts.join(' ')}` : '';
          lines.push(
            `- 提案 ${v.attempt}：領袖座${leaderSeat} 提隊[${teamSeats}] → ${v.approved ? '通過' : '否決'}（同意座[${approves.join(',')}] / 反對座[${rejects.join(',')}]）${anomalyTag}`,
          );
        }
      }
      if (quest) {
        const teamSeats = quest.team.map(id => seatOf(g, id)).join(',');
        const teamSize = quest.team.length;
        // Edward 2026-04-24 selfplay review fix #4: explicit team size
        // counter (`N人`) so Edward can visually confirm each round's quest
        // team size (e.g. R4 in 10p must be 5 人).
        lines.push(
          `- 任務結果：隊伍[${teamSeats}]（${teamSize}人）→ ${quest.result === 'success' ? '✅ 成功' : '❌ 失敗'}（${quest.failCount} 張 fail）`,
        );
      }
      // lake that happens after round r (between r and r+1)
      const lakeThisRound = g.ladyOfTheLakeHistory.filter(l => l.round === r);
      for (const l of lakeThisRound) {
        const holder = seatOf(g, l.holderId);
        const target = seatOf(g, l.targetId);
        const claim = l.declaredClaim ? `宣告 ${l.declaredClaim === 'good' ? '好人' : '壞人'}` : '未宣告';
        lines.push(`- 🌊 湖：持有者座${holder} 湖 座${target}（真實：${l.result === 'good' ? '好人' : '壞人'}，${claim}）`);
      }
      lines.push('');
    }

    if (g.assassinTargetId) {
      const seat = seatOf(g, g.assassinTargetId);
      const role = g.assassinTargetRole ? translateRole(g.assassinTargetRole) : '?';
      const hitMerlin = g.assassinTargetRole === 'merlin';
      lines.push(`### 刺殺`);
      lines.push(`- 刺客鎖定：座${seat}（實際為 ${role}）→ ${hitMerlin ? '命中梅林，紅方逆轉勝' : '未命中，藍方守下勝利'}`);
      lines.push('');
    }

    lines.push(`### 結果`);
    lines.push(`- 勝方：**${g.winner === 'good' ? '藍方（好人）' : '紅方（壞人）'}**`);
    lines.push(`- 結束原因：${translateEndReason(g.endReason)}`);
    lines.push(`- 事件數：${g.eventCount}`);
    lines.push('');
  }

  return lines.join('\n');
}

function seatOf(game: CapturedGame, playerId: string): number {
  return game.seats.find(s => s.id === playerId)?.seat ?? -1;
}

function translateRole(role: Role): string {
  const map: Record<string, string> = {
    merlin: '梅林',
    percival: '派西維爾',
    loyal: '忠臣',
    assassin: '刺客',
    morgana: '摩甘娜',
    mordred: '莫德雷德',
    oberon: '奧伯倫',
    minion: '爪牙',
  };
  return map[role] ?? role;
}

function translateEndReason(reason?: string): string {
  if (!reason) return '—';
  const map: Record<string, string> = {
    failed_quests: '壞人贏 3 輪任務',
    vote_rejections: '連續 5 次否決 → 壞人勝',
    merlin_assassinated: '梅林被刺 → 壞人勝',
    assassination_failed: '刺殺失手 → 好人勝',
    assassination_timeout: '刺殺超時 → 好人勝',
    host_cancelled: '房主取消',
  };
  return map[reason] ?? reason;
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  // Disable selfplay scheduler-side imports; we're running standalone.
  process.env.SELFPLAY_ENABLED = 'false';

  const outDir = path.resolve(__dirname, '../staging/selfplay');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const games: CapturedGame[] = [];
  for (let i = 1; i <= GAME_COUNT; i++) {
    const agents: AvalonAgent[] = Array.from(
      { length: PLAYER_COUNT },
      (_, j) => new HeuristicAgent(`H-${String(j + 1).padStart(2, '0')}`, DIFFICULTY),
    );
    const t0 = Date.now();
    const g = await runOneGame(i, agents);
    const dt = Date.now() - t0;
    console.log(
      `[game ${i}] winner=${g.winner} rounds=${g.rounds} lakes=${g.ladyOfTheLakeHistory.length} ` +
      `assassin→${g.assassinTargetRole ?? '—'} endReason=${g.endReason ?? '—'} (${dt}ms)`,
    );
    games.push(g);
  }

  // Summary
  const goodWins = games.filter(g => g.winner === 'good').length;
  const evilWins = games.filter(g => g.winner === 'evil').length;
  console.log(`\n[summary] good ${goodWins}/${GAME_COUNT}, evil ${evilWins}/${GAME_COUNT}`);

  const ts = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(outDir, `selfplay_10p_5games_${ts}.json`);
  const mdPath   = path.join(outDir, `selfplay_10p_5games_${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(games, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(games), 'utf8');
  console.log(`\n[wrote] ${jsonPath}`);
  console.log(`[wrote] ${mdPath}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
