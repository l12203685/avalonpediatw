/**
 * 現行信念的「格子」概似（資訊流研究的對照組，2026-11-04）。
 *
 * - `fitCellTables`：照 `scripts/fitBeliefLikelihoods.ts` 的算法，從一批重播局（訓練折）重新數格子——
 *   票 `陣營|在隊上|隊上有紅|回合段`、派隊 `隊長陣營|回合段|隊上紅數`、任務 `回合|隊上紅數`、紅方湖宣告 `目標陣營`；
 *   機率的平滑與 `BayesBelief.ts` 相同。留出折的評估只用訓練折的格子（沒有洩漏）。
 * - `defaultVoteProb`：現行預設實際讀的票格（`beliefBotTables=1` → 機器人表；`beliefKeyVoteCells` 關鍵局格；
 *   `beliefRedAloneCells` 紅方第 3 局起在隊上分有沒有隊友），用來和真人票比對數概似。
 */
import BOT_TABLE from '../belief/likelihoods_bot.json';
import { campOf, type ReplayGame } from '../benchmark/sheetsReplay';

export interface CellTables {
  vote: Record<string, [number, number]>;
  proposal: Record<string, number>;
  mission: Record<string, number[]>;
  redLake: Record<string, [number, number]>;
}

const bucket = (round: number): string => (round <= 2 ? 'r12' : 'r3');
const smooth = (hit: number, n: number): number => (hit + 1) / (n + 2);

export function fitCellTables(games: readonly ReplayGame[]): CellTables {
  const t: CellTables = { vote: {}, proposal: {}, mission: {}, redLake: {} };
  const bump = (tab: Record<string, [number, number]>, k: string, hit: boolean): void => {
    const v = (tab[k] ??= [0, 0]);
    if (hit) v[0]++;
    v[1]++;
  };
  for (const g of games) {
    const red = (seat: number): boolean => campOf(g.seatRoles[seat - 1]) === 'evil';
    for (const p of g.proposals) {
      const reds = p.teamSeats.filter(red).length;
      if (p.teamSeats.includes(p.leaderSeat)) {
        const k = p.teamSeats.filter((s) => s !== p.leaderSeat && red(s)).length;
        const key = `${red(p.leaderSeat) ? 'evil' : 'good'}|${bucket(p.round)}|${k}`;
        t.proposal[key] = (t.proposal[key] ?? 0) + 1;
      }
      if (p.forced || !p.votesReliable) continue;
      for (let seat = 1; seat <= g.playerCount; seat++) {
        const key = `${red(seat) ? 'evil' : 'good'}|${p.teamSeats.includes(seat) ? 'on' : 'off'}|${reds > 0 ? 'red' : 'clean'}|${bucket(p.round)}`;
        bump(t.vote, key, p.votes[seat - 1]);
      }
    }
    for (const q of g.quests) {
      const key = `${q.round}|${q.teamSeats.filter(red).length}`;
      const dist = (t.mission[key] ??= [0, 0, 0, 0, 0, 0]);
      dist[Math.min(5, q.failCount)]++;
    }
    for (const l of g.lakes) {
      if (!red(l.holderSeat) || l.claim === null) continue;
      bump(t.redLake, red(l.targetSeat) ? 'evil' : 'good', l.claim === 'evil');
    }
  }
  return t;
}

export function cellVoteProb(t: CellTables, red: boolean, on: boolean, hasRed: boolean, round: number, approve: boolean): number {
  const c = t.vote[`${red ? 'evil' : 'good'}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${bucket(round)}`] ?? [1, 2];
  const p = smooth(c[0], c[1]);
  return approve ? p : 1 - p;
}

export function cellProposalProb(t: CellTables, red: boolean, round: number, k: number): number {
  const camp = red ? 'evil' : 'good';
  let total = 0;
  for (let j = 0; j <= 5; j++) total += (t.proposal[`${camp}|${bucket(round)}|${j}`] ?? 0) + 1;
  return ((t.proposal[`${camp}|${bucket(round)}|${k}`] ?? 0) + 1) / total;
}

export function cellMissionProb(t: CellTables, round: number, reds: number, fails: number): number {
  if (fails > reds) return 0;
  const d = t.mission[`${round}|${reds}`];
  if (!d) return fails === reds ? 0.9 : 0.1;
  const n = d.slice(0, reds + 1).reduce((a, b) => a + b + 1, 0);
  return ((d[fails] ?? 0) + 1) / n;
}

export function cellRedLakeProb(t: CellTables, targetRed: boolean): number {
  const c = t.redLake[targetRed ? 'evil' : 'good'] ?? [1, 2];
  return smooth(c[0], c[1]);
}

interface BotTable {
  vote: Record<string, [number, number]>;
  voteKey?: Record<string, [number, number]>;
  voteAlone?: Record<string, [number, number]>;
}
const TB = BOT_TABLE as unknown as BotTable;

/**
 * 現行預設讀一張票的機率（藍方視角、一般座位；不含梅林層與派西的嚴格梅林——那些是另外乘上去的混合）：
 * 機器人表的 `陣營|在隊上|隊上有紅|回合段`；關鍵局（第 3 局起紅方已兩紅）讀 `voteKey`；紅方第 3 局起在隊上讀 `voteAlone`。
 */
export function defaultVoteProb(red: boolean, on: boolean, hasRed: boolean, round: number, keyRound: boolean, redAlone: boolean, approve: boolean): number {
  const camp = red ? 'evil' : 'good';
  let c: [number, number] | undefined;
  if (red && on && round > 2) c = TB.voteAlone?.[`evil|${redAlone ? 'alone' : 'ally'}|${keyRound ? 'key' : 'r3'}`] ?? (keyRound ? TB.voteAlone?.[`evil|${redAlone ? 'alone' : 'ally'}|r3`] : undefined);
  if (!c && keyRound) c = TB.voteKey?.[`${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}`];
  if (!c) c = TB.vote[`${camp}|${on ? 'on' : 'off'}|${hasRed ? 'red' : 'clean'}|${bucket(round)}`] ?? [1, 2];
  const p = smooth(c[0], c[1]);
  return approve ? p : 1 - p;
}
