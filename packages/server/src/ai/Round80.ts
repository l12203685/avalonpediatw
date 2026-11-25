/**
 * 第 80 回合（藍方・梅林）：站長 2026-11-25 更正第 77 回合「梅林學忠臣」的意思（原話）：
 *
 * > 梅林學忠臣的意思是 在忠臣資訊視角內 可以派出的全沒拇指組合 但如果只用忠臣資訊一定會派到拇指 那當然還是用能力避開
 *
 * 第 77 回合的 `merlinCover77` 是「照抄忠臣會派的那一隊」（帶到看得到的紅 59–61%），不是這個意思。這裡的意思是：
 *   1. 「忠臣說得通的隊」= 坐在梅林位置、只看公開紀錄的忠臣算的「這隊沒有紅」機率 ≥ 最高的 r 倍（含自己；過公開視角的邏輯閘門；
 *      和現行梅林挑隊用的是同一個分數 `MerlinLoyalStyle.merlinPublicScoring`，也就是第 58 回合 `merlinPublicThumb58` 的「說得通」）。
 *   2. 裡面有不帶他看得到的紅（拇指 = 刺客、莫甘娜、奧伯倫）、也過他自己關卡的隊 → 派其中最好的一支（現行的那支就在裡面就照舊）。
 *   3. 一支都沒有 → 用他自己的資訊避開：不帶看得到的紅、公開分數最高的那支（現行挑的隊本來就乾淨就照舊）。
 * 和現行預設不同的只有現行會帶拇指的那幾條路——照派帶拇指的成功隊（`merlinReuseNorm`）、順著全場帶同一個拇指（`merlinFlowFollow`）、
 * 第 58 回合「逼不得已照公開視角派拇指」（`merlinPublicThumb58` 的第 3 步，站長 11/20 的寫法；11/25 改成「用能力避開」）——
 * 以及現行挑的乾淨隊不在說得通的範圍裡、而範圍裡另有乾淨隊的時候。
 *
 * `merlinLoyalFree80 = r`（0–1，0 = 關）：「說得通」的倍數。
 * `merlinLoyalFreeScope80`（位元，0 = 每一局的第 1–4 次提議、找不到就用能力避開、照現行的順序挑）：
 *   1 = 只有第 1、2 局非強制（出任務的機率低於一成，`BlueRound37.PROPOSAL_GO_RATE`，同 `merlinPublicThumb58` 的範圍）；
 *   2 = 強制局（第 5 次）也用；4 = 說得通的隊全都帶拇指時照現行（不改成用能力避開）；
 *   8 = 說得通的乾淨隊裡先比梅林自己的「這隊沒有紅」機率（他看得到的紅＋自己確定的紅，同 `merlinOwnRank58`），同分照現行的分數；
 *   16 = 站長之前允許的帶拇指照舊：照派成功的隊（11/09「本來就可以照派成功隊」）、順著全場帶同一個拇指（11/10「全場都派 7…梅林也只能派 7」）——只換掉其他的拇指。
 * A0／A1 不相干（只改梅林自己當隊長的提議；邏輯閘門照舊擋）。
 */
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { bayesOptionsOf, bayesTeamClean } from './belief/BayesBelief';
import { merlinSignalScore } from './belief/ZoneModel';
import { r1Scorer, r1SpreadActive } from './BlueRound33';
import { PROPOSAL_GO_RATE } from './BlueRound37';
import { merlinFlowRed, merlinPublicScoring, merlinReuseNormTeam } from './MerlinLoyalStyle';

/** 診斷計數（研究腳本、自我對打的拆解用；不影響決策）。 */
export const round80Stats = {
  applies: 0, kept: 0, toClean: 0, fromThumb: 0, fallback: 0, fallbackClean: 0, setSize: 0, cleanInSet: 0,
};

/** 這一次梅林的提議要不要套第 80 回合的規則。 */
export function loyalFree80Applies(tuning: Readonly<Partial<AgentTuning>>, obs: PlayerObservation): boolean {
  if (!((tuning.merlinLoyalFree80 ?? 0) > 0) || obs.myRole !== 'merlin' || obs.gamePhase !== 'team_select') return false;
  const bits = tuning.merlinLoyalFreeScope80 ?? 0;
  const fc = obs.failCount ?? 0;
  if (fc >= 4) return (bits & 2) !== 0;
  if ((bits & 1) !== 0) {
    const round = obs.currentRound ?? 1;
    return round <= 2 && (PROPOSAL_GO_RATE[round]?.[fc] ?? 1) < 0.1;
  }
  return true;
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) { acc.push(items[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  return out;
}

export interface LoyalFree80Set {
  /** 每一支候選隊（含自己）：公開的「這隊沒有紅」機率、現行梅林的排序分數、帶幾個看得到的紅、過不過公開視角的閘門、在不在說得通的範圍裡。 */
  teams: { team: string[]; p: number; score: number; thumbs: number; publicOk: boolean; plausible: boolean }[];
  /** 過公開閘門的隊裡最高的公開機率。 */
  top: number;
}

/**
 * 說得通的範圍（研究腳本也用）：`barred` = 梅林不放的人（第 54 回合擋下的可見紅、他自己確定但看不到的紅），不在候選池裡；
 * `publicAllowed` = 公開視角的邏輯閘門（過不了的隊不算說得通，最高機率也不算它）。沒有過得了公開閘門的隊時 null。
 */
export function loyalFree80Set(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  size: number,
  r: number,
  publicAllowed: (team: readonly string[]) => boolean,
  barred: readonly string[],
): LoyalFree80Set | null {
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const pool = obs.allPlayerIds.filter((id) => id !== me && !barred.includes(id));
  if (pool.length < size - 1) return null;
  const { publicView, pubOpts, zoneWeight, prior } = merlinPublicScoring(tuning, obs);
  const teams: LoyalFree80Set['teams'] = [];
  for (const fill of combinations(pool, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team, pubOpts) ?? 0;
    const score = Math.log(Math.max(p, 1e-12)) + (zoneWeight > 0 ? zoneWeight * merlinSignalScore(obs.allPlayerIds, team, seen, prior, me) : 0);
    teams.push({ team, p, score, thumbs: team.filter((id) => seen.has(id)).length, publicOk: publicAllowed(team), plausible: false });
  }
  const ok = teams.filter((t) => t.publicOk);
  if (ok.length === 0) return null;
  const top = Math.max(...ok.map((t) => t.p));
  const floor = Math.min(r, 1) * top - 1e-12;
  for (const t of ok) t.plausible = t.p >= floor;
  return { teams, top };
}

const keyOf = (team: readonly string[]): string => [...team].sort().join(',');

/** 現行那一支是照派成功的隊（`merlinReuseNorm`）或順著全場帶的那根拇指（`merlinFlowFollow`）。 */
function reuseOrFlow80(tuning: Readonly<AgentTuning>, obs: PlayerObservation, cur: readonly string[], publicAllowed: (team: readonly string[]) => boolean): boolean {
  const flow = merlinFlowRed(tuning, obs);
  if (flow !== null && cur.includes(flow)) return true;
  const norm = merlinReuseNormTeam(tuning, obs, cur.length, publicAllowed);
  return norm !== null && keyOf(norm) === keyOf(cur);
}

/**
 * 第 80 回合的挑法：`cur` = 現行預設這一次會派的隊；`allowed` = 梅林自己的關卡（邏輯閘門、湖、證明的紅）；`publicAllowed` = 公開視角的邏輯閘門；
 * `barred` = 梅林不放的人。回傳要派的隊（不改就是 `cur` 本身）。
 */
export function loyalFree80Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  cur: readonly string[],
  allowed: (team: readonly string[]) => boolean,
  publicAllowed: (team: readonly string[]) => boolean,
  barred: readonly string[],
): readonly string[] {
  if (!loyalFree80Applies(tuning, obs) || cur.length === 0) return cur;
  const bits = tuning.merlinLoyalFreeScope80 ?? 0;
  // 位元 16：站長之前允許的兩種帶拇指照舊——照派成功的隊（11/09「本來就可以照派成功隊」，`merlinReuseNorm`）、順著全場帶同一個拇指（11/10，`merlinFlowFollow`）。
  if ((bits & 16) !== 0 && reuseOrFlow80(tuning, obs, cur, publicAllowed)) return cur;
  const r = tuning.merlinLoyalFree80 ?? 0;
  const set = loyalFree80Set(tuning, obs, cur.length, r, publicAllowed, barred);
  if (!set) return cur;
  round80Stats.applies++;
  const seen = new Set(obs.knownEvils);
  const curThumb = cur.some((id) => seen.has(id));
  const plausible = set.teams.filter((t) => t.plausible);
  round80Stats.setSize += plausible.length;
  const clean = plausible.filter((t) => t.thumbs === 0 && allowed(t.team));
  if (clean.length > 0) round80Stats.cleanInSet++;
  // 現行那一支乾淨、又在說得通的範圍裡 → 照舊。現行那一支不含自己（第 3 局起照派人數已滿的成功隊）時直接算它的公開機率。
  if (!curThumb) {
    const k = keyOf(cur);
    const mine = set.teams.find((t) => keyOf(t.team) === k);
    let curPlausible = mine?.plausible ?? false;
    if (!mine && publicAllowed(cur)) {
      const { publicView, pubOpts } = merlinPublicScoring(tuning, obs);
      curPlausible = (bayesTeamClean(publicView, [...cur], pubOpts) ?? 0) >= Math.min(r, 1) * set.top - 1e-12;
    }
    if (curPlausible) { round80Stats.kept++; return cur; }
  }
  if (clean.length > 0) {
    // 說得通的乾淨隊裡最好的一支：現行的順序（第 1 局 `loyalR1Spread` 開著時照它的分數，否則公開分數）；位元 8 先比梅林自己的乾淨機率。
    const spread = r1SpreadActive(tuning, obs);
    const r1 = spread ? r1Scorer(tuning, obs, spread) : null;
    const ownOpts = (bits & 8) !== 0 ? bayesOptionsOf(tuning) : null;
    const ranked = clean.map((t) => ({ ...t, own: ownOpts ? bayesTeamClean(obs, t.team, ownOpts) ?? 0 : 0, r1: r1 ? r1(t.team) : 0 }));
    ranked.sort((x, y) => (Math.abs(y.own - x.own) > 1e-9 ? y.own - x.own : Math.abs(x.r1 - y.r1) > 1e-9 ? x.r1 - y.r1 : y.score - x.score));
    round80Stats.toClean++;
    if (curThumb) round80Stats.fromThumb++;
    return ranked[0].team;
  }
  // 說得通的隊全都帶拇指（或乾淨的都過不了他的關卡）。
  round80Stats.fallback++;
  if ((bits & 4) !== 0 || !curThumb) return cur;
  // 用能力避開：不帶看得到的紅、過他自己關卡、公開分數最高的那支（和現行 `merlinLoyalStyleTeam` 最後一步同一個排序）。
  const avoid = set.teams.filter((t) => t.thumbs === 0 && allowed(t.team)).sort((x, y) => y.score - x.score);
  if (avoid.length === 0) return cur;
  round80Stats.fallbackClean++;
  return avoid[0].team;
}
