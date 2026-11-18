/**
 * 主控台匯出（console:export）的 TypeScript 這一半：百科文章清單、觀念卡、一週草稿、manifest。
 * 牌譜這一半（problem_games.json、game_counts.json）在 packages/server/console_export.py（總庫是 Python）。
 * 系統圖與編輯回流見 docs/CONSOLE.md。
 *
 * 這裡的函式只讀這份 checkout 的檔案（與 git 歷史），不連網路、不需要憑證；輸出不含玩家名字。
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { wikiHeadingText, wikiHeadings } from '../../../web/src/utils/wikiSections';
import { wikiHash } from '../../../web/src/utils/wikiHash';

export const SITE_URL = 'https://avalon-game-platform.web.app';

export type GitRunner = (args: string[], cwd: string) => string;
export const defaultGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** JSON 檔：兩格縮排、結尾換行（重跑一字不差）。 */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

// ─── 百科文章清單（wiki_index.json） ─────────────────────────────────────────

export interface WikiArticle {
  id: string;
  title: string;
  category?: string;
  content: string;
  [key: string]: unknown;
}

export interface ArticleChange {
  commit: string;
  date: string;
  /** false＝git 歷史不完整（淺 clone），實際最後修改可能更早。 */
  exact: boolean;
}

export interface WikiIndexEntry {
  id: string;
  title: string;
  category: string;
  url: string;
  shareUrl: string;
  sections: { level: number; title: string; slug: string; url: string }[];
  lastChanged: ArticleChange | null;
}

function articleHash(a: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(a)).digest('hex');
}

/**
 * 每篇文章最後一次被改的 commit：從新到舊走過改到 wiki_data.json 的 commit，那一版跟前一版（更舊的）不一樣的
 * 最新一個就是。歷史走完還沒找到（文章從最舊那版就是這樣）：最舊那個 commit；淺 clone 時 exact = false。
 */
export function articleHistory(repoRoot: string, relPath: string, ids: readonly string[], git: GitRunner = defaultGit): Map<string, ArticleChange> {
  const out = new Map<string, ArticleChange>();
  let log: string;
  try {
    log = git(['log', '--format=%H%x09%cI', '--', relPath], repoRoot).trim();
  } catch {
    return out;
  }
  if (!log) return out;
  const commits = log.split('\n').map((l) => {
    const [commit, date] = l.split('\t');
    return { commit, date };
  });
  let shallow = false;
  try {
    shallow = git(['rev-parse', '--is-shallow-repository'], repoRoot).trim() === 'true';
  } catch {
    /* 舊版 git：當作完整 */
  }
  const versionAt = (commit: string): Map<string, string> => {
    try {
      const arr = JSON.parse(git(['show', `${commit}:${relPath}`], repoRoot)) as { id?: string }[];
      return new Map(arr.filter((a) => typeof a?.id === 'string').map((a) => [a.id as string, articleHash(a)] as [string, string]));
    } catch {
      return new Map();
    }
  };
  const pending = new Set(ids);
  let newer = versionAt(commits[0].commit);
  for (let i = 0; i < commits.length && pending.size; i++) {
    const older = i + 1 < commits.length ? versionAt(commits[i + 1].commit) : null;
    for (const id of [...pending]) {
      if (!newer.has(id)) continue; // 這一版還沒有這篇（後來才加的 id 在更新的 commit 已處理）
      if (older === null || older.get(id) !== newer.get(id)) {
        out.set(id, { commit: commits[i].commit, date: commits[i].date, exact: older !== null || !shallow });
        pending.delete(id);
      }
    }
    if (older) newer = older;
  }
  return out;
}

export function wikiIndex(articles: readonly WikiArticle[], history: ReadonlyMap<string, ArticleChange>): WikiIndexEntry[] {
  return articles.map((a) => {
    const base = `${SITE_URL}/${wikiHash(a.id)}`;
    return {
      id: a.id,
      title: a.title,
      category: a.category ?? '',
      url: base,
      shareUrl: `${SITE_URL}/w/${encodeURIComponent(a.id)}/`,
      sections: wikiHeadings(a.content ?? '')
        .filter((h) => h.level >= 2)
        .map((h) => ({ level: h.level, title: wikiHeadingText(h.text), slug: h.slug, url: `${SITE_URL}/${wikiHash(a.id, h.slug)}` })),
      lastChanged: history.get(a.id) ?? null,
    };
  });
}

// ─── 觀念卡（concepts.json） ─────────────────────────────────────────────────

export interface ConceptsExport {
  available: boolean;
  source: string;
  version?: number;
  count: number;
  concepts: unknown[];
  note?: string;
}

/**
 * 觀念卡庫照抄（packages/server/src/bots/threads/concepts.json）。這個分支沒有卡庫時 available = false。
 * 「過時」旗標要等觀念卡檢查（concepts check）進 main 才加；現在沒有，所以每張卡都不帶 stale 欄位。
 */
export function conceptsExport(file: string, relSource: string): ConceptsExport {
  if (!fs.existsSync(file)) {
    return { available: false, source: relSource, count: 0, concepts: [], note: '這個分支沒有 concepts.json（觀念卡庫還沒合併進 main）' };
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; concepts?: unknown[] };
  const concepts = Array.isArray(doc.concepts) ? doc.concepts : [];
  return { available: true, source: relSource, ...(typeof doc.version === 'number' ? { version: doc.version } : {}), count: concepts.length, concepts };
}

// ─── manifest ──────────────────────────────────────────────────────────────

export interface ManifestInput {
  sha: string;
  dirty: boolean;
  generatedAt: string;
  files: Record<string, Record<string, number | boolean | string>>;
  notes: string[];
}

export function manifest(input: ManifestInput): Record<string, unknown> {
  return {
    format: 'console-export',
    version: 1,
    /** 鏡像來源的 commit（＝ source.sha；主控台頁首直接讀這一欄）。 */
    sourceSha: input.sha,
    source: { repo: 'l12203685/avalonpediatw', sha: input.sha, dirty: input.dirty },
    /** 產生時間（ISO，UTC）。每次同步／重新發佈主控台都要更新（docs/CONSOLE.md）。 */
    generatedAt: input.generatedAt,
    files: Object.fromEntries(Object.entries(input.files).sort(([a], [b]) => a.localeCompare(b))),
    notes: input.notes,
  };
}

/** 這份 checkout 的 commit 與有沒有沒 commit 的改動（只看追蹤中的檔案）。 */
export function checkoutState(repoRoot: string, git: GitRunner = defaultGit): { sha: string; dirty: boolean } {
  try {
    const sha = git(['rev-parse', 'HEAD'], repoRoot).trim();
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], repoRoot).trim() !== '';
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

// ─── 一週草稿（week_drafts.json） ───────────────────────────────────────────

export const WEEKDAY_ZH = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const;

export interface WeekDay {
  date: string;
  weekday: string;
  theme: string;
  exerciseId: string;
  post: string;
  comment: string;
  commentSource: 'file' | 'fallback';
  images: string[];
  chars: { post: number; comment: number };
  /** 已經發出去（threads-state 有貼文記錄）：內容以發出去的版本為準。 */
  frozen: boolean;
  /** 貼文範本每個佔位符這天的內容（draft.parts 裡的字串），加上第一則留言的 {小觀念}。 */
  parts?: Record<string, string>;
  /** 這天的題型（#89 的 draft.parts.type：哪一種題目、用哪一份 byType 範本）。 */
  type?: WeekDayType;
  recordUrl?: string;
}

/** 題型（同 server draft.ts DraftParts 的 type）。 */
export interface WeekDayType {
  kind: string;
  name: string;
}

/** draft.parts：佔位符 → 內容，另有 type（#89 起是 { kind, name }，不是字串）。 */
export type DraftPartsInput = { readonly [key: string]: string | WeekDayType };

/** 拆成佔位符的字串內容與題型。 */
export function splitDraftParts(parts: DraftPartsInput): { parts: Record<string, string>; type?: WeekDayType } {
  const out: Record<string, string> = {};
  let type: WeekDayType | undefined;
  for (const [k, v] of Object.entries(parts)) {
    if (typeof v === 'string') out[k] = v;
    else if (k === 'type' && v && typeof v.kind === 'string' && typeof v.name === 'string') type = { kind: v.kind, name: v.name };
  }
  return type ? { parts: out, type } : { parts: out };
}

export interface WeekDraftsDoc {
  generatedAt: string;
  start: string;
  days: WeekDay[];
  templateSupport: boolean;
  template?: unknown;
  missing: string[];
}

export function weekDay(input: {
  date: string;
  weekday: number;
  draft: { theme: string; exerciseId: string; recordId?: string; post: { text: string } } & { parts?: DraftPartsInput };
  comment: string;
  commentSource: 'file' | 'fallback';
  images: string[];
  frozen: boolean;
}): WeekDay {
  const { draft } = input;
  const split = draft.parts ? splitDraftParts(draft.parts) : null;
  return {
    date: input.date,
    weekday: WEEKDAY_ZH[input.weekday],
    theme: draft.theme,
    exerciseId: draft.exerciseId,
    post: draft.post.text,
    comment: input.comment,
    commentSource: input.commentSource,
    images: input.images,
    chars: { post: [...draft.post.text].length, comment: [...input.comment].length },
    frozen: input.frozen,
    ...(split ? { parts: split.parts } : {}),
    ...(split?.type ? { type: split.type } : {}),
    ...(draft.recordId ? { recordUrl: `${SITE_URL}/#records=${draft.recordId}` } : {}),
  };
}
