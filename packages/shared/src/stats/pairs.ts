/** 默契：共同出賽的三結果矩陣，以及同陣營的任務／最終勝負；不沿用試算表四張矩陣的值。 */
import { playerNameKey } from '../playerNameMatch';
import { isFinalWin, isOutcome, roleFactionName, SEATS } from './constants';
import type { Game } from './dataset';
import { cmpCodePoint, rate } from './pyround';

export interface PairRoster { players: string[]; rowLabels?: string[] }
export interface OutcomePairMatrix {
  players: string[];
  rowLabels: string[];
  values: Array<Array<number | null>>;
  threeBlueDeadPct: Array<Array<number | null>>;
  threeBlueAlivePct: Array<Array<number | null>>;
  games: Array<Array<number | null>>;
  source: 'games';
}
export interface FactionPair {
  players: [string, string];
  sharedGames: number;
  sameFactionGames: number;
  missionWins: number;
  missionLosses: number;
  finalWins: number;
  finalLosses: number;
  missionWinRate: number | null;
  finalWinRate: number | null;
}
export interface PairsSection {
  outcomePair: OutcomePairMatrix;
  sameFaction: FactionPair[];
  source: 'games';
}

interface Counts { red: number; dead: number; alive: number; same: number; missionWins: number; finalWins: number }
const pairKey = (a: string, b: string) => JSON.stringify(cmpCodePoint(a, b) < 0 ? [a, b] : [b, a]);

export function computePairs(games: readonly Game[], roster: PairRoster = { players: [] }, hidden?: ReadonlySet<string>): PairsSection {
  const counts = new Map<string, Counts>();
  const labels = new Map<string, string>();
  for (const game of games) {
    if (!isOutcome(game.outcome)) continue;
    const present = new Map<string, Set<string>>();
    game.seatPlayers.forEach((name, i) => {
      if (!name) return;
      const key = playerNameKey(name);
      labels.set(key, name);
      if (!present.has(key)) present.set(key, new Set());
      present.get(key)!.add(roleFactionName(game.seatRoles.get(SEATS[i]) ?? ''));
    });
    const names = [...present.keys()].sort(cmpCodePoint);
    names.forEach((a, i) => {
      for (const b of names.slice(i + 1)) {
        const key = pairKey(a, b);
        let c = counts.get(key);
        if (!c) { c = { red: 0, dead: 0, alive: 0, same: 0, missionWins: 0, finalWins: 0 }; counts.set(key, c); }
        c.red += Number(game.outcome === '三紅');
        c.dead += Number(game.outcome === '三藍死');
        c.alive += Number(game.outcome === '三藍活');
        const fa = present.get(a)!;
        const fb = present.get(b)!;
        const faction = [...fa][0];
        // 同一名字跨陣營佔兩席時仍算共同出賽，但不能確定兩人的同隊陣營。
        if (fa.size !== 1 || fb.size !== 1 || !faction || !fb.has(faction)) continue;
        c.same += 1;
        c.missionWins += Number(faction === '紅方' ? game.redWin : game.blueWin);
        c.finalWins += Number(isFinalWin(faction === '紅方' ? '刺客' : '忠臣', game.outcome));
      }
    });
  }
  const hiddenKeys = new Set([...(hidden ?? [])].map(playerNameKey));
  const shown = (name: string) => !hiddenKeys.has(playerNameKey(name));
  const players = roster.players.filter(shown);
  const rowLabels = players.length ? (roster.rowLabels?.length ? roster.rowLabels : roster.players).filter(shown) : [];
  const matrix = (field: 'red' | 'dead' | 'alive' | 'games'): Array<Array<number | null>> => rowLabels.map((a) => players.map((b) => {
    const ak = playerNameKey(a); const bk = playerNameKey(b);
    const c = ak === bk ? undefined : counts.get(pairKey(ak, bk));
    if (!c) return null;
    const n = c.red + c.dead + c.alive;
    return field === 'games' ? n : rate(c[field], n);
  }));
  const sameFaction: FactionPair[] = [];
  for (const [key, c] of counts) {
    const keys = JSON.parse(key) as [string, string];
    if (keys.some((k) => hiddenKeys.has(k))) continue;
    sameFaction.push({
      players: keys.map((k) => labels.get(k)!) as [string, string],
      sharedGames: c.red + c.dead + c.alive, sameFactionGames: c.same,
      missionWins: c.missionWins, missionLosses: c.same - c.missionWins,
      finalWins: c.finalWins, finalLosses: c.same - c.finalWins,
      missionWinRate: c.same ? rate(c.missionWins, c.same) : null,
      finalWinRate: c.same ? rate(c.finalWins, c.same) : null,
    });
  }
  sameFaction.sort((a, b) => b.sameFactionGames - a.sameFactionGames
    || cmpCodePoint(a.players[0], b.players[0]) || cmpCodePoint(a.players[1], b.players[1]));
  return { source: 'games', sameFaction, outcomePair: {
    players, rowLabels, values: matrix('red'), threeBlueDeadPct: matrix('dead'), threeBlueAlivePct: matrix('alive'),
    games: matrix('games'), source: 'games',
  } };
}
