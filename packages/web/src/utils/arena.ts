/**
 * AI 擂台（#arena；站長 2026-11-26「提供個人AI的雛形 … 以後就可以是一堆自建AI對戰」）。
 *
 * 排行榜 arena/leaderboard.json 由 .github/workflows/arena-tournament.yml 每週產生、commit 在 main 的 repo 最上層
 * （不在 packages/ 裡，所以不會觸發網站或伺服器重新部署）；網站在瀏覽器裡直接讀 GitHub 上的那一份。
 * 格式見 packages/server/src/arena/report.ts（`Leaderboard`）。
 */
import { knightDisplayName } from './knightNames';
import { REPO_URL } from '../i18n/collab';

export const LEADERBOARD_URL = 'https://raw.githubusercontent.com/l12203685/avalonpediatw/main/arena/leaderboard.json';
export const BOTS_README_URL = `${REPO_URL}/blob/main/community-bots/README.md`;
export const TEMPLATE_URL = `${REPO_URL}/tree/main/community-bots/_template`;
export const BOTS_FOLDER_URL = `${REPO_URL}/tree/main/community-bots`;

export interface SideRating { rating: number; low: number; high: number }

export interface ArenaBot {
  rank: number;
  id: string;
  name: string;
  author: string | null;
  source: 'reference' | 'example' | 'community' | 'extra';
  title: string | null;
  style: string;
  knobs: string[];
  rating: { overall: SideRating; red: SideRating; blue: SideRating };
  seats: number;
  games: number;
  red: { seats: number; winRate: number };
  blue: { seats: number; winRate: number };
  assassin: { tries: number; hits: number };
}

export interface KnobCatalogEntry {
  key: string;
  kind: 'number' | 'boolean';
  side: 'good' | 'evil' | 'assassin';
  min?: number;
  max?: number;
  default: number | boolean;
  zh: string;
  en: string;
}

export interface ArenaLeaderboard {
  schema: number;
  generatedAt: string;
  games: number;
  sizes: number[];
  bots: ArenaBot[];
  knobCatalog?: KnobCatalogEntry[];
}

/** 粗略檢查格式（GitHub 上的檔案壞掉時網站顯示「讀不到」，不要整頁壞掉）。 */
export function parseLeaderboard(raw: unknown): ArenaLeaderboard | null {
  const d = raw as Partial<ArenaLeaderboard> | null;
  if (!d || d.schema !== 1 || !Array.isArray(d.bots)) return null;
  const okBot = (b: unknown): b is ArenaBot => {
    const x = b as Partial<ArenaBot>;
    return typeof x?.id === 'string' && typeof x.name === 'string' && typeof x.rating?.overall?.rating === 'number'
      && typeof x.red?.winRate === 'number' && typeof x.blue?.winRate === 'number';
  };
  if (!d.bots.every(okBot)) return null;
  return {
    schema: 1,
    generatedAt: String(d.generatedAt ?? ''),
    games: Number(d.games ?? 0),
    sizes: Array.isArray(d.sizes) ? d.sizes.map(Number) : [],
    // 舊排行榜上的「百科AI」顯示成「AI騎士_百科」（站長 2026-11-26 改名；下一次每週重算就是新名字）
    bots: d.bots.map((b) => (b.id === 'baike' ? { ...b, name: knightDisplayName(b.name) } : b)),
    knobCatalog: Array.isArray(d.knobCatalog) ? d.knobCatalog : undefined,
  };
}

export async function fetchLeaderboard(signal?: AbortSignal): Promise<ArenaLeaderboard | null> {
  const res = await fetch(LEADERBOARD_URL, { signal, cache: 'no-cache' });
  if (!res.ok) return null;
  return parseLeaderboard(await res.json());
}

/** 「給你的 AI 的提示」最後附上的開關清單（從排行榜檔的 knobCatalog 來；讀不到時只留 README 連結）。 */
export function knobLines(catalog: readonly KnobCatalogEntry[] | undefined, lang: 'zh' | 'en'): string {
  if (!catalog || catalog.length === 0) return '';
  return catalog.map((k) => {
    const range = k.kind === 'boolean' ? 'true/false' : `${k.min}–${k.max}`;
    return `- ${k.key}（${range}，${lang === 'zh' ? '預設' : 'default'} ${String(k.default)}）：${lang === 'zh' ? k.zh : k.en}`;
  }).join('\n');
}

export function fmtRating(r: SideRating): string {
  return Math.round(r.rating).toString();
}

export function fmtInterval(r: SideRating): string {
  return `${Math.round(r.low)}–${Math.round(r.high)}`;
}

export function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
