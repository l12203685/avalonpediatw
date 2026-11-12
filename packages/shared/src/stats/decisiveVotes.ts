/**
 * 關鍵外白／內黑（社群點子「最佳第六人」，Edward 2026-11-11 擴大）：真的決定了結果的藍方投票。
 * 「最佳第六人」= 紅方已兩勝後，不在隊上的藍方贊成一支全好的隊、讓它剛好過關；Edward 擴成「關鍵 場外／場內 × 白／黑 × 對／錯」
 * 八格：每一張關鍵的藍方票都落在其中一格。
 *
 *   關鍵票   把這一票翻過來，這次提議過不過就會不一樣：剛好 6 票贊成過關、而他投贊成（白），或剛好 5 票贊成沒過、而他投反對（黑）。
 *            等價於「其他 9 票裡剛好 5 票贊成」：這時不管他投白投黑，結果都由他決定。投票是同時翻牌，投的人不知道自己這票是不是
 *            關鍵，所以關鍵票是他全部投票裡被機運挑出來的一小部分。
 *   提議     只算第 1～4 次（第 5 次強制出發，投票不影響結果）、第 1～5 局。過不過 = 贊成 6 票以上；有沒有出任務 = 這次提議是
 *            紀錄裡該局最後一次、而且該局有任務結果。兩者對不上（贊成過半卻沒出任務，或反過來）的提議是紀錄有錯，不算。
 *            這個統計不用隊長，所以不需要推出隊長的輪替；提議紀錄有缺口也不影響（每次提議用自己的票與結果判斷）。
 *   投票的人 只算藍方（忠臣、派西維爾、梅林），依角色與在不在隊上（場內／場外）分。沒寫名字的座位算進全體與角色，不算個人。
 *   隊伍     紅方 = 刺客、莫甘娜、莫德雷德、奧伯倫（莫德雷德也算紅）。
 *              全好      隊上沒有紅方 → 該放行
 *              會失敗    紅方多到能讓任務失敗：第 4 局兩個以上、其他局一個以上 → 該擋
 *              中性      第 4 局剛好一個紅方（一張失敗不會紅，放不放都不算對錯），另外一欄，不進對率
 *   八格     （場內／場外）×（白／黑）×（對／錯），加上中性：
 *              白對 = 關鍵地贊成全好的隊（任務因為他出得去）       白錯 = 關鍵地贊成會失敗的隊
 *              黑對 = 關鍵地擋下會失敗的隊                         黑錯 = 關鍵地擋下全好的隊
 *            正常的票：場內白（自己在隊上投贊成）、場外黑（不在隊上投反對）；異常的票：場內黑 = 內黑、場外白 = 外白——
 *            跟一般習慣反著投，最能看出判斷。關鍵外白 = 場外白對；關鍵內黑 = 場內黑對；關鍵外黑 = 場外黑對。
 *   範圍     twoRed = 紅方剛好已經兩勝（twoRed.ts redWinsBefore，第 3、4、5 局）；r35 = 第 3～5 局全部；r12 = 第 1～2 局
 *            （只給分析用：這時「一律投黑」的正確率比平均還高，正確率會獎勵單邊投票，不拿來排名）。
 *   排名     關鍵票正確率 =（白對 + 黑對）÷（對 + 錯）；中性不算。收縮值 =（對 + k·p0）÷（n + k），p0 = 同範圍全體（含沒寫名字的
 *            座位）的正確率、k = DECISIVE_SHRINK_K：一位玩家 n 張關鍵票時只保留 n ÷（n + k）的自己的偏差。
 *            k 是選定的收縮強度，不是從資料估出來的：用「每人的局隨機分兩半」檢查（全部局、無篩選，2026-11），30 張以上的常客
 *            兩半對不起來（相關約 0、玩家間的真實差異估出來 ≤ 0，k 等於無限大），只有算進 15～29 張的人才有小幅正相關
 *            （約 0.3～0.4，估出的 k 約 50～250）。所以 k = 150 取在這個範圍中間；門檻 30 張是為了涵蓋率（兩紅之後涵蓋有名字
 *            玩家關鍵票的 84%），不是信度。
 *            三種固定投法（一律白、一律黑、照常投 = 場內白、場外黑）在同一批關鍵位置上的正確率由 decisiveBaselines 即時算：
 *            全部局時兩紅之後 45% / 55% / 66%、第 3～5 局 40% / 60% / 67%，都低於平均（68%）；篩選後可能不同，表上顯示即時的數字。
 *            第 1～2 局一律黑就比平均準，不排名。
 *
 * 資料集只有 10 人局（4 紅），配置不是 6 個不同數字的局不算（同 twoRed.ts）。
 */
import { RED_ROLES, SEATS } from './constants';
import type { Game } from './dataset';
import { MORDRED, TWO_RED_ROLES, fullConfig, redWinsBefore, type TwoRedRole } from './twoRed';
import { cohortGrid, cohortHistogram, seatCohort, type CohortCell, type CohortCuts, type CohortGrid, type CohortHistogram, type CohortRecord } from './cohort';

export const DECISIVE_ROLES = TWO_RED_ROLES;
export type DecisiveRole = TwoRedRole;

/** 範圍：twoRed 紅方兩勝之後（預設）、r35 第 3～5 局、r12 第 1～2 局（只給分析）。 */
export type DecisiveScope = 'twoRed' | 'r35' | 'r12';
export const DECISIVE_SCOPES: readonly DecisiveScope[] = ['twoRed', 'r35', 'r12'];
/** 排行可以切的範圍（r12 的正確率獎勵一律投黑，不排名）。 */
export const DECISIVE_RANK_SCOPES = ['twoRed', 'r35'] as const;
export type DecisiveRankScope = (typeof DECISIVE_RANK_SCOPES)[number];

/** 四組：onYes 場內白、onNo 場內黑（內黑）、offYes 場外白（外白）、offNo 場外黑。 */
export type DecisiveGroup = 'onYes' | 'onNo' | 'offYes' | 'offNo';
export const DECISIVE_GROUPS: readonly DecisiveGroup[] = ['onYes', 'onNo', 'offYes', 'offNo'];
/** 異常的票（跟一般習慣反著投）：內黑、外白。 */
export const DECISIVE_ABNORMAL: ReadonlySet<DecisiveGroup> = new Set<DecisiveGroup>(['onNo', 'offYes']);

/** 全好 = 該放行；會失敗 = 該擋；中性 = 第 4 局單紅（放不放都不算對錯）。 */
export type DecisiveQuality = 'good' | 'bad' | 'neutral';

/** 收縮的強度 k（樣本 n 張時保留 n ÷（n + k）的自己的偏差）。選定的值，不是估計值（見檔頭「排名」）。 */
export const DECISIVE_SHRINK_K = 150;
/** 上榜的預設門檻：至少這麼多張非中性的關鍵票（為了涵蓋率；見檔頭「排名」）。 */
export const DECISIVE_MIN_N = 30;
/** 四組（與白票、黑票）對率：不到這麼多張只能參考，依這組排序時排在夠張數的人後面（4 張以下差一張就差 25 個百分點以上）。 */
export const DECISIVE_GROUP_MIN = 5;

/** 一組的對、錯、中性張數。 */
export interface DecisiveCell {
  right: number;
  wrong: number;
  neutral: number;
}
export type DecisiveGrid = Record<DecisiveGroup, DecisiveCell>;

/** 一張關鍵的藍方票。 */
export interface DecisiveVote {
  seq: number;
  /** 座位上的名字（沒寫 = null）。 */
  player: string | null;
  role: DecisiveRole;
  round: number;
  attempt: number;
  /** 投票的人在隊上。 */
  on: boolean;
  /** 投贊成（白）。 */
  approve: boolean;
  quality: DecisiveQuality;
  /** 隊上唯一的紅方是莫德雷德（梅林看不到他）。 */
  mordredOnly: boolean;
  scope: Exclude<DecisiveScope, 'twoRed'>;
  /** 提議當下紅方剛好已經兩勝。 */
  twoRed: boolean;
  /** 投票的座位字元。 */
  seat: string;
  /** 投票的人那一局開打前的 PR（benchmarks.ts seatPr；暫定、沒寫名字、沒評分 = null）。分組（cohort.ts）用。 */
  pr: number | null;
  /** 那一局的 S（沒評分 = null）。 */
  s: number | null;
}

type ScopeCounts = Record<DecisiveScope, number>;

/** 全部局掃一次：關鍵票、各範圍的投票機會（藍方投票的人 × 提議）、提議次數。 */
export interface DecisiveScan {
  votes: DecisiveVote[];
  /** 範圍 → 角色 → 投票機會（藍方座位 × 算進來的提議，含沒寫名字的座位與中性的隊）。 */
  opportunities: Record<DecisiveScope, Record<DecisiveRole, number>>;
  /** 範圍 → 算進來的提議次數（第 1～4 次、票數和結果對得上）。 */
  proposals: ScopeCounts;
  /** 範圍 → 票數和結果對不上、不算的提議次數。 */
  inconsistent: ScopeCounts;
  /** 範圍 → 有算進來的提議的局數。 */
  games: ScopeCounts;
  /**
   * scanDecisiveVotes(games, { allVotes: true }) 時才有：每一張藍方票（不只關鍵的）依局、座位、範圍合起來
   * （分組的「全部投票」；counts = DECISIVE_COHORT_ORDER）。
   */
  allVotes?: DecisiveSeatRecord[];
}

/** 九宮格的 counts 依這個順序：四組 × 對、錯、中性（索引 = 組 × 3 + 對錯）。 */
export const DECISIVE_COHORT_ORDER: ReadonlyArray<{ group: DecisiveGroup; outcome: keyof DecisiveCell }> = DECISIVE_GROUPS.flatMap((group) =>
  (['right', 'wrong', 'neutral'] as const).map((outcome) => ({ group, outcome })));
const cohortIndex = (group: DecisiveGroup, outcome: keyof DecisiveCell): number =>
  DECISIVE_GROUPS.indexOf(group) * 3 + (outcome === 'right' ? 0 : outcome === 'wrong' ? 1 : 2);

/** 同一局、同一座位、同一個範圍（第 1～2 局／第 3～5 局，且分兩紅之後與否）的藍方票合起來：九宮格的一筆。 */
export interface DecisiveSeatRecord extends CohortRecord {
  role: DecisiveRole;
  scope: Exclude<DecisiveScope, 'twoRed'>;
  twoRed: boolean;
  /** scanDecisiveVotes(games, { allVotes: true, byRound: true }) 時才有：再依第幾局分開（自動發現的「第幾局」「局勢」用）。 */
  round?: number;
  /** 座位字元（byRound 時才有）。 */
  seat?: string;
}

const ROLE_SET: ReadonlySet<string> = new Set(DECISIVE_ROLES);
const isDecisiveRole = (role: string): role is DecisiveRole => ROLE_SET.has(role);

/** 隊伍的品質：reds = 紅方人數。 */
export function decisiveQuality(round: number, reds: number): DecisiveQuality {
  if (reds === 0) return 'good';
  if (round === 4 && reds === 1) return 'neutral';
  return 'bad';
}

/** 這一票屬於哪一組。 */
export function decisiveGroup(on: boolean, approve: boolean): DecisiveGroup {
  if (on) return approve ? 'onYes' : 'onNo';
  return approve ? 'offYes' : 'offNo';
}

/** 對 / 錯 / 中性：白票放行全好的隊、黑票擋下會失敗的隊 = 對。 */
export function decisiveOutcome(approve: boolean, quality: DecisiveQuality): keyof DecisiveCell {
  if (quality === 'neutral') return 'neutral';
  return (quality === 'good') === approve ? 'right' : 'wrong';
}

const zeroScopes = (): ScopeCounts => ({ twoRed: 0, r35: 0, r12: 0 });
const zeroRoles = (): Record<DecisiveRole, number> => ({ 梅林: 0, 派西維爾: 0, 忠臣: 0 });

/** 贊成的座位數（重複的字元只算一次、不是座位的字元不算）。 */
function approvals(approved: string): Set<string> {
  const out = new Set<string>();
  for (const ch of approved) if ((SEATS as readonly string[]).includes(ch)) out.add(ch);
  return out;
}

/** 全部局裡的關鍵藍方票（三個範圍一起掃）。 */
export function scanDecisiveVotes(games: readonly Game[], options: { allVotes?: boolean; byRound?: boolean } = {}): DecisiveScan {
  const votes: DecisiveVote[] = [];
  const allVotes: DecisiveSeatRecord[] = [];
  const opportunities = { twoRed: zeroRoles(), r35: zeroRoles(), r12: zeroRoles() };
  const proposals = zeroScopes();
  const inconsistent = zeroScopes();
  const gameCounts = zeroScopes();
  for (const g of games) {
    if (!fullConfig(g.config)) continue;
    // 每一局在紀錄裡的最後一次提議（含第 5 次）：只有它可能出任務。
    const lastIndex = new Map<number, number>();
    g.votingProposals.forEach(([round], k) => lastIndex.set(round, k));
    const seen = zeroScopes();
    // 全部投票：這一局每個座位、每個範圍一筆
    const seatRecords = new Map<string, DecisiveSeatRecord>();
    g.votingProposals.forEach(([round, attempt, team, approved], k) => {
      if (round < 1 || round > 5 || attempt < 1 || attempt > 4) return;
      const scope = round <= 2 ? 'r12' : 'r35';
      const twoRed = scope === 'r35' && redWinsBefore(g, round) === 2;
      const yes = approvals(approved);
      const passed = yes.size > 5;
      const went = lastIndex.get(round) === k && Boolean(g.roundResults[round - 1]);
      if (passed !== went) {
        inconsistent[scope] += 1;
        if (twoRed) inconsistent.twoRed += 1;
        return;
      }
      proposals[scope] += 1;
      seen[scope] = 1;
      if (twoRed) { proposals.twoRed += 1; seen.twoRed = 1; }
      let reds = 0;
      let mordred = false;
      for (const seat of team) {
        const role = g.seatRoles.get(seat) ?? '';
        if (RED_ROLES.has(role)) reds += 1;
        if (role === MORDRED) mordred = true;
      }
      const quality = decisiveQuality(round, reds);
      const mordredOnly = reds === 1 && mordred;
      SEATS.forEach((seat, i) => {
        const role = g.seatRoles.get(seat) ?? '';
        if (!isDecisiveRole(role)) return;
        opportunities[scope][role] += 1;
        if (twoRed) opportunities.twoRed[role] += 1;
        const approve = yes.has(seat);
        const on = team.includes(seat);
        const { pr, s } = seatCohort(g, i);
        if (options.allVotes) {
          const rk = options.byRound ? `${seat}|${round}` : `${seat}|${scope}|${twoRed ? 1 : 0}`;
          let rec = seatRecords.get(rk);
          if (!rec) {
            rec = { player: g.seatPlayers[i] ?? null, game: g.seq, pr, s, n: 0, counts: new Array<number>(12).fill(0), role, scope, twoRed };
            if (options.byRound) { rec.round = round; rec.seat = seat; }
            seatRecords.set(rk, rec);
            allVotes.push(rec);
          }
          rec.n += 1;
          (rec.counts as number[])[cohortIndex(decisiveGroup(on, approve), decisiveOutcome(approve, quality))] += 1;
        }
        // 關鍵：剛好 6 票過關而他投白，或剛好 5 票沒過而他投黑（⇔ 其他 9 票裡剛好 5 票贊成）
        const decisive = passed ? yes.size === 6 && approve : yes.size === 5 && !approve;
        if (!decisive) return;
        votes.push({
          seq: g.seq,
          player: g.seatPlayers[i] ?? null,
          role,
          round,
          attempt,
          on,
          approve,
          quality,
          mordredOnly,
          scope,
          twoRed,
          seat,
          pr,
          s,
        });
      });
    });
    for (const s of DECISIVE_SCOPES) gameCounts[s] += seen[s];
  }
  return { votes, opportunities, proposals, inconsistent, games: gameCounts, ...(options.allVotes ? { allVotes } : {}) };
}

/** 這張票在不在範圍裡。 */
export function inDecisiveScope(v: Pick<DecisiveVote, 'scope' | 'twoRed'>, scope: DecisiveScope): boolean {
  return scope === 'twoRed' ? v.twoRed : v.scope === scope;
}

export const emptyDecisiveCell = (): DecisiveCell => ({ right: 0, wrong: 0, neutral: 0 });
export function emptyDecisiveGrid(): DecisiveGrid {
  return { onYes: emptyDecisiveCell(), onNo: emptyDecisiveCell(), offYes: emptyDecisiveCell(), offNo: emptyDecisiveCell() };
}

export function addDecisiveVote(grid: DecisiveGrid, v: Pick<DecisiveVote, 'on' | 'approve' | 'quality'>): void {
  grid[decisiveGroup(v.on, v.approve)][decisiveOutcome(v.approve, v.quality)] += 1;
}

/** 一格（或幾格合起來）的對、錯、中性。 */
export function sumDecisive(grid: DecisiveGrid, groups: readonly DecisiveGroup[] = DECISIVE_GROUPS): DecisiveCell {
  const out = emptyDecisiveCell();
  for (const k of groups) {
    out.right += grid[k].right;
    out.wrong += grid[k].wrong;
    out.neutral += grid[k].neutral;
  }
  return out;
}

/** 對率 = 對 ÷（對 + 錯）（0..1）；沒有非中性的票 = null。 */
export function decisiveRate(cell: Pick<DecisiveCell, 'right' | 'wrong'>): number | null {
  const n = cell.right + cell.wrong;
  return n > 0 ? cell.right / n : null;
}

/** 收縮後的正確率 =（對 + k·p0）÷（n + k）；p0 = null（全體沒有票）時就是原始值。 */
export function decisiveShrunk(cell: Pick<DecisiveCell, 'right' | 'wrong'>, p0: number | null, k = DECISIVE_SHRINK_K): number | null {
  const n = cell.right + cell.wrong;
  if (p0 === null) return decisiveRate(cell);
  return (cell.right + k * p0) / (n + k);
}

/** 同一批關鍵位置（非中性）上三種固定投法的正確率：一律白、一律黑、照常投（場內白、場外黑）。 */
export interface DecisiveBaselines {
  approve: number | null;
  reject: number | null;
  usual: number | null;
}

/**
 * 三種固定投法在這些關鍵位置上的正確率（從八格倒推：位置是全好還是會失敗、投的人在不在隊上，與實際投白投黑無關）。
 * 拿來檢查分數會不會獎勵單邊投票：三者都低於全體平均才不會。
 */
export function decisiveBaselines(grid: DecisiveGrid): DecisiveBaselines {
  const onGood = grid.onYes.right + grid.onNo.wrong;
  const onBad = grid.onYes.wrong + grid.onNo.right;
  const offGood = grid.offYes.right + grid.offNo.wrong;
  const offBad = grid.offYes.wrong + grid.offNo.right;
  const n = onGood + onBad + offGood + offBad;
  if (n === 0) return { approve: null, reject: null, usual: null };
  return { approve: (onGood + offGood) / n, reject: (onBad + offBad) / n, usual: (onGood + offBad) / n };
}

/** 一位玩家在一個範圍裡的關鍵票。 */
export interface DecisivePlayerRow {
  name: string;
  /** 全部角色合計的八格（＋中性）。 */
  grid: DecisiveGrid;
  byRole: Record<DecisiveRole, DecisiveGrid>;
  right: number;
  wrong: number;
  neutral: number;
  /** 非中性的關鍵票 = right + wrong（上榜門檻、收縮都用這個）。 */
  n: number;
  /** 原始正確率（0..1）。 */
  raw: number | null;
  /** 收縮後的正確率（0..1，排名用）。 */
  score: number | null;
  /** 有關鍵票的局數。 */
  games: number;
}

/** 全體（含沒寫名字的座位）依角色。 */
export interface DecisiveRoleRow {
  grid: DecisiveGrid;
  /** 投票機會（藍方座位 × 提議）。 */
  opportunities: number;
  /** 隊上唯一的紅方是莫德雷德、會失敗的隊（第 3、5 局）上的關鍵票：梅林看不到莫德雷德。 */
  mordredOnly: { right: number; wrong: number };
}

export interface DecisiveReport {
  scope: DecisiveScope;
  /** 有關鍵票的每位玩家（有名字），依收縮值、n、名字排序。 */
  players: DecisivePlayerRow[];
  all: {
    grid: DecisiveGrid;
    byRole: Record<DecisiveRole, DecisiveRoleRow>;
    opportunities: number;
    /** 沒寫名字的座位投的關鍵票（含中性）。 */
    unnamed: number;
    proposals: number;
    inconsistent: number;
    games: number;
    /** 全體的關鍵票正確率（收縮的目標）。 */
    p0: number | null;
    /** 同一批關鍵位置上一律白／一律黑／照常投的正確率（跟 p0 比：都低才不獎勵單邊投票）。 */
    baselines: DecisiveBaselines;
  };
  k: number;
}

/** 掃描結果 → 一個範圍的報表。 */
export function decisiveReport(scan: DecisiveScan, scope: DecisiveScope, k = DECISIVE_SHRINK_K): DecisiveReport {
  const allGrid = emptyDecisiveGrid();
  const byRole = {} as Record<DecisiveRole, DecisiveRoleRow>;
  for (const role of DECISIVE_ROLES) {
    byRole[role] = { grid: emptyDecisiveGrid(), opportunities: scan.opportunities[scope][role], mordredOnly: { right: 0, wrong: 0 } };
  }
  const players = new Map<string, { byRole: Record<DecisiveRole, DecisiveGrid>; grid: DecisiveGrid; games: Set<number> }>();
  let unnamed = 0;
  for (const v of scan.votes) {
    if (!inDecisiveScope(v, scope)) continue;
    addDecisiveVote(allGrid, v);
    const roleRow = byRole[v.role];
    addDecisiveVote(roleRow.grid, v);
    if (v.mordredOnly && v.quality === 'bad') roleRow.mordredOnly[decisiveOutcome(v.approve, v.quality) as 'right' | 'wrong'] += 1;
    if (v.player === null) {
      unnamed += 1;
      continue;
    }
    let p = players.get(v.player);
    if (!p) {
      p = { byRole: { 梅林: emptyDecisiveGrid(), 派西維爾: emptyDecisiveGrid(), 忠臣: emptyDecisiveGrid() }, grid: emptyDecisiveGrid(), games: new Set() };
      players.set(v.player, p);
    }
    addDecisiveVote(p.grid, v);
    addDecisiveVote(p.byRole[v.role], v);
    p.games.add(v.seq);
  }
  const p0 = decisiveRate(sumDecisive(allGrid));
  const rows: DecisivePlayerRow[] = [...players].map(([name, p]) => {
    const tot = sumDecisive(p.grid);
    return {
      name,
      grid: p.grid,
      byRole: p.byRole,
      right: tot.right,
      wrong: tot.wrong,
      neutral: tot.neutral,
      n: tot.right + tot.wrong,
      raw: decisiveRate(tot),
      score: decisiveShrunk(tot, p0, k),
      games: p.games.size,
    };
  });
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const opportunities = DECISIVE_ROLES.reduce((s, r) => s + byRole[r].opportunities, 0);
  return {
    scope,
    players: rows,
    all: {
      grid: allGrid,
      byRole,
      opportunities,
      unnamed,
      proposals: scan.proposals[scope],
      inconsistent: scan.inconsistent[scope],
      games: scan.games[scope],
      p0,
      baselines: decisiveBaselines(allGrid),
    },
    k,
  };
}

/** 排序依：收縮後的正確率（預設）、原始正確率、關鍵票張數、白票／黑票對率、四組對率。 */
export type DecisiveSortKey = 'score' | 'raw' | 'n' | 'yes' | 'no' | DecisiveGroup;
export const DECISIVE_SORT_KEYS: readonly DecisiveSortKey[] = ['score', 'raw', 'n', 'yes', 'no', 'onYes', 'onNo', 'offYes', 'offNo'];

/** 一位玩家的某一組（或白票 = 場內白 + 場外白、黑票 = 場內黑 + 場外黑）的對、錯、中性。 */
export function decisiveSlice(row: Pick<DecisivePlayerRow, 'grid'>, key: 'yes' | 'no' | DecisiveGroup): DecisiveCell {
  const groups: readonly DecisiveGroup[] = key === 'yes' ? ['onYes', 'offYes'] : key === 'no' ? ['onNo', 'offNo'] : [key];
  return sumDecisive(row.grid, groups);
}

/**
 * 排序：大的在前。白票／黑票與四組對率不到 DECISIVE_GROUP_MIN 張的玩家排在夠的人後面（3 張全對的 100% 不會排第一）；
 * 同值看非中性關鍵票多的、再看名字。
 */
export function sortDecisiveRows(rows: readonly DecisivePlayerRow[], key: DecisiveSortKey): DecisivePlayerRow[] {
  const val = (r: DecisivePlayerRow): [number, number] => {
    if (key === 'score') return [1, r.score ?? -1];
    if (key === 'raw') return [1, r.raw ?? -1];
    if (key === 'n') return [1, r.n];
    const c = decisiveSlice(r, key);
    return [c.right + c.wrong >= DECISIVE_GROUP_MIN ? 1 : 0, decisiveRate(c) ?? -1];
  };
  return [...rows].sort((a, b) => {
    const [ta, va] = val(a);
    const [tb, vb] = val(b);
    return tb - ta || vb - va || b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

/** 一步到位：局 → 一個範圍的報表。 */
export function computeDecisiveReport(games: readonly Game[], scope: DecisiveScope = 'twoRed'): DecisiveReport {
  return decisiveReport(scanDecisiveVotes(games), scope);
}

// ── 分組：強者／一般人／新手 × 高端／普通／歡樂（cohort.ts 的慣例：個人的關鍵票太少，看合併的組）──────────

/** 關鍵票 → 依局、座位、範圍合起來的筆（counts = DECISIVE_COHORT_ORDER）。 */
export function decisiveSeatRecords(votes: readonly DecisiveVote[]): DecisiveSeatRecord[] {
  const out = new Map<string, DecisiveSeatRecord>();
  for (const v of votes) {
    const key = `${v.seq}|${v.seat}|${v.scope}|${v.twoRed ? 1 : 0}`;
    let rec = out.get(key);
    if (!rec) {
      rec = { player: v.player, game: v.seq, pr: v.pr, s: v.s, n: 0, counts: new Array<number>(12).fill(0), role: v.role, scope: v.scope, twoRed: v.twoRed };
      out.set(key, rec);
    }
    rec.n += 1;
    (rec.counts as number[])[cohortIndex(decisiveGroup(v.on, v.approve), decisiveOutcome(v.approve, v.quality))] += 1;
  }
  return [...out.values()];
}

/** 給網站的分組資料（一個範圍）：關鍵票與全部投票各自的筆、PR／S 分布。切點在網站上換，不用重算。 */
export interface DecisiveCohortData {
  scope: DecisiveScope;
  decisive: DecisiveSeatRecord[];
  all: DecisiveSeatRecord[];
  histogram: CohortHistogram;
}

/** 掃描結果（要有 allVotes）＋局 → 一個範圍的分組資料。 */
export function decisiveCohortData(scan: DecisiveScan, scope: DecisiveScope, games: readonly Game[]): DecisiveCohortData {
  const inScope = (r: Pick<DecisiveSeatRecord, 'scope' | 'twoRed'>): boolean => inDecisiveScope(r, scope);
  return {
    scope,
    decisive: decisiveSeatRecords(scan.votes.filter((v) => inDecisiveScope(v, scope))),
    all: (scan.allVotes ?? []).filter(inScope),
    histogram: cohortHistogram(games),
  };
}

/** 筆 → 九宮格（role 給了就只算那個角色）。 */
export function decisiveCohortGrid(records: readonly DecisiveSeatRecord[], cuts: CohortCuts, role?: DecisiveRole | null): CohortGrid {
  return cohortGrid(role ? records.filter((r) => r.role === role) : records, cuts, DECISIVE_COHORT_ORDER.length);
}

/** 九宮格的一格 → 八格（＋中性）。 */
export function decisiveGridOf(cell: Pick<CohortCell, 'counts'>): DecisiveGrid {
  const grid = emptyDecisiveGrid();
  DECISIVE_COHORT_ORDER.forEach(({ group, outcome }, k) => { grid[group][outcome] += cell.counts[k] ?? 0; });
  return grid;
}

// ── 場外藍票：外白率／外黑率（Edward 2026-11-12）────────────────────────────
//
// 只看不在提議的隊上的藍方票（場外；第 1～4 次提議、藍方投票的人，同上面的掃描），依（贊成／反對）×（隊伍品質）分六類：
//   外白率 = 場外贊成 ÷ 場外票、外黑率 = 場外反對 ÷ 場外票（兩者加起來 100%）。
//   只看外白率會把好隊與壞隊混在一起（壞隊多的範圍外白率自然低），所以再依隊伍品質拆：
//     全好的隊上的外白率 = 贊成全好 ÷（贊成全好 + 反對全好）；會失敗的隊、第 4 局單紅（中性）同理；外黑率 = 100% − 外白率。
//   外白對率 = 贊成全好 ÷ 場外贊成（不含中性）＝ 八格的「場外白」對率；外黑對率 = 反對會失敗 ÷ 場外反對（不含中性）＝「場外黑」對率。
// 資料就是分組用的 DecisiveSeatRecord（counts = DECISIVE_COHORT_ORDER）裡的場外兩組：場外白的 對／錯／中性 = 贊成 全好／會失敗／中性，
// 場外黑的 對／錯／中性 = 反對 會失敗／全好／中性；不用另外掃。

/** 場外藍票的六類：贊成／反對 × 全好／會失敗／中性（第 4 局單紅）。 */
export interface OffTeamCounts {
  yesGood: number;
  yesBad: number;
  yesNeutral: number;
  noGood: number;
  noBad: number;
  noNeutral: number;
}

/** 指標：yes 外白率、no 外黑率；yesGood／yesBad／yesNeutral = 全好／會失敗／中性的隊上的外白率（no… 同理是外黑率）；yesRight 外白對率、noRight 外黑對率。 */
export const OFF_TEAM_MEASURES = ['yes', 'no', 'yesGood', 'yesBad', 'yesNeutral', 'noGood', 'noBad', 'noNeutral', 'yesRight', 'noRight'] as const;
export type OffTeamMeasure = (typeof OFF_TEAM_MEASURES)[number];

/** 一筆（或一格）的 counts → 場外的六類。 */
export function offTeamCounts(cell: { counts: readonly number[] }): OffTeamCounts {
  const at = (group: DecisiveGroup, outcome: keyof DecisiveCell): number => cell.counts[cohortIndex(group, outcome)] ?? 0;
  return {
    yesGood: at('offYes', 'right'),
    yesBad: at('offYes', 'wrong'),
    yesNeutral: at('offYes', 'neutral'),
    noGood: at('offNo', 'wrong'),
    noBad: at('offNo', 'right'),
    noNeutral: at('offNo', 'neutral'),
  };
}

/** 指標的分子 k 與分母 n（比率 = k ÷ n；n = 0 時沒有比率）。 */
export function offTeamRatio(c: OffTeamCounts, measure: OffTeamMeasure): { k: number; n: number } {
  const yes = c.yesGood + c.yesBad + c.yesNeutral;
  const no = c.noGood + c.noBad + c.noNeutral;
  switch (measure) {
    case 'yes': return { k: yes, n: yes + no };
    case 'no': return { k: no, n: yes + no };
    case 'yesGood': return { k: c.yesGood, n: c.yesGood + c.noGood };
    case 'noGood': return { k: c.noGood, n: c.yesGood + c.noGood };
    case 'yesBad': return { k: c.yesBad, n: c.yesBad + c.noBad };
    case 'noBad': return { k: c.noBad, n: c.yesBad + c.noBad };
    case 'yesNeutral': return { k: c.yesNeutral, n: c.yesNeutral + c.noNeutral };
    case 'noNeutral': return { k: c.noNeutral, n: c.yesNeutral + c.noNeutral };
    case 'yesRight': return { k: c.yesGood, n: c.yesGood + c.yesBad };
    case 'noRight': return { k: c.noBad, n: c.noBad + c.noGood };
    default: return { k: 0, n: 0 };
  }
}

/**
 * 筆 → 這個指標的九宮格：只留這個指標分母 > 0 的筆（格子的人數 = 真的有票算進這個比率的人；在隊上的票不算），
 * role 給了就只算那個角色。比率用 offTeamRatio(offTeamCounts(cell), measure)。
 */
export function offTeamCohortGrid(
  records: readonly DecisiveSeatRecord[], cuts: CohortCuts, measure: OffTeamMeasure, role?: DecisiveRole | null,
): CohortGrid {
  const kept = records.filter((r) => (!role || r.role === role) && offTeamRatio(offTeamCounts(r), measure).n > 0);
  return cohortGrid(kept, cuts, DECISIVE_COHORT_ORDER.length);
}
