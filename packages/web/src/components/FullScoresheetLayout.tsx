import { useMemo, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { ChatMessage, Room, Player } from '@avalon/shared';
import LiveScoresheet from './LiveScoresheet';
import QuestResultBanner from './QuestResultBanner';
import PlayerRing from './PlayerRing';
import ScoresheetChatPanel, { SystemChatEntry } from './ScoresheetChatPanel';
import { displaySeatNumber } from '../utils/seatDisplay';

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
 *   ├──────────┬────────────────────────┬──────────────┤
 *   │          │                        │              │
 *   │ 0 seat   │                        │ 1 seat       │
 *   │ 9 seat   │   LiveScoresheet       │ 2 seat       │
 *   │ 8 seat   │   (existing matrix)    │ 3 seat       │
 *   │ 7 seat   │                        │ 4 seat       │
 *   │ 6 seat   │                        │ 5 seat       │
 *   │ (ring)   │                        │ (ring)       │
 *   ├──────────┴────────────────────────┴──────────────┤
 *   │                           ScoresheetChatPanel    │  ← lg+ only
 *   └──────────────────────────────────────────────────┘
 *
 * Responsive behaviour:
 *   - lg (>=1024px): 2-column grid — scoresheet+ring on the left,
 *     ScoresheetChatPanel permanently mounted on the right.
 *   - <lg mobile/tablet: chat column collapses behind a floating toggle
 *     ("對話紀錄") so the matrix has full width. Tapping opens a drawer
 *     overlay with the same ScoresheetChatPanel.
 *   - Matrix container allows horizontal scroll if the 10-seat width ever
 *     exceeds the viewport.
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
  // were provided by the caller. Each entry summarises the round/attempt
  // approval count so the replay viewer has something to read.
  const defaultSystemEntries = useMemo<SystemChatEntry[]>(() => {
    if (systemEntries) return systemEntries;
    return room.voteHistory.map((v, idx) => {
      const approveCount = Object.values(v.votes).filter(Boolean).length;
      const totalVotes = Object.values(v.votes).length;
      return {
        id: `sys-vote-${v.round}-${v.attempt}-${idx}`,
        timestamp: room.createdAt + idx * 1000,
        text: `系統：${v.round}-${v.attempt}, 贊成 ${approveCount}/${totalVotes}, ${v.approved ? '通過' : '否決'}`,
      };
    });
  }, [room.voteHistory, room.createdAt, systemEntries]);

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

      {/* Middle: ring (seats) + scoresheet (centre) + chat (right on lg+) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-3 sm:gap-4 items-start">
        <PlayerRing
          playerIds={playerIds}
          players={room.players}
          currentPlayerId={currentPlayer.id}
        >
          <div className="bg-black/40 rounded border border-gray-700/50 p-1 sm:p-2 overflow-x-auto">
            <LiveScoresheet room={room} currentPlayer={currentPlayer} />
          </div>
        </PlayerRing>

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
