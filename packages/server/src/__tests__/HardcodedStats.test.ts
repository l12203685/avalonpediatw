/**
 * 守門：使用者看得到的統計數字不能寫死（站長 2026-11-20「所有跟數字統計有關的 都應該跟資料庫連動 而不是寫死」、
 * 「我說了要跟數據分析還有勝率統計那邊同步啊 整個系統要完全同步同來源」）。
 *
 * 掃主要的統計出口：百科文章（wiki_data.json、docs/avalon-wiki 副本）、網站介面字串與程式、觀念卡、
 * Threads 留言與範本、LINE／DC 機器人的回覆程式。抓「看起來是從牌譜算出來、又寫死在檔案裡」的寫法：
 *   - 比率旁邊帶樣本數：「70.1%（n=568）」「n=240 … 44%」
 *   - 次數帶比率：「989 (46%)」「723（30.9%）」、比率帶局數：「53.3%（16 場）」
 *   - 上千局的樣本數：「2146 場」「2,284 局」
 *   - 快照寫法：「統計日 2026-10-30」
 * 數字要嘛從資料算（網站讀 API／快取；百科放在 `<!-- stat:KEY -->` 標記裡，由 wiki_stats.py 每晚重算，
 * 這裡會先拿掉標記裡的內容），要嘛是刻意的歷史引用：那就寫明日期與樣本，並加進下面的 ALLOW（附理由）。
 * 機率的算式（10/36 ≈ 27.8%）、門檻（S ≥ 65、30 場以上）、程式註解不算。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SERVER = path.join(ROOT, 'packages', 'server');
const WEB_SRC = path.join(ROOT, 'packages', 'web', 'src');

const PATTERNS: Array<[string, RegExp]> = [
  ['比率帶樣本數', /\d+(?:\.\d+)?\s*%[^\n。；;]{0,12}?\bn\s*[=＝]\s*\d{2,}|\bn\s*[=＝]\s*\d{2,}[^\n。；;]{0,12}?\d+(?:\.\d+)?\s*%/],
  ['次數帶比率', /\d[\d,]*\s*(?:局|場|次|筆|games?)?\s*[（(]\s*\d+(?:\.\d+)?\s*%\s*[）)]/],
  ['比率帶局數', /\d+(?:\.\d+)?\s*%\s*[（(]\s*\d[\d,]*\s*(?:局|場|筆)/],
  ['上千局的樣本數', /(?<![\d,.])(?:\d,\d{3}|[1-9]\d{3})\s*(?:局|場)(?!次)/],
  ['快照寫法', /統計日\s*\d{4}-\d{2}-\d{2}/],
  ['比率對比', /\d+(?:\.\d+)?\s*%\s*對\s*\d+(?:\.\d+)?\s*%/],
];

/**
 * 刻意保留的歷史數字（附日期與樣本），鍵是「出處」（文章 id 或 repo 相對路徑），值是理由。
 * 只列真的需要的；出處裡新的寫死數字一樣會被擋（見最後一個測試：每個例外都還用得到）。
 */
const ALLOW: Record<string, { pattern: RegExp; why: string }[]> = {
  'wiki-182': [{ pattern: /三(?:紅|藍梅死|藍梅活)：\d+\.\d%（\d+ 場）/, why: '2023 年 S2 積分賽的戰績（已結束的賽季，標題寫明 2023）' }],
  'wiki-147': [
    { pattern: /n=2[04]0|n=480/, why: '2026-11-16 的一次性統計，文中寫明日期與 n、不隨每晚更新' },
    { pattern: /約 56% 對 55%/, why: '2026-11-16 同一段一次性統計，待 wiki_stats.py 補動態標記後移除' },
  ],
  'wiki-209': [{ pattern: /牌譜數據報告（2,146 局，資料至 2026-02）/, why: '引用舊報告的標題（本文整合自…），不是現在的數字' }],
};

const STAT_SPAN_RE = /<!-- stat:[A-Za-z0-9_.-]+ -->[\s\S]*?<!-- \/stat -->/g;

interface Hit { where: string; kind: string; text: string }

function scanText(where: string, text: string, hits: Hit[]): void {
  const body = text.replace(STAT_SPAN_RE, '');
  for (const line of body.split('\n')) {
    for (const [kind, re] of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const allowed = (ALLOW[where] ?? []).some((a) => a.pattern.test(line));
      if (!allowed) hits.push({ where, kind, text: line.trim().slice(0, 160) });
    }
  }
}

/** 程式檔：只看不是註解的行（`//`、`/*`、` * ` 開頭的行略過）。 */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

function walk(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      walk(p, accept, out);
    } else if (accept(p)) out.push(p);
  }
  return out;
}

function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsOf(x, out));
  return out;
}

const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/');

function collect(): Hit[] {
  const hits: Hit[] = [];
  // 百科：wiki_data.json 每篇（標題、摘要、內文）
  const wiki = JSON.parse(fs.readFileSync(path.join(SERVER, 'wiki_data.json'), 'utf8')) as Array<Record<string, unknown>>;
  for (const a of wiki) {
    for (const k of ['title', 'excerpt', 'content']) if (typeof a[k] === 'string') scanText(String(a.id), a[k] as string, hits);
  }
  // 百科的 Markdown 副本
  for (const p of walk(path.join(ROOT, 'docs', 'avalon-wiki'), (f) => f.endsWith('.md'))) scanText(rel(p), fs.readFileSync(p, 'utf8'), hits);
  // 網站介面字串
  for (const p of walk(path.join(WEB_SRC, 'i18n'), (f) => f.endsWith('.json'))) {
    for (const s of stringsOf(JSON.parse(fs.readFileSync(p, 'utf8')))) scanText(rel(p), s, hits);
  }
  // 網站程式（百科AI 優化歷程頁另案處理，不在這裡）
  for (const p of walk(WEB_SRC, (f) => /\.(tsx?|json)$/.test(f) && !/aiHistory|AiHistory|[/\\]i18n[/\\]/.test(f))) {
    const text = fs.readFileSync(p, 'utf8');
    scanText(rel(p), p.endsWith('.json') ? stringsOf(JSON.parse(text)).join('\n') : codeLines(text), hits);
  }
  // 網站首頁 HTML（防 SEO/meta 寫死局數與勝率）
  const webIndex = path.join(ROOT, 'packages', 'web', 'index.html');
  if (fs.existsSync(webIndex)) scanText(rel(webIndex), fs.readFileSync(webIndex, 'utf8'), hits);
  // 觀念卡（網址欄位除外：網址的 %E4… 不是比率）
  const concepts = JSON.parse(fs.readFileSync(path.join(SERVER, 'src', 'bots', 'threads', 'concepts.json'), 'utf8')) as unknown;
  const noUrls = JSON.parse(JSON.stringify(concepts, (k, v) => (/url/i.test(k) ? undefined : v))) as unknown;
  for (const s of stringsOf(noUrls)) scanText('packages/server/src/bots/threads/concepts.json', s, hits);
  // Threads 第一則留言與貼文範本
  for (const p of walk(path.join(ROOT, 'docs', 'threads'), (f) => f.endsWith('.md'))) scanText(rel(p), fs.readFileSync(p, 'utf8'), hits);
  const template = path.join(SERVER, 'threads_template.json');
  if (fs.existsSync(template)) for (const s of stringsOf(JSON.parse(fs.readFileSync(template, 'utf8')))) scanText(rel(template), s, hits);
  // LINE／DC 機器人、Threads、模擬瓦的回覆程式
  for (const p of walk(path.join(SERVER, 'src', 'bots'), (f) => f.endsWith('.ts'))) scanText(rel(p), codeLines(fs.readFileSync(p, 'utf8')), hits);
  return hits;
}

describe('hard-coded statistics guard (站長 2026-11-20：統計數字跟資料庫連動、不寫死)', () => {
  it('no user-facing surface hard-codes a rate with its sample size, a 1,000+ game count or a 統計日 snapshot', () => {
    const hits = collect().map((h) => `${h.where} [${h.kind}] ${h.text}`);
    expect(hits).toEqual([]);
  });

  it('each wiki stat marker is closed and named (wiki_stats.py fills them; test_wiki_stats.py checks the numbers)', () => {
    const wiki = JSON.parse(fs.readFileSync(path.join(SERVER, 'wiki_data.json'), 'utf8')) as Array<{ id: string; content: string }>;
    const opens = wiki.flatMap((a) => [...a.content.matchAll(/<!-- stat:([A-Za-z0-9_.-]+) -->/g)].map((m) => `${a.id}:${m[1]}`));
    const closes = wiki.reduce((n, a) => n + (a.content.match(/<!-- \/stat -->/g)?.length ?? 0), 0);
    expect(opens.length).toBeGreaterThan(0);
    expect(closes).toBe(opens.length);
    // 牌譜數據紀錄整篇的數字都在標記裡
    expect(opens.filter((o) => o.startsWith('wiki-40:'))).toHaveLength(8);
  });

  it('every allowance is still needed (a fixed number leaves no stale exception behind)', () => {
    const wiki = JSON.parse(fs.readFileSync(path.join(SERVER, 'wiki_data.json'), 'utf8')) as Array<{ id: string; content: string }>;
    const text = (where: string): string => {
      const a = wiki.find((w) => w.id === where);
      if (a) return a.content;
      return fs.readFileSync(path.join(ROOT, where), 'utf8');
    };
    for (const [where, list] of Object.entries(ALLOW)) {
      for (const a of list) expect(a.pattern.test(text(where)), `${where}: ${a.why}`).toBe(true);
    }
  });

  it('the patterns catch the old hard-coded forms', () => {
    const hits: Hit[] = [];
    for (const s of [
      '2146 場全紀錄 · 三紅 989 (46%)',
      '首湖 70.1%（n=568）',
      '原組合 44%，n=240',
      '三紅：53.3%（16 場）',
      '本站牌譜（資料期間 2017-02-13～2026-10-25，2,284 局，統計日 2026-10-30）',
      '湖中留在藍方手上的機率約 56% 對 55%',
    ]) scanText('sample', s, hits);
    expect(new Set(hits.map((h) => h.text)).size).toBe(6);
    const clean: Hit[] = [];
    for (const s of ['兩人全好的機率約 28%（10/36）', 'S ≥ 65 高強度', '30 場以上', '<!-- stat:x -->2,341 局（30.9%）<!-- /stat -->']) scanText('sample', s, clean);
    expect(clean).toEqual([]);
  });
});
