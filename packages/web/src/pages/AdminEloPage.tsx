import { useState, useEffect } from 'react';
import { ArrowLeft, Loader, Activity, Zap, AlertTriangle } from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import {
  fetchAdminMe,
  fetchEloConfig,
  updateEloConfig,
  EloConfigView,
  EloAttributionMode,
} from '../services/api';
import { getStoredToken } from '../services/socket';

/**
 * AdminEloPage — #54 Phase 2 Day 3
 *
 * Admin-only surface for toggling ELO attribution mode and viewing the
 * currently active configuration. Factor weight tuning is deferred to
 * Phase 2.5; this page only exposes the legacy / per_event switch plus
 * a read-only weights summary.
 */
export default function AdminEloPage(): JSX.Element {
  const { setGameState, addToast } = useGameStore();

  const [config, setConfig] = useState<EloConfigView | null>(null);
  const [supabaseReady, setSupabaseReady] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

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
        return fetchEloConfig(token).then(result => {
          setConfig(result.config);
          setSupabaseReady(result.supabaseReady);
        });
      })
      .catch(err => {
        const msg = err instanceof Error ? err.message : '載入失敗';
        setAuthError(msg);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const handleModeChange = async (nextMode: EloAttributionMode): Promise<void> => {
    if (!token || !config) return;
    if (nextMode === config.attributionMode) return;
    setWorking(true);
    setWarning(null);
    try {
      const result = await updateEloConfig(token, { attributionMode: nextMode });
      setConfig(result.config);
      setSupabaseReady(result.supabaseReady);
      if (result.warning) {
        setWarning(result.warning);
        addToast('已切換（僅內存生效）', 'info');
      } else {
        addToast(`已切換為 ${nextMode === 'per_event' ? 'Per-event' : 'Legacy'} 模式`, 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '切換失敗';
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
            aria-label="返回"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
              <Activity size={24} className="text-cyan-400" /> ELO 設定
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              切換 ELO 歸因模式 (#54 Phase 2) — 變更會即時熱 reload
            </p>
          </div>
        </div>

        {loading && (
          <div className="flex justify-center pt-10">
            <Loader size={32} className="animate-spin text-cyan-400" />
          </div>
        )}

        {authError && !loading && (
          <div className="bg-red-900/50 border border-red-600 rounded-xl p-4 text-red-200 text-sm text-center">
            {authError}
          </div>
        )}

        {!loading && !authError && config && (
          <>
            {/* Supabase status banner */}
            {!supabaseReady && (
              <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3 text-yellow-200 text-xs flex items-start gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <div>
                  Supabase 未設定 — 切換只作用在當前進程內存，重啟後會還原為 legacy。
                </div>
              </div>
            )}

            {warning && (
              <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3 text-yellow-200 text-xs flex items-start gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <div>{warning}</div>
              </div>
            )}

            {/* Attribution mode toggle */}
            <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
              <h2 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2">
                <Zap size={16} className="text-amber-400" /> 歸因模式
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void handleModeChange('legacy')}
                  className={
                    'px-4 py-3 rounded-lg border text-sm font-semibold transition-all ' +
                    (config.attributionMode === 'legacy'
                      ? 'bg-blue-900/60 border-blue-500 text-blue-100 shadow-[0_0_0_2px_rgba(59,130,246,0.3)]'
                      : 'bg-gray-800/50 border-gray-700 text-gray-300 hover:bg-gray-800')
                  }
                >
                  <div>Legacy</div>
                  <div className="text-xs font-normal text-gray-400 mt-0.5">
                    Phase 1 陣營 / 結局 / 角色乘數
                  </div>
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void handleModeChange('per_event')}
                  className={
                    'px-4 py-3 rounded-lg border text-sm font-semibold transition-all ' +
                    (config.attributionMode === 'per_event'
                      ? 'bg-amber-900/60 border-amber-500 text-amber-100 shadow-[0_0_0_2px_rgba(245,158,11,0.3)]'
                      : 'bg-gray-800/50 border-gray-700 text-gray-300 hover:bg-gray-800')
                  }
                >
                  <div>Per-event</div>
                  <div className="text-xs font-normal text-gray-400 mt-0.5">
                    疊加 Proposal + 外白內黑
                  </div>
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                當前模式：
                <span className="text-white font-semibold ml-1">
                  {config.attributionMode === 'per_event' ? 'Per-event' : 'Legacy'}
                </span>
                {config.attributionMode === 'per_event' && (
                  <span className="ml-2 text-amber-400">（新開的對局會使用細粒度歸因）</span>
                )}
              </p>
            </section>

            {/* Weights (read-only) */}
            <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
              <h2 className="text-sm font-bold text-gray-300 mb-3">歸因權重（唯讀）</h2>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between py-1 border-b border-gray-700/50">
                  <span className="text-gray-400">Proposal</span>
                  <span className="text-gray-200 font-mono">
                    {config.attributionWeights.proposal.toFixed(1)}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-700/50">
                  <span className="text-gray-400">外白內黑</span>
                  <span className="text-gray-200 font-mono">
                    {config.attributionWeights.outerWhiteInnerBlack.toFixed(1)}
                  </span>
                </div>
                {typeof config.attributionWeights.information === 'number' && (
                  <div className="flex justify-between py-1 border-b border-gray-700/50">
                    <span className="text-gray-400">資訊利用率</span>
                    <span className="text-gray-200 font-mono">
                      {config.attributionWeights.information.toFixed(1)}
                    </span>
                  </div>
                )}
                {typeof config.attributionWeights.misdirection === 'number' && (
                  <div className="flex justify-between py-1 border-b border-gray-700/50">
                    <span className="text-gray-400">欺敵成本</span>
                    <span className="text-gray-200 font-mono">
                      {config.attributionWeights.misdirection.toFixed(1)}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-3">
                權重細調預計在 Phase 2.5 透過 backtest 調整後上線。
              </p>
            </section>

            {/* Phase 1 config (read-only summary) */}
            <section className="bg-avalon-card/40 border border-gray-700 rounded-xl p-4">
              <h2 className="text-sm font-bold text-gray-300 mb-3">基礎設定（唯讀）</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-800/40 rounded p-2">
                  <div className="text-xs text-gray-500">起始 ELO</div>
                  <div className="text-gray-100 font-mono">{config.startingElo}</div>
                </div>
                <div className="bg-gray-800/40 rounded p-2">
                  <div className="text-xs text-gray-500">最低 ELO</div>
                  <div className="text-gray-100 font-mono">{config.minElo}</div>
                </div>
                <div className="bg-gray-800/40 rounded p-2">
                  <div className="text-xs text-gray-500">Base K</div>
                  <div className="text-gray-100 font-mono">{config.baseKFactor}</div>
                </div>
                <div className="bg-gray-800/40 rounded p-2">
                  <div className="text-xs text-gray-500">刺殺倍率</div>
                  <div className="text-gray-100 font-mono">
                    {config.outcomeWeights.assassin_kills_merlin.toFixed(1)}
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
