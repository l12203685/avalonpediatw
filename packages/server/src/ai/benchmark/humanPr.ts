/**
 * 人類 PR 量尺的純函式（2026-11-03，`scripts/humanPrBenchmark.ts`）。
 *
 * 想法：機器人和人類在「同一個決策點」各做一個選擇，用人類資料估每個選擇的價值，再看機器人的選擇
 * 相當於哪個 PR 的人類。
 *
 *   1. 決策點：人類牌譜重播到那一刻（`replayObservation` 只給那個座位當時知道的東西）。機器人只看得到
 *      公開紀錄＋自己角色的資訊；**評分**用的局面特徵可以用真相（例如這隊實際有幾紅），因為那是裁判在
 *      打分數，不是給決策者的輸入——同一個裁判同時替人類和機器人打分數。
 *   2. 價值：優勢 A(s, a) = 在局面 s 選 a 的人類，他那一方最後贏的殘差（減掉陣容強度預期）平均，
 *      減掉局面 s 所有人類的平均；分層經驗貝氏收縮（細局面 → 粗局面 → 0）。用 5 折交叉擬合：
 *      一局的決策只用其他 4 折的局估出來的表打分數（不會拿自己這局的結果替自己加分）。
 *   3. 量尺：人類依座位 PR（開打前、時間相對、生涯 ≥ 30 場；暫定的不算）分 10 組。每組在自己的決策點上：
 *      人類平均優勢 vs 機器人在同一批決策點的平均優勢，差 Δ。Δ 隨 PR 遞減，Δ = 0 的 PR 就是機器人的等效 PR
 *      （加權直線擬合；配對比較，不受各組局面分布不同影響）。
 *   刺殺不用估：刺中 = 紅方贏，直接比刺中率。
 *
 * 是相關不是因果：A 包含「會選 a 的人通常還會做對別的事」。殘差化（扣掉陣容強度）只去掉一部分。
 */

import { AVALON_CONFIG } from '@avalon/shared';
import { campOf, type ReplayGame } from './sheetsReplay';

export type HumanPrDecision = 'team' | 'vote' | 'quest' | 'lakeTarget' | 'lakeClaim' | 'assassinate';

// ── 公開局面 ─────────────────────────────────────────────

/** 第 round 局開始前的比分「紅勝-藍勝」。 */
export function scoreBefore(game: ReplayGame, round: number): string {
  let red = 0;
  let blue = 0;
  for (const q of game.quests) {
    if (q.round >= round) break;
    if (q.failed) red++; else blue++;
  }
  return `${red}-${blue}`;
}

/** 第 round 局之前出過失敗任務的座位（公開）。 */
export function taintedBefore(game: ReplayGame, round: number): Set<number> {
  const out = new Set<number>();
  for (const q of game.quests) if (q.round < round && q.failed) for (const s of q.teamSeats) out.add(s);
  return out;
}

/** 第 round 局之前最近一次成功任務的隊伍（沒有 = null）。 */
export function lastSuccessTeam(game: ReplayGame, round: number): number[] | null {
  let team: number[] | null = null;
  for (const q of game.quests) if (q.round < round && !q.failed) team = q.teamSeats;
  return team;
}

/** 隊伍包含最近一次成功任務的全部隊員（照派成功的隊）。 */
export function isReuse(game: ReplayGame, round: number, team: readonly number[]): boolean {
  const last = lastSuccessTeam(game, round);
  return last !== null && last.every((s) => team.includes(s));
}

export function redsOn(game: ReplayGame, team: readonly number[]): number {
  return team.filter((s) => campOf(game.seatRoles[s - 1]) === 'evil').length;
}

/** "1,4,7" → [1,4,7]。 */
export function parseSeatList(text: string): number[] {
  return text.split(',').map((x) => Number.parseInt(x, 10)).filter((n) => Number.isFinite(n));
}

// ── 評分用的局面＋行動鍵（細 → 粗） ──────────────────────

/** 一個決策的分層鍵：levels[i] = [局面鍵, 行動鍵]，0 最細。 */
export interface KeyedAction {
  levels: Array<[string, string]>;
}

function side(game: ReplayGame, seat: number): string {
  return campOf(game.seatRoles[seat - 1]);
}

/** 投票：角色、局、第幾次、比分、在隊上／隊長、隊上實際紅數、隊上有出過失敗任務的人、照派。 */
export function voteKeys(game: ReplayGame, proposalIndex: number, seat: number, approve: boolean): KeyedAction {
  const p = game.proposals[proposalIndex];
  const role = game.seatRoles[seat - 1];
  const pos = p.leaderSeat === seat ? 'L' : p.teamSeats.includes(seat) ? 'on' : 'off';
  const reds = Math.min(3, redsOn(game, p.teamSeats));
  const tainted = taintedBefore(game, p.round);
  const t = p.teamSeats.some((s) => s !== seat && tainted.has(s)) ? 't1' : 't0';
  const reuse = isReuse(game, p.round, p.teamSeats) ? 'u1' : 'u0';
  const score = scoreBefore(game, p.round);
  const a = approve ? 'A' : 'R';
  return {
    levels: [
      [`${role}|R${p.round}|a${Math.min(4, p.attempt)}|${score}|${pos}|r${reds}|${t}|${reuse}`, a],
      [`${role}|R${p.round}|${score}|${pos}|r${reds}`, a],
      [`${side(game, seat)}|R${p.round}|${pos}|r${reds}`, a],
      [`${side(game, seat)}|${pos}|r${reds}`, a],
    ],
  };
}

/** 派隊：局面 = 角色、局、第幾次、比分；行動 = 自己在不在隊上、隊上實際紅數、出過失敗任務的人數、照派。 */
export function teamKeys(game: ReplayGame, proposalIndex: number, team: readonly number[]): KeyedAction {
  const p = game.proposals[proposalIndex];
  const seat = p.leaderSeat;
  const role = game.seatRoles[seat - 1];
  const self = team.includes(seat) ? 's1' : 's0';
  const reds = `r${Math.min(3, redsOn(game, team))}`;
  const tainted = taintedBefore(game, p.round);
  const t = `t${Math.min(2, team.filter((s) => s !== seat && tainted.has(s)).length)}`;
  const reuse = isReuse(game, p.round, team) ? 'u1' : 'u0';
  const score = scoreBefore(game, p.round);
  return {
    levels: [
      [`${role}|R${p.round}|a${p.attempt}|${score}`, `${self}${reds}${t}${reuse}`],
      [`${role}|R${p.round}|${score}`, `${self}${reds}${reuse}`],
      [`${side(game, seat)}|R${p.round}`, `${self}${reds}`],
      [side(game, seat), reds],
    ],
  };
}

/** 紅方任務牌（只有能確定的牌）：角色、局、比分、隊上紅數、需要幾張失敗。 */
export function questKeys(game: ReplayGame, round: number, seat: number, fail: boolean): KeyedAction {
  const q = game.quests.find((x) => x.round === round);
  const role = game.seatRoles[seat - 1];
  const evilOn = q ? redsOn(game, q.teamSeats) : 0;
  const need = AVALON_CONFIG[game.playerCount].questFailsRequired[round - 1];
  const score = scoreBefore(game, round);
  const a = fail ? 'F' : 'S';
  return {
    levels: [
      [`${role}|R${round}|${score}|e${evilOn}|n${need}`, a],
      [`${role}|R${round}|e${evilOn}|n${need}`, a],
      [`evil|R${round}|e${evilOn}|n${need}`, a],
      [`evil|e${evilOn}|n${need}`, a],
    ],
  };
}

/** 湖的目標：持湖角色、第幾局後、比分；行動 = 目標實際陣營、目標出過失敗任務。 */
export function lakeTargetKeys(game: ReplayGame, lakeIndex: number, target: number): KeyedAction {
  const lake = game.lakes[lakeIndex];
  const role = game.seatRoles[lake.holderSeat - 1];
  const camp = campOf(game.seatRoles[target - 1]) === 'evil' ? 'red' : 'blue';
  const tainted = taintedBefore(game, lake.round + 1).has(target) ? 't1' : 't0';
  const score = scoreBefore(game, lake.round + 1);
  return {
    levels: [
      [`${role}|L${lake.round}|${score}`, `${camp}${tainted}`],
      [`${role}|L${lake.round}`, `${camp}${tainted}`],
      [side(game, lake.holderSeat), `${camp}${tainted}`],
      [side(game, lake.holderSeat), camp],
    ],
  };
}

/** 湖的宣告：持湖角色、第幾局後、目標實際陣營；行動 = 說真話／說謊。 */
export function lakeClaimKeys(game: ReplayGame, lakeIndex: number, claim: 'good' | 'evil' | 'none'): KeyedAction {
  const lake = game.lakes[lakeIndex];
  const role = game.seatRoles[lake.holderSeat - 1];
  const truth = campOf(game.seatRoles[lake.targetSeat - 1]);
  const a = claim === 'none' ? 'none' : claim === truth ? 'truth' : 'lie';
  return {
    levels: [
      [`${role}|L${lake.round}|${truth}`, a],
      [`${role}|${truth}`, a],
      [`${side(game, lake.holderSeat)}|${truth}`, a],
      [side(game, lake.holderSeat), a],
    ],
  };
}

// ── 優勢表（分層經驗貝氏） ───────────────────────────────

export interface AdvantageSample {
  keys: KeyedAction;
  /** 結果殘差（那一方贏 1／輸 0，減掉陣容強度預期）。 */
  residual: number;
}

interface Cell { n: number; sum: number }

export interface AdvantageTable {
  /** levels[i]：局面鍵 → { 局面的 n、sum；行動鍵 → n、sum }。 */
  levels: Array<Map<string, { state: Cell; actions: Map<string, Cell> }>>;
  shrink: number;
}

export function fitAdvantageTable(samples: readonly AdvantageSample[], shrink = 30): AdvantageTable {
  const depth = samples.length > 0 ? samples[0].keys.levels.length : 0;
  const levels = Array.from({ length: depth }, () => new Map<string, { state: Cell; actions: Map<string, Cell> }>());
  for (const smp of samples) {
    smp.keys.levels.forEach(([sk, ak], i) => {
      let st = levels[i].get(sk);
      if (!st) { st = { state: { n: 0, sum: 0 }, actions: new Map() }; levels[i].set(sk, st); }
      st.state.n += 1;
      st.state.sum += smp.residual;
      const c = st.actions.get(ak) ?? { n: 0, sum: 0 };
      c.n += 1;
      c.sum += smp.residual;
      st.actions.set(ak, c);
    });
  }
  return { levels, shrink };
}

/**
 * 收縮後的優勢：最粗一層往 0 收縮，每一層往上一層（較粗）收縮：
 * Â_i = (n·(mean(s,a) − mean(s)) + m·Â_{i+1}) / (n + m)。沒看過的行動（n = 0）= 上一層的值。
 */
export function advantage(table: AdvantageTable, keys: KeyedAction): number {
  let prior = 0;
  for (let i = keys.levels.length - 1; i >= 0; i--) {
    const [sk, ak] = keys.levels[i];
    const st = table.levels[i]?.get(sk);
    const c = st?.actions.get(ak);
    if (!st || !c || c.n === 0) continue;
    const raw = c.sum / c.n - st.state.sum / st.state.n;
    prior = (c.n * raw + table.shrink * prior) / (c.n + table.shrink);
  }
  return prior;
}

// ── 交叉擬合、陣容預期 ──────────────────────────────────

/** 局 id → 折（0..k-1），只看 id，跟順序無關。 */
export function foldOf(gameId: string, k = 5): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < gameId.length; i++) {
    h ^= gameId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % k;
}

/** 一維邏輯迴歸（截距＋斜率），牛頓法；回傳 [α, β]。 */
export function fitLogistic(xs: readonly number[], ys: readonly number[], iters = 25): [number, number] {
  let a = 0;
  let b = 0;
  for (let it = 0; it < iters; it++) {
    let ga = 0; let gb = 0; let haa = 0; let hab = 0; let hbb = 0;
    for (let i = 0; i < xs.length; i++) {
      const p = 1 / (1 + Math.exp(-(a + b * xs[i])));
      const w = p * (1 - p);
      ga += ys[i] - p;
      gb += (ys[i] - p) * xs[i];
      haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  return [a, b];
}

// ── PR 分組與等效 PR ───────────────────────────────────

export const PR_BUCKETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90] as const;

/** PR → 分組下界（90 含 100）；暫定或沒有 lineup = null。 */
export function prBucket(pr: number | undefined | null, provisional: boolean | undefined | null): number | null {
  if (pr === undefined || pr === null || provisional) return null;
  return Math.min(90, Math.floor(pr / 10) * 10);
}

export interface BucketDelta {
  /** 分組下界。 */
  bucket: number;
  n: number;
  /** 這組人類在自己的決策點的平均（優勢或刺中率）。 */
  human: number;
  /** 機器人在同一批決策點的平均。 */
  bot: number;
}

/**
 * Δ = bot − human 對分組中點（下界 + 5）做加權直線擬合（權重 n），Δ = 0 的 PR = 等效 PR。
 * 斜率 ≥ 0（人類沒有隨 PR 變好的梯度）= null。clamped = 超出 0..100 被夾住。
 */
export function equivalentPr(rows: readonly BucketDelta[]): { pr: number | null; slope: number; intercept: number; clamped: boolean } {
  const pts = rows.filter((r) => r.n > 0);
  const W = pts.reduce((a, r) => a + r.n, 0);
  if (pts.length < 2 || W === 0) return { pr: null, slope: 0, intercept: 0, clamped: false };
  const mx = pts.reduce((a, r) => a + r.n * (r.bucket + 5), 0) / W;
  const my = pts.reduce((a, r) => a + r.n * (r.bot - r.human), 0) / W;
  const sxx = pts.reduce((a, r) => a + r.n * (r.bucket + 5 - mx) ** 2, 0);
  const sxy = pts.reduce((a, r) => a + r.n * (r.bucket + 5 - mx) * (r.bot - r.human - my), 0);
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  if (slope >= 0) return { pr: null, slope, intercept, clamped: false };
  const raw = -intercept / slope;
  const pr = Math.max(0, Math.min(100, raw));
  return { pr, slope, intercept, clamped: pr !== raw };
}

/** 人類平均對 PR 的加權直線斜率（每 10 PR）：量尺有沒有梯度。 */
export function humanSlopePer10(rows: readonly BucketDelta[]): number {
  const pts = rows.filter((r) => r.n > 0);
  const W = pts.reduce((a, r) => a + r.n, 0);
  if (pts.length < 2 || W === 0) return 0;
  const mx = pts.reduce((a, r) => a + r.n * r.bucket, 0) / W;
  const my = pts.reduce((a, r) => a + r.n * r.human, 0) / W;
  const sxx = pts.reduce((a, r) => a + r.n * (r.bucket - mx) ** 2, 0);
  const sxy = pts.reduce((a, r) => a + r.n * (r.bucket - mx) * (r.human - my), 0);
  return sxx > 0 ? (sxy / sxx) * 10 : 0;
}
