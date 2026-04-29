/**
 * selfplay_10p_qualitative.ts
 *
 * Qualitative 10-player Avalon self-play (Edward 2026-04-28 spec). Adapted
 * from selfplay_8p_qualitative.ts with PLAYER_COUNT = 10 and canonical 10p
 * roleOptions (Mordred + Oberon both ON).
 *
 * 10-player config (per AVALON_CONFIG[10]):
 *   - 6 good (Merlin / Percival / 4 Loyal) + 4 evil (Assassin / Morgana / Mordred / Oberon)
 *   - team sizes: R1=3, R2=4, R3=4, R4=5, R5=5
 *   - R4 requires 2 fail votes
 *
 * Output format (Edward 2026-04-29 minimal spec):
 *
 *   126                  (R1 隊長 1家 派 1/2/6)
 *   234
 *   589 3+               (3家外白 — 異常票)
 *   ...
 *   oox                  (任務結果 row marks task end)
 *                        (空行 = task 邊界, 不再有 <task X> 標記)
 *   1679
 *   ...
 *   oooo
 *   0>1 o                (湖中 inline: 0家驗 1家, 報 o)
 *
 *   ...
 *   刺殺: 8k4            (一行; 無刺殺則 `刺殺: ` 留空)
 *   配置: 809516         (一行 6 字串, 順序: 刺娜德奧派梅; 8p 無奧用 '-')
 *
 * Per-decision reasoning is captured separately and rendered AFTER the
 *牌譜 in a 思維紀錄 section (Edward 2026-04-28 spec — keep 牌譜 純格式).
 *
 * Run:  pnpm --filter @avalon/server exec tsx ../../scripts/selfplay_10p_qualitative.ts
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
  Role,
  Room,
  VoteRecord,
  QuestRecord,
  LadyOfTheLakeRecord,
  ReasoningEntry,
  ReasoningDecisionType,
  ReasoningAnomalyType,
  ReasoningMissionVoteType,
} from '@avalon/shared';
import { GameEngine } from '../packages/server/src/game/GameEngine';
import { RoomManager } from '../packages/server/src/game/RoomManager';
import { HeuristicAgent } from '../packages/server/src/ai/HeuristicAgent';
import { SelfPlayEngine } from '../packages/server/src/ai/SelfPlayEngine';
import { AvalonAgent, PlayerObservation } from '../packages/server/src/ai/types';
import {
  computePyramidScores,
  rankBySuspicion,
} from '../packages/server/src/ai/baseline';
import { SelfPlayReasoningRepository } from '../packages/server/src/services/SelfPlayReasoningRepository';

const PLAYER_COUNT = 10;
const DIFFICULTY: 'hard' = 'hard';

// ── Reasoning trace types ──────────────────────────────────────
//
// Wave D 2026-04-29 restructure (Edward grill round 5):
//   - 4-column template (解讀/邏輯/目的/動作)
//   - 忠臣 baseline + 我的 override 母模板
//   - anomaly classifier so render layer can filter normal votes
//   - mission classifier so render layer keeps only red-side rows
//   - lake events stay full (Q7: 湖中思維 > 任務思維)
//
// Schema lives in `@avalon/shared` so the DB layer (`SelfPlayReasoningRepository`)
// and the render layer share a single source of truth.

interface CapturedGame {
  gameIndex:               number;
  roomId:                  string;
  seats:                   { seat: number; id: string; role: Role; team: 'good' | 'evil' }[];
  voteHistory:             VoteRecord[];
  questHistory:            QuestRecord[];
  ladyOfTheLakeHistory:    LadyOfTheLakeRecord[];
  assassinTargetId?:       string;
  assassinTargetRole?:     Role;
  winner:                  'good' | 'evil';
  endReason?:              string;
  rounds:                  number;
  totalVoteAttempts:       number;
  eventCount:              number;
  reasoning:               ReasoningEntry[];
}

// ── Seat sort helper (1-9,0 convention; seat 10 displays as "0") ─
function seatSortKey(seatDigit: number): number {
  return seatDigit === 0 ? 10 : seatDigit;
}

function seatDigit(seat: number): string {
  return seat === 10 ? '0' : String(seat);
}

function formatSeatsAsc(seats: number[]): string {
  return [...seats]
    .sort((a, b) => seatSortKey(a) - seatSortKey(b))
    .map(seatDigit)
    .join('');
}

// ── Reasoning helpers ──────────────────────────────────────────

function roleLabelZh(role: Role): string {
  switch (role) {
    case 'merlin':   return '梅林';
    case 'percival': return '派西';
    case 'loyal':    return '忠臣';
    case 'assassin': return '刺客';
    case 'morgana':  return '莫甘娜';
    case 'mordred':  return '莫德';
    case 'oberon':   return '奧伯倫';
    default:         return role;
  }
}

function seatBySid(sid: string, seats: CapturedGame['seats']): number {
  return seats.find(s => s.id === sid)?.seat ?? -1;
}

// ── Reasoning builder (4-col template + baseline/override) ────
//
// Edward 2026-04-29 grill round 5 spec:
//
//   解讀: 我看到上家 X 動作 Y, 我推 Z
//   邏輯: 一句推導鏈 (連接解讀→動作)
//   目的: 角色目的, 從清單選 (camp purpose 清單)
//   動作: 派 130 / 異常黑 / 出失敗票 等
//
//   忠臣 baseline: 如果我是忠臣會怎麼推
//   我的 override: 但我內建知 X, 推導變 Y
//
// Camp purpose clauses (Edward Q3 verbatim):
//   藍方: 三藍為最大前提 + 隱藏梅林
//   紅方: 三紅為優先 + 逼梅林開能力 / 刺殺梅林次之
//   忠臣: 找好人 (6 能力者 4 紅 + 梅派要躲)

function purposeForRole(role: Role): string {
  switch (role) {
    case 'merlin':
      return '三藍前提 + 隱藏梅林身份 (不能曝光)';
    case 'percival':
      return '三藍前提 + 護梅 + 識破莫甘娜';
    case 'loyal':
      return '找好人 (6 能力者 4 紅, 梅派要躲); 配合三藍前提';
    case 'assassin':
      return '三紅優先 + 逼梅林現身刺殺 (次要)';
    case 'morgana':
      return '三紅優先 + 偽裝梅林吸火 (混淆派西)';
    case 'mordred':
      return '三紅優先 + 隱身於梅林視線外';
    case 'oberon':
      return '三紅優先 + 配合任務失敗 (但無內線)';
    default:
      return '陣營目的';
  }
}

function knownTag(obs: PlayerObservation, seats: CapturedGame['seats']): string {
  const knownEvilSeats = obs.knownEvils
    .map(id => seatDigit(seatBySid(id, seats)))
    .sort()
    .join('');
  if (knownEvilSeats.length > 0) return `見紅 ${knownEvilSeats}`;
  if (obs.myRole === 'percival' && obs.knownWizards && obs.knownWizards.length > 0) {
    return `見梅+娜 ${obs.knownWizards
      .map(id => seatDigit(seatBySid(id, seats)))
      .sort()
      .join('')}`;
  }
  return '無內線';
}

function suspicionDigest(obs: PlayerObservation, seats: CapturedGame['seats']): { sus: string; clean: string } {
  const pyramid = computePyramidScores(obs);
  const ranking = rankBySuspicion(pyramid, obs, true);
  const topSus = [...ranking].reverse().slice(0, 2);
  const topClean = ranking.slice(0, 2);
  const fmt = (id: string): string => {
    const s = seatBySid(id, seats);
    const score = pyramid.scores.get(id) ?? 0.5;
    return `${seatDigit(s)}=${score.toFixed(2)}`;
  };
  return {
    sus: topSus.map(fmt).join(' '),
    clean: topClean.map(fmt).join(' '),
  };
}

/**
 * Classify a team_vote as anomaly or normal (Edward Q4 spec).
 *
 *   normal       — leader's own team approve / on-team approve / off-team reject
 *   inner_black  — on-team voting reject
 *   outer_white  — off-team voting approve (non-leader)
 *   outer_white_self — leader proposed a team that excludes self AND voted approve
 */
function classifyVoteAnomaly(
  voterSid: string,
  voterIsLeader: boolean,
  team: string[],
  vote: boolean,
): ReasoningAnomalyType {
  const onTeam = team.includes(voterSid);
  if (voterIsLeader && !onTeam && vote) return 'outer_white_self';
  if (!onTeam && vote) return 'outer_white';
  if (onTeam && !vote) return 'inner_black';
  return null;
}

function classifyMissionVote(
  myTeam: 'good' | 'evil',
  vote: 'success' | 'fail',
): ReasoningMissionVoteType {
  if (myTeam !== 'evil') return null; // blue side dropped (Q7)
  return vote === 'success' ? 'red_success' : 'red_fail';
}

function buildLoyalistBaseline(
  obs:        PlayerObservation,
  decisionType: ReasoningDecisionType,
  detail:     string,
): string {
  const round = obs.currentRound ?? 1;
  const onTeam = obs.proposedTeam.includes(obs.myPlayerId);
  switch (decisionType) {
    case 'team_select':
      return `如果我是忠臣 R${round} 派人, 從 pyramid 最低紅嫌挑足 team-size, 自己優先`;
    case 'team_vote':
      if (round <= 2) {
        return onTeam
          ? '忠臣 R1-R2 在隊內 → 默認贊成 (沒資訊基礎反對)'
          : '忠臣 R1-R2 場外 → 默認反對 (異常率 ≤ 1%)';
      }
      return onTeam
        ? '忠臣 R3+ 在隊內 → 預設贊成, 除非 pyramid 顯示 ≥1 紅嫌'
        : '忠臣 R3+ 場外 → pyramid 平均 < strict threshold 才贊成, 否則反對';
    case 'quest_vote':
      return '忠臣任務 → 必出成功 (藍方無條件成功)';
    case 'lake_target':
      return '忠臣持湖 → 湖低紅嫌 (建信任鏈, 硬規則 4)';
    case 'lake_declare':
      return '忠臣宣告 → 講真話 (藍方無理由說謊)';
    case 'assassinate':
      return '忠臣不會刺 (此 entry 不該出現)';
    default:
      return `忠臣 baseline (decision=${decisionType}): ${detail}`;
  }
}

function buildMyOverride(
  obs:        PlayerObservation,
  decisionType: ReasoningDecisionType,
  baseline:   string,
  seats:      CapturedGame['seats'],
): string {
  const role = obs.myRole;
  const tag = knownTag(obs, seats);

  // Plain loyalist → no override.
  if (role === 'loyal') return '我就是忠臣, 同 baseline';

  switch (role) {
    case 'merlin':
      return `我是梅林, ${tag}; baseline 之上加優先排除已知紅入隊, 但不能曝光自己`;
    case 'percival':
      return `我是派西, ${tag}; baseline 之上加優先信任見到的梅或娜 (二選一)`;
    case 'assassin':
    case 'morgana':
    case 'mordred':
      if (decisionType === 'team_select') {
        return `我是${roleLabelZh(role)}, ${tag}; 派人偷帶隊友 (1-2 紅) 維持任務出黑機會`;
      }
      if (decisionType === 'team_vote') {
        return `我是${roleLabelZh(role)}, ${tag}; 在隊或有隊友在隊一律贊成 (cover)`;
      }
      if (decisionType === 'quest_vote') {
        return `我是${roleLabelZh(role)}, ${tag}; 任務看局勢出失敗票 (三紅優先)`;
      }
      if (decisionType === 'lake_declare') {
        return `我是${roleLabelZh(role)}, ${tag}; 宣告可說謊洗壓力或誣指梅林`;
      }
      if (decisionType === 'assassinate') {
        return `我是刺客, ${tag}; 鎖梅林 (高 Merlin-likeness 玩家)`;
      }
      return `我是${roleLabelZh(role)}, ${tag}; baseline + 紅方策略`;
    case 'oberon':
      return `我是奧伯倫, 無內線; baseline 之上前三輪先觀察, 出過任務後 R+1 起無條件外白`;
    default:
      return baseline;
  }
}

function actionPhrase(decisionType: ReasoningDecisionType, detail: string): string {
  switch (decisionType) {
    case 'team_select':  return `派 ${detail}`;
    case 'team_vote':    return detail;          // pre-formatted: 異常黑/異常白/正常票
    case 'quest_vote':   return detail;          // 出成功 / 出失敗
    case 'lake_target':  return `湖 ${detail}`;
    case 'lake_declare': return `宣告 ${detail}`;
    case 'assassinate':  return `刺 ${detail}`;
  }
}

function buildLogicLine(
  obs:        PlayerObservation,
  decisionType: ReasoningDecisionType,
  detail:     string,
  seats:      CapturedGame['seats'],
): string {
  const susInfo = suspicionDigest(obs, seats);
  const round = obs.currentRound ?? 1;
  switch (decisionType) {
    case 'team_select':
      return `R${round} 派 → ${detail} (紅疑 ${susInfo.sus || '-'} / 藍疑 ${susInfo.clean || '-'})`;
    case 'team_vote':
      return `R${round} 表決 → ${detail} (紅疑 ${susInfo.sus || '-'})`;
    case 'quest_vote':
      return `R${round} 任務 → ${detail}`;
    case 'lake_target':
      return `R${round} 湖中 → ${detail} (低紅嫌優先)`;
    case 'lake_declare':
      return `R${round} 宣告 → ${detail}`;
    case 'assassinate':
      return `R${round} 刺殺 → ${detail} (Merlin-likeness max)`;
  }
}

interface BuildEntryArgs {
  obs:           PlayerObservation;
  decisionType:  ReasoningDecisionType;
  detail:        string;
  attempt:       number;
  seats:         CapturedGame['seats'];
  leaderSid:     string;
  anomalyType?:  ReasoningAnomalyType;
  missionVoteType?: ReasoningMissionVoteType;
  interpretation?: string;
}

function buildStructuredEntry(args: BuildEntryArgs): ReasoningEntry {
  const { obs, decisionType, detail, attempt, seats, leaderSid } = args;
  const seat = seatBySid(obs.myPlayerId, seats);
  const leaderSeat = seatBySid(leaderSid, seats);
  const interpretation = args.interpretation
    ?? `R${obs.currentRound} ${seatDigit(leaderSeat)}家派, 我${seatDigit(seat) === seatDigit(leaderSeat) ? '是隊長' : '依公開資訊'}推`;
  const logic = buildLogicLine(obs, decisionType, detail, seats);
  const purpose = purposeForRole(obs.myRole);
  const action = actionPhrase(decisionType, detail);
  const loyalistBaseline = buildLoyalistBaseline(obs, decisionType, detail);
  const myOverride = buildMyOverride(obs, decisionType, loyalistBaseline, seats);

  return {
    decisionType,
    round: obs.currentRound ?? 1,
    attempt,
    actorSeat: seat,
    actorRole: obs.myRole,
    leaderSeat,
    interpretation,
    logic,
    purpose,
    action,
    loyalistBaseline,
    myOverride,
    anomalyType: args.anomalyType ?? null,
    missionVoteType: args.missionVoteType ?? null,
  };
}

// ── Run one game ──────────────────────────────────────────────

async function runOneGame(
  gameIndex: number,
  agents: AvalonAgent[],
): Promise<CapturedGame> {
  const roomManager = new RoomManager();
  const roomId = `AI10-${uuidv4().slice(0, 8).toUpperCase()}`;
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

  // 10-player canonical: percival/morgana/mordred/oberon all ON (6 good, 4 evil).
  room.roleOptions = {
    ...(room.roleOptions ?? {
      percival: true,
      morgana:  true,
      oberon:   true,
      mordred:  true,
    }),
    percival: true,
    morgana:  true,
    oberon:   true,
    mordred:  true,
    ladyOfTheLake: true,
    ladyStart:     'seat0', // = playerCount-1 = seat 10 for 10p
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

  const playerIds0 = Object.keys(room.players);
  const seatsEarly = playerIds0.map((id, i) => ({
    seat: i + 1,
    id,
    role: roleMap.get(id)!,
    team: teamMap.get(id)!,
  }));

  for (const a of agents) {
    const obs = buildObs(a.agentId, room, roleMap, teamMap, [], []);
    a.onGameStart(obs);
  }

  const voteHistory:  VoteRecord[]  = [];
  const questHistory: QuestRecord[] = [];
  const reasoning:    ReasoningEntry[] = [];
  let voteAttempt = 0;
  let proposalCounterByRound = new Map<number, number>();

  while (room.state !== 'ended') {
    const leaderId = engine.getCurrentLeaderId();

    if (room.state === 'voting' && room.questTeam.length === 0) {
      const leader = agents.find(a => a.agentId === leaderId)!;
      const obs = buildObs(leader.agentId, room, roleMap, teamMap, voteHistory, questHistory);
      const action = leader.act({ ...obs, gamePhase: 'team_select' });
      if (action.type !== 'team_select') throw new Error('Expected team_select');

      const teamSeats = action.teamIds.map(id => seatBySid(id, seatsEarly));
      const teamStr = formatSeatsAsc(teamSeats);
      const attemptNo = (proposalCounterByRound.get(obs.currentRound) ?? 0) + 1;
      proposalCounterByRound.set(obs.currentRound, attemptNo);

      reasoning.push(buildStructuredEntry({
        obs,
        decisionType: 'team_select',
        detail:       teamStr,
        attempt:      attemptNo,
        seats:        seatsEarly,
        leaderSid:    leader.agentId,
      }));

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
      const voteLeaderSid = leaderId; // captured before submitVote may rotate state
      for (const a of agents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'team_vote' });
        if (action.type !== 'team_vote') throw new Error('Expected team_vote');
        votes[a.agentId] = action.vote;

        const anomalyType = classifyVoteAnomaly(
          a.agentId,
          a.agentId === voteLeaderSid,
          obs.proposedTeam,
          action.vote,
        );
        let voteDetail: string;
        if (anomalyType === 'inner_black') voteDetail = '異常黑 (場內反對)';
        else if (anomalyType === 'outer_white') voteDetail = '異常白 (場外贊成)';
        else if (anomalyType === 'outer_white_self') voteDetail = '外灑外白 (隊長不派自己卻贊成)';
        else voteDetail = action.vote ? '正常票 (贊成)' : '正常票 (反對)';

        reasoning.push(buildStructuredEntry({
          obs,
          decisionType: 'team_vote',
          detail:       voteDetail,
          attempt:      voteAttempt,
          seats:        seatsEarly,
          leaderSid:    voteLeaderSid,
          anomalyType,
        }));
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
      const questLeaderSid = leaderId;
      let failCount = 0;
      for (const a of teamAgents) {
        const obs = buildObs(a.agentId, room, roleMap, teamMap, voteHistory, questHistory);
        const action = a.act({ ...obs, gamePhase: 'quest_vote' });
        if (action.type !== 'quest_vote') throw new Error('Expected quest_vote');
        if (action.vote === 'fail') failCount++;

        const myTeam = teamMap.get(a.agentId) ?? 'good';
        const missionVoteType = classifyMissionVote(myTeam, action.vote);
        const detail = action.vote === 'success' ? '出成功票' : '出失敗票';

        reasoning.push(buildStructuredEntry({
          obs,
          decisionType: 'quest_vote',
          detail,
          attempt:      0,
          seats:        seatsEarly,
          leaderSid:    questLeaderSid,
          missionVoteType,
        }));

        engine.submitQuestVote(a.agentId, action.vote);
        if ((room.state as string) !== 'quest') break;
      }
      const result = room.questResults[preRound - 1] ?? (failCount > 0 ? 'fail' : 'success');
      questHistory.push({
        round:     preRound,
        team:      preTeam,
        result:    result as 'success' | 'fail',
        failCount,
      });
      if ((room.state as string) === 'ended') break;
    }

    if (room.state === 'lady_of_the_lake') {
      const holderId = room.ladyOfTheLakeHolder!;
      const used = new Set(room.ladyOfTheLakeUsed ?? []);
      const validTargets = Object.keys(room.players).filter(
        id => id !== holderId && !used.has(id),
      );
      if (validTargets.length > 0) {
        const holderTeam = teamMap.get(holderId);
        const holderObs = buildObs(holderId, room, roleMap, teamMap, voteHistory, questHistory);
        const targetId = lakePicker.pickLadyTarget(holderTeam, holderObs, validTargets);
        const targetSeat = seatBySid(targetId, seatsEarly);

        reasoning.push(buildStructuredEntry({
          obs:          holderObs,
          decisionType: 'lake_target',
          detail:       `${seatDigit(targetSeat)}家`,
          attempt:      0,
          seats:        seatsEarly,
          leaderSid:    holderId,
        }));

        engine.submitLadyOfTheLakeTarget(holderId, targetId);
        const actualTeam = teamMap.get(targetId);
        const claim = lakePicker.decideLakeAnnouncement(holderTeam, targetId, holderObs, actualTeam);
        if (claim !== null) {
          reasoning.push(buildStructuredEntry({
            obs:          holderObs,
            decisionType: 'lake_declare',
            detail:       claim === 'good' ? '好人' : '壞人',
            attempt:      0,
            seats:        seatsEarly,
            leaderSid:    holderId,
          }));
          try {
            engine.declareLakeResult(holderId, claim);
          } catch {
            /* best-effort */
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

      const targetSeat = seatBySid(action.targetId, seatsEarly);
      reasoning.push(buildStructuredEntry({
        obs,
        decisionType: 'assassinate',
        detail:       `${seatDigit(targetSeat)}家`,
        attempt:      0,
        seats:        seatsEarly,
        leaderSid:    assassin.agentId,
      }));

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
    voteHistory:          room.voteHistory,
    questHistory:         room.questHistory,
    ladyOfTheLakeHistory: room.ladyOfTheLakeHistory ?? [],
    assassinTargetId:     room.assassinTargetId,
    assassinTargetRole,
    winner:               evilWins ? 'evil' : 'good',
    endReason:            room.endReason,
    rounds:               room.currentRound,
    totalVoteAttempts:    room.voteHistory.length,
    eventCount:           events.length,
    reasoning,
  };

  roomManager.deleteRoom(roomId);
  roomManager.destroy();
  return captured;
}

function buildObs(
  playerId:     string,
  room:         Room,
  roleMap:      Map<string, Role>,
  teamMap:      Map<string, 'good' | 'evil'>,
  voteHistory:  VoteRecord[],
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

  const lakeHistory = (room.ladyOfTheLakeHistory ?? [])
    .filter((rec) => rec.declared === true && rec.declaredClaim !== undefined)
    .map((rec) => ({
      round:         rec.round,
      holderId:      rec.holderId,
      targetId:      rec.targetId,
      declaredClaim: rec.declaredClaim as 'good' | 'evil',
    }));

  return {
    myPlayerId:    playerId,
    myRole,
    myTeam,
    playerCount:   playerIds.length,
    allPlayerIds:  playerIds,
    knownEvils,
    knownWizards,
    allEvilIds,
    currentRound:  room.currentRound,
    currentLeader,
    failCount:     room.failCount,
    questResults:  room.questResults.filter((r): r is 'success' | 'fail' => r !== 'pending'),
    gamePhase,
    voteHistory:   [...voteHistory],
    questHistory:  [...questHistory],
    proposedTeam:  [...room.questTeam],
    lakeHistory,
  };
}

function getKnownEvils(
  pid:     string,
  role:    Role,
  roleMap: Map<string, Role>,
  teamMap: Map<string, 'good' | 'evil'>,
): string[] {
  switch (role) {
    case 'merlin':
      // Merlin sees ALL evil EXCEPT Mordred (Oberon IS visible to Merlin).
      // Aligned with main fix in 25c5181b (canonical Avalon spec).
      return Array.from(teamMap.entries())
        .filter(([id, t]) =>
          t === 'evil' && id !== pid && roleMap.get(id) !== 'mordred',
        )
        .map(([id]) => id);
    case 'percival':
      return Array.from(roleMap.entries())
        .filter(([id, r]) => (r === 'merlin' || r === 'morgana') && id !== pid)
        .map(([id]) => id);
    case 'assassin':
    case 'morgana':
    case 'mordred':
      // Evils know each other EXCEPT oberon.
      return Array.from(teamMap.entries())
        .filter(([id, t]) => t === 'evil' && roleMap.get(id) !== 'oberon' && id !== pid)
        .map(([id]) => id);
    case 'oberon':
      // Oberon doesn't see other evils, doesn't know other evils.
      return [];
    default:
      return [];
  }
}

// ── Edward-format renderer (純牌譜, NO inline thoughts) ────────

function questResultEmoji(result: 'success' | 'fail', failCount: number, teamSize: number): string {
  const o = 'o'.repeat(teamSize - failCount);
  const x = 'x'.repeat(failCount);
  return o + x;
}

/**
 * Render the pure 牌譜 — NO reasoning inline. Reasoning is rendered
 * separately in renderReasoningTrace().
 */
function renderEdwardFormat(game: CapturedGame, gameNum: number): string {
  const lines: string[] = [];
  const seats = game.seats;

  lines.push(`=== Game ${gameNum} === room=${game.roomId} winner=${game.winner === 'good' ? '藍方(好人)' : '紅方(壞人)'}`);
  lines.push('');

  // ── 5 missions ────────────────────────────────────────────
  // Edward 2026-04-29 spec: minimal format — drop `<task X>` headers.
  // Task boundaries are recoverable from blank lines + result rows
  // (oox/oooo/etc.). Rounds not reached emit nothing.
  for (let r = 1; r <= 5; r++) {
    const votes = game.voteHistory.filter(v => v.round === r);
    const quest = game.questHistory.find(q => q.round === r);
    if (votes.length === 0 && !quest) continue;

    for (const v of votes) {
      const teamSeats = v.team.map(id => seatBySid(id, seats));
      const teamStr = formatSeatsAsc(teamSeats);

      // Anomaly markers
      const teamSet = new Set(teamSeats);
      const innerBlackSeats: number[] = [];
      const outerWhiteSeats: number[] = [];
      for (const [pid, approved] of Object.entries(v.votes)) {
        const s = seatBySid(pid, seats);
        if (!approved && teamSet.has(s)) innerBlackSeats.push(s);
        if (approved && !teamSet.has(s)) outerWhiteSeats.push(s);
      }
      const parts: string[] = [];
      // R5 forced proposal: no anomaly tagging (logically impossible)
      if (v.attempt < 5) {
        if (outerWhiteSeats.length > 0) parts.push(`${formatSeatsAsc(outerWhiteSeats)}+`);
        if (innerBlackSeats.length > 0) parts.push(`${formatSeatsAsc(innerBlackSeats)}-`);
      }
      const anomaly = parts.length > 0 ? ` ${parts.join(' ')}` : '';

      // Pure 牌譜 row — no thoughts inline.
      lines.push(`${teamStr}${anomaly}`);
    }

    if (quest) {
      const teamSize = quest.team.length;
      const result = questResultEmoji(quest.result, quest.failCount, teamSize);
      lines.push(`${result}`);
    }

    // ── 湖中 inline (after this round's quest result) ──────
    // Edward 2026-04-29 spec: lake events render at the time-point they
    // occur (between round R quest result and round R+1 first proposal),
    // NOT lumped at the end in a separate <湖中> section.
    const lakesThisRound = game.ladyOfTheLakeHistory.filter(l => l.round === r);
    for (const l of lakesThisRound) {
      const holderSeat = seatBySid(l.holderId, seats);
      const targetSeat = seatBySid(l.targetId, seats);
      const claim = l.declaredClaim
        ? (l.declaredClaim === 'good' ? 'o' : 'x')
        : '?';
      lines.push(`${seatDigit(holderSeat)}>${seatDigit(targetSeat)} ${claim}`);
    }

    lines.push('');
  }

  // ── 刺殺 (Edward 2026-04-29 spec: one-line `刺殺: <value-or-empty>`) ──
  // Always emit; empty value when assassin did not act (e.g. 三紅 game).
  const findRoleSeat = (role: Role): string => {
    const seat = seats.find(s => s.role === role);
    return seat ? seatDigit(seat.seat) : '-';
  };
  if (game.assassinTargetId) {
    const assassinSeat = seatBySid(
      seats.find(s => s.role === 'assassin')?.id ?? '',
      seats,
    );
    const targetSeat = seatBySid(game.assassinTargetId, seats);
    lines.push(`刺殺: ${seatDigit(assassinSeat)}k${seatDigit(targetSeat)}`);
  } else {
    lines.push('刺殺: ');
  }

  // ── 配置 (Edward 2026-04-29 spec: one-line 6-char string, 刺娜德奧派梅) ──
  // Order: 刺(assassin) 娜(morgana) 德(mordred) 奧(oberon) 派(percival) 梅(merlin)
  // 忠臣 omitted (loyals inferred from remaining seats).
  // 結局 dropped — recoverable from final task result row (oox/ooxxx/etc.) +
  // 刺殺 line (k means assassinated).
  const config =
    findRoleSeat('assassin') +
    findRoleSeat('morgana') +
    findRoleSeat('mordred') +
    findRoleSeat('oberon') +
    findRoleSeat('percival') +
    findRoleSeat('merlin');
  lines.push(`配置: ${config}`);

  return lines.join('\n');
}

/**
 * Render reasoning AFTER the 牌譜 (Wave D 2026-04-29 spec).
 *
 * Layout per entry — 4-column template + 忠臣 baseline + override:
 *
 *   [N家(角色)思維 R<round> r<attempt>]
 *     解讀: ...
 *     邏輯: ...
 *     目的: ...
 *     動作: ...
 *     忠臣 baseline: ...
 *     我的 override: ...
 *
 * Filter rules (Edward Q4/Q5/Q7):
 *   - Leader's team_select         → always emit
 *   - Vote rows                    → only if anomalyType !== null
 *   - Quest_vote rows              → only if missionVoteType !== null (red side)
 *   - Lake target / declare        → always emit (lake 思維 > 任務思維)
 *   - Assassinate                  → always emit
 */
function renderReasoningEntry(e: ReasoningEntry): string[] {
  const role = roleLabelZh(e.actorRole as Role);
  const header = `[${seatDigit(e.actorSeat)}家(${role})思維 R${e.round} r${e.attempt}]`;
  return [
    header,
    `  解讀: ${e.interpretation}`,
    `  邏輯: ${e.logic}`,
    `  目的: ${e.purpose}`,
    `  動作: ${e.action}`,
    `  忠臣 baseline: ${e.loyalistBaseline}`,
    `  我的 override: ${e.myOverride}`,
  ];
}

function renderReasoningTrace(game: CapturedGame, gameNum: number): string {
  const lines: string[] = [];
  const seats = game.seats;

  lines.push(`--- Game ${gameNum} 思維紀錄 ---`);
  lines.push('');

  for (let r = 1; r <= 5; r++) {
    const votes = game.voteHistory.filter(v => v.round === r);
    if (votes.length === 0) continue;

    for (const v of votes) {
      const attempt = v.attempt;
      const tsEntry = game.reasoning.find(rr =>
        rr.decisionType === 'team_select' &&
        rr.round === r &&
        rr.attempt === attempt,
      );
      const leaderSeat = tsEntry?.leaderSeat ?? -1;
      const leaderRole = tsEntry ? roleLabelZh(tsEntry.actorRole as Role) : '?';
      const teamSeats = v.team.map(id => seatBySid(id, seats));
      const teamStr = formatSeatsAsc(teamSeats);

      // Anomaly-only filter for vote thoughts (Edward Q4/Q5).
      const anomalyVotes = game.reasoning
        .filter(rr =>
          rr.decisionType === 'team_vote' &&
          rr.round === r &&
          rr.attempt === attempt &&
          rr.anomalyType !== null,
        )
        .sort((a, b) => seatSortKey(a.actorSeat) - seatSortKey(b.actorSeat));

      // Skip block entirely if no leader thought AND no anomalies.
      if (!tsEntry && anomalyVotes.length === 0) continue;

      lines.push(`T${gameNum} r${attempt} (${seatDigit(leaderSeat)}家${leaderRole}派 ${teamStr}):`);
      if (tsEntry) {
        for (const line of renderReasoningEntry(tsEntry)) lines.push(`  ${line}`);
      }
      for (const av of anomalyVotes) {
        for (const line of renderReasoningEntry(av)) lines.push(`  ${line}`);
      }
      lines.push('');
    }

    // Mission thoughts: only red side (missionVoteType !== null per Q7).
    const quest = game.questHistory.find(q => q.round === r);
    if (quest) {
      const teamSeats = quest.team.map(id => seatBySid(id, seats));
      const teamStr = formatSeatsAsc(teamSeats);
      const redMissionThoughts = game.reasoning
        .filter(rr =>
          rr.decisionType === 'quest_vote' &&
          rr.round === r &&
          rr.missionVoteType !== null,
        )
        .sort((a, b) => seatSortKey(a.actorSeat) - seatSortKey(b.actorSeat));
      if (redMissionThoughts.length > 0) {
        lines.push(`T${gameNum} R${r} 任務 (${teamStr}) — 紅方思維:`);
        for (const qt of redMissionThoughts) {
          for (const line of renderReasoningEntry(qt)) lines.push(`  ${line}`);
        }
        lines.push('');
      }
    }

    // Lake thoughts: always emit (lake 思維 > 任務思維 per Q7).
    const lakes = game.ladyOfTheLakeHistory.filter(l => l.round === r);
    for (const l of lakes) {
      const hSeat = seatBySid(l.holderId, seats);
      const tSeat = seatBySid(l.targetId, seats);
      lines.push(`T${gameNum} R${r} 湖中 (${seatDigit(hSeat)}>${seatDigit(tSeat)}):`);
      const lakeThoughts = game.reasoning.filter(rr =>
        (rr.decisionType === 'lake_target' || rr.decisionType === 'lake_declare') &&
        rr.round === r,
      );
      for (const lt of lakeThoughts) {
        for (const line of renderReasoningEntry(lt)) lines.push(`  ${line}`);
      }
      lines.push('');
    }
  }

  // Assassinate
  if (game.assassinTargetId) {
    const assassinSid = seats.find(s => s.role === 'assassin')?.id ?? '';
    const aSeat = seatBySid(assassinSid, seats);
    const tSeat = seatBySid(game.assassinTargetId, seats);
    lines.push(`T${gameNum} 刺殺 (${seatDigit(aSeat)}k${seatDigit(tSeat)}):`);
    const aEntries = game.reasoning.filter(rr => rr.decisionType === 'assassinate');
    for (const ae of aEntries) {
      for (const line of renderReasoningEntry(ae)) lines.push(`  ${line}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────

async function main() {
  process.env.SELFPLAY_ENABLED = 'false';

  // Output directly to Edward's main staging dir per task spec.
  const outDir = '/mnt/c/Users/admin/staging/selfplay';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const NUM_GAMES = Number(process.env.SELFPLAY_NUM_GAMES ?? '1');
  const games: CapturedGame[] = [];
  for (let i = 1; i <= NUM_GAMES; i++) {
    const agents: AvalonAgent[] = Array.from(
      { length: PLAYER_COUNT },
      (_, j) => new HeuristicAgent(`H-${String(j + 1).padStart(2, '0')}`, DIFFICULTY),
    );
    const t0 = Date.now();
    const g = await runOneGame(i, agents);
    const dt = Date.now() - t0;
    console.log(
      `[game ${i}] winner=${g.winner} rounds=${g.rounds} lakes=${g.ladyOfTheLakeHistory.length} ` +
      `assassin->${g.assassinTargetRole ?? '-'} endReason=${g.endReason ?? '-'} ` +
      `reasonings=${g.reasoning.length} (${dt}ms)`,
    );
    games.push(g);
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  // Use system time directly — runner host uses +08 already.
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())} +08`;

  const date = ts.slice(0, 10);
  const outBase = process.env.SELFPLAY_OUT_BASE ?? `qualitative_${games.length}games_10p_${date}`;
  const mdPath   = path.join(outDir, `${outBase}.md`);
  const jsonPath = path.join(outDir, `${outBase}.json`);

  const header = [
    `# 10人版 Avalon Self-Play (Wave A+B 質化驗證)`,
    `# 完成於 ${ts}`,
    `# 10-player config: 6 good (Merlin/Percival/4 Loyal) + 4 evil (Assassin/Morgana/Mordred/Oberon)`,
    `#                   team sizes R1/R2/R3/R4/R5 = 3/4/4/5/5; R4 needs 2 fails`,
    `#                   Lady of the Lake ON; ladyStart='seat0' (= seat 10 for 10p)`,
    `#                   Difficulty: ${DIFFICULTY}`,
    ``,
    `## 牌譜 (純格式 — 一行一 row)`,
    ``,
  ].join('\n');

  const board = games.map((g, i) => renderEdwardFormat(g, i + 1)).join('\n\n');

  const reasoningHeader = [
    ``,
    `---`,
    ``,
    `## 思維紀錄 (牌譜後另列)`,
    ``,
    `每個 decision row 對應一個思維 block, 列每個玩家一行。`,
    ``,
  ].join('\n');

  const reasoning = games.map((g, i) => renderReasoningTrace(g, i + 1)).join('\n\n');

  fs.writeFileSync(mdPath, header + board + reasoningHeader + reasoning, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(games, null, 2), 'utf8');

  // ── Wave D: Option F DB-equivalent reasoning blob (gzip + base64) ──
  // Mirror of the Firestore `selfplay_reasoning/{gameId}` doc. Emitted
  // alongside the .json/.md so an offline run reproduces the exact
  // payload that would land in DB without needing Firebase credentials.
  const blobPath = path.join(outDir, `${outBase}.reasoning.json`);
  const blobs = games.map((g) =>
    SelfPlayReasoningRepository.buildRecord(g.roomId, g.reasoning),
  );
  fs.writeFileSync(blobPath, JSON.stringify(blobs, null, 2), 'utf8');

  // Anomaly-rate breakdown (Edward 2026-04-29 Q5 verification — T1 ≤ 1%, T2 ≤ 5%).
  const anomalyByRound = new Map<number, { total: number; anomaly: number }>();
  for (const g of games) {
    for (const e of g.reasoning) {
      if (e.decisionType !== 'team_vote') continue;
      const slot = anomalyByRound.get(e.round) ?? { total: 0, anomaly: 0 };
      slot.total += 1;
      if (e.anomalyType !== null) slot.anomaly += 1;
      anomalyByRound.set(e.round, slot);
    }
  }
  const summaryLines: string[] = ['# Anomaly rate by round (Wave D verification)'];
  for (const round of [...anomalyByRound.keys()].sort()) {
    const slot = anomalyByRound.get(round)!;
    const pct = slot.total === 0 ? 0 : (slot.anomaly / slot.total) * 100;
    summaryLines.push(`R${round}: ${slot.anomaly}/${slot.total} = ${pct.toFixed(2)}%`);
  }
  const summaryPath = path.join(outDir, `${outBase}.anomaly_summary.txt`);
  fs.writeFileSync(summaryPath, summaryLines.join('\n') + '\n', 'utf8');

  console.log(`\n[wrote] ${mdPath}`);
  console.log(`[wrote] ${jsonPath}`);
  console.log(`[wrote] ${blobPath}  (${blobs.length} reasoning blobs)`);
  console.log(`[wrote] ${summaryPath}`);
  console.log(summaryLines.join('\n'));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
