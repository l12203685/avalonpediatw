/**
 * 篩選重算的呼叫端：預設在 Worker 裡算 (stats.worker.ts)，瀏覽器不支援或 Worker 起不來時改在主執行緒算
 * (同一份 statsCompute.ts)。同一個篩選只算一次 (最近幾個篩選的結果留著，切回來不用重算)。
 */
import type { AbnormalCohortData, CohortCuts, DecisiveCohortData, DecisiveReport, DecisiveScope, DiscoveryResult, TwoRedCohortData, GameFilter, StatsResult, StrengthGrouping, StrengthReport, TwoRedReport } from '@avalon/shared/stats';
import type { FilterVocab } from './statsCompute';
import type { ClaimData } from '../components/idClaim/claimIndex';
import type { StateGamesResult } from '../components/analysis/stateTree/stateTree';

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

type RequestType = 'vocab' | 'compute' | 'strength' | 'discovery' | 'stateTree' | 'claim' | 'twoRed' | 'decisive' | 'twoRedCohort' | 'decisiveCohort' | 'abnormalCohort';

async function onMainThread<T>(type: RequestType, filter?: GameFilter | null, grouping?: StrengthGrouping, name?: string, scope?: DecisiveScope, cuts?: CohortCuts): Promise<T> {
  const mod = await import('./statsCompute');
  try {
    return (type === 'vocab'
      ? await mod.filterVocab(SERVER_URL)
      : type === 'strength'
        ? await mod.computeStrength(SERVER_URL, filter ?? null, grouping ?? { kind: 'tier' })
        : type === 'discovery'
          ? await mod.computeDiscovery(SERVER_URL, filter ?? null, cuts ?? null)
        : type === 'stateTree'
          ? await mod.computeStateGames(SERVER_URL, filter ?? null)
        : type === 'claim'
          ? await mod.computeClaimData(SERVER_URL)
        : type === 'twoRed'
          ? await mod.computeTwoRed(SERVER_URL, filter ?? null, name ?? '')
        : type === 'decisive'
          ? await mod.computeDecisive(SERVER_URL, filter ?? null, scope ?? 'twoRed')
        : type === 'twoRedCohort'
          ? await mod.computeTwoRedCohort(SERVER_URL, filter ?? null)
        : type === 'decisiveCohort'
          ? await mod.computeDecisiveCohort(SERVER_URL, filter ?? null, scope ?? 'twoRed')
        : type === 'abnormalCohort'
          ? await mod.computeAbnormalCohort(SERVER_URL, filter ?? null)
          : await mod.computeFiltered(SERVER_URL, filter as GameFilter)) as T;
  } catch (err) {
    const status = err instanceof mod.GamesUnavailableError ? err.status : 0;
    throw new FilterUnavailableError(status, err instanceof Error ? err.message : String(err));
  }
}

function call<T>(type: RequestType, filter?: GameFilter | null, grouping?: StrengthGrouping, name?: string, scope?: DecisiveScope, cuts?: CohortCuts): Promise<T> {
  const w = getWorker();
  if (!w) return onMainThread<T>(type, filter, grouping, name, scope, cuts);
  const id = nextId;
  nextId += 1;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new FilterUnavailableError(0, 'timeout'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    w.postMessage({ id, type, serverUrl: SERVER_URL, filter: filter ?? undefined, grouping, name, scope, cuts });
  }).catch((err: unknown) => {
    // Worker 壞掉 (不是資料集拿不到) → 主執行緒再試一次
    if (err instanceof FilterUnavailableError && err.message === 'worker failed') return onMainThread<T>(type, filter, grouping, name, scope, cuts);
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

const strengthResults = new Map<string, Promise<StrengthReport>>();

/** 數據分析「陣容強度」：目前篩選（沒有 = 全部局）下依 grouping 分組的報告。失敗不快取。 */
export function strengthReport(filter: GameFilter | null, filterKey: string, grouping: StrengthGrouping): Promise<StrengthReport> {
  const key = `${filterKey}|${JSON.stringify(grouping)}`;
  const hit = strengthResults.get(key);
  if (hit) return hit;
  const p = call<StrengthReport>('strength', filter, grouping);
  strengthResults.set(key, p);
  p.catch(() => {
    if (strengthResults.get(key) === p) strengthResults.delete(key);
  });
  while (strengthResults.size > KEEP_RESULTS) strengthResults.delete(strengthResults.keys().next().value as string);
  return p;
}

const discoveryResults = new Map<string, Promise<DiscoveryResult>>();

/** 自動發現：目前篩選與分組切點下的全部發現（Worker 裡掃描，同一個篩選＋切點只算一次）。失敗不快取。 */
export function discoveryResult(filter: GameFilter | null, filterKey: string, cuts: CohortCuts): Promise<DiscoveryResult> {
  const key = `${filterKey}|${cuts.prHi}-${cuts.prLo}-${cuts.sHi}-${cuts.sLo}`;
  const hit = discoveryResults.get(key);
  if (hit) return hit;
  const p = call<DiscoveryResult>('discovery', filter, undefined, undefined, undefined, cuts);
  discoveryResults.set(key, p);
  p.catch(() => {
    if (discoveryResults.get(key) === p) discoveryResults.delete(key);
  });
  while (discoveryResults.size > KEEP_RESULTS) discoveryResults.delete(discoveryResults.keys().next().value as string);
  return p;
}

const stateTreeResults = new Map<string, Promise<StateGamesResult>>();

/** 數據分析「局勢樹」：目前篩選（沒有 = 全部局）下樹要的局。失敗不快取。 */
export function stateTreeGames(filter: GameFilter | null, filterKey: string): Promise<StateGamesResult> {
  const hit = stateTreeResults.get(filterKey);
  if (hit) return hit;
  const p = call<StateGamesResult>('stateTree', filter);
  stateTreeResults.set(filterKey, p);
  p.catch(() => {
    if (stateTreeResults.get(filterKey) === p) stateTreeResults.delete(filterKey);
  });
  while (stateTreeResults.size > KEEP_RESULTS) stateTreeResults.delete(stateTreeResults.keys().next().value as string);
  return p;
}

const twoRedResults = new Map<string, Promise<TwoRedReport>>();

/** 玩家雷達「兩紅之後的派隊」：目前篩選（沒有 = 全部局）下這位玩家的表＋全體。失敗不快取。 */
export function twoRedReport(filter: GameFilter | null, filterKey: string, name: string): Promise<TwoRedReport> {
  const key = `${filterKey}|${name}`;
  const hit = twoRedResults.get(key);
  if (hit) return hit;
  const p = call<TwoRedReport>('twoRed', filter, undefined, name);
  twoRedResults.set(key, p);
  p.catch(() => {
    if (twoRedResults.get(key) === p) twoRedResults.delete(key);
  });
  while (twoRedResults.size > 12) twoRedResults.delete(twoRedResults.keys().next().value as string);
  return p;
}

const decisiveResults = new Map<string, Promise<DecisiveReport>>();

/** 排行「關鍵外白／內黑」：目前篩選（沒有 = 全部局）下一個範圍的關鍵票報表（每位玩家＋全體）。失敗不快取。 */
export function decisiveReport(filter: GameFilter | null, filterKey: string, scope: DecisiveScope): Promise<DecisiveReport> {
  const key = `${filterKey}|${scope}`;
  const hit = decisiveResults.get(key);
  if (hit) return hit;
  const p = call<DecisiveReport>('decisive', filter, undefined, undefined, scope);
  decisiveResults.set(key, p);
  p.catch(() => {
    if (decisiveResults.get(key) === p) decisiveResults.delete(key);
  });
  while (decisiveResults.size > 8) decisiveResults.delete(decisiveResults.keys().next().value as string);
  return p;
}

const twoRedCohortResults = new Map<string, Promise<TwoRedCohortData>>();

/** 「兩紅之後的派隊」分組：目前篩選（沒有 = 全部局）下的提議（精簡版）＋每位玩家最近的 PR＋分布。失敗不快取。 */
export function twoRedCohort(filter: GameFilter | null, filterKey: string): Promise<TwoRedCohortData> {
  const hit = twoRedCohortResults.get(filterKey);
  if (hit) return hit;
  const p = call<TwoRedCohortData>('twoRedCohort', filter);
  twoRedCohortResults.set(filterKey, p);
  p.catch(() => {
    if (twoRedCohortResults.get(filterKey) === p) twoRedCohortResults.delete(filterKey);
  });
  while (twoRedCohortResults.size > 4) twoRedCohortResults.delete(twoRedCohortResults.keys().next().value as string);
  return p;
}

const decisiveCohortResults = new Map<string, Promise<DecisiveCohortData>>();

/** 「關鍵外白／內黑」分組：目前篩選下一個範圍的關鍵票與全部投票（依局、座位合起來）＋分布。失敗不快取。 */
export function decisiveCohort(filter: GameFilter | null, filterKey: string, scope: DecisiveScope): Promise<DecisiveCohortData> {
  const key = `${filterKey}|${scope}`;
  const hit = decisiveCohortResults.get(key);
  if (hit) return hit;
  const p = call<DecisiveCohortData>('decisiveCohort', filter, undefined, undefined, scope);
  decisiveCohortResults.set(key, p);
  p.catch(() => {
    if (decisiveCohortResults.get(key) === p) decisiveCohortResults.delete(key);
  });
  while (decisiveCohortResults.size > 4) decisiveCohortResults.delete(decisiveCohortResults.keys().next().value as string);
  return p;
}

const abnormalCohortResults = new Map<string, Promise<AbnormalCohortData>>();

/** 「異常票（內黑／外白）」：目前篩選下情境內的藍方票（依局、座位、情境合起來）＋分布。失敗不快取。 */
export function abnormalCohort(filter: GameFilter | null, filterKey: string): Promise<AbnormalCohortData> {
  const hit = abnormalCohortResults.get(filterKey);
  if (hit) return hit;
  const p = call<AbnormalCohortData>('abnormalCohort', filter);
  abnormalCohortResults.set(filterKey, p);
  p.catch(() => {
    if (abnormalCohortResults.get(filterKey) === p) abnormalCohortResults.delete(filterKey);
  });
  while (abnormalCohortResults.size > 4) abnormalCohortResults.delete(abnormalCohortResults.keys().next().value as string);
  return p;
}

let claimData: Promise<ClaimData> | null = null;

/** ID 認領頁：全部局的座位名單（同一份 /api/analysis/games，Worker 裡已載入就不再下載）。失敗不快取。 */
export function loadClaimData(): Promise<ClaimData> {
  if (!claimData) {
    claimData = call<ClaimData>('claim');
    claimData.catch(() => {
      claimData = null;
    });
  }
  return claimData;
}

/** 測試／重試用：清掉 Worker 錯誤狀態以外的快取。 */
export function resetFilteredStats(): void {
  results.clear();
  strengthResults.clear();
  discoveryResults.clear();
  stateTreeResults.clear();
  twoRedResults.clear();
  decisiveResults.clear();
  twoRedCohortResults.clear();
  decisiveCohortResults.clear();
  abnormalCohortResults.clear();
  vocab = null;
  claimData = null;
  failAll(new FilterUnavailableError(0, 'reset'));
}
