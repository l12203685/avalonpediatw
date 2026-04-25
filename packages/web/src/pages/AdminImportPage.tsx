import { useState } from 'react';
import {
  ArrowLeft,
  Upload,
  FileJson,
  Table2,
  Loader,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useGameStore } from '../store/gameStore';
import { getStoredToken } from '../services/socket';
import {
  importGamesFromJson,
  importGamesFromSheets,
  GameImportResult,
} from '../services/api';

type Source = 'sheets' | 'json';
type Phase = 'idle' | 'loading' | 'preview' | 'committing' | 'done' | 'error';

const DEFAULT_SHEET_ID = '174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU';

/**
 * #49 history import admin UI (hineko_20260424_1035_admin_import_button).
 *
 * Two-step flow:
 *   1. User picks source + file/sheetId, hits "Dry Run 預覽" → we call
 *      the endpoint with dryRun=true and render preview + counts.
 *   2. User hits "確認寫入" → same endpoint with dryRun=false; preview
 *      switches to the post-commit result.
 *
 * Sheets source is currently a 501 on the backend (CLI-only). We still
 * render the radio so admins know it's a planned path, but it's disabled
 * with a hint pointing at scripts/import-games.ts.
 */
export default function AdminImportPage(): JSX.Element {
  const { setGameState, addToast } = useGameStore();

  const [source, setSource] = useState<Source>('json');
  const [sheetId, setSheetId] = useState<string>(DEFAULT_SHEET_ID);
  const [jsonFile, setJsonFile] = useState<File | null>(null);
  const [jsonFileName, setJsonFileName] = useState<string>('');
  const [limitText, setLimitText] = useState<string>('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [dryResult, setDryResult] = useState<GameImportResult | null>(null);
  const [finalResult, setFinalResult] = useState<GameImportResult | null>(null);
  const [errMessage, setErrMessage] = useState<string>('');

  const [showErrors, setShowErrors] = useState<boolean>(false);
  const [showPreview, setShowPreview] = useState<boolean>(true);

  const parsedLimit = (() => {
    const n = parseInt(limitText, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();

  async function readJsonFile(file: File): Promise<unknown[]> {
    const text = await file.text();
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('JSON 檔案必須是 array of records（最外層 []）');
    }
    return parsed;
  }

  async function runImport(dryRun: boolean): Promise<void> {
    const token = getStoredToken();
    if (!token) {
      setPhase('error');
      setErrMessage('尚未登入，請先回首頁登入 admin 帳號');
      return;
    }

    setPhase(dryRun ? 'loading' : 'committing');
    setErrMessage('');

    try {
      let result: GameImportResult;
      if (source === 'sheets') {
        result = await importGamesFromSheets(token, {
          dryRun,
          limit: parsedLimit,
          sheetId: sheetId || undefined,
        });
      } else {
        if (!jsonFile) {
          throw new Error('請先選 JSON 檔案');
        }
        const jsonData = await readJsonFile(jsonFile);
        result = await importGamesFromJson(token, {
          dryRun,
          limit: parsedLimit,
          jsonData,
        });
      }

      if (dryRun) {
        setDryResult(result);
        setFinalResult(null);
        setPhase('preview');
      } else {
        setFinalResult(result);
        setPhase('done');
        addToast(`匯入完成：寫入 ${result.writtenCount} 筆`, 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知錯誤';
      setErrMessage(msg);
      setPhase('error');
    }
  }

  function resetAll(): void {
    setPhase('idle');
    setDryResult(null);
    setFinalResult(null);
    setErrMessage('');
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0] ?? null;
    setJsonFile(f);
    setJsonFileName(f?.name ?? '');
    setDryResult(null);
    setFinalResult(null);
    setPhase('idle');
  }

  const busy = phase === 'loading' || phase === 'committing';
  const dryDisabled = busy || (source === 'json' && !jsonFile);
  const showResult = dryResult ?? finalResult;
  const committed: boolean = phase === 'done' && finalResult !== null;

  return (
    <div className="min-h-screen bg-avalon-dark text-white px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setGameState('adminClaims')}
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-avalon-card/50 transition-all"
            title="返回"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="flex-1">
            <h1 className="text-2xl font-black text-white flex items-center gap-2">
              <ShieldCheck size={24} className="text-amber-400" />
              戰績匯入管理
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              從 Google Sheet 或 JSON 檔批次匯入歷史戰績
            </p>
          </div>
        </div>

        {/* Source picker */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          <h2 className="text-sm font-bold text-white">來源選擇</h2>
          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700 cursor-not-allowed opacity-60">
              <input
                type="radio"
                name="source"
                value="sheets"
                checked={source === 'sheets'}
                onChange={() => setSource('sheets')}
                className="mt-0.5 accent-amber-500"
                disabled
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Table2 size={16} className="text-blue-300" />
                  <span className="text-sm font-semibold">從預設 Google Sheet</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/50 text-amber-300">
                    Phase 2
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  目前尚未串接 HTTP 路徑（缺 googleapis 後端 dep）。如需立即匯入，
                  請開發者執行 <code className="bg-black/40 px-1 rounded">scripts/import-games.ts</code> CLI。
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700 cursor-pointer hover:border-amber-600/40">
              <input
                type="radio"
                name="source"
                value="json"
                checked={source === 'json'}
                onChange={() => setSource('json')}
                className="mt-0.5 accent-amber-500"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <FileJson size={16} className="text-amber-300" />
                  <span className="text-sm font-semibold">上傳 JSON 檔案</span>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  ProAvalon legacy JSON 格式（array of records）。每筆含
                  <code className="bg-black/40 px-1 rounded">_id</code> /
                  <code className="bg-black/40 px-1 rounded">winningTeam</code> /
                  <code className="bg-black/40 px-1 rounded">playerUsernamesOrdered</code> 等欄位。
                </p>
              </div>
            </label>
          </div>
        </section>

        {/* Source-specific inputs */}
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
          {source === 'json' && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-300">JSON 檔案</label>
              <input
                type="file"
                accept=".json,application/json"
                onChange={onFileChange}
                className="block w-full text-xs text-gray-300 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:bg-amber-700 file:text-white hover:file:bg-amber-600 file:cursor-pointer"
              />
              {jsonFileName && (
                <p className="text-[11px] text-gray-500">
                  選中：<span className="text-gray-300">{jsonFileName}</span>
                </p>
              )}
            </div>
          )}
          {source === 'sheets' && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-300">
                Sheet ID（留空使用預設）
              </label>
              <input
                type="text"
                value={sheetId}
                onChange={(e) => setSheetId(e.target.value)}
                placeholder={DEFAULT_SHEET_ID}
                disabled
                className="w-full bg-black/40 border border-zinc-700 rounded px-3 py-2 text-xs text-gray-400 disabled:opacity-50"
              />
            </div>
          )}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-gray-300">上限筆數（選填）</label>
            <input
              type="number"
              value={limitText}
              onChange={(e) => setLimitText(e.target.value)}
              placeholder="留空 = 全部"
              min="1"
              className="w-32 bg-black/40 border border-zinc-700 rounded px-3 py-2 text-xs text-gray-200"
            />
            <p className="text-[10px] text-gray-500">
              先用小數字（例：10）跑 dry run 驗證再解除上限。
            </p>
          </div>
        </section>

        {/* Action buttons */}
        <section className="flex gap-3">
          <button
            onClick={() => { void runImport(true); }}
            disabled={dryDisabled}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
          >
            {phase === 'loading' ? (
              <Loader size={16} className="animate-spin" />
            ) : (
              <Upload size={16} />
            )}
            Dry Run 預覽
          </button>
          <button
            onClick={() => { void runImport(false); }}
            disabled={busy || !dryResult || committed}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors"
            title={!dryResult ? '請先跑 Dry Run 預覽' : undefined}
          >
            {phase === 'committing' ? (
              <Loader size={16} className="animate-spin" />
            ) : (
              <CheckCircle2 size={16} />
            )}
            {committed ? '已寫入' : '確認寫入'}
          </button>
        </section>

        {/* Error banner */}
        {phase === 'error' && errMessage && (
          <section className="bg-red-900/40 border border-red-700 rounded-xl p-4 text-sm text-red-200">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle size={16} /> 發生錯誤
            </div>
            <p className="mt-1 text-xs leading-relaxed">{errMessage}</p>
            <button
              onClick={resetAll}
              className="mt-2 text-xs underline text-red-300 hover:text-red-100"
            >
              關閉
            </button>
          </section>
        )}

        {/* Result panel */}
        {showResult && (
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className={committed ? 'text-emerald-400' : 'text-blue-400'} />
              <h2 className="text-sm font-bold text-white">
                {committed ? '寫入結果' : 'Dry Run 預覽'}
              </h2>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 border border-zinc-700 text-gray-300">
                來源：{showResult.sourceTag === 'json' ? 'JSON 檔案' : 'Google Sheet'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat label="總筆數" value={showResult.totalCount} />
              <Stat
                label={committed ? '已寫入' : '預計寫入'}
                value={showResult.writtenCount}
                tone={committed ? 'success' : 'primary'}
              />
              <Stat label="已存在跳過" value={showResult.skippedExisting} tone="muted" />
            </div>
            {showResult.errors.length > 0 && (
              <div>
                <button
                  onClick={() => setShowErrors(v => !v)}
                  className="flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200"
                >
                  {showErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {showResult.errors.length} 筆格式錯誤已跳過
                </button>
                {showErrors && (
                  <ul className="mt-2 space-y-1 text-[11px] text-amber-200 max-h-48 overflow-y-auto bg-black/30 rounded p-2">
                    {showResult.errors.slice(0, 50).map((e) => (
                      <li key={e.row}>
                        row {e.row}: {e.reason}
                      </li>
                    ))}
                    {showResult.errors.length > 50 && (
                      <li className="text-gray-500">…另 {showResult.errors.length - 50} 筆省略</li>
                    )}
                  </ul>
                )}
              </div>
            )}
            {showResult.preview.length > 0 && (
              <div>
                <button
                  onClick={() => setShowPreview(v => !v)}
                  className="flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200"
                >
                  {showPreview ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  預覽前 {showResult.preview.length} 筆
                </button>
                {showPreview && (
                  <div className="mt-2 space-y-1.5 text-[11px] bg-black/30 rounded p-2 max-h-64 overflow-y-auto">
                    {showResult.preview.map((p) => (
                      <div
                        key={p.gameId}
                        className="flex items-center gap-2 border-b border-zinc-800 last:border-0 pb-1 last:pb-0"
                      >
                        <span className="font-mono text-gray-500 text-[10px]">{p.gameId.slice(-8)}</span>
                        <span className="text-gray-300">{p.playerCount}人</span>
                        <span
                          className={
                            p.winner === 'good'
                              ? 'text-blue-300'
                              : 'text-red-300'
                          }
                        >
                          {p.winner === 'good' ? '好人勝' : '壞人勝'}
                        </span>
                        <span className="text-gray-500 truncate flex-1">{p.winReason}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {committed && (
              <button
                onClick={resetAll}
                className="mt-2 text-xs underline text-gray-400 hover:text-white"
              >
                再匯入一批
              </button>
            )}
          </section>
        )}

        {/* Help footer */}
        <section className="text-[11px] text-gray-500 space-y-1 pt-4 border-t border-zinc-800">
          <p>寫入目標：Firestore <code className="bg-black/40 px-1 rounded">games/{'{gameId}'}</code>（V1 legacy schema）</p>
          <p>重複 gameId 會被跳過（不覆寫已有記錄）。</p>
          <p>Admin 權限透過 <code className="bg-black/40 px-1 rounded">requireAdminAuth</code> 檢查，白名單 email 才能呼叫此 endpoint。</p>
          <p className="pt-2">
            <span className="text-amber-300 font-semibold">V2 戰績（games_v2）：</span>
            現場對局已於 Phase 2c 起自動雙寫；歷史 Sheets 匯入走 CLI
            <code className="bg-black/40 px-1 rounded mx-1">scripts/import-games-v2.ts</code>；
            V1→V2 遷移走 CLI <code className="bg-black/40 px-1 rounded mx-1">scripts/migrate-v1-to-v2.ts</code>。
          </p>
        </section>
      </div>
    </div>
  );
}

interface StatProps {
  label: string;
  value: number;
  tone?: 'muted' | 'success' | 'primary';
}

function Stat({ label, value, tone = 'primary' }: StatProps): JSX.Element {
  const colour =
    tone === 'success' ? 'text-emerald-300 border-emerald-700/40'
    : tone === 'muted' ? 'text-gray-400 border-zinc-700'
    : 'text-blue-300 border-blue-700/40';
  return (
    <div className={`rounded bg-black/40 border ${colour} p-2`}>
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="text-base font-bold">{value}</div>
    </div>
  );
}
