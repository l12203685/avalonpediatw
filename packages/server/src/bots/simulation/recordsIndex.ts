/**
 * 模擬瓦 — 題庫的一局 → 網站「牌譜紀錄」那一篇（Edward 2026-11-16：「模擬瓦公布沒辦法知道原本的完整牌譜，
 * 還要自己找」「給牌局連結就好」）。
 *
 * 題庫（sim_bank.json）從試算表的牌譜來，沒有名字、日期；網站的牌譜紀錄（records_cache.json）是 DC 論壇的貼文。
 * 之後牌譜紀錄清單也會收試算表的局（每局都有網站頁）：這裡不假設 id 是 DC 貼文的數字，對照照樣適用。
 * 兩邊用同一個指紋對：generate_cache.py record_fingerprint（配置｜每次派票的隊伍（座位排序、0 最後）｜每局任務
 * （o 在前 x 在後））。題庫這邊用 bankCodec.recordFingerprint（建題庫時算題號的同一個），貼文這邊照
 * discord_records_export.entry_fingerprint 在這裡重算。對到的才有連結；試算表裡比 DC 論壇早、或沒貼到論壇的局沒有。
 *
 * 檔案只讀一次（題庫讀完後順便讀），只留「題庫第幾局 → 貼文 id」，不留標題、名字或其他欄位。
 * 讀不到或格式不對 → 空的對照（/公布 改附文字牌譜，選題不限制）。log 只有固定文字和數字。
 */

import * as fs from 'fs';
import type { ReplayGame } from '../../ai/benchmark/sheetsReplay';
import { recordsPaths, isRecordsDocument } from '../../services/recordsList';
import { STATS_SITE_URL } from '../stats/statsReplies';
import { describeError } from '../media/bytes';
import { recordFingerprint } from './bankCodec';
import type { SimGame } from './scenario';

/** 牌譜紀錄的一篇貼文裡，指紋要用到的欄位（discord_records_export.py 的 game）。 */
export interface RecordPostGame {
  config: string;
  rounds: { proposals: { team: string }[]; mission: string }[];
}

const seatNumber = (ch: string): number => (ch === '0' ? 10 : Number(ch));

/** discord_records_export.entry_fingerprint（= generate_cache.record_fingerprint）的同一個定義。 */
export function postFingerprint(game: RecordPostGame): string {
  const teams: string[] = [];
  const missions: string[] = [];
  for (const r of game.rounds ?? []) {
    for (const p of r.proposals ?? []) {
      const m = /^[0-9]+/u.exec(String(p.team ?? '').normalize('NFKC').trim());
      if (m) teams.push([...m[0]].sort((a, b) => seatNumber(a) - seatNumber(b)).join(''));
    }
    const mission = String(r.mission ?? '').normalize('NFKC').trim();
    if (/^[oxOX]+$/u.test(mission)) {
      const low = mission.toLowerCase();
      missions.push('o'.repeat([...low].filter((c) => c === 'o').length) + 'x'.repeat([...low].filter((c) => c === 'x').length));
    }
  }
  return `${String(game.config ?? '').trim()}|${teams.join(',')}|${missions.join(',')}`;
}

/**
 * 這一篇是模擬的局（不是真人實戰）：分類、標籤寫了模擬，或有 `sim`／`simulated` 旗標（整併後的牌譜紀錄寫 `sim: true`，2026-11-16）。
 * 模擬的局不當題目、也不拿來連結（Edward：「模擬畢竟只是模擬」）。
 */
export function isSimulatedPost(p: { game?: unknown; tags?: unknown; sim?: unknown; simulated?: unknown; category?: unknown }): boolean {
  if (p.sim === true || p.simulated === true) return true;
  const game = (p.game ?? {}) as { category?: unknown; sim?: unknown; simulated?: unknown };
  if (game.sim === true || game.simulated === true) return true;
  const words = [p.category, game.category, ...(Array.isArray(p.tags) ? p.tags : [])].map((x) => String(x ?? ''));
  return words.some((w) => w.includes('模擬'));
}

/** 貼文清單 → 指紋 → 貼文 id（同一局貼兩次取第一篇；模擬的局跳過）。 */
export function fingerprintIndex(posts: readonly unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of posts) {
    const p = raw as { id?: unknown; game?: unknown; tags?: unknown; simulated?: unknown; category?: unknown };
    if (isSimulatedPost(p)) continue;
    const id = String(p?.id ?? '');
    // id 當不透明字串（DC 貼文 id，或之後試算表局的新 id）：只擋掉空的、太長的、怪字元。
    if (!/^[0-9A-Za-z_-]{1,40}$/.test(id) || !p.game || typeof p.game !== 'object') continue;
    const fp = postFingerprint(p.game as RecordPostGame);
    if (!out.has(fp)) out.set(fp, id);
  }
  return out;
}

/** 題庫 games[] 的索引 → 貼文 id。 */
export function linkRecords(games: readonly SimGame[], index: ReadonlyMap<string, string>): Map<number, string> {
  const out = new Map<number, string>();
  games.forEach((g, i) => {
    const id = index.get(recordFingerprint(g as ReplayGame));
    if (id) out.set(i, id);
  });
  return out;
}

/** 讀網站的牌譜紀錄清單，回傳貼文清單；讀不到回 null（只 log 固定文字）。 */
export function readRecordPosts(paths: readonly string[] = recordsPaths()): unknown[] | null {
  const file = paths.find((p) => fs.existsSync(p));
  if (!file) return null;
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecordsDocument(doc)) {
      console.warn('[sim] records_cache.json has an unexpected shape; /公布 falls back to the text record');
      return null;
    }
    return doc.posts;
  } catch (err) {
    console.warn(`[sim] reading records_cache.json failed (${describeError(err)})`);
    return null;
  }
}

/** 網站上這一篇牌譜的連結（網站的公開 hash 連結，不需要登入）。 */
export function recordUrl(postId: string): string {
  return `${STATS_SITE_URL}/#records=${encodeURIComponent(postId)}`;
}
