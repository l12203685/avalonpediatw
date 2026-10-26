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
import { missionFailed } from './missionFacts';
import { ForwardAgent, USE_FORWARD_REASONING, interpret } from './forward';
import { estimateMerlinLikenessFromHistory, estimateSuspicionFromHistory, goodLakeAvoidSet } from './LakePolicy';
import { claimPossibleForGoodHolder, returnLakeOptions } from './belief/Certainty';
import { anyGate, certaintyFor, gateOptionsFrom, teamGateBreach } from './LogicGates';
import { analyzeGoodLake } from './GoodLakeInfo';
import { getDefaultAgentTuning, type AgentTuning } from './AgentTuning';
import { redR1TeamPlanDraws, replayBothDraws, visibleTeammatesOn } from './RedR1Teammate';
import { percivalNoThumbsR1Active, percivalR1ThumbException } from './PercivalThumbs';
import { AVALON_CONFIG } from '@avalon/shared';
import { scoreAssassinCandidates } from './assassin/AssassinModel';
import { adjustedProbabilities, visibleRedEvidence } from './assassin/VisibleRedProposals';

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
    // The public outcome, as the table reads it (the review shows the score, not the cards).
    if (!missionFailed(q)) ok += 1;
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
    // redR1Teammate draws whether an R1 red leader brings a teammate; replay both outcomes.
    if (redR1TeamPlanDraws(obs, shadow.tuning)) {
      const both = replayBothDraws(() => new ForwardAgent(obs.myPlayerId, shadow).decide(obs).action);
      const brought = real.type === 'team_select' && visibleTeammatesOn(obs, real.teamIds) > 0;
      return {
        rule: `紅方首局帶隊友：R1 依真人比例抽籤決定要不要帶一位看得到的隊友（這次${brought ? '帶' : '不帶'}），其餘照前向推理評分`,
        mismatch: !sameAction(both.withTeammate, real) && !sameAction(both.without, real),
      };
    }
    const { action, reasoningTrace: trace } = new ForwardAgent(obs.myPlayerId, shadow).decide(obs);
    const desc = trace.chosen.description;
    if (trace.usedFallback) {
      return { rule: `前向推理出錯（${trace.fallbackReason ?? '未知'}），改用基準策略`, mismatch: false };
    }
    if (obs.gamePhase === 'team_select' && percivalR1ThumbException(shadow.tuning, obs)) {
      return {
        rule: '派西首局不放拇指的例外：先前有一根拇指當隊長時把另一根放進自己的隊，被放的那根（多半是梅林）可以進派西的隊，另一根不放',
        mismatch: !sameAction(action, real),
      };
    }
    if (obs.gamePhase === 'team_select' && percivalNoThumbsR1Active(shadow.tuning, obs)) {
      return {
        rule: '派西首局不放拇指：第一個任務結果出來之前，兩根拇指（梅林／莫甘娜候選）都不放，其餘照前向推理評分',
        mismatch: !sameAction(action, real),
      };
    }
    if (desc.startsWith('logic gate reject')) {
      const why = desc.includes('mustFail')
        ? '依任務失敗張數、自己的視野、湖的結果（好人持湖者說實話），這隊每一種可能的紅方組合都有足夠讓任務失敗的紅'
        : desc.includes('dominated')
          ? '隊上有某人、卻沒有他宣藍的人（湖鏈 A→B→C：選 A 必選 B 必選 C），而且隊上另有人可能是唯一的紅 —— 換成被宣藍的人一定不會更差'
          : '自己在隊上，隊上有自己湖到並宣紅的人，這一局一張失敗就夠';
      return { rule: `邏輯閘門（R3 起、非強制局）：${why} → 反對`, mismatch: !sameAction(action, real) };
    }
    if (desc === 'baseline R1-R2 force normal') {
      return { rule: 'R1–R2 只投正常票（在隊上贊成、不在隊上反對）', mismatch: false };
    }
    if (desc === 'percival both thumbs reject') {
      return {
        rule: '派西兩拇指同隊：梅林與莫甘娜恰好一紅，兩根拇指都在隊上就一定有紅，這一局一張失敗就夠（R3 起、非強制局） → 反對',
        mismatch: !sameAction(action, real),
      };
    }
    if (desc === 'baseline morgana on-team approve hard rule') {
      return { rule: '莫甘娜在隊上一律贊成（紅方規則）', mismatch: false };
    }
    if (desc.endsWith('on-team approve hard rule')) {
      // Only with AgentTuning.percivalLoyalVote off (legacy tuning): the
      // production Percival votes as a loyal since logic-first batch 1E.
      return { rule: '舊版規則（「派西維爾照忠臣投票」關閉時）：派西維爾在隊上一律贊成', mismatch: false };
    }
    if (desc === 'blue vouch follow-up reject') {
      return {
        rule: '持湖者言行一致：自己不在隊上，隊伍漏掉自己（或湖鏈上）宣藍的人、或放了宣紅的人 → 反對',
        mismatch: !sameAction(action, real),
      };
    }
    if (desc === 'red vouch follow-up reject') {
      return {
        rule: '紅方持湖者言行一致：自己不在隊上，隊伍漏掉自己宣藍的人、或放了宣紅的人 → 反對',
        mismatch: !sameAction(action, real),
      };
    }
    if (desc.startsWith('human quest-card rule')) {
      return { rule: '真人任務牌規則（R1 莫甘娜為隊上唯一紅方時出失敗）', mismatch: !sameAction(action, real) };
    }
    if (desc.startsWith('baseline assassinate')) {
      return { rule: '基準刺殺評分（梅林特徵與刺殺模型）', mismatch: false };
    }
    const purposes = topPurposes(trace.purposes as unknown as Record<string, number>);
    // A good leader's team gates (batch 1D): replay with both gates off; when
    // that pick is barred, the gates replaced it (2026-10-26 review).
    if (obs.gamePhase === 'team_select' && obs.myTeam === 'good' && anyGate(gateOptionsFrom(shadow.tuning))) {
      const ungated = new HeuristicAgent(obs.myPlayerId, undefined, undefined, {
        ...shadow.tuning, teamDominanceGate: false, mustFailGate: false,
      });
      const alt = new ForwardAgent(obs.myPlayerId, ungated).decide(obs).action;
      const breach = alt.type === 'team_select'
        ? teamGateBreach(obs, certaintyFor(obs), alt.teamIds, obs.currentRound ?? 1, gateOptionsFrom(shadow.tuning))
        : null;
      if (alt.type === 'team_select' && breach !== null && !sameAction(alt, action)) {
        const why = breach === 'mustFail'
          ? '依任務失敗張數、自己的視野與湖的結果，這隊每一種可能的紅方組合都有足夠讓任務失敗的紅（必敗隊）'
          : '隊上有某人、卻沒有他宣藍的人（湖鏈 A→B→C：選 A 必選 B 必選 C），而且隊上另有人可能是唯一的紅（被支配的隊）';
        return {
          rule: `邏輯閘門（好人隊長）：前向推理原本最高分的隊 ${seatsTxt(obs, alt.teamIds)} ${why} → 不派，改從其餘的隊裡取分數最高者`,
          mismatch: !sameAction(action, real),
        };
      }
    }
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
  // 還湖 (Edward 2026-10-26, `returnLake`): the previous lake declared this holder red and a publicly
  // certain-good seat could be laked — the pick returns the lake (not returning it = 認壞).
  const back = tuning.returnLake ? returnLakeOptions(obs, obs.myPlayerId, candidates) : [];
  if (back.includes(targetId)) {
    return {
      reason: `湖 ${seatTxt(obs, targetId)}：上一個湖宣告自己是紅，${seatsTxt(obs, back)} 照公開紀錄確定是好人，把湖交給其中一位（還湖）。`,
      rule: '還湖：被上一個湖說壞的人，把湖交給確定是好人的玩家；不還湖等於認壞',
      knowledge: describeKnowledge(obs),
      suspects: [],
    };
  }
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
  // The avoid set the pick itself uses (2026-10-26 review): a good holder's is
  // `goodLakeAvoidSet` — Percival's blue lake (`percivalBlueLake`, D4) avoids
  // the known reds only, never the thumbs (Percival cannot tell Merlin from
  // Morgana, so lake a thumb DOES give new information).
  const avoid = obs.myTeam === 'good'
    ? goodLakeAvoidSet(obs, tuning)
    : new Set([...obs.knownEvils, ...(obs.knownWizards ?? [])]);
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
  tuning: AgentTuning = getDefaultAgentTuning(),
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
  // A red holder who declares nothing because both claims would prove it red
  // (batch 1F, `redPossibleClaimsOnly`): say so (2026-10-26 review).
  let rule: string | undefined = obs.myTeam === 'good' ? '好人照實宣告' : undefined;
  if (obs.myTeam === 'evil' && claim === null && tuning.redPossibleClaimsOnly
    && !claimPossibleForGoodHolder(obs, obs.myPlayerId, targetId, 'good')
    && !claimPossibleForGoodHolder(obs, obs.myPlayerId, targetId, 'evil')) {
    rule = '紅方只做可能為真的宣告：照公開紀錄，好人持湖者宣「好人」或「壞人」都不可能，兩種宣告都會證明自己是紅 → 不宣告';
  }
  return {
    reason: `${parts.join('；')}。`,
    rule,
    knowledge: describeKnowledge(obs),
    ...campSuspects(obs),
  };
}

/**
 * The assassination. Since logic-first batch 1G (2026-10-26, practice report
 * (b)) the text states the visible-red tier whenever it applies: the
 * candidates who, as captain on a non-forced proposal, certainly put a red
 * Merlin sees on their team, ranked below everyone who never did
 * (`assassin/VisibleRedProposals.ts`). With the assassination model on, the
 * ranked list is the model's probability (what the pick uses, with the
 * batch-1G likelihood when that switch is on); the ToM Merlin probability
 * stays in the text as a second opinion.
 */
export function explainAssassination(
  obs: PlayerObservation,
  targetId: string,
  agent?: AvalonAgent,
  tuning: AgentTuning = agent instanceof HeuristicAgent ? agent.tuning : getDefaultAgentTuning(),
): DecisionExplanation {
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
  let model: Ranked[] = [];
  if (tuning.assassinModel && candidates.length > 0) {
    const probs = adjustedProbabilities(obs, candidates, scoreAssassinCandidates(obs, candidates), tuning.assassinVisibleRedLikelihood);
    model = candidates
      .map((id) => ({ id, score: probs.get(id) ?? 0 }))
      .sort((a, b) => b.score - a.score || seatOfId(obs, a.id) - seatOfId(obs, b.id));
  }
  const like = rankMerlinLike(obs, candidates);
  const parts: string[] = [`候選 ${candidates.length} 人（排除紅方）`];
  let rule: string | undefined;
  if (tuning.assassinVisibleRedTier && candidates.length > 0) {
    const evidence = visibleRedEvidence(obs, candidates);
    const flagged = candidates.filter((id) => evidence.get(id)?.tier === 1);
    if (flagged.length > 0 && flagged.length < candidates.length) {
      parts.push(
        `${seatsTxt(obs, flagged)}當隊長時把梅林一定看得到的紅（刺殺者自己、奧伯倫，或兩位隊友都在、其中一位一定是莫甘娜）放進自己的隊（第 5 次強制提議也算），`
          + `真人梅林很少這樣派（刺殺時約一成的梅林有過、其他好人約四成），排在其餘 ${candidates.length - flagged.length} 人之後`,
      );
      rule = '刺殺（像真人的規則）：當隊長時確定把梅林看得到的紅放進自己隊的人排在後面，其餘再看分數';
    } else if (flagged.length === candidates.length) {
      parts.push('每位候選當隊長時都曾把梅林一定看得到的紅放進自己的隊，改照分數');
    }
  }
  if (model.length > 0) {
    parts.push(scoreTxt(model, targetId, '刺殺模型機率', '高', 0, `前三：${rankedTxt(obs, model)}`));
  }
  if (tom.length > 0) {
    parts.push(scoreTxt(tom, targetId, 'ToM 梅林機率', '高', 0, `前三：${rankedTxt(obs, tom)}`));
  }
  parts.push(scoreTxt(like, targetId, '像梅林分數', '高', 0));
  const ranked = model.length > 0 ? model : tom.length > 0 ? tom : like;
  const label = model.length > 0 ? '刺殺模型機率' : tom.length > 0 ? '梅林機率' : '像梅林';
  const base: DecisionExplanation = {
    reason: `刺 ${seatTxt(obs, targetId)}：${parts.join('；')}。`,
    knowledge: describeKnowledge(obs),
    ...suspectsOf(obs, label, ranked),
  };
  const replayed = withReplay(base, replayRule(obs, agent, { type: 'assassinate', targetId }));
  return rule ? { ...replayed, rule: replayed.rule ? `${rule}（${replayed.rule}）` : rule } : replayed;
}
