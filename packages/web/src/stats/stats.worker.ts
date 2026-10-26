/**
 * 篩選重算的 Worker：全部區塊重算約 0.3 秒 (Node 實測；手機更久)，放在背景不卡畫面。
 * 訊息：{ id, type: 'vocab' | 'compute', serverUrl, filter? } → { id, ok, value } / { id, ok: false, status, error }。
 */
import { computeFiltered, filterVocab, GamesUnavailableError } from './statsCompute';
import type { GameFilter } from '@avalon/shared/stats';

interface StatsRequest {
  id: number;
  type: 'vocab' | 'compute';
  serverUrl: string;
  filter?: GameFilter;
}

/** Worker 的全域 (web 的 tsconfig 只有 DOM lib；不引 webworker lib，避免兩套全域型別衝突)。 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<StatsRequest>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = async (event: MessageEvent<StatsRequest>): Promise<void> => {
  const { id, type, serverUrl, filter } = event.data;
  try {
    const value = type === 'vocab'
      ? await filterVocab(serverUrl)
      : await computeFiltered(serverUrl, filter as GameFilter);
    ctx.postMessage({ id, ok: true, value });
  } catch (err) {
    const status = err instanceof GamesUnavailableError ? err.status : 0;
    ctx.postMessage({ id, ok: false, status, error: err instanceof Error ? err.message : String(err) });
  }
};
