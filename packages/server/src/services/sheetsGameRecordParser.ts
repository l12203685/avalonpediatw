/**
 * Sheets 牌譜純文字 → GameRecordV2 parser.
 *
 * 對應 Edward 2026-04-24 12:27 給的格式範例（第 2139 場）：
 *
 *   138              round 1 prop 1 — 隊員 [1,3,8]，無異常票 → 按正常票通過，任務直出
 *   267              （正常情況：一列 = 一次提議）
 *   370
 *   248
 *   258
 *   ooo              round 1 任務結果：3 成功
 *   2458 6+          round 2 prop 1 — 隊 [2,4,5,8]，座 6 場外白（未被選但 approve）
 *   2580 0- 7+       round 2 prop 2 — 隊 [2,5,8,10]，座 10(0) 場內黑、座 7 場外白
 *   ...
 *   ooxx             round 2 任務結果
 *   0>1 o            湖：座 10 查座 1 宣告好人
 *   ...
 *   oooox            round 5 任務結果
 *
 *   末端 metadata:
 *     roleCode "701498"  = 刺/娜/德/奧/派/梅 6 個座號
 *     locationCode "面瓦"|"線瓦"
 *     playedAtStr "2026/02/27"
 *     gameNumInDay 16
 *     playerNames 10 個玩家名字（對應座位 1..10）
 *
 * 規則細節：
 *   - 數字序列 `138` / `2458` / `12568` 每個字元 = 一個座號，0 = 座 10
 *   - `X+` = 座 X 場外白（未在隊伍但 approve）
 *   - `X-` = 座 X 場內黑（在隊伍但 reject）
 *   - 沒標 `+/-` 的座 = 正常票：在隊伍 approve，不在隊伍 reject
 *   - 每回合結尾以任務結果行 (`o` 和 `x` 的字串) 標示
 *   - 湖行 `X>Y o` 或 `X>Y x` 可插入在任務結果之後
 *
 * Output: GameRecordV2（playerSeats 為 UUID，缺 UUID 時 fallback `sheets:<原名字>`）
 */

import type {
  FixedTenStrings,
  GameRecordV2,
  LadyLinkV2,
  MissionV2,
  RolesV2,
  CampV2,
  WinReasonV2,
} from '@avalon/shared';

export interface SheetsParseInput {
  /** 牌譜原文（含所有回合 + 任務結果 + 湖行）。 */
  gameText: string;
  /** 6 碼刺娜德奧派梅（assassin/morgana/mordred/oberon/percival/merlin 的座號字元）。 */
  roleCode: string;
  /** `面瓦` | `線瓦`（暫未入主 schema，metadata 用）。 */
  locationCode: string;
  /** 日期字串 `YYYY/MM/DD`。 */
  playedAtStr: string;
  /** 當天第幾場（metadata 用）。 */
  gameNumInDay: number;
  /** 10 個玩家名字依座位 1..10；不足 10 以空字串補。 */
  playerNames: string[];
  /**
   * 名字 → 註冊用戶 UUID 對照。查不到回 `null`，parser 會 fallback 到 `sheets:<名字>`。
   * 未提供整個 callback 時全部 fallback。
   */
  playerNameToUid?: (name: string) => string | null;
  /** 選用的 gameId；未提供則用 date + gameNum 組出。 */
  gameId?: string;
}

// ---------------------------------------------------------------------------
// Lower-level parsing helpers
// ---------------------------------------------------------------------------

/**
 * 把座位字元 `'1'..'9'`/`'0'` 轉座號數字 1..10。
 */
function charToSeat(ch: string): number {
  if (ch === '0') return 10;
  const n = Number.parseInt(ch, 10);
  if (!Number.isFinite(n) || n < 1 || n > 9) {
    throw new Error(`Invalid seat char: ${ch}`);
  }
  return n;
}

/**
 * 數字 token → 座位陣列。例如 `"2458"` → `[2, 4, 5, 8]`；`"0"` → `[10]`。
 */
function parseSeatToken(token: string): number[] {
  const seats: number[] = [];
  for (const ch of token) {
    seats.push(charToSeat(ch));
  }
  return seats;
}

/**
 * 異常票 token：
 *   `"6+"` → `{ seat: 6, kind: 'plus' }`
 *   `"0-"` → `{ seat: 10, kind: 'minus' }`
 *   `"70+"` → `[{seat:7,plus},{seat:10,plus}]`（多座號共用同一個 +/-）
 *   `"17-"` → `[{seat:1,minus},{seat:7,minus}]`
 */
interface Anomaly {
  seat: number;
  kind: 'plus' | 'minus';
}

function parseAnomalyToken(token: string): Anomaly[] {
  const lastCh = token[token.length - 1];
  if (lastCh !== '+' && lastCh !== '-') {
    throw new Error(`Anomaly token must end with + or -: ${token}`);
  }
  // Split the token into one or more seat-group + kind runs so that mixed
  // tokens like "249+3-", "1+8-", "2+58-", "5-0+" are all supported.
  // Each run = a run of seat digits followed by a single +/- marker.
  // Example "249+3-" → [{seats:"249",kind:"+"}, {seats:"3",kind:"-"}].
  const runs: Array<{ seats: string; kind: 'plus' | 'minus' }> = [];
  let buf = '';
  for (const ch of token) {
    if (ch === '+' || ch === '-') {
      const kind: 'plus' | 'minus' = ch === '+' ? 'plus' : 'minus';
      if (buf.length === 0) {
        // A stray +/- with no preceding digits is not valid.
        throw new Error(`Anomaly token missing seats before ${ch}: ${token}`);
      }
      runs.push({ seats: buf, kind });
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) {
    // trailing seats without a marker – treat the overall last marker as its kind
    // (mirrors the simple case). Fallback: throw.
    throw new Error(`Anomaly token has trailing seats without marker: ${token}`);
  }
  const anomalies: Anomaly[] = [];
  for (const run of runs) {
    for (const seat of parseSeatToken(run.seats)) {
      anomalies.push({ seat, kind: run.kind });
    }
  }
  return anomalies;
}

/**
 * 判斷一行是不是任務結果行（只含 `o` 和 `x`，至少 2 字元；大小寫皆可）。
 */
function isQuestLine(line: string): boolean {
  return /^[oxOX]{2,5}$/.test(line);
}

/**
 * 判斷一行是不是湖行（`X>Y o` / `X>Y x` 或 `X>Yo` / `X>Yx` 或 `X>Y`）。
 * 允許 tab/space/無分隔，宣告字母可省略（有些舊列只寫 `"0>7"`）。
 */
function isLadyLine(line: string): boolean {
  // Accept optional declaration [oxOX?]; ? = illegible (舊列 `9>8 ?`)。
  return /^[0-9]>[0-9](?:[\s\t]*[oxOX?])?$/.test(line);
}

/**
 * 提議行解析：
 *   "138"               → team=[1,3,8], anomalies=[]
 *   "2458 6+"           → team=[2,4,5,8], anomalies=[{6,plus}]
 *   "2580 0- 7+"        → team=[2,5,8,10], anomalies=[{10,minus},{7,plus}]
 *   "14678 17- 0+"      → team=[1,4,6,7,8], anomalies=[{1,minus},{7,minus},{10,plus}]
 *   "12568 390+"        → team=[1,2,5,6,8], anomalies=[{3,plus},{9,plus},{10,plus}]
 */
interface ProposalLine {
  teamSeats: number[];
  anomalies: Anomaly[];
}

function parseProposalLine(line: string): ProposalLine {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0) throw new Error(`Empty proposal line`);

  const teamSeats = parseSeatToken(tokens[0]);
  const anomalies: Anomaly[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    anomalies.push(...parseAnomalyToken(tokens[i]));
  }
  return { teamSeats, anomalies };
}

/**
 * 湖行解析：`"0>1 o"` → `{holder:10,target:1,declaration:'good'}`
 */
function parseLadyLine(
  line: string,
  round: number,
): Omit<LadyLinkV2, 'actual' | 'truthful'> {
  // 支援 "0>1 o" / "0>1o" / "0>1\to" / "0>1"（無宣告的舊列，預設 'good'）；
  // 以及 "9>8 ?"（宣告不明，舊列用問號標示），預設 'good'。
  const m = /^([0-9])>([0-9])(?:[\s\t]*([oxOX?]))?$/.exec(line.trim());
  if (!m) throw new Error(`Invalid lady line: ${line}`);
  const holderSeat = charToSeat(m[1]);
  const targetSeat = charToSeat(m[2]);
  const rawDecl = (m[3] ?? 'o').toLowerCase();
  const declaration: CampV2 = rawDecl === 'x' ? 'evil' : 'good';
  return { round, holderSeat, targetSeat, declaration };
}

// ---------------------------------------------------------------------------
// Votes + mission building
// ---------------------------------------------------------------------------

/**
 * 依 teamSeats + anomalies 計算 approve/reject 票數，並回一張
 * （選用）`votes[10]` 明細。playerCount < 10 時後段座位的票值為 `'reject'`
 * 但不代表「真的投 reject」，下游請透過 `playerCount` 判斷是否納入統計。
 *
 * 規則：
 *   - 在 teamSeats 的座：預設 approve；若 `{seat, minus}` 覆寫 reject（場內黑）
 *   - 不在 teamSeats 的座：預設 reject；若 `{seat, plus}` 覆寫 approve（場外白）
 */
function buildVotes(
  teamSeats: number[],
  anomalies: Anomaly[],
  playerCount: number,
): {
  votes: Array<'approve' | 'reject'>;
  approveCount: number;
  rejectCount: number;
} {
  const inTeam = new Set(teamSeats);
  const minusSeats = new Set(
    anomalies.filter((a) => a.kind === 'minus').map((a) => a.seat),
  );
  const plusSeats = new Set(
    anomalies.filter((a) => a.kind === 'plus').map((a) => a.seat),
  );

  const votes: Array<'approve' | 'reject'> = new Array(playerCount);
  let approveCount = 0;
  let rejectCount = 0;

  for (let i = 0; i < playerCount; i += 1) {
    const seat = i + 1;
    const baseApprove = inTeam.has(seat);
    const overrideMinus = minusSeats.has(seat); // 場內黑 → reject
    const overridePlus = plusSeats.has(seat);   // 場外白 → approve

    let vote: 'approve' | 'reject';
    if (overrideMinus) vote = 'reject';
    else if (overridePlus) vote = 'approve';
    else vote = baseApprove ? 'approve' : 'reject';

    votes[i] = vote;
    if (vote === 'approve') approveCount += 1;
    else rejectCount += 1;
  }

  return { votes, approveCount, rejectCount };
}

/**
 * 任務結果行解析：`"ooxx"` → `{successCount:2, failCount:2, success:false}`
 * success 規則：7 人以上的第 4 回合需要 ≥2 fail 才失敗；其他回合 ≥1 fail 即失敗。
 * 不過：Sheets 牌譜只寫了結果 o/x 字元，此處直接以 fail=0 → 成功 判斷，
 * 避免跟 AVALON_CONFIG 耦合。
 */
function parseQuestLine(
  line: string,
  round: number,
  playerCount: number,
): {
  successCount: number;
  failCount: number;
  success: boolean;
} {
  let successCount = 0;
  let failCount = 0;
  for (const ch of line.trim().toLowerCase()) {
    if (ch === 'o') successCount += 1;
    else if (ch === 'x') failCount += 1;
  }
  // 7 人以上第 4 回合需要 2 fail 才算失敗。
  const needsTwoFails = playerCount >= 7 && round === 4;
  const success = needsTwoFails ? failCount < 2 : failCount === 0;
  return { successCount, failCount, success };
}

// ---------------------------------------------------------------------------
// Win condition
// ---------------------------------------------------------------------------

function deriveWinner(
  questOutcomes: Array<'blue' | 'red'>,
): { winnerCamp: CampV2; winReason: WinReasonV2 } {
  let blue = 0;
  let red = 0;
  for (const o of questOutcomes) {
    if (o === 'blue') blue += 1;
    else red += 1;
  }
  if (red >= 3) return { winnerCamp: 'evil', winReason: 'threeRed' };
  if (blue >= 3) {
    // Phase 2a 只標「好人三藍成立」；刺殺細節 Phase 2c 補（需 transcript）。
    return { winnerCamp: 'good', winReason: 'threeBlue_merlinAlive' };
  }
  // fallback：不足 3 勝任何一方（理論上 5 回合一定有一方 ≥3），保險用 evil。
  return { winnerCamp: 'evil', winReason: 'threeRed' };
}

// ---------------------------------------------------------------------------
// Role code
// ---------------------------------------------------------------------------

/**
 * 6 碼 roleCode `"701498"` 拆出能力角色座號。
 * 順序：刺 / 娜 / 德 / 奧 / 派 / 梅 = assassin / morgana / mordred / oberon / percival / merlin
 */
function parseRoleCode(code: string): RolesV2 {
  const trimmed = code.trim();
  if (trimmed.length !== 6) {
    throw new Error(`roleCode must be 6 chars (刺娜德奧派梅): ${code}`);
  }
  return {
    assassin: charToSeat(trimmed[0]),
    morgana: charToSeat(trimmed[1]),
    mordred: charToSeat(trimmed[2]),
    oberon: charToSeat(trimmed[3]),
    percival: charToSeat(trimmed[4]),
    merlin: charToSeat(trimmed[5]),
  };
}

// ---------------------------------------------------------------------------
// Player seats
// ---------------------------------------------------------------------------

function buildPlayerSeats(
  playerNames: string[],
  playerNameToUid?: (name: string) => string | null,
): FixedTenStrings {
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const name = (playerNames[i] ?? '').trim();
    if (!name) {
      out.push('');
      continue;
    }
    const uid = playerNameToUid ? playerNameToUid(name) : null;
    out.push(uid && uid.trim() ? uid.trim() : `sheets:${name}`);
  }
  return out.slice(0, 10) as unknown as FixedTenStrings;
}

// ---------------------------------------------------------------------------
// gameId fallback
// ---------------------------------------------------------------------------

function buildGameId(playedAtStr: string, gameNumInDay: number): string {
  // 2026/02/27 #16 → sheets-2026-02-27-16
  const dateSlug = playedAtStr.replace(/\//g, '-');
  return `sheets-${dateSlug}-${gameNumInDay}`;
}

function parsePlayedAt(playedAtStr: string): number {
  // 2026/02/27 → Unix ms at 00:00 +08 (Taipei)
  const m = /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/.exec(playedAtStr.trim());
  if (!m) throw new Error(`Invalid playedAtStr: ${playedAtStr}`);
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  // +08 時區 → UTC 前一天 16:00。用 Date.UTC 直接算。
  return Date.UTC(y, mo - 1, d, -8, 0, 0);
}

// ---------------------------------------------------------------------------
// Lady actual/truthful derivation
// ---------------------------------------------------------------------------

/**
 * 依 targetSeat 查 roles + AVALON_CONFIG 推該座實際陣營。
 * Phase 2a 簡化：假設 merlin/percival 為好人；assassin/morgana/mordred/oberon 為壞人；
 * 其餘座位在 7-10 人局一律算好人（8 人局只有 3 個壞人角色 + oberon，其他為好人）。
 * Phase 2b 會接 `expandRolesForAllSeats`（GameStatsV2.ts 的 stub）做精確版。
 */
function deriveActualCamp(seat: number, roles: RolesV2): CampV2 {
  if (roles.assassin === seat) return 'evil';
  if (roles.morgana === seat) return 'evil';
  if (roles.mordred === seat) return 'evil';
  if (roles.oberon === seat) return 'evil';
  // merlin / percival / loyal
  return 'good';
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseSheetsGameCell(input: SheetsParseInput): GameRecordV2 {
  const {
    gameText,
    roleCode,
    playedAtStr,
    gameNumInDay,
    playerNames,
    playerNameToUid,
    gameId,
  } = input;

  // ---- Line normalization ----
  // 1) Lowercase O/X → o/x (some rows use capitals for quest/lady outcomes).
  // 2) Strip curly quotes (e.g. `136”` typo from Sheets auto-format).
  // 3) Replace period-as-separator with space (e.g. `"190.4+"` → `"190 4+"`)
  //    when the period sits between a seat digit and a +/- anomaly digit.
  // 4) Collapse lingering tabs/double-spaces.
  // 5) Truncate at assassination footer (lines starting with `刺客刺殺`,
  //    `1.` / `2.` / …  numbered player listings, or isolated 6-digit cfg
  //    that matches the roleCode value). These are metadata, not gameplay.
  const rawLines = gameText.split(/\r?\n/);
  const lines: string[] = [];
  const footerStart = /^(?:刺客刺殺|刺殺|結果[:：])/;
  const numberedPlayerLine = /^[0-9]\s*[.．、]\s*\S/;
  const assassinCfgMatch = roleCode.trim();
  for (const raw of rawLines) {
    let line = raw.trim();
    if (line.length === 0) continue;
    if (footerStart.test(line)) break;
    if (numberedPlayerLine.test(line)) break;
    if (assassinCfgMatch.length === 6 && line === assassinCfgMatch) break;
    // strip curly quotes
    line = line.replace(/[“”‘’”“’‘]/g, '');
    // replace period separator between digit and digit-with-sign
    line = line.replace(/([0-9])\.([0-9])/g, '$1 $2');
    // collapse whitespace
    line = line.replace(/\s+/g, ' ').trim();
    if (line.length === 0) continue;
    lines.push(line);
  }

  const playerCount = playerNames.filter((n) => (n ?? '').trim().length > 0).length;
  if (playerCount < 5 || playerCount > 10) {
    throw new Error(`Invalid playerCount: ${playerCount} (must be 5..10)`);
  }

  const missions: MissionV2[] = [];
  const ladyChain: LadyLinkV2[] = [];
  const questOutcomes: Array<'blue' | 'red'> = [];
  const roles = parseRoleCode(roleCode);

  let currentRound: 1 | 2 | 3 | 4 | 5 = 1;
  let proposalInRound = 0;
  // leader seat：Phase 2a 依每回合第一個提議實際行為下一次隊長推導，
  // 這裡簡化為 leaderSeat = 該提議序號對應的座號 — Sheets 原文沒明寫，
  // 保守以 teamSeats[0] 當 leader（若來源有明確隊長欄再改）。
  // 實務上用戶在意的是隊員/投票，leaderSeat 僅供 future hydrate。

  for (const line of lines) {
    if (isQuestLine(line)) {
      // 任務結果 → 覆寫最後一次提議的 questResult + 記錄 round outcome + 進入下一回合
      const last = missions[missions.length - 1];
      if (!last || last.round !== currentRound) {
        // 舊資料偶見重複 quest 行或收尾多餘字元，安全做法是忽略，不炸整場。
        // 這發生在 5 局已結束後的尾端裝飾行（例：row 419 的多餘 "ooooo"）。
        continue;
      }
      const q = parseQuestLine(line, currentRound, playerCount);
      last.questResult = q;
      last.passed = true; // 任務有開牌 → 隊伍必通過
      questOutcomes.push(q.success ? 'blue' : 'red');

      // 前進下一回合
      currentRound = Math.min(5, currentRound + 1) as 1 | 2 | 3 | 4 | 5;
      proposalInRound = 0;
      continue;
    }

    if (isLadyLine(line)) {
      // 湖行通常出現在回合任務結果之後；round = 剛結束的回合 = currentRound - 1
      const ladyRound = Math.max(1, currentRound - 1);
      try {
        const core = parseLadyLine(line, ladyRound);
        const actual = deriveActualCamp(core.targetSeat, roles);
        ladyChain.push({
          ...core,
          actual,
          truthful: core.declaration === actual,
        });
      } catch {
        // 舊列偶有錯字；湖不可解析時跳過不炸整場。
      }
      continue;
    }

    // 不是任務結果也不是湖 → 提議行；舊列偶有錯字（多餘 token / 缺 +/-），
    // 不應整場 abort，改跳過該行。
    let parsed: ProposalLine | null = null;
    try {
      parsed = parseProposalLine(line);
    } catch {
      continue;
    }
    const { teamSeats, anomalies } = parsed;
    if (teamSeats.length === 0) continue;
    const { votes, approveCount, rejectCount } = buildVotes(
      teamSeats,
      anomalies,
      playerCount,
    );

    proposalInRound += 1;

    // 最後一個提議才 passed；之前的都是 rejected — 下方 quest line 處理時會覆寫 last.passed = true
    const passed = approveCount > rejectCount;

    // leaderSeat 保守推導：提議序號以「1 起往右數」的方式從首位 leader 推；
    // 史料無明確 leader 來源時，退而用 teamSeats[0]（與 derived 用 leaderStartIndex 取首 proposal 的 leader）。
    const leaderSeat = teamSeats[0] ?? 1;

    missions.push({
      round: currentRound,
      proposalIndex: Math.min(5, proposalInRound) as 1 | 2 | 3 | 4 | 5,
      leaderSeat,
      teamSeats,
      votes,
      passed,
      approveCount,
      rejectCount,
    });
  }

  // 修正 passed：每回合最後一個 mission = passed（任務已開牌），之前的 = 未通過
  // 但若某回合只有一個 mission，它就是直接通過的那個（也有可能是強制局 = proposalIndex 5）。
  const byRound = new Map<number, MissionV2[]>();
  for (const m of missions) {
    const arr = byRound.get(m.round) ?? [];
    arr.push(m);
    byRound.set(m.round, arr);
  }
  for (const arr of byRound.values()) {
    for (let i = 0; i < arr.length; i += 1) {
      if (i < arr.length - 1) {
        arr[i].passed = false; // 非最後一個 = 被否決
      } else {
        arr[i].passed = true;  // 最後一個 = 通過（因為有對應的任務結果）
      }
    }
  }

  const { winnerCamp, winReason } = deriveWinner(questOutcomes);

  const playerSeats = buildPlayerSeats(playerNames, playerNameToUid);

  const record: GameRecordV2 = {
    schemaVersion: 2,
    gameId: gameId ?? buildGameId(playedAtStr, gameNumInDay),
    playedAt: parsePlayedAt(playedAtStr),
    playerSeats,
    finalResult: {
      winnerCamp,
      winReason,
      roles,
      // Sheets 牌譜不含刺殺細節，留空；Phase 2c 會從 transcript 補。
    },
    missions,
    ladyChain: ladyChain.length > 0 ? ladyChain : undefined,
  };

  return record;
}

// ---------------------------------------------------------------------------
// Named internal exports for focused unit tests
// ---------------------------------------------------------------------------

export const __internal = {
  charToSeat,
  parseSeatToken,
  parseAnomalyToken,
  parseProposalLine,
  parseLadyLine,
  parseQuestLine,
  parseRoleCode,
  buildVotes,
  deriveWinner,
  deriveActualCamp,
  buildPlayerSeats,
  parsePlayedAt,
  isQuestLine,
  isLadyLine,
};
