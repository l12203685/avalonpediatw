/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 百科機器人去遊玩頁（avalon.signage-cloud.org）補位 —— Edward 2026-11-03：
 *「我希望你可以在晚上百科群的人開局的時候 如果人不夠 就加進去玩1-2局試試看 用現有邏輯 我會請玩家反饋」
 * 同日追加：玩家可以指定房間叫機器人來測試（--room）。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/signagePlayer.ts --mode live [--max-games 2] [--hours 5.5]
 *   pnpm --filter @avalon/server exec tsx scripts/signagePlayer.ts --mode room --room Room-1460 [--games 1] [--hours 1]
 *   pnpm --filter @avalon/server exec tsx scripts/signagePlayer.ts --mode private-test [--games 1] [--private-log DIR]
 *
 * 一個帳號（暱稱「百科機器人（測試）」，只要暱稱、沒有密碼），一個瀏覽器分頁，走練習台本來的介面：
 * 每個動作都是呼叫房間頁自己的按鈕函式（app.Touch 點座位、app.Vote、app.ExcuteMission、app.LakeResult、
 * app.StartVote、app.Dialog 聊天），不自己組協定訊息。判斷用正式站同一個 HeuristicAgent（預設調校），
 * 只看自己座位畫面上看得到的資料（scripts/signageAdapter.ts）。不呼叫任何語言模型。
 *
 * 模式：
 *   - private-test：開有密碼的私房，用練習台內建機器人補滿 9 席、開湖，自己當房主開局，打完 --games 局。
 *     測試每一種動作用；不碰任何有真人的房間。
 *   - live（每晚）：只看「野團、等待中、9 個真人（沒有內建機器人）、標題沒說不要機器人」而且連續 ≥ --wait-min 分鐘的房間，
 *     加入前再確認還是 9 人；整晚最多 --max-games 局；每打完一局就離開（之後同一間房還缺人時，要再等 1 分鐘才回去）。
 *   - room（玩家指定）：直接去 --room 那間房，有空位（人數穩定 15 秒、沒有人正在進房）才坐下；
 *     私房要 --password。打完 --games 局（最多 3）就離開。
 * 共同（開局前）：房間設定是機器人打不了的（王者之劍、蘭斯洛特等角色；角色數和人數不合）就離開；房裡已經有另一個
 * （每間房最多 1 個的限制已拿掉，Edward 11/03）；等開局超過 --start-min 分鐘離開；有人離開（不再是滿桌缺一）也離開（live）；
 * 自己變成房主就離開。
 * 對局中不離開：練習台以暱稱認人，中途離開整桌會卡在等這個座位（2026-11-03 實測）。輪到自己卻 45 秒送不出動作就用保守的
 * 預設動作；被導回大廳就重新加入回原座位；程式掛掉時 workflow 重跑，--state 讓它先回去把那局打完。整局 15 分鐘沒有任何
 * 變化（整桌都不動了）才放棄。
 *
 * 公開 log（GitHub Actions）：只有時間、房號、狀態與局數；不寫暱稱、角色、聊天內容。
 * --private-log DIR（本機用）才把角色、夜晚資訊、每個決定寫進 DIR。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import type { PrivateLakeResult, QuestRecord, VoteRecord } from '../src/ai/types';
import type { Role } from '@avalon/shared';
import {
  ENDED, buildObservation, decisionOpen, evilRolesAtAssassination, historyFromRecord, lobbyCandidate, lobbyRolesLoose, missionCard,
  myLakeFromSnap, nextTeamAction, pendingDecision, pendingLakeDeclaration, readKnowledge, seatsCandidate, setOf,
  shortRooms, sid, unsupportedReason, validLakeTargets,
  type Decision, type Knowledge, type LobbyRoom, type PlatformRecord, type SiteAction, type Snap,
} from './signageAdapter';
import { BOT_NICK, TEST_ROOM_PREFIX, isPediaBotName } from './signagePaipu';

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
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const MODE = arg('mode', 'live') as 'live' | 'room' | 'private-test';
const HOURS = Number(arg('hours', MODE === 'live' ? '5.5' : '1'));
const MAX_GAMES = Math.max(0, Math.min(MODE === 'live' ? 2 : 3, Number(arg('max-games', arg('games', MODE === 'live' ? '2' : '1')))));
const ROOM = arg('room', '');
/**
 * 暱稱。練習台同一個暱稱同時兩個連線會互相干擾（2026-11-03 私房測試：同暱稱兩桌同時打，其中一桌被導回大廳），
 * 所以每個同時在跑的程序用不同暱稱，都是「百科AI_{#}」（Edward 2026-11-03；記錄員靠「百科AI」前綴認，戰績合併成「百科AI」）：
 *   - 每晚補位：百科AI_0
 *   - 指定房間（1 個）：百科AI_10～19（依房號個位數）——每間房一個 workflow（concurrency 依房號）
 *   - player_aliases.json 把 百科AI_0～19 都併成「百科AI」（Edward 11/03「百科AI玩的都當成同一個人」）
 *   - 指定房間多個（私房陪練、本機執行）：百科AI_1 … 百科AI_9
 *   - 看座位用的觀眾席分頁：百科AI看房1460（只旁觀、不入座；每間房各一個暱稱）
 */
const roomNo = (name: string): string => (/(\d+)\s*$/.exec(name)?.[1] ?? '');
const NICK = arg('nick', MODE === 'room' ? (roomNo(ROOM) ? `百科AI_${10 + (Number(roomNo(ROOM)) % 10)}` : '百科AI_1') : BOT_NICK);
const watchNick = (room: string): string => `百科AI看房${roomNo(room)}`;
const PASSWORD = arg('password', '');
/** 指定房間也可以用房間描述找（--title 文字：描述含這段文字的房間），玩家開房前不必先知道房號。 */
const ROOM_TITLE = arg('title', '');
const WAIT_MIN = Number(arg('wait-min', '3'));
const REJOIN_MIN = Number(arg('rejoin-min', '1'));
const START_MIN = Number(arg('start-min', '6'));
const PRIVATE_LOG = arg('private-log', '');
const CHAT = arg('chat', 'on') !== 'off';
/** 本機測試用：只看標題以這個開頭的房間（測每晚補位流程時，避免碰到真人的房間）。 */
const ONLY_TITLE = arg('only-title', '');
/**
 * --state FILE：坐進房間時記下房號，離開時刪掉。練習台以暱稱認人：對局中斷線（程式掛掉、runner 重開）後，同暱稱從大廳
 * 「加入」同一間房會回到原座位（2026-11-03 實測）；中途離開會讓整桌卡在等這個座位，所以重新啟動時先回去把那局打完。
 */
const STATE = arg('state', '');
/**
 * 每間房的百科機器人數：Edward 2026-11-03 先說「目前先限制B只能有一隻進入」，同晚改成「把每房最多1個全部拿掉
 * 不管私房或公開房」。指定房間（--bots）最多 9 個（自己對 9 個機器人）；每晚補位一次只派 1 個（一個程序一個帳號）。
 */
const MAX_BOTS_PER_ROOM = 1;
const MAX_BOTS_ROOM_MODE = 9;
const BOTS = Math.max(1, Math.min(MODE === 'room' ? MAX_BOTS_ROOM_MODE : MAX_BOTS_PER_ROOM, Number(arg('bots', '1')) || 1));
/** 第 i 個機器人（1 起算）的暱稱：只有 1 個時就是 NICK；多個時 百科AI_1 … 百科AI_9。 */
const botNick = (i: number, n: number): string => (n <= 1 ? NICK : `百科AI_${i}`);
/** 開局後的「開眼階段」狀態字串。 */
const EYES = '開眼階段';
/**
 * 輪到自己時等多久再按（毫秒）。Edward 2026-11-03：「百科AI的所有動作速度都可以再快一點 瞬間做完都沒差 因為是AI」
 * ——原本 1–3 秒，改成 --act-ms（預設 150）上下 50%；POLL_MS 是沒輪到自己時多久看一次畫面。
 */
const ACT_MS = Math.max(0, Number(arg('act-ms', '150')) || 0);
const actDelay = (): number => ACT_MS * (0.5 + Math.random());
const POLL_MS = 400;
const HELLO = '我是阿瓦隆百科的測試機器人，人不夠時來補位，打完會離開；有意見請到 DC 百科問題回報';

// ── log ──────────────────────────────────────────────────────────────────────────────
const stamp = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** 公開 log：只放時間、房號、狀態、局數。 */
const log = (msg: string): void => { console.log(`${stamp()} ${msg}`); };
/** 本機私人紀錄（角色、夜晚資訊、決定）：只有 --private-log 時寫。 */
function plog(msg: string): void {
  if (!PRIVATE_LOG) return;
  fs.mkdirSync(PRIVATE_LOG, { recursive: true });
  fs.appendFileSync(path.join(PRIVATE_LOG, 'player.log'), `${stamp()} ${msg}\n`);
}

// ── 頁面 ─────────────────────────────────────────────────────────────────────────────
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`逾時：${what}`)), ms))]);
}
const READY_JS = 'window.app && window.app.data_ready === true';
// 送進瀏覽器的程式一律用字串：tsx 會在函式裡插入 __name 輔助函式，瀏覽器端沒有它。
const SNAP_JS = `(() => {
  const a = window.app;
  if (!a || !a.data_ready) return null;
  const j = (v) => JSON.parse(JSON.stringify(v ?? null));
  return { gaming: !!a.gaming, status: a.game_status ?? '', myself: j(a.myself), users: j(a.users) ?? [], free_ticks: a.free_ticks,
    missions: j(a.missions) ?? [], mission_result: j(a.mission_result) ?? [], lake_result: j(a.lake_result) ?? [],
    game_roles: j(a.game_roles) ?? [], enable_lake: !!a.enable_lake, enable_sword: !!a.enable_sword };
})()`;
async function snap(p: Page): Promise<Snap | null> {
  return withTimeout(p.evaluate(SNAP_JS), 10000, 'snap') as Promise<Snap | null>;
}
const inRoom = (p: Page): boolean => /\/Room/i.test(p.url());

async function newPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1366, height: 900 } });
  // 機器人不需要看圖：擋掉圖片、字型、影音，多開幾個分頁時省 CPU 和流量（GitHub runner 4 核）
  await ctx.route('**/*', (route: { request(): { resourceType(): string }; abort(): Promise<void>; continue(): Promise<void> }) =>
    (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  const p = await ctx.newPage();
  // 練習台用 alert() 提示（例：房間已滿、密碼錯）；自動按掉，只記「有提示」，不記內容以外的東西
  p.on('dialog', (d: { message(): string; accept(): Promise<void> }) => {
    log('練習台跳出提示（內容只寫本機紀錄）');
    plog(`練習台提示：${d.message()}`);
    void d.accept();
  });
  p.setDefaultTimeout(20000);
  return p;
}
async function login(p: Page, nick: string): Promise<void> {
  await p.goto(`${BASE}/Account/Login`, { waitUntil: 'networkidle' });
  const f = p.locator('form[action="/Account/Submit"]');
  await f.locator('input[name=NickName]').fill(nick);
  await f.locator('button[type=submit]').click();
  await p.waitForLoadState('networkidle');
}
async function lobbyRooms(p: Page): Promise<LobbyRoom[]> {
  return withTimeout(p.evaluate('JSON.parse(JSON.stringify((window.app && window.app.rooms) || []))'), 10000, 'rooms') as Promise<LobbyRoom[]>;
}

/**
 * 按房間頁的按鈕：呼叫 app 的同名方法（房間頁的按鈕也是呼叫這些方法）。app 自己有「上一個動作還沒回應就不送」的保護
 * （ux_disable），先等它解除；回傳 'ok'／'busy'／'gone'。
 */
async function press(p: Page, a: SiteAction): Promise<string> {
  const js = `(async () => {
    const app = window.app; const a = ${JSON.stringify(a)};
    for (let i = 0; i < 40 && app.ux_disable; i++) await new Promise((r) => setTimeout(r, 100));
    if (app.ux_disable) return 'busy';
    switch (a.kind) {
      case 'touch': { const u = app.users.find((x) => x.set === a.set); if (!u) return 'gone'; app.Touch(u); break; }
      case 'startVote': app.StartVote(); break;
      case 'vote': app.Vote(a.yes); break;
      case 'mission': app.ExcuteMission(a.success); break;
      case 'lakeResult': app.LakeResult(a.good); break;
      case 'declineVerify': if (app.SkipSwap) app.SkipSwap(); else return 'gone'; break;
    }
    for (let i = 0; i < 50 && app.ux_disable; i++) await new Promise((r) => setTimeout(r, 100));
    return 'ok';
  })()`;
  return withTimeout(p.evaluate(js), 15000, a.kind) as Promise<string>;
}
async function hostInvoke(p: Page, method: string, ...args: unknown[]): Promise<void> {
  await withTimeout(p.evaluate(`window.connection.invoke(${[method, ...args].map((x) => JSON.stringify(x)).join(', ')})`), 10000, method)
    .catch((err: unknown) => log(`${method} 沒有回應（${err instanceof Error ? err.message : String(err)}），照房間狀態繼續`));
}
/** 聊天：房間頁的聊天框（app.Dialog），只在 can_chat 時。 */
async function chat(p: Page, text: string): Promise<boolean> {
  return withTimeout(p.evaluate(`(() => { const a = window.app; if (!a || !a.myself || !a.myself.can_chat || !a.Dialog) return false;
    a.Dialog(${JSON.stringify(text)}); return true; })()`), 10000, 'chat').catch(() => false) as Promise<boolean>;
}

/** 派票紀錄（房內「紀錄下載」的資料）：SyncGameStatistics → RecvGameStatistics。 */
const RECORD_HOOK_JS = `(() => { if (window.__recHook) return; window.__recHook = true; window.__recN = 0;
  window.connection.on('RecvGameStatistics', (s) => { window.__rec = s; window.__recN++; }); })()`;
async function fetchRecord(p: Page): Promise<PlatformRecord> {
  await p.evaluate(RECORD_HOOK_JS);
  const n0: number = await p.evaluate('window.__recN');
  await p.evaluate("window.connection.invoke('SyncGameStatistics', false)");
  await p.waitForFunction(`window.__recN > ${n0}`, undefined, { timeout: 8000 });
  return p.evaluate('JSON.parse(JSON.stringify(window.__rec))');
}

/** 離開房間：開局前（can_leave_free）按「離開」（連到大廳 /）；對局中只能關掉連線（回大廳頁）。 */
async function leaveRoom(p: Page, why: string, room: string): Promise<void> {
  log(`離開 ${room}：${why}`);
  saveState(null);
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' }).catch(() => undefined);
}

// ── 一個座位 ──────────────────────────────────────────────────────────────────────────
class Seat {
  constructor(readonly label: string) {}
  agent = new HeuristicAgent('signage-player');
  k!: Knowledge;
  lobbyRoles!: Role[];
  myLake: PrivateLakeResult[] = [];
  hist: { votes: VoteRecord[]; quests: QuestRecord[] } = { votes: [], quests: [] };
  plan: number[] | null = null;
  planKey = '';
  started = false;
  startedAt = 0;

  start(s: Snap): void {
    this.lobbyRoles = lobbyRolesLoose(s.game_roles, s.users.length);
    this.k = readKnowledge(s, this.lobbyRoles);
    this.myLake = []; this.hist = { votes: [], quests: [] }; this.plan = null; this.planKey = ''; this.started = true; this.startedAt = Date.now();
    this.agent.onGameStart(this.obs(s, 'team_select'));
    plog(`${this.label} 開局 坐 ${s.myself.set} 家 角色 ${s.myself.role} 夜晚 ${JSON.stringify(this.k.nightView)}${this.k.mismatch ? ` ⚠ ${this.k.mismatch}` : ''}`);
  }
  refresh(s: Snap): void {
    let k: Knowledge;
    try { k = readKnowledge(s, this.lobbyRoles); } catch { return; }
    if (JSON.stringify([k.knownEvils, k.knownWizards]) === JSON.stringify([this.k.knownEvils, this.k.knownWizards])) return;
    this.k = k;
    this.agent.onGameStart(this.obs(s, 'team_select'));
    plog(`${this.label} 夜晚資訊更新 ${JSON.stringify(k.nightView)}${k.mismatch ? ` ⚠ ${k.mismatch}` : ''}`);
  }
  obs(s: Snap, phase: Parameters<typeof buildObservation>[4], extra = {}): ReturnType<typeof buildObservation> {
    return buildObservation(this.k, s, this.hist, this.myLake, phase, this.lobbyRoles, extra);
  }
}

interface GameResult { status: 'ended' | 'stalled' | 'error' | 'left'; missions: string; winner: string; actions: Record<string, number> }

/**
 * 打一局：從開局（或已在局中）打到遊戲結束。每 0.8 秒看一次自己的畫面；輪到自己時等 1–3 秒（像真人）再做。
 */
async function playGame(p: Page, room: string): Promise<GameResult> {
  const seat = new Seat(room);
  const actions: Record<string, number> = {};
  const count = (k: string): void => { actions[k] = (actions[k] ?? 0) + 1; };
  let lastChange = Date.now();
  let lastKey = '';
  let lastFlags = '';
  let pendingSince = 0; let pendingKey = '';
  const done = new Map<string, number>(); // 決定的 key → 做完的時間
  let failures = 0;
  const t0 = Date.now();
  for (;;) {
    if (!inRoom(p) && !(await rejoin(p, room))) return { status: 'left', missions: '', winner: '', actions };
    let s: Snap | null = null;
    try { s = await snap(p); failures = 0; } catch { failures += 1; }
    if (!s) {
      if (failures > 40) return { status: 'error', missions: '', winner: '', actions };
      await sleep(1000); continue;
    }
    const key = JSON.stringify([s.status, s.missions, s.lake_result, s.users.map((u) => [u.crown, u.tick, u.vote_bag])]);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    if (PRIVATE_LOG) {
      const m = s.myself;
      const flags = `${s.status} tip=${m.action_tip} tick=${m.tick ?? ''} ${['can_dispatch_ticks', 'can_start_vote', 'can_vote', 'can_to_mission', 'can_lake_to', 'can_select_lake_result', 'can_assassin_to', 'can_verify'].filter((f) => (m as unknown as Record<string, boolean>)[f]).join(',')} free=${s.free_ticks} lake=${JSON.stringify(s.lake_result)} d=${pendingDecision(s) ?? '-'}`;
      if (flags !== lastFlags) { lastFlags = flags; plog(`${room} 畫面 ${flags}`); }
    }
    // 「開眼階段」（約 10 秒）身分標記可能還沒全到，過了才讀夜晚資訊
    if (s.gaming && s.status !== ENDED && s.status !== EYES && !seat.started) {
      try { seat.start(s); } catch (err) {
        log(`${room} 無法讀開局資訊（${err instanceof Error ? err.message : String(err)}），改用預設動作`);
        return { status: 'error', missions: '', winner: '', actions };
      }
    }
    if (seat.started && (s.status === ENDED || !s.gaming)) {
      const missions = s.missions.map((x) => (x ? 'o' : 'x')).join('');
      const logs: string[] = await p.evaluate('(window.app.logs || []).slice(0, 12).map((l) => String(l.msg || ""))').catch(() => []);
      const winner = logs.some((x) => /壞人獲勝/.test(x)) ? 'evil' : logs.some((x) => /好人獲勝/.test(x)) ? 'good' : '?';
      plog(`${room} 結束 任務 ${missions} 勝方 ${winner} 我方 ${seat.k.team}`);
      return { status: 'ended', missions, winner, actions };
    }
    if (Date.now() - lastChange > 15 * 60_000 || Date.now() - t0 > 90 * 60_000) return { status: 'stalled', missions: '', winner: '', actions };
    if (!seat.started) { await sleep(800); continue; }

    // 開局的第一張畫面有時身分標記還沒送到（2026-11-03 實測：梅林第一張看到 0 個紅）：開局 60 秒內、人數和規則
    // 對不上時重讀，夜晚資訊有變就重新開始 AI 的記憶（AI 每次決定都會從完整的公開紀錄重建）。
    if (seat.k.mismatch && Date.now() - seat.startedAt < 60_000) seat.refresh(s);
    if (seat.k.mismatch && Date.now() - seat.startedAt < 6000) { await sleep(500); continue; } // 先等標記到齊再做決定
    myLakeFromSnap(s, seat.myLake).forEach((m) => { if (!seat.myLake.some((x) => x.round === m.round)) { seat.myLake.push(m); plog(`${room} 湖結果 ${m.targetId} ${m.result}`); } });
    const d = pendingDecision(s);
    if (!d) { pendingKey = ''; await sleep(POLL_MS); continue; }
    const crown = s.users.find((u) => u.crown)?.set ?? 0;
    const dkey = `${d}|${s.missions.length}|${crown}|${s.lake_result.filter((l) => l.to !== null).length}`;
    if (dkey !== pendingKey) { pendingKey = dkey; pendingSince = Date.now(); }
    const doneAt = done.get(dkey);
    // 做過了但畫面還要求同一件事：8 秒後重送（可能被 ux_disable 擋掉或連線掉了）
    if (doneAt && Date.now() - doneAt < 8000 && d !== 'team') { await sleep(800); continue; }
    // 輪到自己卻 45 秒還沒做成：改用保守的預設動作（不讓整桌等）
    const fallback = Date.now() - pendingSince > 45_000;
    try {
      if (!doneAt && d !== 'team') {
        await sleep(actDelay());
        const again = await snap(p);
        if (!again || !decisionOpen(again, d)) continue;
        s = again;
      }
      const a = await decide(p, seat, s, d, dkey, fallback);
      if (a) {
        const r = await press(p, a);
        if (r === 'ok') { count(a.kind); if (d !== 'team') done.set(dkey, Date.now()); }
        if (d === 'team') await sleep(400);
      } else if (d === 'lakeDeclare' || d === 'verify') {
        done.set(dkey, Date.now());
      }
    } catch (err) {
      log(`${room} 動作失敗（${d}）：${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
      await sleep(1500);
    }
    await sleep(300);
  }
}

/** 依現在要做的決定問 AI，轉成一個練習台動作。fallback：AI 出錯或卡太久時的保守動作。 */
async function decide(p: Page, seat: Seat, s: Snap, d: Decision, dkey: string, fallback: boolean): Promise<SiteAction | null> {
  const sync = async (): Promise<void> => {
    try { seat.hist = historyFromRecord(await fetchRecord(p), s); } catch { /* 紀錄抓不到就用上一次的 */ }
  };
  const safe = <T>(f: () => T, dflt: T): T => { if (fallback) return dflt; try { return f(); } catch (err) { log(`AI 例外，用預設動作：${String(err).slice(0, 80)}`); return dflt; } };
  switch (d) {
    case 'team': {
      if (seat.planKey !== dkey || !seat.plan) {
        await sync();
        await sleep(actDelay());
        const need = s.free_ticks + s.users.filter((u) => u.tick).length;
        const dflt = [s.myself.set, ...s.users.map((u) => u.set).filter((x) => x !== s.myself.set)].slice(0, need);
        const a = safe(() => seat.agent.act(seat.obs(s, 'team_select')), { type: 'team_select' as const, teamIds: dflt.map(sid) });
        seat.plan = a.type === 'team_select' && a.teamIds.length === need ? a.teamIds.map(setOf) : dflt;
        seat.planKey = dkey;
        plog(`${seat.label} 派隊 ${seat.plan.join(',')}（第 ${s.missions.length + 1} 局，第 ${seat.hist.votes.filter((v) => v.round === s.missions.length + 1).length + 1} 次）`);
      }
      return nextTeamAction(s, seat.plan);
    }
    case 'vote': {
      await sync();
      const a = safe(() => seat.agent.act(seat.obs(s, 'team_vote')), { type: 'team_vote' as const, vote: true });
      const yes = a.type === 'team_vote' ? a.vote : true;
      plog(`${seat.label} 投票 ${s.users.filter((u) => u.tick).map((u) => u.set).join(',')} → ${yes ? '白' : '黑'}`);
      return { kind: 'vote', yes };
    }
    case 'mission': {
      await sync();
      const a = safe(() => seat.agent.act(seat.obs(s, 'quest_vote')), { type: 'quest_vote' as const, vote: 'success' as const });
      const ok = missionCard(seat.k.team, a.type === 'quest_vote' ? a.vote : undefined);
      plog(`${seat.label} 任務 → ${ok ? '成功' : '失敗'}`);
      return { kind: 'mission', success: ok };
    }
    case 'lakeTarget': {
      await sync();
      const valid = validLakeTargets(s);
      const target = safe(() => seat.agent.pickLakeTarget(seat.obs(s, 'team_select'), valid), valid[0]);
      plog(`${seat.label} 湖 → ${target}`);
      return { kind: 'touch', set: setOf(valid.includes(target) ? target : valid[0]) };
    }
    case 'lakeDeclare': {
      const i = pendingLakeDeclaration(s);
      if (i === null) return null;
      const seen = seat.myLake.find((x) => x.round === i + 2);
      if (!seen) return null;
      await sync();
      const claim = safe(() => seat.agent.declareLake(seat.obs(s, 'team_select'), seen.targetId, seen.result), seen.result);
      plog(`${seat.label} 湖宣告 ${seen.targetId} → ${claim ?? '不宣告'}`);
      return claim ? { kind: 'lakeResult', good: claim === 'good' } : null;
    }
    case 'assassinate': {
      await sync();
      const allEvilRoles = evilRolesAtAssassination(s, seat.k);
      const goods = s.users.map((u) => sid(u.set)).filter((id) => !(id in allEvilRoles));
      const a = safe(() => seat.agent.act(seat.obs(s, 'assassination', { allEvilIds: Object.keys(allEvilRoles), allEvilRoles })),
        { type: 'assassinate' as const, targetId: goods[0] });
      const target = a.type === 'assassinate' ? a.targetId : goods[0];
      plog(`${seat.label} 刺殺 → ${target}`);
      return { kind: 'touch', set: setOf(target) };
    }
    case 'verify':
      return { kind: 'declineVerify' };
  }
  return null;
}

// ── 房間裡：等開局、打、離開 ─────────────────────────────────────────────────────────────
/**
 * 已經坐進房間：等開局（檢查設定、人數、房主）、打 `games` 局。回傳打完的局數。
 * live 模式 `strictFull`：開局前有人離開（不再是 10 人）就離開。
 */
async function stayAndPlay(p: Page, room: string, games: number, strictFull: boolean, isHost: boolean, greet = true): Promise<number> {
  let played = 0;
  let greeted = false;
  while (played < games) {
    // 等開局
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < START_MIN * 60_000) {
      if (!inRoom(p)) { log(`${room}：已不在房間`); return played; }
      let s: Snap | null = null;
      try { s = await snap(p); } catch { s = null; }
      if (s) {
        if (s.gaming && s.status !== ENDED) { started = true; break; }
        if (!greeted && CHAT && greet && !isHost) { greeted = await chat(p, HELLO); if (greeted) log(`${room}：已在聊天室打招呼`); }
        // 私房多機器人（--password --bots N）：同房的其他百科機器人是自己人，不算違反「每間房最多 1 個」
        if (!isHost && s.myself.master) { await leaveRoom(p, '變成房主（不佔房主位）', room); return played; }
        if (strictFull && s.users.length < 10) { await leaveRoom(p, `有人離開（剩 ${s.users.length} 人）`, room); return played; }
        // 角色設定跟上人數時才檢查（房主調整中、人還沒到齊時不算）
        const why = s.game_roles?.length === s.users.length ? unsupportedReason(s, s.users.length) : null;
        if (why && !isHost) { await leaveRoom(p, `房間設定機器人打不了（${why}）`, room); return played; }
        if (isHost && s.users.length >= 10 && !s.gaming) { await sleep(2000); await hostInvoke(p, 'StartGame'); await sleep(3000); continue; }
        // 私房測試的房主：局末是「討論時間」（點任一頭像可立即停止討論），停止後才能再開局。
        // 只有自己當房主的私房測試會按；在別人的房間局末不碰任何東西。
        if (isHost && s.gaming && s.status === ENDED) { await sleep(3000); await press(p, { kind: 'touch', set: s.myself.set }); await sleep(3000); continue; }
      }
      await sleep(2000);
    }
    if (!started) { await leaveRoom(p, `${START_MIN} 分鐘沒有開局`, room); return played; }
    log(`${room}：開局（第 ${played + 1} 局）`);
    const r = await playGame(p, room);
    const acts = Object.entries(r.actions).map(([k, v]) => `${k}×${v}`).join(' ');
    log(`${room}：${r.status === 'ended' ? `打完，任務 ${r.missions}，${r.winner === 'good' ? '藍方勝' : r.winner === 'evil' ? '紅方勝' : '勝負不明'}` : r.status}（動作 ${acts || '無'}）`);
    if (r.status !== 'ended') { if (inRoom(p)) await leaveRoom(p, r.status === 'stalled' ? '對局卡住' : '機器人出錯', room); return played; }
    played += 1;
    countGame();
    if (PRIVATE_LOG) fs.appendFileSync(path.join(PRIVATE_LOG, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), room, ...r }) + '\n');
  }
  if (inRoom(p) && !isHost) await leaveRoom(p, `打完 ${played} 局`, room);
  return played;
}

/** 每個分頁坐進的房間（斷線重連用）。 */
const joined = new WeakMap<object, { room: string; password: string }>();
/** 這次執行（含掛掉重跑前）已打完的局數：也記在狀態檔，重跑後整晚上限照樣算。 */
let playedTotal = 0;
function saveState(room: string | null, password = ''): void {
  if (!STATE) return;
  try {
    fs.writeFileSync(STATE, JSON.stringify(room ? { room, password, nick: NICK, at: Date.now(), played: playedTotal } : { nick: NICK, played: playedTotal }));
  } catch { /* 狀態檔寫不了只少了重連 */ }
}
function countGame(): void { playedTotal += 1; saveState(null); }

/** 對局中被導回大廳（斷線、RoomNotExist）：回大廳再按一次加入，回到原座位。 */
async function rejoin(p: Page, label: string): Promise<boolean> {
  const j = joined.get(p);
  if (!j) return false;
  for (let i = 1; i <= 3; i++) {
    log(`${label}：不在房間裡，第 ${i} 次重新連回座位`);
    try {
      if (!/\/$/.test(new URL(p.url()).pathname) || inRoom(p)) await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      if (/\/Account\/Login/i.test(p.url())) await login(p, NICK);
      await p.waitForFunction('window.app && Array.isArray(window.app.rooms)', undefined, { timeout: 20000 });
      if (await joinRoom(p, j.room, j.password)) return true;
    } catch { /* 下一次 */ }
    await sleep(5000);
  }
  return false;
}

/** 從大廳用房間頁自己的加入表單進房（和按「加入房間」一樣）。 */
async function joinRoom(p: Page, room: string, password: string): Promise<boolean> {
  await p.evaluate(`(() => {
    document.getElementById('room_name').value = ${JSON.stringify(room)};
    document.getElementById('room_password').value = ${JSON.stringify(password)};
    document.getElementById('join_room').submit();
  })()`);
  // 表單送出後才開始換頁：等網址變成 /Room（房間滿了、密碼錯會留在大廳並跳提示）
  await p.waitForURL(/\/Room/i, { timeout: 20000 }).catch(() => undefined);
  if (!inRoom(p)) return false;
  await p.waitForFunction(READY_JS, undefined, { timeout: 30000 }).catch(() => undefined);
  const s = await snap(p).catch(() => null);
  const ok = Boolean(s && s.users.some((u) => u.id === s.myself.id));
  if (ok) { joined.set(p, { room, password }); saveState(room, password); }
  return ok;
}

// ── 模式 ─────────────────────────────────────────────────────────────────────────────
/** 依序登入 n 個機器人（各自獨立的瀏覽器環境：自己的登入、自己的連線、自己的視野）。 */
async function loginBots(browser: Browser, n: number): Promise<{ label: string; page: Page }[]> {
  const bots: { label: string; page: Page }[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await newPage(browser);
    await login(page, botNick(i, n));
    bots.push({ label: n > 1 ? `#${i}` : '', page });
  }
  return bots;
}

/**
 * 私房測試：第 1 個機器人開有密碼的私房，其他機器人用密碼加入，其餘座位用練習台內建機器人補滿，開湖，房主開局。
 */
async function privateTest(browser: Browser): Promise<void> {
  const bots = await loginBots(browser, BOTS);
  const host = bots[0].page;
  const desc = `${TEST_ROOM_PREFIX}（請勿加入）`;
  const password = `bk${Math.floor(Math.random() * 9000 + 1000)}`;
  await host.locator('input[placeholder^="房間描述"]').fill(desc);
  await host.locator('input[placeholder^="密碼"]').fill(password);
  await host.getByRole('button', { name: /建立房間/ }).click();
  await host.waitForLoadState('networkidle');
  await host.waitForFunction(READY_JS);
  const room = new URL(host.url()).searchParams.get('RoomName') ?? '';
  const name = ((await lobbyRooms(bots[1]?.page ?? host).catch(() => [] as LobbyRoom[])).find((r) => r.description_title === desc)?.name) ?? room;
  for (const b of bots.slice(1)) {
    if (!(await joinRoom(b.page, name, password))) log(`私房測試：${b.label} 沒有坐進去`);
  }
  for (let i = 0; i < 10 - BOTS; i++) { await hostInvoke(host, 'AddRobot'); await sleep(700); }
  await sleep(1500);
  const s = await snap(host);
  if (s && !s.enable_lake) { await hostInvoke(host, 'SetLake', true); await sleep(800); }
  log(`私房測試：${s?.users.length ?? 0} 人入座（百科機器人 ${BOTS} 個），打 ${MAX_GAMES} 局`);
  const results = await Promise.all(bots.map((b, i) => stayAndPlay(b.page, `private${b.label}`, MAX_GAMES, false, i === 0, false)));
  log(`私房測試結束：各座位打完 ${results.join('/')} 局`);
  for (const b of bots) await b.page.context().close().catch(() => undefined);
}

interface Watch { page: Page; ok: boolean }

/** 開觀眾席（雜魚視角）分頁看一間房的座位：只讀畫面資料，不按任何按鈕。 */
async function openWatch(browser: Browser, name: string): Promise<Page | null> {
  const page = await newPage(browser);
  try {
    await login(page, watchNick(name));
    await page.evaluate(`(() => { document.querySelector('#watch_room_name').value = ${JSON.stringify(name)};
      document.querySelector('#watch_room').submit(); })()`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(READY_JS, undefined, { timeout: 30000 });
    return page;
  } catch {
    await page.context().close().catch(() => undefined);
    return null;
  }
}

/** 每晚：找「人不夠」的野團補位。 */
async function live(browser: Browser, deadline: number, alreadyPlayed = 0): Promise<void> {
  const lobby = await newPage(browser);
  await login(lobby, NICK);
  const watches = new Map<string, Watch>();
  const seen = new Map<string, number>();
  const playedIn = new Map<string, number>(); // 房號 → 上次打完的時間
  let played = alreadyPlayed;
  log(`補位上線：整晚最多 ${MAX_GAMES} 局，房間要缺人 ≥ ${WAIT_MIN} 分鐘`);
  while (Date.now() < deadline && played < MAX_GAMES) {
    let rooms: LobbyRoom[] = [];
    try { rooms = await lobbyRooms(lobby); } catch {
      log('大廳讀取失敗，重新登入');
      await login(lobby, NICK).catch(() => undefined);
      await sleep(10000); continue;
    }
    const cands = rooms.filter((r) => lobbyCandidate(r) && (!ONLY_TITLE || (r.description_title ?? '').startsWith(ONLY_TITLE))).map((r) => r.name);
    // 觀眾席看座位（同一間房只開一個觀眾席分頁，不反覆進出）
    for (const [name, w] of [...watches]) {
      if (!cands.includes(name)) { await w.page.context().close().catch(() => undefined); watches.delete(name); }
    }
    for (const name of cands) {
      let w = watches.get(name);
      if (!w) {
        const page = await openWatch(browser, name);
        if (!page) continue;
        w = { page, ok: false }; watches.set(name, w);
      }
      const s = await snap(w.page).catch(() => null);
      w.ok = Boolean(s && inRoom(w.page) && seatsCandidate(s.users, s.gaming));
    }
    const ready = shortRooms(seen, cands.filter((n) => watches.get(n)?.ok), Date.now(), 0)
      .filter((n) => Date.now() - (seen.get(n) as number) >= (playedIn.has(n) ? REJOIN_MIN : WAIT_MIN) * 60_000);
    if (ready.length) {
      const name = ready[0];
      // 加入前最後確認：大廳還是 9 人、還沒開局
      const fresh = (await lobbyRooms(lobby).catch(() => [] as LobbyRoom[])).find((r) => r.name === name);
      if (fresh && lobbyCandidate(fresh)) {
        const w = watches.get(name);
        if (w) { await w.page.context().close().catch(() => undefined); watches.delete(name); }
        log(`${name}：9 個真人等了 ${((Date.now() - (seen.get(name) as number)) / 60000).toFixed(1)} 分鐘，加入`);
        seen.delete(name);
        if (await joinRoom(lobby, name, '')) {
          const n = await stayAndPlay(lobby, name, Math.min(1, MAX_GAMES - played), true, false);
          played += n;
          if (n) playedIn.set(name, Date.now());
          log(`今晚已打 ${played}/${MAX_GAMES} 局`);
        } else {
          log(`${name}：沒有坐進去（房間可能滿了），回大廳`);
        }
        if (inRoom(lobby)) await leaveRoom(lobby, '結束', name);
        await lobby.waitForFunction('window.app && Array.isArray(window.app.rooms)', undefined, { timeout: 30000 }).catch(() => login(lobby, NICK));
      }
    }
    await sleep(15000);
  }
  for (const w of watches.values()) await w.page.context().close().catch(() => undefined);
  log(`補位結束：今晚打了 ${played} 局`);
}

/** 房號比對：Room-1460、room-1460、1460 都算同一間。 */
export function sameRoom(a: string, b: string): boolean {
  const n = (x: string): string => x.trim().toLowerCase().replace(/^room-?/, '');
  return n(a) === n(b);
}

/**
 * 玩家指定房間：直接去那間房，有空位（人數 15 秒沒變＝沒有人正在進房）就坐，打完 --games 局離開。
 * --bots N：N 個獨立的機器人依序各坐一個空位（Edward 11/03「如果我希望自己跟9個機器人玩呢」）；
 * 每個機器人只用自己分頁看得到的資料，彼此不共用任何資訊。只有第 1 個在聊天室打招呼。
 */
async function roomMode(browser: Browser, deadline: number, alreadyPlayed = 0): Promise<void> {
  if (alreadyPlayed >= MAX_GAMES) { log('重連的那局已打完，結束'); return; }
  const bots = await loginBots(browser, BOTS);
  const lobby = bots[0].page;
  log(`指定房間 ${ROOM || '（依房間描述）'}：百科機器人 ${BOTS} 個，打 ${MAX_GAMES} 局`);
  let lastLen = -1; let stableSince = Date.now();
  while (Date.now() < deadline) {
    const rooms = await lobbyRooms(lobby).catch(() => [] as LobbyRoom[]);
    const r = rooms.find((x) => (ROOM ? sameRoom(x.name, ROOM) : Boolean(ROOM_TITLE) && (x.description_title ?? '').includes(ROOM_TITLE)));
    if (!r) { lastLen = -1; await sleep(15000); continue; }
    if (!r.is_publish_room && !PASSWORD) { log(`${r.name}：私房需要密碼（--password），不加入`); return; }
    const len = r.length ?? 0;
    if (len !== lastLen) { lastLen = len; stableSince = Date.now(); }
    if (r.gaming || len >= 10 || Date.now() - stableSince < 15000) { await sleep(5000); continue; }
    // 房裡已經有百科機器人（例如另一次指定、或每晚補位已經坐進去）就不加入
    const watch = await openWatch(browser, r.name);
    const seen = watch ? await snap(watch).catch(() => null) : null;
    if (watch) await watch.context().close().catch(() => undefined);
    // 依序坐下：每個機器人坐之前再看一次大廳，房間滿了或開局了就不再坐
    const seated: { label: string; page: Page }[] = [];
    for (const b of bots) {
      const now = (await lobbyRooms(b.page).catch(() => [] as LobbyRoom[])).find((x) => x.name === r.name);
      if (!now || now.gaming || (now.length ?? 10) >= 10) break;
      if (await joinRoom(b.page, r.name, r.is_publish_room ? '' : PASSWORD)) seated.push(b);
      else { log(`${r.name}${b.label}：沒有坐進去`); break; }
      await sleep(1500);
    }
    log(`${r.name}：坐進 ${seated.length}/${BOTS} 個百科機器人`);
    if (!seated.length) { await sleep(10000); continue; }
    const results = await Promise.all(seated.map((b, i) => stayAndPlay(b.page, `${r.name}${b.label}`, MAX_GAMES - alreadyPlayed, false, false, i === 0)));
    log(`指定房間結束：各座位打完 ${results.join('/')} 局`);
    for (const b of seated) if (inRoom(b.page)) await leaveRoom(b.page, '結束', r.name);
    return;
  }
  log('指定房間結束：時間到，沒有找到可以坐的房間');
}

/**
 * 上次中途斷線留下的房間（--state）：那間房還在打，就回去把那局打完（算一局）。
 * 回傳這次執行（含之前掛掉的那次）已打完的局數。
 */
async function resume(browser: Browser): Promise<number> {
  if (!STATE || !fs.existsSync(STATE)) return 0;
  let st: { room?: string; password?: string; nick?: string; at?: number; played?: number } = {};
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf-8')); } catch { /* 壞掉的狀態檔 */ }
  if (st.nick === NICK) playedTotal = Math.max(0, Number(st.played) || 0);
  saveState(null);
  if (!st.room || st.nick !== NICK || Date.now() - (st.at ?? 0) > 3 * 3600_000) return playedTotal;
  const p = await newPage(browser);
  try {
    await login(p, NICK);
    await p.waitForFunction('window.app && Array.isArray(window.app.rooms) && window.app.rooms.length > 0', undefined, { timeout: 15000 }).catch(() => undefined);
    const r = (await lobbyRooms(p).catch(() => [] as LobbyRoom[])).find((x) => x.name === st.room);
    if (!r || !r.gaming) { log(`${st.room}：上次的房間已經沒在打，不用重連`); return playedTotal; }
    log(`${st.room}：上次中途斷線，回去把那局打完`);
    if (!(await joinRoom(p, st.room, st.password ?? ''))) { log(`${st.room}：連不回座位`); saveState(null); return playedTotal; }
    const sn = await snap(p).catch(() => null);
    if (!sn || !sn.gaming || sn.status === ENDED) { await leaveRoom(p, '那局已經結束', st.room); return playedTotal; }
    const res = await playGame(p, st.room);
    log(`${st.room}：${res.status === 'ended' ? `打完，任務 ${res.missions}` : res.status}`);
    if (res.status === 'ended') countGame();
    await leaveRoom(p, '重連的那局結束', st.room);
    return playedTotal;
  } finally {
    await p.context().close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (MAX_GAMES <= 0) { log('局數 0，不打'); return; }
  const browser = await chromium.launch();
  const deadline = Date.now() + HOURS * 3600_000;
  try {
    if (MODE === 'private-test') await privateTest(browser);
    else {
      const resumed = await resume(browser);
      if (MODE === 'room') { if (!ROOM && !ROOM_TITLE) throw new Error('--room 沒有給房號（或 --title 房間描述）'); await roomMode(browser, deadline, resumed); }
      else await live(browser, deadline, resumed);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('signagePlayer')) {
  main().then(() => process.exit(0), (err) => { console.error(`錯誤：${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
}
