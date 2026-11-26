/**
 * AI 擂台的一桌：每個座位各自是一隻機器人（profile）或百科AI 本身（profile = null），
 * 同一套自我對打引擎（`SelfPlayEngine`、正式路徑 ForwardAgent）。
 *
 * 可重現：座位洗牌與發角色用 (gameSeed|setup) 的亂數，每個決策用 (gameSeed, 座位, 局面) 的亂數
 * ——和 `scripts/selfPlayStrength.ts` 同一套「共同亂數」。同一個 gameSeed、同樣的座位安排，
 * 換掉一個座位的機器人，其他座位面對同樣的局面會做一樣的決定。
 */
import { HeuristicAgent } from '../ai/HeuristicAgent';
import type { SelfPlayEngine } from '../ai/SelfPlayEngine';
import { seededRandom, withSeededRandom } from '../ai/benchmark/agreement';
import type { AgentAction, AvalonAgent, PlayerObservation } from '../ai/types';
import { deriveValidLakeTargets } from '../ai/LakePolicy';
import { resolveProfileTuning, type ArenaSide, type BotProfile } from './profile';
import { ResidualPolicy } from './residual';

export interface Entrant {
  /** 名冊裡的 id（資料夾名稱；百科AI = `baike`）。 */
  id: string;
  profile: BotProfile | null;
}

export type Outcome = 'threeRed' | 'merlinKilled' | 'threeBlue';

export interface SeatResult {
  entrant: string;
  role: string;
  team: ArenaSide;
  won: boolean;
  /** 這個座位出手刺殺（三藍時）：有沒有刺中梅林。 */
  assassinHit?: boolean;
}

export interface TableResult {
  gameSeed: string;
  playerCount: number;
  winner: ArenaSide;
  outcome: Outcome;
  seats: SeatResult[];
  /** 整局公開紀錄（派隊、投票、任務、湖）的雜湊：兩局打法有沒有不同（`arena:knobs` 用）。 */
  fingerprint: string;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

class ArenaSeat implements AvalonAgent {
  readonly agentType = 'heuristic' as const;
  private inner: HeuristicAgent | null = null;
  /** 官方 AI騎士 的每人殘差層（schema 2 的 `residual`）；沒有 = 照引擎。 */
  private residual: ResidualPolicy | null = null;
  role = '';
  team: ArenaSide = 'good';
  assassinated: string | undefined;
  finalObs: PlayerObservation | null = null;

  constructor(readonly agentId: string, readonly entrant: Entrant, private readonly gameSeed: string) {}

  private seedFor(obs: PlayerObservation, extra = ''): string {
    return [
      this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
      `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`,
      obs.proposedTeam.join(','), extra,
    ].join('|');
  }

  onGameStart(obs: PlayerObservation): void {
    this.role = obs.myRole as string;
    this.team = obs.myTeam === 'evil' ? 'evil' : 'good';
    const tuning = resolveProfileTuning(this.entrant.profile, this.role, this.team);
    this.inner = new HeuristicAgent(this.agentId, undefined, undefined, tuning);
    this.residual = this.entrant.profile?.residual ? new ResidualPolicy(this.entrant.profile.residual, tuning) : null;
    this.inner.onGameStart(obs);
  }

  act(obs: PlayerObservation): AgentAction {
    let a = withSeededRandom(this.seedFor(obs), () => this.inner!.act(obs));
    if (this.residual) a = this.adjust(obs, a);
    if (a.type === 'assassinate') this.assassinated = a.targetId;
    return a;
  }

  /** 殘差層：引擎決定之後重新打分（硬規則在 `ResidualPolicy` 裡）。 */
  private adjust(obs: PlayerObservation, a: AgentAction): AgentAction {
    const r = this.residual!;
    switch (a.type) {
      case 'team_select': return { type: 'team_select', teamIds: r.team(obs, a.teamIds) };
      case 'team_vote': return { type: 'team_vote', vote: r.vote(obs, a.vote) };
      case 'quest_vote': return { type: 'quest_vote', vote: r.questCard(obs, a.vote) };
      case 'assassinate': return { type: 'assassinate', targetId: r.assassinate(obs, a.targetId) };
    }
  }

  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    const t = withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner!.pickLakeTarget(obs, validTargets));
    return this.residual ? this.residual.lakeTarget(obs, validTargets ?? deriveValidLakeTargets(obs), t) : t;
  }

  declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    const c = withSeededRandom(this.seedFor(obs, `claim-${targetId}`), () => this.inner!.declareLake(obs, targetId, trueFaction));
    return this.residual ? this.residual.lakeClaim(obs, targetId, trueFaction, c) : c;
  }

  onGameEnd(obs: PlayerObservation, won: boolean): void {
    this.finalObs = obs;
    this.inner?.onGameEnd(obs, won);
  }
}

/**
 * 打一局。`seats[i]` 是第 i 位加入房間的機器人；實際座位（幾家）由引擎用 setup 亂數洗牌。
 * GameEngine 會把每個事件印到 stdout，呼叫端自己決定要不要靜音（`quietly`）。
 */
export async function playTable(engine: SelfPlayEngine, seats: readonly Entrant[], gameSeed: string): Promise<TableResult> {
  const agents = seats.map((e, i) => new ArenaSeat(`P${i + 1}`, e, gameSeed));
  const originalRandom = Math.random;
  Math.random = seededRandom(`${gameSeed}|setup`);
  let result;
  try {
    result = await engine.runGame(agents, false);
  } finally {
    Math.random = originalRandom;
  }
  const final = agents[0].finalObs;
  const fingerprint = fnv1a(JSON.stringify([final?.voteHistory ?? [], final?.questHistory ?? [], final?.lakeHistory ?? [],
    agents.map((a) => a.assassinated ?? '')]));
  const outcome: Outcome = !result.threeBlue ? 'threeRed' : result.merlinKilled ? 'merlinKilled' : 'threeBlue';
  return {
    gameSeed,
    playerCount: seats.length,
    winner: result.winner,
    outcome,
    fingerprint,
    seats: agents.map((a) => {
      const s: SeatResult = { entrant: a.entrant.id, role: a.role, team: a.team, won: a.team === result.winner };
      if (a.assassinated !== undefined) s.assassinHit = outcome === 'merlinKilled';
      return s;
    }),
  };
}

/** GameEngine 每個事件都印 JSON；跑大量對局時先靜音。 */
/* eslint-disable no-console -- 暫時換掉 console.log 再換回來 */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (): void => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}
/* eslint-enable no-console */
