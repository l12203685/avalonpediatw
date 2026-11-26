/**
 * AI 擂台名冊：從資料夾讀機器人（`community-bots/<id>/profile.json`），加上內建的示範對手
 * （`community-bots/_examples/<id>/`），以及外部匯出的 profile 清單（例如之後網站上的「代理騎士」）。
 *
 * 社群資料夾在 repo 最上層、不在 Render 的 buildFilter 裡：新的機器人合併進 main 不會重新部署伺服器。
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateProfile, validateRoster, BOT_ID_RE, type BotProfile } from './profile';

export type BotSource = 'reference' | 'example' | 'community' | 'extra';

export interface RegisteredBot {
  id: string;
  source: BotSource;
  profile: BotProfile | null;
  /** 稱號（之後的「代理騎士」用：侍從／騎士／圓桌騎士）；社群資料夾沒有。 */
  title?: string;
}

export const REFERENCE_ID = 'baike';
export const REFERENCE_NAME = '百科AI';

/** 資料夾裡允許的檔案：資料，不是程式。 */
export const ALLOWED_FILES = new Set(['profile.json', 'README.md']);

export function defaultCommunityDir(): string {
  return path.resolve(__dirname, '../../../../community-bots');
}

export interface FolderCheck {
  id: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  profile?: BotProfile;
}

/** 檢查一個機器人資料夾（`arena:check` 與名冊共用）。 */
export function checkBotFolder(folder: string): FolderCheck {
  const id = path.basename(path.resolve(folder));
  const errors: string[] = [];
  const warnings: string[] = [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folder);
  } catch {
    return { id, ok: false, errors: [`找不到資料夾 ${folder}`], warnings };
  }
  if (!stat.isDirectory()) return { id, ok: false, errors: [`${folder} 不是資料夾`], warnings };
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || !ALLOWED_FILES.has(entry.name)) {
      errors.push(`不允許的${entry.isDirectory() ? '資料夾' : '檔案'}「${entry.name}」：只能放 profile.json 和（可選的）README.md`);
    }
  }
  const file = path.join(folder, 'profile.json');
  if (!fs.existsSync(file)) return { id, ok: false, errors: [...errors, '缺少 profile.json'], warnings };
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > 16 * 1024) errors.push('profile.json 太大（上限 16 KB）');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { id, ok: false, errors: [...errors, `profile.json 不是合法的 JSON：${(err as Error).message}`], warnings };
  }
  const v = validateProfile(raw, id.startsWith('_') ? undefined : id);
  return { id, ok: errors.length === 0 && v.ok, errors: [...errors, ...v.errors], warnings: v.warnings, profile: v.profile };
}

function subfolders(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

export interface Roster {
  bots: RegisteredBot[];
  /** 讀不進來的資料夾（排行榜不收，原因列出來）。 */
  rejected: { id: string; errors: string[] }[];
}

/**
 * 讀整個名冊：百科AI（參考點）→ 示範對手 → 社群機器人 → 外部清單。
 * 社群資料夾以 `_` 開頭的不算參賽（`_template`、`_examples`）。
 */
export function loadRoster(opts: { dir?: string; extra?: readonly RegisteredBot[]; includeExamples?: boolean } = {}): Roster {
  const dir = opts.dir ?? defaultCommunityDir();
  const bots: RegisteredBot[] = [{ id: REFERENCE_ID, source: 'reference', profile: null }];
  const rejected: Roster['rejected'] = [];
  if (opts.includeExamples !== false) {
    for (const name of subfolders(path.join(dir, '_examples'))) {
      const c = checkBotFolder(path.join(dir, '_examples', name));
      if (c.ok && c.profile) bots.push({ id: `example-${name}`, source: 'example', profile: c.profile });
      else rejected.push({ id: `_examples/${name}`, errors: c.errors });
    }
  }
  const community: RegisteredBot[] = [];
  for (const name of subfolders(dir)) {
    if (name.startsWith('_')) continue;
    const c = checkBotFolder(path.join(dir, name));
    if (c.ok && c.profile) community.push({ id: name, source: 'community', profile: c.profile });
    else rejected.push({ id: name, errors: c.errors });
  }
  const rosterErrors = validateRoster(community.map((b) => ({ id: b.id, profile: b.profile! })));
  // 名字重複／一人兩隻：後面的（資料夾名稱排序）不收。
  const dropped = new Set(rosterErrors.map((e) => e.split('：')[0]));
  for (const b of community) {
    if (dropped.has(b.id)) rejected.push({ id: b.id, errors: rosterErrors.filter((e) => e.startsWith(`${b.id}：`)) });
    else bots.push(b);
  }
  const taken = new Set(bots.map((b) => b.id));
  for (const b of opts.extra ?? []) {
    if (taken.has(b.id)) { rejected.push({ id: b.id, errors: ['id 和名冊裡的機器人重複'] }); continue; }
    taken.add(b.id);
    bots.push(b);
  }
  return { bots, rejected };
}

/**
 * 外部 profile 清單（JSON）：`{ "profiles": [{ "id": "knight-xxx", "title": "騎士", "profile": {...} }] }`。
 * 每一份都過同一套 `validateProfile`；id 規則同資料夾名稱。
 */
export function parseExtraProfiles(raw: unknown): { bots: RegisteredBot[]; rejected: { id: string; errors: string[] }[] } {
  const bots: RegisteredBot[] = [];
  const rejected: { id: string; errors: string[] }[] = [];
  const list = (raw as { profiles?: unknown })?.profiles;
  if (!Array.isArray(list)) return { bots, rejected: [{ id: '(extra)', errors: ['外部清單要是 {"profiles": [...]}'] }] };
  for (const item of list) {
    const id = String((item as { id?: unknown })?.id ?? '');
    if (!BOT_ID_RE.test(id)) { rejected.push({ id: id || '(no id)', errors: ['id 只能用小寫英文、數字、減號，2–32 個字'] }); continue; }
    const v = validateProfile((item as { profile?: unknown }).profile);
    if (!v.ok || !v.profile) { rejected.push({ id, errors: v.errors }); continue; }
    const title = (item as { title?: unknown }).title;
    const bot: RegisteredBot = { id, source: 'extra', profile: v.profile };
    if (typeof title === 'string' && title.trim() && [...title.trim()].length <= 8) bot.title = title.trim();
    bots.push(bot);
  }
  return { bots, rejected };
}
