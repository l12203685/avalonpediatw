import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Loader, ShieldCheck, XCircle, CheckCircle2, ChevronDown, ChevronUp, Inbox, Users, Activity, Upload } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchPendingClaims,
  approveClaimApi,
  rejectClaimApi,
  fetchAdminMe,
  ClaimableRecord,
  PendingClaimView,
} from '../services/api';
import { getStoredToken } from '../services/socket';

const ROLE_LABELS: Record<string, string> = {
  merlin: '梅林',
  percival: '派西維爾',
  loyal: '忠臣',
  assassin: '刺客',
  morgana: '莫甘娜',
  mordred: '莫德雷德',
  oberon: '奧伯倫',
  minion: '爪牙',
};

function formatDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-TW', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function roleLabel(role: string | null): string {
  if (!role) return '未知';
  return ROLE_LABELS[role] ?? role;
}

interface AdminRecordRowProps {
  record: ClaimableRecord;
  checked: boolean;
  onToggle: () => void;
}

function AdminRecordRow({ record, checked, onToggle }: AdminRecordRowProps): JSX.Element {
  const teamColor = record.team === 'evil'
    ? 'text-red-300'
    : record.team === 'good'
      ? 'text-blue-300'
      : 'text-gray-400';
  const wonLabel = record.won ? '勝' : '敗';
  const wonColor = record.won ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300';
  return (
    <label className={`flex items-center gap-3 py-2 px-3 border-b border-gray-700/50 last:border-0 cursor-pointer hover:bg-avalon-card/60 transition-colors ${
      checked ? 'bg-blue-900/10' : ''
    }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="w-4 h-4 accent-blue-500 flex-shrink-0"
      />
      <div className={`w-10 text-center text-xs font-bold py-0.5 rounded ${wonColor}`}>{wonLabel}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-semibold ${teamColor}`}>{roleLabel(record.role)}</span>
          <span className="text-xs text-gray-500">{record.playerCount}人局</span>
          {record.matchScore !== undefined && (
            <span className="text-xs px-1.5 py-0.5 bg-amber-900/40 border border-amber-700/50 text-amber-300 rounded-full">
              相似度 {record.matchScore.toFixed(0)}%
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 mt-0.5 truncate">
          當時暱稱：<span className="text-gray-300">{record.displayName}</span>
        </div>
      </div>
      <div className="text-xs text-gray-500 w-20 text-right flex-shrink-0">{formatDate(record.createdAt)}</div>
    </label>
  );
}

interface ClaimCardProps {
  view: PendingClaimView;
  onApprove: (claimId: string, approvedIds: string[]) => Promise<void>;
  onReject: (claimId: string, reason: string) => Promise<void>;
  working: boolean;
}

function ClaimCard({ view, onApprove, onReject, working }: ClaimCardProps): JSX.Element {
  const { claim, records } = view;
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(claim.targetRecordIds));
  const [rejectMode, setRejectMode] = useState(false);
  const [reason, setReason] = useState('');

  const toggle = (id: string): void => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = (): void => {
    if (selected.size === claim.targetRecordIds.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(claim.targetRecordIds));
    }
  };

  const handleApprove = async (): Promise<void> => {
    await onApprove(claim.id, Array.from(selected));
  };

  const handleReject = async (): Promise<void> => {
    await onReject(claim.id, reason.trim());
    setRejectMode(false);
    setReason('');
  };

  const allSelected = selected.size === claim.targetRecordIds.length && claim.targetRecordIds.length > 0;

  return (
    <div className="bg-avalon-card/50 border border-gray-700 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-avalon-card/70 transition-colors"
      >
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white truncate">
              {claim.displayName}
            </span>
            {claim.email && (
              <span className="text-xs text-gray-400 truncate">({claim.email})</span>
            )}
            {claim.autoMatched && (
              <span className="text-xs px-1.5 py-0.5 bg-amber-900/40 border border-amber-700/50 text-amber-300 rounded-full">
                自動比對
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            送出於 {formatDateTime(claim.submittedAt)} · 申請 {claim.targetRecordIds.length} 場
          </p>
        </div>
        {expanded ? <ChevronUp size={18} className="text-gray-500 flex-shrink-0" /> : <ChevronDown size={18} className="text-gray-500 flex-shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-gray-700 p-4 space-y-3">
          {/* Evidence note */}
          {claim.evidenceNote && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
              <p className="text-xs text-gray-400 mb-1">申請人備註</p>
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{claim.evidenceNote}</p>
            </div>
          )}

          {/* Records list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-gray-400">申請戰績清單</p>
              {records.length > 0 && (
                <button
                  onClick={selectAll}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  {allSelected ? '取消全選' : '全選'}
                </button>
              )}
            </div>
            {records.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-3">戰績資料載入失敗或已被刪除</p>
            ) : (
              <div className="bg-gray-900/30 rounded-lg max-h-80 overflow-y-auto">
                {records.map(r => (
                  <AdminRecordRow
                    key={r.recordId}
                    record={r}
                    checked={selected.has(r.recordId)}
                    onToggle={() => toggle(r.recordId)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          {!rejectMode ? (
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => void handleApprove()}
                disabled={working || selected.size === 0}
                className="flex-1 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {working ? <Loader size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                批准 {selected.size} 場
              </button>
              <button
                onClick={() => setRejectMode(true)}
                disabled={working}
                className="flex-1 bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <XCircle size={16} />
                否決
              </button>
            </div>
          ) : (
            <div className="space-y-2 pt-2">
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="否決理由（例如：暱稱對不上、無法辨識為同一人）"
                className="w-full bg-gray-800 border border-gray-700 focus:border-red-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none resize-none"
                rows={2}
                maxLength={500}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void handleReject()}
                  disabled={working || !reason.trim()}
                  className="flex-1 bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-bold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {working ? <Loader size={16} className="animate-spin" /> : <XCircle size={16} />}
                  確認否決
                </button>
                <button
                  onClick={() => { setRejectMode(false); setReason(''); }}
                  disabled={working}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold py-2 rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminClaimsPage(): JSX.Element {
  const { setGameState, addToast } = useGameStore();

  const [pending, setPending] = useState<PendingClaimView[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const token = getStoredToken();

  useEffect(() => {
    if (!token) {
      setAuthError('請先登入');
      setLoading(false);
      return;
    }
    // Verify admin first to give a friendly message rather than a raw 403
    fetchAdminMe(token)
      .then(me => {
        if (!me.isAdmin) {
          setAuthError('此頁面僅限管理員使用');
          return;
        }
        return fetchPendingClaims(token).then(setPending);
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : '載入失敗';
        setAuthError(msg);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const refresh = async (): Promise<void> => {
    if (!token) return;
    try {
      const data = await fetchPendingClaims(token);
      setPending(data);
    } catch {
      // ignore
    }
  };

  const handleApprove = async (claimId: string, approvedIds: string[]): Promise<void> => {
    if (!token) return;
    if (approvedIds.length === 0) {
      addToast('請至少勾選一場要批准的戰績', 'info');
      return;
    }
    setWorking(true);
    try {
      await approveClaimApi(token, claimId, approvedIds);
      addToast(`已批准 ${approvedIds.length} 場戰績`, 'success');
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '批准失敗';
      addToast(msg, 'error');
    } finally {
      setWorking(false);
    }
  };

  const handleReject = async (claimId: string, reason: string): Promise<void> => {
    if (!token) return;
    if (!reason) {
      addToast('請填寫否決理由', 'info');
      return;
    }
    setWorking(true);
    try {
      await rejectClaimApi(token, claimId, reason);
      addToast('已否決申請', 'success');
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '否決失敗';
      addToast(msg, 'error');
    } finally {
      setWorking(false);
    }
  };

  const totalRecords = useMemo(
    () => pending.reduce((sum, v) => sum + v.claim.targetRecordIds.length, 0),
    [pending]
  );

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('home')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
              <ShieldCheck size={24} className="text-amber-400" /> 申請審核
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">審核玩家綁定舊戰績的申請</p>
          </div>
          <button
            onClick={() => setGameState('adminImport')}
            className="flex items-center gap-1 text-xs px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700"
            title="批次匯入歷史戰績"
          >
            <Upload size={14} />
            匯入
          </button>
          <button
            onClick={() => setGameState('adminElo')}
            className="flex items-center gap-1 text-xs px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700"
            title="ELO 設定"
          >
            <Activity size={14} />
            ELO
          </button>
          <button
            onClick={() => setGameState('adminAdmins')}
            className="flex items-center gap-1 text-xs px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700"
            title="管理管理員列表"
          >
            <Users size={14} />
            管理員
          </button>
        </div>

        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-amber-400" />
          </div>
        )}

        {authError && !loading && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
            {authError}
          </div>
        )}

        {!loading && !authError && (
          <>
            <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4 text-center">
              <div className="text-xs text-gray-400 mb-1 flex items-center justify-center gap-1">
                <Inbox size={12} /> 待審核
              </div>
              <div className="text-3xl font-black text-white">
                {pending.length} <span className="text-sm text-gray-500 font-normal">筆申請</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">涉及 {totalRecords} 場戰績</div>
            </div>

            {pending.length === 0 ? (
              <div className="bg-avalon-card/40 border border-gray-700 rounded-xl p-8 text-center">
                <Inbox size={40} className="text-gray-600 mx-auto mb-3" />
                <p className="text-sm text-gray-500">目前沒有待審核的申請</p>
              </div>
            ) : (
              <div className="space-y-4">
                {pending.map(view => (
                  <ClaimCard
                    key={view.claim.id}
                    view={view}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    working={working}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
