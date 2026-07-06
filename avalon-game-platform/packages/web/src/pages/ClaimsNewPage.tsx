import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Loader, Sparkles, Search, Send, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchAutoMatchCandidates,
  searchManualRecords,
  submitClaim,
  fetchMyClaims,
  ClaimableRecord,
  ClaimRequestApi,
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

function roleLabel(role: string | null): string {
  if (!role) return '未知';
  return ROLE_LABELS[role] ?? role;
}

function statusPill(status: ClaimRequestApi['status']): { label: string; className: string; Icon: typeof Clock } {
  if (status === 'approved') return { label: '已核准', className: 'bg-blue-900/60 text-blue-300 border-blue-600/50', Icon: CheckCircle2 };
  if (status === 'rejected') return { label: '已否決', className: 'bg-red-900/60 text-red-300 border-red-600/50', Icon: XCircle };
  return { label: '審核中', className: 'bg-yellow-900/60 text-yellow-300 border-yellow-600/50', Icon: Clock };
}

interface RecordRowProps {
  record: ClaimableRecord;
  checked: boolean;
  onToggle: () => void;
}

function RecordRow({ record, checked, onToggle }: RecordRowProps): JSX.Element {
  const teamColor = record.team === 'evil'
    ? 'text-red-300'
    : record.team === 'good'
      ? 'text-blue-300'
      : 'text-gray-400';
  const wonLabel = record.won ? '勝' : '敗';
  const wonColor = record.won ? 'bg-blue-900/60 text-blue-300' : 'bg-red-900/60 text-red-300';
  return (
    <label className={`flex items-center gap-3 py-2 px-3 border-b border-gray-700/50 last:border-0 cursor-pointer hover:bg-avalon-card/80 transition-colors ${
      checked ? 'bg-blue-900/20' : ''
    }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="w-4 h-4 accent-blue-500 flex-shrink-0"
      />
      <div className={`w-10 text-center text-xs font-bold py-0.5 rounded ${wonColor}`}>{wonLabel}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${teamColor} truncate`}>{roleLabel(record.role)}</span>
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

export default function ClaimsNewPage(): JSX.Element {
  const { setGameState, addToast, currentPlayer } = useGameStore();

  const [autoRecords, setAutoRecords] = useState<ClaimableRecord[]>([]);
  const [autoLoading, setAutoLoading] = useState(true);

  const [manualQuery, setManualQuery] = useState('');
  const [manualRecords, setManualRecords] = useState<ClaimableRecord[]>([]);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualSince, setManualSince] = useState('');
  const [manualUntil, setManualUntil] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [evidenceNote, setEvidenceNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [myClaims, setMyClaims] = useState<ClaimRequestApi[]>([]);
  const [myClaimsLoading, setMyClaimsLoading] = useState(true);

  const token = getStoredToken();

  // Build a unified map of records seen so we can display selection regardless
  // of which section (auto / manual) the record came from.
  const recordPool = useMemo(() => {
    const map = new Map<string, ClaimableRecord>();
    for (const r of autoRecords) map.set(r.recordId, r);
    for (const r of manualRecords) map.set(r.recordId, r);
    return map;
  }, [autoRecords, manualRecords]);

  useEffect(() => {
    if (!token) {
      setAutoLoading(false);
      setMyClaimsLoading(false);
      return;
    }
    fetchAutoMatchCandidates(token)
      .then(records => setAutoRecords(records))
      .catch(() => setAutoRecords([]))
      .finally(() => setAutoLoading(false));

    fetchMyClaims(token)
      .then(setMyClaims)
      .catch(() => setMyClaims([]))
      .finally(() => setMyClaimsLoading(false));
  }, [token]);

  const refreshMyClaims = async (): Promise<void> => {
    if (!token) return;
    try {
      const data = await fetchMyClaims(token);
      setMyClaims(data);
    } catch {
      // ignore
    }
  };

  const handleManualSearch = async (): Promise<void> => {
    if (!token) return;
    const q = manualQuery.trim();
    if (!q) {
      addToast('請輸入舊暱稱', 'info');
      return;
    }
    setManualLoading(true);
    try {
      const since = manualSince ? new Date(manualSince).getTime() : undefined;
      const until = manualUntil ? new Date(manualUntil).getTime() + 86_399_000 : undefined;
      const records = await searchManualRecords(token, { oldNickname: q, since, until });
      setManualRecords(records);
      if (records.length === 0) {
        addToast('找不到匹配的戰績', 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '搜尋失敗';
      addToast(msg, 'error');
    } finally {
      setManualLoading(false);
    }
  };

  const toggle = (id: string): void => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllAuto = (): void => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allSelected = autoRecords.every(r => next.has(r.recordId));
      if (allSelected) {
        for (const r of autoRecords) next.delete(r.recordId);
      } else {
        for (const r of autoRecords) next.add(r.recordId);
      }
      return next;
    });
  };

  const selectedRecords = useMemo(() => {
    return Array.from(selectedIds)
      .map(id => recordPool.get(id))
      .filter((r): r is ClaimableRecord => r !== undefined);
  }, [selectedIds, recordPool]);

  const handleSubmit = async (): Promise<void> => {
    if (!token) {
      addToast('請先登入', 'error');
      return;
    }
    if (selectedIds.size === 0) {
      addToast('請至少勾選一場戰績', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const autoIds = new Set(autoRecords.map(r => r.recordId));
      const allAuto = Array.from(selectedIds).every(id => autoIds.has(id));
      await submitClaim(token, {
        targetRecordIds: Array.from(selectedIds),
        evidenceNote,
        autoMatched: allAuto,
      });
      addToast('申請已送出，等待審核', 'success');
      setSelectedIds(new Set());
      setEvidenceNote('');
      await refreshMyClaims();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '送出失敗';
      addToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const autoAllSelected = autoRecords.length > 0 && autoRecords.every(r => selectedIds.has(r.recordId));

  return (
    <div className="min-h-screen p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('profile')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-white">申請綁定舊戰績</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              把歷史遊戲記錄認領到你的帳號 {currentPlayer?.name ? `(${currentPlayer.name})` : ''}
            </p>
          </div>
        </div>

        {/* Status card — my recent claims */}
        <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
          <h2 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
            <Clock size={16} /> 我的申請狀態
          </h2>
          {myClaimsLoading ? (
            <div className="flex justify-center py-4"><Loader size={20} className="animate-spin text-blue-400" /></div>
          ) : myClaims.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-2">尚無申請記錄</p>
          ) : (
            <div className="space-y-2">
              {myClaims.slice(0, 10).map(claim => {
                const pill = statusPill(claim.status);
                const Icon = pill.Icon;
                return (
                  <div key={claim.id} className="flex items-start gap-3 p-3 bg-gray-800/40 border border-gray-700 rounded-lg">
                    <div className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 ${pill.className} flex-shrink-0`}>
                      <Icon size={12} />
                      {pill.label}
                    </div>
                    <div className="flex-1 min-w-0 text-xs text-gray-400">
                      <p>
                        送出於 {formatDate(claim.submittedAt)} · 申請 {claim.targetRecordIds.length} 場
                        {claim.status === 'approved' && claim.approvedRecordIds && (
                          <> · 核准 <span className="text-blue-400 font-semibold">{claim.approvedRecordIds.length}</span> 場</>
                        )}
                      </p>
                      {claim.status === 'rejected' && claim.rejectReason && (
                        <p className="text-red-300 mt-1">否決理由：{claim.rejectReason}</p>
                      )}
                      {claim.evidenceNote && (
                        <p className="text-gray-500 mt-1 truncate">備註：{claim.evidenceNote}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Auto-match */}
        <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-gray-300 flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" /> 系統自動比對
            </h2>
            {autoRecords.length > 0 && (
              <button
                onClick={toggleAllAuto}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                {autoAllSelected ? '取消全選' : '全選'}
              </button>
            )}
          </div>
          {autoLoading ? (
            <div className="flex justify-center py-8"><Loader size={24} className="animate-spin text-blue-400" /></div>
          ) : autoRecords.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              系統未找到像是你的舊戰績 — 你可以用下方手動搜尋。
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">系統根據你的暱稱比對，找到 {autoRecords.length} 場可能是你的戰績：</p>
              <div className="bg-gray-900/30 rounded-lg max-h-96 overflow-y-auto">
                {autoRecords.map(r => (
                  <RecordRow
                    key={r.recordId}
                    record={r}
                    checked={selectedIds.has(r.recordId)}
                    onToggle={() => toggle(r.recordId)}
                  />
                ))}
              </div>
            </>
          )}
        </section>

        {/* Manual search */}
        <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
          <h2 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
            <Search size={16} className="text-blue-400" /> 手動搜尋（輸入舊暱稱）
          </h2>
          <div className="space-y-2">
            <input
              type="text"
              value={manualQuery}
              onChange={e => setManualQuery(e.target.value)}
              placeholder="舊暱稱 / 遊戲內名稱"
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none"
              onKeyDown={e => { if (e.key === 'Enter') void handleManualSearch(); }}
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">起始日期（選填）</label>
                <input
                  type="date"
                  value={manualSince}
                  onChange={e => setManualSince(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">結束日期（選填）</label>
                <input
                  type="date"
                  value={manualUntil}
                  onChange={e => setManualUntil(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white outline-none"
                />
              </div>
            </div>
            <button
              onClick={() => void handleManualSearch()}
              disabled={manualLoading}
              className="w-full bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {manualLoading ? <Loader size={16} className="animate-spin" /> : <Search size={16} />}
              搜尋
            </button>
          </div>
          {manualRecords.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-gray-500 mb-2">找到 {manualRecords.length} 場相似戰績：</p>
              <div className="bg-gray-900/30 rounded-lg max-h-96 overflow-y-auto">
                {manualRecords.map(r => (
                  <RecordRow
                    key={r.recordId}
                    record={r}
                    checked={selectedIds.has(r.recordId)}
                    onToggle={() => toggle(r.recordId)}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Evidence note + submit */}
        {selectedIds.size > 0 && (
          <section className="bg-avalon-card/60 border border-blue-700/60 rounded-xl p-4 space-y-3 sticky bottom-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">
                已選 <span className="text-blue-400">{selectedIds.size}</span> 場
              </h2>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-gray-400 hover:text-white"
              >
                清空選擇
              </button>
            </div>
            <div className="text-xs text-gray-400 max-h-24 overflow-y-auto space-y-0.5">
              {selectedRecords.slice(0, 5).map(r => (
                <p key={r.recordId} className="truncate">
                  • {formatDate(r.createdAt)} {roleLabel(r.role)} {r.won ? '勝' : '敗'}（{r.displayName}）
                </p>
              ))}
              {selectedRecords.length > 5 && <p>… 另外 {selectedRecords.length - 5} 場</p>}
            </div>
            <textarea
              value={evidenceNote}
              onChange={e => setEvidenceNote(e.target.value)}
              placeholder="備註：留言給管理員（例如「我就是XXX當年的號，5/12 那場跟阿X一起玩」— 幫助審核更快通過）"
              className="w-full bg-gray-800 border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none resize-none"
              rows={3}
              maxLength={2000}
            />
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-bold py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {submitting ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
              送出申請
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
