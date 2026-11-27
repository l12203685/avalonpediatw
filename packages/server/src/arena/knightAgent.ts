/**
 * 一位 AI騎士 上桌時的機器人：百科AI 的引擎（HeuristicAgent，含這位騎士的開關）＋ 那位玩家的殘差層（#222，`residual.ts`）。
 *
 * 擂台（`table.ts` 的座位）、練習台、一般房間（`socket/GameServer.ts`）和補位機器人（`scripts/signagePlayer.ts`）都用這一個類別，
 * 所以同一位騎士在哪裡打都是同一套決定（站長 2026-11-27：正式對局以前只套開關、沒有套殘差層）。
 *
 * 殘差層在引擎決定之後重新打分；硬規則照 `ResidualPolicy`：藍方任務一定成功、紅方已拿兩局時任務牌照引擎（A1）、
 * 藍方湖中宣告照實（A0）、刺客不刺已知的紅、隊伍人數與湖中對象一定合法。殘差層算到一半出錯 → 照引擎原本的決定（不讓一桌卡住）。
 *
 * 繼承 HeuristicAgent：伺服器其他地方（`instanceof HeuristicAgent`、`tuning`、`assassinationReadout`、理由說明）照樣能用。
 */
import { HeuristicAgent } from '../ai/HeuristicAgent';
import type { AgentTuning } from '../ai/AgentTuning';
import type { AgentAction, PlayerObservation } from '../ai/types';
import { deriveValidLakeTargets } from '../ai/LakePolicy';
import { ResidualPolicy, type ResidualWeights } from './residual';
import type { ResidualAction } from './profile';

/** 殘差層出錯、退回引擎決定的次數（只記次數）。 */
export const residualFallbackCounter = { errors: 0 };

/** 一個引擎決定經過殘差層之後的決定（擂台與正式對局共用）。 */
export function applyResidualAction(
  r: ResidualPolicy,
  obs: PlayerObservation,
  a: AgentAction,
  off?: ReadonlySet<ResidualAction>,
): AgentAction {
  switch (a.type) {
    case 'team_select': return off?.has('team') ? a : { type: 'team_select', teamIds: r.team(obs, a.teamIds) };
    case 'team_vote': return off?.has('vote') ? a : { type: 'team_vote', vote: r.vote(obs, a.vote) };
    case 'quest_vote': return off?.has('quest') ? a : { type: 'quest_vote', vote: r.questCard(obs, a.vote) };
    case 'assassinate': return off?.has('assassinate') ? a : { type: 'assassinate', targetId: r.assassinate(obs, a.targetId) };
  }
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    residualFallbackCounter.errors++;
    if (residualFallbackCounter.errors <= 5 || residualFallbackCounter.errors % 100 === 0) {
      console.warn(`[knight] residual layer failed (${err instanceof Error ? err.name : typeof err}); engine decision kept (total ${residualFallbackCounter.errors})`);
    }
    return fallback;
  }
}

export class KnightAgent extends HeuristicAgent {
  readonly residualPolicy: ResidualPolicy;
  readonly residualOff: ReadonlySet<ResidualAction>;

  constructor(
    agentId: string,
    tuning: Partial<AgentTuning> | undefined,
    residual: ResidualWeights,
    residualOff?: readonly ResidualAction[],
  ) {
    super(agentId, undefined, undefined, tuning);
    this.residualPolicy = new ResidualPolicy(residual, this.tuning);
    this.residualOff = new Set(residualOff ?? []);
  }

  override act(obs: PlayerObservation): AgentAction {
    const a = super.act(obs);
    return safely(() => applyResidualAction(this.residualPolicy, obs, a, this.residualOff), a);
  }

  override pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    const t = super.pickLakeTarget(obs, validTargets);
    if (this.residualOff.has('lakeTarget')) return t;
    return safely(() => this.residualPolicy.lakeTarget(obs, validTargets ?? deriveValidLakeTargets(obs), t), t);
  }

  override declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    const c = super.declareLake(obs, targetId, trueFaction);
    if (this.residualOff.has('lakeClaim')) return c;
    return safely(() => this.residualPolicy.lakeClaim(obs, targetId, trueFaction, c), c);
  }
}

/** 正式對局要不要套殘差層：環境變數 `KNIGHT_RESIDUAL_LIVE=off` 關掉（只套開關，同 #222 以前）。擂台一律套。 */
export function liveResidualEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KNIGHT_RESIDUAL_LIVE ?? '').trim().toLowerCase() !== 'off';
}

/** 有殘差層 → KnightAgent；沒有 → 一般的 HeuristicAgent（同樣的開關）。 */
export function buildKnightAgent(
  agentId: string,
  tuning: Partial<AgentTuning> | undefined,
  residual: ResidualWeights | undefined | null,
  residualOff?: readonly ResidualAction[],
): HeuristicAgent {
  return residual ? new KnightAgent(agentId, tuning, residual, residualOff) : new HeuristicAgent(agentId, undefined, undefined, tuning);
}
