/**
 * 第 43 回合（藍方）：替梅林擋刀——忠臣／派西第 1、2 局的提議去相關（`loyalFresh43`）。
 *
 * 依據（`docs/ai/wiki_sop_map.md` 第 6.1 節第 1 項，百科 B27／B19／B7）：
 *   - B27（進階思考〈GTO〉）：被針對的位置，各角色都以高比例拆車；雜魚至少一半拆車掩護梅林；各角色行動整體均衡。
 *   - B19（遊戲分支與廣泛性）：在合理前提下保留多條故事線，讓能力者有空間。
 *   - B7（不要無腦疊票）：1-4 之前某人最好不要超過三票；站長 11/09 更正為「適時疊票、適時分散」。
 * 量到的問題（第 37–38 回合）：機器人忠臣一直疊同一批人——梅林坐 6 號時，忠臣第 2 局第一次提議帶的三個人在第 1 局平均被派過 2.21 次、
 * 沒被派過的 0.08 人；梅林 1.80 次、0.25 人；真人三個角色 1.53–1.57 次、0.37–0.45 人。梅林疊不了（有他看得到的紅），於是成了唯一「不一樣」的人。
 *
 * 規則：忠臣（位元 1）／派西（位元 2）在第 1 局（位元 4）／第 2 局（位元 8）非強制的提議，隊上（自己以外）至少要有一個
 * 「前面的提議還沒派過」而且自己後驗紅的機率 < τ 的人（位元 16：「前面」算整場；不設只算這一局）。已經有就不動；
 * 沒有的話，把隊上自己以外紅的機率最高的一個換成這樣的人，挑換完自己後驗最乾淨、過好人的閘門與自己的投票規則的那一支。
 * 同分（換出的人紅的機率同分、換完一樣乾淨）時在所有同分的（換出, 換進）組合裡用亂數挑，不照座位或隊伍名單的順序。
 * 位元 32：換的時候也不和這一局前面看起來偏藍（紅的機率 < 0.5）的隊長的提議重疊超過 1 人（自己以外）。
 * 位元 64：第 2 局只在第 1 局失敗之後。
 * 不碰梅林（梅林照原本的規則）；照派成功任務的隊不動；這一局（或整場）前面沒有提議時不適用。
 *
 * 第 43b 回合（站長 11/17 對 `loyalFresh43=5` 的回覆：「從第 3 家之後才開始考慮」「2 家直接派 1 家沒派過的人反而很像打對立」，
 * 百科〈解讀前人派票〉的 1AB／2CD、1AB／2BC、12A／2AB／2BC、13A／2AB／23B／2BC 與 3 家的反對／尊重／認同），只在第 1 局：
 *   - 位元 128：第 2 家（這一局第 2 個提議）不套用，第 3 家起才套用原本的規則。
 *   - 位元 256「延伸」：第 2 家至少留一個第 1 家的隊員（第 1 家隊長以外），也至少放一個第 1 家沒派過、自己後驗不差的人。
 *   - 位元 512「不重複」：第 2 家隊上（自己以外）沒有第 1 家隊上的人。
 *   - 位元 1024「第 3 家起尊重」：前面每一個提議的隊員、以及這一局還沒人派過的人，各區（自己以外）最多選一個（百科的「尊重」）。
 *   這幾條用 `minimalSwapTeam` 換最少的人；沒設的那一家照原本的規則（位元 256／512 的第 3 家起、位元 128 的第 3 家起）。
 */
import type { AgentAction, PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from './belief/BayesBelief';

type Allowed = (team: readonly string[]) => boolean;

/** 這個座位這一次提議適不適用 `loyalFresh43`（不看隊伍內容）。 */
export function loyalFresh43Applies(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const mode = tuning.loyalFresh43 ?? 0;
  if (!(mode > 0) || obs.gamePhase !== 'team_select' || obs.myTeam !== 'good' || obs.publicLoyalView === true) return false;
  if (obs.seatTeam !== undefined && obs.seatTeam !== 'good') return false;
  const roleOk = (obs.myRole === 'loyal' && (mode & 1) !== 0) || (obs.myRole === 'percival' && (mode & 2) !== 0);
  if (!roleOk) return false;
  if ((obs.failCount ?? 0) >= 4) return false;
  const round = obs.currentRound ?? 1;
  if (round === 1) return (mode & 4) !== 0;
  if (round === 2) {
    if ((mode & 8) === 0) return false;
    if ((mode & 64) !== 0 && (obs.questResults ?? [])[0] !== 'fail') return false;
    return true;
  }
  return false;
}

/** 前面的提議派過的人（含隊長自己放進隊的情形）；位元 16 = 整場，否則只算這一局。 */
export function proposedBefore(obs: PlayerObservation, wholeGame: boolean): Set<string> {
  const round = obs.currentRound ?? 1;
  const seen = new Set<string>();
  for (const v of obs.voteHistory) if (wholeGame || v.round === round) for (const id of v.team) seen.add(id);
  return seen;
}

/** `loyalFresh43`：見檔頭。不適用或不需要換時回傳原本的動作（同一個物件）。 */
export function loyalFresh43Team(tuning: Readonly<AgentTuning>, obs: PlayerObservation, action: AgentAction, allowed: Allowed = () => true): AgentAction {
  if (action.type !== 'team_select' || !loyalFresh43Applies(tuning, obs)) return action;
  const mode = tuning.loyalFresh43 ?? 0;
  const round = obs.currentRound ?? 1;
  const wholeGame = (mode & 16) !== 0;
  const earlier = obs.voteHistory.filter((v) => wholeGame || v.round === round);
  if (earlier.length === 0) return action;
  // 照派成功任務的隊（或它加一人）：常態，不動。
  const results = obs.questResults ?? [];
  if (obs.questHistory.some((q) => q.round < round && results[q.round - 1] === 'success' && q.team.every((id) => action.teamIds.includes(id)))) return action;
  const me = obs.myPlayerId;
  const tau = (tuning.loyalFresh43Tau ?? 0) > 0 ? tuning.loyalFresh43Tau : 0.5;
  const opts = bayesOptionsOf(tuning);
  const share = bayesRedShare(obs, opts);
  const red = (id: string): number => share.get(id) ?? 0.5;
  const seen = proposedBefore(obs, wholeGame);
  const fresh = (id: string): boolean => id !== me && !seen.has(id) && !obs.knownEvils.includes(id) && red(id) < tau;
  const blueLed = (mode & 32) !== 0
    ? obs.voteHistory.filter((v) => v.round === round && v.leader !== me && red(v.leader) < 0.5).map((v) => new Set(v.team.filter((id) => id !== me)))
    : [];
  const spread = (team: readonly string[]): boolean => blueLed.every((s) => team.filter((id) => id !== me && s.has(id)).length <= 1);
  // 第 43b 回合（見 open43b 的說明）：第 1 局的開局排法，位元 128／256／512／1024。
  if (round === 1 && (mode & OPEN43B_BITS) !== 0) {
    const thisRound = obs.voteHistory.filter((v) => v.round === 1);
    if ((mode & 128) !== 0 && thisRound.length < 2) return action; // V1：第 2 家不套用（可以照用第 1 家的人）
    if (thisRound.length === 1 && (mode & (256 | 512)) !== 0) {
      const first = thisRound[0];
      const firstTeam = new Set(first.team);
      const mateOf = (team: readonly string[]): string[] => team.filter((id) => id !== me);
      // 256「延伸」（1AB → 2BC；12A → 2AB；13A → 23B／2AB）：至少留一個第 1 家的隊員（第 1 家隊長以外），也至少放一個第 1 家沒派過、自己後驗不差的人。
      // 512「不重複」（1AB → 2CD；12A／13A → 2BC）：隊上（自己以外）沒有第 1 家隊上的人。
      const ok2 = (mode & 256) !== 0
        ? (team: readonly string[]): boolean => mateOf(team).some((id) => firstTeam.has(id) && id !== first.leader) && mateOf(team).some(fresh)
        : (team: readonly string[]): boolean => mateOf(team).every((id) => !firstTeam.has(id));
      return minimalSwapTeam(obs, action, ok2, allowed, opts);
    }
    if (thisRound.length >= 2 && (mode & 1024) !== 0) {
      // 1024「第 3 家起尊重」（百科〈3 家對 1AB、2CD 之後的解讀與反饋〉的「尊重」：147、260 之後「147 不能同時選兩人、
      // 589（2 沒選的區間）不能同時選兩人」）：前面每一個提議的隊員、以及這一局還沒人派過的人，各區（自己以外）最多選一個。
      const seenRound = new Set(thisRound.flatMap((v) => v.team));
      const sets = [
        ...thisRound.map((v) => new Set(v.team.filter((id) => id !== me))),
        new Set(obs.allPlayerIds.filter((id) => id !== me && !seenRound.has(id))),
      ];
      const ok3 = (team: readonly string[]): boolean => spread(team)
        && sets.every((s) => team.filter((id) => id !== me && s.has(id)).length <= 1);
      return minimalSwapTeam(obs, action, ok3, allowed, opts);
    }
  }
  const ok = (team: readonly string[]): boolean => team.some(fresh) && spread(team);
  if (ok(action.teamIds)) return action;
  const mates = action.teamIds.filter((id) => id !== me);
  if (mates.length === 0) return action;
  // 換掉隊上（自己以外）紅的機率最高的一個；同分時每一個都試。
  const worst = Math.max(...mates.map(red));
  const outs = mates.filter((id) => red(id) >= worst - 1e-12);
  const pool = obs.allPlayerIds.filter(fresh).filter((id) => !action.teamIds.includes(id));
  // 同分不照座位序（11/10 裁定）：所有同分的（換出, 換進）組合收齊，再用這一次決策的亂數（Math.random，自我對打照種子固定）挑一個。
  let bestP = -Infinity;
  let ties: string[][] = [];
  for (const out of outs) {
    for (const inn of pool) {
      const team = action.teamIds.map((id) => (id === out ? inn : id));
      if (!ok(team) || !allowed(team)) continue;
      const p = bayesTeamClean(obs, team, opts);
      if (p === null) return action;
      if (p - bestP > 1e-12) { bestP = p; ties = [team]; }
      else if (Math.abs(p - bestP) <= 1e-12) ties.push(team);
    }
  }
  const best = ties.length > 0 ? ties[Math.min(ties.length - 1, Math.floor(Math.random() * ties.length))] : null;
  return best ? { type: 'team_select', teamIds: best } : action;
}

/** 第 43b 回合的位元（第 1 局的開局排法）。 */
export const OPEN43B_BITS = 128 | 256 | 512 | 1024;

function combos<T>(xs: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  xs.forEach((x, i) => { for (const rest of combos(xs.slice(i + 1), k - 1)) out.push([x, ...rest]); });
  return out;
}

/**
 * 第 43b 回合：隊伍已經符合 `ok` 就不動；不符合時找「換最少人」就符合的隊（隊長自己不換、換進的人不是已知的紅），
 * 換的人數相同時挑自己後驗最乾淨、過好人的閘門與自己的投票規則的；同分用這一次決策的亂數挑（有種子時結果固定）。找不到就照原本的隊。
 */
export function minimalSwapTeam(
  obs: PlayerObservation, action: AgentAction, ok: (team: readonly string[]) => boolean, allowed: Allowed,
  opts: ReturnType<typeof bayesOptionsOf>,
): AgentAction {
  if (action.type !== 'team_select' || ok(action.teamIds)) return action;
  const me = obs.myPlayerId;
  const mates = action.teamIds.filter((id) => id !== me);
  const pool = obs.allPlayerIds.filter((id) => id !== me && !action.teamIds.includes(id) && !obs.knownEvils.includes(id));
  for (let k = 1; k <= mates.length; k++) {
    let bestP = -Infinity;
    let ties: string[][] = [];
    for (const outs of combos(mates, k)) {
      for (const ins of combos(pool, k)) {
        const swap = new Map(outs.map((id, i) => [id, ins[i]] as const));
        const team = action.teamIds.map((id) => swap.get(id) ?? id);
        if (!ok(team) || !allowed(team)) continue;
        const p = bayesTeamClean(obs, team, opts);
        if (p === null) return action;
        if (p - bestP > 1e-12) { bestP = p; ties = [team]; }
        else if (Math.abs(p - bestP) <= 1e-12) ties.push(team);
      }
    }
    if (ties.length > 0) return { type: 'team_select', teamIds: ties[Math.min(ties.length - 1, Math.floor(Math.random() * ties.length))] };
  }
  return action;
}
