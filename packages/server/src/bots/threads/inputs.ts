/**
 * Threads 腳本共用的輸入（threads:draft、threads:candidates 讀同一份）：站長選的題目與存下來的草稿。
 *
 * - 選的題目：threads_picks.json 的每一天都用，包括今天和過去的日子（站長前一天選的今天的題目、昨天的答案要對上昨天的題）。
 * - 存下來的草稿：`<資料夾>/<日期>.json`；已經發出去的那一天以它為準（產生器的 pickFor 存下來的優先），
 *   所以選擇之後改了也不會換掉已經貼出去的題目。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ThreadsDraft } from './draft';
import { parsePicks } from './picksFile';

/** 讀站長選的題目檔（日期 → 題號）；路徑是空字串就沒有選擇。 */
export function readPicksFile(file: string): Map<string, string> {
  if (!file) return new Map();
  return parsePicks(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** 存下來的草稿：`dir/<日期>.json`，沒有或讀不了就 null。 */
export function savedDraftReader(dir: string): (date: string) => ThreadsDraft | null {
  return (date) => {
    const file = path.join(dir, `${date}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ThreadsDraft;
    } catch {
      return null;
    }
  };
}

/** 這份程式的 git 版本（百科AI 答案的 policy 欄位）：HEAD 的 SHA、有沒有沒 commit 的改動；不是 git 或沒有 git 就 null。 */
export function gitVersion(cwd: string): { sha: string | null; dirty?: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: null };
  }
}
