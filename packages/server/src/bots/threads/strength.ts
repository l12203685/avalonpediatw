/**
 * Threads 選局（2026-11-17）— 每一局的陣容強度 S。
 *
 * S 是網站「陣容強度」的定義（Edward 2026-10-31「S = 場上 PR 的平均，直接用 S 來篩選」）：
 * 每局賽前，十個座位在當時玩家池裡的 PR 平均；games_cache.json 每一局的 `lineup[1]` 是 S×10，
 * 不評分的局（有名字的座位太少等）是空的。網站把 S ≥ 65 當高強度（generate_cache.py lineup_summary）。
 *
 * 題庫（sim_bank.json）沒有日期、名字，也沒有 S：用跟 generate_cache.py `record_fingerprint`
 * 同一個指紋（配置｜每次派票的隊伍｜每局任務結果）對上 games_cache.json 的那一局。
 */

import { recordFingerprint } from '../simulation/bankCodec';
import type { SimGame } from '../simulation/scenario';

/** 網站的高強度門檻（S ≥ 65）。 */
export const HIGH_LINEUP_S = 65;

interface GamesCacheFile {
  fields?: readonly string[];
  games?: readonly unknown[][];
}

function seatNumber(c: string): number {
  return c === '0' ? 10 : Number(c);
}

function sortedTeam(team: string): string {
  return [...team].sort((a, b) => seatNumber(a) - seatNumber(b)).join('');
}

/** games_cache.json 一局的指紋（generate_cache.py record_fingerprint 的同一個定義）。 */
export function cacheGameFingerprint(config: string, votes: readonly unknown[], missions: string): string {
  const teams = votes
    .map((v) => (Array.isArray(v) ? String(v[2] ?? '') : ''))
    .filter((t) => /^[0-9]+$/.test(t))
    .map(sortedTeam);
  const results = missions
    .split('|')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => /^[ox]+$/.test(m))
    .map((m) => 'o'.repeat([...m].filter((c) => c === 'o').length) + 'x'.repeat([...m].filter((c) => c === 'x').length));
  return `${String(config ?? '').trim()}|${teams.join(',')}|${results.join(',')}`;
}

/** games_cache.json → 指紋 → S（同一個指紋出現兩次就不給，避免對錯局）。 */
export function lineupIndex(cache: GamesCacheFile): Map<string, number> {
  const fields = cache.fields ?? [];
  const col = (name: string): number => fields.indexOf(name);
  const [ci, vi, mi, li] = [col('config'), col('votes'), col('missions'), col('lineup')];
  const out = new Map<string, number>();
  const dup = new Set<string>();
  if ([ci, vi, mi, li].some((i) => i < 0)) return out;
  for (const g of cache.games ?? []) {
    const lineup = g[li];
    const votes = g[vi];
    if (!Array.isArray(lineup) || lineup.length < 2 || typeof lineup[1] !== 'number' || !Array.isArray(votes)) continue;
    const fp = cacheGameFingerprint(String(g[ci] ?? ''), votes, String(g[mi] ?? ''));
    if (out.has(fp)) dup.add(fp);
    out.set(fp, Math.round(lineup[1]) / 10);
  }
  for (const fp of dup) out.delete(fp);
  return out;
}

/** 題庫一局的 S；對不上或不評分就 null。 */
export function lineupOf(game: SimGame, index: ReadonlyMap<string, number>): number | null {
  return index.get(recordFingerprint(game as Parameters<typeof recordFingerprint>[0])) ?? null;
}
