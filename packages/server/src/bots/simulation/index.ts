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
import { SimEngine } from './session';

let loader: SimBankLoader | null = null;
let engine: SimEngine | null = null;

export function getSimBankLoader(): SimBankLoader {
  if (!loader) loader = new SimBankLoader();
  return loader;
}

export function getSimEngine(): SimEngine {
  if (!engine) {
    const l = getSimBankLoader();
    engine = new SimEngine({ bank: (): Promise<SimBank | null> => l.get() });
  }
  return engine;
}

/** 開機後呼叫一次：背景讀題庫（不擋開機）。 */
export function startSimulation(): void {
  if (!SIM_CONFIG.commandsEnabled) return;
  getSimBankLoader().start();
}

/** 測試用：換掉單例。 */
export function __setSimForTests(next: { loader?: SimBankLoader | null; engine?: SimEngine | null }): void {
  if (next.loader !== undefined) loader = next.loader;
  if (next.engine !== undefined) engine = next.engine;
}

/** `/api/bots/status → simulation`：只有數字和布林。 */
export function simulationStatus(): SimulationStatus {
  const e = getSimEngine();
  return {
    enabled: SIM_CONFIG.commandsEnabled,
    weighsBehaviour: e.weighsBehaviour,
    bank: getSimBankLoader().status(),
    sessions: { active: e.activeSessions() },
    counts: JSON.parse(JSON.stringify(e.counts)) as SimulationStatus['counts'],
  };
}

export { parseSimCommand, isSimCommandText, SIM_COMMAND_RE } from './commands';
export type { SimReply, SimRequest } from './session';
