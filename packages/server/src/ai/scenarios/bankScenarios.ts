/**
 * 情境題庫：每日一題題庫的題目（第 74 回合）。
 *
 * 每日一題（Threads／模擬瓦）每天從實戰題庫 `sim_bank.json` 出一題；這裡把題庫裡**每一個**會出的題目都變成一題情境，
 * 答案用事後的真實角色對（跟每日一題公布答案時用的一樣）：
 *   - 尾派（1-5、2-5、3-5、4-5）、第四局忠臣派 5 人、第五局：派出去的隊紅不夠讓任務失敗（第 4 局紅少於 2 個，其他局全藍）；
 *   - 派西維爾：兩根拇指裡把梅林當成比較像藍的那一根（P(紅) 比較低），另外一類看他的隊有沒有帶莫甘娜；
 *   - 刺殺：刺中梅林。
 * 只收藍方視角（忠臣、派西、梅林）和刺客的刺殺題，跟選局頁的候選一樣。真人當時怎麼做一起記下來，當對照。
 * 選題的池子直接用 `bots/threads/plan.buildCandidates`（只讀，不改那邊的程式）。
 */
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import type { SimBank } from '../../bots/simulation/bank';
import type { SimGame } from '../../bots/simulation/scenario';
import { buildCandidates, exerciseIdOfPick, type PoolName, type ThreadsPick } from '../../bots/threads/plan';
import type { DecisionPoint } from '../benchmark/replayObservation';
import { EVIL_ROLES, type ReplayGame } from '../benchmark/sheetsReplay';
import { seatChar, type ScenarioCheck, type ScenarioFixture } from './scenarioSuite';

/** 題庫題目的類別（報告的列）。 */
export const BANK_CLASSES = {
  'tail1': '每日一題：1-5 尾派（派出全藍的隊）',
  'tail2': '每日一題：2-5 尾派（派出全藍的隊）',
  'tail3': '每日一題：3-5 尾派（派出全藍的隊）',
  'tail4': '每日一題：4-5 尾派（隊上的紅少於 2 個）',
  'round4': '每日一題：第四局忠臣派 5 人（隊上的紅少於 2 個）',
  'final': '每日一題：第五局（派出全藍的隊）',
  'thumb': '每日一題：派西認拇指（把梅林當成比較像藍的那一根）',
  'percTeam': '每日一題：派西的隊不帶莫甘娜',
  'kill': '每日一題：刺殺（刺中梅林）',
} as const;
export type BankClass = keyof typeof BANK_CLASSES;

export interface BankScenario {
  fixture: ScenarioFixture;
  game: ReplayGame;
  point: DecisionPoint;
  seat: number;
  /** 真人當時的答案過不過同一條檢查（派西認拇指沒有真人的答案：null）。 */
  humanPass: boolean | null;
  /** 真人當時做了什麼（一句話）。 */
  humanText: string;
}

const isRed = (r: Role): boolean => EVIL_ROLES.has(r);
const asReplay = (g: SimGame): ReplayGame => ({ ...g, names: Array.from({ length: g.playerCount }, () => '') });
const teamTxt = (seats: readonly number[]): string => [...seats].sort((a, b) => a - b).map(seatChar).join('');

function teamClass(pool: PoolName, pick: ThreadsPick): BankClass | null {
  if (pick.kind === 'final') return 'final';
  if (pick.kind === 'round4') return 'round4';
  if (pick.kind === 'tail') return pick.round === 1 ? 'tail1' : pick.round === 2 ? 'tail2' : pick.round === 3 ? 'tail3' : pick.round === 4 ? 'tail4' : null;
  return null;
}

/**
 * 題庫裡全部會出的題目（題號不重複）。`only` 給了就只留那幾類。
 */
export function bankScenarios(bank: Pick<SimBank, 'games'>, only?: ReadonlySet<BankClass>): BankScenario[] {
  const byId = new Map<string, SimGame>(bank.games.map((g) => [g.id, g]));
  const pools = buildCandidates({ games: bank.games });
  const out: BankScenario[] = [];
  const seen = new Set<string>();
  const add = (cls: BankClass, pick: ThreadsPick, expect: ScenarioCheck[], humanPass: boolean | null, humanText: string, title: string): void => {
    if (only && !only.has(cls)) return;
    const g = byId.get(pick.gameId);
    if (!g) return;
    const ex = exerciseIdOfPick(pick, g);
    const id = `${cls}:${ex}`;
    if (seen.has(id)) return;
    seen.add(id);
    const point: DecisionPoint = pick.proposal === null ? { kind: 'assassination' } : { kind: 'team_select', proposal: pick.proposal };
    out.push({
      fixture: { id, cls: `bank:${cls}`, title, source: `每日一題題庫 ${ex}（sim_bank.json，實戰局）`, bank: ex, expect },
      game: asReplay(g),
      point,
      seat: pick.seat,
      humanPass,
      humanText,
    });
  };
  (Object.keys(pools) as PoolName[]).forEach((pool) => {
    for (const cand of pools[pool]) {
      for (const pick of cand.picks) {
        const g = byId.get(pick.gameId);
        if (!g) continue;
        const role = g.seatRoles[pick.seat - 1];
        const redsOf = (seats: readonly number[]): number => seats.filter((s) => isRed(g.seatRoles[s - 1])).length;
        if (pick.proposal === null) {
          const merlin = g.seatRoles.indexOf('merlin') + 1;
          const real = g.assassinTargetSeat ?? 0;
          add('kill', pick, [{ hitsMerlin: true }], real === merlin, `真人刺 ${seatChar(real)} 家`, `三藍，${seatChar(pick.seat)} 家刺客要找梅林`);
          continue;
        }
        const p = g.proposals[pick.proposal];
        const need = AVALON_CONFIG[g.playerCount]?.questFailsRequired[p.round - 1] ?? 1;
        const where = `第 ${p.round} 局第 ${p.attempt} 次${p.attempt === 5 ? '（強制出發）' : ''}`;
        if (pick.kind === 'percival') {
          if (role !== 'percival') continue;
          const merlin = g.seatRoles.indexOf('merlin') + 1;
          const morgana = g.seatRoles.indexOf('morgana') + 1;
          if (merlin < 1 || morgana < 1) continue;
          add('thumb', pick, [{ pRedBelow: [seatChar(merlin), seatChar(morgana)] }], null, '', `${where}，${seatChar(pick.seat)} 家派西：兩根拇指（${teamTxt([merlin, morgana])}）哪一根是梅林`);
          add('percTeam', pick, [{ teamLacks: seatChar(morgana) }], !p.teamSeats.includes(morgana), `真人派 ${teamTxt(p.teamSeats)}`, `${where}，${seatChar(pick.seat)} 家派西派隊`);
          continue;
        }
        const cls = teamClass(pool, pick);
        if (!cls) continue;
        if (role !== 'loyal' && role !== 'percival' && role !== 'merlin') continue;
        add(cls, pick, [{ teamRedsMax: need - 1 }], redsOf(p.teamSeats) <= need - 1, `真人派 ${teamTxt(p.teamSeats)}`, `${where}，${seatChar(pick.seat)} 家${role === 'merlin' ? '梅林' : role === 'percival' ? '派西' : '忠臣'}派隊`);
      }
    }
  });
  return out;
}
