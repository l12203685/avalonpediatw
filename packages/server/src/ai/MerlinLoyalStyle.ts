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
import { bayesTeamClean } from './belief/BayesBelief';
import { merlinSignalScore } from './belief/ZoneModel';

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
): AgentAction {
  if (!tuning.merlinLoyalStyle || action.type !== 'team_select' || obs.myRole !== 'merlin') return action;
  const me = obs.myPlayerId;
  const seen = new Set(obs.knownEvils);
  const pool = obs.allPlayerIds.filter((id) => id !== me && !seen.has(id));
  const size = action.teamIds.length;
  if (pool.length < size - 1) return action;
  // The public loyal view of my own seat: the same records, none of Merlin's sight.
  const publicView = { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const prior = obs.voteHistory.filter((p) => p.round <= 2 && p.leader !== me).map((p) => ({ leader: p.leader, team: p.team }));
  const scored: { team: string[]; score: number }[] = [];
  for (const fill of combinations(pool, size - 1)) {
    const team = [me, ...fill];
    const p = bayesTeamClean(publicView, team) ?? 0;
    // Loyal plausibility first; the extension / correction / zone signal only breaks near-ties.
    scored.push({ team, score: Math.log(Math.max(p, 1e-12)) + 0.05 * merlinSignalScore(obs.allPlayerIds, team, seen, prior, me) });
  }
  // Highest first (stable); the logic gates (must-fail / dominated) still bind.
  scored.sort((x, y) => y.score - x.score);
  const best = scored.find((c) => allowed(c.team));
  return best ? { type: 'team_select', teamIds: best.team } : action;
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
  const opts = { strictMerlin: tuning.percivalThumbLogic === true, thumbRoles: tuning.bayesThumbRoles === true };
  const publicView = { ...obs, myRole: 'loyal', knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
  const scored: { team: string[]; score: number }[] = [];
  for (const fill of combinations(others, size - 1)) {
    const team = [me, ...fill];
    const priv = bayesTeamClean(obs, team, opts) ?? 0;
    const pub = bayesTeamClean(publicView, team) ?? 0;
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
  const p = bayesTeamClean(publicView, team) ?? 0;
  if (p < Math.max(tuning.goodCleanVote || 0.25, 0.25)) return false;
  let h = 0x811c9dc5;
  for (const c of `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${team.join(',')}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < q;
}
