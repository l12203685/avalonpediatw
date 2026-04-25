import { useMemo, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { ChatMessage, Room, Player } from '@avalon/shared';
import LiveScoresheet from './LiveScoresheet';
import QuestResultBanner from './QuestResultBanner';
import ScoresheetChatPanel, { SystemChatEntry } from './ScoresheetChatPanel';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';

/**
 * Sort seats in canonical Avalon order — 1..9 ascending, with seat 10 last
 * (rendered as "0"). Mirrors the convention used in PlayerRing / shield cells:
 * `[10, 1, 5, 3] -> [1, 3, 5, 10]` -> displayed as "1350".
 *
 * Returns the concatenated digit string (no separator) so it matches the
 * scoresheet shorthand Edward uses verbally ("派 134" / "派 2680").
 */
function formatSeatsDigitString(seats: number[]): string {
  const sorted = [...seats].sort((a, b) => a - b);
  return sorted.map(displaySeatNumber).join('');
}

/**
 * Format anomaly votes for the chat log. "Inner black" = team members who
 * voted reject; "outer white" = non-team members who voted approve. Both lists
 * render as a digit string + sign, separated by a space:
 *
 *   formatAnomalyVotes([5], [7])     -> "5- 7+"
 *   formatAnomalyVotes([], [3,6,8])  -> "368+"
 *   formatAnomalyVotes([], [])       -> ""  (caller substitutes "無異常")
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
  /** Chat messages for the right-side log (optional — defaults to empty). */
  messages?: ChatMessage[];
  /**
   * System entries (異常票 / 投票結果) for the chat log. In replay mode the
   * caller can synthesise these from voteHistory; in live mode they can be
   * left empty.
   */
  systemEntries?: SystemChatEntry[];
}

/**
 * FullScoresheetLayout — the full scoresheet view that mirrors Edward's
 * 2026-04-24 reference image. Used live + replay so the mobile player sees
 * the full-paper layout the whole game.
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  [OXX] [OOOX] [OOOO] [OOOOO] [_]                 │  ← QuestResultBanner
 *   ├──────────────────────────────────┬───────────────┤
 *   │                                  │               │
 *   │                                  │               │
 *   │        LiveScoresheet            │  Chat panel   │
 *   │        (existing matrix)         │  (lg+ only)   │
 *   │                                  │               │
 *   │                                  │               │
 *   └──────────────────────────────────┴───────────────┘
 *
 * Responsive behaviour:
 *   - lg (>=1024px): 2-column grid — scoresheet on the left,
 *     ScoresheetChatPanel permanently mounted on the right.
 *   - <lg mobile/tablet: chat column collapses behind a floating toggle
 *     ("對話紀錄") so the matrix has full width. Tapping opens a drawer
 *     overlay with the same ScoresheetChatPanel.
 *   - Matrix container allows horizontal scroll if the 10-seat width ever
 *     exceeds the viewport.
 *
 * 2026-04-24 Edward: outer PlayerRing (seat labels + names) removed — shield
 * cells inside the matrix already carry seat numbers, so the outer ring was
 * redundant and crowded the layout on mobile.
 */
export default function FullScoresheetLayout({
  room,
  currentPlayer,
  messages = [],
  systemEntries,
}: FullScoresheetLayoutProps): JSX.Element {
  const playerIds = useMemo(() => Object.keys(room.players), [room.players]);
  const [chatOpenMobile, setChatOpenMobile] = useState<boolean>(false);

  // Build a seat-label lookup for the chat panel so player names render
  // as "1: …" / "0: …" (seat 10 shown as 0) instead of raw usernames.
  const seatLabel = useMemo(() => {
    const map = new Map<string, string>();
    playerIds.forEach((pid, i) => map.set(pid, displaySeatNumber(i + 1)));
    return (pid: string): string => map.get(pid) ?? '?';
  }, [playerIds]);

  // Default: synthesise minimal system entries from voteHistory if none
  // were provided by the caller. Each entry summarises the round/attempt with
  //   - 隊伍組合 (team digit string in canonical order, e.g. "134" for seats 1,3,4)
  //   - 異常票 (inner-black "<seats>-" / outer-white "<seats>+", or "無異常")
  // so the replay viewer can read team composition + cross-faction signals
  // without flipping back to the matrix (Edward 2026-04-25 spec).
  const defaultSystemEntries = useMemo<SystemChatEntry[]>(() => {
    if (systemEntries) return systemEntries;
    return room.voteHistory.map((v, idx) => {
      const approveCount = Object.values(v.votes).filter(Boolean).length;
      const totalVotes = Object.values(v.votes).length;

      // Team composition — display in canonical seat order ("134" / "2680").
      const teamSeats = v.team
        .map((pid) => seatOf(pid, room.players))
        .filter((s) => s > 0);
      const teamDigits = formatSeatsDigitString(teamSeats);

      // Anomaly votes: split voters into team/non-team and approve/reject.
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
  }, [room.voteHistory, room.players, room.createdAt, systemEntries]);

  const chatPanel = (
    <ScoresheetChatPanel
      messages={messages}
      systemEntries={defaultSystemEntries}
      seatLabel={seatLabel}
    />
  );

  return (
    <div className="w-full flex flex-col gap-3 sm:gap-4 relative">
      {/* Top: 4-block quest result banner */}
      <QuestResultBanner
        questHistory={room.questHistory}
        playerCount={playerIds.length}
        maxRounds={5}
      />

      {/* Middle: scoresheet (centre) + chat (right on lg+). PlayerRing removed
          2026-04-24 — shield cells already show seat numbers inside the matrix. */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-3 sm:gap-4 items-start">
        <div className="bg-black/40 rounded border border-gray-700/50 p-1 sm:p-2 overflow-x-auto">
          <LiveScoresheet room={room} currentPlayer={currentPlayer} />
        </div>

        {/* Chat panel — right column on lg+ desktop only. Drawer on mobile. */}
        <div className="hidden lg:block">
          {chatPanel}
        </div>
      </div>

      {/* Mobile / tablet: floating chat toggle (bottom-right above Edward chat bubble) */}
      <button
        type="button"
        onClick={() => setChatOpenMobile(true)}
        className="lg:hidden fixed bottom-20 right-3 z-40 bg-lime-800/90 hover:bg-lime-700 text-lime-50 text-xs font-bold px-3 py-2 rounded-full shadow-lg flex items-center gap-1 border border-lime-500/50"
        aria-label="開啟對話紀錄"
      >
        <MessageSquare size={14} />
        <span>對話紀錄</span>
      </button>

      {/* Mobile drawer overlay — tap backdrop to close. */}
      {chatOpenMobile && (
        <div
          className="lg:hidden fixed inset-0 z-50 flex"
          role="dialog"
          aria-modal="true"
          aria-label="對話紀錄"
        >
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setChatOpenMobile(false)}
          />
          <div className="relative ml-auto w-[85%] max-w-[340px] h-full bg-avalon-card border-l border-lime-800/40 shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
              <span className="text-sm font-bold text-lime-200">對話紀錄</span>
              <button
                type="button"
                onClick={() => setChatOpenMobile(false)}
                className="text-gray-400 hover:text-white"
                aria-label="關閉對話紀錄"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {chatPanel}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
