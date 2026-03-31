import { motion } from 'framer-motion';
import { ArrowLeft, Bot, TrendingUp, Clock, Zap, RefreshCw } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { MOCK_AI_STATS, ROLE_DISPLAY } from '../data/mockData';

// ─── Simple Bar ───────────────────────────────────────────────────────────────

function Bar({ value, max, color }: { value: number; max: number; color: string }): JSX.Element {
  return (
    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${(value / max) * 100}%` }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
        className={`h-full rounded-full ${color}`}
      />
    </div>
  );
}

// ─── Daily Sparkline ──────────────────────────────────────────────────────────

function DailyChart(): JSX.Element {
  const data = MOCK_AI_STATS.recentDaily;
  const maxGames = Math.max(...data.map((d) => d.gamesPlayed));

  return (
    <div className="space-y-3">
      {data.map((day) => {
        const goodPct = (day.goodWins / day.gamesPlayed) * 100;
        const evilPct = (day.evilWins / day.gamesPlayed) * 100;
        const date = day.date.slice(5); // MM-DD
        return (
          <div key={day.date} className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>{date}</span>
              <span>{day.gamesPlayed} 局 · 好陣營 {goodPct.toFixed(0)}%</span>
            </div>
            <div className="h-3 bg-gray-700 rounded-full overflow-hidden flex">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${goodPct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="h-full bg-green-500"
              />
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${evilPct}%` }}
                transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
                className="h-full bg-red-500"
              />
            </div>
          </div>
        );
      })}
      <div className="flex gap-4 text-xs text-gray-500 pt-1">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> 好陣營勝</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-500 inline-block" /> 邪惡陣營勝</span>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AiStatsPage(): JSX.Element {
  const { setGameState } = useGameStore();
  const stats = MOCK_AI_STATS;

  const nextRunIn = Math.max(0, Math.floor((stats.nextRunAt - Date.now()) / 60000));

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black">
      {/* Back */}
      <div className="absolute top-4 left-4 z-10">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setGameState('home')}
          className="flex items-center gap-2 bg-avalon-card/50 hover:bg-avalon-card/80 text-white px-4 py-2 rounded-lg border border-gray-600"
        >
          <ArrowLeft size={18} />
          返回
        </motion.button>
      </div>

      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-cyan-600/20 to-blue-600/20 border-b border-gray-700 px-8 pt-16 pb-8"
      >
        <div className="max-w-4xl mx-auto text-center space-y-3">
          <div className="flex items-center justify-center gap-3">
            <Bot size={32} className="text-cyan-400" />
            <h1 className="text-4xl font-bold text-white">AI 自對弈統計</h1>
          </div>
          <p className="text-gray-400">HeuristicAgent vs RandomAgent 自動對局數據</p>

          {/* Scheduler status */}
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm border ${
            stats.schedulerEnabled
              ? 'bg-green-900/30 border-green-600/40 text-green-300'
              : 'bg-gray-800 border-gray-600 text-gray-400'
          }`}>
            <motion.div
              animate={stats.schedulerEnabled ? { scale: [1, 1.3, 1] } : {}}
              transition={{ duration: 2, repeat: Infinity }}
              className={`w-2 h-2 rounded-full ${stats.schedulerEnabled ? 'bg-green-400' : 'bg-gray-500'}`}
            />
            {stats.schedulerEnabled ? `排程器運行中 · ${nextRunIn} 分鐘後下次執行` : '排程器已停用'}
          </div>
        </div>
      </motion.div>

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Summary Cards */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-4"
        >
          {[
            { label: '總對局數', value: stats.totalGames.toLocaleString(), icon: <Zap size={20} className="text-blue-400" />, color: 'border-blue-600/40 bg-blue-900/20' },
            { label: '好陣營勝率', value: `${stats.goodWinRate}%`, icon: <TrendingUp size={20} className="text-green-400" />, color: 'border-green-600/40 bg-green-900/20' },
            { label: '邪惡陣營勝率', value: `${stats.evilWinRate}%`, icon: <TrendingUp size={20} className="text-red-400" />, color: 'border-red-600/40 bg-red-900/20' },
            { label: '平均局時', value: `${stats.avgDurationSeconds}s`, icon: <Clock size={20} className="text-yellow-400" />, color: 'border-yellow-600/40 bg-yellow-900/20' },
          ].map((card) => (
            <motion.div
              key={card.label}
              whileHover={{ scale: 1.02 }}
              className={`rounded-xl border p-5 text-center space-y-2 ${card.color}`}
            >
              <div className="flex justify-center">{card.icon}</div>
              <p className="text-2xl font-bold text-white">{card.value}</p>
              <p className="text-xs text-gray-400">{card.label}</p>
            </motion.div>
          ))}
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Agent Breakdown */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6 space-y-5"
          >
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Bot size={18} className="text-cyan-400" />
              Agent 表現
            </h2>
            {stats.agentBreakdown.map((agent) => (
              <div key={agent.agent} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-300 font-medium">{agent.agent}</span>
                  <span className="text-gray-400">{agent.games} 局 · <span className="text-blue-300">{agent.winRate.toFixed(1)}%</span></span>
                </div>
                <Bar value={agent.wins} max={agent.games} color="bg-gradient-to-r from-cyan-500 to-blue-500" />
              </div>
            ))}

            <div className="pt-2 border-t border-gray-700 text-xs text-gray-500 space-y-1">
              <p>HeuristicAgent：具備隊伍評分、歷史追蹤、角色推理策略</p>
              <p>RandomAgent：完全隨機決策，作為基準對照</p>
            </div>
          </motion.div>

          {/* Role Win Rates */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6 space-y-4"
          >
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-400" />
              各角色勝率
            </h2>
            {stats.roleWinRates.map((r) => {
              const display = ROLE_DISPLAY[r.role];
              return (
                <div key={r.role} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className={`${display?.color ?? 'text-gray-300'} font-medium`}>
                      {display?.icon ?? ''} {display?.label ?? r.role}
                    </span>
                    <span className="text-gray-400">
                      {r.gamesAsRole} 局 · <span className="text-blue-300">{r.winRate.toFixed(1)}%</span>
                    </span>
                  </div>
                  <Bar
                    value={r.wins}
                    max={r.gamesAsRole}
                    color={r.winRate >= 55 ? 'bg-gradient-to-r from-green-500 to-green-400' : r.winRate >= 45 ? 'bg-gradient-to-r from-blue-500 to-blue-400' : 'bg-gradient-to-r from-red-600 to-red-500'}
                  />
                </div>
              );
            })}
          </motion.div>
        </div>

        {/* Daily Chart */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-avalon-card/50 border border-gray-600 rounded-xl p-6 space-y-4"
        >
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <RefreshCw size={18} className="text-purple-400" />
            近 7 日每日對局（每 30 分鐘 5 局）
          </h2>
          <DailyChart />
        </motion.div>

        <p className="text-center text-xs text-gray-600 pb-4">
          資料來源：/api/ai/stats（目前顯示模擬資料）
        </p>
      </div>
    </div>
  );
}
