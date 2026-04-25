import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  AlertCircle,
  Loader,
  Users,
  ThumbsUp,
  ThumbsDown,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchGameReplay,
  getErrorMessage,
  GameEvent,
} from '../services/api';
import { CampDisc } from '../components/CampDisc';

// ─── Scoresheet shape ─────────────────────────────────────────────────────────
//
// 2026-04-25 Edward verbatim:「對戰回放畫面錯誤太多 名字 還有過程展示都很奇怪
// 只要展示牌譜紀錄就夠」. The page used to call /api/replay/:roomId/structured
// (404 — the endpoint never existed) and on failure fall back to MOCK_REPLAY,
// which is why screenshots showed mock player names like "梅林守護者" /
// "刺客之刃". This rewrite drops MOCK_REPLAY entirely, switches to the
// existing /api/replay/:roomId raw-events endpoint, and renders only the
// scoresheet — one card per round with proposal, vote outcome, and quest
// result lines. No player roster, no win banner, no hide-roles toggle.

interface RoundScoresheet {
  round: number;
  /** Most recent quest_team_selected payload for this round (final proposal). */
  proposalTeam: string[] | null;
  proposalLeader: string | null;
  /** All voting_resolved entries for the round, in attempt order. */
  votes: Array<{
    approvals: number;
    rejections: number;
    approved: boolean;
  }>;
  /** quest_resolved payload, if the quest actually ran. */
  quest: {
    result: 'success' | 'fail';
    successVotes: number;
    failVotes: number;
  } | null;
}

interface ReplayHeader {
  roomId: string;
  playerCount: number | null;
  evilWins: boolean | null;
}

function buildScoresheet(events: GameEvent[]): RoundScoresheet[] {
  const byRound = new Map<number, RoundScoresheet>();
  const ensure = (round: number): RoundScoresheet => {
    let r = byRound.get(round);
    if (!r) {
      r = {
        round,
        proposalTeam: null,
        proposalLeader: null,
        votes: [],
        quest: null,
      };
      byRound.set(round, r);
    }
    return r;
  };

  for (const ev of events) {
    const data = ev.event_data as Record<string, unknown>;
    const round = Number(data.round);
    if (!Number.isFinite(round) || round < 1) continue;
    const slot = ensure(round);

    if (ev.event_type === 'quest_team_selected' || ev.event_type === 'team_auto_selected') {
      const team = data.team;
      if (Array.isArray(team)) slot.proposalTeam = team.map((x) => String(x));
      const leader = (data.leaderName as string | undefined) ?? (data.leaderId as string | undefined);
      if (leader) slot.proposalLeader = leader;
    } else if (ev.event_type === 'voting_resolved') {
      const approvals = Number(data.approvals ?? data.approveCount ?? 0);
      const rejections = Number(data.rejections ?? data.rejectCount ?? 0);
      const approved = data.result === 'approved' || data.approved === true;
      slot.votes.push({ approvals, rejections, approved });
    } else if (ev.event_type === 'quest_resolved') {
      const result = data.result === 'success' ? 'success' : 'fail';
      slot.quest = {
        result,
        successVotes: Number(data.successVotes ?? 0),
        failVotes: Number(data.failVotes ?? 0),
      };
    }
  }

  return Array.from(byRound.values()).sort((a, b) => a.round - b.round);
}

function buildHeader(roomId: string, events: GameEvent[]): ReplayHeader {
  const start = events.find((e) => e.event_type === 'game_started');
  const end = events.find((e) => e.event_type === 'game_ended');
  const playerCount = start
    ? (Number((start.event_data as Record<string, unknown>).playerCount) || null)
    : null;
  const evilWins = end
    ? Boolean((end.event_data as Record<string, unknown>).evilWins)
    : null;
  return { roomId, playerCount, evilWins };
}

// ─── Round card ───────────────────────────────────────────────────────────────

function RoundCard({ slot, visible }: { slot: RoundScoresheet; visible: boolean }): JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: visible ? 1 : 0.35, y: 0 }}
      className="rounded-xl border border-gray-700 bg-avalon-card/40 p-4 sm:p-5 space-y-3"
    >
      <div className="flex items-center gap-2 text-amber-300">
        <span className="text-sm font-bold">第 {slot.round} 局</span>
      </div>

      {/* Final proposal */}
      {slot.proposalTeam && slot.proposalTeam.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-amber-300">
            <Users size={14} />
            <span>隊伍提案{slot.proposalLeader ? `(隊長 ${slot.proposalLeader})` : ''}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {slot.proposalTeam.map((name, i) => (
              <span
                key={`${slot.round}-team-${i}-${name}`}
                className="text-xs bg-amber-800/40 text-amber-100 border border-amber-600/40 px-2 py-1 rounded-full"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Vote attempts */}
      {slot.votes.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span>投票結果</span>
          </div>
          <div className="space-y-1">
            {slot.votes.map((v, i) => (
              <div
                key={`${slot.round}-vote-${i}`}
                className={`flex items-center gap-2 text-xs px-2.5 py-1.5 rounded border ${
                  v.approved
                    ? 'bg-blue-900/20 border-blue-700/40 text-blue-200'
                    : 'bg-red-900/20 border-red-700/40 text-red-200'
                }`}
              >
                <span className="text-gray-500 w-12">第 {i + 1} 次</span>
                {v.approved ? (
                  <ThumbsUp size={12} className="text-blue-400" />
                ) : (
                  <ThumbsDown size={12} className="text-red-400" />
                )}
                <span>{v.approved ? '通過' : '否決'}</span>
                <span className="text-blue-400 ml-auto">贊成 {v.approvals}</span>
                <span className="text-red-400">反對 {v.rejections}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quest result */}
      {slot.quest && (
        <div
          className={`flex items-center gap-2 text-sm px-3 py-2 rounded border font-semibold ${
            slot.quest.result === 'success'
              ? 'bg-blue-900/30 border-blue-600/50 text-blue-200'
              : 'bg-red-900/30 border-red-600/50 text-red-200'
          }`}
        >
          {slot.quest.result === 'success' ? (
            <CheckCircle size={16} className="text-blue-400" />
          ) : (
            <XCircle size={16} className="text-red-400" />
          )}
          <span>任務{slot.quest.result === 'success' ? '成功' : '失敗'}</span>
          <span className="text-xs text-blue-300 ml-auto">成功票 {slot.quest.successVotes}</span>
          <span className="text-xs text-red-300">失敗票 {slot.quest.failVotes}</span>
        </div>
      )}
    </motion.div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReplayPage(): JSX.Element {
  const { setGameState, replayRoomId } = useGameStore();
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);

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

    fetchGameReplay(gameId)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEvents([]);
          setError(getErrorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [replayRoomId]);

  const scoresheet = useMemo(() => buildScoresheet(events), [events]);
  const header = useMemo(
    () => buildHeader(replayRoomId ?? '', events),
    [replayRoomId, events],
  );

  const totalSteps = scoresheet.length;
  const safeStep = totalSteps === 0 ? 0 : Math.min(step, totalSteps - 1);
  const canPrev = safeStep > 0;
  const canNext = safeStep < totalSteps - 1;

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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center min-h-screen gap-2 text-gray-400">
          <Loader size={24} className="animate-spin" />
          載入牌譜中...
        </div>
      )}

      {!loading && (
        <>
          {/* Header — minimal: room id + player count + winner only */}
          <div className="px-8 pt-16 pb-4 border-b border-gray-700">
            <div className="max-w-2xl mx-auto text-center space-y-2">
              <h1 className="text-2xl font-bold text-white">牌譜紀錄</h1>
              <div className="flex items-center justify-center gap-3 text-sm text-gray-400 flex-wrap">
                <span>房間 {header.roomId || '—'}</span>
                {header.playerCount !== null && (
                  <>
                    <span>·</span>
                    <span>{header.playerCount} 人局</span>
                  </>
                )}
                {header.evilWins !== null && (
                  <>
                    <span>·</span>
                    <span
                      className={`inline-flex items-center gap-1.5 ${
                        header.evilWins ? 'text-red-400' : 'text-blue-400'
                      }`}
                    >
                      <CampDisc team={header.evilWins ? 'evil' : 'good'} className="w-4 h-4" />
                      {header.evilWins ? '邪惡方獲勝' : '正義方獲勝'}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
            {/* Error / empty state */}
            {error && (
              <div className="flex items-start gap-2 text-yellow-300 bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-2 text-sm">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                <span>無法載入牌譜：{error}</span>
              </div>
            )}

            {!error && totalSteps === 0 && (
              <div className="text-center text-gray-500 py-12 text-sm">
                此局無牌譜紀錄。
              </div>
            )}

            {totalSteps > 0 && (
              <>
                {/* Progress */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>第 {safeStep + 1} / {totalSteps} 局</span>
                    <span>{Math.round(((safeStep + 1) / totalSteps) * 100)}%</span>
                  </div>
                  <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                    <motion.div
                      animate={{ width: `${((safeStep + 1) / totalSteps) * 100}%` }}
                      className="h-full bg-gradient-to-r from-blue-500 to-amber-500 rounded-full"
                    />
                  </div>
                </div>

                {/* Scoresheet — all rounds visible, current one highlighted */}
                <div className="space-y-3">
                  {scoresheet.map((slot, idx) => (
                    <RoundCard
                      key={slot.round}
                      slot={slot}
                      visible={idx <= safeStep}
                    />
                  ))}
                </div>

                {/* Step controls */}
                <div className="flex items-center justify-center gap-4 pt-2 sticky bottom-6">
                  <motion.button
                    whileHover={canPrev ? { scale: 1.05 } : {}}
                    whileTap={canPrev ? { scale: 0.95 } : {}}
                    onClick={() => setStep((s) => Math.max(0, s - 1))}
                    disabled={!canPrev}
                    className="flex items-center gap-2 bg-avalon-card border border-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-all"
                  >
                    <ChevronLeft size={18} />
                    上一步
                  </motion.button>

                  <span className="text-gray-500 text-sm tabular-nums">
                    {safeStep + 1} / {totalSteps}
                  </span>

                  <motion.button
                    whileHover={canNext ? { scale: 1.05 } : {}}
                    whileTap={canNext ? { scale: 0.95 } : {}}
                    onClick={() => setStep((s) => Math.min(totalSteps - 1, s + 1))}
                    disabled={!canNext}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-xl transition-all"
                  >
                    下一步
                    <ChevronRight size={18} />
                  </motion.button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
