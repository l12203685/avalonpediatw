/**
 * players 區塊（generate_cache.py 的 _PlayerTally / _player_tallies / compute_player_stats /
 * compute_role_final_win_rates / compute_seat_final_win_rates / compute_seat_outcomes_per_player 逐行移植）。
 *
 * 一位玩家 = 玩1..玩0 的一個名字（資料集已是合併後的顯示名）；只算結果是三紅 / 三藍死 / 三藍活的局、
 * 有寫名字的座位。舊欄位用任務階段的勝負（三藍死 = 藍勝），final* / excess* / theory 用最終結算。
 */
import {
  ALL_ROLES,
  OUTCOMES,
  OUTCOME_BLUE_ALIVE,
  OUTCOME_BLUE_DEAD,
  OUTCOME_THREE_RED,
  RED_ROLES,
  SEATS,
  isFinalWin,
  isOutcome,
  seatLabel,
} from './constants';
import type { Game, GamesDatasetConfig } from './dataset';
import type { PlayerVoting } from '../derived/playerVoting';
import { computePlayerVoting } from './voting';
import { rate, rnd1, sortByKey, sumLtr } from './pyround';
import { playerTheory, playerTimelines, type PlayerSeat, type PlayerTheory } from './theory';

export interface OutcomeSplit {
  threeRed: number;
  threeBlueDead: number;
  threeBlueAlive: number;
  threeRedPct: number;
  threeBlueDeadPct: number;
  threeBlueAlivePct: number;
}

export interface RoleSeatCell {
  games: number;
  wins: number;
  winRate: number;
}

/** players.players 的一列（欄位與順序同快取）。 */
export interface PlayerRow {
  name: string;
  totalGames: number;
  winRate: number;
  roleTheory: number;
  positionTheory: number;
  redWin: number;
  blueWin: number;
  red3Red: number;
  redMerlinDead: number;
  redMerlinAlive: number;
  blue3Red: number;
  blueMerlinDead: number;
  blueMerlinAlive: number;
  roleWinRates: Record<string, number>;
  roleDistribution: Record<string, number>;
  redRoleRate: number;
  blueRoleRate: number;
  seatWinRates: Record<string, number>;
  seatRedWinRates: Record<string, number>;
  seatBlueWinRates: Record<string, number>;
  rawRoleGames: Record<string, number>;
  rawRedWins: number;
  rawBlueWins: number;
  rawTotalWins: number;
  rawRedGames: number;
  rawBlueGames: number;
  rawRedThreeRed: number;
  rawRedMerlinDead: number;
  rawRedMerlinAlive: number;
  rawBlueThreeRed: number;
  rawBlueMerlinDead: number;
  rawBlueMerlinAlive: number;
  roleSeatStats: Record<string, RoleSeatCell>;
  finalWinRate: number;
  finalRedWinRate: number;
  finalBlueWinRate: number;
  missionWinRate: number;
  merlinSurvivalRate: number;
  rawBlueThreeBlue: number;
  roleFinalWinRates: Record<string, number>;
  expectedFinalWinRate: number | null;
  excessWinRate: number | null;
  firstPlayed: string;
  lastPlayed: string;
  roleOutcomes: Record<string, Record<string, number>>;
  theory: PlayerTheory;
  seatOutcomes?: Record<string, OutcomeSplit>;
  voting?: PlayerVoting;
}

type Faction = 'red' | 'blue';

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** generate_cache._PlayerTally：走過局時一位玩家的計數。 */
export class PlayerTally {
  games = 0;
  wins = 0;
  readonly roleGames = new Map<string, number>();
  readonly roleWins = new Map<string, number>();
  readonly factionGames = new Map<string, number>();
  readonly factionWins = new Map<string, number>();
  /** `${faction}|${結果}` */
  readonly factionOutcomes = new Map<string, number>();
  readonly seatGames = new Map<string, number>();
  readonly seatWins = new Map<string, number>();
  /** `${seat}|${faction}` */
  readonly seatFactionGames = new Map<string, number>();
  readonly seatFactionWins = new Map<string, number>();
  /** "角色|座號" → [games, wins]，首見順序。 */
  readonly roleSeat = new Map<string, [number, number]>();
  /** `${role}|${結果}` */
  readonly roleOutcomes = new Map<string, number>();
  firstDate = '';
  lastDate = '';

  add(seat: string, role: string, outcome: string, won: boolean, date = ''): void {
    const faction: Faction = RED_ROLES.has(role) ? 'red' : 'blue';
    const w = won ? 1 : 0;
    this.games += 1;
    this.wins += w;
    inc(this.roleGames, role);
    inc(this.roleWins, role, w);
    inc(this.factionGames, faction);
    inc(this.factionWins, faction, w);
    inc(this.factionOutcomes, `${faction}|${outcome}`);
    inc(this.seatGames, seat);
    inc(this.seatWins, seat, w);
    inc(this.seatFactionGames, `${seat}|${faction}`);
    inc(this.seatFactionWins, `${seat}|${faction}`, w);
    const key = `${role}|${seatLabel(seat)}`;
    const cell = this.roleSeat.get(key) ?? [0, 0];
    cell[0] += 1;
    cell[1] += w;
    this.roleSeat.set(key, cell);
    inc(this.roleOutcomes, `${role}|${outcome}`);
    if (date) {
      this.firstDate = this.firstDate ? (date < this.firstDate ? date : this.firstDate) : date;
      if (date > this.lastDate) this.lastDate = date;
    }
  }

  private outcomes(faction: Faction, outcome: string): number {
    return this.factionOutcomes.get(`${faction}|${outcome}`) ?? 0;
  }

  /** 最終結算的勝場（全部，或當 `role` 的局）。 */
  finalWins(role?: string): number {
    if (role !== undefined) {
      return OUTCOMES.reduce((n, o) => n + (isFinalWin(role, o) ? this.roleOutcomes.get(`${role}|${o}`) ?? 0 : 0), 0);
    }
    return this.outcomes('red', OUTCOME_THREE_RED) + this.outcomes('red', OUTCOME_BLUE_DEAD) + this.outcomes('blue', OUTCOME_BLUE_ALIVE);
  }

  /** generate_cache._PlayerTally.to_row（`roleFinalRates` = overview.roleFinalWinRates；沒有時 expected / excess 為 null）。 */
  toRow(name: string, roleFinalRates?: Readonly<Record<string, number>>): Omit<PlayerRow, 'theory'> {
    const total = this.games;
    const redGames = this.factionGames.get('red') ?? 0;
    const blueGames = this.factionGames.get('blue') ?? 0;
    const get = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;
    const roleWinRates: Record<string, number> = {};
    const roleDistribution: Record<string, number> = {};
    for (const r of ALL_ROLES) {
      roleWinRates[r] = rate(get(this.roleWins, r), get(this.roleGames, r));
      roleDistribution[r] = rate(get(this.roleGames, r), total);
    }
    const roleTheory = rnd1(sumLtr(ALL_ROLES.map((r) => roleDistribution[r] * roleWinRates[r])) / 100);
    const seatRates = (faction: Faction | null): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const s of SEATS) {
        out[s] = faction === null
          ? rate(get(this.seatWins, s), get(this.seatGames, s))
          : rate(get(this.seatFactionWins, `${s}|${faction}`), get(this.seatFactionGames, `${s}|${faction}`));
      }
      return out;
    };
    const finalWinRate = rate(this.finalWins(), total);
    const blueThreeBlue = this.outcomes('blue', OUTCOME_BLUE_ALIVE) + this.outcomes('blue', OUTCOME_BLUE_DEAD);
    let expected: number | null = null;
    let excess: number | null = null;
    if (roleFinalRates && total) {
      expected = rnd1(sumLtr(ALL_ROLES.map((r) => get(this.roleGames, r) * Number(roleFinalRates[r] ?? 0))) / total);
      excess = rnd1(finalWinRate - expected);
    }
    const rawRoleGames: Record<string, number> = {};
    const roleFinal: Record<string, number> = {};
    const roleOutcomes: Record<string, Record<string, number>> = {};
    for (const r of ALL_ROLES) {
      rawRoleGames[r] = get(this.roleGames, r);
      roleFinal[r] = rate(this.finalWins(r), get(this.roleGames, r));
      roleOutcomes[r] = {};
      for (const o of OUTCOMES) roleOutcomes[r][o] = this.roleOutcomes.get(`${r}|${o}`) ?? 0;
    }
    const roleSeatStats: Record<string, RoleSeatCell> = {};
    for (const [key, [n, w]] of this.roleSeat) roleSeatStats[key] = { games: n, wins: w, winRate: rate(w, n) };
    return {
      name,
      totalGames: total,
      winRate: rate(this.wins, total),
      roleTheory,
      positionTheory: 0,
      redWin: rate(get(this.factionWins, 'red'), redGames),
      blueWin: rate(get(this.factionWins, 'blue'), blueGames),
      red3Red: rate(this.outcomes('red', OUTCOME_THREE_RED), redGames),
      redMerlinDead: rate(this.outcomes('red', OUTCOME_BLUE_DEAD), redGames),
      redMerlinAlive: rate(this.outcomes('red', OUTCOME_BLUE_ALIVE), redGames),
      blue3Red: rate(this.outcomes('blue', OUTCOME_THREE_RED), blueGames),
      blueMerlinDead: rate(this.outcomes('blue', OUTCOME_BLUE_DEAD), blueGames),
      blueMerlinAlive: rate(this.outcomes('blue', OUTCOME_BLUE_ALIVE), blueGames),
      roleWinRates,
      roleDistribution,
      redRoleRate: rate(redGames, total),
      blueRoleRate: rate(blueGames, total),
      seatWinRates: seatRates(null),
      seatRedWinRates: seatRates('red'),
      seatBlueWinRates: seatRates('blue'),
      rawRoleGames,
      rawRedWins: get(this.factionWins, 'red'),
      rawBlueWins: get(this.factionWins, 'blue'),
      rawTotalWins: this.wins,
      rawRedGames: redGames,
      rawBlueGames: blueGames,
      rawRedThreeRed: this.outcomes('red', OUTCOME_THREE_RED),
      rawRedMerlinDead: this.outcomes('red', OUTCOME_BLUE_DEAD),
      rawRedMerlinAlive: this.outcomes('red', OUTCOME_BLUE_ALIVE),
      rawBlueThreeRed: this.outcomes('blue', OUTCOME_THREE_RED),
      rawBlueMerlinDead: this.outcomes('blue', OUTCOME_BLUE_DEAD),
      rawBlueMerlinAlive: this.outcomes('blue', OUTCOME_BLUE_ALIVE),
      roleSeatStats,
      finalWinRate,
      finalRedWinRate: rate(this.outcomes('red', OUTCOME_THREE_RED) + this.outcomes('red', OUTCOME_BLUE_DEAD), redGames),
      finalBlueWinRate: rate(this.outcomes('blue', OUTCOME_BLUE_ALIVE), blueGames),
      missionWinRate: rate(this.wins, total),
      merlinSurvivalRate: rate(this.outcomes('blue', OUTCOME_BLUE_ALIVE), blueThreeBlue),
      rawBlueThreeBlue: blueThreeBlue,
      roleFinalWinRates: roleFinal,
      expectedFinalWinRate: expected,
      excessWinRate: excess,
      firstPlayed: this.firstDate,
      lastPlayed: this.lastDate,
      roleOutcomes,
    };
  }
}

/** generate_cache._player_tallies：每個名字一份，首次出現順序。 */
export function playerTallies(games: readonly Game[]): Map<string, PlayerTally> {
  const tallies = new Map<string, PlayerTally>();
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    SEATS.forEach((seat, s) => {
      const name = g.seatPlayers[s];
      if (!name) return;
      const role = g.seatRoles.get(seat) as string;
      const won = RED_ROLES.has(role) ? g.redWin : g.blueWin;
      let t = tallies.get(name);
      if (!t) {
        t = new PlayerTally();
        tallies.set(name, t);
      }
      t.add(seat, role, g.outcome, won, g.date);
    });
  }
  return tallies;
}

/** overview.roleFinalWinRates：有結果的局、有名字的座位，每個角色的最終勝率。 */
export function computeRoleFinalWinRates(games: readonly Game[]): Record<string, number> {
  const roleGames = new Map<string, number>();
  const roleWins = new Map<string, number>();
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    SEATS.forEach((seat, s) => {
      if (!g.seatPlayers[s]) return;
      const role = g.seatRoles.get(seat) as string;
      inc(roleGames, role);
      inc(roleWins, role, isFinalWin(role, g.outcome) ? 1 : 0);
    });
  }
  const out: Record<string, number> = {};
  for (const r of ALL_ROLES) out[r] = rate(roleWins.get(r) ?? 0, roleGames.get(r) ?? 0);
  return out;
}

/** overview.seatFinalWinRates（鍵 "1".."10"）。 */
export function computeSeatFinalWinRates(games: readonly Game[]): Record<string, number> {
  const seatGames = new Map<string, number>();
  const seatWins = new Map<string, number>();
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    SEATS.forEach((seat, s) => {
      if (!g.seatPlayers[s]) return;
      const role = g.seatRoles.get(seat) as string;
      inc(seatGames, seat);
      inc(seatWins, seat, isFinalWin(role, g.outcome) ? 1 : 0);
    });
  }
  const out: Record<string, number> = {};
  for (const s of SEATS) out[seatLabel(s)] = rate(seatWins.get(s) ?? 0, seatGames.get(s) ?? 0);
  return out;
}

/**
 * overview.roleSeatFinalWinRates（generate_cache.compute_role_seat_final_win_rates）：{角色: {"1".."10": 最終勝率}}；
 * 沒有人玩過的格 = 該角色的族群率。
 */
export function computeRoleSeatFinalWinRates(games: readonly Game[]): Record<string, Record<string, number>> {
  const cellGames = new Map<string, number>();
  const cellWins = new Map<string, number>();
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    SEATS.forEach((seat, s) => {
      if (!g.seatPlayers[s]) return;
      const role = g.seatRoles.get(seat) as string;
      inc(cellGames, `${role}|${seat}`);
      inc(cellWins, `${role}|${seat}`, isFinalWin(role, g.outcome) ? 1 : 0);
    });
  }
  const out: Record<string, Record<string, number>> = {};
  for (const r of ALL_ROLES) {
    let n = 0;
    let w = 0;
    for (const s of SEATS) {
      n += cellGames.get(`${r}|${s}`) ?? 0;
      w += cellWins.get(`${r}|${s}`) ?? 0;
    }
    const roleRate = rate(w, n);
    const row: Record<string, number> = {};
    for (const s of SEATS) {
      const cn = cellGames.get(`${r}|${s}`) ?? 0;
      row[seatLabel(s)] = cn ? rate(cellWins.get(`${r}|${s}`) ?? 0, cn) : roleRate;
    }
    out[r] = row;
  }
  return out;
}

export interface PlayerStatsResult {
  rows: PlayerRow[];
  roleFinalWinRates: Record<string, number>;
  seatFinalWinRates: Record<string, number>;
  roleSeatFinalWinRates: Record<string, Record<string, number>>;
  timelines: Map<string, PlayerSeat[]>;
}

/** generate_cache.compute_player_stats（另外回傳族群率與時間線，給 overview / 排行 / 玩家條件用）。 */
export function computePlayerStats(games: readonly Game[], config: GamesDatasetConfig): PlayerStatsResult {
  const roleFinalWinRates = computeRoleFinalWinRates(games);
  const seatFinalWinRates = computeSeatFinalWinRates(games);
  const roleSeatFinalWinRates = computeRoleSeatFinalWinRates(games);
  const timelines = playerTimelines(games);
  const voting = computePlayerVoting(games);
  const rows: PlayerRow[] = [];
  for (const [name, t] of playerTallies(games)) {
    const row = t.toRow(name, roleFinalWinRates) as PlayerRow;
    row.theory = playerTheory(
      timelines.get(name) ?? [], roleFinalWinRates, seatFinalWinRates, config.leaderboard, roleSeatFinalWinRates,
    );
    row.voting = voting.get(name);
    rows.push(row);
  }
  return { rows: sortByKey(rows, (r) => [-r.totalGames]), roleFinalWinRates, seatFinalWinRates, roleSeatFinalWinRates, timelines };
}

export function emptyOutcome(): OutcomeSplit {
  return { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0, threeRedPct: 0, threeBlueDeadPct: 0, threeBlueAlivePct: 0 };
}

/** generate_cache._outcome_split_counts。 */
export function outcomeSplitCounts(counts: { threeRed: number; threeBlueDead: number; threeBlueAlive: number }): OutcomeSplit {
  const n = counts.threeRed + counts.threeBlueDead + counts.threeBlueAlive;
  if (n === 0) return emptyOutcome();
  return {
    threeRed: counts.threeRed,
    threeBlueDead: counts.threeBlueDead,
    threeBlueAlive: counts.threeBlueAlive,
    threeRedPct: rnd1((counts.threeRed / n) * 100),
    threeBlueDeadPct: rnd1((counts.threeBlueDead / n) * 100),
    threeBlueAlivePct: rnd1((counts.threeBlueAlive / n) * 100),
  };
}

/** generate_cache._outcome_split：一組局的三結果（局數含其他結果的局，所以 % 加起來可能不到 100）。 */
export function outcomeSplit(games: readonly Game[]): OutcomeSplit {
  const n = games.length;
  if (n === 0) return emptyOutcome();
  let red = 0;
  let dead = 0;
  let alive = 0;
  for (const g of games) {
    if (g.outcome === OUTCOME_THREE_RED) red += 1;
    else if (g.outcome === OUTCOME_BLUE_DEAD) dead += 1;
    else if (g.outcome === OUTCOME_BLUE_ALIVE) alive += 1;
  }
  return {
    threeRed: red,
    threeBlueDead: dead,
    threeBlueAlive: alive,
    threeRedPct: rnd1((red / n) * 100),
    threeBlueDeadPct: rnd1((dead / n) * 100),
    threeBlueAlivePct: rnd1((alive / n) * 100),
  };
}

/** generate_cache.compute_seat_outcomes_per_player：每人每個座位（"1".."9","0"）自己的三結果。 */
export function computeSeatOutcomesPerPlayer(
  games: readonly Game[],
  players: readonly Pick<PlayerRow, 'name'>[],
): Map<string, Record<string, OutcomeSplit>> {
  const tallies = new Map<string, Map<string, { threeRed: number; threeBlueDead: number; threeBlueAlive: number }>>();
  for (const g of games) {
    if (!isOutcome(g.outcome)) continue;
    SEATS.forEach((seat, s) => {
      const name = g.seatPlayers[s];
      if (!name) return;
      let perSeat = tallies.get(name);
      if (!perSeat) {
        perSeat = new Map();
        tallies.set(name, perSeat);
      }
      const c = perSeat.get(seat) ?? { threeRed: 0, threeBlueDead: 0, threeBlueAlive: 0 };
      if (g.outcome === OUTCOME_THREE_RED) c.threeRed += 1;
      else if (g.outcome === OUTCOME_BLUE_DEAD) c.threeBlueDead += 1;
      else c.threeBlueAlive += 1;
      perSeat.set(seat, c);
    });
  }
  const out = new Map<string, Record<string, OutcomeSplit>>();
  for (const p of players) {
    const perSeat = tallies.get(p.name);
    const row: Record<string, OutcomeSplit> = {};
    for (const s of SEATS) {
      const c = perSeat?.get(s);
      row[s] = c ? outcomeSplitCounts(c) : emptyOutcome();
    }
    out.set(p.name, row);
  }
  return out;
}
