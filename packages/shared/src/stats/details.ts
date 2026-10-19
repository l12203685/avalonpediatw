/**
 * players 端點的外殼與 playerDetails（generate_cache.compute_players_endpoint / compute_player_details）。
 */
import type { PlayerRow } from './players';

export const OUTCOME_SOURCE_GAMES = 'games';

export interface PlayersSection {
  players: PlayerRow[];
  total: number;
  seatOutcomesSource: typeof OUTCOME_SOURCE_GAMES;
  aliases?: Record<string, string>;
}

export interface PlayerDetail {
  /** players 列去掉 seatOutcomes（快取只在 players.players 放 seatOutcomes）。 */
  player: Omit<PlayerRow, 'seatOutcomes'>;
  /** roleWinRates 的副本（沒有人讀：/api/analysis/players/:name 自己組 radar）。 */
  radar: Record<string, number>;
}

export function computePlayersEndpoint(players: PlayerRow[], aliases: Record<string, string> = {}): PlayersSection {
  const names = new Set(players.map((p) => p.name));
  const present = Object.fromEntries(Object.entries(aliases).filter(([, to]) => names.has(to)));
  return { players, total: players.length, seatOutcomesSource: OUTCOME_SOURCE_GAMES,
    ...(Object.keys(present).length ? { aliases: present } : {}) };
}

/** 名字當鍵：用 defineProperty，"__proto__" 之類的名字也是一般的鍵（Python dict 也是）。 */
export function setNamed<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, { value, enumerable: true, writable: true, configurable: true });
}

export function computePlayerDetails(players: readonly PlayerRow[]): Record<string, PlayerDetail> {
  const out: Record<string, PlayerDetail> = {};
  for (const p of players) {
    const { seatOutcomes: _seatOutcomes, ...player } = p;
    void _seatOutcomes;
    setNamed(out, p.name, { player, radar: { ...p.roleWinRates } });
  }
  return out;
}
