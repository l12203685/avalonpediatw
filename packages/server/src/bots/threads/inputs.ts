/**
 * Threads 腳本共用的輸入（threads:draft、threads:candidates 讀同一份）：站長選的題目與存下來的草稿。
 *
 * - 選的題目：threads_picks.json 的每一天都用，包括今天和過去的日子（站長前一天選的今天的題目、昨天的答案要對上昨天的題）。
 * - 存下來的草稿：`<資料夾>/<日期>.json`；已經發出去的那一天以它為準（產生器的 pickFor 存下來的優先），
 *   所以選擇之後改了也不會換掉已經貼出去的題目。
 */

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
