import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  History,
  Loader2,
  Lock,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import {
  ACTION_LABELS,
  fetchNextReplayQuiz,
  fetchReplayQuizStats,
  REPLAY_QUIZ_ACTIONS,
  ReplayQuizApiError,
  ROLE_LABELS,
  seatLabel,
  submitReplayQuizAnswer,
  type ReplayQuizAction,
  type ReplayQuizAnswerResponse,
  type ReplayQuizAnswerValue,
  type ReplayQuizQuestion,
  type ReplayQuizRecentItem,
  type ReplayQuizStats,
} from '../services/replayQuiz';

const cardCls = 'space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4';
const inputCls =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-amber-400 focus:outline-none';

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/**
 * 統一 AI騎士（C）— 站長私人重玩測驗（#replay-quiz）。
 *
 * 僅限站長登入存取：從一個月以前（> 30 天）的歷史對局抽出局面，
 * 顯示當時的公開紀錄與角色視野（所有名字匿名換成 1家～9家、0家），
 * 私人記錄作答與選填理由，並逐動作統計與當初決策一致的比例。
 */
export default function ReplayQuizPage(): JSX.Element {
  const setGameState = useGameStore((s) => s.setGameState);

  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [actionFilter, setActionFilter] = useState<ReplayQuizAction | 'all'>('all');
  const [playerId, setPlayerId] = useState<string>('');
  const [poolSize, setPoolSize] = useState(0);
  const [remainingCount, setRemainingCount] = useState(0);
  const [question, setQuestion] = useState<ReplayQuizQuestion | null>(null);
  const [stats, setStats] = useState<ReplayQuizStats | null>(null);
  const [recent, setRecent] = useState<ReplayQuizRecentItem[]>([]);

  // 作答輸入狀態
  const [selectedTeam, setSelectedTeam] = useState<number[]>([]);
  const [selectedVote, setSelectedVote] = useState<boolean | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<number | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<'good' | 'evil' | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ReplayQuizAnswerResponse | null>(null);

  const resetInputs = useCallback(() => {
    setSelectedTeam([]);
    setSelectedVote(null);
    setSelectedTarget(null);
    setSelectedClaim(null);
    setReason('');
    setSubmitError(null);
    setFeedback(null);
  }, []);

  const loadQuiz = useCallback(
    async (filter: ReplayQuizAction | 'all') => {
      setLoading(true);
      setError(null);
      setForbidden(false);
      resetInputs();

      const token = getStoredToken();
      if (!token) {
        setAuthRequired(true);
        setLoading(false);
        return;
      }
      setAuthRequired(false);

      try {
        const [nextRes, statsRes] = await Promise.all([
          fetchNextReplayQuiz(token, { action: filter === 'all' ? undefined : filter }),
          fetchReplayQuizStats(token, { limit: 20 }),
        ]);
        setPlayerId(nextRes.playerId);
        setPoolSize(nextRes.poolSize);
        setRemainingCount(nextRes.remainingCount);
        setQuestion(nextRes.question);
        setStats(nextRes.stats);
        setRecent(statsRes.recent);
      } catch (err) {
        if (err instanceof ReplayQuizApiError) {
          if (err.status === 401) {
            setAuthRequired(true);
          } else if (err.status === 403) {
            setForbidden(true);
          } else {
            setError(err.message);
          }
        } else {
          setError(err instanceof Error ? err.message : '無法讀取重玩測驗');
        }
      } finally {
        setLoading(false);
      }
    },
    [resetInputs],
  );

  useEffect(() => {
    void loadQuiz(actionFilter);
  }, [actionFilter, loadQuiz]);

  const toggleTeamSeat = (seat: number): void => {
    if (!question || feedback) return;
    const max = question.requiredTeamSize ?? 0;
    setSelectedTeam((prev) => {
      if (prev.includes(seat)) return prev.filter((s) => s !== seat);
      if (prev.length >= max) return prev;
      return [...prev, seat].sort((a, b) => a - b);
    });
  };

  const canSubmit = ((): boolean => {
    if (!question || submitting || feedback) return false;
    switch (question.action) {
      case 'team':
        return selectedTeam.length === (question.requiredTeamSize ?? 0);
      case 'vote':
        return selectedVote !== null;
      case 'lakeTarget':
      case 'assassinate':
        return selectedTarget !== null;
      case 'lakeClaim':
        return selectedClaim !== null;
    }
  })();

  const handleSubmit = async (): Promise<void> => {
    if (!question || !canSubmit) return;
    const token = getStoredToken();
    if (!token) {
      setAuthRequired(true);
      return;
    }

    let answer: ReplayQuizAnswerValue;
    switch (question.action) {
      case 'team':
        answer = selectedTeam;
        break;
      case 'vote':
        answer = selectedVote as boolean;
        break;
      case 'lakeTarget':
      case 'assassinate':
        answer = selectedTarget as number;
        break;
      case 'lakeClaim':
        answer = selectedClaim as 'good' | 'evil';
        break;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await submitReplayQuizAnswer(token, {
        questionId: question.questionId,
        answer,
        reason: reason.trim() || undefined,
      });
      setFeedback(res);
      setStats(res.stats);
      setRemainingCount((c) => Math.max(0, c - 1));
      const updatedStats = await fetchReplayQuizStats(token, { limit: 20 });
      setRecent(updatedStats.recent);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '送出作答失敗');
    } finally {
      setSubmitting(false);
    }
  };

  const goBackToMyKnight = (): void => {
    setGameState('myKnight');
    window.scrollTo({ top: 0 });
  };

  return (
    <div
      className="relative z-10 mx-auto max-w-4xl space-y-4 px-3 py-4 text-white sm:px-4"
      data-testid="replay-quiz-page"
    >
      {/* 頁首 */}
      <section className={cardCls}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={goBackToMyKnight}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <ArrowLeft size={13} />返回我的騎士
            </button>
            <h1 className="flex items-center gap-2 text-lg font-bold">
              <Sparkles size={18} className="text-amber-300" />
              重玩測驗
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/50 bg-sky-950/60 px-2 py-0.5 text-[11px] font-semibold text-sky-200">
                <ShieldCheck size={12} />站長私人頁
              </span>
            </h1>
          </div>
          {!authRequired && !forbidden && (
            <button
              type="button"
              onClick={() => void loadQuiz(actionFilter)}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />換一題
            </button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-zinc-300">
          從一個月以前（超過 30 天）的歷史對局抽取局面，只顯示當時的公開紀錄與角色視野，所有玩家名字已完全換成座位（1家～9家、0家）。你的作答與理由只存在私人儲存庫，並逐動作統計和當初一樣的比例。
        </p>
      </section>

      {/* 未登入 */}
      {authRequired && (
        <section className={`${cardCls} items-start`}>
          <p className="flex items-center gap-2 text-sm font-bold text-amber-200">
            <Lock size={16} />需要登入站長帳號
          </p>
          <p className="text-xs text-zinc-300">
            重玩測驗是站長專屬私人頁面，請先登入正式帳號後再開啟。
          </p>
          <button
            type="button"
            onClick={() => setGameState('home')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-black hover:bg-amber-300"
          >
            <LogIn size={14} />前往登入
          </button>
        </section>
      )}

      {/* 非站長拒絕 */}
      {forbidden && (
        <section className="space-y-2 rounded-xl border border-rose-700/60 bg-rose-950/30 p-4 text-sm text-rose-200">
          <p className="flex items-center gap-2 font-bold">
            <Lock size={16} />此頁面僅限站長使用
          </p>
          <p className="text-xs text-rose-200/80">
            你的帳號沒有站長權限，無法讀取或作答私人重玩測驗。
          </p>
        </section>
      )}

      {/* 一般錯誤 */}
      {error && (
        <section className="flex items-center gap-2 rounded-xl border border-rose-700/60 bg-rose-950/30 p-3 text-xs text-rose-200">
          <AlertTriangle size={16} className="flex-shrink-0" />
          <span>{error}</span>
        </section>
      )}

      {/* 站長主內容 */}
      {!authRequired && !forbidden && (
        <>
          {/* 1. 逐動作一致率統計 */}
          {stats && (
            <section className={cardCls} data-testid="replay-quiz-stats">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-zinc-100">
                  與當初歷史決策一致比例
                  {playerId && <span className="ml-2 text-xs font-normal text-zinc-400">視角：{playerId}</span>}
                </h2>
                <span className="text-xs text-zinc-400">
                  題庫剩餘 {remainingCount} / {poolSize} 題
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-2.5 text-center">
                  <div className="text-[11px] font-semibold text-amber-200">整體</div>
                  <div className="mt-0.5 text-lg font-bold text-white">{fmtPct(stats.overall.rate)}</div>
                  <div className="text-[11px] text-zinc-400">
                    {stats.overall.matched} / {stats.overall.answered}
                  </div>
                </div>
                {REPLAY_QUIZ_ACTIONS.map((act) => {
                  const cell = stats.byAction[act];
                  return (
                    <div
                      key={act}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-center"
                    >
                      <div className="text-[11px] font-semibold text-zinc-300">{ACTION_LABELS[act]}</div>
                      <div className="mt-0.5 text-lg font-bold text-white">{fmtPct(cell.rate)}</div>
                      <div className="text-[11px] text-zinc-400">
                        {cell.matched} / {cell.answered}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 動作篩選 */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs text-zinc-400">出題篩選：</span>
                {(['all', ...REPLAY_QUIZ_ACTIONS] as const).map((key) => {
                  const active = actionFilter === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setActionFilter(key)}
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
                        active
                          ? 'bg-amber-400 text-black'
                          : 'border border-zinc-700 bg-zinc-950 text-zinc-300 hover:bg-zinc-800'
                      }`}
                    >
                      {key === 'all' ? '全部動作' : ACTION_LABELS[key]}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 2. 載入中 */}
          {loading && (
            <div className={`${cardCls} flex items-center gap-2 text-sm text-zinc-300`}>
              <Loader2 size={16} className="animate-spin text-amber-300" />
              正在從 30 天以前歷史對局抽取匿名局面…
            </div>
          )}

          {/* 3. 題庫已答完 */}
          {!loading && !question && !error && (
            <section className={cardCls}>
              <p className="text-sm font-semibold text-amber-200">
                目前篩選條件下的歷史題目已全部作答完畢！
              </p>
              <p className="text-xs text-zinc-400">
                可以切換上方的「出題篩選」來練習其他動作類型。
              </p>
            </section>
          )}

          {/* 4. 題目局面與作答區 */}
          {!loading && question && (
            <>
              {/* 你的身分與角色視野 */}
              <section className={cardCls} data-testid="replay-quiz-situation">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-amber-400/20 px-2 py-0.5 text-xs font-bold text-amber-200">
                      題型：{ACTION_LABELS[question.action]}
                    </span>
                    <span className="text-sm font-bold text-white">
                      第 {question.currentRound} 輪
                      {question.currentAttempt ? `・第 ${question.currentAttempt} 次派隊` : ''}
                    </span>
                    <span className="text-xs text-zinc-400">
                      目前隊長：{question.currentLeaderLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                        question.myTeam === 'good'
                          ? 'border-sky-500/50 bg-sky-950/60 text-sky-200'
                          : 'border-rose-500/50 bg-rose-950/60 text-rose-200'
                      }`}
                    >
                      你是 {question.mySeatLabel}・{roleLabel(question.myRole)}（{question.myTeam === 'good' ? '藍方' : '紅方'}）
                    </span>
                  </div>
                </div>

                {/* 角色視野 */}
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-xs space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-amber-200">
                    <Eye size={14} />當時你的角色視野
                  </div>
                  {question.vision.knownEvils.length > 0 && (
                    <p className="text-zinc-200">
                      看到的紅方座位：
                      <span className="font-bold text-rose-300">
                        {question.vision.knownEvils.map(seatLabel).join('、')}
                      </span>
                    </p>
                  )}
                  {question.vision.knownWizards && question.vision.knownWizards.length > 0 && (
                    <p className="text-zinc-200">
                      看到的法師座位（梅林／莫甘娜）：
                      <span className="font-bold text-sky-300">
                        {question.vision.knownWizards.map(seatLabel).join('、')}
                      </span>
                    </p>
                  )}
                  {question.vision.allEvilSeats && question.vision.allEvilSeats.length > 0 && (
                    <p className="text-zinc-200">
                      刺殺階段紅方全開牌：
                      <span className="font-bold text-rose-300">
                        {question.vision.allEvilSeats
                          .map((s) => `${seatLabel(s)}(${roleLabel(question.vision.allEvilRoles?.[s] ?? '')})`)
                          .join('、')}
                      </span>
                    </p>
                  )}
                  {question.vision.knownEvils.length === 0 &&
                    (!question.vision.knownWizards || question.vision.knownWizards.length === 0) &&
                    (!question.vision.allEvilSeats || question.vision.allEvilSeats.length === 0) && (
                      <p className="text-zinc-400">無額外開眼資訊（本局共 {question.evilCount} 位紅方）。</p>
                    )}
                  {question.vision.myLakeResults.length > 0 && (
                    <div className="pt-1 text-zinc-200">
                      你驗過的湖中結果（私密）：
                      {question.vision.myLakeResults.map((r) => (
                        <span
                          key={`${r.round}-${r.targetSeat}`}
                          className={`ml-1.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                            r.result === 'good'
                              ? 'bg-sky-950/80 text-sky-200'
                              : 'bg-rose-950/80 text-rose-200'
                          }`}
                        >
                          R{r.round} {r.targetLabel} = {r.result === 'good' ? '藍' : '紅'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 任務進度 */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-bold text-zinc-300">任務紀錄</h3>
                  {question.questHistory.length === 0 ? (
                    <p className="text-xs text-zinc-500">尚未完成任何任務（第 1 輪進行中）。</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {question.questHistory.map((q) => (
                        <div
                          key={q.round}
                          className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
                            q.result === 'success'
                              ? 'border-sky-700/50 bg-sky-950/30 text-sky-100'
                              : 'border-rose-700/50 bg-rose-950/30 text-rose-100'
                          }`}
                        >
                          <span className="font-bold">
                            R{q.round}：{q.teamSeats.map(seatLabel).join('、')}
                          </span>
                          <span className="font-semibold">
                            {q.result === 'success' ? '藍方成功' : `紅方失敗（${q.failCount} 壞）`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 湖中紀錄 */}
                {question.lakeHistory.length > 0 && (
                  <div className="space-y-1.5">
                    <h3 className="text-xs font-bold text-zinc-300">公開湖中紀錄</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {question.lakeHistory.map((l) => (
                        <span
                          key={`${l.round}-${l.holderSeat}-${l.targetSeat}`}
                          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                        >
                          R{l.round}：{l.holderLabel} 驗 {l.targetLabel} → 宣告{' '}
                          <strong
                            className={
                              l.declaredClaim === 'good'
                                ? 'text-sky-300'
                                : l.declaredClaim === 'evil'
                                  ? 'text-rose-300'
                                  : 'text-zinc-400'
                            }
                          >
                            {l.declaredClaim === 'good' ? '藍' : l.declaredClaim === 'evil' ? '紅' : '未宣告'}
                          </strong>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* 投票紀錄 */}
                <div className="space-y-1.5">
                  <h3 className="text-xs font-bold text-zinc-300">
                    公開投票紀錄（共 {question.voteHistory.length} 次）
                  </h3>
                  {question.voteHistory.length === 0 ? (
                    <p className="text-xs text-zinc-500">目前還沒有先前的投票紀錄。</p>
                  ) : (
                    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                      {question.voteHistory.map((v) => (
                        <div
                          key={`${v.round}-${v.attempt}`}
                          className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span>
                              <strong className="text-amber-200">
                                R{v.round}-{v.attempt}
                              </strong>{' '}
                              隊長 {v.leaderLabel} 派{' '}
                              <strong className="text-white">{v.teamSeats.map(seatLabel).join('、')}</strong>
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                                v.forced
                                  ? 'bg-amber-950/70 text-amber-200'
                                  : v.approved
                                    ? 'bg-emerald-950/70 text-emerald-200'
                                    : 'bg-zinc-800 text-zinc-300'
                              }`}
                            >
                              {v.forced ? '第 5 次強制出任務' : v.approved ? '通過出任務' : '否決'}
                            </span>
                          </div>
                          {!v.forced && (
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
                              <span>
                                贊成（{v.approveSeats.length}）：
                                <span className="text-zinc-200">{v.approveSeats.map(seatLabel).join('、') || '無'}</span>
                              </span>
                              <span>
                                反對（{v.rejectSeats.length}）：
                                <span className="text-zinc-400">{v.rejectSeats.map(seatLabel).join('、') || '無'}</span>
                              </span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* 作答互動區 */}
              <section className={cardCls} data-testid="replay-quiz-answer-box">
                <h2 className="text-sm font-bold text-amber-200">
                  換你決定：
                  {question.action === 'team' && `請選擇本輪要派出的 ${question.requiredTeamSize} 位隊員`}
                  {question.action === 'vote' &&
                    `${question.currentLeaderLabel} 提議派 ${(question.proposedTeamSeats ?? []).map(seatLabel).join('、')}，你要投贊成還是反對？`}
                  {question.action === 'lakeTarget' && '你是持湖人，你要驗哪一個座位？'}
                  {question.action === 'lakeClaim' &&
                    `你剛驗了 ${question.inspectedTargetLabel}（實際陣營：${question.inspectedResult === 'good' ? '藍方好人' : '紅方壞人'}），你要公開宣告什麼？`}
                  {question.action === 'assassinate' && '藍方三藍達成，你是刺客，你要刺殺哪一個座位？'}
                </h2>

                {/* 派隊選擇 */}
                {question.action === 'team' && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-5 gap-2">
                      {question.seats.map((s) => {
                        const picked = selectedTeam.includes(s.seat);
                        const isMe = s.seat === question.mySeat;
                        return (
                          <button
                            key={s.seat}
                            type="button"
                            disabled={Boolean(feedback)}
                            onClick={() => toggleTeamSeat(s.seat)}
                            className={`rounded-lg border px-2 py-2 text-xs font-bold transition-colors ${
                              picked
                                ? 'border-amber-400 bg-amber-400 text-black'
                                : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                            } disabled:opacity-60`}
                          >
                            {s.label}
                            {isMe ? ' (你)' : ''}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-zinc-400">
                      已選 {selectedTeam.length} / {question.requiredTeamSize} 人：
                      <span className="text-white">
                        {selectedTeam.length > 0 ? selectedTeam.map(seatLabel).join('、') : '尚未選擇'}
                      </span>
                    </p>
                  </div>
                )}

                {/* 投票選擇 */}
                {question.action === 'vote' && (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => setSelectedVote(true)}
                      className={`rounded-lg border px-4 py-3 text-sm font-bold transition-colors ${
                        selectedVote === true
                          ? 'border-emerald-400 bg-emerald-400 text-black'
                          : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                      } disabled:opacity-60`}
                    >
                      贊成（白票）
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => setSelectedVote(false)}
                      className={`rounded-lg border px-4 py-3 text-sm font-bold transition-colors ${
                        selectedVote === false
                          ? 'border-rose-400 bg-rose-400 text-black'
                          : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                      } disabled:opacity-60`}
                    >
                      反對（黑票）
                    </button>
                  </div>
                )}

                {/* 選湖 / 刺殺 目標選擇 */}
                {(question.action === 'lakeTarget' || question.action === 'assassinate') && (
                  <div className="grid grid-cols-5 gap-2">
                    {(question.validTargetSeats ?? []).map((seat) => {
                      const picked = selectedTarget === seat;
                      return (
                        <button
                          key={seat}
                          type="button"
                          disabled={Boolean(feedback)}
                          onClick={() => setSelectedTarget(seat)}
                          className={`rounded-lg border px-2 py-2 text-xs font-bold transition-colors ${
                            picked
                              ? 'border-amber-400 bg-amber-400 text-black'
                              : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                          } disabled:opacity-60`}
                        >
                          {seatLabel(seat)}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 湖中宣告 */}
                {question.action === 'lakeClaim' && (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => setSelectedClaim('good')}
                      className={`rounded-lg border px-4 py-3 text-sm font-bold transition-colors ${
                        selectedClaim === 'good'
                          ? 'border-sky-400 bg-sky-400 text-black'
                          : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                      } disabled:opacity-60`}
                    >
                      宣告藍方（好人）
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(feedback)}
                      onClick={() => setSelectedClaim('evil')}
                      className={`rounded-lg border px-4 py-3 text-sm font-bold transition-colors ${
                        selectedClaim === 'evil'
                          ? 'border-rose-400 bg-rose-400 text-black'
                          : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:bg-zinc-800'
                      } disabled:opacity-60`}
                    >
                      宣告紅方（壞人）
                    </button>
                  </div>
                )}

                {/* 選填「為什麼」理由 */}
                <div className="space-y-1">
                  <label htmlFor="replay-quiz-reason" className="block text-xs font-semibold text-zinc-300">
                    為什麼這樣選？（選填，只記在你的私人紀錄）
                  </label>
                  <textarea
                    id="replay-quiz-reason"
                    rows={2}
                    maxLength={500}
                    disabled={Boolean(feedback)}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="例如：R2 的投票結構顯示 4家 幾乎必紅，這裡不能帶 4家…"
                    className={inputCls}
                  />
                </div>

                {submitError && (
                  <p className="flex items-center gap-1.5 text-xs text-rose-300">
                    <AlertTriangle size={14} />{submitError}
                  </p>
                )}

                {!feedback ? (
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void handleSubmit()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-5 py-2 text-xs font-bold text-black hover:bg-amber-300 disabled:opacity-40"
                    data-testid="replay-quiz-submit"
                  >
                    {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    送出作答
                  </button>
                ) : (
                  <div
                    className={`space-y-2 rounded-lg border p-3 text-xs ${
                      feedback.matched
                        ? 'border-emerald-500/60 bg-emerald-950/40 text-emerald-100'
                        : 'border-amber-500/60 bg-amber-950/30 text-amber-100'
                    }`}
                    data-testid="replay-quiz-feedback"
                  >
                    <div className="flex items-center gap-2 text-sm font-bold">
                      {feedback.matched ? (
                        <>
                          <CheckCircle2 size={16} className="text-emerald-300" />
                          和當初一樣！
                        </>
                      ) : (
                        <>
                          <XCircle size={16} className="text-amber-300" />
                          和當初的選擇不同
                        </>
                      )}
                    </div>
                    <div className="space-y-0.5 text-zinc-200">
                      <p>這次你的選擇：<strong>{feedback.userAnswerLabel}</strong></p>
                      <p>當初實際選擇（{feedback.gameDate}）：<strong>{feedback.actualAnswerLabel}</strong></p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadQuiz(actionFilter)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-1.5 text-xs font-bold text-black hover:bg-zinc-200"
                    >
                      下一題 <ArrowRight size={13} />
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          {/* 5. 最近作答紀錄 */}
          {recent.length > 0 && (
            <section className={cardCls}>
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-zinc-200">
                <History size={15} className="text-zinc-400" />最近作答紀錄（私人）
              </h2>
              <ul className="space-y-1.5">
                {recent.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                            r.matched
                              ? 'bg-emerald-950/80 text-emerald-200'
                              : 'bg-amber-950/80 text-amber-200'
                          }`}
                        >
                          {r.matched ? '一致' : '不同'}
                        </span>
                        <span className="font-semibold text-white">{ACTION_LABELS[r.action]}</span>
                        <span className="text-zinc-400">
                          {r.seatLabel}・{roleLabel(r.role)}（{r.gameDate}）
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-500">{fmtTime(r.answeredAt)}</span>
                    </div>
                    <p className="mt-1 text-zinc-300">
                      重玩：<strong>{r.userAnswerLabel}</strong> ／ 當初：<strong>{r.actualAnswerLabel}</strong>
                    </p>
                    {r.reason && <p className="mt-0.5 text-zinc-400">理由：{r.reason}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
