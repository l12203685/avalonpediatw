import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  Users,
  ThumbsUp,
  ThumbsDown,
  CheckCircle,
  XCircle,
  Swords,
  Trophy,
  AlertCircle,
  Loader,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { MOCK_REPLAY, ROLE_DISPLAY } from '../data/mockData';
import {
  fetchReplay,
  getErrorMessage,
  ReplayDataApi,
  ReplayEventApi,
} from '../services/api';

// ─── Event Card ───────────────────────────────────────────────────────────────

function EventCard({ event, visible }: { event: ReplayEventApi; visible: boolean }): JSX.Element {
  const base = 'rounded-xl p-5 border space-y-3';

  if (event.type === 'team-proposed') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: visible ? 1 : 0.2, y: 0 }}
        className={`${base} bg-purple-900/20 border-purple-600/40`}
      >
        <div className="flex items-center gap-2">
          <Users size={16} className="text-purple-400" />
          <span className="text-purple-300 font-semibold text-sm">隊伍提案</span>
          <span className="text-gray-500 text-xs ml-auto">第 {event.round} 輪</span>
        </div>
        <p className="text-white text-sm">
          <span className="text-yellow-300 font-semibold">{event.leader}</span> 提名隊伍
        </p>
        <div className="flex flex-wrap gap-2">
          {event.team?.map((name) => (
            <span
              key={name}
              className="text-xs bg-purple-800/50 text-purple-200 border border-purple-600/40 px-2 py-1 rounded-full"
            >
              {name}
            </span>
          ))}
        </div>
      </motion.div>
    );
  }

  if (event.type === 'vote-result') {
    const color = event.approved ? 'green' : 'red';
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: visible ? 1 : 0.2, y: 0 }}
        className={`${base} bg-${color}-900/20 border-${color}-600/40`}
      >
        <div className="flex items-center gap-2">
          {event.approved
            ? <ThumbsUp size={16} className="text-green-400" />
            : <ThumbsDown size={16} className="text-red-400" />}
          <span className={`text-${color}-300 font-semibold text-sm`}>
            投票結果：{event.approved ? '通過' : '否決'}
          </span>
        </div>
        <div className="flex gap-4 text-sm">
          <span className="text-green-400">✓ 贊成 {event.approvals}</span>
          <span className="text-red-400">✗ 反對 {event.rejections}</span>
          {(event.failCount ?? 0) > 0 && (
            <span className="text-yellow-400 ml-auto text-xs">
              連續否決 {event.failCount}
            </span>
          )}
        </div>
      </motion.div>
    );
  }

  if (event.type === 'quest-result') {
    const success = event.questResult === 'success';
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: visible ? 1 : 0.2, y: 0 }}
        className={`${base} ${
          success ? 'bg-green-900/25 border-green-600/50' : 'bg-red-900/25 border-red-600/50'
        }`}
      >
        <div className="flex items-center gap-2">
          {success
            ? <CheckCircle size={16} className="text-green-400" />
            : <XCircle size={16} className="text-red-400" />}
          <span className={`${success ? 'text-green-300' : 'text-red-300'} font-bold`}>
            任務{success ? '成功' : '失敗'}
          </span>
        </div>
        <div className="flex gap-4 text-sm">
          <span className="text-green-400">成功票 {event.successVotes}</span>
          <span className="text-red-400">失敗票 {event.failVotes}</span>
        </div>
      </motion.div>
    );
  }

  if (event.type === 'assassination') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: visible ? 1 : 0.2, y: 0 }}
        className={`${base} bg-red-900/30 border-red-500/60`}
      >
        <div className="flex items-center gap-2">
          <Swords size={16} className="text-red-400" />
          <span className="text-red-300 font-bold text-sm">暗殺</span>
        </div>
        <p className="text-white text-sm">
          <span className="text-red-300 font-semibold">{event.assassin}</span>
          {' 刺殺了 '}
          <span
            className={`font-semibold ${
              event.targetWasMerlin ? 'text-red-400' : 'text-gray-300'
            }`}
          >
            {event.target}
          </span>
        </p>
        <p
          className={`text-sm font-semibold ${
            event.targetWasMerlin ? 'text-red-400' : 'text-green-400'
          }`}
        >
          {event.targetWasMerlin
            ? '✓ 暗殺成功！目標是 Merlin'
            : '✗ 暗殺失敗！目標不是 Merlin'}
        </p>
      </motion.div>
    );
  }

  if (event.type === 'game-end') {
    const good = event.winner === 'good';
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: visible ? 1 : 0.2, scale: 1 }}
        className={`${base} ${
          good ? 'bg-green-900/30 border-green-500' : 'bg-red-900/30 border-red-500'
        } text-center`}
      >
        <Trophy size={24} className={`mx-auto ${good ? 'text-green-400' : 'text-red-400'}`} />
        <p className={`font-black text-xl ${good ? 'text-green-300' : 'text-red-300'}`}>
          {good ? '⚔️ 好陣營勝利' : '👹 邪惡陣營勝利'}
        </p>
        <p className="text-gray-300 text-sm">{event.reason}</p>
      </motion.div>
    );
  }

  return <></>;
}

// ─── Round Track ─────────────────────────────────────────────────────────────

function RoundTrack({
  results,
}: {
  results: ReplayDataApi['questResults'];
}): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-3">
      {results.map((r, i) => (
        <motion.div
          key={i}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: i * 0.1 }}
          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shadow-lg ${
            r === 'success' ? 'bg-green-500 shadow-green-500/30' : 'bg-red-500 shadow-red-500/30'
          }`}
        >
          {r === 'success' ? '✓' : '✗'}
        </motion.div>
      ))}
      {Array.from({ length: 5 - results.length }).map((_, i) => (
        <div
          key={`empty-${i}`}
          className="w-8 h-8 rounded-full border-2 border-dashed border-gray-600"
        />
      ))}
    </div>
  );
}

// ─── Player Roster ────────────────────────────────────────────────────────────

function PlayerRoster({
  players,
}: {
  players: ReplayDataApi['players'];
}): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2">
      {players.map((p) => {
        const role = ROLE_DISPLAY[p.role];
        return (
          <div
            key={p.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
              p.team === 'good'
                ? 'bg-blue-900/20 border-blue-700/40'
                : 'bg-red-900/20 border-red-700/40'
            }`}
          >
            <span>{role?.icon ?? '👤'}</span>
            <span className="text-white font-medium truncate">{p.name}</span>
            <span className={`ml-auto text-xs shrink-0 ${role?.color ?? 'text-gray-400'}`}>
              {role?.label ?? p.role}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ReplayPage(): JSX.Element {
  const { setGameState, replayRoomId } = useGameStore();
  const [replay, setReplay] = useState<ReplayDataApi>(MOCK_REPLAY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [showRoster, setShowRoster] = useState(false);

  useEffect(() => {
    const gameId = replayRoomId;
    if (!gameId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setStep(0);

    fetchReplay(gameId)
      .then((data) => {
        if (!cancelled) setReplay(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [replayRoomId]);

  const totalSteps = replay.events.length;
  const canPrev = step > 0;
  const canNext = step < totalSteps - 1;

  const ago = (() => {
    const diffMs = Date.now() - replay.playedAt;
    const d = Math.floor(diffMs / 86400000);
    const h = Math.floor(diffMs / 3600000);
    if (d > 0) return `${d} 天前`;
    return `${h} 小時前`;
  })();

  return (
    <div className="min-h-screen bg-gradient-to-b from-avalon-dark to-black">
      {/* Back */}
      <div className="absolute top-4 left-4 z-10">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setGameState('profile')}
          className="flex items-center gap-2 bg-avalon-card/50 hover:bg-avalon-card/80 text-white px-4 py-2 rounded-lg border border-gray-600 transition-all"
        >
          <ArrowLeft size={18} />
          返回
        </motion.button>
      </div>

      {/* Loading overlay */}
      {loading && (
        <div className="flex items-center justify-center min-h-screen gap-2 text-gray-400">
          <Loader size={24} className="animate-spin" />
          載入回放資料...
        </div>
      )}

      {!loading && (
        <>
          {/* Error banner */}
          {error && (
            <div className="max-w-2xl mx-auto mt-16 mb-4 px-4">
              <div className="flex items-center gap-2 text-yellow-400 bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-4 py-2 text-sm">
                <AlertCircle size={16} />
                無法從伺服器載入（顯示範例資料）：{error}
              </div>
            </div>
          )}

          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-gradient-to-r from-blue-600/20 to-purple-600/20 border-b border-gray-700 px-8 pt-16 pb-6"
          >
            <div className="max-w-2xl mx-auto text-center space-y-3">
              <h1 className="text-3xl font-bold text-white">對戰回放</h1>
              <div className="flex items-center justify-center gap-4 text-sm text-gray-400 flex-wrap">
                <span>房間 {replay.roomId}</span>
                <span>·</span>
                <span>{replay.playerCount} 人</span>
                <span>·</span>
                <span>{replay.durationMinutes} 分鐘</span>
                <span>·</span>
                <span>{ago}</span>
              </div>

              <RoundTrack results={replay.questResults} />

              <p
                className={`text-lg font-bold ${
                  replay.winner === 'good' ? 'text-green-400' : 'text-red-400'
                }`}
              >
                {replay.winner === 'good' ? '⚔️ 好陣營勝利' : '👹 邪惡陣營勝利'}
              </p>

              <button
                onClick={() => setShowRoster((v) => !v)}
                className="text-xs text-blue-400 hover:text-blue-300 underline transition-colors"
              >
                {showRoster ? '隱藏角色列表' : '查看角色揭露'}
              </button>

              <AnimatePresence>
                {showRoster && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="pt-3 max-w-md mx-auto">
                      <PlayerRoster players={replay.players} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* Timeline Viewer */}
          <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
            {/* Progress bar */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-gray-500">
                <span>事件 {step + 1} / {totalSteps}</span>
                <span>{Math.round(((step + 1) / totalSteps) * 100)}%</span>
              </div>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <motion.div
                  animate={{ width: `${((step + 1) / totalSteps) * 100}%` }}
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full"
                />
              </div>
            </div>

            {/* Events */}
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {replay.events.slice(0, step + 1).map((event, idx) => (
                  <EventCard
                    key={`${event.type}-${event.round}-${idx}`}
                    event={event}
                    visible={idx === step}
                  />
                ))}
              </AnimatePresence>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-4 pt-2 sticky bottom-6">
              <motion.button
                whileHover={canPrev ? { scale: 1.05 } : {}}
                whileTap={canPrev ? { scale: 0.95 } : {}}
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={!canPrev}
                className="flex items-center gap-2 bg-avalon-card border border-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-all"
              >
                <ChevronLeft size={20} />
                上一步
              </motion.button>

              <span className="text-gray-500 text-sm tabular-nums">
                {step + 1} / {totalSteps}
              </span>

              <motion.button
                whileHover={canNext ? { scale: 1.05 } : {}}
                whileTap={canNext ? { scale: 0.95 } : {}}
                onClick={() => setStep((s) => Math.min(totalSteps - 1, s + 1))}
                disabled={!canNext}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold px-6 py-3 rounded-xl transition-all"
              >
                下一步
                <ChevronRight size={20} />
              </motion.button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
