import { useState, useEffect } from 'react';
import { ArrowLeft, Loader, UserPlus, Trash2, ShieldCheck, FileText, ShieldAlert, ClipboardList } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchAdminList,
  addAdminApi,
  removeAdminApi,
  fetchAuditLog,
  fetchAdminMe,
  AuditLogEntryApi,
} from '../services/api';
import { getStoredToken } from '../services/socket';

function formatDateTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-TW', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function actionLabel(action: AuditLogEntryApi['action']): { text: string; className: string } {
  switch (action) {
    case 'approve':     return { text: '批准', className: 'bg-green-900/60 text-green-300 border-green-600/50' };
    case 'reject':      return { text: '否決', className: 'bg-red-900/60 text-red-300 border-red-600/50' };
    case 'addAdmin':    return { text: '新增管理員', className: 'bg-blue-900/60 text-blue-300 border-blue-600/50' };
    case 'removeAdmin': return { text: '移除管理員', className: 'bg-yellow-900/60 text-yellow-300 border-yellow-600/50' };
    default:            return { text: action, className: 'bg-gray-800 text-gray-300 border-gray-600' };
  }
}

export default function AdminAdminsPage(): JSX.Element {
  const { setGameState, addToast } = useGameStore();

  const [admins, setAdmins] = useState<string[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntryApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [myEmail, setMyEmail] = useState<string | null>(null);

  const token = getStoredToken();

  useEffect(() => {
    if (!token) {
      setAuthError('請先登入');
      setLoading(false);
      return;
    }
    fetchAdminMe(token)
      .then(me => {
        if (!me.isAdmin) {
          setAuthError('此頁面僅限管理員使用');
          return;
        }
        setMyEmail(me.email);
        return Promise.all([
          fetchAdminList(token).then(setAdmins),
          fetchAuditLog(token).then(setAuditLog),
        ]);
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : '載入失敗';
        setAuthError(msg);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const refreshAll = async (): Promise<void> => {
    if (!token) return;
    try {
      const [emails, entries] = await Promise.all([
        fetchAdminList(token),
        fetchAuditLog(token),
      ]);
      setAdmins(emails);
      setAuditLog(entries);
    } catch {
      // ignore
    }
  };

  const handleAdd = async (): Promise<void> => {
    if (!token) return;
    const email = newEmail.trim().toLowerCase();
    if (!email) {
      addToast('請輸入 email', 'info');
      return;
    }
    if (!email.includes('@')) {
      addToast('Email 格式不正確', 'error');
      return;
    }
    setWorking(true);
    try {
      const updated = await addAdminApi(token, email);
      setAdmins(updated);
      setNewEmail('');
      addToast(`已新增管理員 ${email}`, 'success');
      await refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '新增失敗';
      addToast(msg, 'error');
    } finally {
      setWorking(false);
    }
  };

  const handleRemove = async (email: string): Promise<void> => {
    if (!token) return;
    if (admins.length <= 1) {
      addToast('無法移除最後一位管理員', 'error');
      return;
    }
    if (email === myEmail) {
      if (!window.confirm(`確定要移除「自己 (${email})」嗎？移除後你將失去管理權限。`)) return;
    } else if (!window.confirm(`確定要移除 ${email} 的管理權限嗎？`)) {
      return;
    }
    setWorking(true);
    try {
      const updated = await removeAdminApi(token, email);
      setAdmins(updated);
      addToast(`已移除 ${email}`, 'success');
      await refreshAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '移除失敗';
      addToast(msg, 'error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('adminClaims')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
              <ShieldAlert size={24} className="text-yellow-400" /> 管理員設定
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">管理管理員白名單與審核軌跡</p>
          </div>
        </div>

        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-yellow-400" />
          </div>
        )}

        {authError && !loading && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
            {authError}
          </div>
        )}

        {!loading && !authError && (
          <>
            {/* Admin list */}
            <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
              <h2 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                <ShieldCheck size={16} className="text-green-400" /> 管理員白名單
                <span className="text-xs text-gray-500 font-normal">({admins.length})</span>
              </h2>
              <div className="space-y-2 mb-3">
                {admins.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">尚無管理員</p>
                ) : (
                  admins.map(email => (
                    <div key={email} className="flex items-center justify-between bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <ShieldCheck size={14} className="text-green-500 flex-shrink-0" />
                        <span className="text-sm text-gray-200 truncate">{email}</span>
                        {email === myEmail && (
                          <span className="text-xs px-1.5 py-0.5 bg-blue-900/40 border border-blue-700/50 text-blue-300 rounded-full flex-shrink-0">你</span>
                        )}
                      </div>
                      <button
                        onClick={() => void handleRemove(email)}
                        disabled={working || admins.length <= 1}
                        className="p-1.5 text-gray-500 hover:text-red-400 disabled:text-gray-700 disabled:cursor-not-allowed transition-colors"
                        title={admins.length <= 1 ? '無法移除最後一位管理員' : '移除'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Add new admin */}
              <div className="flex gap-2 pt-3 border-t border-gray-700">
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleAdd(); }}
                  placeholder="新增管理員 email"
                  className="flex-1 bg-gray-800 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none"
                />
                <button
                  onClick={() => void handleAdd()}
                  disabled={working || !newEmail.trim()}
                  className="bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-bold px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                >
                  {working ? <Loader size={14} className="animate-spin" /> : <UserPlus size={14} />}
                  新增
                </button>
              </div>
            </section>

            {/* Audit log */}
            <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
              <h2 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                <ClipboardList size={16} className="text-cyan-400" /> 操作軌跡
                <span className="text-xs text-gray-500 font-normal">(最新 {auditLog.length})</span>
              </h2>
              {auditLog.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-4">尚無操作記錄</p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {auditLog.map(entry => {
                    const a = actionLabel(entry.action);
                    return (
                      <div key={entry.id} className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
                        <div className="flex items-start gap-2 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full border flex-shrink-0 ${a.className}`}>
                            {a.text}
                          </span>
                          <div className="flex-1 min-w-0 text-xs text-gray-400">
                            <p className="truncate">
                              <span className="text-gray-200">{entry.adminEmail}</span>
                              {entry.targetClaimId && (
                                <> · 申請 <span className="text-gray-500 font-mono">{entry.targetClaimId.slice(0, 8)}</span></>
                              )}
                              {entry.targetRecordIds && entry.targetRecordIds.length > 0 && (
                                <> · {entry.targetRecordIds.length} 場</>
                              )}
                            </p>
                            <p className="text-gray-600 mt-0.5">{formatDateTime(entry.ts)}</p>
                            {entry.details && (
                              <p className="text-gray-500 mt-1 flex items-start gap-1">
                                <FileText size={10} className="mt-0.5 flex-shrink-0" />
                                <span className="truncate">{entry.details}</span>
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
