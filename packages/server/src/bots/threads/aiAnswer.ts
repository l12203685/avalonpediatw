/**
 * Threads 每日一題的「百科AI 答案」（2026-11-18）— 只給站長看，不進貼文、不進 threads-state。
 *
 * 站長 11/18：「每日一題 我希望 你先讓百科AI去跑個答案出來給我 我順便可以修正百科AI的思考和盲點」。
 *
 * 做法：用牌譜把題目那一家在出題那一刻的觀察重建出來（aiRead.decisionObservation → buildReplayObservation，只放那一家
 * 當下看得到的資訊，大廳角色不照座位），交給正式的百科AI（ForwardAgent 包 HeuristicAgent，DEFAULT_AGENT_TUNING），問它會怎麼做：
 *   - pick：它會派的隊（或刺殺的目標）；
 *   - top：派隊題＝每一種同人數的隊在它的貝氏信念下「隊上沒有紅」（第 4 局要 2 張失敗：紅少於 2 人）的機率，前 5 名；
 *          刺殺題＝它刺殺排序用的分數（模型＋投票＋派隊＋重派讀法）換算成機率，照它真的排序（先看分層，再看分數）；
 *          前向推理內部只公開選中那個的分數（pick.forwardScore），所以派隊題的 top 不是它的內部排序，是它的信念。
 *   - belief：每一家的 P(紅)（派隊題）或 P(梅林)（刺殺題）；
 *   - reasons：只放真的從決策用到的欄位算出來的句子（每句標來源）：角色資訊、決策路徑（前向推理的軌跡／explain 的規則）、
 *     網站賽後回顧的說明、公開事實（任務、湖、拇指）、信念驅動（拿掉一類證據重算的變化——這是推算，不是百科AI 自己的說明）；
 *   - real：真人那一手和結果；hindsight：看了角色之後兩邊的隊上各有誰是紅、刺到的是不是梅林；
 *   - policy：機器人、參數的指紋、git SHA、種子。
 * 同一題、同一個種子結果一樣（Math.random 換成固定種子；預設種子跟模擬瓦 /區間 一樣，所以兩邊的派法一致）。
 */

import { createHash } from 'crypto';
import type { Role } from '@avalon/shared';
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../../ai/types';
import { combinations } from '../../ai/worlds';
import { withSeededRandom } from '../../ai/benchmark/agreement';
import { seatId, seatOfId, type DecisionPoint } from '../../ai/benchmark/replayObservation';
import { DEFAULT_AGENT_TUNING } from '../../ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamRedsBelow, bayesWorlds } from '../../ai/belief/BayesBelief';
import { describeKnowledge, explainAssassination, explainTeamProposal, isForwardRoutingActive, replayRule } from '../../ai/explain';
import type { AssassinScoreTerms } from '../../ai/HeuristicAgent';
import { decisionObservation, defaultBot } from '../simulation/aiRead';
import { ROLE_ZH } from '../simulation/commands';
import { assassinSeat, firstDecision, isRed, splitExerciseId, stageDecision, type SimGame } from '../simulation/scenario';
import { seatChar, teamDigits } from '../simulation/seats';

/** 輸出格式的版本（欄位改了就加一）。 */
export const AI_ANSWER_SCHEMA = 1;
/** 前 N 名的隊／目標。 */
export const AI_ANSWER_TOP = 5;

export interface AiAnswerSeatP {
  seat: number;
  p: number;
}

export interface AiAnswerOption {
  /** 隊（座位遞增）；刺殺題是一個座位。 */
  seats: number[];
  /** 見 `top.metric`。 */
  p: number;
  /** 百科AI 選的那一個。 */
  chosen: boolean;
  /** 真人選的那一個。 */
  real: boolean;
  /** 刺殺題：在百科AI 的前排（分層）裡；不在前排的人分數再高也不會被刺。 */
  front?: boolean;
  /** 刺殺題：分數的組成（log 分數）。 */
  terms?: AssassinScoreTerms;
}

export type AiAnswerReasonSource = 'knowledge' | 'rule' | 'trace' | 'review' | 'facts' | 'terms' | 'driver';

export interface AiAnswerReason {
  source: AiAnswerReasonSource;
  /** 來源的中文名稱。 */
  label: string;
  text: string;
}

export interface ThreadsAiAnswer {
  schema: number;
  exerciseId: string;
  gameId: string;
  decision: {
    kind: 'team' | 'assassination';
    round: number;
    /** 第幾次派票（刺殺題 null）。 */
    attempt: number | null;
    teamSize: number | null;
    /** 這一局要幾張失敗任務才會失敗。 */
    failsRequired: number | null;
    /** 第 5 次派票（強制出發）。 */
    forced: boolean;
  };
  viewer: { seat: number; role: Role; roleZh: string; knowledge: string | null };
  pick: {
    seats: number[];
    text: string;
    /** 這個隊／目標在 `top.metric` 下的機率。 */
    p: number | null;
    /** 在全部選項裡的名次（1 = 最高；同分算同名次）。 */
    rank: number | null;
    /** 前向推理選中的分數（只有派隊題、走前向推理時有）。 */
    forwardScore: number | null;
  };
  top: { metric: string; options: number; items: AiAnswerOption[]; /** 第 N 名同分、沒列出來的還有幾個。 */ tiedBeyond: number };
  belief: { metric: 'P(red)' | 'P(merlin)'; note: string; seats: AiAnswerSeatP[]; topWorlds?: { seats: number[]; p: number }[] };
  reasons: AiAnswerReason[];
  real: {
    seats: number[];
    text: string;
    sameAsAi: boolean;
    /** 真人那一手在 `top.metric` 下的機率、名次。 */
    p: number | null;
    rank: number | null;
    /** 派隊題：這隊有沒有出任務（強制的一定出）；贊成票數（強制的 null）。 */
    approved?: boolean;
    approveCount?: number | null;
    mission?: { failCount: number; failed: boolean } | null;
    /** 刺殺題：刺中梅林了嗎。 */
    hit?: boolean;
    outcome: string;
  };
  /** 看了角色之後（事後）：兩邊的隊上有誰是紅、梅林是誰。 */
  hindsight: { aiPickReds: number[]; realPickReds: number[]; merlinSeat?: number; aiHit?: boolean; text: string };
  policy: {
    agent: string;
    tuning: 'DEFAULT_AGENT_TUNING';
    tuningHash: string;
    gitSha: string | null;
    gitDirty?: boolean;
    /** HeuristicAgent 內部轉給前向推理的開關（正式伺服器是 true；vitest 下 lazy require 失敗是 false）。 */
    forwardRouting: boolean;
    seed: string;
  };
}

/** 題目：哪一局、哪一次派票（刺殺題 null）、誰的視角。ThreadsPick 直接可以用。 */
export interface AiAnswerTarget {
  gameId: string;
  proposal: number | null;
  seat: number;
}

export interface AiAnswerOptions {
  exerciseId?: string;
  /** 種子；不給＝跟模擬瓦 /區間 一樣（派隊：`<局>|<座位>|team-<次>`；刺殺：`<局>|<座位>|assassinate`）。 */
  seed?: string;
  gitSha?: string | null;
  gitDirty?: boolean;
}

// ─── 小工具 ───────────────────────────────────────────────────────────────

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const seatTxt = (s: number): string => `${seatChar(s)}家`;
const seatsTxt = (seats: readonly number[]): string => (seats.length ? `${seats.map(seatChar).join('、')}家` : '無');
const sorted = (seats: Iterable<number>): number[] => [...seats].sort((a, b) => a - b);
const key = (seats: readonly number[]): string => sorted(seats).join(',');

/** DEFAULT_AGENT_TUNING 的指紋（鍵排好的 JSON 的 sha1 前 10 碼）。 */
export function tuningHash(): string {
  const t = DEFAULT_AGENT_TUNING as unknown as Record<string, unknown>;
  const body = JSON.stringify(Object.keys(t).sort().map((k) => [k, t[k]]));
  return createHash('sha1').update(body).digest('hex').slice(0, 10);
}

/** 名次（1 = 最高；跟它同分的不算在前面）。 */
function rankOf(all: readonly number[], p: number): number {
  return 1 + all.filter((x) => r3(x) > r3(p)).length;
}

// ─── 題號 → 題目 ─────────────────────────────────────────────────────────

/** 題號（K7Q2M-3-5、K7Q2M-A、K7Q2M-4）→ 題目；題庫沒有這一局或沒有這個決定就 null。 */
export function targetOfExercise(games: { byId: ReadonlyMap<string, number>; games: readonly SimGame[] }, exerciseId: string): { game: SimGame; target: AiAnswerTarget } | null {
  const parts = splitExerciseId(exerciseId);
  if (!parts) return null;
  const index = games.byId.get(parts.gameId);
  if (index === undefined) return null;
  const game = games.games[index];
  if (parts.assassin) {
    const seat = assassinSeat(game);
    return seat === null ? null : { game, target: { gameId: game.id, proposal: null, seat } };
  }
  const proposal = parts.stage ? stageDecision(game, parts.stage) : parts.seat !== undefined ? firstDecision(game, parts.seat) : null;
  if (proposal === null) return null;
  return { game, target: { gameId: game.id, proposal, seat: game.proposals[proposal].leaderSeat } };
}

// ─── 證據 ─────────────────────────────────────────────────────────────────

/** 公開事實：某一家出過的失敗任務、被湖的宣告、自己湖的宣告、是不是拇指。 */
function seatFacts(obs: PlayerObservation, seat: number): string[] {
  const id = seatId(seat);
  const out: string[] = [];
  for (const q of obs.questHistory) {
    if (q.team.includes(id) && q.failCount > 0) out.push(`出過第 ${q.round} 局的失敗任務（${q.failCount} 張失敗）`);
  }
  const clean = obs.questHistory.filter((q) => q.team.includes(id) && q.failCount === 0).map((q) => q.round);
  if (clean.length) out.push(`出過第 ${clean.join('、')} 局沒有失敗的任務`);
  for (const l of obs.lakeHistory ?? []) {
    const claim = l.declaredClaim === 'good' ? '宣藍' : l.declaredClaim === 'evil' ? '宣紅' : '沒宣告';
    if (l.targetId === id) out.push(`第 ${l.round} 局被 ${seatTxt(seatOfId(l.holderId))} 湖、${claim}`);
    if (l.holderId === id) out.push(`第 ${l.round} 局湖 ${seatTxt(seatOfId(l.targetId))}、${claim}`);
  }
  for (const l of obs.myLakeResults ?? []) {
    if (l.targetId === id) out.push(`自己第 ${l.round} 局湖到他是${l.result === 'evil' ? '紅' : '藍'}`);
  }
  if ((obs.knownWizards ?? []).includes(id)) out.push('是自己看到的拇指（梅林或莫甘娜）');
  if (obs.knownEvils.includes(id)) out.push('是自己看到的紅');
  return out;
}

/** 拿掉一類證據的觀察（信念驅動用）。 */
const ABLATIONS: { label: string; applies: (o: PlayerObservation) => boolean; strip: (o: PlayerObservation) => PlayerObservation }[] = [
  { label: '任務結果', applies: (o) => o.questHistory.length > 0, strip: (o) => ({ ...o, questHistory: [], questResults: [] }) },
  { label: '湖', applies: (o) => (o.lakeHistory ?? []).length > 0, strip: (o) => ({ ...o, lakeHistory: [], myLakeResults: [] }) },
  { label: '派隊與投票紀錄', applies: (o) => o.voteHistory.length > 0, strip: (o) => ({ ...o, voteHistory: [] }) },
  { label: '拇指', applies: (o) => (o.knownWizards ?? []).length > 0, strip: (o) => ({ ...o, knownWizards: [] }) },
];

/** 信念驅動：拿掉一類證據重算 P(紅)，看最可疑的幾家變多少（推算，不是百科AI 自己的說明）。 */
function beliefDrivers(obs: PlayerObservation, full: ReadonlyMap<string, number>, focus: readonly number[], opts: ReturnType<typeof bayesOptionsOf>): AiAnswerReason[] {
  const out: AiAnswerReason[] = [];
  for (const a of ABLATIONS) {
    if (!a.applies(obs)) continue;
    let share: Map<string, number>;
    try {
      share = bayesRedShare(a.strip(obs), opts);
    } catch {
      continue;
    }
    const moves = obs.allPlayerIds
      .map((id) => ({ seat: seatOfId(id), before: full.get(id) ?? 0, after: share.get(id) ?? 0 }))
      .filter((m) => m.seat !== seatOfId(obs.myPlayerId));
    const biggest = [...moves].sort((x, y) => Math.abs(y.before - y.after) - Math.abs(x.before - x.after) || x.seat - y.seat)[0];
    const shown = moves.filter((m) => focus.includes(m.seat));
    if (biggest && !shown.some((m) => m.seat === biggest.seat) && Math.abs(biggest.before - biggest.after) >= 0.05) shown.push(biggest);
    const text = shown.map((m) => `${seatTxt(m.seat)} ${m.after.toFixed(2)}→${m.before.toFixed(2)}`).join('、');
    const maxMove = Math.max(0, ...moves.map((m) => Math.abs(m.before - m.after)));
    out.push({
      source: 'driver',
      label: '信念驅動（推算：拿掉這類證據重算 P(紅)，非百科AI 自己的說明）',
      text: `${a.label}：沒有它→有它 ${text}（所有人最大變動 ${maxMove.toFixed(2)}）`,
    });
  }
  return out;
}

/**
 * 前向推理軌跡的原文：`team [P5,P6,P4] (score=…) → 後處理步驟…`。座位換成 N家；軌跡開頭的隊（評分最高的那一隊）
 * 跟最後派的隊不一樣時註明（後面「→」的步驟換掉的，軌跡不會改寫開頭的隊）。
 */
export function traceText(summary: string, finalSeats: readonly number[], fallback: string | null): string {
  let first: number[] | null = null;
  const text = summary.replace(/\[((?:P\d+,?)+)\]/g, (_m, list: string) => {
    const seats = sorted(list.split(',').filter(Boolean).map(seatOfId));
    if (!first) first = seats;
    return `[${seatsTxt(seats)}]`;
  });
  const parts = [text];
  const head = first as number[] | null;
  if (head && key(head) !== key(finalSeats)) parts.push(`（開頭的 ${teamDigits(head)} 是評分最高的隊，後面「→」的步驟改成最後派的 ${teamDigits(finalSeats)}）`);
  if (fallback) parts.push(`（改用基準策略：${fallback}）`);
  return parts.join('');
}

// ─── 主函式 ───────────────────────────────────────────────────────────────

/** 題目那一家在出題那一刻，百科AI 的答案。 */
export function threadsAiAnswer(game: SimGame, target: AiAnswerTarget, opts: AiAnswerOptions = {}): ThreadsAiAnswer {
  const assassination = target.proposal === null;
  const seed = opts.seed ?? (assassination ? `${game.id}|${target.seat}|assassinate` : `${game.id}|${target.seat}|team-${target.proposal}`);
  return withSeededRandom(seed, () => (assassination ? answerAssassination(game, target, opts, seed) : answerTeam(game, target, opts, seed)));
}

function policyOf(opts: AiAnswerOptions, seed: string): ThreadsAiAnswer['policy'] {
  return {
    agent: 'ForwardAgent(HeuristicAgent)',
    tuning: 'DEFAULT_AGENT_TUNING',
    tuningHash: tuningHash(),
    gitSha: opts.gitSha ?? null,
    ...(opts.gitDirty !== undefined ? { gitDirty: opts.gitDirty } : {}),
    forwardRouting: isForwardRoutingActive(),
    seed,
  };
}

function viewerOf(game: SimGame, seat: number, obs: PlayerObservation): ThreadsAiAnswer['viewer'] {
  const role = game.seatRoles[seat - 1];
  return { seat, role, roleZh: ROLE_ZH[role], knowledge: describeKnowledge(obs) ?? null };
}

function exerciseIdOf(game: SimGame, target: AiAnswerTarget, opts: AiAnswerOptions): string {
  if (opts.exerciseId) return opts.exerciseId;
  if (target.proposal === null) return `${game.id}-A`;
  const p = game.proposals[target.proposal];
  return `${game.id}-${p.round}-${p.attempt}`;
}

const redsOn = (game: SimGame, seats: readonly number[]): number[] => sorted(seats.filter((s) => isRed(game.seatRoles[s - 1])));

function answerTeam(game: SimGame, target: AiAnswerTarget, opts: AiAnswerOptions, seed: string): ThreadsAiAnswer {
  const proposal = game.proposals[target.proposal as number];
  const point: DecisionPoint = { kind: 'team_select', proposal: proposal.globalIndex };
  const obs = decisionObservation(game, target.seat, point);
  const { agent, base, tuning } = defaultBot(game, target.seat);
  const decision = agent.decide(obs);
  const action = decision.action;
  const aiSeats = action.type === 'team_select' ? sorted(action.teamIds.map(seatOfId)) : [];
  const realSeats = sorted(proposal.teamSeats);
  const round = proposal.round;
  const teamSize = realSeats.length;
  const failsRequired = AVALON_CONFIG[game.playerCount]?.questFailsRequired[round - 1] ?? 1;

  // 信念：每一家的 P(紅)；每一種同人數的隊「紅少於 failsRequired」的機率。
  const bopts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, bopts);
  const belief = obs.allPlayerIds.map((id) => ({ seat: seatOfId(id), p: r3(share.get(id) ?? 0) }));
  const post = bayesWorlds(obs, bopts);
  const total = post.wts.reduce((a, b) => a + b, 0);
  const topWorlds = total > 0
    ? post.worlds
      .map((w, i) => ({ seats: sorted(obs.allPlayerIds.filter((id) => (w & post.bitOf(id)) !== 0).map(seatOfId)), p: post.wts[i] / total }))
      .sort((a, b) => b.p - a.p || key(a.seats).localeCompare(key(b.seats)))
      .slice(0, 3)
      .map((w) => ({ seats: w.seats, p: r3(w.p) }))
    : [];
  const ids = obs.allPlayerIds;
  const teams = combinations(ids.map((_, k) => k), teamSize).map((mask) => {
    const team = ids.filter((_, k) => (mask & (1 << k)) !== 0);
    return { seats: sorted(team.map(seatOfId)), p: bayesTeamRedsBelow(obs, team, failsRequired, bopts) ?? 0 };
  });
  teams.sort((a, b) => b.p - a.p || key(a.seats).localeCompare(key(b.seats)));
  const allP = teams.map((t) => t.p);
  const pOf = (seats: readonly number[]): number | null => teams.find((t) => key(t.seats) === key(seats))?.p ?? null;
  const top = teams.slice(0, AI_ANSWER_TOP);
  const cutoff = top.length ? r3(top[top.length - 1].p) : 0;
  const tiedBeyond = teams.slice(AI_ANSWER_TOP).filter((t) => r3(t.p) === cutoff).length;
  const aiP = pOf(aiSeats);
  const realP = pOf(realSeats);
  const metric = failsRequired >= 2
    ? `百科AI 的貝氏信念下，這隊紅少於 ${failsRequired} 人（任務不會失敗）的機率；不是前向推理內部的排序分數`
    : '百科AI 的貝氏信念下，這隊沒有紅的機率；不是前向推理內部的排序分數';

  // 理由：只放決策真的用到的東西。
  const reasons: AiAnswerReason[] = [];
  const knowledge = describeKnowledge(obs);
  if (knowledge) reasons.push({ source: 'knowledge', label: '角色資訊', text: knowledge });
  const replay = action.type === 'team_select' ? withSeededRandom(seed, () => replayRule(obs, base, action, { forwardActive: true })) : undefined;
  if (replay) reasons.push({ source: 'rule', label: '決策路徑（explain 對照前向推理軌跡）', text: replay.mismatch ? `${replay.rule}（重算和實際不同，僅供參考）` : replay.rule });
  const tr = decision.reasoningTrace;
  reasons.push({ source: 'trace', label: '前向推理軌跡（內部標籤原文，座位換成 N家）', text: traceText(tr.summary, aiSeats, tr.usedFallback ? tr.fallbackReason ?? '未知' : null) });
  if (action.type === 'team_select') {
    const review = explainTeamProposal(obs, action.teamIds);
    reasons.push({ source: 'review', label: '網站賽後回顧的說明（嫌疑分是金字塔分數，跟 belief 的貝氏機率是不同的量）', text: review.reason });
  }
  const me = target.seat;
  const focus = [...belief].filter((b) => b.seat !== me).sort((a, b) => b.p - a.p || a.seat - b.seat).slice(0, 3).map((b) => b.seat);
  for (const s of focus) {
    const facts = seatFacts(obs, s);
    reasons.push({ source: 'facts', label: '公開事實（最可疑的三家）', text: `${seatTxt(s)} P(紅) ${(share.get(seatId(s)) ?? 0).toFixed(2)}：${facts.length ? facts.join('；') : '沒有任務、湖的紀錄（只剩派隊與投票）'}` });
  }
  const dropped = realSeats.filter((s) => !aiSeats.includes(s));
  const added = aiSeats.filter((s) => !realSeats.includes(s));
  if (dropped.length || added.length) {
    reasons.push({
      source: 'facts',
      label: '跟真人的差別（百科AI 的 P(紅)）',
      text: `百科AI 多放 ${added.map((s) => `${seatTxt(s)}(${(share.get(seatId(s)) ?? 0).toFixed(2)})`).join('、') || '無'}；`
        + `沒放真人放的 ${dropped.map((s) => `${seatTxt(s)}(${(share.get(seatId(s)) ?? 0).toFixed(2)})`).join('、') || '無'}`,
    });
  }
  if (failsRequired >= 2) {
    // 這一局要 2 張失敗：「隊上沒有紅」和「紅少於 2 人」排出來的隊不一樣；兩個都列（百科AI 有些步驟看的是前者）。
    const cleanOf = (seats: readonly number[]): number => bayesTeamRedsBelow(obs, seats.map(seatId), 1, bopts) ?? 0;
    const bestClean = teams.map((t) => ({ seats: t.seats, p: cleanOf(t.seats) })).sort((a, b) => b.p - a.p || key(a.seats).localeCompare(key(b.seats)))[0];
    reasons.push({
      source: 'facts',
      label: `第 ${round} 局要 ${failsRequired} 張失敗（兩種機率對照）`,
      text: `百科AI 派的 ${teamDigits(aiSeats)}：P(紅少於 ${failsRequired}) ${(aiP ?? 0).toFixed(2)}、P(沒有紅) ${cleanOf(aiSeats).toFixed(2)}；`
        + `P(紅少於 ${failsRequired}) 最高是 ${teamDigits(teams[0].seats)}（${teams[0].p.toFixed(2)}、P(沒有紅) ${cleanOf(teams[0].seats).toFixed(2)}）；`
        + `P(沒有紅) 最高是 ${teamDigits(bestClean.seats)}（${bestClean.p.toFixed(2)}）`,
    });
  }
  reasons.push(...beliefDrivers(obs, share, focus, bopts));

  const quest = game.quests.find((q) => q.round === round);
  const mission = proposal.wentOnMission && quest ? { failCount: quest.failCount, failed: quest.failed } : null;
  const outcome = proposal.forced
    ? `強制出發 → ${mission ? `${mission.failCount} 張失敗，任務${mission.failed ? '失敗' : '成功'}` : '（沒有任務紀錄）'}`
    : proposal.wentOnMission
      ? `${proposal.approveCount} 票贊成通過 → ${mission ? `${mission.failCount} 張失敗，任務${mission.failed ? '失敗' : '成功'}` : '（沒有任務紀錄）'}`
      : `${proposal.approveCount} 票贊成，沒過`;
  const aiReds = redsOn(game, aiSeats);
  const realReds = redsOn(game, realSeats);

  return {
    schema: AI_ANSWER_SCHEMA,
    exerciseId: exerciseIdOf(game, target, opts),
    gameId: game.id,
    decision: { kind: 'team', round, attempt: proposal.attempt, teamSize, failsRequired, forced: proposal.forced },
    viewer: viewerOf(game, target.seat, obs),
    pick: {
      seats: aiSeats,
      text: `派 ${teamDigits(aiSeats)}`,
      p: aiP === null ? null : r3(aiP),
      rank: aiP === null ? null : rankOf(allP, aiP),
      forwardScore: tr.usedFallback ? null : r3(tr.chosenScore),
    },
    top: {
      metric,
      options: teams.length,
      items: top.map((t) => ({ seats: t.seats, p: r3(t.p), chosen: key(t.seats) === key(aiSeats), real: key(t.seats) === key(realSeats) })),
      tiedBeyond,
    },
    belief: { metric: 'P(red)', note: '百科AI 的貝氏信念（BayesBelief，派隊／投票／任務／湖／拇指都算進去）；自己是 0', seats: belief, topWorlds },
    reasons,
    real: {
      seats: realSeats,
      text: `派 ${teamDigits(realSeats)}`,
      sameAsAi: key(realSeats) === key(aiSeats),
      p: realP === null ? null : r3(realP),
      rank: realP === null ? null : rankOf(allP, realP),
      approved: proposal.wentOnMission,
      approveCount: proposal.forced ? null : proposal.approveCount,
      mission,
      outcome,
    },
    hindsight: {
      aiPickReds: aiReds,
      realPickReds: realReds,
      text: `百科AI 的隊上紅：${seatsTxt(aiReds)}；真人的隊上紅：${seatsTxt(realReds)}`,
    },
    policy: policyOf(opts, seed),
  };
}

function answerAssassination(game: SimGame, target: AiAnswerTarget, opts: AiAnswerOptions, seed: string): ThreadsAiAnswer {
  const obs = decisionObservation(game, target.seat, { kind: 'assassination' });
  const { agent, base, tuning } = defaultBot(game, target.seat);
  const action: AgentAction = agent.act(obs);
  const aiTarget = action.type === 'assassinate' ? seatOfId(action.targetId) : 0;
  const realTarget = game.assassinTargetSeat ?? 0;
  const merlinSeat = game.seatRoles.indexOf('merlin') + 1;

  // 刺殺排序用的分數（模型路徑）→ 機率（softmax）；前排＝分層之後真的會被刺的那一群。
  const readout = base.assassinationReadout(obs);
  const probs = new Map<number, number>();
  const items: AiAnswerOption[] = [];
  let order: number[] = [];
  if (readout) {
    const raw = readout.candidates.map((id) => readout.scores.get(id) ?? 0);
    const max = Math.max(...raw);
    const exps = raw.map((x) => Math.exp(x - max));
    const z = exps.reduce((a, b) => a + b, 0);
    readout.candidates.forEach((id, i) => probs.set(seatOfId(id), exps[i] / z));
    const front = new Set(readout.front.map(seatOfId));
    order = readout.candidates
      .map(seatOfId)
      .sort((a, b) => Number(front.has(b)) - Number(front.has(a)) || (probs.get(b) ?? 0) - (probs.get(a) ?? 0) || a - b);
    for (const s of order.slice(0, AI_ANSWER_TOP)) {
      const t = readout.terms.get(seatId(s));
      items.push({
        seats: [s],
        p: r3(probs.get(s) ?? 0),
        chosen: s === aiTarget,
        real: s === realTarget,
        front: front.has(s),
        ...(t ? { terms: { model: r3(t.model), vote: r3(t.vote), lake: r3(t.lake), lead: r3(t.lead), reuse: r3(t.reuse) } } : {}),
      });
    }
  }
  const belief = obs.allPlayerIds.map((id) => ({ seat: seatOfId(id), p: r3(probs.get(seatOfId(id)) ?? 0) }));
  const rankIn = (s: number): number | null => (order.includes(s) ? order.indexOf(s) + 1 : null);

  const reasons: AiAnswerReason[] = [];
  const knowledge = describeKnowledge(obs);
  if (knowledge) reasons.push({ source: 'knowledge', label: '角色資訊', text: knowledge });
  if (action.type === 'assassinate') {
    const replay = replayRule(obs, base, action, { forwardActive: true });
    if (replay) reasons.push({ source: 'rule', label: '決策路徑（explain 對照前向推理軌跡）', text: replay.mismatch ? `${replay.rule}（重算和實際不同，僅供參考）` : replay.rule });
    const review = explainAssassination(obs, action.targetId, undefined, tuning);
    if (review.rule) reasons.push({ source: 'rule', label: '刺殺分層規則', text: review.rule });
    reasons.push({ source: 'review', label: '網站賽後回顧的說明', text: review.reason });
  }
  const termTxt = (s: number): string => {
    const t = readout?.terms.get(seatId(s));
    if (!t) return `${seatTxt(s)}：沒有分數`;
    const parts = [['模型', t.model], ['投票', t.vote], ['湖', t.lake], ['派隊', t.lead], ['重派', t.reuse]] as const;
    const sum = t.model + t.vote + t.lake + t.lead + t.reuse;
    return `${seatTxt(s)} ${parts.filter(([, v]) => v !== 0).map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(' ')} = ${sum.toFixed(2)}`
      + `（P(梅林) ${(probs.get(s) ?? 0).toFixed(2)}${readout && !readout.front.includes(seatId(s)) ? '，不在前排' : ''}）`;
  };
  if (readout) {
    const shown = [...new Set([...order.slice(0, 3), realTarget, merlinSeat].filter((s) => order.includes(s)))];
    // 梅林是誰是事後的資訊：只用來決定多列哪一家的分數，句子裡不寫誰是梅林（看 hindsight）。
    reasons.push({ source: 'terms', label: '刺殺分數的組成（log 分數，加起來就是排序用的分數）', text: shown.map(termTxt).join('；') });
  }
  for (const s of order.slice(0, 3)) {
    const facts = seatFacts(obs, s);
    reasons.push({ source: 'facts', label: '公開事實（分數最高的三家）', text: `${seatTxt(s)}：${facts.length ? facts.join('；') : '沒有任務失敗、湖的紀錄'}` });
  }

  const hit = game.seatRoles[realTarget - 1] === 'merlin';
  const aiHit = aiTarget === merlinSeat;
  return {
    schema: AI_ANSWER_SCHEMA,
    exerciseId: exerciseIdOf(game, target, opts),
    gameId: game.id,
    decision: { kind: 'assassination', round: game.quests.length, attempt: null, teamSize: null, failsRequired: null, forced: false },
    viewer: viewerOf(game, target.seat, obs),
    pick: {
      seats: aiTarget ? [aiTarget] : [],
      text: `刺 ${seatTxt(aiTarget)}`,
      p: readout ? r3(probs.get(aiTarget) ?? 0) : null,
      rank: rankIn(aiTarget),
      forwardScore: null,
    },
    top: {
      metric: '百科AI 刺殺排序用的分數（模型＋投票＋派隊＋重派讀法的 log 分數）換算成機率（softmax，候選＝全部藍方）；照它真的排序：前排優先，再看分數',
      options: order.length,
      items,
      tiedBeyond: 0,
    },
    belief: { metric: 'P(merlin)', note: '刺殺分數的 softmax（紅方與自己是 0）；不在前排的人分數再高也不會被刺', seats: belief },
    reasons,
    real: {
      seats: realTarget ? [realTarget] : [],
      text: `刺 ${seatTxt(realTarget)}`,
      sameAsAi: realTarget === aiTarget,
      p: readout ? r3(probs.get(realTarget) ?? 0) : null,
      rank: rankIn(realTarget),
      hit,
      outcome: hit ? '刺中梅林，紅方勝' : '沒刺中梅林，藍方勝',
    },
    hindsight: {
      aiPickReds: [],
      realPickReds: [],
      merlinSeat,
      aiHit,
      text: `梅林是 ${seatTxt(merlinSeat)}；百科AI ${aiHit ? '刺中' : '沒刺中'}，真人${hit ? '刺中' : '沒刺中'}`,
    },
    policy: policyOf(opts, seed),
  };
}

/** 給站長看的一段摘要（腳本、主控台用；不進貼文）。 */
export function aiAnswerSummary(a: ThreadsAiAnswer): string {
  const top = [...a.belief.seats].filter((b) => b.seat !== a.viewer.seat).sort((x, y) => y.p - x.p || x.seat - y.seat).slice(0, 3);
  const beliefTxt = top.map((b) => `${seatTxt(b.seat)} ${b.p.toFixed(2)}`).join('、');
  return [
    `${a.exerciseId}｜${seatTxt(a.viewer.seat)} ${a.viewer.roleZh}`,
    `百科AI：${a.pick.text}${a.pick.p !== null ? `（${a.pick.p.toFixed(2)}，第 ${a.pick.rank} 名）` : ''}；真人：${a.real.text}${a.real.p !== null ? `（${a.real.p.toFixed(2)}，第 ${a.real.rank} 名）` : ''} → ${a.real.outcome}`,
    `${a.belief.metric} 最高：${beliefTxt}`,
    `事後：${a.hindsight.text}`,
  ].join('\n');
}
