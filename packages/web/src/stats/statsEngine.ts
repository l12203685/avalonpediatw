/**
 * 篩選重算的呼叫端：預設在 Worker 裡算 (stats.worker.ts)，瀏覽器不支援或 Worker 起不來時改在主執行緒算
 * (同一份 statsCompute.ts)。同一個篩選只算一次 (最近幾個篩選的結果留著，切回來不用重算)。
 */
import type { GameFilter, StatsResult } from '@avalon/shared/stats';
import type { FilterVocab } from './statsCompute';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const TIMEOUT_MS = 60_000;
const KEEP_RESULTS = 6;

/** 資料集拿不到 (503：還沒產生、兩檔不同批、一致性檢查失敗) 或算不出來。 */
export class FilterUnavailableError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FilterUnavailableError';
    this.status = status;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: unknown): void {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
    pending.delete(id);
  }
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === 'undefined'
      ? null
      : new Worker(new URL('./stats.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown; status?: number; error?: string }>): void => {
      const { id, ok, value, status, error } = event.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (ok) p.resolve(value);
      else p.reject(new FilterUnavailableError(status ?? 0, error ?? 'unknown error'));
    };
    worker.onerror = (): void => {
      // Worker 本身壞了 (載入失敗等)：之後改在主執行緒算，等著的請求在 call() 裡重送。
      worker?.terminate();
      worker = null;
      failAll(new FilterUnavailableError(0, 'worker failed'));
    };
  }
  return worker;
}

async function onMainThread<T>(type: 'vocab' | 'compute', filter?: GameFilter): Promise<T> {
  const mod = await import('./statsCompute');
  try {
    return (type === 'vocab'
      ? await mod.filterVocab(SERVER_URL)
      : await mod.computeFiltered(SERVER_URL, filter as GameFilter)) as T;
  } catch (err) {
    const status = err instanceof mod.GamesUnavailableError ? err.status : 0;
    throw new FilterUnavailableError(status, err instanceof Error ? err.message : String(err));
  }
}

function call<T>(type: 'vocab' | 'compute', filter?: GameFilter): Promise<T> {
  const w = getWorker();
  if (!w) return onMainThread<T>(type, filter);
  const id = nextId;
  nextId += 1;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new FilterUnavailableError(0, 'timeout'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    w.postMessage({ id, type, serverUrl: SERVER_URL, filter });
  }).catch((err: unknown) => {
    // Worker 壞掉 (不是資料集拿不到) → 主執行緒再試一次
    if (err instanceof FilterUnavailableError && err.message === 'worker failed') return onMainThread<T>(type, filter);
    throw err;
  });
}

let vocab: Promise<FilterVocab> | null = null;

/** 篩選面板的選項 (玩家名單、賽季、地點…)。失敗不快取。 */
export function loadFilterVocab(): Promise<FilterVocab> {
  if (!vocab) {
    vocab = call<FilterVocab>('vocab');
    vocab.catch(() => {
      vocab = null;
    });
  }
  return vocab;
}

const results = new Map<string, Promise<StatsResult>>();

/** 篩選後的全部區塊 (key = canonicalFilterKey(filter))。失敗不快取。 */
export function filteredStats(filter: GameFilter, key: string): Promise<StatsResult> {
  const hit = results.get(key);
  if (hit) {
    results.delete(key);
    results.set(key, hit);
    return hit;
  }
  const p = call<StatsResult>('compute', filter);
  results.set(key, p);
  p.catch(() => {
    if (results.get(key) === p) results.delete(key);
  });
  while (results.size > KEEP_RESULTS) results.delete(results.keys().next().value as string);
  return p;
}

/** 測試／重試用：清掉 Worker 錯誤狀態以外的快取。 */
export function resetFilteredStats(): void {
  results.clear();
  vocab = null;
  failAll(new FilterUnavailableError(0, 'reset'));
}
