/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 遊玩頁（avalon.signage-cloud.org）對局記錄員 —— Edward 2026-10-30：「常態性有一個『阿瓦隆百科』的帳號登入，
 * 去旁觀所有在上面開的局，都記錄下來」。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/signageRecorder.ts --out DIR [--nick 阿瓦隆百科] [--hours 6] [--max-rooms 8]
 *
 * - 大廳分頁以暱稱登入，每 10 秒看一次房間列表；每間房（野團、私房都一樣）開一個「觀眾席（雜魚視角）」分頁。
 * - 觀眾席只讀房間推來的畫面資料（`window.app`，練習台的 UpdateRoom），不按任何按鈕、不呼叫任何遊戲動作。
 * - 每 2 秒取一次快照，有變化才記；一局（gaming false → true → false）存成一個 JSON：時間軸＋局末快照。
 *   局末快照的座位角色若練習台有公開就一起存下。轉成網站紀錄格式另外做（`signageRecordConvert`）。
 * - 房間消失（練習台把觀眾導回大廳）就關掉那個分頁。
 *
 * 輸出含玩家暱稱：**不要放進公開 repo**（--out 預設在系統暫存目錄）。
 * 有設定 DISCORD_BOT_TOKEN（或 DISCORD_PAIPU_WEBHOOK_URL）時，每局結束把牌譜貼到 DC 牌譜頻道（scripts/signagePaipu.ts）；
 * 每日匯入（import-discord-records.yml）再把牌譜收進戰績。GitHub Actions 每晚排程：.github/workflows/signage-recorder.yml。
 * Edward 2026-11-03：每局都貼（沒通過檢查的標題加【待檢視】、不掛結果標籤），並附兩張圖：
 *   - 開牌後配置：局末（角色公開後）觀眾席畫面截圖，裁成座位＋任務板＋湖的那一塊（找不到就截整個畫面）。
 *   - 視覺化牌譜：練習台自己的「紀錄下載」頁（/Statistics/Index/房號，房內「紀錄下載」按鈕開的也是這頁，
 *     標題「派票與任務統計」：每輪的任務結果＋每次提議的投票格），切到「全部局次」分頁後截圖。
 *   截圖失敗只少那張圖，文字照貼；圖也存在 --out 旁邊（同檔名加 _board.jpg／_stats.jpg）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPaipuPost, dayIndex, postPaipu, unverifiedReason, type PaipuImage, type RecordedGame } from './signagePaipu';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const { chromium } = require('playwright') as { chromium: { launch(): Promise<any> } };
type Page = any;
type Browser = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const BASE = 'https://avalon.signage-cloud.org';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const NICK = arg('nick', '阿瓦隆百科');
const OUT = arg('out', path.join(os.tmpdir(), 'signage-records'));
const HOURS = Number(arg('hours', '6'));
const MAX_ROOMS = Number(arg('max-rooms', '8'));
const POLL_MS = 2000;

interface LobbyRoom { name: string; description_title?: string; is_publish_room?: boolean; length?: number; gaming?: boolean }
interface Snapshot {
  gaming: boolean; status: string; story: unknown; users: unknown; missions: unknown; missionResult: unknown;
  lake: unknown; meetings: unknown; missionHistorys: unknown; roles: unknown; dayTime: unknown;
  /** 局末才取：系統訊息（含刺殺、勝負）。 */
  logs?: unknown;
}
const ENDED = '遊戲結束';

const SNAP_JS = `(() => { const a = window.app; if (!a || !a.data_ready) return null;
  const j = (v) => JSON.parse(JSON.stringify(v ?? null));
  return { gaming: !!a.gaming, status: a.game_status ?? '', story: j(a.story_message), users: j(a.users), missions: j(a.missions),
    missionResult: j(a.mission_result), lake: j(a.lake_result), meetings: j(a.meetings), missionHistorys: j(a.mission_historys),
    roles: j(a.game_roles), dayTime: j(a.day_time), logs: a.game_status === '遊戲結束' ? j(a.logs) : undefined }; })()`;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`逾時：${what}`)), ms))]);
}

async function login(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('dialog', (d: { accept(): Promise<void> }) => { void d.accept(); });
  p.setDefaultTimeout(20000);
  await p.goto(`${BASE}/Account/Login`, { waitUntil: 'networkidle' });
  const f = p.locator('form[action="/Account/Submit"]');
  await f.locator('input[name=NickName]').fill(NICK);
  await f.locator('button[type=submit]').click();
  await p.waitForLoadState('networkidle');
  return p;
}

function stamp(): string { return new Date().toISOString(); }

/** 每張圖的上限（Discord 機器人上限 25MB，這裡留很多餘裕）。 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 截 JPEG；超過 MAX_IMAGE_BYTES 就降畫質再截，還是太大就放棄（回傳 null）。 */
async function jpeg(shoot: (quality: number) => Promise<Buffer>): Promise<Buffer | null> {
  for (const quality of [80, 55, 35]) {
    const buf = await shoot(quality);
    if (buf.length <= MAX_IMAGE_BYTES) return buf;
  }
  return null;
}

/**
 * 開牌後配置：局末觀眾席畫面。裁成左邊的座位＋任務板（第一個 .col-7）加上右邊的湖柱（.avalon-stone-pillar），
 * 不含右側聊天與房間設定；找不到這些區塊時截整個畫面。
 */
export async function boardShot(page: Page): Promise<Buffer | null> {
  const clip: { x: number; y: number; width: number; height: number } | null = await page.evaluate(`(() => {
    const rects = [document.querySelector('.col-7'), ...document.querySelectorAll('.avalon-stone-pillar')]
      .filter(Boolean).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 50 && r.height > 50);
    if (!rects.length) return null;
    const x = Math.max(0, Math.min(...rects.map((r) => r.left)) + window.scrollX);
    const y = Math.max(0, Math.min(...rects.map((r) => r.top)) + window.scrollY);
    const right = Math.max(...rects.map((r) => r.right)) + window.scrollX;
    const bottom = Math.max(...rects.map((r) => r.bottom)) + window.scrollY;
    return { x, y, width: Math.min(right, document.documentElement.scrollWidth) - x, height: Math.min(bottom - y, 2400) };
  })()`).catch(() => null);
  const ok = clip && clip.width > 200 && clip.height > 200;
  return jpeg((quality) => page.screenshot({ type: 'jpeg', quality, ...(ok ? { clip, fullPage: true } : {}) }));
}

/**
 * 視覺化牌譜：同一個登入的瀏覽器環境另開分頁到 /Statistics/Index/房號（頁面自己用 axios 抓資料畫表），
 * 等「全部局次」畫好，把它設成顯示中的分頁，截整個 #statistics-app。
 */
export async function statsShot(page: Page, room: string): Promise<Buffer | null> {
  const p = await page.context().newPage();
  p.on('dialog', (d: { accept(): Promise<void> }) => { void d.accept(); });
  try {
    await p.goto(`${BASE}/Statistics/Index/${encodeURIComponent(room)}?count=0`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForSelector('#sg_tab_all section', { state: 'attached', timeout: 20000 });
    await p.evaluate(`(() => {
      document.querySelectorAll('.tab-pane').forEach((e) => e.classList.remove('show', 'active'));
      document.querySelectorAll('.nav-tabs .nav-link').forEach((e) => e.classList.remove('active'));
      const all = document.querySelector('#sg_tab_all'); if (all) all.classList.add('show', 'active');
      const btn = document.querySelector('[data-bs-target="#sg_tab_all"]'); if (btn) btn.classList.add('active');
    })()`);
    // 任務牌圖片載完再截
    await p.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => undefined);
    await sleep(500);
    const app = p.locator('#statistics-app');
    return await jpeg((quality) => app.screenshot({ type: 'jpeg', quality, timeout: 15000 }));
  } finally {
    await p.close().catch(() => undefined);
  }
}

function safe(s: string): string { return s.replace(/[^\w.-]+/g, '_'); }

/** 旁觀一間房直到房間消失；每局存一個檔。 */
async function watchRoom(browser: Browser, room: LobbyRoom, stop: () => boolean): Promise<void> {
  const page = await login(browser);
  try {
    await page.evaluate((name: string) => {
      (document.querySelector('#watch_room_name') as HTMLInputElement).value = name;
      (document.querySelector('#watch_room') as HTMLFormElement).submit();
    }, room.name);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction('window.app && window.app.data_ready === true', undefined, { timeout: 30000 });
    console.log(`${stamp()} 開始旁觀 ${room.name}`);
    let game: { startedAt: string; timeline: { t: string; s: Snapshot }[]; joinedMidGame?: boolean } | null = null;
    let last = '';
    // 練習台局末顯示「遊戲結束」但 gaming 仍是 true（房主重開才變）；所以「結束」看狀態，
    // 「開局」看 gaming 為 true 且狀態不是遊戲結束。剛進房就是遊戲結束的那局不記。
    let inGame = false;
    let sawEnd = false;
    while (!stop()) {
      if (!/\/Room/i.test(page.url())) break; // 房間消失 → 被導回大廳
      let s: Snapshot | null = null;
      try { s = await withTimeout(page.evaluate(SNAP_JS), 10000, 'snap'); } catch { s = null; }
      if (s) {
        const live = s.gaming && s.status !== ENDED;
        if (live && !inGame) {
          // 剛進房時已經在打（已有任務結果或不只一次提議）＝中途加入：照樣記，但標出來（貼 DC 時標待檢視）
          const hist = Array.isArray(s.missionHistorys) ? s.missionHistorys.length : 0;
          const meets = Array.isArray(s.meetings) ? s.meetings.length : 0;
          const joinedMidGame = hist > 0 || meets > 1;
          inGame = true; sawEnd = false; game = { startedAt: stamp(), timeline: [], joinedMidGame }; last = '';
          console.log(`${stamp()} ${room.name} ${joinedMidGame ? '中途加入（貼 DC 時標待檢視）' : '開局'}`);
        }
        const key = JSON.stringify(s);
        if (game && key !== last) { game.timeline.push({ t: stamp(), s }); last = key; }
        if (inGame && game && (s.status === ENDED || !s.gaming) && !sawEnd) {
          sawEnd = true;
          // 局末：多等一下讓公開角色、刺殺、勝負的畫面資料進來，再取最後一張
          await sleep(3000);
          let end: Snapshot | null = null;
          try { end = await withTimeout(page.evaluate(SNAP_JS), 10000, 'snap'); } catch { end = null; }
          // Edward 11/03：「開牌後配置」的圖——角色公開後、房主重開前，先截觀眾席畫面
          let board: Buffer | null = null;
          try { board = await withTimeout(boardShot(page), 30000, 'board'); } catch { board = null; }
          const text: string = await page.evaluate('document.body.innerText').catch(() => '');
          // 練習台自己的「紀錄下載」頁（整局派票紀錄；中途才進房時補前面漏掉的提議）
          let statsHtml = '';
          try {
            // 在頁面裡抓（帶登入 cookie、走瀏覽器的網路設定）
            statsHtml = await withTimeout(page.evaluate(
              `fetch('/Statistics/Index/${encodeURIComponent(room.name)}', { credentials: 'include' }).then((r) => r.ok ? r.text() : 'HTTP ' + r.status)`,
            ), 20000, 'statistics');
          } catch (err) { statsHtml = `ERROR ${err instanceof Error ? err.message : String(err)}`; }
          // 「視覺化牌譜」的圖：同一頁畫出來的派票與任務統計
          let stats: Buffer | null = null;
          try { stats = await withTimeout(statsShot(page, room.name), 60000, 'stats'); } catch { stats = null; }
          const file = path.join(OUT, `${safe(game.startedAt)}_${safe(room.name)}.json`);
          fs.writeFileSync(file, JSON.stringify({
            source: 'signage-cloud', room: room.name, title: room.description_title ?? '', publicRoom: room.is_publish_room ?? null,
            startedAt: game.startedAt, endedAt: stamp(), joinedMidGame: Boolean(game.joinedMidGame), end, endText: text.slice(0, 6000), statsHtml, timeline: game.timeline,
          }));
          console.log(`${stamp()} ${room.name} 結束，存檔 ${path.basename(file)}（${game.timeline.length} 張快照）`);
          const images: PaipuImage[] = [];
          const base = file.replace(/\.json$/, '');
          if (board) images.push({ filename: 'board.jpg', data: board, contentType: 'image/jpeg' });
          if (stats) images.push({ filename: 'stats.jpg', data: stats, contentType: 'image/jpeg' });
          for (const [suffix, buf] of [['_board.jpg', board], ['_stats.jpg', stats]] as const) {
            if (buf) try { fs.writeFileSync(base + suffix, buf); } catch { /* 存不了圖不影響貼文 */ }
          }
          console.log(`${stamp()} ${room.name} 截圖：開牌後配置 ${board ? 'ok' : '失敗'}、視覺化牌譜 ${stats ? 'ok' : '失敗'}`);
          // Edward 2026-10-30：每局牌譜貼到 DC 牌譜頻道（附座位暱稱）；有設定 DISCORD_BOT_TOKEN 或 DISCORD_PAIPU_WEBHOOK_URL 才貼
          // Edward 2026-11-03：每局都貼——沒通過檢查的標題加【待檢視】、不掛結果標籤（buildPaipuPost）；附兩張圖
          try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordedGame;
            // 第n局（dayIndex）只數通過檢查的局；待檢視的局標題不寫第幾局
            const post = buildPaipuPost(saved, dayIndex(file));
            if (!post.verified) console.log(`${stamp()} ${room.name} 待檢視：${unverifiedReason(saved)}`);
            if (await postPaipu(post.content, post.name, post.tags, images)) {
              console.log(`${stamp()} ${room.name} 牌譜已貼到 Discord（${post.verified ? '正式' : '待檢視'}，${images.length} 張圖）`);
            }
          } catch (err) {
            console.log(`${stamp()} ${room.name} 牌譜貼到 Discord 失敗：${err instanceof Error ? err.message : String(err)}`);
          }
          game = null; inGame = false;
        }
      }
      await sleep(POLL_MS);
    }
    if (game) {
      const file = path.join(OUT, `${safe(game.startedAt)}_${safe(room.name)}_incomplete.json`);
      fs.writeFileSync(file, JSON.stringify({ source: 'signage-cloud', room: room.name, incomplete: true, startedAt: game.startedAt, timeline: game.timeline }));
      console.log(`${stamp()} ${room.name} 中途離開，存未完成檔 ${path.basename(file)}`);
    }
  } finally {
    console.log(`${stamp()} 停止旁觀 ${room.name}`);
    await page.context().close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const deadline = Date.now() + HOURS * 3600_000;
  const stop = (): boolean => Date.now() > deadline;
  const watching = new Map<string, Promise<void>>();
  let lobby = await login(browser);
  console.log(`${stamp()} 記錄員「${NICK}」上線，輸出 ${OUT}，最多同時 ${MAX_ROOMS} 間，${HOURS} 小時`);
  while (!stop()) {
    let rooms: LobbyRoom[] = [];
    try {
      rooms = await withTimeout(lobby.evaluate('JSON.parse(JSON.stringify((window.app && window.app.rooms) || []))'), 10000, 'rooms');
    } catch (err) {
      console.log(`${stamp()} 大廳讀取失敗（${err instanceof Error ? err.message : String(err)}），重新登入`);
      await lobby.context().close().catch(() => undefined);
      lobby = await login(browser).catch(() => lobby);
    }
    for (const r of rooms) {
      if (watching.has(r.name) || watching.size >= MAX_ROOMS) continue;
      const job = watchRoom(browser, r, stop)
        .catch((err) => console.log(`${stamp()} 旁觀 ${r.name} 失敗：${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { watching.delete(r.name); });
      watching.set(r.name, job);
    }
    await sleep(10000);
  }
  await Promise.allSettled([...watching.values()]);
  await browser.close();
  console.log(`${stamp()} 記錄員結束`);
}

// 直接執行才啟動（測試可以 import 截圖函式）
if (process.argv[1] && path.basename(process.argv[1]).startsWith('signageRecorder')) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}
