/**
 * 模擬瓦（2026-10-14）— 題庫載入。
 *
 * 題庫是 commit 進 repo 的 `packages/server/sim_bank.json`（沒有名字、沒有日期，見 bankCodec.ts），
 * 由 `scripts/buildSimBank.ts` 從牌譜快照產生。`sheets_cache.json` 不進 Render 映像檔
 * （.dockerignore），而且裡面有玩家名字，所以伺服器不讀它。
 *
 * 伺服器開機後在背景讀一次；第一個 /模擬 如果題庫還在讀就等它。
 * 每一列都重新嚴格解析，壞的丟掉並計數。檔案不見或壞掉 → /模擬 回「題庫還沒準備好」，
 * 狀態頁 bank.loaded=false。log 只有固定文字和數字。
 *
 * Edward 2026-10-14 審查修正：整個建起來要 0.35 秒以上的 CPU（解析＋同位置真人統計），
 * Render 免費方案 0.1 CPU 會卡住幾秒——剛好是叫醒伺服器的那個 webhook 在等的時候，
 * LINE 逾時就會重送。所以開機讀題庫時每 SIM_BANK_CHUNK 局讓出一次（buildSimBankAsync），
 * 一段只有幾毫秒，webhook 照常回。
 */

import * as fs from 'fs';
import * as path from 'path';
import { describeError } from '../media/bytes';
import { parseBankEntry, SIM_BANK_VERSION, type SimBankFile } from './bankCodec';
import { addGameToAggregates, buildHumanAggregates, type HumanAgg } from './human';
import { buildDecisionPool, type DecisionRef, type SimGame } from './scenario';

export interface SimBank {
  games: SimGame[];
  /** 題庫代號 → games[] 的索引。 */
  byId: Map<string, number>;
  /** `角色:座位` → 那一家第一個決定。 */
  pool: Map<string, DecisionRef[]>;
  /** 同位置真人（human.ts）。 */
  humans: Map<string, HumanAgg>;
  /** 解析失敗而丟掉的列數。 */
  dropped: number;
  /** 所有派票數（每一次派票都是隊長的一個決定點）。 */
  decisionPoints: number;
}

/** 一列 → 加進 games／byId；壞的或重複的回 false。 */
function addEntry(entry: SimBankFile['games'][number], games: SimGame[], byId: Map<string, number>): boolean {
  const res = parseBankEntry(entry);
  if (!res.ok || byId.has(entry.id)) return false;
  // 名字欄位一律丟掉（題庫本來就沒有）：SimGame 沒有 names。
  const game: SimGame & { names?: string[] } = { ...res.game };
  delete game.names;
  byId.set(game.id, games.length);
  games.push(game);
  return true;
}

function finish(games: SimGame[], byId: Map<string, number>, humans: Map<string, HumanAgg>, dropped: number): SimBank {
  return {
    games,
    byId,
    pool: buildDecisionPool(games),
    humans,
    dropped,
    decisionPoints: games.reduce((n, g) => n + g.proposals.length, 0),
  };
}

/** 檔案內容 → 題庫（一次做完；測試與工具用）。 */
export function buildSimBank(file: SimBankFile): SimBank {
  const games: SimGame[] = [];
  const byId = new Map<string, number>();
  let dropped = 0;
  for (const entry of Array.isArray(file?.games) ? file.games : []) {
    if (!addEntry(entry, games, byId)) dropped++;
  }
  return finish(games, byId, buildHumanAggregates(games), dropped);
}

/** 開機讀題庫時每幾局讓出一次 CPU。 */
export const SIM_BANK_CHUNK = 25;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 跟 buildSimBank 一樣的結果，但每 `chunk` 局讓出一次（開機時不擋 webhook）。 */
export async function buildSimBankAsync(file: SimBankFile, chunk = SIM_BANK_CHUNK, pause: () => Promise<void> = yieldToLoop): Promise<SimBank> {
  const games: SimGame[] = [];
  const byId = new Map<string, number>();
  let dropped = 0;
  const entries = Array.isArray(file?.games) ? file.games : [];
  for (let i = 0; i < entries.length; i++) {
    if (!addEntry(entries[i], games, byId)) dropped++;
    if ((i + 1) % chunk === 0) await pause();
  }
  const humans = new Map<string, HumanAgg>();
  for (let i = 0; i < games.length; i++) {
    addGameToAggregates(humans, games[i]);
    if ((i + 1) % chunk === 0) await pause();
  }
  return finish(games, byId, humans, dropped);
}

export const SIM_BANK_FILE = 'sim_bank.json';

/** src/bots/simulation（或 dist/bots/simulation）往上三層 = packages/server。 */
export function defaultSimBankPaths(): string[] {
  const override = (process.env.SIM_BANK_PATH || '').trim();
  if (override) return [path.resolve(override)];
  return [
    path.resolve(__dirname, '..', '..', '..', SIM_BANK_FILE),
    path.resolve(process.cwd(), 'packages', 'server', SIM_BANK_FILE),
    path.resolve(process.cwd(), SIM_BANK_FILE),
  ];
}

/** 讀檔 + 檢查版本；找不到或壞掉回 null（只 log 固定文字和錯誤代碼）。 */
export function readSimBankFile(paths: readonly string[] = defaultSimBankPaths()): SimBankFile | null {
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const file = JSON.parse(fs.readFileSync(p, 'utf8')) as SimBankFile;
      if (file?.version !== SIM_BANK_VERSION || !Array.isArray(file.games)) {
        console.warn('[sim] sim_bank.json has an unexpected version or shape; /模擬 stays off');
        return null;
      }
      return file;
    } catch (err) {
      console.warn(`[sim] reading sim_bank.json failed (${describeError(err)})`);
      return null;
    }
  }
  console.warn('[sim] sim_bank.json not found; /模擬 answers 題庫還沒準備好');
  return null;
}

export interface SimBankStatus {
  loaded: boolean;
  games: number;
  dropped: number;
  decisionPoints: number;
}

/** 題庫只讀一次；`get()` 在讀完之前等它。 */
export class SimBankLoader {
  private promise: Promise<SimBank | null> | null = null;
  private bank: SimBank | null = null;

  constructor(private readonly load: () => SimBank | null | Promise<SimBank | null> = async () => {
    const file = readSimBankFile();
    return file ? buildSimBankAsync(file) : null;
  }) {}

  /** 開機後在背景開始讀（不擋開機）。 */
  start(): void {
    void this.get();
  }

  get(): Promise<SimBank | null> {
    if (!this.promise) {
      this.promise = new Promise<SimBank | null>((resolve) => {
        setImmediate(async () => {
          try {
            this.bank = await this.load();
          } catch (err) {
            console.warn(`[sim] building the bank failed (${describeError(err)})`);
            this.bank = null;
          }
          resolve(this.bank);
        });
      });
    }
    return this.promise;
  }

  status(): SimBankStatus {
    const b = this.bank;
    return { loaded: !!b, games: b?.games.length ?? 0, dropped: b?.dropped ?? 0, decisionPoints: b?.decisionPoints ?? 0 };
  }
}
