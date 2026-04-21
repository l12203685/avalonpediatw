import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Room, Player } from '@avalon/shared';
import { useTranslation } from 'react-i18next';

interface VoteAnalysisPanelProps {
  room: Room;
  currentPlayer: Player;
}

const GOOD_ROLES = new Set(['merlin', 'percival', 'loyal']);

export default function VoteAnalysisPanel({ room, currentPlayer }: VoteAnalysisPanelProps): JSX.Element {
  const { t } = useTranslation(['game']);
  const [open, setOpen] = useState(false);

  const roleLabel = (role: string | undefined): string => {
    if (!role) return '?';
    const key = `game:role.${role}`;
    const translated = t(key);
    return translated === key ? role : translated;
  };

  if (room.voteHistory.length === 0) return <></>;

  const players = Object.values(room.players);

  // Sort: good team first, then evil — interesting to see alignment vs. behaviour
  const sorted = [...players].sort((a, b) => {
    const aGood = GOOD_ROLES.has(a.role ?? '') ? 0 : 1;
    const bGood = GOOD_ROLES.has(b.role ?? '') ? 0 : 1;
    return aGood - bGood;
  });

  return (
    <div className="bg-gray-900/50 border border-gray-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-700/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gray-300">{t('game:voteAnalysis.title')}</span>
          <span className="text-xs text-gray-600">{t('game:voteAnalysis.proposalCount', { count: room.voteHistory.length })}</span>
        </div>
        {open ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-5 space-y-5">

              {/* ── Per-player stats ── */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[340px]">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-700/60">
                      <th className="text-left py-1.5 pr-2 font-semibold">{t('game:voteAnalysis.colPlayer')}</th>
                      <th className="text-left py-1.5 pr-2 font-semibold">{t('game:voteAnalysis.colRole')}</th>
                      <th className="text-center py-1.5 px-1 font-semibold">{t('game:voteAnalysis.colApproveRate')}</th>
                      <th className="text-center py-1.5 px-1 font-semibold">{t('game:voteAnalysis.colLeaderCount')}</th>
                      <th className="text-center py-1.5 px-1 font-semibold">{t('game:voteAnalysis.colQuestCount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(player => {
                      const isGood = GOOD_ROLES.has(player.role ?? '');
                      const votes = room.voteHistory.map(v => v.votes[player.id]);
                      const cast   = votes.filter(v => v !== undefined);
                      const approves = cast.filter(v => v === true).length;
                      const leaderCount = room.voteHistory.filter(v => v.leader === player.id).length;
                      const questCount  = room.questHistory.filter(q => q.team.includes(player.id)).length;
                      const isMe = player.id === currentPlayer.id;

                      return (
                        <tr
                          key={player.id}
                          className={`border-b border-gray-800/40 ${isMe ? 'bg-yellow-900/10' : ''}`}
                        >
                          <td className="py-1.5 pr-2 font-semibold text-white whitespace-nowrap">
                            {player.name}
                            {isMe && <span className="text-yellow-500 text-xs ml-1">{t('game:voteAnalysis.youSuffix')}</span>}
                          </td>
                          <td className={`py-1.5 pr-2 whitespace-nowrap ${isGood ? 'text-blue-400' : 'text-red-400'}`}>
                            {roleLabel(player.role ?? undefined)}
                          </td>
                          <td className="py-1.5 px-1 text-center text-gray-300">
                            {cast.length > 0
                              ? <span className={approves / cast.length > 0.7 ? 'text-blue-400' : approves / cast.length < 0.35 ? 'text-red-400' : 'text-gray-300'}>
                                  {approves}/{cast.length}
                                </span>
                              : <span className="text-gray-600">—</span>}
                          </td>
                          <td className="py-1.5 px-1 text-center text-gray-400">
                            {leaderCount > 0 ? leaderCount : <span className="text-gray-600">—</span>}
                          </td>
                          <td className="py-1.5 px-1 text-center text-gray-400">
                            {questCount > 0 ? questCount : <span className="text-gray-600">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Vote matrix ── */}
              <div>
                <p className="text-xs text-gray-600 mb-2 font-semibold uppercase tracking-wider">
                  {t('game:voteAnalysis.matrixTitle')}
                </p>
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr>
                        {/* player name column */}
                        <th className="text-left pr-3 pb-1.5 text-gray-600 font-normal whitespace-nowrap" style={{ minWidth: 72 }}>
                          {t('game:voteAnalysis.matrixHeader')}
                        </th>
                        {room.voteHistory.map((v, i) => (
                          <th key={i} className="text-center px-1 pb-1.5" style={{ minWidth: 34 }}>
                            <div className="text-gray-600 leading-none">{t('game:voteAnalysis.roundPrefix', { round: v.round })}</div>
                            <div className={`font-bold leading-none mt-0.5 ${v.approved ? 'text-blue-400' : 'text-red-400'}`}>
                              {v.approved ? '✓' : '✗'}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map(player => {
                        const isGood = GOOD_ROLES.has(player.role ?? '');
                        const isMe   = player.id === currentPlayer.id;
                        return (
                          <tr key={player.id} className={isMe ? 'bg-yellow-900/10 rounded' : ''}>
                            <td className={`pr-3 py-0.5 font-semibold whitespace-nowrap ${isGood ? 'text-blue-300' : 'text-red-300'}`}>
                              {player.name.length > 7 ? player.name.slice(0, 7) + '…' : player.name}
                            </td>
                            {room.voteHistory.map((v, i) => {
                              const vote = v.votes[player.id];
                              const isLeader = v.leader === player.id;
                              return (
                                <td
                                  key={i}
                                  title={isLeader ? t('game:voteAnalysis.matrixTeamTooltip', { team: v.team.map(id => room.players[id]?.name ?? id).join('、') }) : undefined}
                                  className={`text-center px-1 py-0.5 ${isLeader ? 'ring-1 ring-yellow-500/40 rounded bg-yellow-900/10' : ''}`}
                                >
                                  {vote === undefined ? (
                                    <span className="text-gray-700">·</span>
                                  ) : (
                                    <span className={vote ? 'text-blue-400' : 'text-red-400'}>
                                      {vote ? '👍' : '👎'}
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-700 mt-2">
                  {t('game:voteAnalysis.matrixLegend')}
                </p>
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
