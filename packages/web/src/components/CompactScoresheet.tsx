import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Room, Player } from '@avalon/shared';
import { ClipboardList, ChevronDown, ChevronUp } from 'lucide-react';
import LiveScoresheet from './LiveScoresheet';

interface CompactScoresheetProps {
  room: Room;
  currentPlayer: Player;
}

/**
 * CompactScoresheet — collapsible wrapper around {@link LiveScoresheet} (#83 Phase 2).
 *
 * Default: collapsed. Shows a 1-line summary ("{{quests}} 輪任務・{{votes}} 次投票・點擊展開")
 * that expands to the full live scoresheet when tapped. Auto-expands when
 * `room.state === 'ended'` so the post-game review is instantly visible.
 *
 * Owns its own chrome (border + title strip + toggle button) so callers can drop
 * this in one line without an outer wrapper.
 */
export default function CompactScoresheet({ room, currentPlayer }: CompactScoresheetProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [expanded, setExpanded] = useState<boolean>(false);

  // Auto-expand once the game ends so the final scoresheet is immediately visible.
  // Uses a ref-free useEffect because we only need one flip per ended-state
  // transition; users can still collapse manually afterward.
  useEffect(() => {
    if (room.state === 'ended') {
      setExpanded(true);
    }
  }, [room.state]);

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
          <LiveScoresheet room={room} currentPlayer={currentPlayer} />
        </div>
      )}
    </div>
  );
}
