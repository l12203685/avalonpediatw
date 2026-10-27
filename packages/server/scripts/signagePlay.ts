/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 百科機器人上阿瓦隆練習台（avalon.signage-cloud.org）下棋 —— Edward 2026-10-27：
 *「之後我希望你直接在這個平台上進行模擬戰」「我會用 ED 你用百科機器人 A~I 來跟我玩一場」。
 *
 *   pnpm --filter @avalon/server exec tsx scripts/signagePlay.ts \
 *     [--bots 9] [--fill-robots 0] [--games 1] [--pace 1500] [--password XXXX] [--log DIR]
 *
 * 每個機器人一個獨立的瀏覽器分頁（自己的登入、自己的連線），走練習台本來的介面：
 *   - A 開私房（有密碼），其他機器人從大廳用同一組密碼加入；
 *   - 坐滿 10 人後 A（房主）開局；--fill-robots N 用練習台內建機器人補位（測試用）；
 *   - 每個機器人只讀「自己分頁」看得到的畫面資料，組成自己的 PlayerObservation，交給正式站同一個
 *     HeuristicAgent 決定派隊、投票、任務、湖、刺殺。機器人之間不共用任何狀態（同一支程式控制九個座位，
 *     但每個座位的判斷只用它自己的視野）。
 *
 * 練習台和我們的規則差異（照練習台）：
 *   - 第 5 次派隊是強制局：不投票直接出任務。紀錄裡記成全員贊成的第 5 次提議。
 *   - 湖的宣告只有好／壞（沒有「不宣告」的按鈕）；機器人決定不宣告時就不按。
 *   - 機器人不會打字聊天。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import type { LakePublicRecord, PlayerObservation, PrivateLakeResult, QuestRecord, VoteRecord } from '../src/ai/types';
import type { Role } from '@avalon/shared';

const require = createRequire(import.meta.url);
// Playwright 裝在容器全域，不是 repo 的相依套件，所以沒有型別；只用到 launch / newContext / page 幾個方法。
/* eslint-disable @typescript-eslint/no-explicit-any */
const { chromium } = require('playwright') as { chromium: { launch(): Promise<any> } };
type Page = any;
type Browser = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const BASE = 'https://avalon.signage-cloud.org';
const LETTERS = 'ABCDEFGHI';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const N_BOTS = Number(arg('bots', '9'));
const FILL_ROBOTS = Number(arg('fill-robots', '0'));
const GAMES = Number(arg('games', '1'));
const PACE = Number(arg('pace', '1500'));
const PASSWORD = arg('password', `bk${Math.floor(Math.random() * 9000 + 1000)}`);
const LOG_DIR = arg('log', '.');
const DESC = arg('desc', '百科機器人模擬戰');
/** --debug PATH：每次決定前把那個座位的觀測寫進 PATH（本機除錯用）。 */
const DEBUG_FILE = arg('debug', '');

// ── 練習台畫面資料（Vue app 的欄位，見房間頁的 TransformUsers / TransformMySelf）─────────────
interface SUser {
  id: string; name: string; master: boolean; role: string; set: number; crown: boolean; tick: boolean;
  vote_bag: boolean | null; lake: number | null; is_robot: boolean; dead: boolean;
}
interface SMyself {
  id: string; name: string; master: boolean; role: string; is_good: boolean; set: number; vote_bag: boolean | null;
  can_dispatch_ticks: boolean; can_to_mission: boolean; can_vote: boolean; can_start_vote: boolean;
  can_lake_to: boolean; can_select_lake_result: boolean; can_assassin_to: boolean; can_verify: boolean;
  action_tip: string;
}
interface SLake { from: number; to: number | null; result: boolean | null }
interface Snap {
  gaming: boolean; status: string; myself: SMyself; users: SUser[]; free_ticks: number;
  missions: boolean[]; mission_result: boolean[]; lake_result: SLake[];
}

// 送進瀏覽器的程式一律用字串：tsx 會在函式裡插入 __name 輔助函式，瀏覽器端沒有它。
const SNAP_JS = `(() => {
  const a = window.app;
  if (!a || !a.data_ready) return null;
  const j = (v) => JSON.parse(JSON.stringify(v ?? null));
  return { gaming: a.gaming, status: a.game_status, myself: j(a.myself), users: j(a.users), free_ticks: a.free_ticks,
    missions: j(a.missions) ?? [], mission_result: j(a.mission_result) ?? [], lake_result: j(a.lake_result) ?? [] };
})()`;
async function snap(p: Page): Promise<Snap | null> {
  return p.evaluate(SNAP_JS);
}
const invoke = (p: Page, method: string, ...args: unknown[]) =>
  p.evaluate(`window.connection.invoke(${[method, ...args].map((x) => JSON.stringify(x)).join(', ')})`);
const READY_JS = 'window.app && window.app.data_ready === true';

interface PlatformRecord {
  [round: string]: { meetings?: { ticks_set: number[]; white_ball_set: number[]; captain_set: number }[];
    mission_history?: { member: number[]; result: boolean[] } | null } | undefined;
}
const RECORD_HOOK_JS = `(() => { if (window.__recHook) return; window.__recHook = true; window.__recN = 0;
  window.connection.on('RecvGameStatistics', (s) => { window.__rec = s; window.__recN++; }); })()`;
async function fetchRecord(p: Page): Promise<PlatformRecord> {
  await p.evaluate(RECORD_HOOK_JS);
  const n0: number = await p.evaluate('window.__recN');
  await p.evaluate("window.connection.invoke('SyncGameStatistics', false)");
  await p.waitForFunction(`window.__recN > ${n0}`, undefined, { timeout: 8000 });
  return p.evaluate('JSON.parse(JSON.stringify(window.__rec))');
}

// ── 角色字串 ────────────────────────────────────────────────────────────────────────────
const ROLE_OF: Record<string, Role> = {
  梅林: 'merlin', 派西維爾: 'percival', 刺客: 'assassin', 莫甘娜: 'morgana', 莫德雷德: 'mordred', 奧伯倫: 'oberon',
};
function roleOf(name: string): Role {
  if (ROLE_OF[name]) return ROLE_OF[name];
  if (/^雜魚/.test(name)) return 'loyal';
  if (/^爪牙/.test(name)) return 'minion' as Role;
  throw new Error(`unknown role ${name}`);
}
const sid = (set: number) => `S${set}`;
const ALL_IDS = Array.from({ length: 10 }, (_, i) => sid(i + 1));

/**
 * 一個座位的追蹤器：只從這個座位自己的畫面更新。
 */
class SeatTracker {
  role!: Role; team!: 'good' | 'evil'; me!: string;
  knownEvils: string[] = []; knownWizards: string[] | undefined;
  nightView: Record<string, string> = {};
  votes: VoteRecord[] = []; quests: QuestRecord[] = [];
  lakeHolders: number[] = []; myLake: PrivateLakeResult[] = [];
  declaredLakes = new Set<number>();
  plan: string[] | null = null; planKey = '';
  agent: HeuristicAgent;

  constructor(readonly label: string) { this.agent = new HeuristicAgent(label); }

  start(s: Snap): void {
    this.me = sid(s.myself.set);
    this.role = roleOf(s.myself.role);
    this.team = s.myself.is_good ? 'good' : 'evil';
    this.nightView = Object.fromEntries(s.users.filter((u) => u.set !== s.myself.set && u.role !== 'unknown').map((u) => [sid(u.set), u.role]));
    const seen = Object.keys(this.nightView);
    if (this.role === 'percival') { this.knownWizards = seen; this.knownEvils = []; }
    else if (this.role === 'merlin' || this.team === 'evil') this.knownEvils = seen;
    this.votes = []; this.quests = []; this.lakeHolders = []; this.myLake = []; this.declaredLakes.clear();
    this.plan = null;
    this.agent.onGameStart(this.obs(s, 'team_select'));
  }

  round(s: Snap): number { return Math.min(5, s.missions.length + 1); }

  /**
   * 派隊、黑白球、任務：讀練習台的「派票紀錄」（每個玩家都能打開的公開紀錄，從自己的分頁要）。
   * 畫面輪詢會漏掉很快的階段（內建機器人一秒內就派完、出任務時兵牌逐一收掉），所以不從畫面拼。
   */
  applyRecord(rec: PlatformRecord, s: Snap): void {
    this.votes = []; this.quests = [];
    for (let r = 1; r <= 5; r++) {
      const round = rec[`round_${r}`];
      if (!round) continue;
      const meetings = round.meetings ?? [];
      meetings.forEach((m, i) => {
        const inProgress = i === meetings.length - 1 && r === s.missions.length + 1 && m.white_ball_set.length === 0 && s.status === '投票';
        if (inProgress) return;
        const yes = new Set(m.white_ball_set);
        this.votes.push({
          round: r, attempt: i + 1, leader: sid(m.captain_set), team: m.ticks_set.map(sid),
          approved: yes.size * 2 > 10, votes: Object.fromEntries(ALL_IDS.map((id) => [id, yes.has(Number(id.slice(1)))])),
        });
      });
      const mh = round.mission_history;
      if (mh && s.missions.length >= r) {
        this.quests.push({ round: r, team: mh.member.map(sid), result: s.missions[r - 1] ? 'success' : 'fail',
          failCount: mh.result.filter((x) => x === false).length });
      }
    }
  }

  /** 湖（畫面上的湖紀錄一直都在，不會漏）。 */
  update(s: Snap): void {
    // 湖：自己湖到的人，在自己的畫面上會翻成 good / bad。
    for (const l of s.lake_result) {
      if (l.from === s.myself.set && l.to !== null) {
        const u = s.users.find((x) => x.set === l.to);
        const r = u && /^(good|bad)$/.test(u.role) ? (u.role === 'good' ? 'good' : 'evil') : null;
        const lakeRound = 2 + s.lake_result.indexOf(l);
        if (r && !this.myLake.some((m) => m.round === lakeRound)) this.myLake.push({ round: lakeRound, targetId: sid(l.to), result: r });
      }
    }
  }

  lakeHistory(s: Snap): LakePublicRecord[] {
    return s.lake_result.filter((l) => l.to !== null && l.result !== null)
      .map((l, i) => ({ round: 2 + i, holderId: sid(l.from), targetId: sid(l.to as number), declaredClaim: l.result ? 'good' : 'evil' }));
  }

  obs(s: Snap, phase: PlayerObservation['gamePhase'], extra: Partial<PlayerObservation> = {}): PlayerObservation {
    const round = this.round(s);
    const failCount = this.votes.filter((v) => v.round === round && !v.approved).length;
    const leaderU = s.users.find((u) => u.crown);
    return {
      myPlayerId: this.me, myRole: this.role, myTeam: this.team, playerCount: 10, allPlayerIds: ALL_IDS,
      knownEvils: this.knownEvils, knownWizards: this.knownWizards,
      currentRound: round, currentLeader: leaderU ? sid(leaderU.set) : this.me, failCount,
      questResults: this.quests.map((q) => q.result), gamePhase: phase,
      voteHistory: this.votes, questHistory: this.quests,
      proposedTeam: s.users.filter((u) => u.tick).map((u) => sid(u.set)),
      lakeHistory: this.lakeHistory(s), myLakeResults: this.myLake, evilCount: 4,
      lobbyRoles: ['merlin', 'percival', 'loyal', 'loyal', 'loyal', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'],
      ...extra,
    };
  }
}

// ── 機器人 ─────────────────────────────────────────────────────────────────────────────
interface Bot { label: string; name: string; page: Page; seat: SeatTracker; busyUntil: number }

async function login(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/Account/Login`, { waitUntil: 'networkidle' });
  const f = p.locator('form[action="/Account/Submit"]');
  await f.locator('input[name=NickName]').fill(name);
  await f.locator('button[type=submit]').click();
  await p.waitForLoadState('networkidle');
  return p;
}

async function act(bot: Bot, s: Snap, log: (m: string) => void): Promise<void> {
  const t = bot.seat; const m = s.myself;
  if (Date.now() < bot.busyUntil) return;
  const later = (ms = PACE) => { bot.busyUntil = Date.now() + ms; };
  const sync = async () => {
    t.applyRecord(await fetchRecord(bot.page), s);
    if (DEBUG_FILE) fs.appendFileSync(DEBUG_FILE, JSON.stringify({ seat: bot.label, status: s.status, obs: t.obs(s, 'team_select') }) + '\n');
  };

  if (m.can_dispatch_ticks) {
    const key = `${s.missions.length}|${s.users.find((u) => u.crown)?.set}`;
    if (t.planKey !== key) {
      await sync();
      const a = t.agent.act(t.obs(s, 'team_select'));
      t.plan = a.type === 'team_select' ? a.teamIds : null; t.planKey = key;
      log(`${bot.label} 派隊 ${t.plan?.map((x) => x.slice(1)).join(',')}`);
      later(PACE * 2); return;
    }
    const want = new Set(t.plan ?? []);
    const wrong = s.users.find((u) => u.tick && !want.has(sid(u.set)));
    const miss = s.users.find((u) => !u.tick && want.has(sid(u.set)));
    if (wrong) { await invoke(bot.page, 'Touch', wrong.set); later(400); return; }
    if (miss && s.free_ticks > 0) { await invoke(bot.page, 'Touch', miss.set); later(700); return; }
    if (m.can_start_vote && s.free_ticks === 0) { await invoke(bot.page, 'StartVote'); later(); }
    return;
  }
  if (m.can_vote && m.vote_bag === null) {
    await sync();
    const a = t.agent.act(t.obs(s, 'team_vote'));
    const yes = a.type === 'team_vote' ? a.vote : true;
    await invoke(bot.page, 'Vote', yes); later(); return;
  }
  if (m.can_to_mission) {
    await sync();
    const a = t.agent.act(t.obs(s, 'quest_vote'));
    const ok = t.team === 'good' || (a.type === 'quest_vote' ? a.vote === 'success' : true);
    await invoke(bot.page, 'ExcuteMission', ok); later(); return;
  }
  if (m.can_lake_to) {
    const used = new Set(s.lake_result.map((l) => l.from));
    const valid = ALL_IDS.filter((id) => id !== t.me && !used.has(Number(id.slice(1))));
    await sync();
    const target = t.agent.pickLakeTarget(t.obs(s, 'team_select'), valid);
    log(`${bot.label} 湖 ${target.slice(1)}`);
    await invoke(bot.page, 'Touch', Number(target.slice(1))); later(PACE * 2); return;
  }
  if (m.can_select_lake_result) {
    const mine = s.lake_result.findIndex((l) => l.from === m.set && l.to !== null && l.result === null);
    if (mine >= 0 && !t.declaredLakes.has(mine)) {
      const l = s.lake_result[mine];
      const seen = t.myLake.find((x) => x.targetId === sid(l.to as number));
      if (!seen) return; // 還沒看到結果
      t.declaredLakes.add(mine);
      await sync();
      const claim = t.agent.declareLake(t.obs(s, 'team_select'), seen.targetId, seen.result);
      log(`${bot.label} 湖宣告 ${claim ?? '不宣告'}`);
      if (claim) await invoke(bot.page, 'LakeResult', claim === 'good');
      later(); return;
    }
  }
  if (m.can_assassin_to) {
    // 刺殺階段紅方開牌：刺客畫面上看得到所有紅方的角色。
    const reds = s.users.filter((u) => u.set !== m.set && u.role !== 'unknown' && !/^雜魚|^梅林|^派西|^good$/.test(u.role));
    const allEvilRoles: Record<string, Role> = { [t.me]: t.role };
    for (const u of reds) { try { allEvilRoles[sid(u.set)] = roleOf(u.role); } catch { allEvilRoles[sid(u.set)] = 'minion' as Role; } }
    await sync();
    const a = t.agent.act(t.obs(s, 'assassination', { allEvilIds: Object.keys(allEvilRoles), allEvilRoles }));
    if (a.type === 'assassinate') { log(`${bot.label} 刺殺 ${a.targetId.slice(1)}`); await invoke(bot.page, 'Touch', Number(a.targetId.slice(1))); }
    later(PACE * 3);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOG_DIR, `signage_${stamp}.log`);
  const log = (msg: string) => { const line = `${new Date().toISOString().slice(11, 19)} ${msg}`; console.log(line); fs.appendFileSync(logFile, line + '\n'); };

  const bots: Bot[] = [];
  for (let i = 0; i < N_BOTS; i++) {
    const label = LETTERS[i]; const name = `百科機器人${label}`;
    bots.push({ label, name, page: await login(browser, name), seat: new SeatTracker(label), busyUntil: 0 });
  }
  // A 開房
  const host = bots[0].page;
  await host.locator('input[placeholder^="房間描述"]').fill(DESC);
  await host.locator('input[placeholder^="密碼"]').fill(PASSWORD);
  await host.getByRole('button', { name: /建立房間/ }).click();
  await host.waitForLoadState('networkidle');
  await host.waitForFunction(READY_JS);
  // 其他人從大廳找房間加入
  for (const b of bots.slice(1)) {
    const room = `(window.app.rooms || []).find((r) => r.description_title === ${JSON.stringify(DESC)})`;
    await b.page.waitForFunction(`!!${room}`, undefined, { timeout: 30000 });
    await b.page.evaluate(`(() => {
      const room = ${room};
      document.getElementById('room_name').value = room.name;
      document.getElementById('room_password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('join_room').submit();
    })()`);
    await b.page.waitForLoadState('networkidle');
    await b.page.waitForFunction(READY_JS);
  }
  for (let i = 0; i < FILL_ROBOTS; i++) { await invoke(host, 'AddRobot'); await sleep(600); }
  log(`房間「${DESC}」密碼 ${PASSWORD}；機器人 ${bots.map((b) => b.label).join('')} 已入座`);

  for (let g = 1; g <= GAMES; g++) {
    // 等坐滿 10 人再開局
    for (;;) {
      const s = await snap(host);
      if (s && s.users.length >= 10 && !s.gaming) break;
      await sleep(2000);
    }
    log(`第 ${g} 局：10 人到齊，10 秒後開局`);
    await sleep(10000);
    await invoke(host, 'StartGame');
    await sleep(2500);
    const started = new Set<string>();
    let ended = false;
    let lastStatus = '';
    while (!ended) {
      for (const b of bots) {
        const s = await snap(b.page);
        if (!s) continue;
        if (s.gaming && !started.has(b.label)) {
          b.seat.start(s); started.add(b.label);
          log(`${b.label} 坐 ${s.myself.set} 家（角色只記在本機紀錄）`);
          fs.appendFileSync(logFile, `  [private] ${b.label} ${s.myself.role} night=${JSON.stringify(b.seat.nightView)}\n`);
        }
        if (!started.has(b.label)) continue;
        b.seat.update(s);
        if (b === bots[0] && s.status !== lastStatus) {
          log(`狀態：${s.status}（任務 ${s.missions.map((x) => (x ? '藍' : '紅')).join('')}）`); lastStatus = s.status;
          if (s.status === '遊戲結束') {
            // 對帳用：練習台自己的派票紀錄，和每個座位自己拼出來的紀錄（只寫本機紀錄檔）。
            await invoke(host, 'SyncGameStatistics', false); await sleep(1000);
            fs.appendFileSync(logFile, `  [private] platform ${JSON.stringify(await host.evaluate('window.app.game_statistics'))}\n`);
            for (const x of bots) {
              const xs = await snap(x.page);
              if (xs) x.seat.applyRecord(await fetchRecord(x.page), xs);
            }
            for (const x of bots) fs.appendFileSync(logFile, `  [private] seat ${x.label} ${JSON.stringify({ votes: x.seat.votes, quests: x.seat.quests, lake: x.seat.myLake })}\n`);
          }
        }
        if (s.gaming) {
          try { await act(b, s, log); } catch (e) { log(`${b.label} 動作失敗：${String(e).slice(0, 200)}`); b.busyUntil = Date.now() + 2000; }
        } else if (started.size > 0 && b === bots[0]) {
          ended = true;
          const end: string[] = await host.evaluate('window.app.logs.slice(0, 8).map((l) => l.msg)');
          log(`第 ${g} 局結束：${end.join(' / ')}`);
        }
      }
      await sleep(300);
    }
  }
  log('全部結束');
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
