/**
 * AI 擂台名冊：從資料夾讀機器人（`community-bots/<id>/profile.json`），加上內建的示範對手
 * （`community-bots/_examples/<id>/`），以及外部匯出的 profile 清單（例如之後網站上的「代理騎士」）。
 *
 * 社群資料夾在 repo 最上層、不在 Render 的 buildFilter 裡：新的機器人合併進 main 不會重新部署伺服器。
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateProfile, validateRoster, BOT_ID_RE, type BotProfile } from './profile';

export type BotSource = 'reference' | 'example' | 'house' | 'community' | 'extra';

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
export function checkBotFolder(folder: string, opts: { house?: boolean } = {}): FolderCheck {
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
  // 官方 AI騎士 帶殘差層權重（schema 2），上限放寬到 32 KB；社群投稿照舊 16 KB。
  const limitKb = (opts.house ?? isHouseFolder(folder)) ? 32 : 16;
  if (text.length > limitKb * 1024) errors.push(`profile.json 太大（上限 ${limitKb} KB）`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { id, ok: false, errors: [...errors, `profile.json 不是合法的 JSON：${(err as Error).message}`], warnings };
  }
  const house = opts.house ?? isHouseFolder(folder);
  const v = validateProfile(raw, id.startsWith('_') ? undefined : id, { house });
  return { id, ok: errors.length === 0 && v.ok, errors: [...errors, ...v.errors], warnings: v.warnings, profile: v.profile };
}

/** 官方 AI騎士 的資料夾（依玩家風格建立；作者固定「AI騎士團」，見 profile.ts `HOUSE_AUTHOR`）。 */
export const HOUSE_DIR = '_knights';
export const HOUSE_TITLE = 'AI騎士團';

/** 這個資料夾在 `community-bots/_knights/` 底下嗎。 */
export function isHouseFolder(folder: string): boolean {
  return path.basename(path.dirname(path.resolve(folder))) === HOUSE_DIR;
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
 * 讀整個名冊：百科AI（參考點）→ 示範對手 → 官方 AI騎士（`_knights/`）→ 社群機器人 → 外部清單。
 * 社群資料夾以 `_` 開頭的不算一般參賽者（`_template`；`_examples`、`_knights` 另外讀）。
 */
export function loadRoster(opts: { dir?: string; extra?: readonly RegisteredBot[]; includeExamples?: boolean; includeHouse?: boolean } = {}): Roster {
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
  if (opts.includeHouse !== false) {
    for (const name of subfolders(path.join(dir, HOUSE_DIR))) {
      const c = checkBotFolder(path.join(dir, HOUSE_DIR, name), { house: true });
      if (c.ok && c.profile) bots.push({ id: name, source: 'house', profile: c.profile, title: HOUSE_TITLE });
      else rejected.push({ id: `${HOUSE_DIR}/${name}`, errors: c.errors });
    }
    // 官方 AI騎士 不受「一人一隻」限制，但名字一樣不能重複（重複的、後面的不收）。
    const house = bots.filter((b) => b.source === 'house');
    const houseErrors = validateRoster(house.map((b) => ({ id: b.id, profile: { ...b.profile!, author: b.id } })));
    const dupHouse = new Set(houseErrors.map((e) => e.split('：')[0]));
    for (const id of dupHouse) {
      rejected.push({ id: `${HOUSE_DIR}/${id}`, errors: houseErrors.filter((e) => e.startsWith(`${id}：`)) });
      bots.splice(bots.findIndex((b) => b.source === 'house' && b.id === id), 1);
    }
  }
  const houseNames = new Set(bots.filter((b) => b.source === 'house').map((b) => b.profile!.name.toLowerCase().replace(/\s+/g, '')));
  const community: RegisteredBot[] = [];
  for (const name of subfolders(dir)) {
    if (name.startsWith('_')) continue;
    const c = checkBotFolder(path.join(dir, name));
    if (!c.ok || !c.profile) { rejected.push({ id: name, errors: c.errors }); continue; }
    if (bots.some((b) => b.id === name)) { rejected.push({ id: name, errors: [`資料夾名稱「${name}」和官方的機器人重複`] }); continue; }
    if (houseNames.has(c.profile.name.toLowerCase().replace(/\s+/g, ''))) { rejected.push({ id: name, errors: [`名字「${c.profile.name}」和官方的 AI騎士 重複`] }); continue; }
    community.push({ id: name, source: 'community', profile: c.profile });
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
