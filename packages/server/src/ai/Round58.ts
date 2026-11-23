/**
 * 第 58 回合（梅林）：站長 2026-11-20 在私人主控台回答「梅林在注定被否決的提議照公開視角派，算不算順應局勢」（原話）：
 *
 * > 算順應局勢 但應該說 要從公開資訊中找到符合自己內建資訊 盡可能避開三個可見紅方拇指的隊伍資訊。我補充一點 除非逼不得已
 * > 沒辦法不用超前資訊就派不出全沒姆指的組合 => 這時只能依據忠臣資訊去派拇指了
 *
 * 現行預設（`merlinLoyalStyle`）：梅林在「不帶他看得到的紅」的隊裡挑公開視角最乾淨的那支——不管那支在公開上說不說得通。
 * 公開上說得通的隊全都帶拇指時，梅林仍然派一支乾淨、但公開上很勉強的隊，就是用了超前資訊（刺客讀得到）。
 *
 * `merlinPublicThumb58 = r`（0–1，0 = 關）：
 *   1. 公開上說得通的隊 = 坐在梅林位置、只看公開紀錄的忠臣算的「這隊沒有紅」機率 ≥ 最高的 r 倍（過公開視角的邏輯閘門；不放梅林自己確定、但看不到的紅，
 *      也不放第 54 回合擋下的出過失敗任務的可見紅）。
 *   2. 裡面有不帶看得到的紅、也過梅林自己關卡的隊 → 照舊（和現行預設同一支）。
 *   3. 沒有 → 照公開視角的忠臣派（公開機率最高、同分看延伸前面的派票、再同分照局面雜湊；拇指在不在隊上由公開局勢決定）。
 * `merlinPublicThumbScope58`：第 3 步（照公開視角派拇指）用在哪些提議。0／1 = 出任務的機率低於一成的提議（第 1、2 局非強制，
 *   `BlueRound37.PROPOSAL_GO_RATE`，同 `merlinFlowFollow`）；2 = 每一次非強制的提議；3 = 每一次提議；4 = 不用（只用 `merlinOwnRank58`）。範圍外照現行（乾淨的隊裡公開最乾淨的）。
 * `merlinOwnRank58 = r′`（0–1，0 = 關；「符合自己內建資訊」）：第 1 步在公開上說得通的乾淨隊裡，先比梅林自己的「這隊沒有紅」機率（他看得到的紅＋用私人資訊推得到的莫德雷德），
 *   同分再照現行的公開分數；每一次梅林照忠臣方式的提議都用（第 3 步仍照上面的範圍）。
 *   驗收案例：2026-11-20 網站 Room-17 一局（DC #牌譜紀錄與覆盤；決策 #130），梅林 5 家看得到 1、3、10，第 1 局 456 失敗 → 莫德雷德在 4、6 之一；
 *   3-5 現行仍派帶 6 的隊（6 = 莫德雷德，任務失敗、紅方三勝）。公開上說得通、又完全避開 4、6 的隊存在，梅林就該派那一支。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesTeamClean, type BayesOptions } from './belief/BayesBelief';
import { merlinSignalScore } from './belief/ZoneModel';
import { PROPOSAL_GO_RATE } from './BlueRound37';
import { forcedThumbGate64, goodLeadersCanGoClean64, oneThumbTeam64, temperedPick64 } from './Round64';

/** 診斷計數（`merlinPublicThumbStudy`、自我對打的拆解用；不影響決策）。 */
export const round58Stats = { applies: 0, cleanKept: 0, fallback: 0, fallbackThumb: 0, ownChanged: 0 };

/** 這一次梅林的提議要不要套第 58 回合的規則（第 3 步的範圍另外看 `publicThumb58FallbackOn`）。 */
export function publicThumb58Applies(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (obs.myRole !== 'merlin') return false;
  return (tuning.merlinOwnRank58 ?? 0) > 0 || publicThumb58FallbackOn(tuning, obs);
}

/** 第 3 步（逼不得已照公開視角派拇指）在這一次提議用不用。 */
export function publicThumb58FallbackOn(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  if (!((tuning.merlinPublicThumb58 ?? 0) > 0) || obs.myRole !== 'merlin') return false;
  const scope = tuning.merlinPublicThumbScope58 ?? 0;
  const fc = obs.failCount ?? 0;
  if (scope >= 4) return false;
  if (scope === 3) return true;
  if (fc >= 4) return false;
  if (scope === 2) return true;
  const round = obs.currentRound ?? 1;
  return round <= 2 && (PROPOSAL_GO_RATE[round]?.[fc] ?? 1) < 0.1;
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

export interface PublicThumb58Ctx {
  publicView: PlayerObservation;
  pubOpts: BayesOptions;
  /** 梅林不能放的人（第 54 回合擋下的可見紅、自己確定但看不到的紅）。 */
  barred: readonly string[];
  /** 這一局前面的提議（延伸訊號用；不用梅林的視角）。 */
  prior: readonly { leader: string; team: readonly string[] }[];
  /** 梅林自己的「這隊沒有紅」機率（`merlinOwnRank58`）；沒給 = 不比。 */
  ownClean?: (team: readonly string[]) => number;
  /** 第 64 回合 G4：照機器人忠臣派法推測別的座位當隊長會派的隊（`Round64.forecastView64` 的觀察）。沒給 = 不推測。 */
  forecast?: (view: PlayerObservation) => string[] | null;
}

/**
 * 第 58 回合的挑法。`clean` = 現行預設的候選（不帶看得到的紅，已照現行的分數排好，每支帶公開的「沒有紅」機率 p）。
 * 回傳要派的隊；公開上說得通的乾淨隊存在、而且現行的那支就是 → 回傳現行的那支（決策不變）。沒有可派的 → null（照現行）。
 */
export function publicThumb58Team(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  size: number,
  clean: readonly { team: string[]; p: number }[],
  allowed: (team: readonly string[]) => boolean,
  publicAllowed: (team: readonly string[]) => boolean,
  ctx: PublicThumb58Ctx,
): string[] | null {
  // 「說得通」的倍數：有 `merlinPublicThumb58` 用它，否則用 `merlinOwnRank58` 的值（只比自己的乾淨機率、不派拇指）。
  const r = Math.min((tuning.merlinPublicThumb58 ?? 0) > 0 ? tuning.merlinPublicThumb58 : tuning.merlinOwnRank58 ?? 0, 1);
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const none = new Set<string>();
  const salt = `${me}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|publicThumb58`;
  const pool = obs.allPlayerIds.filter((id) => id !== me && !ctx.barred.includes(id));
  if (pool.length < size - 1) return null;
  const pub: { team: string[]; p: number; score: number }[] = [];
  for (const fill of combinations(pool, size - 1)) {
    const team = [me, ...fill];
    if (!publicAllowed(team)) continue;
    const p = bayesTeamClean(ctx.publicView, team, ctx.pubOpts) ?? 0;
    let h = 0x811c9dc5;
    for (const ch of `${salt}|${team.join(',')}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    pub.push({ team, p, score: Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, none, ctx.prior, me) + 1e-9 * (h % 1000) });
  }
  if (pub.length === 0) return null;
  round58Stats.applies++;
  const top = Math.max(...pub.map((c) => c.p));
  const floor = r * top - 1e-12;
  const ok = clean.filter((c) => c.p >= floor && allowed(c.team));
  const keepClean = (): string[] | null => {
    if (ok.length === 0) return null;
    round58Stats.cleanKept++;
    if (!ctx.ownClean || (tuning.merlinOwnRank58 ?? 0) <= 0) return ok[0].team;
    // 「符合自己內建資訊」：說得通的乾淨隊裡，梅林自己最確定沒有紅的那支（同分照現行的順序）。
    const own = ok.map((c, i) => ({ team: c.team, q: ctx.ownClean!(c.team), i }));
    own.sort((x, y) => (Math.abs(y.q - x.q) > 1e-9 ? y.q - x.q : x.i - y.i));
    if (own[0].i !== 0) round58Stats.ownChanged++;
    return own[0].team;
  };
  // 第 64 回合 G4（站長 11/23）：要派拇指之前，先推測後面的好人隊長派不派得出沒有拇指的隊；派得出就不刻意放可見紅（null = 現行的乾淨隊）。
  const forecastOn = (tuning.merlinForecast64 ?? 0) > 0 && ctx.forecast !== undefined;
  // 第 64 回合 G5（Gemini 問題四）：「逼不得已」改成量化的條件，最多一根拇指。
  const theta = tuning.merlinForcedThumbGate64 ?? 0;
  if (theta > 0 && publicThumb58FallbackOn(tuning, obs)) {
    if (forcedThumbGate64(theta, obs, { pub, clean: clean.filter((c) => allowed(c.team)) }) === 'clean') return keepClean();
    const one = oneThumbTeam64(obs, pub);
    if (!one) return keepClean();
    if (forecastOn && goodLeadersCanGoClean64(tuning, obs, ctx.forecast!)) return keepClean();
    round58Stats.fallback++;
    round58Stats.fallbackThumb++;
    return one;
  }
  if (ok.length > 0) return keepClean();
  if (!publicThumb58FallbackOn(tuning, obs)) return null;
  // 逼不得已：公開上說得通的隊全都帶拇指 → 照公開視角的忠臣派。
  pub.sort((x, y) => y.score - x.score);
  let pick = pub.find((c) => c.team.some((id) => seen.has(id)) || allowed(c.team))?.team ?? null;
  if (!pick) return null;
  if (forecastOn && pick.some((id) => seen.has(id))) {
    if (goodLeadersCanGoClean64(tuning, obs, ctx.forecast!)) return null;
    if (((tuning.merlinForecast64 ?? 0) & 4) !== 0) pick = temperedPick64(obs, pub, floor, allowed) ?? pick;
  }
  round58Stats.fallback++;
  if (pick.some((id) => seen.has(id))) round58Stats.fallbackThumb++;
  return pick;
}
