#!/usr/bin/env node
/**
 * 部署閘門：合併一個會讓正式機重啟的 PR（改到 packages/server/**、packages/shared/** 等，見 render.yaml buildFilter）
 * 之前先跑這支。站長 2026-11-26：「你未來可以先確定沒有影響進行中的局或任務再合併嗎」。
 *
 *   node scripts/deployGate.mjs                 問一次：安全 → exit 0；不安全、問不到 → exit 1
 *   node scripts/deployGate.mjs --wait 30       不安全就每分鐘再問一次，最多等 30 分鐘
 *   node scripts/deployGate.mjs --allow lobby_with_humans,rooms_in_game_humans_away
 *                                               這些代碼當成不擋（例：確定那幾間斷線的房間不會回來）
 *   DEPLOY_GATE_URL=http://localhost:3001 node scripts/deployGate.mjs   問別台
 *
 * 讀 /api/bots/status → live（packages/server/src/services/deploySafety.ts）。只印數字和代碼。
 * 沒有任何相依套件，Node 18 以上就能跑。說明：docs/BOTS.md〈合併前先跑部署閘門〉、docs/RENDER_FREE_DEPLOY.md。
 */

const DEFAULT_URL = 'https://avalon-server-z6c0-cs0s.onrender.com';
const REQUEST_TIMEOUT_MS = 90_000; // 免費方案冷啟動要 30~60 秒
const POLL_MS = 60_000;

/** 代碼 → 一句白話。 */
export const REASON_TEXT = {
  rooms_in_game_with_humans: '有真人的對局正在進行',
  rooms_in_game_humans_away: '有對局進行中，真人暫時斷線（可能會回來）',
  practice_in_game: '有人在跟機器人練習',
  red_talk_waits: '刺殺階段，機器人刺客在等紅方真人下指令',
  sim_sessions_unsaved: '模擬瓦有進行中的題目，而且沒有存檔',
  feedback_unsaved: '遊戲內回饋還沒寫進試算表',
  practice_exploit_pending: '練習局的回答還沒寫進試算表',
  live_counts_unavailable: '伺服器沒有回報房間數（不知道 = 不安全）',
  lobby_with_humans: '大廳有人在等開局（不擋：重啟後重新開房就好）',
  line_reply_queue: 'LINE 有待送的同步訊息（不擋）',
  sim_sessions_saved: '模擬瓦有進行中的題目，有存檔、重啟後讀得回來（不擋）',
  bot_only_rooms: '只有機器人的房間（不擋）',
};

export function parseArgs(argv) {
  const out = { waitMinutes: 0, allow: new Set(), url: (process.env.DEPLOY_GATE_URL || DEFAULT_URL).replace(/\/+$/, '') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--wait') out.waitMinutes = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--allow') for (const c of String(argv[++i] || '').split(',')) { if (c.trim()) out.allow.add(c.trim()); }
    else if (a === '--url') out.url = String(argv[++i] || out.url).replace(/\/+$/, '');
  }
  return out;
}

/** status JSON → { safe, blocking, minor, numbers }。`live` 不在（舊版伺服器）→ 不安全。 */
export function decide(status, allow = new Set()) {
  const live = status && typeof status === 'object' ? status.live : null;
  if (!live || typeof live !== 'object' || typeof live.safeToDeploy !== 'boolean') {
    return { safe: false, blocking: ['live_missing'], minor: [], numbers: {} };
  }
  const reasons = Array.isArray(live.reasons) ? live.reasons.map(String) : [];
  const serverBlocking = new Set(Array.isArray(live.blocking) ? live.blocking.map(String) : live.safeToDeploy ? [] : reasons);
  const blocking = reasons.filter((r) => serverBlocking.has(r) && !allow.has(r));
  for (const r of serverBlocking) if (!reasons.includes(r) && !allow.has(r)) blocking.push(r);
  const minor = reasons.filter((r) => !blocking.includes(r));
  const numbers = Object.fromEntries(Object.entries(live).filter(([, v]) => typeof v === 'number'));
  return { safe: blocking.length === 0, blocking, minor, numbers };
}

async function fetchStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/bots/status`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function report(d) {
  const nums = Object.entries(d.numbers).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(d.safe ? '✅ 可以部署：重啟不會讓任何真人丟掉東西' : '⛔ 先不要部署：');
  for (const r of d.blocking) console.log(`  ✗ ${r}：${REASON_TEXT[r] ?? (r === 'live_missing' ? '伺服器沒有 live 這一段（還是舊版？）' : r)}`);
  for (const r of d.minor) console.log(`  · ${r}：${REASON_TEXT[r] ?? r}`);
  if (nums) console.log(`  數字：${nums}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + args.waitMinutes * 60_000;
  for (;;) {
    let d;
    try {
      d = decide(await fetchStatus(args.url), args.allow);
    } catch (err) {
      d = { safe: false, blocking: ['unreachable'], minor: [], numbers: {} };
      console.log(`⛔ 問不到伺服器（${err instanceof Error ? err.name : 'error'}）`);
    }
    if (d.blocking[0] !== 'unreachable') report(d);
    if (d.safe) return 0;
    if (Date.now() + POLL_MS > deadline) return 1;
    console.log('  一分鐘後再問一次…');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('deployGate.mjs');
if (isMain) {
  main().then((code) => process.exit(code), () => process.exit(1));
}
