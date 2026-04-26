import { useMemo } from 'react';
import type { Room } from '@avalon/shared';
import { seatOf, displaySeatNumber } from '../utils/seatDisplay';

/**
 * PhaseInfoBanner — sticky 即時 phase state 顯示 (Edward 2026-04-26 spec 33).
 *
 * Edward verbatim「系統任務選擇誰沒有馬上跳出來 所以還是需要有個視窗固定顯示
 * 當下的資訊 "隊長選擇:" 」+「應該是 上方有常態性方塊 [隊伍選擇: 134] 隊伍選擇
 * 一直顯示最新的組合」.
 *
 * 關鍵: 不靠 chat 訊息驅動 (避 #25 lag) — 直接從 `room.state` + `room.questTeam`
 * + `room.votes` + leader/lady 資訊派生. React state-driven, 不寫入 chat history.
 *
 * 顯示 (per phase):
 *   TEAM_SELECT 隊伍未選定: 「隊伍選擇: 1家 (尚未選人)」 / 「隊伍選擇: 134」
 *   VOTING (隊伍已選): 「投票中: {approved}/{total}」
 *   QUEST: 「任務執行中: {questTeam}」
 *   LADY pick: 「{holder} 選湖目標」
 *   LADY declare: 「{holder} → {target}: 等待宣告」
 *   ASSASSINATE (discussion): 「刺客 {seat} 選擇刺殺目標」
 *
 * 僅 gameplay phases 顯示 (lobby/ended 由 caller 不 render).
 */

interface PhaseInfoBannerProps {
  room: Room;
}

function joinSeats(playerIds: readonly string[], players: Record<string, unknown>): string {
  return playerIds
    .map((id) => seatOf(id, players))
    .filter((seat) => seat > 0)
    .map((seat) => displaySeatNumber(seat))
    .join('');
}

function seatLabel(playerId: string | undefined, players: Record<string, unknown>): string {
  if (!playerId) return '?';
  const seat = seatOf(playerId, players);
  return seat === 0 ? '?' : `${displaySeatNumber(seat)}家`;
}

export default function PhaseInfoBanner({ room }: PhaseInfoBannerProps): JSX.Element | null {
  const display = useMemo(() => {
    const players = room.players;
    const playerIds = Object.keys(players);
    const playerCount = playerIds.length;

    if (room.state === 'voting') {
      // 投票階段: 隊伍未選定 = 隊長選人; 隊伍已選 = 全員投票中.
      if (room.questTeam.length === 0) {
        const leaderId = playerIds[room.leaderIndex % Math.max(playerIds.length, 1)];
        const leader = seatLabel(leaderId, players);
        return `隊伍選擇: ${leader} 選人中`;
      }
      const teamStr = joinSeats(room.questTeam, players);
      const approvedCount = Object.values(room.votes).filter((v) => v === true).length;
      const submittedCount = Object.keys(room.votes).length;
      // 顯示已投人數 (不洩漏 approve/reject direction). approvedCount 算到 submitted
      // 為止, 雖然 spec 寫 approvedCount/playerCount, 但實際 chat 會 reveal 直到全員
      // 投完才公布 — 這裡退回顯示已投/總人數較不洩漏資訊.
      void approvedCount;
      return `投票中 (隊伍 ${teamStr}): ${submittedCount}/${playerCount} 已投`;
    }

    if (room.state === 'quest') {
      const teamStr = joinSeats(room.questTeam, players);
      const submitted = room.questVotedCount ?? 0;
      const total = room.questTeam.length;
      return `任務執行中 (隊伍 ${teamStr}): ${submitted}/${total} 已執行`;
    }

    if (room.state === 'lady_of_the_lake') {
      const holder = seatLabel(room.ladyOfTheLakeHolder, players);
      if (room.ladyOfTheLakeTarget) {
        const target = seatLabel(room.ladyOfTheLakeTarget, players);
        return `${holder} → ${target}: 等待宣告`;
      }
      return `${holder} 選湖目標`;
    }

    if (room.state === 'discussion') {
      // discussion phase = assassin 選擇刺殺目標.
      const assassinId = playerIds.find((id) => players[id]?.role === 'assassin');
      if (assassinId) {
        const seat = seatLabel(assassinId, players);
        return `刺客 ${seat} 選擇刺殺目標`;
      }
      return '刺客選擇刺殺目標';
    }

    return null;
  }, [
    room.state,
    room.questTeam,
    room.votes,
    room.leaderIndex,
    room.players,
    room.ladyOfTheLakeHolder,
    room.ladyOfTheLakeTarget,
    room.questVotedCount,
  ]);

  if (!display) return null;

  return (
    <div
      className="relative z-20 shrink-0 px-2 sm:px-3 py-1 bg-amber-900/30 border-y border-amber-700/60"
      data-testid="phase-info-banner"
      role="status"
      aria-live="polite"
    >
      <span className="block text-center text-[clamp(0.7rem,2.2vw,0.9rem)] font-semibold text-amber-100">
        {display}
      </span>
    </div>
  );
}
