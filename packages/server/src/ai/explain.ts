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
import { analyzeGoodLake } from './GoodLakeInfo';
import { getDefaultAgentTuning, type AgentTuning } from './AgentTuning';
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
  /** Shown instead of an empty `suspects` list (「尚無區分（全員 0.50）」), or after it when ties decide the order. */
  suspectsNote?: string;
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

/** Equal as displayed (two decimals) — what the reader sees as a tie. */
function same(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Two or more seats and every score equal — a ranking would only be seat order. */
function allTied(ranked: readonly Ranked[]): boolean {
  return ranked.length > 1 && ranked.every((r) => same(r.score, ranked[0].score));
}

function noSpreadTxt(ranked: readonly Ranked[]): string {
  return `尚無區分（全員 ${fmt(ranked[0].score)}）`;
}

function toSuspects(obs: PlayerObservation, ranked: Ranked[], n = 3): ExplainedSuspect[] {
  if (allTied(ranked)) return [];
  return ranked.slice(0, n).map((r) => ({ seat: seatOfId(obs, r.id), score: Math.round(r.score * 100) / 100 }));
}

/** How many seats past the first `n` share the n-th score (a tie the cut hides). */
function hiddenTies(ranked: readonly Ranked[], n: number): number {
  if (ranked.length <= n || n <= 0) return 0;
  const edge = ranked[n - 1].score;
  return ranked.slice(n).filter((r) => same(r.score, edge)).length;
}

/** Note for a top-`n` list whose order is partly seat order (ties). */
function tieNote(ranked: readonly Ranked[], n: number): string | undefined {
  const hidden = hiddenTies(ranked, n);
  if (hidden > 0) return `另有 ${hidden} 人同為 ${fmt(ranked[n - 1].score)}，依座位順序只列前 ${n} 位`;
  const top = ranked.slice(0, n);
  const tiedInside = top.some((r, i) => i > 0 && same(r.score, top[i - 1].score));
  return tiedInside ? '同分者依座位順序' : undefined;
}

/** `suspects` + `suspectsNote` for one ranking (no list when every score ties). */
function suspectsOf(
  obs: PlayerObservation,
  label: string,
  ranked: Ranked[],
): Pick<DecisionExplanation, 'suspects' | 'suspectsLabel' | 'suspectsNote'> {
  if (allTied(ranked)) return { suspectsLabel: label, suspects: [], suspectsNote: noSpreadTxt(ranked) };
  const note = tieNote(ranked, 3);
  return { suspectsLabel: label, suspects: toSuspects(obs, ranked), ...(note ? { suspectsNote: note } : {}) };
}

function rankedTxt(obs: PlayerObservation, ranked: Ranked[], n = 3): string {
  if (allTied(ranked)) return noSpreadTxt(ranked);
  const list = ranked.slice(0, n).map((r) => `${seatTxt(obs, r.id)} ${fmt(r.score)}`).join('、') || '無';
  const hidden = hiddenTies(ranked, n);
  return hidden > 0 ? `${list}（另有 ${hidden} 人同分）` : list;
}

/** 「隊上最可疑 4家 0.70」, or「隊上最可疑：尚無區分（全員 0.50）」when nobody stands out. */
function topTxt(obs: PlayerObservation, label: string, ranked: Ranked[]): string {
  if (allTied(ranked)) return `${label}：${noSpreadTxt(ranked)}`;
  const hidden = hiddenTies(ranked, 1);
  return `${label} ${seatTxt(obs, ranked[0].id)} ${fmt(ranked[0].score)}${hidden > 0 ? `（另有 ${hidden} 人同分）` : ''}`;
}

/**
 * Where `id` stands in `ranked` (high first), with ties counted honestly:
 * 「候選中第 2 高」「候選中第 2 高，與 3 人同分」「候選全員同分」.
 */
function rankTxt(ranked: readonly Ranked[], id: string, word: string): string {
  const me = ranked.find((r) => r.id === id);
  if (!me) return '不在候選中';
  if (allTied(ranked)) return '候選全員同分';
  const rank = 1 + ranked.filter((r) => r.score > me.score && !same(r.score, me.score)).length;
  const ties = ranked.filter((r) => r.id !== id && same(r.score, me.score)).length;
  return `候選中第 ${rank} ${word}${ties > 0 ? `，與 ${ties} 人同分` : ''}`;
}

function scoreOf(ranked: readonly Ranked[], id: string, fallback: number): number {
  return ranked.find((r) => r.id === id)?.score ?? fallback;
}

/**
 * 「像梅林分數 0.40（候選中第 2 高；前三：…）」, or「像梅林分數：尚無區分（全員 0.00）」
 * when every candidate ties.
 */
function scoreTxt(
  ranked: readonly Ranked[],
  id: string,
  label: string,
  word: string,
  fallback: number,
  extra?: string,
): string {
  if (allTied(ranked)) return `${label}：${noSpreadTxt(ranked)}`;
  return `${label} ${fmt(scoreOf(ranked, id, fallback))}（${rankTxt(ranked, id, word)}${extra ? `；${extra}` : ''}）`;
}

/** Ranked by the lake policy's public-history suspicion proxy (high first). */
function rankHistorySuspicion(obs: PlayerObservation, among: readonly string[]): Ranked[] {
  return among
    .filter((id) => id !== obs.myPlayerId)
    .map((id) => ({ id, score: estimateSuspicionFromHistory(id, obs) }))
    .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
}

/** Oberon is red but sees nobody: no allies to exclude, no Merlin hunt to report. */
function isOberon(obs: PlayerObservation): boolean {
  return (obs.myRole as string) === 'oberon';
}

/**
 * Default suspect list for the bot's camp: red-suspicion (good) /
 * Merlin-likeness (red). Oberon knows no ally, so a Merlin-likeness list
 * would include his own teammates; he gets the public red-suspicion view.
 */
function campSuspects(obs: PlayerObservation): Pick<DecisionExplanation, 'suspects' | 'suspectsLabel' | 'suspectsNote'> {
  if (obs.myTeam === 'evil' && !isOberon(obs)) return suspectsOf(obs, '像梅林', rankMerlinLike(obs));
  if (isOberon(obs)) return suspectsOf(obs, '紅方嫌疑（公開紀錄）', rankRedSuspicion(obs));
  return suspectsOf(obs, '紅方嫌疑', rankRedSuspicion(obs));
}

const OBERON_NOTE = '奧伯倫不認識隊友，只能看公開紀錄';

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
  if (obs.myTeam === 'evil' && !isOberon(obs)) {
    parts.push(`隊上的紅方隊友：${seatsTxt(obs, knownOnTeam)}`);
  } else {
    if (isOberon(obs)) parts.push(OBERON_NOTE);
    const ranked = rankRedSuspicion(obs);
    const onTeam = ranked.filter((r) => teamIds.includes(r.id));
    const offTeam = ranked.filter((r) => !teamIds.includes(r.id));
    if (onTeam.length > 0) parts.push(topTxt(obs, '隊上最可疑', onTeam));
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
  if (obs.myTeam === 'evil' && !isOberon(obs)) {
    parts.push(`隊上的紅方隊友：${seatsTxt(obs, knownOnTeam)}`);
  } else {
    if (isOberon(obs)) parts.push(OBERON_NOTE);
    const onTeamRanked = rankRedSuspicion(obs, team);
    if (onTeamRanked.length > 0) parts.push(topTxt(obs, '隊上最可疑', onTeamRanked));
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
      rule: '好人只能出成功',
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

/**
 * The `goodLakeInfoMax` numbers for one pick: expected drop of the blues'
 * common uncertainty, the holder's P(red), the trust-chain term and the
 * model's top three. `null` when the model has no consistent world (the
 * policy then fell back to the older rule).
 */
function explainGoodLakeInfo(
  obs: PlayerObservation,
  targetId: string,
  candidates: readonly string[],
): { parts: string[]; redRanked: Ranked[] } | null {
  const analysis = analyzeGoodLake(obs, candidates);
  const me = analysis?.candidates.find((c) => c.id === targetId);
  if (!analysis || !me) return null;
  const byScore = [...analysis.candidates].sort(
    (a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id),
  );
  const bestGain = Math.max(...analysis.candidates.map((c) => c.infoGain));
  const parts = [
    `湖下去後藍方共同資訊預期增加 ${fmt(me.infoGain)} bits（候選最高 ${fmt(bestGain)}）`,
    `我看他是紅方的機率 ${Math.round(me.pEvil * 100)}%`,
    analysis.trustWeight > 0
      ? `之後還有湖、紅方還沒拿兩局 → 加信任鏈分 ${fmt(me.trust)}（湖到好人就多一位可信的持湖者）`
      : '紅方已拿兩局或這是最後一次湖 → 不加信任鏈分，只看資訊量',
    `模型總分前三：${byScore.slice(0, 3).map((c) => `${seatTxt(obs, c.id)} ${fmt(c.score)}`).join('、')}`,
  ];
  if (analysis.droppedLakes) parts.push('先前的湖宣告彼此矛盾，這次計算沒有採用它們');
  const redRanked = analysis.candidates
    .map((c) => ({ id: c.id, score: c.pEvil }))
    .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
  return { parts, redRanked };
}

export function explainLakeTarget(
  obs: PlayerObservation,
  targetId: string,
  eligible: readonly string[],
  tuning: AgentTuning = getDefaultAgentTuning(),
): DecisionExplanation {
  const candidates = eligible.filter((id) => id !== obs.myPlayerId);
  const parts: string[] = [`候選 ${candidates.length} 人`];
  parts.push(`${seatTxt(obs, targetId)} ${questRecordTxt(obs, targetId)}`);
  if (obs.myTeam === 'evil' && !isOberon(obs)) {
    const isAlly = obs.knownEvils.includes(targetId);
    if (isAlly) {
      const allies = rankHistorySuspicion(obs, candidates.filter((id) => obs.knownEvils.includes(id)));
      const pressure = scoreOf(allies, targetId, 0);
      parts.push(`${seatTxt(obs, targetId)} 是紅方隊友（湖隊友可以幫他洗白；任務紀錄嫌疑分 ${fmt(pressure)}）`);
    } else {
      const ranked = rankMerlinLike(obs, candidates);
      parts.push(`${seatTxt(obs, targetId)} 不是已知隊友，${scoreTxt(ranked, targetId, '像梅林分數', '高', 0)}`);
    }
    return {
      reason: `湖 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
      knowledge: describeKnowledge(obs),
      ...suspectsOf(obs, '像梅林', rankMerlinLike(obs, candidates)),
    };
  }
  if (isOberon(obs)) parts.push(OBERON_NOTE);
  const avoid = new Set([...obs.knownEvils, ...(obs.knownWizards ?? [])]);
  // A good holder under `goodLakeInfoMax` (2026-10-13 default) picks with
  // GoodLakeInfo.ts — show that model's numbers, not a proxy score.
  if (obs.myTeam === 'good' && tuning.goodLakeInfoMax && !avoid.has(targetId)) {
    const model = explainGoodLakeInfo(obs, targetId, candidates.filter((id) => !avoid.has(id)));
    if (model) {
      return {
        reason: `湖 ${seatTxt(obs, targetId)}：${[...parts, ...model.parts].join('；')}。`,
        rule: '好人湖：共同資訊極大化',
        knowledge: describeKnowledge(obs),
        suspects: toSuspects(obs, model.redRanked),
        suspectsLabel: '紅方機率（持湖者看法）',
        suspectsNote: tieNote(model.redRanked, 3),
      };
    }
  }
  // Both public scores are shown; neither is claimed to be the one the lake
  // policy used (the good / Oberon lake rule may change between versions).
  const ranked = rankRedSuspicion(obs, candidates);
  parts.push(scoreTxt(ranked, targetId, '金字塔紅方嫌疑', '可疑', 0.5));
  const hist = rankHistorySuspicion(obs, candidates);
  parts.push(scoreTxt(hist, targetId, '任務／投票紀錄嫌疑分', '高', 0, `最高 ${rankedTxt(obs, hist, 2)}`));
  if (ranked.length > 0 && !allTied(ranked)) {
    parts.push(`金字塔最可疑：${rankedTxt(obs, ranked, 2)}；最不可疑：${rankedTxt(obs, [...ranked].reverse(), 2)}`);
  }
  if (avoid.has(targetId)) parts.push('注意：目標是自己已知身分的人，這次湖得不到新資訊');
  return {
    reason: `湖 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...suspectsOf(obs, isOberon(obs) ? '紅方嫌疑（公開紀錄）' : '紅方嫌疑', ranked),
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
  if (obs.myTeam === 'evil' && !isOberon(obs)) {
    parts.push(obs.knownEvils.includes(targetId) ? '對象是紅方隊友' : '對象不是已知隊友');
  } else if (isOberon(obs)) {
    parts.push('奧伯倫不認識隊友，看到紅方也不知道是誰');
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
  if (tom.length > 0) {
    parts.push(scoreTxt(tom, targetId, 'ToM 梅林機率', '高', 0, `前三：${rankedTxt(obs, tom)}`));
  }
  parts.push(scoreTxt(like, targetId, '像梅林分數', '高', 0));
  const base: DecisionExplanation = {
    reason: `刺 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...suspectsOf(obs, tom.length > 0 ? '梅林機率' : '像梅林', tom.length > 0 ? tom : like),
  };
  return withReplay(base, replayRule(obs, agent, { type: 'assassinate', targetId }));
}
