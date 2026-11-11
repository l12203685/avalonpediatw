/**
 * 優化迴圈第 38 回合・藍方（2026-11-10）。
 *
 * 第 37 回合量到：和真人的差距全部在第 1 局失敗的局，最大的一塊是刺中率。凍結的刺客先看「誰當隊長時從來沒派過梅林看得到的紅」，梅林永遠在這群人裡；
 * 其他五個藍方留在這群人裡的比例各約四成（和隨機挑的差不多），但是一起留、一起出去——每個忠臣用同一份公開後驗挑最高的那一支，隊伍幾乎一樣。
 * 名單只剩梅林一個人的局（第 1 局失敗的局 18.6%），刺中率 100%。
 *
 * Edward 11/10 的裁定：忠臣在同一個局面有很多支可以派的隊，會選「和自己前面的想法一致、和資訊流一致」的那幾支；不是等機率亂挑。
 *
 *   - `ownView`（`belief/BayesBelief.ts`）：挑非強制的隊時，後驗從自己的先驗出發（對每個人一個偏好，從這一局第一個提議起整局不變；自己派過的人少算一點可疑），
 *     公開紀錄照常更新。這個檔案補上後驗管不到的那一次：整場第一個提議（還沒有任何紀錄，原本固定派同一組人；這一次的偏好另外用亂數抽，和之後的無關）。
 *   - `percivalThumbRead`：派西第 2 局起只帶分得出來是梅林的那一根拇指。
 *   - `goodOnTeamState`、`goodReuseWhite`、`merlinOnTeamOwn`：異常票照局面（比分、是不是整隊照派成功的隊、自己還會不會派、有沒有被宣告紅的人）決定，
 *     不是只調門檻（真人牌譜同一點的兩個方向比對）。
 * 全部預設關。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean, ownViewStrength } from './belief/BayesBelief';

type Allowed = (team: readonly string[]) => boolean;

function combos<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

const keyOf = (team: readonly string[]): string => [...team].sort().join(',');

/** `ownView` 開著、而且這個座位這一次挑隊適用（忠臣；範圍 2 起加派西）。 */
export function ownViewOn(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!((tuning.ownView ?? 0) > 0)) return false;
  return ownViewStrength(obs, Math.max(1, tuning.ownViewScope ?? 0), tuning.ownViewRounds ?? 0) > 0;
}

/**
 * `ownView`：第 1 局還沒有任何提議時（整場第一個隊長），原本的流程固定派同一組人（1 號忠臣一律帶 6、9 號）。開了 `ownView` 之後照自己的先驗挑
 * 最乾淨的隊——這時候沒有紀錄，等於照這一次用亂數抽的偏好挑。派西照舊不帶拇指。`allowed` 由呼叫端給：邏輯關卡，加上第一個提議禁止的座位組合
 * （5 人 12／34／45／15、10 人 123／150／234／678；`ForwardAgent` 的候選清單也是這樣濾的）。不適用時回傳原本的動作（同一個物件）。
 */
export function ownViewFirstPickTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  if (action.type !== 'team_select' || !ownViewOn(tuning, obs)) return action;
  if ((obs.currentRound ?? 1) !== 1 || obs.voteHistory.length > 0) return action;
  const me = obs.myPlayerId;
  const thumbs = obs.myRole === 'percival' ? obs.knownWizards ?? [] : [];
  const pool = obs.allPlayerIds.filter((id) => id !== me && !thumbs.includes(id));
  const size = action.teamIds.length;
  if (pool.length < size - 1) return action;
  const opts = bayesOptionsOf(tuning);
  let best: { team: string[]; p: number } | null = null;
  for (const fill of combos(pool, size - 1)) {
    const team = [me, ...fill];
    if (!allowed(team)) continue;
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    if (!best || p - best.p > 1e-12) best = { team, p };
  }
  if (!best || keyOf(best.team) === keyOf(action.teamIds)) return action;
  return { type: 'team_select', teamIds: best.team };
}

// ── 派西：只帶分得出來的那一根拇指（`percivalThumbRead`）──────────────

/**
 * 真人派西（強者派西的牌譜分析，2,229 局）：兩根拇指從不一起帶；用拇指自己的動作分辨（帶過另一根拇指的那根 14–19% 是梅林、上過成功任務 70% 以上），
 * 「上過失敗任務」不算數；分不出來就兩根都不帶（第 2 局 36–46%、第 3 局 37%）。隨便帶一根（一半是莫甘娜）比帶一個不是拇指的人（約 3/7 是紅）還差。
 * 規則：第 2 局起、不是整隊照派成功任務的隊——自己後驗裡「是梅林」的機率 ≥ θ 的那一根可以帶，另一根一定不帶；兩根都不到 θ 就都不帶。
 * 原本的隊已經符合時不動；不符合時改派符合的隊裡自己後驗最乾淨的一支。不適用時回傳原本的動作（同一個物件）。
 */
export function percivalThumbReadTeam(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  // Retired in round 39: with `percivalRead39` on, Percival's thumbs follow the round-39 read and plan only (never combined).
  const theta = (tuning.percivalRead39 ?? 0) > 0 ? 0 : tuning.percivalThumbRead ?? 0;
  if (!(theta > 0) || action.type !== 'team_select' || obs.myRole !== 'percival' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return action;
  const thumbs = obs.knownWizards ?? [];
  const round = obs.currentRound ?? 1;
  if (thumbs.length !== 2 || round < 2) return action;
  const results = obs.questResults ?? [];
  if (obs.questHistory.some((q) => q.round < round && results[q.round - 1] === 'success' && q.team.every((id) => action.teamIds.includes(id)))) return action;
  const opts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, opts);
  const barred = thumbs.filter((id) => 1 - (share.get(id) ?? 0.5) < theta);
  if (!action.teamIds.some((id) => barred.includes(id))) return action;
  const me = obs.myPlayerId;
  const pool = obs.allPlayerIds.filter((id) => id !== me && !barred.includes(id));
  const size = action.teamIds.length;
  if (pool.length < size - 1) return action;
  let best: { team: string[]; p: number } | null = null;
  for (const fill of combos(pool, size - 1)) {
    const team = [me, ...fill];
    if (!allowed(team)) continue;
    const p = bayesTeamClean(obs, team, opts);
    if (p === null) return action;
    if (!best || p - best.p > 1e-12) best = { team, p };
  }
  return best ? { type: 'team_select', teamIds: best.team } : action;
}

// ── 異常票的時機（`goodOnTeamState`、`goodReuseWhite`、`merlinOnTeamOwn`）──────────────

/** 這支隊包含最近一次成功任務的整支隊（整隊照派成功的隊）。 */
export function fullReuseOfLastSuccess(obs: PlayerObservation, team: readonly string[]): boolean {
  const round = obs.currentRound ?? 1;
  const results = obs.questResults ?? [];
  const succ = obs.questHistory.filter((q) => q.round < round && results[q.round - 1] === 'success').sort((a, b) => b.round - a.round)[0];
  return !!succ && succ.team.every((id) => team.includes(id));
}

/** 這一局之後（到強制局為止）還會輪到自己當隊長。 */
export function leadsLaterThisRound(obs: PlayerObservation): boolean {
  const ids = obs.allPlayerIds;
  const at = ids.indexOf(obs.currentLeader);
  if (at < 0) return false;
  const left = 4 - (obs.failCount ?? 0);
  for (let o = 1; o <= left; o++) if (ids[(at + o) % ids.length] === obs.myPlayerId) return true;
  return false;
}

/**
 * `goodOnTeamState`（真人牌譜同一點：機器人在隊上內黑、真人贊成的票 6,430 張，97% 是後驗門檻觸發；這些票若照機器人投會擋下 581 個提議，其中 62% 後來任務成功）。
 * 在隊上、第 3、4 局、後驗門檻原本要內黑時，回傳 true = 改成贊成：
 *   - 紅方還沒有兩勝：只有後驗幾乎確定（P(隊上的紅足以失敗) ≥ 0.99）才內黑（公開邏輯證明必敗的那一條在呼叫端之前就投了）；
 *   - 紅方已經兩勝（模式 2）：隊長整隊照派成功的隊 → 只有幾乎確定才內黑；否則要再有一個理由才內黑——自己這一局還會派、隊上有被湖宣告紅的人、或後驗 ≥ 0.9。
 * 第 5 局不適用（真人在 2:2 的內黑比機器人還多）。
 */
export function onTeamStateApprove(tuning: Readonly<AgentTuning>, obs: PlayerObservation, pFail: number, key: boolean): boolean {
  const mode = tuning.goodOnTeamState ?? 0;
  const round = obs.currentRound ?? 1;
  if (!(mode > 0) || round < 3 || round > 4) return false;
  if (!key) return pFail < 0.99;
  if (mode < 2) return false;
  const team = obs.proposedTeam ?? [];
  if (fullReuseOfLastSuccess(obs, team)) return pFail < 0.99;
  const declaredRed = (obs.lakeHistory ?? []).some((l) => l.declaredClaim === 'evil' && team.includes(l.targetId));
  return !(leadsLaterThisRound(obs) || declaredRed || pFail >= 0.9);
}

/**
 * `goodReuseWhite`（真人牌譜同一點：真人外白、機器人反對的票裡，任務結果支持的幾種）：不在隊上、這一局的第 1 次提議、隊長整隊照派最近成功任務的隊——
 *   - 第 4 局、藍 2:紅 1（真人外白 59%，三藍活局 63%；通過後任務失敗 10%——第 4 局要兩張失敗）；
 *   - 第 3 局、1:1，而且成功的是第 2 局（第 1 局失敗、第 2 局成功；真人這種提議 99% 出任務、失敗 19–23%）；第 1 局成功、第 2 局失敗之後不適用；
 *   - 模式 2：第 4 局、藍 1:紅 2（真人 35%；失敗 0%，n 61）。
 * 公開邏輯指出隊上有紅、被看起來是藍的持湖者宣告紅、自己湖的宣告不符，都在呼叫端之前就投反對了。
 */
export function reuseWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.goodReuseWhite ?? 0;
  if (!(mode > 0) || (obs.failCount ?? 0) !== 0) return false;
  const round = obs.currentRound ?? 1;
  const results = (obs.questResults ?? []).slice(0, round - 1);
  const s = results.filter((r) => r === 'success').length;
  const f = results.filter((r) => r === 'fail').length;
  // 第 3 局 1:1 只在「第 1 局失敗、第 2 局成功」之後：第 1 局成功、第 2 局照派之後失敗的那一隊，真人也不放行（出任務 0–1%），
  // 自我對打放行之後三藍率 55 → 47%（藏牌的紅在第 3 局出失敗）。
  // 第 4 局 2:1 不分順序：真人這種提議在「失敗、成功、成功」和「成功、失敗、成功」之後出任務 82–99%、失敗 5–16%；「成功、成功、失敗」之後
  // （最近的成功是第 2 局）真人幾乎不這樣派（4 次）。自我對打裡藍方隊長在這種局面整隊照派第 2 局的隊，通過之後任務失敗 3%，不像第 3 局「成功、失敗」那樣，
  // 而且第 4 局要兩張失敗，所以沒有拆開（拆開的版本沒有另外量）。
  const spot = (round === 4 && s === 2 && f === 1) || (round === 3 && s === 1 && f === 1 && results[1] === 'success') || (mode >= 2 && round === 4 && s === 1 && f === 2);
  if (!spot) return false;
  const team = obs.proposedTeam ?? [];
  if (team.includes(obs.myPlayerId)) return false;
  return fullReuseOfLastSuccess(obs, team);
}

/**
 * `goodFourthWhite`：第 3 局第 4 次提議、比分 1:1、自己不在隊上也不是強制局（第 5 次）的隊長；強制局的隊長不在這支隊上、而且上過失敗的任務 → 贊成。
 * 真人忠臣第 4 次提議的外白看的是「不要讓尾家來派」：尾家不在隊上 41%、在隊上 11%；1:1 時 27% vs 3%。0:2 不適用（真人在那裡外白通過的任務 76–79% 失敗）。
 */
export function fourthWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!((tuning.goodFourthWhite ?? 0) > 0) || (obs.failCount ?? 0) !== 3 || (obs.currentRound ?? 1) !== 3) return false;
  const results = (obs.questResults ?? []).slice(0, 2);
  if (results.filter((r) => r === 'success').length !== 1 || results.filter((r) => r === 'fail').length !== 1) return false;
  const ids = obs.allPlayerIds;
  const at = ids.indexOf(obs.currentLeader);
  if (at < 0) return false;
  const tail = ids[(at + 1) % ids.length];
  const team = obs.proposedTeam ?? [];
  if (tail === obs.myPlayerId || team.includes(obs.myPlayerId) || team.includes(tail)) return false;
  return obs.questHistory.some((q) => results[q.round - 1] === 'fail' && q.team.includes(tail));
}

/**
 * `percivalMerlinWhite=θ`：派西不在隊上，隊長是他後驗裡「是梅林」的機率 ≥ θ 的那一根拇指、另一根拇指不在隊上 → 贊成。
 * 梅林自己派的隊不會有他看得到的紅；派西分得出哪一根是梅林時，這是他才有的資訊。
 */
export function percivalMerlinWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const theta = tuning.percivalMerlinWhite ?? 0;
  if (!(theta > 0) || obs.myRole !== 'percival' || obs.publicLoyalView === true) return false;
  const thumbs = obs.knownWizards ?? [];
  if (thumbs.length !== 2 || !thumbs.includes(obs.currentLeader)) return false;
  const team = obs.proposedTeam ?? [];
  const other = thumbs.find((id) => id !== obs.currentLeader)!;
  if (team.includes(obs.myPlayerId) || team.includes(other) || !team.includes(obs.currentLeader)) return false;
  const share = bayesRedShare(obs, bayesOptionsOf(tuning));
  return 1 - (share.get(obs.currentLeader) ?? 0.5) >= theta;
}

/**
 * `merlinOwnWhite=θ`：梅林不在隊上、隊上沒有他看得到的紅、他自己的後驗 P(全藍) ≥ 0.9，而且只看公開紀錄的忠臣坐在他的位置估的 P(全藍) ≥ θ → 贊成。
 * 公開上說不過去的隊（θ 以下）不外白：梅林的外白要是同樣公開資訊的忠臣也可能投的票。
 */
export function merlinOwnWhiteNow(tuning: Readonly<AgentTuning>, obs: PlayerObservation, publicView: PlayerObservation): boolean {
  const theta = tuning.merlinOwnWhite ?? 0;
  if (!(theta > 0) || obs.myRole !== 'merlin') return false;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0 || team.includes(obs.myPlayerId) || team.some((id) => obs.knownEvils.includes(id))) return false;
  const opts = bayesOptionsOf(tuning);
  const own = bayesTeamClean(obs, team, opts);
  if (own === null || own < 0.9) return false;
  const pub = bayesTeamClean(publicView, team, opts);
  return pub !== null && pub >= theta;
}

/**
 * `goodEarlyVote`（第 1、2 局的異常票，Edward 11/04／11/10：前幾次提議不是注定被否決，異常票夠多就會出任務）：忠臣不在隊上、非強制，這一局自己先前派過隊，
 * 現在這支隊把他那一次派的人（自己以外）全部留下 → 贊成。真人忠臣在這個局面外白 12%（其他局面 2%）；出任務的機率照樣很低（要 6 票）。
 */
export function earlyOwnTeamWhite(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!((tuning.goodEarlyVote ?? 0) > 0) || obs.gamePhase !== 'team_vote' || obs.myRole !== 'loyal' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  const round = obs.currentRound ?? 1;
  if (round > 2 || (obs.failCount ?? 0) >= 4) return false;
  const me = obs.myPlayerId;
  const team = obs.proposedTeam ?? [];
  if (team.length === 0 || team.includes(me) || obs.currentLeader === me) return false;
  const mine = obs.voteHistory.filter((v) => v.round === round && v.leader === me);
  if (mine.length === 0) return false;
  const picks = mine[mine.length - 1].team.filter((id) => id !== me);
  return picks.length > 0 && picks.every((id) => team.includes(id));
}

/** 第 4 局第 1 次提議、要兩張失敗、第 3 局成功，而且第 3 局任務隊的每個人都在這支隊上（檢查表 AV-03／AV-07 的局面）。 */
export function r3TeamKeptAtR4(obs: PlayerObservation, team: readonly string[]): boolean {
  if ((obs.currentRound ?? 1) !== 4 || (obs.failCount ?? 0) !== 0 || failsNeeded(obs) < 2) return false;
  if ((obs.questResults ?? [])[2] !== 'success') return false;
  const q3 = obs.questHistory.find((q) => q.round === 3);
  return !!q3 && q3.team.every((id) => team.includes(id));
}

/**
 * `merlinOnTeamOwn`（檢查表 AV-11）：梅林在隊上、公開視角的門檻要他內黑（理由是機率門檻，不是公開邏輯）、而且隊上他看得到的紅不會當場輸掉時，
 * 要不要改成贊成。`ownClean`／`ownMordred` ＝他自己的後驗裡這支隊全藍的機率、他看不到的那個紅（莫德雷德）在隊上的機率。
 */
export function merlinOnTeamOwnApprove(mode: number, obs: PlayerObservation, seenOnTeam: number, ownClean: number | null, ownMordred: number | null): boolean {
  if (!(mode > 0)) return false;
  const round = obs.currentRound ?? 1;
  if (mode >= 4) return seenOnTeam === 0;
  if (round >= 5) return false;
  const redWins = (obs.questResults ?? []).filter((r) => r === 'fail').length;
  if (failsNeeded(obs) >= 2) {
    if (seenOnTeam === 0) return true;
    return seenOnTeam === 1 && ownMordred !== null && ownMordred < (redWins >= 2 ? 0.3 : 0.5);
  }
  if (seenOnTeam !== 0) return false;
  if (redWins < 2) return mode >= 2 && ownClean !== null && 1 - ownClean < 0.8;
  return mode >= 3 && ownMordred !== null && ownMordred < 0.3;
}

/** 這一局要幾張失敗牌任務才失敗。 */
export function failsNeeded(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount ?? obs.allPlayerIds.length]?.questFailsRequired?.[(obs.currentRound ?? 1) - 1] ?? 1;
}

// ── 藍方持湖的目標（`goodLakeHuman`、`percivalLakeNoMorgana`）──────────────

/**
 * 藍方持湖者的候選名單（原本的規則在這份名單裡挑）：
 *   - `percivalLakeNoMorgana`：派西不湖自己後驗裡比較像莫甘娜的那一根拇指；
 *   - `goodLakeHuman`：最近一次任務成功時，只留「上過那一次任務、沒上過失敗任務」的人（真人：把湖用來確認成功任務上的人，之後由他接著持湖）；沒有這樣的人就不限制。
 * 沒有任何限制適用時回傳原本的名單（同一個陣列）。
 */
export function goodLakeHumanPool(tuning: Readonly<AgentTuning>, obs: PlayerObservation, candidates: readonly string[]): readonly string[] {
  let pool = candidates;
  if (tuning.percivalLakeNoMorgana === true && obs.myRole === 'percival' && (obs.knownWizards ?? []).length === 2) {
    const share = bayesRedShare(obs, bayesOptionsOf(tuning));
    const [a, b] = obs.knownWizards as string[];
    const morgana = (share.get(a) ?? 0.5) > (share.get(b) ?? 0.5) ? a : (share.get(b) ?? 0.5) > (share.get(a) ?? 0.5) ? b : null;
    const kept = morgana ? pool.filter((id) => id !== morgana) : pool;
    if (kept.length > 0 && kept.length < pool.length) pool = kept;
  }
  if ((tuning.goodLakeHuman ?? 0) > 0) {
    const results = obs.questResults ?? [];
    const done = [...obs.questHistory].sort((x, y) => y.round - x.round);
    const last = done[0];
    if (last && results[last.round - 1] === 'success') {
      const stained = new Set(done.filter((q) => results[q.round - 1] === 'fail').flatMap((q) => q.team));
      const kept = pool.filter((id) => last.team.includes(id) && !stained.has(id));
      if (kept.length > 0 && kept.length < pool.length) pool = kept;
    }
  }
  return pool;
}
