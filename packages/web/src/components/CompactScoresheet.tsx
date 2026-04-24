import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage, Room, Player } from '@avalon/shared';
import { ClipboardList, ChevronDown, ChevronUp } from 'lucide-react';
import { getSocket } from '../services/socket';
import FullScoresheetLayout from './FullScoresheetLayout';

interface CompactScoresheetProps {
  room: Room;
  currentPlayer: Player;
}

/**
 * CompactScoresheet — collapsible wrapper around {@link FullScoresheetLayout} (#83 Phase 2).
 *
 * Default: collapsed. Shows a 1-line summary ("{{quests}} 輪任務・{{votes}} 次投票・點擊展開")
 * that expands to the full scoresheet when tapped. Auto-expands when
 * `room.state === 'ended'` so the post-game review is instantly visible.
 *
 * 2026-04-24 Edward spec update: always use {@link FullScoresheetLayout} — even
 * during live play — so the mobile + desktop viewer sees the 4-block banner,
 * player ring and chat column the entire game, not just after `ended`. The
 * chat column pulls live socket messages into `liveMessages` so the right
 * panel stays in sync during play.
 *
 * Owns its own chrome (border + title strip + toggle button) so callers can drop
 * this in one line without an outer wrapper.
 */
export default function CompactScoresheet({ room, currentPlayer }: CompactScoresheetProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);

  // Auto-expand once the game ends so the final scoresheet is immediately visible.
  // Uses a ref-free useEffect because we only need one flip per ended-state
  // transition; users can still collapse manually afterward.
  useEffect(() => {
    if (room.state === 'ended') {
      setExpanded(true);
    }
  }, [room.state]);

  // Live chat listener so the full layout's right-column chat reflects
  // in-game messages as they arrive. Mirrors ChatPanel's subscription
  // pattern; a second listener on the same event is harmless since socket.io
  // fans out to every .on() callback.
  useEffect(() => {
    let socket: ReturnType<typeof getSocket> | null = null;
    try {
      socket = getSocket();
    } catch {
      return;
    }

    const handler = (msg: ChatMessage) => {
      setLiveMessages(prev => [...prev, msg]);
    };

    socket.on('chat:message-received', handler);
    return () => { socket!.off('chat:message-received', handler); };
  }, []);

  const questCount = room.questHistory.length;
  const voteCount = room.voteHistory.length;
  const summary = t('game:scoresheet.collapsedSummary', { quests: questCount, votes: voteCount });
  const collapseLabel = t('game:scoresheet.expanded');

  return (
    <div className="bg-avalon-card/50 border border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(prev => !prev)}
        className="w-full px-3 py-2 border-b border-gray-700/50 flex items-center justify-between text-left hover:bg-avalon-card/70 transition-colors"
        aria-expanded={expanded}
        aria-controls="compact-scoresheet-body"
      >
        <span className="text-sm font-bold text-gray-300 flex items-center gap-1.5">
          <ClipboardList size={14} className="-mt-0.5" />
          {t('game:scoresheet.title')}
        </span>
        <span className="text-[10px] text-gray-500 flex items-center gap-1">
          {expanded ? (
            <>
              <span>{collapseLabel}</span>
              <ChevronUp size={12} />
            </>
          ) : (
            <>
              <span>{summary}</span>
              <ChevronDown size={12} />
            </>
          )}
        </span>
      </button>

      {expanded && (
        <div id="compact-scoresheet-body" className="px-2 sm:px-3 py-2">
          {/*
            2026-04-24 Edward spec: live + ended both use the full replay-style
            layout (banner + player ring + chat log) so the mobile view matches
            the reference image the whole game. During live play `liveMessages`
            feeds the chat column; after `ended` the same component keeps
            rendering (messages stay cached).
          */}
          <FullScoresheetLayout
            room={room}
            currentPlayer={currentPlayer}
            messages={liveMessages}
          />
        </div>
      )}
    </div>
  );
}
