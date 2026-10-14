/**
 * 模擬瓦（2026-10-14）— 題庫檔 `sim_bank.json` 的格式，純函式。
 *
 * 規則（owner）：題目只有座位，沒有玩家名字、沒有日期、沒有流水號、沒有備註。
 * 所以題庫不存原始儲存格：`rec` 是**解析後的對局重新寫成牌譜**（隊伍數字、` X-` / ` X+`、
 * o/x 任務行、`H>T o|x` 湖行），名字、日期、註記、全形字、頁尾都不可能混進來；
 * 字元只有 `0-9 o x + - > 空白 換行`（測試守著）。往返測試保證
 * `parseReplayGame(rec)` ≡ 原本解析的那局（名字和流水號除外）。
 *
 * 題號 `id` = sha1(record fingerprint) 的 Crockford base32 前 5 碼；fingerprint 跟
 * generate_cache.py 的 record_fingerprint 同一個定義（配置 + 每次派票的隊伍（座位排序、0 最後）
 * + 每局任務（o 在前 x 在後）），所以重建題庫題號不變，也跟流水號無關。撞號的那幾局一起加長到 6 碼。
 * 題庫照題號排序：檔案順序看不出對局先後。
 */

import { createHash } from 'crypto';
import {
  parseReplayGame,
  ROLE_CODE_ORDER,
  type PaipuRow,
  type ReplayGame,
} from '../../ai/benchmark/sheetsReplay';
import { seatChar, teamDigits } from './seats';

export const SIM_BANK_VERSION = 1;

export interface SimBankEntry {
  /** 題庫裡這一局的代號（5 碼，撞號時 6 碼以上）。 */
  id: string;
  /** 配置：刺娜德奧派梅 6 個座位字元。 */
  cfg: string;
  /** 重新寫過的牌譜（只有座位、o/x、+/-、>）。 */
  rec: string;
  /** 刺殺目標座位字元，沒有刺殺是空字串。 */
  kill: string;
  /** 三紅／三藍死／三藍活。 */
  res: '三紅' | '三藍死' | '三藍活';
}

export interface SimBankFile {
  version: number;
  builtFrom: string;
  games: SimBankEntry[];
}

/** 牌譜這一局的配置碼（刺娜德奧派梅的座位字元）。 */
export function roleCodeOf(game: Pick<ReplayGame, 'seatRoles'>): string {
  return ROLE_CODE_ORDER.map((role) => seatChar(game.seatRoles.indexOf(role) + 1)).join('');
}

/** 把解析後的對局寫回牌譜（題庫的 `rec`）。 */
export function serialiseRecord(game: ReplayGame): string {
  const lines: string[] = [];
  for (const p of game.proposals) {
    let line = p.teamSeats.map(seatChar).join('');
    if (p.minusSeats.length) line += ` ${p.minusSeats.map(seatChar).join('')}-`;
    if (p.plusSeats.length) line += ` ${p.plusSeats.map(seatChar).join('')}+`;
    lines.push(line);
    if (p.wentOnMission) {
      const q = game.quests.find((x) => x.round === p.round);
      if (q) {
        lines.push('o'.repeat(q.successCount) + 'x'.repeat(q.failCount));
        for (const l of game.lakes.filter((x) => x.round === q.round)) {
          const claim = l.claim === 'good' ? ' o' : l.claim === 'evil' ? ' x' : '';
          lines.push(`${seatChar(l.holderSeat)}>${seatChar(l.targetSeat)}${claim}`);
        }
      }
    }
  }
  return lines.join('\n');
}

export function resultLabelOf(game: ReplayGame): SimBankEntry['res'] {
  if (game.quests.filter((q) => q.failed).length >= 3) return '三紅';
  return game.winner === 'evil' ? '三藍死' : '三藍活';
}

/** generate_cache.py record_fingerprint 的同一個定義，算在解析後的對局上。 */
export function recordFingerprint(game: ReplayGame): string {
  const teams = game.proposals.map((p) => teamDigits(p.teamSeats));
  const missions = game.quests.map((q) => 'o'.repeat(q.successCount) + 'x'.repeat(q.failCount));
  return `${roleCodeOf(game)}|${teams.join(',')}|${missions.join(',')}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockfordBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

export function fingerprintHash(fingerprint: string): string {
  return crockfordBase32(createHash('sha1').update(fingerprint, 'utf8').digest());
}

/** 題庫的一列（解析 → 題庫）。 */
export function bankEntryFor(game: ReplayGame, id: string): SimBankEntry {
  return {
    id,
    cfg: roleCodeOf(game),
    rec: serialiseRecord(game),
    kill: game.assassinTargetSeat !== undefined ? seatChar(game.assassinTargetSeat) : '',
    res: resultLabelOf(game),
  };
}

/** 題庫的一列 → 嚴格解析（伺服器載入時每一列都重新解析，壞的就丟掉並計數）。 */
export function parseBankEntry(entry: SimBankEntry): ReturnType<typeof parseReplayGame> {
  if (!entry || typeof entry.rec !== 'string' || typeof entry.cfg !== 'string' || typeof entry.id !== 'string') {
    return { ok: false, reason: 'bad entry' };
  }
  if (!/^[0-9ox+\-> \n]*$/.test(entry.rec)) return { ok: false, reason: 'unexpected characters' };
  const res = parseReplayGame({
    文字記錄: entry.rec,
    配置: entry.cfg,
    刺殺: entry.kill ?? '',
    結果: entry.res ?? '',
  });
  if (res.ok) res.game.id = entry.id;
  return res;
}

export interface SimBankBuildCounts {
  rows: number;
  recorded: number;
  replayable: number;
  lakeChainInvalid: number;
  entertainment: number;
  duplicates: number;
  games: number;
  idCollisions: number;
}

/**
 * 牌譜各列 → 題庫。條件（設計 §2、owner D6 預設）：嚴格解析成功、湖的順序合理、
 * 分類不是「娛樂」。同一個 fingerprint 只留一局。輸出照題號排序。只回傳計數，不回傳任何列的內容。
 */
export function buildBankFile(rows: readonly PaipuRow[], builtFrom = 'sheets_cache.json'): { file: SimBankFile; counts: SimBankBuildCounts } {
  const counts: SimBankBuildCounts = {
    rows: rows.length, recorded: 0, replayable: 0, lakeChainInvalid: 0, entertainment: 0, duplicates: 0, games: 0, idCollisions: 0,
  };
  const byFingerprint = new Map<string, ReplayGame>();
  for (const row of rows) {
    if (!(row['文字記錄'] ?? '').trim()) continue;
    counts.recorded++;
    const parsed = parseReplayGame(row);
    if (!parsed.ok) continue;
    counts.replayable++;
    if (!parsed.game.lakeChainValid) { counts.lakeChainInvalid++; continue; }
    if ((row['分類'] ?? '').trim() === '娛樂') { counts.entertainment++; continue; }
    const fp = recordFingerprint(parsed.game);
    const prev = byFingerprint.get(fp);
    if (prev) {
      counts.duplicates++;
      // 同一局打了兩次：留重寫後字典序較小的那份，跟讀取順序無關。
      if (serialiseRecord(parsed.game) < serialiseRecord(prev)) byFingerprint.set(fp, parsed.game);
      continue;
    }
    byFingerprint.set(fp, parsed.game);
  }

  const hashed = [...byFingerprint.entries()].map(([fp, game]) => ({ hash: fingerprintHash(fp), game }));
  const ids = assignIds(hashed.map((h) => h.hash));
  counts.idCollisions = hashed.filter((h, i) => ids[i].length > 5).length;
  const games = hashed
    .map((h, i) => bankEntryFor(h.game, ids[i]))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  counts.games = games.length;
  return { file: { version: SIM_BANK_VERSION, builtFrom, games }, counts };
}

/** 每個 hash 取最短、不跟別人撞的前綴（至少 5 碼）；撞號的一起加長。 */
export function assignIds(hashes: readonly string[]): string[] {
  const out: string[] = new Array(hashes.length).fill('');
  let pending = hashes.map((_, i) => i);
  for (let len = 5; pending.length > 0 && len <= 32; len++) {
    const groups = new Map<string, number[]>();
    for (const i of pending) {
      const key = hashes[i].slice(0, len);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    const next: number[] = [];
    for (const [key, members] of groups) {
      if (members.length === 1) out[members[0]] = key;
      else next.push(...members);
    }
    pending = next;
  }
  return out;
}
