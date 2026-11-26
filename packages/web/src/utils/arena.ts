/**
 * AI 擂台（#arena；站長 2026-11-26「提供個人AI的雛形 … 以後就可以是一堆自建AI對戰」）。
 *
 * 排行榜 arena/leaderboard.json 由 .github/workflows/arena-tournament.yml 每天產生（每日大賽 12 萬局＋合併後補跑）、commit 在 main 的 repo 最上層
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
  source: 'reference' | 'example' | 'house' | 'community' | 'extra';
  title: string | null;
  /** 風格標籤（依玩家風格建立的 AI騎士 才有；舊的排行榜沒有這個欄位）。 */
  tag?: string | null;
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

/** 每日大賽的資訊（packages/server/src/arena/report.ts `DailyInfo`；舊的每週排行榜沒有）。 */
export interface ArenaDaily {
  date: string;
  gamesToday: number;
  runsToday: number;
  gamesTotal: number;
}

/** 最近幾天的總分走勢（packages/server/src/arena/daily.ts `Trend`）。 */
export interface ArenaTrend {
  dates: string[];
  ratings: Record<string, (number | null)[]>;
}

export interface ArenaLeaderboard {
  schema: number;
  generatedAt: string;
  games: number;
  sizes: number[];
  bots: ArenaBot[];
  knobCatalog?: KnobCatalogEntry[];
  daily?: ArenaDaily;
  trend?: ArenaTrend;
}

function parseDaily(raw: unknown): ArenaDaily | undefined {
  const d = raw as Partial<ArenaDaily> | null | undefined;
  if (!d || typeof d.date !== 'string' || typeof d.gamesToday !== 'number' || typeof d.gamesTotal !== 'number') return undefined;
  return { date: d.date, gamesToday: d.gamesToday, runsToday: Number(d.runsToday ?? 1), gamesTotal: d.gamesTotal };
}

function parseTrend(raw: unknown): ArenaTrend | undefined {
  const t = raw as Partial<ArenaTrend> | null | undefined;
  if (!t || !Array.isArray(t.dates) || !t.ratings || typeof t.ratings !== 'object') return undefined;
  const n = t.dates.length;
  const ratings: Record<string, (number | null)[]> = {};
  for (const [id, xs] of Object.entries(t.ratings)) {
    if (Array.isArray(xs) && xs.length === n) ratings[id] = xs.map((x) => (typeof x === 'number' ? x : null));
  }
  return { dates: t.dates.map(String), ratings };
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
    // 舊排行榜上的「百科AI」顯示成「AI騎士_百科」（站長 2026-11-26 改名；下一次重算就是新名字）
    bots: d.bots.map((b) => (b.id === 'baike' ? { ...b, name: knightDisplayName(b.name) } : b)),
    knobCatalog: Array.isArray(d.knobCatalog) ? d.knobCatalog : undefined,
    daily: parseDaily(d.daily),
    trend: parseTrend(d.trend),
  };
}

/** 排行榜產生的時間，台灣時間「YYYY-MM-DD HH:mm」（讀不懂就原樣回傳日期部分）。 */
export function fmtTaipeiTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** 局數：12,345。 */
export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * 小走勢圖的折線點（SVG 座標）。少於兩個有分數的點就不畫（回傳 null）。
 * 縱軸以這隻自己的高低為範圍，但至少 40 分高，免得小抖動看起來像大起伏。
 */
export function sparkPoints(values: readonly (number | null)[], width: number, height: number): string | null {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2 || values.length < 2) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const span = Math.max(hi - lo, 40);
  const mid = (hi + lo) / 2;
  const pad = 1.5;
  const x = (i: number): number => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number): number => pad + (1 - ((v - mid) / span + 0.5)) * (height - 2 * pad);
  return pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
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
