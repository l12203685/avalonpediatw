import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  History,
  Loader2,
  LogIn,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  Sliders,
  Sparkles,
  Swords,
  UserCheck,
  XCircle,
} from 'lucide-react';
import '../i18n/aiKnights';
import { AI_KNIGHTS_NS } from '../i18n/aiKnights';
import { openAiKnightsTab } from '../components/aiKnights/AiKnightsHub';
import { getStoredToken } from '../services/socket';
import { useGameStore } from '../store/gameStore';
import {
  buildExternalAiPrompt,
  extractJsonFromAiReply,
  fetchAdminKnightClaims,
  fetchMyKnight,
  KnightApiError,
  RESIDUAL_ACTION_LABELS,
  reviewAdminKnightClaim,
  saveKnightAdjust,
  submitKnightClaim,
  validateKnightAdjust,
  type AdminKnightClaim,
  type FidelityMetricCell,
  type KnightAdjustPayload,
  type KnobMeta,
  type MyKnightResponse,
  type ResidualActionKey,
  type ValidateAdjustResponse,
} from '../services/myKnight';

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function cloneAdjust(a: KnightAdjustPayload | undefined): KnightAdjustPayload {
  return {
    schema: 1,
    ...(a?.note ? { note: a.note } : {}),
    ...(a?.source ? { source: a.source } : {}),
    ...(a?.overrides ? { overrides: { ...a.overrides } } : {}),
    ...(a?.sides
      ? {
          sides: {
            ...(a.sides.good ? { good: { ...a.sides.good } } : {}),
            ...(a.sides.evil ? { evil: { ...a.sides.evil } } : {}),
          },
        }
      : {}),
    ...(a?.roles
      ? {
          roles: Object.fromEntries(
            Object.entries(a.roles).map(([r, v]) => [r, { ...v }]),
          ),
        }
      : {}),
    ...(a?.residualOff ? { residualOff: [...a.residualOff] } : {}),
  };
}

function StatusBadge({ status }: { status: 'pending' | 'approved' | 'rejected' }): JSX.Element {
  if (status === 'approved') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/50 bg-emerald-950/60 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
        <CheckCircle2 size={12} />已核准
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/50 bg-rose-950/60 px-2 py-0.5 text-[11px] font-semibold text-rose-200">
        <XCircle size={12} />已退回
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-950/60 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
      <Clock size={12} />待站長審核
    </span>
  );
}

/**
 * 我的騎士（AI騎士團的分頁，#my-knight，統一 AI騎士 B2）。
 *
 * 1. 登入後送出「這個 ID 是我」認領申請（站長逐筆核准才生效）。
 * 2. 站長審核介面（後端透過帳號庫 email 比對 SEED_ADMIN_EMAILS 驗證）。
 * 3. 已核准後顯示自己的騎士與逐動作精準度（`knight_fidelity.json`）。
 * 4. 調整第 2 層（白名單開關 + 說明文字 + 殘差停用 + 私人改動紀錄）。
 * 5. 「用你自己的 AI 調整」：可複製提示詞 ＋ 貼回 JSON 檢查預覽與儲存。
 */
export default function MyKnightPage(): JSX.Element {
  const { t } = useTranslation(AI_KNIGHTS_NS);
  const setGameState = useGameStore((s) => s.setGameState);

  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MyKnightResponse | null>(null);

  // 認領表單
  const [claimPlayerId, setClaimPlayerId] = useState('');
  const [claimNote, setClaimNote] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 站長審核
  const [adminClaims, setAdminClaims] = useState<AdminKnightClaim[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminShowAll, setAdminShowAll] = useState(false);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  // 第 2 層編輯狀態
  const [draftAdjust, setDraftAdjust] = useState<KnightAdjustPayload>({ schema: 1 });
  const [feedbackText, setFeedbackText] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string; warnings?: string[] } | null>(null);
  const [activeSideTab, setActiveSideTab] = useState<'good' | 'evil' | 'assassin'>('good');

  // 「用你自己的 AI 調整」
  const [aiGoal, setAiGoal] = useState('');
  const [aiGameLink, setAiGameLink] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [showPromptPreview, setShowPromptPreview] = useState(false);
  const [pasteJson, setPasteJson] = useState('');
  const [validateBusy, setValidateBusy] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidateAdjustResponse | null>(null);
  const [pasteParseError, setPasteParseError] = useState<string | null>(null);

  const loadAdminClaims = useCallback(async (token: string) => {
    setAdminLoading(true);
    try {
      const res = await fetchAdminKnightClaims(token);
      setAdminClaims(res.claims);
    } catch {
      // ignore if not admin
    } finally {
      setAdminLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const token = getStoredToken();
    if (!token) {
      setAuthRequired(true);
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetchMyKnight(token);
      setAuthRequired(false);
      setData(res);
      setDraftAdjust(cloneAdjust(res.knight?.adjust));
      if (res.user.isAdmin) {
        void loadAdminClaims(token);
      }
    } catch (err) {
      if (err instanceof KnightApiError && err.status === 401) {
        setAuthRequired(true);
        setData(null);
      } else {
        setError(err instanceof Error ? err.message : '載入失敗，請稍後再試');
      }
    } finally {
      setLoading(false);
    }
  }, [loadAdminClaims]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleClaimSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const token = getStoredToken();
    if (!token) { setAuthRequired(true); return; }
    setClaimBusy(true);
    setClaimMsg(null);
    try {
      await submitKnightClaim(token, claimPlayerId, claimNote);
      setClaimPlayerId('');
      setClaimNote('');
      setClaimMsg({ kind: 'ok', text: '已送出認領申請，待站長逐筆核准後生效。' });
      await load();
    } catch (err) {
      setClaimMsg({ kind: 'err', text: err instanceof Error ? err.message : '送出失敗' });
    } finally {
      setClaimBusy(false);
    }
  };

  const handleAdminReview = async (claimId: string, decision: 'approved' | 'rejected'): Promise<void> => {
    const token = getStoredToken();
    if (!token) return;
    setReviewBusyId(claimId);
    setAdminMsg(null);
    try {
      await reviewAdminKnightClaim(token, claimId, decision, reviewReasons[claimId]);
      setAdminMsg(decision === 'approved' ? '已核准該筆認領申請。' : '已退回該筆認領申請。');
      await load();
    } catch (err) {
      setAdminMsg(err instanceof Error ? err.message : '審核失敗');
    } finally {
      setReviewBusyId(null);
    }
  };

  const setOverrideKnob = (knob: KnobMeta, enabled: boolean, value?: number | boolean): void => {
    setDraftAdjust((prev) => {
      const next = cloneAdjust(prev);
      const overrides = { ...(next.overrides ?? {}) };
      if (!enabled) {
        delete overrides[knob.key];
      } else {
        overrides[knob.key] = value !== undefined ? value : knob.defaultValue;
      }
      if (Object.keys(overrides).length > 0) next.overrides = overrides;
      else delete next.overrides;
      return next;
    });
  };

  const toggleResidualOff = (action: ResidualActionKey): void => {
    setDraftAdjust((prev) => {
      const next = cloneAdjust(prev);
      const set = new Set<ResidualActionKey>(next.residualOff ?? []);
      if (set.has(action)) set.delete(action);
      else set.add(action);
      if (set.size > 0) next.residualOff = [...set];
      else delete next.residualOff;
      return next;
    });
  };

  const handleSaveAdjust = async (adjustToSave: KnightAdjustPayload, source: 'web' | 'ai-paste'): Promise<void> => {
    const token = getStoredToken();
    if (!token) { setAuthRequired(true); return; }
    setSaveBusy(true);
    setSaveMsg(null);
    try {
      const res = await saveKnightAdjust(token, adjustToSave, feedbackText, source);
      setData((prev) => (prev && prev.knight
        ? {
            ...prev,
            knight: {
              ...prev.knight,
              adjust: res.adjust,
              updatedAt: res.updatedAt,
              history: res.history,
            },
          }
        : prev));
      setDraftAdjust(cloneAdjust(res.adjust));
      setFeedbackText('');
      setSaveMsg({
        kind: 'ok',
        text: '已儲存第 2 層調整並立即套用到正式對局！',
        warnings: res.warnings,
      });
    } catch (err) {
      setSaveMsg({ kind: 'err', text: err instanceof Error ? err.message : '儲存失敗' });
    } finally {
      setSaveBusy(false);
    }
  };

  const externalPrompt = useMemo(() => {
    if (!data?.knight) return '';
    return buildExternalAiPrompt({
      knight: data.knight,
      fidelity: data.fidelity,
      knobs: data.knobs,
      userGoal: aiGoal,
      gameLink: aiGameLink,
    });
  }, [data, aiGoal, aiGameLink]);

  const handleCopyPrompt = (): void => {
    const done = (ok: boolean): void => {
      setCopyState(ok ? 'done' : 'failed');
      window.setTimeout(() => setCopyState('idle'), 2000);
    };
    if (!navigator.clipboard || !externalPrompt) { done(false); return; }
    navigator.clipboard.writeText(externalPrompt).then(() => done(true), () => done(false));
  };

  const handleValidatePaste = async (): Promise<void> => {
    const token = getStoredToken();
    if (!token) { setAuthRequired(true); return; }
    setPasteParseError(null);
    setValidationResult(null);
    const parsed = extractJsonFromAiReply(pasteJson);
    if (!parsed.ok) {
      setPasteParseError(parsed.error);
      return;
    }
    setValidateBusy(true);
    try {
      const res = await validateKnightAdjust(token, parsed.value);
      setValidationResult(res);
    } catch (err) {
      setPasteParseError(err instanceof Error ? err.message : '驗證失敗');
    } finally {
      setValidateBusy(false);
    }
  };

  const cardCls = 'space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/80 p-3 sm:p-4';
  const linkCls = 'flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800';
  const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-amber-400 focus:outline-none';

  const visibleAdminClaims = useMemo(
    () => (adminShowAll ? adminClaims : adminClaims.filter((c) => c.status === 'pending')),
    [adminClaims, adminShowAll],
  );
  const pendingAdminCount = useMemo(
    () => adminClaims.filter((c) => c.status === 'pending').length,
    [adminClaims],
  );

  const groupedKnobs = useMemo(() => {
    const all = data?.knobs ?? [];
    return {
      good: all.filter((k) => k.side === 'good'),
      evil: all.filter((k) => k.side === 'evil'),
      assassin: all.filter((k) => k.side === 'assassin'),
    };
  }, [data?.knobs]);

  const fidelityRows = useMemo(() => {
    const s = data?.fidelity?.time;
    if (!s) return [];
    const rows: { label: string; cell?: FidelityMetricCell }[] = [
      { label: '整體一致率', cell: s.overall },
      { label: '投票', cell: s.vote },
      { label: '任務牌', cell: s.quest },
      { label: '派隊 Top1', cell: s.teamTop1 },
      { label: '查驗對象', cell: s.lakeTarget },
      { label: '紅方報湖', cell: s.lakeClaimRed },
      { label: '紅方非常規票 F1', cell: s.abnormalF1?.red },
      { label: '藍方非常規票 F1', cell: s.abnormalF1?.blue },
      { label: '派西信任回合', cell: s.percivalTrustRound },
      { label: '梅林差距（越低越像）', cell: s.merlinRateGap },
    ];
    return rows.filter((r) => r.cell);
  }, [data?.fidelity]);

  return (
    <div className="relative z-10 mx-auto max-w-4xl space-y-4 px-3 py-4 text-white sm:px-4" data-testid="my-knight-page">
      {/* 頁首 */}
      <section className={cardCls}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-bold">
            <Shield size={20} className="text-amber-300" />
            {t('mine.title')}
            {data?.user.isAdmin && (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-400/50 bg-sky-950/60 px-2 py-0.5 text-[11px] font-semibold text-sky-200">
                <ShieldCheck size={12} />站長
              </span>
            )}
          </h1>
          {!authRequired && (
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />重新整理
            </button>
          )}
        </div>
        <p className="text-xs leading-relaxed text-zinc-300">
          每位玩家擁有一隻與自己牌譜對應的統一 AI騎士（<code className="text-amber-200">AI騎士_玩家ID_01</code>）：第 1 層由真人牌譜自動擬合，第 2 層由你親自調整（即時套用到正式對局，並同步到每日擂台）。
        </p>
      </section>

      {loading && (
        <div className={`${cardCls} flex items-center gap-2 text-sm text-zinc-300`}>
          <Loader2 size={16} className="animate-spin text-amber-300" />載入我的騎士資料中…
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* 未登入或訪客 */}
      {!loading && authRequired && (
        <section className={cardCls} data-testid="my-knight-login-required">
          <h2 className="flex items-center gap-2 text-sm font-bold text-amber-200">
            <LogIn size={16} />請先登入正式帳號
          </h2>
          <p className="text-xs leading-relaxed text-zinc-300">
            認領玩家 ID 與調整自己的 AI騎士 需要使用 Email 帳號登入（訪客模式無法保存私人設定）。登入後可送出「這個 ID 是我」申請，經站長逐筆核准即生效。
          </p>
          <button
            type="button"
            onClick={() => setGameState('settings')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-black hover:bg-amber-300"
            data-testid="my-knight-go-login"
          >
            <LogIn size={15} />前往登入
          </button>
        </section>
      )}

      {/* 已登入主內容 */}
      {!loading && !authRequired && data && (
        <>
          {/* 1. 帳號 ↔ 玩家 ID 認領 */}
          <section className={cardCls} data-testid="my-knight-claim-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
                <UserCheck size={16} className="text-amber-300" />帳號 ↔ 玩家 ID 認領（「這個 ID 是我」）
              </h2>
              <span className="text-xs text-zinc-400">登入帳號：{data.user.displayName}</span>
            </div>

            {data.knight ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-3 py-2 text-xs">
                <div>
                  已綁定玩家 ID：<strong className="text-emerald-200">{data.knight.playerId}</strong>
                  <span className="ml-2 text-zinc-400">（{data.knight.displayName}）</span>
                </div>
                <StatusBadge status="approved" />
              </div>
            ) : (
              <form onSubmit={(e) => void handleClaimSubmit(e)} className="space-y-2.5">
                <p className="text-xs text-zinc-400">
                  輸入你在牌譜裡使用的玩家 ID（或從下方既有 AI騎士 名冊選取），送出後由站長逐筆核准。
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="claim-player-id">玩家 ID</label>
                    <input
                      id="claim-player-id"
                      list="official-knight-player-ids"
                      value={claimPlayerId}
                      onChange={(e) => setClaimPlayerId(e.target.value)}
                      placeholder="例如：ED、豬羊、小花"
                      className={inputCls}
                      maxLength={32}
                      required
                    />
                    <datalist id="official-knight-player-ids">
                      {data.officialKnights.map((k) => (
                        <option key={k.id} value={k.playerId}>{k.name}{k.tag ? `（${k.tag}）` : ''}</option>
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="claim-note">補充說明（選填，僅站長可見）</label>
                    <input
                      id="claim-note"
                      value={claimNote}
                      onChange={(e) => setClaimNote(e.target.value)}
                      placeholder="例如：Discord 暱稱或常玩時段，方便站長確認"
                      className={inputCls}
                      maxLength={200}
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={claimBusy || !claimPlayerId.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-amber-300 disabled:opacity-50"
                  data-testid="my-knight-claim-submit"
                >
                  {claimBusy ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                  送出「這個 ID 是我」
                </button>
                {claimMsg && (
                  <p className={`text-xs ${claimMsg.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {claimMsg.text}
                  </p>
                )}
              </form>
            )}

            {data.claims.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <p className="text-xs font-semibold text-zinc-400">我的認領紀錄</p>
                <ul className="space-y-1.5">
                  {data.claims.map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-zinc-100">{c.playerId}</span>
                          <StatusBadge status={c.status} />
                          <span className="text-zinc-500">{fmtTime(c.createdAt)}</span>
                        </div>
                        {c.note && <p className="text-zinc-400">說明：{c.note}</p>}
                        {c.reviewReason && <p className="text-zinc-300">站長備註：{c.reviewReason}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* 2. 站長審核介面（僅站長可見） */}
          {data.user.isAdmin && (
            <section className="space-y-3 rounded-xl border border-sky-700/50 bg-sky-950/20 p-3 sm:p-4" data-testid="my-knight-admin-panel">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-sky-200">
                  <ShieldCheck size={16} />站長審核介面（待審核 {pendingAdminCount} 筆）
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAdminShowAll((v) => !v)}
                    className="rounded-md border border-sky-700/60 bg-zinc-900 px-2.5 py-1 text-xs text-sky-200 hover:bg-zinc-800"
                  >
                    {adminShowAll ? '只看待審核' : `顯示全部 (${adminClaims.length})`}
                  </button>
                </div>
              </div>
              {adminMsg && <p className="text-xs text-emerald-300">{adminMsg}</p>}
              {adminLoading ? (
                <p className="flex items-center gap-2 text-xs text-zinc-400">
                  <Loader2 size={14} className="animate-spin" />讀取認領申請中…
                </p>
              ) : visibleAdminClaims.length === 0 ? (
                <p className="text-xs text-zinc-400">目前沒有{adminShowAll ? '' : '待審核的'}認領申請。</p>
              ) : (
                <ul className="space-y-2">
                  {visibleAdminClaims.map((c) => (
                    <li
                      key={c.id}
                      className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/80 p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-amber-200">{c.playerId}</span>
                          <span className="text-zinc-300">申請人：{c.displayName}</span>
                          <StatusBadge status={c.status} />
                        </div>
                        <span className="text-zinc-500">{fmtTime(c.createdAt)}</span>
                      </div>
                      {c.note && <p className="text-zinc-300">申請補充：{c.note}</p>}
                      {c.status === 'pending' ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <input
                            value={reviewReasons[c.id] ?? ''}
                            onChange={(e) => setReviewReasons((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            placeholder="審核備註（選填）"
                            className="min-w-[180px] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-white placeholder-zinc-500"
                            maxLength={200}
                          />
                          <button
                            type="button"
                            disabled={reviewBusyId === c.id}
                            onClick={() => void handleAdminReview(c.id, 'approved')}
                            className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-3 py-1 text-xs font-bold text-black hover:bg-emerald-400 disabled:opacity-50"
                          >
                            <Check size={13} />核准
                          </button>
                          <button
                            type="button"
                            disabled={reviewBusyId === c.id}
                            onClick={() => void handleAdminReview(c.id, 'rejected')}
                            className="inline-flex items-center gap-1 rounded-md border border-rose-500/60 bg-rose-950/60 px-3 py-1 text-xs font-bold text-rose-200 hover:bg-rose-900/60 disabled:opacity-50"
                          >
                            <XCircle size={13} />退回
                          </button>
                        </div>
                      ) : (
                        <p className="text-zinc-500">
                          審核時間：{fmtTime(c.reviewedAt)}{c.reviewReason ? `｜備註：${c.reviewReason}` : ''}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* 3. 已核准騎士：資訊、逐動作精準度、第 2 層調整與 AI 提示 */}
          {data.knight && (
            <>
              {/* 騎士概覽 + 逐動作精準度 */}
              <section className={cardCls} data-testid="my-knight-fidelity">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold text-amber-200">
                    <Shield size={16} />{data.knight.displayName}
                    {data.knight.layer1?.tag && (
                      <span className="rounded-full border border-amber-400/50 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-200">
                        {data.knight.layer1.tag}
                      </span>
                    )}
                    <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] font-normal text-zinc-300">
                      {data.knight.layer1?.fit === 'fitted' ? '第 1 層：已從牌譜擬合' : '第 1 層：尚無牌譜／預設引擎'}
                    </span>
                  </h2>
                  <span className="text-[11px] text-zinc-500">最後調整：{fmtTime(data.knight.updatedAt)}</span>
                </div>
                {data.knight.layer1?.style && (
                  <p className="text-xs leading-relaxed text-zinc-300">{data.knight.layer1.style}</p>
                )}

                <div className="space-y-1.5 pt-1">
                  <h3 className="text-xs font-bold text-zinc-200">逐動作精準度（和你的真人牌譜比對）</h3>
                  {fidelityRows.length > 0 ? (
                    <div className="overflow-x-auto rounded-lg border border-zinc-800">
                      <table className="w-full text-left text-xs tabular-nums">
                        <thead className="bg-zinc-950 text-zinc-400">
                          <tr>
                            <th className="px-2.5 py-1.5">動作指標</th>
                            <th className="px-2.5 py-1.5 text-right">樣本數</th>
                            <th className="px-2.5 py-1.5 text-right">百科AI (D)</th>
                            <th className="px-2.5 py-1.5 text-right">開關版 (K)</th>
                            <th className="px-2.5 py-1.5 text-right text-amber-200">你的騎士 (V2)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/80 bg-zinc-900/50">
                          {fidelityRows.map(({ label, cell }) => (
                            <tr key={label}>
                              <td className="px-2.5 py-1.5 text-zinc-200">{label}</td>
                              <td className="px-2.5 py-1.5 text-right text-zinc-400">{cell?.n ?? '—'}</td>
                              <td className="px-2.5 py-1.5 text-right text-zinc-400">{fmtPct(cell?.D)}</td>
                              <td className="px-2.5 py-1.5 text-right text-zinc-300">{fmtPct(cell?.K)}</td>
                              <td className="px-2.5 py-1.5 text-right font-semibold text-amber-200">{fmtPct(cell?.V2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-400">
                      目前尚無此玩家 ID 的逐動作精準度報告（累積足夠真人牌譜並於每週自動擬合後會顯示在這裡）。
                    </p>
                  )}
                </div>
              </section>

              {/* 4. 調整第 2 層（白名單開關 + 說明文字 + 殘差停用 + 改動紀錄） */}
              <section className={cardCls} data-testid="my-knight-adjust-editor">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
                    <Sliders size={16} className="text-amber-300" />調整第 2 層（白名單開關與說明）
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftAdjust(cloneAdjust(data.knight?.adjust));
                      setSaveMsg(null);
                    }}
                    className="text-xs text-zinc-400 hover:text-white"
                  >
                    重設為目前版本
                  </button>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="adjust-note">
                      風格說明（note，選填，最多 300 字）
                    </label>
                    <textarea
                      id="adjust-note"
                      rows={2}
                      maxLength={300}
                      value={draftAdjust.note ?? ''}
                      onChange={(e) => setDraftAdjust((prev) => ({ ...prev, note: e.target.value || undefined }))}
                      placeholder="例如：紅方第 3 局起更常照紅方利益投、藍方不在隊上更嚴格"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="adjust-feedback">
                      本次調整原因／回饋（僅存私人紀錄，絕不公開）
                    </label>
                    <textarea
                      id="adjust-feedback"
                      rows={2}
                      maxLength={500}
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      placeholder="記錄你為什麼這樣調，方便日後回顧"
                      className={inputCls}
                    />
                  </div>
                </div>

                {/* 分邊開關頁籤 */}
                <div className="flex gap-1 rounded-lg bg-zinc-950 p-1 text-xs">
                  {(
                    [
                      ['good', `藍方（${groupedKnobs.good.length}）`],
                      ['evil', `紅方（${groupedKnobs.evil.length}）`],
                      ['assassin', `刺客（${groupedKnobs.assassin.length}）`],
                    ] as const
                  ).map(([side, label]) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => setActiveSideTab(side)}
                      className={`flex-1 rounded-md py-1.5 font-semibold transition-colors ${
                        activeSideTab === side ? 'bg-zinc-800 text-amber-200' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="space-y-2">
                  {groupedKnobs[activeSideTab].map((knob) => {
                    const currentVal = draftAdjust.overrides?.[knob.key];
                    const enabled = currentVal !== undefined;
                    const displayVal = enabled ? currentVal : knob.defaultValue;
                    return (
                      <div
                        key={knob.key}
                        className={`rounded-lg border p-2.5 text-xs ${
                          enabled ? 'border-amber-500/50 bg-amber-950/15' : 'border-zinc-800 bg-zinc-950/60'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex cursor-pointer items-center gap-2 font-semibold text-zinc-100">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) => setOverrideKnob(knob, e.target.checked)}
                              className="h-3.5 w-3.5 accent-amber-400"
                            />
                            <code>{knob.key}</code>
                            <span className="font-normal text-zinc-400">
                              （預設 {String(knob.defaultValue)}）
                            </span>
                          </label>
                          {enabled && knob.kind === 'number' && (
                            <span className="font-bold tabular-nums text-amber-200">{String(displayVal)}</span>
                          )}
                        </div>
                        <p className="mt-1 text-zinc-300">{knob.zh}</p>
                        {enabled && (
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {knob.kind === 'boolean' ? (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setOverrideKnob(knob, true, true)}
                                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                                    displayVal === true ? 'bg-amber-400 text-black' : 'border border-zinc-700 bg-zinc-900 text-zinc-300'
                                  }`}
                                >
                                  開 (true)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setOverrideKnob(knob, true, false)}
                                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                                    displayVal === false ? 'bg-amber-400 text-black' : 'border border-zinc-700 bg-zinc-900 text-zinc-300'
                                  }`}
                                >
                                  關 (false)
                                </button>
                              </div>
                            ) : (
                              <>
                                <input
                                  type="range"
                                  min={knob.min ?? 0}
                                  max={knob.max ?? 1}
                                  step={0.01}
                                  value={Number(displayVal)}
                                  onChange={(e) => setOverrideKnob(knob, true, Number(e.target.value))}
                                  className="min-w-[160px] flex-1 accent-amber-400"
                                />
                                <input
                                  type="number"
                                  min={knob.min ?? 0}
                                  max={knob.max ?? 1}
                                  step={0.01}
                                  value={Number(displayVal)}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n)) setOverrideKnob(knob, true, n);
                                  }}
                                  className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-right text-xs text-white"
                                />
                              </>
                            )}
                          </div>
                        )}
                        <p className="mt-1 text-[11px] text-zinc-500">
                          調高/開：{knob.zhUp} ｜ 調低/關：{knob.zhDown}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {/* residualOff 停用殘差層勾選 */}
                <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-xs">
                  <p className="font-semibold text-zinc-200">停用殘差層的動作（residualOff，選填）</p>
                  <p className="text-[11px] text-zinc-400">
                    勾選的動作會純粹照第 1＋2 層白名單開關決定，不讓殘差層把你的手動調整拉回。
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {data.residualActions.map((act) => {
                      const checked = (draftAdjust.residualOff ?? []).includes(act);
                      return (
                        <label
                          key={act}
                          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 ${
                            checked ? 'border-amber-400/60 bg-amber-950/40 text-amber-200' : 'border-zinc-700 bg-zinc-900 text-zinc-300'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleResidualOff(act)}
                            className="accent-amber-400"
                          />
                          {RESIDUAL_ACTION_LABELS[act]} ({act})
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={saveBusy}
                    onClick={() => void handleSaveAdjust(draftAdjust, 'web')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-black hover:bg-amber-300 disabled:opacity-50"
                    data-testid="my-knight-save-adjust"
                  >
                    {saveBusy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    儲存第 2 層調整
                  </button>
                  {saveMsg && (
                    <span className={`text-xs ${saveMsg.kind === 'ok' ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {saveMsg.text}
                    </span>
                  )}
                </div>
                {saveMsg?.warnings && saveMsg.warnings.length > 0 && (
                  <ul className="space-y-0.5 rounded-lg border border-amber-500/40 bg-amber-950/30 p-2 text-xs text-amber-200">
                    {saveMsg.warnings.map((w) => <li key={w}>提醒：{w}</li>)}
                  </ul>
                )}

                {/* 改動紀錄 */}
                <div className="space-y-1.5 pt-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-zinc-300">
                    <History size={14} />改動紀錄（僅本人可見，最新 {data.knight.history.length} 筆）
                  </h3>
                  {data.knight.history.length === 0 ? (
                    <p className="text-xs text-zinc-500">還沒有手動調整過第 2 層。</p>
                  ) : (
                    <ul className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
                      {data.knight.history.map((h) => (
                        <li key={h.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-amber-200">{h.summary || '更新第 2 層'}</span>
                            <span className="text-[11px] text-zinc-500">{fmtTime(h.at)} · {h.source}</span>
                          </div>
                          {h.note && <p className="mt-0.5 text-zinc-300">說明：{h.note}</p>}
                          {h.feedback && <p className="mt-0.5 text-zinc-400">回饋：{h.feedback}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>

              {/* 5. 用你自己的 AI 調整 */}
              <section className={cardCls} data-testid="my-knight-ai-helper">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-zinc-100">
                  <Sparkles size={16} className="text-amber-300" />用你自己的 AI 調整（ChatGPT / Claude / Gemini）
                </h2>
                <p className="text-xs leading-relaxed text-zinc-300">
                  一鍵複製已預填你目前設定、白名單開關表與逐動作精準度的提示詞，貼給你的 AI 討論後，把 AI 產生的第 2 層 JSON 貼回下方檢查、預覽並儲存。
                </p>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="ai-goal">你想怎麼調（預填進提示詞，選填）</label>
                    <input
                      id="ai-goal"
                      value={aiGoal}
                      onChange={(e) => setAiGoal(e.target.value)}
                      placeholder="例如：紅方再敢疊隊一點，但梅林不要被刺中"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-300" htmlFor="ai-game-link">公開牌局連結（選填）</label>
                    <input
                      id="ai-game-link"
                      value={aiGameLink}
                      onChange={(e) => setAiGameLink(e.target.value)}
                      placeholder="https://avalonpediatw.pages.dev/#records=..."
                      className={inputCls}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyPrompt}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-bold text-black hover:bg-zinc-200"
                    data-testid="my-knight-copy-prompt"
                  >
                    {copyState === 'done' ? <Check size={14} /> : <Copy size={14} />}
                    {copyState === 'done' ? '已複製提示詞' : copyState === 'failed' ? '複製失敗，請展開手動複製' : '複製提示詞給自己的 AI'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPromptPreview((v) => !v)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {showPromptPreview ? '收合提示詞預覽' : '檢視提示詞內容'}
                  </button>
                </div>

                {showPromptPreview && (
                  <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-[11px] leading-relaxed text-zinc-300">
                    {externalPrompt}
                  </pre>
                )}

                <div className="space-y-2 pt-2">
                  <label className="block text-xs font-semibold text-zinc-200" htmlFor="paste-ai-json">
                    貼回 AI 產生的第 2 層 JSON（支援整段回覆或 ```json 區塊）
                  </label>
                  <textarea
                    id="paste-ai-json"
                    rows={5}
                    value={pasteJson}
                    onChange={(e) => {
                      setPasteJson(e.target.value);
                      setValidationResult(null);
                      setPasteParseError(null);
                    }}
                    placeholder={'{\n  "schema": 1,\n  "note": "紅方大膽一點",\n  "overrides": { "redNormalVote": 0.7 }\n}'}
                    className={`${inputCls} font-mono text-xs`}
                    data-testid="my-knight-paste-json"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={validateBusy || !pasteJson.trim()}
                      onClick={() => void handleValidatePaste()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/60 bg-amber-950/40 px-3.5 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
                      data-testid="my-knight-validate-json"
                    >
                      {validateBusy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                      檢查與預覽
                    </button>
                    {validationResult?.ok && validationResult.adjust && (
                      <button
                        type="button"
                        disabled={saveBusy}
                        onClick={() => {
                          if (!validationResult.adjust) return;
                          setDraftAdjust(cloneAdjust(validationResult.adjust));
                          void handleSaveAdjust(validationResult.adjust, 'ai-paste');
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-emerald-300 disabled:opacity-50"
                        data-testid="my-knight-apply-json"
                      >
                        <Save size={14} />套用並儲存成第 2 層
                      </button>
                    )}
                  </div>

                  {pasteParseError && (
                    <p className="flex items-center gap-1.5 text-xs text-rose-300">
                      <AlertTriangle size={14} />{pasteParseError}
                    </p>
                  )}

                  {validationResult && (
                    <div
                      className={`space-y-1.5 rounded-lg border p-2.5 text-xs ${
                        validationResult.ok
                          ? 'border-emerald-600/50 bg-emerald-950/30 text-emerald-200'
                          : 'border-rose-600/50 bg-rose-950/30 text-rose-200'
                      }`}
                    >
                      {validationResult.ok ? (
                        <>
                          <p className="font-semibold">檢查通過！差異預覽：{validationResult.diffSummary || '無開關變動'}</p>
                          {validationResult.warnings.length > 0 && (
                            <ul className="list-disc pl-4 text-amber-200">
                              {validationResult.warnings.map((w) => <li key={w}>{w}</li>)}
                            </ul>
                          )}
                          <pre className="max-h-40 overflow-auto rounded bg-zinc-950/80 p-2 font-mono text-[11px] text-zinc-200">
                            {JSON.stringify(validationResult.adjust, null, 2)}
                          </pre>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold">檢查未通過，請修正以下項目：</p>
                          <ul className="list-disc pl-4">
                            {validationResult.errors.map((err) => <li key={err}>{err}</li>)}
                          </ul>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}

      {/* 連到擂台與練習 */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-zinc-200">{t('mine.nowTitle')}</h2>
        <button type="button" className={linkCls} onClick={() => openAiKnightsTab('arena')} data-testid="my-knight-arena">
          <Swords size={16} className="flex-shrink-0 text-rose-300" />
          <span className="min-w-0 flex-1">{t('mine.nowArena')}</span>
          <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
        </button>
        <button type="button" className={linkCls} onClick={() => openAiKnightsTab('practice')} data-testid="my-knight-practice">
          <Bot size={16} className="flex-shrink-0 text-sky-300" />
          <span className="min-w-0 flex-1">{t('mine.nowPractice')}</span>
          <ChevronRight size={16} className="flex-shrink-0 text-zinc-500" />
        </button>
      </section>
    </div>
  );
}
