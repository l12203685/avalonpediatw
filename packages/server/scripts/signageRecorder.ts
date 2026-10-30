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
 * 有設定環境變數 DISCORD_PAIPU_WEBHOOK_URL（DC 牌譜頻道的 Webhook）時，每局結束把牌譜貼過去（scripts/signagePaipu.ts）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gameToPaipu, postPaipu, type RecordedGame } from './signagePaipu';

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
    let game: { startedAt: string; timeline: { t: string; s: Snapshot }[] } | null = null;
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
          inGame = true; sawEnd = false; game = { startedAt: stamp(), timeline: [] }; last = '';
          console.log(`${stamp()} ${room.name} 開局`);
        }
        const key = JSON.stringify(s);
        if (game && key !== last) { game.timeline.push({ t: stamp(), s }); last = key; }
        if (inGame && game && (s.status === ENDED || !s.gaming) && !sawEnd) {
          sawEnd = true;
          // 局末：多等一下讓公開角色、刺殺、勝負的畫面資料進來，再取最後一張
          await sleep(3000);
          let end: Snapshot | null = null;
          try { end = await withTimeout(page.evaluate(SNAP_JS), 10000, 'snap'); } catch { end = null; }
          const text: string = await page.evaluate('document.body.innerText').catch(() => '');
          // 練習台自己的「紀錄下載」頁（整局派票紀錄；中途才進房時補前面漏掉的提議）
          let statsHtml = '';
          try {
            // 在頁面裡抓（帶登入 cookie、走瀏覽器的網路設定）
            statsHtml = await withTimeout(page.evaluate(
              `fetch('/Statistics/Index/${encodeURIComponent(room.name)}', { credentials: 'include' }).then((r) => r.ok ? r.text() : 'HTTP ' + r.status)`,
            ), 20000, 'statistics');
          } catch (err) { statsHtml = `ERROR ${err instanceof Error ? err.message : String(err)}`; }
          const file = path.join(OUT, `${safe(game.startedAt)}_${safe(room.name)}.json`);
          fs.writeFileSync(file, JSON.stringify({
            source: 'signage-cloud', room: room.name, title: room.description_title ?? '', publicRoom: room.is_publish_room ?? null,
            startedAt: game.startedAt, endedAt: stamp(), end, endText: text.slice(0, 6000), statsHtml, timeline: game.timeline,
          }));
          console.log(`${stamp()} ${room.name} 結束，存檔 ${path.basename(file)}（${game.timeline.length} 張快照）`);
          // Edward 2026-10-30：每局牌譜貼到 DC 牌譜頻道（附座位暱稱）；有設定 DISCORD_PAIPU_WEBHOOK_URL 才貼
          try {
            const text = gameToPaipu(JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordedGame);
            if (text && (await postPaipu(text))) console.log(`${stamp()} ${room.name} 牌譜已貼到 Discord`);
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

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
