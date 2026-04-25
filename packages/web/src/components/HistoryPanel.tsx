import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Room, Player, VoteRecord } from '@avalon/shared';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { displaySeatNumber, seatOf } from '../utils/seatDisplay';
import { getVoteTokenImage } from '../utils/avalonAssets';

interface HistoryPanelProps {
  room: Room;
  currentPlayer: Player;
}

export default function HistoryPanel({ room, currentPlayer }: HistoryPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [expandedVote, setExpandedVote] = useState<number | null>(null);

  const { voteHistory, questHistory } = room;

  if (voteHistory.length === 0 && questHistory.length === 0) return <></>;

  // Group vote records by round for display
  const votesByRound = voteHistory.reduce<Record<number, VoteRecord[]>>((acc, v) => {
    if (!acc[v.round]) acc[v.round] = [];
    acc[v.round].push(v);
    return acc;
  }, {});

  // Edward 2026-04-25: 「資訊視窗一律改成座位號碼」 — history panel now
  // shows seat-only (a bare digit 1..9, "0" for seat 10), no player display
  // name. Seat 10 renders as "0" via displaySeatNumber (#93 paper-scoresheet
  // convention).
  // Edward 2026-04-25 21:59 撤回「家」suffix — 純數字。
  const getSeatName = (id: string): string => {
    const seat = seatOf(id, room.players);
    return seat === 0 ? '?' : displaySeatNumber(seat);
  };

  return (
    <div className="bg-avalon-card/50 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-300">歷史紀錄</span>
          <span className="text-xs text-gray-500">
            {questHistory.length} 輪任務・{voteHistory.length} 次投票
          </span>
        </div>
        {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4 max-h-96 overflow-y-auto">
              {Object.entries(votesByRound)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([roundStr, votes]) => {
                  const round = Number(roundStr);
                  const questResult = questHistory.find(q => q.round === round);

                  return (
                    <div key={round} className="space-y-2">
                      {/* Round header */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                          第 {round} 輪 (Round {round})
                        </span>
                        {questResult && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                            questResult.result === 'success'
                              ? 'bg-blue-900/60 text-blue-300'
                              : 'bg-red-900/60 text-red-300'
                          }`}>
                            {questResult.result === 'success' ? '✓ 任務成功' : '✗ 任務失敗'}
                            {questResult.result === 'fail' && ` (${questResult.failCount} fail)`}
                          </span>
                        )}
                        {questResult && (
                          <span className="text-xs text-gray-600">
                            隊伍：{questResult.team.map(getSeatName).join('、')}
                          </span>
                        )}
                      </div>

                      {/* Vote attempts for this round */}
                      {votes.map((vote, vi) => {
                        const key = round * 10 + vi;
                        const isOpen = expandedVote === key;

                        return (
                          <div key={vi} className={`rounded-lg border text-xs ${
                            vote.approved
                              ? 'border-blue-700/50 bg-blue-950/20'
                              : 'border-red-800/40 bg-red-950/10'
                          }`}>
                            {/* Vote summary row */}
                            <button
                              onClick={() => setExpandedVote(isOpen ? null : key)}
                              className="w-full flex items-center justify-between px-3 py-2 text-left"
                            >
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-gray-400">
                                  隊長：<span className="text-yellow-400 font-bold">{getSeatName(vote.leader)}</span>
                                </span>
                                <span className="text-gray-500">→</span>
                                <span className="text-gray-300">
                                  {vote.team.map(getSeatName).join('、')}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                                <span className={`font-bold ${vote.approved ? 'text-blue-400' : 'text-red-400'}`}>
                                  {vote.approved ? '通過' : '否決'}
                                </span>
                                <span className="text-gray-600">
                                  {Object.values(vote.votes).filter(Boolean).length}/{Object.values(vote.votes).length}
                                </span>
                                {isOpen ? <ChevronUp size={12} className="text-gray-500" /> : <ChevronDown size={12} className="text-gray-500" />}
                              </div>
                            </button>

                            {/* Individual votes */}
                            <AnimatePresence>
                              {isOpen && (
                                <motion.div
                                  initial={{ height: 0 }}
                                  animate={{ height: 'auto' }}
                                  exit={{ height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="px-3 pb-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
                                    {Object.entries(vote.votes)
                                      .sort(([a], [b]) => (vote.votes[b] ? 1 : 0) - (vote.votes[a] ? 1 : 0))
                                      .map(([pid, approved]) => (
                                        <div
                                          key={pid}
                                          className={`flex items-center gap-1 px-2 py-1 rounded ${
                                            pid === currentPlayer.id
                                              ? 'ring-1 ring-yellow-500/50'
                                              : ''
                                          } ${approved ? 'text-blue-300' : 'text-red-400'}`}
                                        >
                                          {/* Edward 2026-04-25 emoji→image: 黑白球投票圖
                                              取代 👍/👎 emoji，與 #154 VoteAnalysisPanel
                                              黑白球視覺統一。 */}
                                          <img
                                            src={getVoteTokenImage(approved ? 'approve' : 'reject')}
                                            alt=""
                                            aria-hidden="true"
                                            className="w-3.5 h-3.5 object-contain flex-shrink-0"
                                            draggable={false}
                                          />
                                          <span className="truncate">{getSeatName(pid)}</span>
                                          {pid === currentPlayer.id && <span className="text-yellow-500 text-xs">(你)</span>}
                                        </div>
                                      ))}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
