/**
 * 模擬瓦（2026-10-14）— 題庫載入。
 *
 * 題庫是 commit 進 repo 的 `packages/server/sim_bank.json`（沒有名字、沒有日期，見 bankCodec.ts；/公布 的名字
 * 是執行期從網站的牌譜紀錄清單對來的，不寫進題庫，見 seatNames.ts），
 * 由 `scripts/buildSimBank.ts` 從牌譜總庫 `game_db.json` 產生（每晚，2026-11-20 起；之前讀牌譜快照
 * `sheets_cache.json`）。伺服器只讀題庫，不讀總庫或快照。
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
import { parseBankEntry, recordFingerprint, SIM_BANK_VERSION, type SimBankFile } from './bankCodec';
import { gameProblem, isExcludedBankGame, readSimExclusions, type SimExclusions } from './quality';
import { addGameToAggregates, buildHumanAggregates, type HumanAgg } from './human';
import { linkRecords, readRecordPosts, fingerprintIndex } from './recordsIndex';
import { linkSeatNames, readSeatNameSources, type SeatNameRules } from './seatNames';
import { buildAssassinPool, buildDecisionPool, buildMidPool, type DecisionRef, type SimGame } from './scenario';

export interface SimBank {
  games: SimGame[];
  /** 題庫代號 → games[] 的索引。 */
  byId: Map<string, number>;
  /** `角色:座位` → 那一家第一個決定。 */
  pool: Map<string, DecisionRef[]>;
  /** 局面池：`局:角色` → 尾派（1-5～4-5）、第 5 局的派票；派西維爾的派票（scenario.buildMidPool）。 */
  midPool: Map<string, DecisionRef[]>;
  /** 刺殺題的局（三藍、有刺殺）。 */
  assassinPool: number[];
  /**
   * games[] 的索引 → 網站牌譜紀錄的貼文 id（recordsIndex.ts）。/公布 附連結；有對照時隨機選題只出有連結的局。
   * 讀不到牌譜紀錄清單時是空的。
   */
  records: Map<number, string>;
  /**
   * games[] 的索引 → 1～0 家的名字（網站戰績的寫法，沒有名字是 ''；seatNames.ts）：對到的那一篇牌譜紀錄的名字。
   * /公布 印在座位那一行下面；沒有對到、或那一篇沒有名字的局不在裡面。只在記憶體，不寫進題庫。
   */
  names: Map<number, string[]>;
  /** 同位置真人（human.ts）。 */
  humans: Map<string, HumanAgg>;
  /** 解析失敗而丟掉的列數。 */
  dropped: number;
  /** 讀題庫時因為紀錄異常或人工清單而不出的局數（quality.ts，2026-11-21；只有伺服器讀題庫時擋）。 */
  filtered: number;
  /** 所有派票數（每一次派票都是隊長的一個決定點）。 */
  decisionPoints: number;
}

/**
 * 讀題庫時的異常篩選（2026-11-21，quality.ts）：伺服器讀題庫時給（SimBankLoader），擋掉紀錄本身算得出來的異常和人工清單上的局。
 * Threads 的工具不給（照題庫原樣，計畫和釘選不受影響；題庫每晚重建時已經篩過）。
 */
export interface SimBankFilter {
  exclude: SimExclusions;
}

/** 一列 → 加進 games／byId；壞的或重複的回 'dropped'，被篩掉的回 'filtered'。 */
function addEntry(entry: SimBankFile['games'][number], games: SimGame[], byId: Map<string, number>, filter?: SimBankFilter): 'added' | 'dropped' | 'filtered' {
  const res = parseBankEntry(entry);
  if (!res.ok || byId.has(entry.id)) return 'dropped';
  if (filter && (gameProblem(res.game) || isExcludedBankGame(filter.exclude, recordFingerprint(res.game), entry.id))) return 'filtered';
  // 名字欄位一律丟掉（題庫本來就沒有）：SimGame 沒有 names。
  const game: SimGame & { names?: string[] } = { ...res.game };
  delete game.names;
  byId.set(game.id, games.length);
  games.push(game);
  return 'added';
}

/** /公布 名字的規則（player_aliases.json）和局號對照（game_db.json 同一局的所有來源 id）；沒給 = 照原樣的名字。 */
export interface SeatNameSources {
  rules: SeatNameRules;
  ids: ReadonlyMap<string, readonly string[]>;
}

function finish(
  games: SimGame[], byId: Map<string, number>, humans: Map<string, HumanAgg>, dropped: number, filtered: number,
  posts?: readonly unknown[] | null, nameSources?: SeatNameSources,
): SimBank {
  const records: Map<number, string> = posts ? linkRecords(games, fingerprintIndex(posts)) : new Map();
  return {
    games,
    byId,
    pool: buildDecisionPool(games),
    midPool: buildMidPool(games),
    assassinPool: buildAssassinPool(games),
    records,
    names: posts ? linkSeatNames(records, posts, nameSources?.rules, nameSources?.ids) : new Map(),
    humans,
    dropped,
    filtered,
    decisionPoints: games.reduce((n, g) => n + g.proposals.length, 0),
  };
}

/**
 * 檔案內容 → 題庫（一次做完；測試與工具用）。`posts` = 網站牌譜紀錄的貼文（對連結和 /公布 的名字用，沒給就沒有）；
 * `nameSources` = 名字換成網站寫法的規則。
 */
export function buildSimBank(file: SimBankFile, posts?: readonly unknown[] | null, nameSources?: SeatNameSources, filter?: SimBankFilter): SimBank {
  const games: SimGame[] = [];
  const byId = new Map<string, number>();
  let dropped = 0;
  let filtered = 0;
  for (const entry of Array.isArray(file?.games) ? file.games : []) {
    const r = addEntry(entry, games, byId, filter);
    if (r === 'dropped') dropped++;
    else if (r === 'filtered') filtered++;
  }
  return finish(games, byId, buildHumanAggregates(games), dropped, filtered, posts, nameSources);
}

/** 開機讀題庫時每幾局讓出一次 CPU。 */
export const SIM_BANK_CHUNK = 25;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 跟 buildSimBank 一樣的結果，但每 `chunk` 局讓出一次（開機時不擋 webhook）。 */
export async function buildSimBankAsync(
  file: SimBankFile,
  chunk = SIM_BANK_CHUNK,
  pause: () => Promise<void> = yieldToLoop,
  posts?: readonly unknown[] | null,
  nameSources?: SeatNameSources,
  filter?: SimBankFilter,
): Promise<SimBank> {
  const games: SimGame[] = [];
  const byId = new Map<string, number>();
  let dropped = 0;
  let filtered = 0;
  const entries = Array.isArray(file?.games) ? file.games : [];
  for (let i = 0; i < entries.length; i++) {
    const r = addEntry(entries[i], games, byId, filter);
    if (r === 'dropped') dropped++;
    else if (r === 'filtered') filtered++;
    if ((i + 1) % chunk === 0) await pause();
  }
  const humans = new Map<string, HumanAgg>();
  for (let i = 0; i < games.length; i++) {
    addGameToAggregates(humans, games[i]);
    if ((i + 1) % chunk === 0) await pause();
  }
  await pause();
  return finish(games, byId, humans, dropped, filtered, posts, nameSources);
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
  /** 讀題庫時因為紀錄異常或人工清單而不出的局數。 */
  filtered: number;
  decisionPoints: number;
  /** 對得到網站牌譜紀錄的局數。 */
  linked: number;
}

/** 題庫只讀一次；`get()` 在讀完之前等它。 */
export class SimBankLoader {
  private promise: Promise<SimBank | null> | null = null;
  private bank: SimBank | null = null;

  constructor(private readonly load: () => SimBank | null | Promise<SimBank | null> = async () => {
    const file = readSimBankFile();
    // 網站牌譜紀錄清單（/公布 的連結和名字）：讀不到也照樣出題，只是沒有連結、沒有名字。
    if (!file) return null;
    const posts = readRecordPosts();
    // 紀錄異常的局不出題（2026-11-21）：人工清單 sim_bank_exclude.json 加了就生效，不用等題庫重建。
    return buildSimBankAsync(file, SIM_BANK_CHUNK, yieldToLoop, posts, posts ? readSeatNameSources() : undefined, { exclude: readSimExclusions() });
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
    return { loaded: !!b, games: b?.games.length ?? 0, dropped: b?.dropped ?? 0, filtered: b?.filtered ?? 0, decisionPoints: b?.decisionPoints ?? 0, linked: b?.records.size ?? 0 };
  }
}
