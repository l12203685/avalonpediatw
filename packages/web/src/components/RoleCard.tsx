import { motion } from 'framer-motion';
import { Info, Shield, Zap } from 'lucide-react';
import { useState } from 'react';

interface RoleCardProps {
  role: string;
  team: 'good' | 'evil';
  abilities: string[];
  description: string;
  winCondition: string;
  tips: string[];
  isExpanded?: boolean;
  onHover?: (isHovering: boolean) => void;
}

const ROLE_ICONS: Record<string, string> = {
  merlin: '🧙',
  percival: '🛡️',
  loyal: '⚔️',
  assassin: '🗡️',
  morgana: '👑',
  oberon: '👻',
};

const ROLE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  merlin: { bg: 'from-blue-900 to-blue-700', border: 'border-blue-500', text: 'text-blue-400' },
  percival: { bg: 'from-blue-900 to-sky-800', border: 'border-sky-500', text: 'text-sky-400' },
  loyal: { bg: 'from-blue-900 to-blue-800', border: 'border-blue-500', text: 'text-blue-300' },
  assassin: { bg: 'from-red-900 to-red-700', border: 'border-red-500', text: 'text-red-400' },
  morgana: { bg: 'from-red-900 to-rose-800', border: 'border-rose-500', text: 'text-rose-400' },
  oberon: { bg: 'from-slate-900 to-slate-700', border: 'border-slate-500', text: 'text-slate-300' },
};

export default function RoleCard({
  role,
  team,
  abilities,
  description,
  winCondition,
  tips,
  isExpanded = false,
  onHover,
}: RoleCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(isExpanded);
  const colors = ROLE_COLORS[role.toLowerCase()] || ROLE_COLORS.loyal;
  const icon = ROLE_ICONS[role.toLowerCase()] || '👤';

  const handleHover = (isHovering: boolean) => {
    setExpanded(isHovering);
    onHover?.(isHovering);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.05 }}
      onHoverStart={() => handleHover(true)}
      onHoverEnd={() => handleHover(false)}
      className={`relative group cursor-pointer`}
    >
      {/* Animated background glow */}
      <motion.div
        className={`absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl ${
          team === 'good' ? 'bg-blue-500' : 'bg-red-500'
        }`}
        style={{ zIndex: -1 }}
      />

      {/* Main card */}
      <motion.div
        animate={{ height: expanded ? 'auto' : '280px' }}
        className={`bg-gradient-to-br ${colors.bg} border-2 ${colors.border} rounded-xl p-6 overflow-hidden transition-all duration-300`}
      >
        {/* Header */}
        <div className="flex items-center gap-4 mb-4">
          <motion.div className="text-5xl">{icon}</motion.div>
          <div className="flex-1">
            <h3 className={`text-2xl font-bold capitalize ${colors.text}`}>{role}</h3>
            <p className="text-gray-300 text-sm">
              {team === 'good' ? '🔵 好人陣營 (Good)' : '🔴 邪惡陣營 (Evil)'}
            </p>
          </div>
        </div>

        {/* Divider */}
        <div className={`h-px bg-gradient-to-r from-transparent ${colors.border} to-transparent mb-4`} />

        {/* Description */}
        <p className="text-gray-200 text-sm mb-4 line-clamp-2">{description}</p>

        {/* Team badge */}
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className={colors.text} />
          <span className="text-xs text-gray-300">{team === 'good' ? '忠誠 (Loyal)' : '欺騙 (Deceptive)'}</span>
        </div>

        {/* Quick abilities preview */}
        <div className="space-y-2 mb-4">
          {abilities.slice(0, 2).map((ability, idx) => (
            <motion.div
              key={idx}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.1 }}
              className="flex items-center gap-2"
            >
              <Zap size={14} className="text-yellow-400" />
              <span className="text-xs text-gray-300">{ability}</span>
            </motion.div>
          ))}
        </div>

        {/* Win condition (expanded) */}
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: expanded ? 1 : 0, height: expanded ? 'auto' : 0 }}
          transition={{ duration: 0.3 }}
          className="overflow-hidden"
        >
          <div className={`h-px bg-gradient-to-r from-transparent ${colors.border} to-transparent mb-4`} />

          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Info size={14} className={colors.text} />
              <p className={`text-sm font-bold ${colors.text}`}>勝利條件 (Win Condition)</p>
            </div>
            <p className="text-sm text-gray-300 ml-6">{winCondition}</p>
          </div>

          {/* Full abilities list */}
          {abilities.length > 2 && (
            <div className="mb-4">
              <p className={`text-sm font-bold ${colors.text} mb-2`}>所有能力 (All Abilities)</p>
              <ul className="space-y-1 ml-2">
                {abilities.map((ability, idx) => (
                  <motion.li
                    key={idx}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="flex items-center gap-2 text-xs text-gray-300"
                  >
                    <Zap size={12} className="text-yellow-400" />
                    {ability}
                  </motion.li>
                ))}
              </ul>
            </div>
          )}

          {/* Tips */}
          <div>
            <p className={`text-sm font-bold ${colors.text} mb-2`}>💡 技巧 (Tips)</p>
            <ul className="space-y-1 ml-2">
              {tips.map((tip, idx) => (
                <motion.li
                  key={idx}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="text-xs text-gray-300"
                >
                  • {tip}
                </motion.li>
              ))}
            </ul>
          </div>
        </motion.div>

        {/* Expand hint */}
        <motion.div
          animate={{ opacity: expanded ? 0 : 1 }}
          className="absolute bottom-3 right-3 text-xs text-gray-400"
        >
          懸停展開 (Hover to expand)
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
