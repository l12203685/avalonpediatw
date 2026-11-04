/**
 * 以策略為本的投票概似 (b)：「機器人自己的投票策略，坐在 j 的位置、在假設的世界 w 裡」（資訊流研究原型，2026-11-04）。
 *
 * P(j 的票 | w, INFL_t) ≈ 1 − ε（機器人在 j 的座位、w 給的身分與私訊下也這樣投）或 ε（不一樣）。
 * j 在 w 裡的身分：藍 → 忠臣（不分梅林；私訊只有 j 在 w 裡湖到的結果），紅 → 刺客（看得到 w 裡其他的紅；奧伯倫不分）。
 * 有界：只看少數世界（呼叫端給，例如現行後驗的前 K 個），每個 (提議, 座位, 身分, 看得到的隊友, 湖結果) 只算一次。
 * 每次呼叫是一次完整的 `HeuristicAgent.act`（約數毫秒到數十毫秒），所以只適合研究，不適合線上每個世界都跑。
 */
import type { Role } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../types';
import { bitOf, lakeSig, seatViewObs, type Flow } from './flow';

export interface VoteActor {
  onGameStart(obs: PlayerObservation): void;
  act(obs: PlayerObservation): AgentAction;
}

const STANDARD_ROLES: Role[] = ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];

/** j 在世界 w 裡、第 i 次提議投票時的觀察（身分見檔頭）。 */
export function seatObsUnder(flow: Flow, i: number, j: string, w: number): PlayerObservation {
  const base = seatViewObs(flow, i, j, w);
  const red = (w & bitOf(flow, j)) !== 0;
  if (!red) return { ...base, lobbyRoles: STANDARD_ROLES };
  return {
    ...base,
    myRole: 'assassin',
    myTeam: 'evil',
    knownEvils: flow.ids.filter((id) => id !== j && (w & bitOf(flow, id)) !== 0),
    lobbyRoles: STANDARD_ROLES,
  };
}

export class BotVoteOracle {
  private readonly cache = new Map<string, boolean>();
  calls = 0;
  ms = 0;

  constructor(readonly flow: Flow, readonly makeAgent: (id: string) => VoteActor) {}

  /** 機器人在 j 的座位、世界 w 裡會不會贊成第 i 次提議。 */
  approves(i: number, j: string, w: number): boolean {
    const jb = bitOf(this.flow, j);
    const red = (w & jb) !== 0;
    const key = `${i}|${j}|${red ? w & ~jb : -1}|${lakeSig(this.flow, i, j, w)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const t0 = Date.now();
    const agent = this.makeAgent(j);
    const first = seatObsUnder(this.flow, 0, j, w);
    agent.onGameStart({ ...first, gamePhase: 'team_select', proposedTeam: [] });
    const action = agent.act(seatObsUnder(this.flow, i, j, w));
    const yes = action.type === 'team_vote' ? action.vote : this.flow.votes[i].team.includes(j);
    this.ms += Date.now() - t0;
    this.calls++;
    this.cache.set(key, yes);
    return yes;
  }

  /** log P(j 在前 upTo 次提議的票 | w)，ε 依回合段（`eps(round)`）。觀察者自己與強制局不算。 */
  worldLog(viewer: string, upTo: number, w: number, eps: (round: number) => number): number {
    let lp = 0;
    for (let i = 0; i < upTo; i++) {
      const v = this.flow.votes[i];
      if (v.attempt >= 5) continue;
      const e = eps(v.round);
      for (const j of this.flow.ids) {
        if (j === viewer) continue;
        const vote = v.votes[j];
        if (vote === undefined) continue;
        lp += Math.log(this.approves(i, j, w) === vote ? 1 - e : e);
      }
    }
    return lp;
  }
}
