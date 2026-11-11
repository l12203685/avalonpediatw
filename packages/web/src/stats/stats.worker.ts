/**
 * 篩選重算的 Worker：全部區塊重算約 0.3 秒 (Node 實測；手機更久)，放在背景不卡畫面。
 * 訊息：{ id, type: 'vocab' | 'compute', serverUrl, filter? } → { id, ok, value } / { id, ok: false, status, error }。
 */
import { computeClaimData, computeDecisive, computeDecisiveCohort, computeDiscovery, computeFiltered, computeStateGames, computeStrength, computeTwoRed, computeTwoRedCohort, filterVocab, GamesUnavailableError } from './statsCompute';
import type { DecisiveScope, GameFilter, StrengthGrouping } from '@avalon/shared/stats';

interface StatsRequest {
  id: number;
  type: 'vocab' | 'compute' | 'strength' | 'discovery' | 'stateTree' | 'claim' | 'twoRed' | 'decisive' | 'twoRedCohort' | 'decisiveCohort';
  serverUrl: string;
  filter?: GameFilter;
  grouping?: StrengthGrouping;
  /** twoRed：玩家名字。 */
  name?: string;
  /** decisive／decisiveCohort：範圍。 */
  scope?: DecisiveScope;
}

/** Worker 的全域 (web 的 tsconfig 只有 DOM lib；不引 webworker lib，避免兩套全域型別衝突)。 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<StatsRequest>) => void) | null;
  postMessage(message: unknown): void;
};

ctx.onmessage = async (event: MessageEvent<StatsRequest>): Promise<void> => {
  const { id, type, serverUrl, filter, grouping, name, scope } = event.data;
  try {
    const value = type === 'vocab'
      ? await filterVocab(serverUrl)
      : type === 'strength'
        ? await computeStrength(serverUrl, filter ?? null, grouping ?? { kind: 'tier' })
        : type === 'discovery'
          ? await computeDiscovery(serverUrl, filter ?? null)
        : type === 'stateTree'
          ? await computeStateGames(serverUrl, filter ?? null)
        : type === 'claim'
          ? await computeClaimData(serverUrl)
        : type === 'twoRed'
          ? await computeTwoRed(serverUrl, filter ?? null, name ?? '')
        : type === 'decisive'
          ? await computeDecisive(serverUrl, filter ?? null, scope ?? 'twoRed')
        : type === 'twoRedCohort'
          ? await computeTwoRedCohort(serverUrl, filter ?? null)
        : type === 'decisiveCohort'
          ? await computeDecisiveCohort(serverUrl, filter ?? null, scope ?? 'twoRed')
          : await computeFiltered(serverUrl, filter as GameFilter);
    ctx.postMessage({ id, ok: true, value });
  } catch (err) {
    const status = err instanceof GamesUnavailableError ? err.status : 0;
    ctx.postMessage({ id, ok: false, status, error: err instanceof Error ? err.message : String(err) });
  }
};
