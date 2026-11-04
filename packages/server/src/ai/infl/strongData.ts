/**
 * 強者量尺的資料層（2026-11-04；docs/ai/strong_metrics.md）：
 *   - 真人局：games_cache.json 用 `datasetReplay` 嚴格解析成可重播的局，再從資料集的座位欄補上名字（只在記憶體裡）
 *     與桌上平均開打前 Elo（高強度局）；
 *   - 自我對打局：一局結束時的觀察（完整公開紀錄）＋每個座位的角色 → 同一個 `ReplayGame` 形狀，
 *     讓真人與機器人的局走同一套統計（異常票、尾家、INFL 特徵）。
 *   - `votesOf`：一局每一張可信的票（非強制、票數和結果相符）＋真相（隊上有沒有紅）。
 */
import type { Role } from '@avalon/shared';
import type { PlayerObservation } from '../types';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../benchmark/datasetReplay';
import { EVIL_ROLES, isLakeChainValid, type ReplayGame, type ReplayLake, type ReplayProposal, type ReplayQuest } from '../benchmark/sheetsReplay';
import { judgeVote, type VoteJudgement } from './abnormalVotes';
import { missionFailed } from '../missionFacts';

export interface HumanGame {
  game: ReplayGame;
  /** 桌上平均開打前 Elo（沒有 lineup 的 Elo = null）。 */
  avgElo: number | null;
  hi: boolean;
}

/** 資料集 → 可重播的真人局（名字＝資料集的正式名；百科AI 局已由 datasetReplay 拿掉）。 */
export function humanGamesFromDataset(
  dataset: DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] },
  threshold: number,
): { games: HumanGame[]; skipped: Record<string, number> } {
  const { games, skipped } = replayGamesFromDataset(dataset);
  const iId = dataset.fields.indexOf('id');
  const iSeats = dataset.fields.indexOf('seats');
  const iLineup = dataset.fields.indexOf('lineup');
  const rowOf = new Map<string, DatasetTuple>();
  for (const row of dataset.games) rowOf.set(String(row[iId]), row);
  const out: HumanGame[] = [];
  for (const dg of games) {
    const row = rowOf.get(dg.game.id);
    const seats = (row?.[iSeats] as number[] | undefined) ?? [];
    const names = Array.from({ length: dg.game.playerCount }, (_, k) => (seats[k] !== undefined && seats[k] >= 0 ? dataset.players[seats[k]] ?? '' : ''));
    const lineup = row?.[iLineup] as unknown[] | undefined;
    const elo = Array.isArray(lineup) && lineup.length >= 5 && Array.isArray(lineup[4]) ? (lineup[4] as number[]) : null;
    const avgElo = elo && elo.length === 10 ? elo.reduce((a, x) => a + x / 10, 0) / 10 : null;
    out.push({ game: { ...dg.game, names }, avgElo, hi: avgElo !== null && avgElo >= threshold });
  }
  return { games: out, skipped };
}

/**
 * 自我對打一局 → ReplayGame。`final` = 任何一個座位在終局的觀察（公開紀錄完整），`roleOf` = 每個 id 的角色。
 * 座位 = `final.allPlayerIds` 的順序（1 起），id 改寫成 P{座位}；隊長輪替不合（下一次提議不是下一個座位）時回傳 null。
 */
export function replayGameFromSelfPlay(
  id: string,
  final: Pick<PlayerObservation, 'allPlayerIds' | 'voteHistory' | 'questHistory' | 'lakeHistory'>,
  roleOf: (playerId: string) => Role,
  assassinTargetId?: string,
): ReplayGame | null {
  const ids = final.allPlayerIds;
  const n = ids.length;
  const seatOf = new Map(ids.map((x, k) => [x, k + 1]));
  const seatRoles = ids.map(roleOf);
  const proposals: ReplayProposal[] = final.voteHistory.map((v, gi) => {
    const forced = v.attempt >= 5;
    const teamSeats = v.team.map((x) => seatOf.get(x)!);
    const team = new Set(teamSeats);
    const votes = ids.map((x, k) => (forced ? team.has(k + 1) : v.votes[x] === true));
    const approveCount = forced ? teamSeats.length : votes.filter(Boolean).length;
    return {
      round: v.round,
      attempt: v.attempt,
      globalIndex: gi,
      leaderSeat: seatOf.get(v.leader)!,
      teamSeats,
      plusSeats: forced ? [] : ids.map((_, k) => k + 1).filter((s) => votes[s - 1] && !team.has(s)),
      minusSeats: forced ? [] : teamSeats.filter((s) => !votes[s - 1]),
      votes,
      approveCount,
      forced,
      wentOnMission: v.approved,
      votesReliable: !forced,
    };
  });
  for (let k = 1; k < proposals.length; k++) {
    if (proposals[k].leaderSeat !== (proposals[k - 1].leaderSeat % n) + 1) return null;
  }
  const quests: ReplayQuest[] = final.questHistory.map((q) => ({
    round: q.round,
    teamSeats: q.team.map((x) => seatOf.get(x)!),
    successCount: q.team.length - q.failCount,
    failCount: q.failCount,
    failed: missionFailed(q),
  }));
  const lakes: ReplayLake[] = (final.lakeHistory ?? []).map((l) => ({
    round: l.round,
    holderSeat: seatOf.get(l.holderId)!,
    targetSeat: seatOf.get(l.targetId)!,
    claim: l.declaredClaim === 'none' ? null : l.declaredClaim,
  }));
  const fails = quests.filter((q) => q.failed).length;
  const merlinSeat = seatRoles.indexOf('merlin') + 1;
  const target = assassinTargetId !== undefined ? seatOf.get(assassinTargetId) : undefined;
  const winner = fails >= 3 ? 'evil' : target !== undefined && target === merlinSeat ? 'evil' : 'good';
  return {
    id,
    playerCount: n,
    seatRoles,
    names: new Array<string>(n).fill(''),
    proposals,
    quests,
    lakes,
    lakeChainValid: isLakeChainValid(lakes, quests),
    assassinTargetSeat: target,
    winner,
  };
}

export const isRedRole = (r: Role): boolean => EVIL_ROLES.has(r);

export interface VoteRow {
  /** 提議索引（game.proposals）。 */
  p: number;
  seat: number;
  role: Role;
  round: number;
  attempt: number;
  onTeam: boolean;
  leader: boolean;
  approve: boolean;
  judgement: VoteJudgement;
  teamHasRed: boolean;
}

/** 一局每一張可信的票（`seats` 給了就只取那些座位；`override` 可以把票換成機器人的）。 */
export function votesOf(
  game: ReplayGame,
  seats?: ReadonlySet<number>,
  override?: (p: number, seat: number) => boolean | undefined,
): VoteRow[] {
  const out: VoteRow[] = [];
  game.proposals.forEach((prop, p) => {
    if (prop.forced || !prop.votesReliable) return;
    const team = new Set(prop.teamSeats);
    const redsOnTeam = prop.teamSeats.filter((s) => isRedRole(game.seatRoles[s - 1]));
    for (let seat = 1; seat <= game.playerCount; seat++) {
      if (seats && !seats.has(seat)) continue;
      const role = game.seatRoles[seat - 1];
      const approve = override?.(p, seat) ?? prop.votes[seat - 1];
      const onTeam = team.has(seat);
      const voterRed = isRedRole(role);
      const teamHasRed = redsOnTeam.length > 0;
      out.push({
        p, seat, role, round: prop.round, attempt: prop.attempt, onTeam, leader: prop.leaderSeat === seat, approve, teamHasRed,
        judgement: judgeVote({ onTeam, approve, voterRed, teamHasRed, teamHasOtherRed: redsOnTeam.some((s) => s !== seat) }),
      });
    }
  });
  return out;
}

/** 下一局起，藍方隊長派的隊裡有選 seat 的比例（沒有那種提議 = null）。 */
export function laterBlueInclusion(game: ReplayGame, p: number, seat: number): number | null {
  const round = game.proposals[p].round;
  let n = 0;
  let inc = 0;
  for (const q of game.proposals) {
    if (q.round <= round || q.leaderSeat === seat || isRedRole(game.seatRoles[q.leaderSeat - 1])) continue;
    n++;
    if (q.teamSeats.includes(seat)) inc++;
  }
  return n > 0 ? inc / n : null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 每局（或每個鍵）抽樣的 k 個不同座位（雜湊；同一個鍵每次一樣）。 */
export function sampledSeats(key: string, k: number, n = 10): number[] {
  const out: number[] = [];
  for (let t = 0; out.length < Math.min(k, n); t++) {
    const s = (hash(`${key}|sample|${t}`) % n) + 1;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
