/**
 * explain — read-only, human-readable reasons for bot decisions
 * (網站「與機器人練習」賽後回顧, 2026-10-13).
 *
 * Every function here is a pure projection of the SAME `PlayerObservation`
 * the bot decided from, plus the action it actually took. Nothing here
 * changes a decision or touches the live agent's memory:
 *
 *   - Suspects come from the public pyramid scores (`computePyramidScores`,
 *     the scorer the agents use) for good bots, and from the public
 *     Merlin-likeness proxy (`estimateMerlinLikenessFromHistory`) for red
 *     bots; assassination adds the ToM Merlin probability (`interpret`).
 *   - "Which rule fired" is read from the agent's own reasoning trace: the
 *     decision is replayed through `ForwardAgent.decide` on a SHADOW baseline
 *     (fresh `HeuristicAgent` with the bot's tuning), so the live agent is
 *     never called twice. The forward pipeline is deterministic, so for its
 *     own decisions the replay reproduces the real choice (checked; a
 *     mismatch is flagged in the text). Delegated decisions (R1–R2 vote rule,
 *     quest-card rule, assassination) only report which path was taken.
 *
 * Text is Traditional Chinese (Taiwan); seat 10 reads「0家」.
 */
import type { AgentAction, AvalonAgent, PlayerObservation } from './types';
import { HeuristicAgent } from './HeuristicAgent';
import { computePyramidScores } from './baseline';
import { ForwardAgent, USE_FORWARD_REASONING, interpret } from './forward';
import { estimateMerlinLikenessFromHistory, estimateSuspicionFromHistory } from './LakePolicy';
import { AVALON_CONFIG } from '@avalon/shared';

export interface ExplainedSuspect {
  seat: number;
  score: number;
}

export interface DecisionExplanation {
  /** One or two sentences. */
  reason: string;
  /** Which rule / decision path fired, when known. */
  rule?: string;
  /** What `suspects` ranks. */
  suspectsLabel?: string;
  suspects: ExplainedSuspect[];
  /** Private knowledge the bot's role gives it. */
  knowledge?: string;
}

const PURPOSE_LABEL: Readonly<Record<string, string>> = {
  threeBlueWins: '三藍',
  threeRedWins: '三紅',
  hideMerlin: '隱藏梅林',
  findMerlin: '找梅林',
  mimicMerlin: '偽裝梅林',
  hidePercival: '隱藏派西',
  hideFromMerlin: '躲梅林',
  avoidFriendlyFire: '不誤傷隊友',
  findGoodTeam: '找好人',
  dontOverPushRed: '不過度排紅',
  forceMerlinKill: '逼出梅林',
};

// ── Seat helpers ────────────────────────────────────────────────

export function seatOfId(obs: PlayerObservation, id: string): number {
  return obs.allPlayerIds.indexOf(id) + 1;
}

function digit(seat: number): string {
  return seat === 10 ? '0' : String(seat);
}

function seatTxt(obs: PlayerObservation, id: string): string {
  return `${digit(seatOfId(obs, id))}家`;
}

/** 「1、4、0家」— seats in table order (seat 10 last). */
export function seatsTxt(obs: PlayerObservation, ids: readonly string[]): string {
  if (ids.length === 0) return '無';
  const seats = ids.map((id) => seatOfId(obs, id)).filter((s) => s > 0).sort((a, b) => a - b);
  return `${seats.map(digit).join('、')}家`;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function questScore(obs: PlayerObservation): { good: number; evil: number } {
  const results = obs.questResults ?? [];
  return {
    good: results.filter((r) => r === 'success').length,
    evil: results.filter((r) => r === 'fail').length,
  };
}

function proposalNumber(obs: PlayerObservation): number {
  return obs.voteHistory.filter((v) => v.round === obs.currentRound).length + 1;
}

// ── Knowledge + suspects ────────────────────────────────────────

/** What the bot's role privately knows, in one line. */
export function describeKnowledge(obs: PlayerObservation): string | undefined {
  const role = obs.myRole as string;
  if (role === 'merlin') return `梅林：看到紅方 ${seatsTxt(obs, obs.knownEvils)}（看不到莫德雷德）`;
  if (role === 'percival') {
    return `派西維爾：看到 ${seatsTxt(obs, obs.knownWizards ?? [])}（梅林與莫甘娜，分不出誰是誰）`;
  }
  if (role === 'loyal') return '忠臣：沒有私有資訊';
  if (role === 'oberon') return '奧伯倫：不認識隊友，隊友也不認識他';
  if (obs.myTeam === 'evil') return `紅方隊友：${seatsTxt(obs, obs.knownEvils)}（看不到奧伯倫）`;
  return undefined;
}

interface Ranked {
  id: string;
  score: number;
}

/** Other seats ranked by public pyramid red-suspicion (high first). */
function rankRedSuspicion(obs: PlayerObservation, among?: readonly string[]): Ranked[] {
  const pyramid = computePyramidScores(obs);
  const ids = (among ?? obs.allPlayerIds).filter((id) => id !== obs.myPlayerId);
  return ids
    .map((id) => ({ id, score: pyramid.scores.get(id) ?? 0.5 }))
    .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
}

/** Opponents (not known allies) ranked by public Merlin-likeness (high first). */
function rankMerlinLike(obs: PlayerObservation, among?: readonly string[]): Ranked[] {
  const allies = new Set(obs.knownEvils);
  const ids = (among ?? obs.allPlayerIds).filter((id) => id !== obs.myPlayerId && !allies.has(id));
  return ids
    .map((id) => ({ id, score: estimateMerlinLikenessFromHistory(id, obs) }))
    .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
}

function toSuspects(obs: PlayerObservation, ranked: Ranked[], n = 3): ExplainedSuspect[] {
  return ranked.slice(0, n).map((r) => ({ seat: seatOfId(obs, r.id), score: Math.round(r.score * 100) / 100 }));
}

function rankedTxt(obs: PlayerObservation, ranked: Ranked[], n = 3): string {
  return ranked.slice(0, n).map((r) => `${seatTxt(obs, r.id)} ${fmt(r.score)}`).join('、') || '無';
}

/** Ranked by the lake policy's public-history suspicion proxy (high first). */
function rankHistorySuspicion(obs: PlayerObservation, among: readonly string[]): Ranked[] {
  return among
    .filter((id) => id !== obs.myPlayerId)
    .map((id) => ({ id, score: estimateSuspicionFromHistory(id, obs) }))
    .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
}

/** Default suspect list for the bot's camp: red-suspicion (good) / Merlin-likeness (red). */
function campSuspects(obs: PlayerObservation): Pick<DecisionExplanation, 'suspects' | 'suspectsLabel'> {
  if (obs.myTeam === 'evil') {
    return { suspectsLabel: '像梅林', suspects: toSuspects(obs, rankMerlinLike(obs)) };
  }
  return { suspectsLabel: '紅方嫌疑', suspects: toSuspects(obs, rankRedSuspicion(obs)) };
}

function questRecordTxt(obs: PlayerObservation, id: string): string {
  let ok = 0;
  let bad = 0;
  for (const q of obs.questHistory) {
    if (!q.team.includes(id)) continue;
    if (q.result === 'success') ok += 1;
    else bad += 1;
  }
  if (ok + bad === 0) return '還沒出過任務';
  return `出過任務（成功 ${ok}、失敗 ${bad}）`;
}

// ── Rule read-back from the agent's own reasoning trace ─────────

interface ReplayResult {
  rule: string;
  /** Pipeline decision whose replay differs from the real action. */
  mismatch: boolean;
}

let forwardRouting: boolean | null = null;

/**
 * Whether `HeuristicAgent.act` actually routes through ForwardAgent here.
 * Mirrors its lazy `require('./forward/ForwardAgent')` (same directory, same
 * relative path): in the compiled server it loads and the flag decides; under
 * vitest the lazy require fails, so the agents play the baseline path and the
 * explanation must say so too.
 */
export function isForwardRoutingActive(): boolean {
  if (forwardRouting !== null) return forwardRouting;
  const flag: unknown = USE_FORWARD_REASONING;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    require('./forward/ForwardAgent');
    forwardRouting = flag === true;
  } catch {
    forwardRouting = false;
  }
  return forwardRouting;
}

function sameAction(a: AgentAction, b: AgentAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'team_select' && b.type === 'team_select') {
    return [...a.teamIds].sort().join('|') === [...b.teamIds].sort().join('|');
  }
  if (a.type === 'team_vote' && b.type === 'team_vote') return a.vote === b.vote;
  if (a.type === 'quest_vote' && b.type === 'quest_vote') return a.vote === b.vote;
  if (a.type === 'assassinate' && b.type === 'assassinate') return a.targetId === b.targetId;
  return false;
}

function topPurposes(purposes: Readonly<Record<string, number>>): string {
  return Object.entries(purposes)
    .filter(([, w]) => w > 0.001)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, w]) => `${PURPOSE_LABEL[k] ?? k} ${Math.round(w * 100)}%`)
    .join('、');
}

/**
 * Replay the decision through `ForwardAgent.decide` on a shadow baseline and
 * describe which path fired. Returns undefined when the agent is not a
 * HeuristicAgent, forward reasoning is off, or anything throws.
 */
export function replayRule(
  obs: PlayerObservation,
  agent: AvalonAgent | undefined,
  real: AgentAction,
  opts: { forwardActive?: boolean } = {},
): ReplayResult | undefined {
  if (!(agent instanceof HeuristicAgent)) return undefined;
  const forwardActive = opts.forwardActive ?? isForwardRoutingActive();
  if (!forwardActive) return { rule: '基準策略（HeuristicAgent；前向推理未啟用）', mismatch: false };
  try {
    const shadow = new HeuristicAgent(obs.myPlayerId, undefined, undefined, { ...agent.tuning });
    const { action, reasoningTrace: trace } = new ForwardAgent(obs.myPlayerId, shadow).decide(obs);
    const desc = trace.chosen.description;
    if (trace.usedFallback) {
      return { rule: `前向推理出錯（${trace.fallbackReason ?? '未知'}），改用基準策略`, mismatch: false };
    }
    if (desc === 'baseline R1-R2 force normal') {
      return { rule: 'R1–R2 只投正常票（在隊上贊成、不在隊上反對）', mismatch: false };
    }
    if (desc.endsWith('on-team approve hard rule')) {
      return { rule: '派西維爾／莫甘娜在隊上一律贊成', mismatch: false };
    }
    if (desc.startsWith('human quest-card rule')) {
      return { rule: '真人任務牌規則（R1 莫甘娜為隊上唯一紅方時出失敗）', mismatch: !sameAction(action, real) };
    }
    if (desc.startsWith('baseline assassinate')) {
      return { rule: '基準刺殺評分（梅林特徵與刺殺模型）', mismatch: false };
    }
    const purposes = topPurposes(trace.purposes as unknown as Record<string, number>);
    return {
      rule: `前向推理：評估 ${trace.candidatesEvaluated} 個選項，取分數最高者（${fmt(trace.chosenScore)}）`
        + (purposes ? `；目標權重 ${purposes}` : ''),
      mismatch: !sameAction(action, real),
    };
  } catch {
    return undefined;
  }
}

function withReplay(base: DecisionExplanation, replay: ReplayResult | undefined): DecisionExplanation {
  if (!replay) return base;
  const rule = replay.mismatch ? `${replay.rule}（重算結果與實際不同，僅供參考）` : replay.rule;
  return { ...base, rule };
}

// ── Per-decision explanations ───────────────────────────────────

export function explainTeamProposal(obs: PlayerObservation, teamIds: readonly string[], agent?: AvalonAgent): DecisionExplanation {
  const parts: string[] = [];
  const attempt = proposalNumber(obs);
  if (attempt > 1) parts.push(`本回合第 ${attempt} 次派隊（前面否決 ${attempt - 1} 次）`);
  parts.push(teamIds.includes(obs.myPlayerId) ? '隊上含自己' : '隊上不含自己');
  const known = new Set(obs.knownEvils);
  const knownOnTeam = teamIds.filter((id) => known.has(id) && id !== obs.myPlayerId);
  if (obs.myTeam === 'evil') {
    if (obs.myRole !== 'oberon') parts.push(`隊上的紅方隊友：${seatsTxt(obs, knownOnTeam)}`);
  } else {
    const ranked = rankRedSuspicion(obs);
    const onTeam = ranked.filter((r) => teamIds.includes(r.id));
    const offTeam = ranked.filter((r) => !teamIds.includes(r.id));
    if (onTeam.length > 0) parts.push(`隊上最可疑 ${seatTxt(obs, onTeam[0].id)} ${fmt(onTeam[0].score)}`);
    if (offTeam.length > 0) parts.push(`沒選的人裡最可疑：${rankedTxt(obs, offTeam, 2)}`);
    if (knownOnTeam.length > 0) parts.push(`注意：隊上有自己知道的紅方 ${seatsTxt(obs, knownOnTeam)}`);
    const wizards = (obs.knownWizards ?? []).filter((id) => teamIds.includes(id));
    if (obs.myRole === 'percival' && wizards.length > 0) parts.push(`帶了梅林／莫甘娜候選 ${seatsTxt(obs, wizards)}`);
  }
  const base: DecisionExplanation = {
    reason: `${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...campSuspects(obs),
  };
  return withReplay(base, replayRule(obs, agent, { type: 'team_select', teamIds: [...teamIds] }));
}

export function explainTeamVote(obs: PlayerObservation, approve: boolean, agent?: AvalonAgent): DecisionExplanation {
  const team = obs.proposedTeam ?? [];
  const onTeam = team.includes(obs.myPlayerId);
  const parts: string[] = [];
  parts.push(`自己${onTeam ? '在' : '不在'}隊上`);
  parts.push(`隊長 ${seatTxt(obs, obs.currentLeader)}，本回合第 ${proposalNumber(obs)} 次派隊（已連續否決 ${obs.failCount} 次）`);
  const known = new Set(obs.knownEvils);
  const knownOnTeam = team.filter((id) => known.has(id) && id !== obs.myPlayerId);
  if (obs.myTeam === 'evil') {
    if (obs.myRole !== 'oberon') parts.push(`隊上的紅方隊友：${seatsTxt(obs, knownOnTeam)}`);
  } else {
    const onTeamRanked = rankRedSuspicion(obs, team);
    if (onTeamRanked.length > 0) parts.push(`隊上最可疑 ${seatTxt(obs, onTeamRanked[0].id)} ${fmt(onTeamRanked[0].score)}`);
    if (knownOnTeam.length > 0) parts.push(`隊上有自己知道的紅方 ${seatsTxt(obs, knownOnTeam)}`);
  }
  const base: DecisionExplanation = {
    reason: `${approve ? '贊成' : '反對'}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...campSuspects(obs),
  };
  return withReplay(base, replayRule(obs, agent, { type: 'team_vote', vote: approve }));
}

export function explainQuestCard(obs: PlayerObservation, card: 'success' | 'fail', agent?: AvalonAgent): DecisionExplanation {
  const score = questScore(obs);
  if (obs.myTeam !== 'evil') {
    return {
      reason: `好人只能出成功（比分 藍 ${score.good}：紅 ${score.evil}）。`,
      rule: '規則：好人只能出成功',
      knowledge: describeKnowledge(obs),
      ...campSuspects(obs),
    };
  }
  const team = obs.proposedTeam ?? [];
  const known = new Set(obs.knownEvils);
  const visible = team.filter((id) => id === obs.myPlayerId || known.has(id));
  const required = AVALON_CONFIG[obs.playerCount]?.questFailsRequired[obs.currentRound - 1] ?? 1;
  const parts = [
    `${card === 'fail' ? '出失敗' : '出成功'}：隊上看得到的紅方 ${visible.length} 人（含自己：${seatsTxt(obs, visible)}）`,
    `本局需要 ${required} 張失敗`,
    `比分 藍 ${score.good}：紅 ${score.evil}`,
  ];
  if (obs.myRole === 'oberon') parts.push('奧伯倫看不到隊友，不知道隊上還有沒有紅方');
  const base: DecisionExplanation = {
    reason: `${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...campSuspects(obs),
  };
  return withReplay(base, replayRule(obs, agent, { type: 'quest_vote', vote: card }));
}

export function explainLakeTarget(obs: PlayerObservation, targetId: string, eligible: readonly string[]): DecisionExplanation {
  const candidates = eligible.filter((id) => id !== obs.myPlayerId);
  const parts: string[] = [`候選 ${candidates.length} 人`];
  parts.push(`${seatTxt(obs, targetId)} ${questRecordTxt(obs, targetId)}`);
  if (obs.myTeam === 'evil') {
    const isAlly = obs.knownEvils.includes(targetId);
    if (isAlly) {
      const allies = rankHistorySuspicion(obs, candidates.filter((id) => obs.knownEvils.includes(id)));
      const pressure = allies.find((r) => r.id === targetId)?.score ?? 0;
      parts.push(`${seatTxt(obs, targetId)} 是紅方隊友（湖隊友可以幫他洗白；任務紀錄嫌疑分 ${fmt(pressure)}）`);
    } else {
      const ranked = rankMerlinLike(obs, candidates);
      const rank = ranked.findIndex((r) => r.id === targetId) + 1;
      const s = ranked.find((r) => r.id === targetId)?.score ?? 0;
      parts.push(`${seatTxt(obs, targetId)} 不是已知隊友，像梅林分數 ${fmt(s)}（候選中第 ${rank || '?'} 高）`);
    }
    const base: DecisionExplanation = {
      reason: `湖 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
      knowledge: describeKnowledge(obs),
      suspectsLabel: '像梅林',
      suspects: toSuspects(obs, rankMerlinLike(obs, candidates)),
    };
    return base;
  }
  const ranked = rankRedSuspicion(obs, candidates);
  const rank = ranked.findIndex((r) => r.id === targetId) + 1;
  const s = ranked.find((r) => r.id === targetId)?.score ?? 0.5;
  parts.push(`金字塔紅方嫌疑 ${fmt(s)}（候選中第 ${rank || '?'} 可疑）`);
  const hist = rankHistorySuspicion(obs, candidates);
  const histRank = hist.findIndex((r) => r.id === targetId) + 1;
  parts.push(`任務／投票紀錄嫌疑分 ${fmt(hist.find((r) => r.id === targetId)?.score ?? 0)}（候選中第 ${histRank || '?'} 高；最高 ${rankedTxt(obs, hist, 2)}）`);
  if (ranked.length > 0) {
    parts.push(`金字塔最可疑：${rankedTxt(obs, ranked, 2)}；最不可疑：${rankedTxt(obs, [...ranked].reverse(), 2)}`);
  }
  const avoid = new Set([...obs.knownEvils, ...(obs.knownWizards ?? [])]);
  if (avoid.has(targetId)) parts.push('注意：目標是自己已知身分的人，這次湖得不到新資訊');
  return {
    reason: `湖 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    suspectsLabel: '紅方嫌疑',
    suspects: toSuspects(obs, ranked),
  };
}

export function explainLakeClaim(
  obs: PlayerObservation,
  targetId: string,
  actual: 'good' | 'evil' | undefined,
  claim: 'good' | 'evil' | null,
): DecisionExplanation {
  const seen = actual === 'good' ? '好人' : actual === 'evil' ? '壞人' : '（未知）';
  const parts: string[] = [];
  if (claim === null) {
    parts.push(`看到 ${seatTxt(obs, targetId)} 是${seen}，不公開結果`);
  } else {
    const truthful = actual !== undefined && claim === actual;
    parts.push(`看到 ${seatTxt(obs, targetId)} 是${seen}，宣告${claim === 'good' ? '好人' : '壞人'}（${truthful ? '說實話' : '說謊'}）`);
  }
  if (obs.myTeam === 'evil' && obs.myRole !== 'oberon') {
    parts.push(obs.knownEvils.includes(targetId) ? '對象是紅方隊友' : '對象不是已知隊友');
  }
  return {
    reason: `${parts.join('；')}。`,
    rule: obs.myTeam === 'good' ? '好人照實宣告' : undefined,
    knowledge: describeKnowledge(obs),
    ...campSuspects(obs),
  };
}

export function explainAssassination(obs: PlayerObservation, targetId: string, agent?: AvalonAgent): DecisionExplanation {
  const evil = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, obs.myPlayerId]);
  const candidates = obs.allPlayerIds.filter((id) => !evil.has(id));
  let tom: Ranked[] = [];
  try {
    const { mindBy } = interpret(obs);
    tom = candidates
      .map((id) => ({ id, score: mindBy.get(id)?.predictedRoleProb.merlin ?? 0 }))
      .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
  } catch {
    tom = [];
  }
  const like = rankMerlinLike(obs, candidates);
  const parts: string[] = [`候選 ${candidates.length} 人（排除紅方）`];
  const tomRank = tom.findIndex((r) => r.id === targetId) + 1;
  if (tom.length > 0) {
    parts.push(`ToM 梅林機率 ${fmt(tom.find((r) => r.id === targetId)?.score ?? 0)}（第 ${tomRank || '?'} 高；前三：${rankedTxt(obs, tom)}）`);
  }
  const likeRank = like.findIndex((r) => r.id === targetId) + 1;
  parts.push(`像梅林分數 ${fmt(like.find((r) => r.id === targetId)?.score ?? 0)}（第 ${likeRank || '?'} 高）`);
  const base: DecisionExplanation = {
    reason: `刺 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    suspectsLabel: tom.length > 0 ? '梅林機率' : '像梅林',
    suspects: toSuspects(obs, tom.length > 0 ? tom : like),
  };
  return withReplay(base, replayRule(obs, agent, { type: 'assassinate', targetId }));
}
