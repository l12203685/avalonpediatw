/**
 * 模擬瓦（2026-10-14）— 單例與狀態頁。
 *
 * Edward 2026-10-14：「Line bot/dc bot 有辦法支援模擬瓦嗎? 不是練習局
 * 模擬瓦比較像是練習邏輯思考跟派隊資訊的釋放與解讀」。玩法見 docs/SIMULATION.md。
 *
 * 不是網站的練習局（跟機器人打整場）：一題是真人對局停在某一家某一次派票的當下，
 * 你看前面的派票、寫區間、自己派一次，看你的派票放出什麼資訊，最後公布角色。
 * 回饋是固定規則算出來的（不用 LLM、沒有 token 成本）。
 */

import { SimBankLoader, type SimBank } from './bank';
import { SIM_CONFIG } from './config';
import type { SimulationStatus } from './metrics';
import { GitHubSimBackend, SimPersistence, simStateRepoConfig } from './persist';
import { SimEngine } from './session';

let loader: SimBankLoader | null = null;
let engine: SimEngine | null = null;
let persistence: SimPersistence | null = null;

/** 進行中的題目存檔（persist.ts）：有設定 private repo 就存 GitHub，沒有就只在記憶體。 */
export function getSimPersistence(): SimPersistence {
  if (!persistence) {
    const repo = simStateRepoConfig();
    persistence = new SimPersistence({ backend: repo ? new GitHubSimBackend(repo) : null });
  }
  return persistence;
}

export function getSimBankLoader(): SimBankLoader {
  if (!loader) loader = new SimBankLoader();
  return loader;
}

export function getSimEngine(): SimEngine {
  if (!engine) {
    const l = getSimBankLoader();
    engine = new SimEngine({ bank: (): Promise<SimBank | null> => l.get(), persistence: getSimPersistence() });
  }
  return engine;
}

/**
 * 開機後呼叫一次：背景讀題庫、把重啟前還開著的題目讀回來（都不擋開機；讀完之前的模擬指令會等，見 session.ts）。
 */
export function startSimulation(): void {
  if (!SIM_CONFIG.commandsEnabled) return;
  getSimBankLoader().start();
  getSimEngine();
  void getSimPersistence().restore();
}

/**
 * 關機前呼叫（server 的 index.ts 收到 SIGTERM）：把還沒寫進存檔的題目寫完。最久等 `timeoutMs`，從不丟錯。
 * 模擬沒被用過（沒建過引擎）就什麼都不做。
 */
export async function flushSimulation(timeoutMs = 8_000): Promise<void> {
  if (!persistence) return;
  const p = persistence;
  p.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.flush().catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

/** 測試用：換掉單例。 */
export function __setSimForTests(next: { loader?: SimBankLoader | null; engine?: SimEngine | null; persistence?: SimPersistence | null }): void {
  if (next.loader !== undefined) loader = next.loader;
  if (next.engine !== undefined) engine = next.engine;
  if (next.persistence !== undefined) persistence = next.persistence;
}

/** `/api/bots/status → simulation`：只有數字和布林。 */
export function simulationStatus(): SimulationStatus {
  const e = getSimEngine();
  return {
    enabled: SIM_CONFIG.commandsEnabled,
    weighsBehaviour: e.weighsBehaviour,
    bank: getSimBankLoader().status(),
    sessions: { active: e.activeSessions(), persistence: (e.persistence ?? getSimPersistence()).status() },
    counts: JSON.parse(JSON.stringify(e.counts)) as SimulationStatus['counts'],
  };
}

export { parseSimCommand, isSimCommandText, SIM_COMMAND_RE } from './commands';
export type { SimReply, SimRequest } from './session';
