/**
 * 梅林照忠臣的方式派票（優化迴圈第 5 回合・梅林，Edward 2026-10-29；`AgentTuning.merlinLoyalStyle`）：
 *
 * > 梅林派票並非「只能切區間」或是「只能派可見紅方躲刺」——梅林應該是隨著局勢發展，跟場上所有忠臣做一樣的事。
 *
 * 〈梅林資訊與雜魚視角的同步〉：先透過雜魚視角找出合理的故事線，再配合內建視角選出最能符合雜魚視角的那一條。
 * 實作：梅林當隊長時，用「只看公開紀錄的忠臣」（自己的座位、沒有私人資訊）的貝氏信念算每支隊「沒有紅」的機率，
 * 在隊上沒有他看得到的紅的隊伍裡挑最高的那支；同分時看延伸／修正與切區間（`ZoneModel`）。
 * 忠臣、派西讀「可能是梅林的人」的派票：一支合理的隊、而且不會有他看得到的紅（`BayesOptions.merlinEarlyStrict`）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { merlinSignalScore } from './belief/ZoneModel';
import { r1Scorer, r1SpreadActive } from './BlueRound33';

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

/** Merlin's loyal-style team, or the action unchanged. */
export function merlinLoyalStyleTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
  publicAllowed: (team: readonly string[]) => boolean = allowed,
): AgentAction {
  if (!tuning.merlinLoyalStyle || action.type !== 'team_select' || obs.myRole !== 'merlin') return action;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const size = action.teamIds.length;
  const normTeam = merlinReuseNormTeam(tuning, obs, size, publicAllowed);
  // Round 20 `merlinReuseSkip` / `merlinReusePublic`: Merlin does not re-propose every time the norm applies.
  const reuse = normTeam && !merlinReuseSkipNow(tuning, obs) && merlinReusePublicNow(tuning, obs, size) ? normTeam : null;
  if (reuse) return { type: 'team_select', teamIds: reuse };
  // Round 22 `merlinDoomedPublic`: a doomed R1–R2 proposal (never a mission) follows the public loyal view of this seat, seen reds and all.
  const doomedPublic = merlinDoomedPublicTeam(tuning, obs, size, publicAllowed);
  if (doomedPublic) return { type: 'team_select', teamIds: doomedPublic };
  // Round 24 `merlinDoomedAvoid` (Edward 2026-11-03): among the publicly reasonable doomed R1–R2 teams, the fewest seen reds.
  const doomedAvoid = merlinDoomedAvoidTeam(tuning, obs, size, publicAllowed);
  if (doomedAvoid) return { type: 'team_select', teamIds: doomedAvoid };
  // `merlinLoyalCover` (round 7 candidate): on a doomed R1–R2 proposal (the normal votes reject it), at rate c the
  // loyal-looking team carries exactly one seen red — 派拇指躲刺 inside the loyal style, so not every Merlin lead is clean.
  const cover = merlinLoyalCoverNow(tuning, obs);
  const pool = obs.allPlayerIds.filter((id) => id !== me && (cover || !seen.has(id)));
  if (pool.length < size - 1) return action;
  // The public loyal view of my own seat: the same records, none of Merlin's sight.
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const pubOpts = { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true };
  const prior = obs.voteHistory.filter((p) => p.round <= 2 && p.leader !== me).map((p) => ({ leader: p.leader, team: p.team }));
  const scored: { team: string[]; score: number }[] = [];
  for (const fill of combinations(pool, size - 1)) {
    if (cover && fill.filter((id) => seen.has(id)).length !== 1) continue;
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team, pubOpts) ?? 0;
    // Loyal plausibility first; the extension / correction / zone signal only breaks near-ties.
    scored.push({ team, score: Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, seen, prior, me) });
  }
  // Highest first (stable); the logic gates (must-fail / dominated) still bind.
  // Round 33 `loyalR1Spread`: as the loyals do, an R1 talk proposal takes the least-stacked teams first (Merlin's own seat view of the record).
  const spread = r1SpreadActive(tuning, obs);
  if (spread) {
    const score = r1Scorer(tuning, obs, spread);
    const st = new Map(scored.map((c) => [c, score(c.team)] as const));
    scored.sort((x, y) => (Math.abs(st.get(x)! - st.get(y)!) > 1e-9 ? st.get(x)! - st.get(y)! : y.score - x.score));
  } else scored.sort((x, y) => y.score - x.score);
  // A cover team holds a seen red by design (doomed, never a mission), as `merlinDoomedRed` does: no gate on it.
  const best = cover ? scored[0] : scored.find((c) => allowed(c.team));
  return best ? { type: 'team_select', teamIds: best.team } : action;
}

/**
 * `merlinReuseNorm`（第 17 回合・梅林）：第 2 局非強制的提議（注定被否決）、上一局任務成功、那一隊有梅林看得到的紅 → 照派那一隊
 * （梅林不在隊上就補自己；還缺的位置用只看公開紀錄的忠臣挑沒有看得到的紅、最乾淨的人）。不適用時 null。
 * 第 18 回合候選：2 = 第 3 局起非關鍵局（紅方未滿兩紅）、非強制的提議也照派上一局成功的隊（會出任務，要過公開視角的邏輯閘門 `allowed`——梅林自己的確定性層把看得到的紅當成必紅，
 * 照派的隊一定被「必定失敗」擋下，所以用坐在梅林位置、只看公開紀錄的忠臣的閘門；
 * 那一隊人數已滿、梅林不在隊上時照原樣派）；3 = 同 2，但照派的是「最近一次成功的任務」（上一局失敗時回到之前成功的隊）。
 */
export function merlinReuseNormTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  size: number,
  allowed: (team: readonly string[]) => boolean = () => true,
): string[] | null {
  const mode = tuning.merlinReuseNorm ?? 0;
  if (mode <= 0 || obs.myRole !== 'merlin') return null;
  const round = obs.currentRound ?? 1;
  if (round < 2 || (obs.failCount ?? 0) >= 4) return null;
  const later = round >= 3;
  if (later && (mode < 2 || obs.questResults.filter((r) => r === 'fail').length >= 2)) return null;
  // Round 26 `merlinReuseNoEarly` (Edward 2026-11-04 ruling 5: Merlin's R1–R2 proposals essentially never hold a red he sees): no R2 reuse
  // of a successful team holding a seen red — the loyal-style team instead.
  if (!later && tuning.merlinReuseNoEarly === true) return null;
  const doneRounds = obs.questHistory.filter((q) => q.round < round && obs.questResults[q.round - 1] === 'success').map((q) => q.round);
  const target = mode >= 3 && later ? Math.max(0, ...doneRounds) : round - 1;
  const last = obs.questHistory.find((q) => q.round === target);
  if (!last || obs.questResults[target - 1] !== 'success') return null;
  const seen = new Set(obs.knownEvils);
  if (!last.team.some((id) => seen.has(id))) return null;
  const me = obs.myPlayerId;
  const team = last.team.includes(me) || (later && last.team.length === size) ? [...last.team] : [me, ...last.team];
  if (team.length > size) return null;
  if (later) {
    const full = team.length === size ? team : merlinReuseFill(tuning, obs, team, size, seen);
    return full && allowed(full) ? full : null;
  }
  return team.length === size ? team : merlinReuseFill(tuning, obs, team, size, seen);
}

/**
 * Whether `team` is Merlin's R3+ re-proposal of a successful mission team (`merlinReuseNorm` ≥ 2; the invariant
 * harness exemption — Edward 2026-11-01: 照派成功的隊算順應局勢): round 3+, non-forced, red short of two fails, and every
 * seen red on the team sat on a successful earlier mission whose whole team is on this one.
 */
export function merlinReuseProposal(obs: PlayerObservation, team: readonly string[]): boolean {
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4 || obs.questResults.filter((r) => r === 'fail').length >= 2) return false;
  const seen = team.filter((id) => obs.knownEvils.includes(id));
  return obs.questHistory.some((q) => q.round < round && obs.questResults[q.round - 1] === 'success'
    && q.team.every((id) => team.includes(id)) && seen.every((id) => q.team.includes(id)));
}

/**
 * `merlinDoomedPublic`（第 22 回合・梅林）：第 1、2 局注定被否決的提議（非強制；`MerlinCover.doomedProposal`，不會出任務）照「坐在梅林位置、
 * 只看公開紀錄的忠臣」派：公開視角「這隊沒有紅」機率最高的隊，同分看延伸前面的派票（不用梅林的視角：看得到的紅集合當成空的），再同分照局面雜湊；
 * 看得到的紅也可以在隊上（順應局勢——不刻意放、也不刻意避開）。過公開視角的邏輯閘門 `allowed`。不適用時 null。
 */
export function merlinDoomedPublicTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  size: number,
  allowed: (team: readonly string[]) => boolean = () => true,
): string[] | null {
  if ((tuning.merlinDoomedPublic ?? 0) <= 0 || obs.myRole !== 'merlin') return null;
  const mode = tuning.merlinDoomedPublic ?? 0;
  const round = obs.currentRound ?? 1;
  if (round > 2 || (obs.failCount ?? 0) >= 4 || size < 1) return null;
  // 3 / 4: R1 only / R2 only.
  if ((mode === 3 && round !== 1) || (mode === 4 && round !== 2)) return null;
  const me = obs.myPlayerId;
  // `merlinDoomedPublicHalf` (第 1C 節): only half the doomed proposals (hashed per seat, round and attempt).
  if (tuning.merlinDoomedPublicHalf) {
    let hh = 0x811c9dc5;
    for (const ch of `${me}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|doomedPublicHalf`) hh = Math.imul(hh ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    if ((hh % 10000) / 10000 >= 0.5) return null;
  }
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const pubOpts = { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true };
  const prior = obs.voteHistory.filter((p) => p.round <= 2 && p.leader !== me).map((p) => ({ leader: p.leader, team: p.team }));
  const none = new Set<string>();
  const salt = `${me}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|doomedPublic`;
  const scored: { team: string[]; score: number }[] = [];
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team, pubOpts) ?? 0;
    let h = 0x811c9dc5;
    for (const ch of `${salt}|${team.join(',')}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    scored.push({ team, score: Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, none, prior, me) + 1e-9 * (h % 1000) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.find((c) => allowed(c.team))?.team ?? null;
}

/**
 * `merlinDoomedAvoid`（第 24 回合・梅林；Edward 2026-11-03：「要從公開資訊中找到符合自己內建資訊、盡可能避開三個可見紅方拇指的隊伍資訊」）：
 * 第 1、2 局注定被否決的提議（非強制，不會出任務）——先列出公開上合理的隊（「坐在梅林位置、只看公開紀錄的忠臣」的分數，和 `merlinDoomedPublic` 相同：
 * 公開視角「這隊沒有紅」的 log 機率＋延伸前面派票的訊號＋局面雜湊；不低於最高分 + log r），再在裡面挑看得到的紅最少的隊，同樣多看公開分數。
 * 公開上有乾淨的合理隊就一定乾淨；只有每一支合理的隊都有看得到的紅時才放最少的那幾個。過公開視角的邏輯閘門 `allowed`。不適用時 null。
 */
export function merlinDoomedAvoidTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  size: number,
  allowed: (team: readonly string[]) => boolean = () => true,
): string[] | null {
  const r = tuning.merlinDoomedAvoid ?? 0;
  if (r <= 0 || obs.myRole !== 'merlin') return null;
  const round = obs.currentRound ?? 1;
  if (round > 2 || (obs.failCount ?? 0) >= 4 || size < 1) return null;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const pubOpts = { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true };
  const prior = obs.voteHistory.filter((p) => p.round <= 2 && p.leader !== me).map((p) => ({ leader: p.leader, team: p.team }));
  const none = new Set<string>();
  const salt = `${me}|${round}|${obs.failCount ?? 0}|doomedPublic`;
  const scored: { team: string[]; score: number; reds: number }[] = [];
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), size - 1)) {
    const team = [me, ...fill];
    if (!allowed(team)) continue;
    const p = bayesTeamClean(publicView, team, pubOpts) ?? 0;
    let h = 0x811c9dc5;
    for (const ch of `${salt}|${team.join(',')}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    const score = Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, none, prior, me) + 1e-9 * (h % 1000);
    scored.push({ team, score, reds: fill.filter((id) => seen.has(id)).length });
  }
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((c) => c.score));
  const floor = best + Math.log(Math.min(r, 1)) - 1e-12;
  const reasonable = scored.filter((c) => c.score >= floor);
  reasonable.sort((x, y) => x.reds - y.reds || y.score - x.score);
  return reasonable[0]?.team ?? null;
}

/**
 * `merlinReuseSkip`（第 20 回合・梅林）：照派適用時，這次以比例 s 不照派（照座位、局、提議次數與到目前為止的派隊雜湊；同一局面每次一樣）。
 */
export function merlinReuseSkipNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const s = tuning.merlinReuseSkip ?? 0;
  if (s <= 0) return false;
  if (s >= 1) return true;
  let h = 0x811c9dc5;
  const key = `${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|${obs.voteHistory.map((v) => `${v.leader}:${v.team.join(',')}`).join(';')}|reuseSkip`;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < s;
}

/**
 * `merlinReusePublic`（第 20 回合・梅林）：照派只在「坐在梅林位置、只看公開紀錄的忠臣」當隊長也會派進那一隊時做——那個忠臣派自己＋
 * 公開視角「這隊沒有紅」機率最高的人（`goodCleanLead` 的派法），派出的隊整隊包含要照派的那一隊才照派。關掉時一律 true。
 */
export function merlinReusePublicNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation, size: number): boolean {
  if (!tuning.merlinReusePublic) return true;
  const round = obs.currentRound ?? 1;
  const before = obs.questResults.slice(0, round - 1);
  const done = obs.questHistory.filter((q) => q.round < round && before[q.round - 1] === 'success').map((q) => q.round);
  const target = round >= 3 && (tuning.merlinReuseNorm ?? 0) >= 3 ? Math.max(0, ...done) : round - 1;
  const last = obs.questHistory.find((q) => q.round === target);
  if (!last) return true;
  const me = obs.myPlayerId;
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const pubOpts = bayesOptionsOf(tuning);
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(obs.allPlayerIds.filter((id) => id !== me), size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team, pubOpts) ?? 0;
    if (p > bestP + 1e-12) { bestP = p; best = team; }
  }
  return best !== null && last.team.every((id) => best!.includes(id));
}

/** Fill a re-proposed team with the cleanest public picks that are not seen reds. */
function merlinReuseFill(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: string[], size: number, seen: ReadonlySet<string>): string[] | null {
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const pubOpts = { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true };
  const pool = obs.allPlayerIds.filter((id) => !team.includes(id) && !seen.has(id));
  let best: string[] | null = null;
  let bestP = -1;
  for (const fill of combinations(pool, size - team.length)) {
    const t = [...team, ...fill];
    const p = bayesTeamClean(publicView, t, pubOpts) ?? 0;
    if (p > bestP + 1e-12) { bestP = p; best = t; }
  }
  return best;
}

/** `merlinLoyalCover`: this doomed R1–R2 proposal carries one seen red (hashed per seat, round and attempt). */
function merlinLoyalCoverNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const c = tuning.merlinLoyalCover ?? 0;
  if (c <= 0 || (obs.currentRound ?? 1) > 2 || (obs.failCount ?? 0) >= 4 || obs.knownEvils.length === 0) return false;
  let h = 0x811c9dc5;
  for (const ch of `${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|cover`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < c;
}

/**
 * 派西照忠臣的方式派票（第 5 回合・派西，Edward 2026-10-29）：
 *
 * > 派西並非不能夾——太刻意閃躲拇指，票型上會非常明顯被抓到自己是能力者；跟梅林思維一樣，盡可能符合忠臣視角與思維，
 * > 再去結合雙拇指給的資訊去做整合。派西永遠只有 A 梅 B 娜或 A 娜 B 梅：信 A 資訊＋派 A／不派 A、信 B 資訊＋派 B／不派 B，
 * > 或同時參考 AB 資訊的交集（AB 都選的人最多是莫德雷德，AB 都避開的人幾乎是刺客／奧伯倫）。
 *
 * 實作：派西的貝氏信念本來就只有這兩種世界（`percivalThumbLogic`），對世界加權平均後「全隊沒有紅」機率最高的隊，
 * 就是上面五種之一（某邊的世界權重大 → 信那邊、派不派那根拇指看機率；兩邊差不多 → 落在交集）。
 * 分數 = log P(派西自己的信念：全隊沒有紅) + 0.5 × log P(只看公開紀錄的忠臣：全隊沒有紅)——資訊最好、又不會一眼看出是派西。
 * 回傳時附上這一隊屬於哪一種（給覆盤說明用）。
 */
export type PercivalPlan = '信A派A' | '信A不派A' | '信B派B' | '信B不派B' | 'AB交集';

export function percivalLoyalStyleTeam(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  action: AgentAction,
  allowed: (team: readonly string[]) => boolean = () => true,
): { action: AgentAction; plan: PercivalPlan | null } {
  const thumbs = obs.knownWizards ?? [];
  if (!tuning.percivalLoyalStyle || action.type !== 'team_select' || obs.myRole !== 'percival' || thumbs.length !== 2) {
    return { action, plan: null };
  }
  const me = obs.myPlayerId;
  const others = obs.allPlayerIds.filter((id) => id !== me);
  const size = action.teamIds.length;
  const opts = { strictMerlin: tuning.percivalThumbLogic === true, thumbRoles: tuning.bayesThumbRoles === true, botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true };
  const publicView = { ...obs, myRole: 'loyal', knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const scored: { team: string[]; score: number }[] = [];
  for (const fill of combinations(others, size - 1)) {
    const team = [me, ...fill];
    const priv = bayesTeamClean(obs, team, opts) ?? 0;
    const pub = bayesTeamClean(publicView, team, { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true }) ?? 0;
    scored.push({ team, score: Math.log(Math.max(priv, 1e-12)) + 0.5 * Math.log(Math.max(pub, 1e-12)) });
  }
  scored.sort((x, y) => y.score - x.score);
  const best = scored.find((c) => allowed(c.team))?.team;
  if (!best) return { action, plan: null };
  // Which of Edward's five plans this team is: the thumb believed to be Merlin (posterior), and whether it is on the team.
  const [a, b] = thumbs;
  const share = bayesTeamClean(obs, [me, a], opts) ?? 0.5; // P(A good) = P(A is Merlin)
  const trustA = share >= 0.6;
  const trustB = share <= 0.4;
  const plan: PercivalPlan = trustA ? (best.includes(a) ? '信A派A' : '信A不派A') : trustB ? (best.includes(b) ? '信B派B' : '信B不派B') : 'AB交集';
  return { action: { type: 'team_select', teamIds: best }, plan };
}

/**
 * 梅林投票雜魚化（優化迴圈第 7 回合・梅林候選，2026-10-29；`AgentTuning.merlinVoteCover`）。
 *
 * 百科〈忠臣〉遊戲心態「梅林只想裝雜魚」；〈異常票基礎篇〉內黑外白都在釋放視角，「梅林被刺可能性變高」。
 * 機器人梅林第 3 局起對有他看得到的紅的隊贊成 0%（真人 25.7%），刺客一讀投票（`assassinMerlinVotes`）就抓得到。
 * 規則：第 3 局起、非強制、隊上有看得到的紅、紅方還沒聽牌（失敗 < 2）、而且只看公開紀錄的忠臣會覺得這隊乾淨
 * （P 不低於忠臣投黑門檻 `goodCleanVote`，雜魚會贊成的隊）→ 以比例 q 照雜魚投白（同一局同一次提議的結果固定，用雜湊決定）。
 * 回傳 true = 這一票改投白。
 */
export function merlinVoteCoverApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.merlinVoteCover ?? 0;
  if (q <= 0 || obs.gamePhase !== 'team_vote' || obs.myRole !== 'merlin') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4) return false;
  const team = obs.proposedTeam ?? [];
  const seen = new Set(obs.knownEvils);
  if (team.length === 0 || !team.some((id) => seen.has(id))) return false;
  if (obs.questResults.filter((r) => r === 'fail').length >= 2) return false;
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const p = bayesTeamClean(publicView, team, { botTables: tuning.beliefBotTables ?? 0, botTablesNext: tuning.beliefBotTablesNext === true, botMissionNext: tuning.beliefBotMissionNext === true, keyVoteCells: tuning.beliefKeyVoteCells === true }) ?? 0;
  if (p < Math.max(tuning.goodCleanVote || 0.25, 0.25)) return false;
  let h = 0x811c9dc5;
  for (const c of `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${team.join(',')}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < q;
}

/**
 * 梅林照雜魚的票型投票（強桌差距 B1，2026-10-30；`AgentTuning.merlinNormalVote` = 比例 q）。
 *
 * `docs/ai/strong_table_gap.md`：機器人梅林第 3 局起在隊上、隊裡有他看得到的紅時贊成 0%（梅林勝率前 1/4 的玩家 48%），
 * 不在隊上、看得到的都乾淨時贊成 97%（強者 41%）——票型直接報出拇指。百科〈忠臣〉「梅林只想裝雜魚」、〈外白〉「梅林亂外白
 * 被紅方抓到容易死」。規則：第 3 局起、非強制，以比例 q（依座位、回合、第幾次提議雜湊）照「坐在這個位置、只看公開紀錄的
 * 忠臣」會投的票投；只有致命時才用自己的資訊擋：隊上有看得到的紅而且紅方已兩紅，或第 4 局隊上有兩個以上看得到的紅。
 * 回傳 true = 這一票改照雜魚投（由 `ForwardAgent.decide` 算出那一票）。
 */
export function merlinNormalVoteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.merlinNormalVote ?? 0;
  if (q <= 0 || obs.gamePhase !== 'team_vote' || obs.myRole !== 'merlin') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || (obs.failCount ?? 0) >= 4) return false;
  let h = 0x811c9dc5;
  for (const ch of `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|normal`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < q;
}

/**
 * Whether approving `obs.proposedTeam` could lose the game on the spot for Merlin's camp (the seen reds alone).
 * Round 34 `merlinFatalR4` (basic consistency): on R4 at 7+ players (two fail cards) only two or more seen reds can fail the mission — with red
 * on two fails, one seen red there is not fatal (before, Merlin inner-blacked such a team while every loyal approved it).
 */
export function merlinVoteFatal(obs: PlayerObservation, tuning?: Readonly<Partial<AgentTuning>>): boolean {
  const seen = new Set(obs.knownEvils);
  const reds = (obs.proposedTeam ?? []).filter((id) => seen.has(id)).length;
  if (reds === 0) return false;
  const fails = obs.questResults.filter((r) => r === 'fail').length;
  const twoFail = (obs.currentRound ?? 1) === 4 && obs.playerCount >= 7;
  if (tuning?.merlinFatalR4 === true && twoFail) return reds >= 2;
  return fails >= 2 || (twoFail && reds >= 2);
}
