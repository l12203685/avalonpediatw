import { useMemo } from 'react';
import { ChatMessage } from '@avalon/shared';

/**
 * ScoresheetChatPanel — right-rail chat log inside the full scoresheet view.
 *
 * 2026-04-25 stub: built to unblock the FullScoresheetLayout build chain
 * (commit 58f1b51a left dangling imports). Real implementation will render a
 * full chat transcript with seat-prefixed names, system entries summarising
 * 隊伍組成 + 異常票, and live scroll-to-bottom behaviour.
 *
 * Renders a minimal merged feed (system entries + player messages, sorted
 * by timestamp) so replay viewers can already see vote summaries inline
 * with chat. Polish (colour, theming, virtualisation) to follow.
 */

export interface SystemChatEntry {
  id: string;
  timestamp: number;
  text: string;
}

interface ScoresheetChatPanelProps {
  messages: ChatMessage[];
  systemEntries: SystemChatEntry[];
  seatLabel: (playerId: string) => string;
}

interface MergedEntry {
  id: string;
  timestamp: number;
  kind: 'system' | 'message';
  text: string;
  seat?: string;
  playerName?: string;
}

export default function ScoresheetChatPanel({
  messages,
  systemEntries,
  seatLabel,
}: ScoresheetChatPanelProps): JSX.Element {
  const merged = useMemo<MergedEntry[]>(() => {
    const out: MergedEntry[] = [];
    for (const s of systemEntries) {
      out.push({
        id: s.id,
        timestamp: s.timestamp,
        kind: 'system',
        text: s.text,
      });
    }
    for (const m of messages) {
      out.push({
        id: m.id,
        timestamp: m.timestamp,
        kind: 'message',
        text: m.message,
        seat: seatLabel(m.playerId),
        playerName: m.playerName,
      });
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }, [messages, systemEntries, seatLabel]);

  return (
    <div
      className="w-full h-full max-h-[60vh] lg:max-h-none lg:h-[600px] flex flex-col bg-black/30 border border-gray-700/50 rounded p-2 text-xs"
      data-testid="scoresheet-chat-panel-stub"
    >
      <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1 px-1">
        對話紀錄
      </div>
      <div className="flex-1 overflow-y-auto space-y-1 px-1">
        {merged.length === 0 ? (
          <div className="text-gray-500 italic">（尚無紀錄）</div>
        ) : (
          merged.map((e) =>
            e.kind === 'system' ? (
              <div
                key={e.id}
                className="text-lime-300/80 text-[11px] leading-snug"
              >
                {e.text}
              </div>
            ) : (
              <div key={e.id} className="text-gray-200 leading-snug">
                <span className="text-amber-300 font-mono mr-1">
                  {e.seat ?? '?'}:
                </span>
                {e.text}
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

export { ScoresheetChatPanel };
