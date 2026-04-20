import { Player } from '@avalon/shared';
import { motion } from 'framer-motion';
import { Crown, Shield, WifiOff } from 'lucide-react';

const ROLE_NAMES: Record<string, string> = {
  merlin:   '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal:    '忠臣 (Loyal Servant)',
  assassin: '刺客 (Assassin)',
  morgana:  '莫甘娜 (Morgana)',
  oberon:   '奧伯倫 (Oberon)',
  mordred:  '莫德雷德 (Mordred)',
  minion:   '爪牙 (Minion)',
};

interface PlayerCardProps {
  player: Player;
  isCurrentPlayer: boolean;
  hasVoted: boolean;
  voted?: boolean;
  isLeader?: boolean;
  isOnQuestTeam?: boolean;
  /** 1-indexed seat number shown as a gold badge on the avatar. */
  seatNumber?: number;
  /** Direction the card leans — affects inner flex order for the 5v5 rail layout. */
  side?: 'left' | 'right';
}

export default function PlayerCard({
  player,
  isCurrentPlayer,
  hasVoted,
  voted,
  isLeader = false,
  isOnQuestTeam = false,
  seatNumber,
  side = 'left',
}: PlayerCardProps): JSX.Element {
  // Horizontal row layout: left side → avatar on right edge (info-left), right side → avatar on left edge (info-right)
  const rowDirection = side === 'left' ? 'flex-row' : 'flex-row-reverse';
  const textAlign = side === 'left' ? 'text-right items-end' : 'text-left items-start';

  return (
    <motion.div
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      className={`relative flex ${rowDirection} items-center gap-2 w-full px-2 py-1.5 rounded-lg transition-colors ${
        isCurrentPlayer ? 'bg-yellow-500/10 ring-1 ring-yellow-400/60' : 'hover:bg-white/5'
      }`}
    >
      {/* Avatar with all status markers */}
      <div className="relative flex-shrink-0">
        <motion.div
          className={`w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center font-bold text-sm sm:text-base border-[3px] transition-all relative overflow-hidden ${
            player.status === 'disconnected'
              ? 'border-gray-600 bg-gradient-to-br from-gray-600 to-gray-700 opacity-50'
              : isCurrentPlayer
              ? 'border-yellow-400 bg-gradient-to-br from-yellow-400 to-yellow-500 shadow-lg shadow-yellow-400/50'
              : player.team === 'evil'
              ? 'border-red-500 bg-gradient-to-br from-red-500 to-red-700'
              : player.team === 'good'
              ? 'border-blue-500 bg-gradient-to-br from-blue-500 to-blue-700'
              : player.isBot
              ? 'border-slate-500 bg-gradient-to-br from-slate-600 to-slate-800'
              : 'border-gray-500 bg-gradient-to-br from-slate-500 to-slate-700'
          }`}
        >
          {player.isBot
            ? '🤖'
            : player.avatar
              ? <img src={player.avatar} alt={player.name} className="w-full h-full rounded-full object-cover" />
              : player.name.charAt(0).toUpperCase()
          }
        </motion.div>

        {/* Seat number badge — top-left gold circle with white number */}
        {seatNumber !== undefined && (
          <div
            className="absolute -top-1 -left-1 w-5 h-5 rounded-full bg-gradient-to-br from-yellow-400 to-yellow-600 border border-yellow-700 flex items-center justify-center shadow-md pointer-events-none"
            aria-label={`座位 ${seatNumber}`}
          >
            <span className="text-[10px] font-black text-white leading-none">{seatNumber}</span>
          </div>
        )}

        {/* Leader crown — top center above avatar */}
        {isLeader && (
          <motion.div
            initial={{ scale: 0, y: -5 }}
            animate={{ scale: 1, y: 0 }}
            className="absolute -top-3 left-1/2 -translate-x-1/2 pointer-events-none"
          >
            <Crown size={14} className="text-yellow-400 drop-shadow-md" />
          </motion.div>
        )}

        {/* Quest team shield — top-right gold shield */}
        {isOnQuestTeam && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-1 -right-1 bg-yellow-400 border border-yellow-600 rounded-full p-0.5 pointer-events-none shadow-md"
            aria-label="任務隊員"
          >
            <Shield size={10} className="text-yellow-900" fill="currentColor" />
          </motion.div>
        )}

        {/* Disconnected marker — bottom-left */}
        {player.status === 'disconnected' && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -bottom-1 -left-1 bg-red-700 rounded-full p-0.5 pointer-events-none"
          >
            <WifiOff size={9} className="text-white" />
          </motion.div>
        )}

        {/* Vote ball — bottom-right. White = approve, Black = reject, Gray = hidden */}
        {hasVoted && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full pointer-events-none shadow-md ${
              voted === undefined
                ? 'bg-gray-500 border-2 border-gray-300'
                : voted
                ? 'bg-white border-2 border-gray-300'
                : 'bg-gray-900 border-2 border-gray-700'
            }`}
            aria-label={voted === undefined ? '已投票' : voted ? '贊成' : '反對'}
          />
        )}
      </div>

      {/* Name + role/team info */}
      <div className={`flex-1 min-w-0 flex flex-col gap-0.5 ${textAlign}`}>
        <p
          className={`font-bold text-xs sm:text-sm truncate max-w-full ${
            player.status === 'disconnected' ? 'text-gray-500' : 'text-white'
          }`}
        >
          {player.name}
        </p>

        {/* Show own role + team inline — replaces the old absolutely-positioned hint */}
        {isCurrentPlayer && player.role && (
          <div className={`flex flex-wrap gap-1 ${side === 'left' ? 'justify-end' : 'justify-start'}`}>
            <span className="text-[9px] sm:text-[10px] font-semibold bg-yellow-600/90 text-white px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm">
              {ROLE_NAMES[player.role] ?? player.role}
            </span>
            {player.team && (
              <span
                className={`text-[9px] sm:text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                  player.team === 'good'
                    ? 'bg-blue-600/80 text-white'
                    : 'bg-red-600/80 text-white'
                }`}
              >
                {player.team === 'good' ? '⚔️ 好人' : '👹 邪惡'}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
