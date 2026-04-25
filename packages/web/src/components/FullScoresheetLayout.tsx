import { useMemo } from 'react';
import { ChatMessage, Room, Player } from '@avalon/shared';
import LiveScoresheet from './LiveScoresheet';
import QuestResultBanner from './QuestResultBanner';
import { SystemChatEntry } from './ScoresheetChatPanel';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';

/**
 * Sort seats in canonical Avalon order — 1..9 ascending, with seat 10 last
 * (rendered as "0"). Mirrors the convention used in PlayerRing / shield cells.
 */
function formatSeatsDigitString(seats: number[]): string {
  const sorted = [...seats].sort((a, b) => a - b);
  return sorted.map(displaySeatNumber).join('');
}

/**
 * Format anomaly votes for the chat log. "Inner black" = team members who
 * voted reject; "outer white" = non-team members who voted approve.
 */
function formatAnomalyVotes(innerBlack: number[], outerWhite: number[]): string {
  const parts: string[] = [];
  if (innerBlack.length > 0) parts.push(`${formatSeatsDigitString(innerBlack)}-`);
  if (outerWhite.length > 0) parts.push(`${formatSeatsDigitString(outerWhite)}+`);
  return parts.join(' ');
}

interface FullScoresheetLayoutProps {
  room: Room;
  currentPlayer: Player;
  /**
   * Chat messages for the right-side log. **Deprecated since 2026-04-25** —
   * the chat panel was removed from this layout and consolidated into the
   * single inline ChatPanel in GamePage's center column (Edward「兩個對話
   * 紀錄窗還是分開」). Prop is kept on the interface so existing call sites
   * (CompactScoresheet) continue to compile until they are cleaned up.
   */
  messages?: ChatMessage[];
  /**
   * Synthesised system entries — also kept for back-compat. The unified
   * ChatPanel now derives equivalent entries from `room.voteHistory` itself,
   * so this layout no longer renders them.
   */
  systemEntries?: SystemChatEntry[];
}

/**
 * FullScoresheetLayout — replay-style scoresheet. Renders the 4-block quest
 * banner on top and the live scoresheet matrix below.
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  [OXX] [OOOX] [OOOO] [OOOOO] [_]                 │  ← QuestResultBanner
 *   ├──────────────────────────────────────────────────┤
 *   │                                                  │
 *   │              LiveScoresheet                      │
 *   │              (existing matrix)                   │
 *   │                                                  │
 *   └──────────────────────────────────────────────────┘
 *
 * 2026-04-25 redesign: the right-column ScoresheetChatPanel + mobile chat
 * drawer were removed because they duplicated the inline ChatPanel in
 * GamePage's center column. Edward 14:35「兩個對話紀錄窗還是分開」 — the
 * unified ChatPanel now carries both system events and player messages on
 * one timeline, so a second log here was confusing the player. Matrix gets
 * the full width on every breakpoint now.
 *
 * 2026-04-24 Edward: outer PlayerRing (seat labels + names) removed — shield
 * cells inside the matrix already carry seat numbers.
 */
export default function FullScoresheetLayout({
  room,
  currentPlayer,
  messages: _unusedMessages,
  systemEntries: _unusedSystemEntries,
}: FullScoresheetLayoutProps): JSX.Element {
  // Synthesise system entries internally just to mirror what the unified chat
  // shows, in case future variants of this layout want to surface them again
  // (e.g. printable replay export). Kept memoised but currently unused.
  const _systemEntries = useMemo<SystemChatEntry[]>(() => {
    return room.voteHistory.map((v, idx) => {
      const approveCount = Object.values(v.votes).filter(Boolean).length;
      const totalVotes = Object.values(v.votes).length;

      const teamSeats = v.team
        .map((pid) => seatOf(pid, room.players))
        .filter((s) => s > 0);
      const teamDigits = formatSeatsDigitString(teamSeats);

      const teamSet = new Set(v.team);
      const innerBlackSeats: number[] = [];
      const outerWhiteSeats: number[] = [];
      Object.entries(v.votes).forEach(([pid, approve]) => {
        const seat = seatOf(pid, room.players);
        if (seat <= 0) return;
        const onTeam = teamSet.has(pid);
        if (onTeam && !approve) innerBlackSeats.push(seat);
        else if (!onTeam && approve) outerWhiteSeats.push(seat);
      });
      const anomaly = formatAnomalyVotes(innerBlackSeats, outerWhiteSeats);

      const leaderSeat = seatOf(v.leader, room.players);
      const leaderLabel = leaderSeat > 0 ? displaySeatNumber(leaderSeat) : '?';
      const result = v.approved ? '通過' : '否決';

      return {
        id: `sys-vote-${v.round}-${v.attempt}-${idx}`,
        timestamp: room.createdAt + idx * 1000,
        text: `系統：${v.round}-${v.attempt}，隊長 ${leaderLabel} 派 ${teamDigits}，贊成 ${approveCount}/${totalVotes}（${anomaly || '無異常'}），${result}`,
      };
    });
  }, [room.voteHistory, room.players, room.createdAt]);

  return (
    <div className="w-full flex flex-col gap-3 sm:gap-4">
      {/* Top: 4-block quest result banner */}
      <QuestResultBanner
        questHistory={room.questHistory}
        playerCount={Object.keys(room.players).length}
        maxRounds={5}
      />

      {/* Matrix — full width now that the chat column was lifted into the
          unified ChatPanel above. Horizontal scroll preserved for narrow
          viewports where 10 seats may exceed width. */}
      <div className="bg-black/40 rounded border border-gray-700/50 p-1 sm:p-2 overflow-x-auto">
        <LiveScoresheet room={room} currentPlayer={currentPlayer} />
      </div>
    </div>
  );
}
