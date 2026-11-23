/**
 * 模擬瓦題庫的「紀錄異常」篩選（2026-11-21）。
 *
 * 群組玩家回報（2026-11-17）：一局真人記錯拇指的局被抽成了題目。紀錄有異常的局不該當題目；
 * 但這只是題庫的事，那些局照樣算戰績。所以這裡只管題庫，不動總庫、不動戰績。
 *
 * 不出題的局（建題庫 `scripts/buildSimBank.ts` 每晚一次，伺服器讀題庫時再擋一次）：
 *   1. 總庫的檢查（game_db.py，只有建題庫時看得到）：
 *      - 來源不一致（CONFLICT）、疑似同一局（NEAR_DUP）、同一來源登錄兩次（DUP_SAME_SOURCE）：主控台「問題牌譜」的
 *        conflict／dup 兩組，還沒裁定哪一份對；
 *      - 投票記號跟隊伍對不上（VOTE_MARKS，多半是座位寫錯）；
 *      - 規則錯誤（status error：失敗比紅多、湖不合規則…）本來就不進題庫（bankSource.ts）；
 *      - 記錄者在備註標了事件（flag:incident：「[1-1]派西忘記拇指」這種）、代打（flag:substitution）、爛局（flag:badGame）、
 *        覆盤局（flag:review）。湖修正（flag:lakeCorrected）是改好的紀錄，照出。
 *      不擋的：投票張數對不上（VOTE_RESULT，多半漏記場外白；題目裡標「票沒記全」）、湖沒記宣告、推定全白的票、
 *      推不出隊長輪替（LEADER：很多人不派自己，不代表記錯）。
 *   2. 從紀錄本身算得出來的（建題庫和讀題庫都擋）：
 *      - 失敗張數比隊上的紅方多（配置記錯：拇指、看到的紅都跟著錯）；
 *      - 隊長輪替明顯不是從 1 家開始（每次派票的人「多半派自己」明顯對到另一個起點）：模擬瓦照 1 家起算隊長，這種局
 *        「你是 N家」會坐錯人。
 *   3. 人工清單 `packages/server/sim_bank_exclude.json`：紀錄看不出來、要靠人說的（例如玩家回報當局有人記錯拇指、
 *      備註寫了某家忘記自己的角色）。每一筆寫總庫的局號（`db`）、題庫的題號（`bank`，讀題庫時用）或指紋（`fp`），
 *      加一句原因（不寫名字、不貼聊天原文）。加了之後伺服器下次開機就不出（不用等重建），隔天題庫重建時拿掉。
 *
 * 純函式＋一個讀檔函式；log 只有固定文字。
 */

import * as fs from 'fs';
import * as path from 'path';
import { EVIL_ROLES, type ReplayGame } from '../../ai/benchmark/sheetsReplay';

/** 總庫檢查裡，有這幾條就不出題。 */
export const SIM_PROBLEM_RULES: readonly string[] = ['CONFLICT', 'NEAR_DUP', 'DUP_SAME_SOURCE', 'VOTE_MARKS'];

/** 試算表備註的旗標（game_db 的 OWNER_FLAG 檢查），有這幾個就不出題。 */
export const SIM_PROBLEM_FLAGS: readonly string[] = ['flag:incident', 'flag:substitution', 'flag:badGame', 'flag:review'];

interface DbCheck { rule?: unknown; msg?: unknown }

/** 總庫一局的檢查 → 不出題的原因（規則代碼或旗標），沒有就是 null。 */
export function dbRowProblem(row: { checks?: unknown }): string | null {
  const checks = (Array.isArray(row?.checks) ? row.checks : []) as DbCheck[];
  for (const c of checks) {
    const rule = typeof c?.rule === 'string' ? c.rule : '';
    if (SIM_PROBLEM_RULES.includes(rule)) return rule;
    if (rule === 'OWNER_FLAG') {
      const msg = typeof c.msg === 'string' ? c.msg : '';
      const flag = SIM_PROBLEM_FLAGS.find((f) => msg.split(/[、,\s]+/u).includes(f));
      if (flag) return flag;
    }
  }
  return null;
}

/** game_db.derive_leaders 的門檻（= packages/shared/src/stats/mistakes.ts）。 */
const LEADER_MIN_SHARE = 0.8;
const LEADER_MIN_MARGIN = 3;

/**
 * 每次派票的人「多半派自己」對到的輪替起點（0 = 1 家起算）；看不出明確的起點就是 null
 * （game_db.derive_leaders 的同一個算法）。
 */
export function rotationStart(game: Pick<ReplayGame, 'proposals' | 'playerCount'>): number | null {
  const n = game.playerCount || 10;
  const teams = game.proposals.map((p) => p.teamSeats);
  if (teams.length === 0) return null;
  const cover = Array.from({ length: n }, (_, start) => teams.filter((team, k) => team.includes(((start + k) % n) + 1)).length);
  const best = Math.max(...cover);
  const start = cover.indexOf(best);
  const second = Math.max(...cover.filter((_, i) => i !== start));
  if (best < teams.length * LEADER_MIN_SHARE || best - second < LEADER_MIN_MARGIN) return null;
  return start;
}

export type SimGameProblem = 'fails-gt-red' | 'leader-rotation';

/** 從紀錄本身算得出來的異常（建題庫、讀題庫都擋），沒有就是 null。 */
export function gameProblem(game: Pick<ReplayGame, 'proposals' | 'quests' | 'seatRoles' | 'playerCount'>): SimGameProblem | null {
  for (const q of game.quests) {
    const reds = q.teamSeats.filter((s) => EVIL_ROLES.has(game.seatRoles[s - 1])).length;
    if (q.failCount > reds) return 'fails-gt-red';
  }
  const start = rotationStart(game);
  if (start !== null && start !== 0) return 'leader-rotation';
  return null;
}

/** 人工清單（sim_bank_exclude.json）。 */
export interface SimExclusions {
  /** 總庫的局號（S977、DC 貼文 id…）：建題庫時擋。 */
  db: ReadonlySet<string>;
  /** 題庫的題號（QRSZY）：讀題庫、建題庫都擋。 */
  bank: ReadonlySet<string>;
  /** 指紋（generate_cache.record_fingerprint 的定義）：兩邊都擋。 */
  fp: ReadonlySet<string>;
}

export const NO_EXCLUSIONS: SimExclusions = { db: new Set(), bank: new Set(), fp: new Set() };

interface ExclusionEntry { db?: unknown; bank?: unknown; fp?: unknown }

/** 檔案內容 → 人工清單；形狀不對的筆略過。 */
export function parseSimExclusions(doc: unknown): SimExclusions {
  const games = (doc && typeof doc === 'object' && Array.isArray((doc as { games?: unknown }).games) ? (doc as { games: unknown[] }).games : []) as ExclusionEntry[];
  const pick = (k: keyof ExclusionEntry): Set<string> => new Set(games.map((g) => (g && typeof g[k] === 'string' ? (g[k] as string).trim() : '')).filter(Boolean));
  return { db: pick('db'), bank: pick('bank'), fp: pick('fp') };
}

export const SIM_EXCLUDE_FILE = 'sim_bank_exclude.json';

/** src/bots/simulation（或 dist/bots/simulation）往上三層 = packages/server。 */
export function defaultSimExclusionPaths(): string[] {
  return [
    path.resolve(__dirname, '..', '..', '..', SIM_EXCLUDE_FILE),
    path.resolve(process.cwd(), 'packages', 'server', SIM_EXCLUDE_FILE),
    path.resolve(process.cwd(), SIM_EXCLUDE_FILE),
  ];
}

/** 讀人工清單；沒有檔案或壞掉 → 空的清單（只 log 固定文字）。 */
export function readSimExclusions(paths: readonly string[] = defaultSimExclusionPaths()): SimExclusions {
  const file = paths.find((p) => fs.existsSync(p));
  if (!file) return NO_EXCLUSIONS;
  try {
    return parseSimExclusions(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    console.warn('[sim] sim_bank_exclude.json is unreadable; no manual exclusions');
    return NO_EXCLUSIONS;
  }
}

/** 題庫的一局在人工清單上（題號或指紋；指紋 = bankCodec.recordFingerprint）。 */
export function isExcludedBankGame(ex: SimExclusions, fingerprint: string, bankId?: string): boolean {
  return (!!bankId && ex.bank.has(bankId)) || ex.fp.has(fingerprint);
}
