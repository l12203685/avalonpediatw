/**
 * 異常票（內黑／外白）的分組統計（Edward 2026-11-12，站長的定義）：藍方「跟一般習慣反著投」的票，依情境、關鍵與否、角色、
 * 玩家分層 × 桌分層看比率與正確率。數據排行「關鍵外白／內黑」分組的小分頁「異常票（內黑／外白）」與玩家雷達「兩紅之後」用。
 *
 *   異常票   內黑 = 自己在提議的隊上卻投反對；外白 = 不在隊上卻投贊成（一般在隊上投贊成、不在隊上投反對）。
 *   提議     只算第 1～4 次（第 5 次強制出發，投票不影響結果）。過不過 = 贊成 6 票以上；有沒有出任務 = 這次提議是紀錄裡該局
 *            最後一次、而且該局有任務結果；兩者對不上的提議是紀錄有錯，不算（同 decisiveVotes.ts）。
 *   投票的人 只算藍方（忠臣、派西維爾、梅林）；紅方的票不算。
 *   情境（提議當下的比分 = 之前的任務 藍:紅）
 *              兩紅之後         紅方已經兩勝（第 3 局 0:2、第 4 局 1:2、第 5 局 2:2）
 *              第三局・兩紅     第 3 局、0:2
 *              第三局・一藍一紅 第 3 局、1:1（第 3 局 2:0 不算）
 *              第四局・兩紅     第 4 局、1:2（第 4 局 2:1 不算：兩藍一紅的第 4 局幾乎不會投錯）
 *              第五局           第 5 局（一定是 2:2，也就是兩紅之後）
 *            兩紅之後 = 第三局・兩紅 + 第四局・兩紅 + 第五局。之前的任務結果不明的局不算。
 *   正確與否 用賽後的真實身分（莫德雷德也算紅，奧伯倫也算紅）：
 *              外白對 = 隊上沒有紅方（白到全好）；內黑對 = 隊上至少一個紅方（黑到至少一壞）。每一局都一樣，沒有中性。
 *   全部     內黑率 = 在隊上投反對 ÷ 在隊上的票；內黑正確率 = 內黑對 ÷ 內黑
 *            外白率 = 不在隊上投贊成 ÷ 不在隊上的票；外白正確率 = 外白對 ÷ 外白
 *   關鍵     關鍵外白（「第六顆白」）= 這次提議提前出任務（第 1～4 次、通過），而他不在隊上、投贊成。不管贊成有幾票，每一張
 *              這樣的藍方票都算（例：7 張白、3 張是場外白——一張紅方、兩張藍方 A、B → A、B 都是關鍵外白）。
 *            關鍵內黑（「第五顆黑」）= 這次提議差一張白就提前出任務（第 1～4 次、剛好 5 張白、沒過），而他在隊上、投反對。
 *              每一張這樣的藍方票都算（例：5 張白 = 場內 3 + 場外 2，所以場內有 2 張黑，藍方 C、D 投的 → C、D 都是關鍵內黑）。
 *            關鍵外白率 = 關鍵外白 ÷ 提前出任務的提議上、不在隊上的藍方票（每次機會）；關鍵外白正確率 = 隊全好 ÷ 關鍵外白。
 *            關鍵內黑率 = 關鍵內黑 ÷ 剛好 5 張白沒過的提議上、在隊上的藍方票；關鍵內黑正確率 = 隊上有紅 ÷ 關鍵內黑。
 *   注意     跟排行與八格的「決定性票」（把這一票翻過來結果就改變：剛好 6 張白過關時投白、剛好 5 張白沒過時投黑）不一樣：
 *            7 張白過關時的場外白是關鍵外白，但不是決定性票。
 *
 * 筆 = 同一局、同一座位、同一情境的藍方票合起來（CohortRecord；counts 依 ABNORMAL_COUNT_KEYS），交給 cohort.ts 的九宮格。
 * 資料集只有 10 人局（4 紅），配置不是 6 個不同數字的局不算（同 twoRed.ts）。
 */
import { RED_ROLES, SEATS } from './constants';
import type { Game } from './dataset';
import { TWO_RED_ROLES, fullConfig, type TwoRedRole } from './twoRed';
import { cohortGrid, cohortHistogram, seatCohort, type CohortCuts, type CohortGrid, type CohortHistogram, type CohortRecord } from './cohort';

export type AbnormalRole = TwoRedRole;
export const ABNORMAL_ROLES = TWO_RED_ROLES;

/** 細的情境（每次提議最多屬於一個）。 */
export type AbnormalSlot = 'r3TwoRed' | 'r3Even' | 'r4TwoRed' | 'r5';
/** 表上的情境：兩紅之後（= r3TwoRed + r4TwoRed + r5）與四個細的情境；順序 = 畫面上的順序。 */
export type AbnormalSituation = 'twoRed' | AbnormalSlot;
export const ABNORMAL_SITUATIONS: readonly AbnormalSituation[] = ['twoRed', 'r3TwoRed', 'r3Even', 'r4TwoRed', 'r5'];
const TWO_RED_SLOTS: ReadonlySet<AbnormalSlot> = new Set<AbnormalSlot>(['r3TwoRed', 'r4TwoRed', 'r5']);

/** 全部（每一張藍方票）／關鍵（關鍵外白、關鍵內黑）。 */
export type AbnormalMode = 'all' | 'key';
export const ABNORMAL_MODES: readonly AbnormalMode[] = ['all', 'key'];

/** 四個指標：inBlack 內黑率、inBlackRight 內黑正確率、outWhite 外白率、outWhiteRight 外白正確率（關鍵時是關鍵內黑／外白的）。 */
export const ABNORMAL_MEASURES = ['inBlack', 'inBlackRight', 'outWhite', 'outWhiteRight'] as const;
export type AbnormalMeasure = (typeof ABNORMAL_MEASURES)[number];

/**
 * 一筆（或一格）的張數，counts 依這個順序：
 *   onYes 在隊上投贊成；onNoRight／onNoWrong 內黑（隊上有紅／全好）；offNo 不在隊上投反對；offYesRight／offYesWrong 外白（全好／有紅）；
 *   keyOnNoRight／keyOnNoWrong 關鍵內黑（有紅／全好）；keyOnChance 剛好 5 張白沒過的提議上、在隊上的票；
 *   keyOffYesRight／keyOffYesWrong 關鍵外白（全好／有紅）；keyOffChance 提前出任務的提議上、不在隊上的票。
 */
export const ABNORMAL_COUNT_KEYS = [
  'onYes', 'onNoRight', 'onNoWrong', 'offNo', 'offYesRight', 'offYesWrong',
  'keyOnNoRight', 'keyOnNoWrong', 'keyOnChance', 'keyOffYesRight', 'keyOffYesWrong', 'keyOffChance',
] as const;
export type AbnormalCountKey = (typeof ABNORMAL_COUNT_KEYS)[number];
export type AbnormalCounts = Record<AbnormalCountKey, number>;
const IDX = Object.fromEntries(ABNORMAL_COUNT_KEYS.map((k, i) => [k, i])) as Record<AbnormalCountKey, number>;
export const ABNORMAL_WIDTH = ABNORMAL_COUNT_KEYS.length;

/** 同一局、同一座位、同一情境的藍方票（n = 票數）。 */
export interface AbnormalRecord extends CohortRecord {
  role: AbnormalRole;
  slot: AbnormalSlot;
  seat: string;
}

type SituationCounts = Record<AbnormalSituation, number>;

export interface AbnormalScan {
  records: AbnormalRecord[];
  /** 情境 → 算進來的提議次數（第 1～4 次、票數和結果對得上）。 */
  proposals: SituationCounts;
  /** 情境 → 票數和結果對不上、不算的提議次數。 */
  inconsistent: SituationCounts;
  /** 情境 → 有算進來的提議的局數。 */
  games: SituationCounts;
}

const ROLE_SET: ReadonlySet<string> = new Set(ABNORMAL_ROLES);
const isAbnormalRole = (role: string): role is AbnormalRole => ROLE_SET.has(role);
const zeroSituations = (): SituationCounts => ({ twoRed: 0, r3TwoRed: 0, r3Even: 0, r4TwoRed: 0, r5: 0 });

/** 第 round 局開始前的比分（藍勝、紅勝）；之前有結果不明的任務 = null。 */
export function scoreBefore(g: Pick<Game, 'rounds'>, round: number): { blue: number; red: number } | null {
  let blue = 0;
  let red = 0;
  for (let i = 0; i < round - 1; i += 1) {
    const r = g.rounds[i];
    if (r === '紅') red += 1;
    else if (r === '藍') blue += 1;
    else return null;
  }
  return { blue, red };
}

/** 第幾局 ＋ 之前的比分 → 細的情境；不在任何情境（第 1～2 局、第 3 局 2:0、第 4 局 2:1）= null。 */
export function abnormalSlot(round: number, blue: number, red: number): AbnormalSlot | null {
  if (round === 3 && blue === 0 && red === 2) return 'r3TwoRed';
  if (round === 3 && blue === 1 && red === 1) return 'r3Even';
  if (round === 4 && blue === 1 && red === 2) return 'r4TwoRed';
  if (round === 5 && blue === 2 && red === 2) return 'r5';
  return null;
}

/** 這個細的情境在不在表上的這個情境裡。 */
export function inAbnormalSituation(slot: AbnormalSlot, situation: AbnormalSituation): boolean {
  return situation === 'twoRed' ? TWO_RED_SLOTS.has(slot) : slot === situation;
}

/** 贊成的座位（重複的字元只算一次、不是座位的字元不算）。 */
function approvalSeats(approved: string): Set<string> {
  const out = new Set<string>();
  for (const ch of approved) if ((SEATS as readonly string[]).includes(ch)) out.add(ch);
  return out;
}

/** 全部局掃一次：每一張情境裡的藍方票，依局、座位、情境合起來。 */
export function scanAbnormalVotes(games: readonly Game[]): AbnormalScan {
  const records: AbnormalRecord[] = [];
  const proposals = zeroSituations();
  const inconsistent = zeroSituations();
  const gameCounts = zeroSituations();
  for (const g of games) {
    if (!fullConfig(g.config)) continue;
    const lastIndex = new Map<number, number>();
    g.votingProposals.forEach(([round], k) => lastIndex.set(round, k));
    const seen = zeroSituations();
    const byKey = new Map<string, AbnormalRecord>();
    g.votingProposals.forEach(([round, attempt, team, approved], k) => {
      if (round < 3 || round > 5 || attempt < 1 || attempt > 4) return;
      const score = scoreBefore(g, round);
      if (!score) return;
      const slot = abnormalSlot(round, score.blue, score.red);
      if (!slot) return;
      const twoRed = TWO_RED_SLOTS.has(slot);
      const yes = approvalSeats(approved);
      const passed = yes.size > 5;
      const went = lastIndex.get(round) === k && Boolean(g.roundResults[round - 1]);
      if (passed !== went) {
        inconsistent[slot] += 1;
        if (twoRed) inconsistent.twoRed += 1;
        return;
      }
      proposals[slot] += 1;
      seen[slot] = 1;
      if (twoRed) { proposals.twoRed += 1; seen.twoRed = 1; }
      let reds = 0;
      for (const seat of team) if (RED_ROLES.has(g.seatRoles.get(seat) ?? '')) reds += 1;
      const allGood = reds === 0;
      // 差一張白就提前出任務
      const oneShort = !passed && yes.size === 5;
      SEATS.forEach((seat, i) => {
        const role = g.seatRoles.get(seat) ?? '';
        if (!isAbnormalRole(role)) return;
        const key = `${seat}|${slot}`;
        let rec = byKey.get(key);
        if (!rec) {
          const { pr, s } = seatCohort(g, i);
          rec = { player: g.seatPlayers[i] ?? null, game: g.seq, pr, s, n: 0, counts: new Array<number>(ABNORMAL_WIDTH).fill(0), role, slot, seat };
          byKey.set(key, rec);
          records.push(rec);
        }
        const c = rec.counts as number[];
        rec.n += 1;
        const approve = yes.has(seat);
        if (team.includes(seat)) {
          if (approve) c[IDX.onYes] += 1;
          else c[allGood ? IDX.onNoWrong : IDX.onNoRight] += 1;
          if (oneShort) {
            c[IDX.keyOnChance] += 1;
            if (!approve) c[allGood ? IDX.keyOnNoWrong : IDX.keyOnNoRight] += 1;
          }
        } else {
          if (approve) c[allGood ? IDX.offYesRight : IDX.offYesWrong] += 1;
          else c[IDX.offNo] += 1;
          if (passed) {
            c[IDX.keyOffChance] += 1;
            if (approve) c[allGood ? IDX.keyOffYesRight : IDX.keyOffYesWrong] += 1;
          }
        }
      });
    });
    for (const s of ABNORMAL_SITUATIONS) gameCounts[s] += seen[s];
  }
  return { records, proposals, inconsistent, games: gameCounts };
}

export const emptyAbnormalCounts = (): AbnormalCounts =>
  Object.fromEntries(ABNORMAL_COUNT_KEYS.map((k) => [k, 0])) as AbnormalCounts;

/** 一筆（或九宮格的一格）的 counts → 具名的張數。 */
export function abnormalCounts(cell: { counts: readonly number[] }): AbnormalCounts {
  return Object.fromEntries(ABNORMAL_COUNT_KEYS.map((k, i) => [k, cell.counts[i] ?? 0])) as AbnormalCounts;
}

/** 幾筆合起來。 */
export function sumAbnormal(records: Iterable<{ counts: readonly number[] }>): AbnormalCounts {
  const out = emptyAbnormalCounts();
  for (const r of records) ABNORMAL_COUNT_KEYS.forEach((k, i) => { out[k] += r.counts[i] ?? 0; });
  return out;
}

/** 指標的分子 k、分母 n（比率 = k ÷ n；n = 0 時沒有比率）。 */
export function abnormalRatio(c: AbnormalCounts, measure: AbnormalMeasure, mode: AbnormalMode): { k: number; n: number } {
  if (mode === 'key') {
    const onNo = c.keyOnNoRight + c.keyOnNoWrong;
    const offYes = c.keyOffYesRight + c.keyOffYesWrong;
    switch (measure) {
      case 'inBlack': return { k: onNo, n: c.keyOnChance };
      case 'inBlackRight': return { k: c.keyOnNoRight, n: onNo };
      case 'outWhite': return { k: offYes, n: c.keyOffChance };
      case 'outWhiteRight': return { k: c.keyOffYesRight, n: offYes };
      default: return { k: 0, n: 0 };
    }
  }
  const onNo = c.onNoRight + c.onNoWrong;
  const offYes = c.offYesRight + c.offYesWrong;
  switch (measure) {
    case 'inBlack': return { k: onNo, n: onNo + c.onYes };
    case 'inBlackRight': return { k: c.onNoRight, n: onNo };
    case 'outWhite': return { k: offYes, n: offYes + c.offNo };
    case 'outWhiteRight': return { k: c.offYesRight, n: offYes };
    default: return { k: 0, n: 0 };
  }
}

/** 筆 → 只留這個情境（與角色）的。 */
export function abnormalRecords<R extends Pick<AbnormalRecord, 'slot' | 'role'>>(
  records: readonly R[], situation: AbnormalSituation, role?: AbnormalRole | null,
): R[] {
  return records.filter((r) => inAbnormalSituation(r.slot, situation) && (!role || r.role === role));
}

/**
 * 筆 → 這個情境、這個指標的九宮格：只留這個指標分母 > 0 的筆（格子的人數 = 真的有票算進這個比率的人），
 * role 給了就只算那個角色。比率用 abnormalRatio(abnormalCounts(cell), measure, mode)。
 */
export function abnormalCohortGrid(
  records: readonly AbnormalRecord[], cuts: CohortCuts, situation: AbnormalSituation, measure: AbnormalMeasure, mode: AbnormalMode,
  role?: AbnormalRole | null,
): CohortGrid {
  const kept = abnormalRecords(records, situation, role).filter((r) => abnormalRatio(abnormalCounts(r), measure, mode).n > 0);
  return cohortGrid(kept, cuts, ABNORMAL_WIDTH);
}

/** 給網站的資料：筆、提議次數、PR／S 分布（切點在網站上換，不用重算）。 */
export interface AbnormalCohortData {
  records: AbnormalRecord[];
  proposals: SituationCounts;
  inconsistent: SituationCounts;
  games: SituationCounts;
  histogram: CohortHistogram;
}

export function abnormalCohortData(scan: AbnormalScan, games: readonly Game[]): AbnormalCohortData {
  return { ...scan, histogram: cohortHistogram(games) };
}
