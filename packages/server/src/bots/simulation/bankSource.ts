/**
 * 模擬瓦題庫的來源（2026-11-20）：牌譜總庫 `game_db.json` → bankCodec.buildBankFile 吃的列，純函式。
 *
 * 站長 2026-11-20：「所有跟數字統計有關的 都應該跟資料庫連動 而不是寫死」「整個系統要完全同步同來源」。
 * 以前題庫讀凍結的牌譜快照 sheets_cache.json（2026-04，1,778 局），「同位置真人」跟數據分析頁不是同一份資料。
 * 現在讀每晚 game_db.py 寫的總庫：試算表＋Discord 合成的同一份、已經套用站長更正（game_db_corrections.json）、
 * 錯誤局（刺到隊友、尾派沒出任務）已經排除、ProAvalon 預設不在裡面。
 *
 * 留下的局（其餘只計數）：
 *   - 真人實戰（kind = real）：模擬（sim）與百科AI（bot）的局不要（Edward 11/16「模擬畢竟只是模擬」、11/03「有百科AI的另外算」）；
 *   - 不是外部（ProAvalon，external）；
 *   - 讀得懂（有 game）、沒有違反規則（status 不是 error）；
 *   - 不是補完的局（completed：五個鐵好推定後面的任務，不是真的打過的）；
 *   - 分類不是「娛樂」（legacyCategory；同舊題庫，buildBankFile 計在 entertainment）。
 * 之後一樣經過 buildBankFile 的嚴格解析（parseReplayGame）與湖的順序檢查。
 * 每一局寫成牌譜文字（派票行＋異常票記號、任務行、湖行），跟題庫 `rec` 同一個格式；沒有名字、沒有日期。
 */

import type { PaipuRow } from '../../ai/benchmark/sheetsReplay';

interface DbProposal { team?: unknown; votes?: unknown }
interface DbRound { proposals?: unknown; mission?: unknown }
interface DbLake { after?: unknown; holder?: unknown; target?: unknown; claim?: unknown }
interface DbGame { config?: unknown; rounds?: unknown; lakes?: unknown; assassination?: unknown; outcome?: unknown }
interface DbRow {
  kind?: unknown;
  external?: unknown;
  status?: unknown;
  completed?: unknown;
  legacyCategory?: unknown;
  game?: DbGame | null;
}

export interface GameDbSourceCounts {
  /** 總庫的局數。 */
  rows: number;
  /** 模擬、百科AI 的局。 */
  notReal: number;
  external: number;
  unreadable: number;
  /** 違反規則（status error）。 */
  ruleErrors: number;
  /** 補完的局（completed）。 */
  completed: number;
  /** 交給 buildBankFile 的列。 */
  passed: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 總庫一局的 game → 牌譜文字（題庫 `rec` 的格式）；形狀不對回 null。 */
export function recordTextOf(game: DbGame): string | null {
  const lines: string[] = [];
  const lakes = arr(game.lakes) as DbLake[];
  const rounds = arr(game.rounds) as DbRound[];
  if (rounds.length === 0) return null;
  rounds.forEach((r, i) => {
    for (const p of arr(r.proposals) as DbProposal[]) {
      const team = str(p.team);
      const marks = arr(p.votes).map(str).filter(Boolean);
      lines.push([team, ...marks].join(' '));
    }
    const mission = str(r.mission);
    if (mission) lines.push(mission);
    for (const l of lakes) {
      if (l.after !== i + 1) continue;
      const claim = str(l.claim);
      lines.push(`${str(l.holder)}>${str(l.target)}${claim === 'o' || claim === 'x' ? ` ${claim}` : ''}`);
    }
  });
  return lines.join('\n');
}

/** game_db.json → 題庫的列（buildBankFile 的輸入）＋計數。 */
export function rowsFromGameDb(doc: { games?: unknown } | null | undefined): { rows: PaipuRow[]; counts: GameDbSourceCounts } {
  const all = arr(doc?.games) as DbRow[];
  const counts: GameDbSourceCounts = { rows: all.length, notReal: 0, external: 0, unreadable: 0, ruleErrors: 0, completed: 0, passed: 0 };
  const rows: PaipuRow[] = [];
  for (const g of all) {
    if (g.kind !== 'real') { counts.notReal++; continue; }
    if (g.external) { counts.external++; continue; }
    const text = g.game ? recordTextOf(g.game) : null;
    if (!g.game || text === null) { counts.unreadable++; continue; }
    if (g.status === 'error') { counts.ruleErrors++; continue; }
    if (g.completed) { counts.completed++; continue; }
    const legacy = arr(g.legacyCategory).map(str);
    rows.push({
      文字記錄: text,
      配置: str(g.game.config),
      刺殺: str(g.game.assassination),
      結果: str(g.game.outcome),
      分類: legacy.includes('娛樂') ? '娛樂' : '',
    });
    counts.passed++;
  }
  return { rows, counts };
}
