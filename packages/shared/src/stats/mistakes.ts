/**
 * 可從紀錄直接證明的失誤（generate_cache.detect_mistakes 的同一套規則，Edward 2026-10-31）。牌譜紀錄的標籤由
 * 每晚的 discord_records_export.py 寫好；數據分析「陣容強度」要對 games_cache 的每一局算比例，所以這裡在瀏覽器
 * 再算一次（兩邊用同樣的合成局測試）。
 *
 * 只用公開紀錄，加上動作者自己知道的事（自己是藍方、自己持湖驗到的陣營）。「已證有紅」：某次失敗任務的隊伍 T
 * 出了 f 張失敗 → T 裡至少 f 個紅；新隊伍 P 跟 T 的交集大於 |T| − f 時 P 一定有紅（動作者自己與湖驗到的藍先從 T
 * 扣掉，湖驗到的紅直接算紅；多個失敗任務只在交集互不重疊時相加）。第 4 局要 2 張失敗，要證出 ≥ 2 紅才算。
 */
import { RED_ROLES, SEATS } from './constants';
import type { Game } from './dataset';

export const MISTAKE_PROVEN_SENT = '已證有紅的隊出任務';
export const MISTAKE_BLUE_LEADER = '藍方隊長派已證有紅的隊';
export const MISTAKE_LAKE_CLAIM = '藍方持湖宣告不符（待查）';
export const MISTAKE_BLUE_APPROVE = '藍方贊成已證有紅的隊';
export const MISTAKE_RED_MATCH_POINT = '紅方賽點未出失敗（待查）';
export const MISTAKE_SERIOUS = '嚴重失誤';
export const MISTAKE_TAGS = [
  MISTAKE_SERIOUS, MISTAKE_PROVEN_SENT, MISTAKE_BLUE_LEADER, MISTAKE_BLUE_APPROVE, MISTAKE_LAKE_CLAIM, MISTAKE_RED_MATCH_POINT,
] as const;
export const SERIOUS_MISTAKES: ReadonlySet<string> = new Set([MISTAKE_PROVEN_SENT, MISTAKE_BLUE_LEADER]);

const FAILS_NEEDED: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 1 };
export const LEADER_MIN_SHARE = 0.8;
export const LEADER_MIN_MARGIN = 3;

/** [標籤, 回合, 座位字串]。 */
export type Mistake = [tag: string, round: number, seats: string];
/** [回合, 隊伍, 贊成座位；強制局或沒有投票紀錄為 null]。 */
export type MistakeProposal = [round: number, team: string, approved: string | null];
/** [第幾輪任務後, 持湖, 目標, 宣告 x 紅／o 藍／其他]。 */
export type MistakeLake = [after: number, holder: string, target: string, claim: string];

/** 每次提議的隊長（跨輪輪替，第一位不知道）：同 generate_cache.derive_leaders 與網站 deriveLeaders。 */
export function deriveLeaderSeats(teams: readonly string[]): string[] | null {
  if (teams.length === 0) return null;
  const cover = SEATS.map((_, start) => teams.filter((team, k) => team.includes(SEATS[(start + k) % 10])).length);
  const best = Math.max(...cover);
  const start = cover.indexOf(best);
  const second = Math.max(...cover.filter((_, i) => i !== start));
  if (best < teams.length * LEADER_MIN_SHARE || best - second < LEADER_MIN_MARGIN) return null;
  return teams.map((_, k) => SEATS[(start + k) % 10]);
}

function inter(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  return new Set([...a].filter((x) => b.has(x)));
}

function minus(a: ReadonlySet<string>, ...bs: ReadonlySet<string>[]): Set<string> {
  return new Set([...a].filter((x) => bs.every((b) => !b.has(x))));
}

/** 隊伍 team 裡「一定是紅」的人數下限。 */
export function provenReds(
  team: ReadonlySet<string>, failed: ReadonlyArray<[Set<string>, number]>, knownBlue: ReadonlySet<string>, knownRed: ReadonlySet<string>,
): number {
  const parts: Array<[Set<string>, number]> = [];
  for (const [members, fails] of failed) {
    const rest = minus(members, knownBlue, knownRed);
    const need = fails - inter(members, knownRed).size;
    if (need <= 0) continue;
    const common = inter(team, rest);
    const sure = common.size - (rest.size - need);
    if (sure > 0) parts.push([common, sure]);
  }
  let best = 0;
  const n = parts.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const chosen = parts.filter((_, i) => (mask >> i) & 1);
    const union = new Set(chosen.flatMap(([s]) => [...s]));
    if (chosen.reduce((a, [s]) => a + s.size, 0) === union.size) best = Math.max(best, chosen.reduce((a, [, k]) => a + k, 0));
  }
  return inter(team, knownRed).size + best;
}

/** 一局可證明的失誤，照發生順序；有嚴重的時最前面加 [嚴重失誤, 0, '']。 */
export function detectMistakes(
  roles: ReadonlyMap<string, string>,
  proposals: readonly MistakeProposal[],
  missions: readonly string[],
  lakes: readonly MistakeLake[],
): Mistake[] {
  const red: ReadonlySet<string> = new Set<string>(SEATS.filter((s) => RED_ROLES.has(roles.get(s) ?? '')));
  const byRound = new Map<number, Array<[number, string, string | null]>>();
  proposals.forEach(([round, team, approved], k) => {
    byRound.set(round, [...(byRound.get(round) ?? []), [k, team, approved]]);
  });
  const leaders = deriveLeaderSeats(proposals.map(([, team]) => team));
  const found: Mistake[] = [];
  const failed: Array<[Set<string>, number]> = [];
  let redPoints = 0;
  const knowledge = (seat: string, round: number): [Set<string>, Set<string>] => {
    const blue = new Set([seat]);
    const reds = new Set<string>();
    for (const [after, holder, target] of lakes) {
      if (after < round && holder === seat && (SEATS as readonly string[]).includes(target)) (red.has(target) ? reds : blue).add(target);
    }
    return [blue, reds];
  };
  const seatsStr = (xs: Iterable<string>): string => {
    const set = new Set(xs);
    return SEATS.filter((s) => set.has(s)).join('');
  };
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    if (round < 1 || round > 5) continue;
    const need = FAILS_NEEDED[round];
    const cell = missions[round - 1] ?? '';
    const props = byRound.get(round) ?? [];
    props.forEach(([k, team, approved], idx) => {
      const members = new Set(team);
      const went = Boolean(cell) && idx === props.length - 1;
      if (approved !== null) {
        const yes = new Set(approved);
        if ((yes.size > 5) === went) {
          const wrong = SEATS.filter((s) => !red.has(s) && yes.has(s) && provenReds(members, failed, ...knowledge(s, round)) >= need);
          if (wrong.length) found.push([MISTAKE_BLUE_APPROVE, round, seatsStr(wrong)]);
        }
      }
      if (leaders) {
        const leader = leaders[k];
        if (!red.has(leader) && provenReds(members, failed, ...knowledge(leader, round)) >= need) {
          found.push([MISTAKE_BLUE_LEADER, round, leader]);
        }
      }
      if (went && provenReds(members, failed, new Set(), new Set()) >= need) found.push([MISTAKE_PROVEN_SENT, round, seatsStr(members)]);
    });
    if (!cell || props.length === 0) continue;
    const team = new Set(props[props.length - 1][1]);
    if (cell.length !== team.size) continue;
    const fails = [...cell].filter((c) => c === 'x').length;
    const redsOn = inter(team, red);
    if (redPoints === 2 && redsOn.size >= need && fails < need) found.push([MISTAKE_RED_MATCH_POINT, round, seatsStr(redsOn)]);
    if (fails >= need) {
      redPoints += 1;
      failed.push([team, fails]);
    }
  }
  for (const [after, holder, target, claim] of lakes) {
    const isSeat = (s: string): boolean => (SEATS as readonly string[]).includes(s);
    if (isSeat(holder) && isSeat(target) && !red.has(holder) && roles.get(holder) !== '梅林' && (claim === 'x' || claim === 'o')) {
      if (claim !== (red.has(target) ? 'x' : 'o')) found.push([MISTAKE_LAKE_CLAIM, after, holder]);
    }
  }
  if (found.some(([tag]) => SERIOUS_MISTAKES.has(tag))) found.unshift([MISTAKE_SERIOUS, 0, '']);
  return found;
}

/** detectMistakes 套在 games_cache 的一局（同 generate_cache.game_row_mistakes）。 */
export function gameMistakes(g: Pick<Game, 'seatRoles' | 'votingProposals' | 'roundResults' | 'lakes' | 'claims'>): Mistake[] {
  const proposals: MistakeProposal[] = g.votingProposals.map(([round, attempt, team, approved]) => [
    round, team, attempt >= 5 ? null : approved,
  ]);
  const lakes: MistakeLake[] = [];
  g.lakes.forEach((lake, i) => {
    if (!lake) return;
    const c = g.claims.find((x) => x.holder === lake.holder && x.target === lake.target);
    lakes.push([i + 2, lake.holder, lake.target, c?.claim === '紅' ? 'x' : c?.claim === '藍' ? 'o' : '']);
  });
  return detectMistakes(g.seatRoles, proposals, g.roundResults, lakes);
}
