/**
 * 記錄員存的局（scripts/signageRecorder.ts 的 JSON）→ 百科〈遊戲紀錄〉（wiki-65）牌譜寫法，並可貼到 Discord。
 *
 *   tsx scripts/signagePaipu.ts <局.json> [...]            印出牌譜
 *   tsx scripts/signagePaipu.ts --post <局.json> [...]     貼到 DC 牌譜頻道（DISCORD_BOT_TOKEN，或 DISCORD_PAIPU_WEBHOOK_URL）
 *
 * Edward 2026-10-30：「貼在 DC 的牌譜頻道，要附座位暱稱」。Webhook 網址是密鑰，只從環境變數讀，不寫進 repo。
 * 牌譜格式（照 DC 牌譜頻道過去的文章）：一行一次提議（隊伍座位；`-` 內黑、`+` 外白；強制局不投票、不標記號）、
 * 任務牌 o／x、湖中 `x>y o`（練習台沒記到宣告時寫 `?`，要人工補）、「刺客刺殺:X」（三紅寫 x）、六碼＝刺娜德奧派梅的座位、
 * 依座位「1.暱稱」每人一行。座位 10 寫成 0。
 *
 * Edward 2026-11-03：「都先貼到 DC 並且備註『機器人紀錄員尚待檢視』……我會把錯的或是沒意義的刪掉」「順便貼『視覺化牌譜』的圖 &
 * 『開牌後配置』的圖」。所以每一局都貼（buildPaipuPost）：通過檢查（postSkipReason）的照原本的標題與標籤；沒通過的標題加
 * 「【待檢視】」、不掛結果標籤，內文寫原因。每篇最後一行都是 REVIEW_NOTE。圖由記錄員截好傳給 postPaipu。
 *
 * Edward 2026-11-03：「有百科AI的另外算 我們不會用伺服器內建的強化機器人」。有練習台內建機器人（is_robot）的局完全不貼
 * （noPostReason）；有百科AI 的局照樣【待檢視】＋「模擬」標籤，檢視後匯入成分類「百科AI」，戰績另外算。
 */
import fs from 'node:fs';
import path from 'node:path';

interface Meeting { ticks_set: number[]; white_ball_set: number[]; captain_set: number }
interface Mission { result: boolean[]; member: number[]; crown_set: number }
interface Lake { from: number; to: number | null; result: boolean | null }
interface User { set: number; name: string; role: string }
interface Snapshot { users: User[]; meetings: Meeting[]; missionHistorys: Mission[]; lake: Lake[] | null; logs?: { msg?: string }[] }
export interface RecordedGame {
  room: string; title?: string; startedAt?: string; endedAt?: string; end?: Snapshot | null; incomplete?: boolean;
  /** 記錄員存的快照（局末快照沒抓到時，用最後一張的座位認內建機器人）。 */
  timeline?: { s?: { users?: unknown } | null }[];
}

/** 每篇貼文的最後一行（Edward 11/03）。全形括號開頭：每日匯入當一般文字略過，不影響讀牌譜。 */
export const REVIEW_NOTE = '（機器人紀錄員尚待檢視）';
/**
 * 沒通過檢查的局，討論串標題的開頭。每日匯入（discord_records_import.py）看到標題有「待檢視」就整篇略過、不回覆；
 * 人工檢視後把標題的「【待檢視】」拿掉（或改成正式標題、掛結果標籤），下次匯入才會收錄（有百科AI 的局收成分類「百科AI」）。
 */
export const UNVERIFIED_PREFIX = '【待檢視】';

/**
 * 百科補位機器人的暱稱（scripts/signagePlayer.ts；Edward 2026-11-03「人不夠就加進去玩」）。它是一般帳號（不是練習台內建機器人，
 * is_robot 是 false），所以記錄員靠暱稱認：有它的局一律待檢視，內文寫它坐哪一家；檢視後匯入成分類「百科AI」（另外算、不進戰績）。
 * 以「百科機器人」開頭的暱稱都算（scripts/signagePlay.ts 的模擬戰用 百科機器人A～I）。
 */
export const BOT_NICK = '百科AI_0';
/** Edward 2026-11-03：暱稱改「百科AI_{#}」（例 百科AI_1），戰績上全部當同一個人「百科AI」；舊的「百科機器人…」照樣認。 */
const BOT_NICK_RE = /^百科(機器人|AI)/i;
/** 這個暱稱是百科機器人（補位或模擬戰）。 */
export const isPediaBotName = (name: string): boolean => BOT_NICK_RE.test(name.trim());
/** 百科機器人私房測試的房間描述開頭（signagePlayer --mode private-test）：記錄員不旁觀這種房間。 */
export const TEST_ROOM_PREFIX = '百科機器人測試';
/** 有百科機器人的局另外掛的論壇標籤：每日匯入把有這個標籤的局收成分類「百科AI」（另外算，不進戰績、排行、機器人訓練）。 */
export const BOT_GAME_TAG = '模擬';

/** 百科機器人坐的座位（沒有時空陣列）。 */
export function botSeats(game: RecordedGame): number[] {
  return (game.end?.users ?? []).filter((u) => u && BOT_NICK_RE.test(String(u.name ?? ''))).map((u) => u.set).sort((a, b) => a - b);
}

const ROLE_ORDER = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'];
const d = (seat: number): string => (seat === 10 ? '0' : String(seat));
const digits = (seats: Iterable<number>): string => [...seats].sort((a, b) => (a === 10 ? 10 : a) - (b === 10 ? 10 : b)).map(d).join('');

/** 六碼配置：刺娜德奧派梅的座位（座位 10 寫成 0）。 */
export function paipuConfig(game: RecordedGame): string {
  const users = (game.end?.users ?? []).filter(Boolean);
  return ROLE_ORDER.map((name) => { const u = users.find((x) => x.role === name); return u ? d(u.set) : '?'; }).join('');
}

/** 六碼配置齊全（6 個不同的座位，沒有 ?）。 */
export function hasValidConfig(game: RecordedGame): boolean {
  const c = paipuConfig(game);
  return /^[0-9]{6}$/.test(c) && new Set(c).size === 6;
}

/** 一局 → 牌譜文字（Discord 訊息；未完成的局回傳 null）。 */
export function gameToPaipu(game: RecordedGame): string | null {
  if (!game.end || game.incomplete) return null;
  return paipuText(game.end, game);
}

/**
 * 盡量轉出牌譜（待檢視的局用）：資料缺東缺西也不丟錯，轉不出來時回傳空字串。
 * 中途加入、有機器人、沒打完的局一樣照現有的資料轉。
 */
export function gameToPaipuLoose(game: RecordedGame): string {
  try {
    return game.end ? paipuText(game.end, game) : '';
  } catch {
    return '';
  }
}

function paipuText(end: Snapshot, game: RecordedGame): string {
  const users = (end.users ?? []).filter((u) => u && typeof u.set === 'number').sort((a, b) => a.set - b.set);
  const lakes = (end.lake ?? []).filter((l) => l && typeof l.from === 'number' && typeof l.to === 'number');
  const missions = (end.missionHistorys ?? []).filter(Boolean);
  const lines: string[] = [];
  let mi = 0;
  let attempt = 0;
  for (const m of (end.meetings ?? []).filter(Boolean)) {
    const team = new Set(m.ticks_set ?? []);
    const whites = new Set(m.white_ball_set ?? []);
    attempt += 1;
    // 第 5 次提議才是尾家強制局；10 人全白（全場贊成）是正常的投票結果，要照常標外白
    const forced = attempt === 5;
    let line = digits(team);
    if (!forced) {
      const blackIn = [...team].filter((s) => !whites.has(s));
      const whiteOut = [...whites].filter((s) => !team.has(s));
      // 內黑在前、外白在後（DC 牌譜頻道過去多數文章的寫法，例：2579 7- 1+）
      if (blackIn.length) line += ` ${digits(blackIn)}-`;
      if (whiteOut.length) line += ` ${digits(whiteOut)}+`;
    }
    lines.push(line);
    const ms = missions[mi];
    if (ms && digits(ms.member ?? []) === digits(team) && ms.crown_set === m.captain_set) {
      const result = ms.result ?? [];
      const fails = result.filter((r) => !r).length;
      lines.push('o'.repeat(result.length - fails) + 'x'.repeat(fails));
      mi += 1;
      attempt = 0;
      if (mi >= 2 && mi <= 4 && lakes[mi - 2]) {
        const lk = lakes[mi - 2];
        // 持湖者沒在練習台按好／壞（畫面顯示「不明」）時寫「?」：DC 牌譜頻道的寫法，每日匯入（discord_records_import.py）讀得懂
        lines.push(`${d(lk.from)}>${d(lk.to as number)} ${lk.result === true ? 'o' : lk.result === false ? 'x' : '?'}`);
      }
    }
  }
  const logs = (end.logs ?? []).map((l) => String(l.msg ?? ''));
  // 刺殺對象：刺中＝「刺客背刺 N家 梅林」；刺錯＝「N家擋刀」；被刺的人在局末畫面標 dead。
  const stabbed = users.find((u) => (u as { dead?: boolean }).dead)?.set
    ?? Number(logs.map((x) => /背刺\s*(\d+)\s*家|(\d+)\s*家擋刀/.exec(x)).find(Boolean)?.slice(1).find(Boolean) ?? NaN);
  // Edward 10/31：牌譜各行 → 刺客刺殺:X（三紅寫 x，照頻道格式）→ 六碼配置（刺娜德奧派梅）→ 依座位「1.暱稱」每人一行
  lines.push(`刺客刺殺:${Number.isFinite(stabbed) ? d(stabbed) : 'x'}`);
  lines.push(paipuConfig(game));
  for (const u of users) lines.push(`${d(u.set)}.${u.name}`);
  return lines.join('\n');
}

/** 局的結果（三紅／三藍死／三藍活），討論串標題用。 */
export function gameKind(game: RecordedGame): string {
  const end = game.end;
  if (!end) return '';
  const logs = (end.logs ?? []).map((l) => String(l.msg ?? ''));
  const blueRounds = (end.missionHistorys ?? []).filter((ms, i) => (ms?.result ?? []).filter((r) => !r).length < (i === 3 && (ms?.result ?? []).length >= 4 ? 2 : 1)).length;
  return blueRounds < 3 ? '三紅' : logs.some((x) => x.includes('壞人獲勝')) ? '三藍死' : '三藍活';
}

/**
 * 練習台內建機器人（is_robot，例：強化人N號）坐的座位數：局末快照，沒有時用最後一張快照。
 * 百科AI 是一般帳號（is_robot false），不算在這裡。
 */
export function siteRobotCount(game: RecordedGame): number {
  const last = game.timeline?.length ? game.timeline[game.timeline.length - 1]?.s?.users : undefined;
  const users: unknown = game.end?.users ?? last;
  return Array.isArray(users) ? users.filter((u) => (u as { is_robot?: boolean } | null)?.is_robot === true).length : 0;
}

/**
 * 整局不貼 DC 的原因（log 用：只有個數，不含暱稱）；要貼（正式或待檢視）時 null。
 * Edward 2026-11-03「我們不會用伺服器內建的強化機器人」：有練習台內建機器人的局不是我們的紀錄，連待檢視都不貼。
 */
export function noPostReason(game: RecordedGame): string | null {
  const robots = siteRobotCount(game);
  if (robots) return `有練習台內建機器人（${robots} 個）`;
  // 2026-11-09：有百科AI 的局由百科AI 自己貼到牌譜區（同格式，附 trace.json），記錄員不重複貼
  const bots = botSeats(game).length;
  return bots ? `有百科AI（${bots} 個，由百科AI 自己貼）` : null;
}

/** 只貼真人 10 人局（遊玩頁內建機器人的練習局不貼）。 */
export function isPostable(game: RecordedGame): boolean {
  return postSkipReason(game) === null;
}

/** 不貼 DC 的原因（log 用，不含暱稱）；可以貼時 null。 */
export function postSkipReason(game: RecordedGame): string | null {
  const users = game.end?.users ?? [];
  if (users.length !== 10) return `${users.length} 人局`;
  if (users.some((u) => (u as { is_robot?: boolean } | null)?.is_robot)) return '有機器人';
  const bots = botSeats(game);
  if (bots.length) return `百科機器人參與（坐 ${bots.map(d).join('、')} 家），不是真人紀錄`;
  // 記錄員中途才進房的局（開局前的提議與任務沒看到）不貼：10/31 第一晚就貼出一篇缺第 1 局的牌譜
  if ((game as { joinedMidGame?: boolean }).joinedMidGame) return '中途加入';
  return isCompleteRecord(game) ? null : '牌譜不完整（沒打完或提議／任務人數不對）';
}

/** 牌譜完整：第 1 次提議是 3 人隊、任務人數依序 3-4-4-5-5，而且任務已經分出勝負（三藍或三紅）。 */
export function isCompleteRecord(game: RecordedGame): boolean {
  const end = game.end;
  if (!end || !end.meetings?.length || new Set(end.meetings[0]?.ticks_set ?? []).size !== 3) return false;
  const sizes = [3, 4, 4, 5, 5];
  let blue = 0;
  let red = 0;
  for (const [i, ms] of (end.missionHistorys ?? []).entries()) {
    const result = ms?.result ?? [];
    if (result.length !== sizes[i]) return false;
    const fails = result.filter((r) => !r).length;
    if (fails >= (i === 3 ? 2 : 1)) red += 1; else blue += 1;
  }
  return blue >= 3 || red >= 3;
}

/** 台灣時間的 Date（取 UTC 欄位來讀）。 */
const twTime = (iso?: string): Date | null => (iso ? new Date(Date.parse(iso) + 8 * 3600_000) : null);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const twDay = (iso?: string): string => { const t = twTime(iso); return t && !Number.isNaN(t.getTime()) ? `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}` : ''; };
const twHHMM = (iso?: string): string => { const t = twTime(iso); return t && !Number.isNaN(t.getTime()) ? `${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}` : ''; };

/**
 * 牌譜頻道是論壇頻道（要帶討論串標題）：一局一個討論串，標題「yyyymmdd_第x局_刺娜德奧派梅」（台灣日期＋六碼配置；Edward 10/31：省略時間，同過去的貼文）。
 * 配置寫在牌譜裡、結果用論壇標籤（同過去的貼文，內文不另寫結果）。第幾局＝當天第幾個打完的真人 10 人局（見 dayIndex）。
 */
export function paipuThreadName(game: RecordedGame, index?: number): string {
  return [twDay(game.startedAt), index ? `第${index}局` : '', game.end ? paipuConfig(game) : ''].filter(Boolean).join('_').slice(0, 100);
}

/**
 * 這局是當天（台灣日期，依開局時刻）第幾個打完的真人 10 人局：數同資料夾裡同一天、比它早或同時結束的可貼局。
 * 用結束順序而不是開局順序，同時開好幾桌時編號才不會重複。
 */
export function dayIndex(file: string): number | undefined {
  try {
    const me = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordedGame & { endedAt?: string };
    const day = twDay(me.startedAt);
    const dir = path.dirname(file);
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.includes('incomplete')) continue;
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as RecordedGame & { endedAt?: string };
      if (twDay(g.startedAt) === day && isPostable(g) && gameToPaipu(g) && (g.endedAt ?? '') <= (me.endedAt ?? '')) n += 1;
    }
    return n || undefined;
  } catch {
    return undefined;
  }
}

/** 結果，用論壇標籤的名稱：三紅／三藍被刀／三藍躲刺。 */
function resultTag(game: RecordedGame): string {
  const kind = gameKind(game);
  return kind === '三紅' ? '三紅' : kind === '三藍死' ? '三藍被刀' : kind === '三藍活' ? '三藍躲刺' : '';
}

/** 論壇標籤：結果（每日匯入用的名稱）＋線瓦（線上局）。 */
export function paipuTags(game: RecordedGame): string[] {
  const result = resultTag(game);
  return result ? [result, '線瓦'] : ['線瓦'];
}

/**
 * 待檢視的局的討論串標題：「【待檢視】yyyymmdd_HHMM_房號」（台灣時間的開局時刻），六碼配置齊全時再接「_配置」。
 * 不寫「第n局」：當天第幾局只數通過檢查的局（dayIndex），標題才和每日匯入的場次對得上。
 */
export function unverifiedThreadName(game: RecordedGame): string {
  const when = game.startedAt ?? game.endedAt;
  const room = String(game.room ?? '').replace(/\s+/g, '');
  const parts = [botSeats(game).length ? '含百科機器人' : '', twDay(when), twHHMM(when), room, hasValidConfig(game) ? paipuConfig(game) : ''].filter(Boolean);
  return `${UNVERIFIED_PREFIX}${parts.join('_') || '未知局'}`.slice(0, 100);
}

/** 待檢視的原因（中文，寫進內文；記錄員的 log 也用這個，不含暱稱）。 */
export function unverifiedReason(game: RecordedGame): string {
  if (!game.end) return '沒有抓到局末畫面資料';
  try {
    return postSkipReason(game) ?? '牌譜轉換失敗';
  } catch {
    return '紀錄資料格式不對';
  }
}

/** 內文最後加 REVIEW_NOTE；太長時截掉前面的內文，備註一定留著（Discord 一則訊息 2000 字）。 */
export function withReviewNote(body: string): string {
  const max = 1990 - REVIEW_NOTE.length - 1;
  const text = body.length > max ? body.slice(0, max) : body;
  return text ? `${text}\n${REVIEW_NOTE}` : REVIEW_NOTE;
}

export interface PaipuPost {
  /** 討論串標題 */
  name: string;
  /** 起始訊息（已含 REVIEW_NOTE） */
  content: string;
  /** 論壇標籤名稱 */
  tags: string[];
  /** 通過檢查（postSkipReason 為 null）的正式牌譜 */
  verified: boolean;
}

/**
 * 一局 → 要貼的文章。通過檢查：標題 yyyymmdd_第n局_配置（n＝dayIndex）、結果標籤＋線瓦、內文＝牌譜。
 * 沒通過：標題「【待檢視】…」（unverifiedThreadName）、只掛線瓦（不掛結果標籤，每日匯入也不會收）、
 * 內文＝「待檢視原因：…」＋盡量轉出的牌譜。兩種最後一行都是 REVIEW_NOTE。不丟錯。
 */
export function buildPaipuPost(game: RecordedGame, index?: number): PaipuPost {
  let skip: string | null;
  try {
    skip = postSkipReason(game);
  } catch {
    skip = '紀錄資料格式不對';
  }
  if (!skip) {
    let text: string | null = null;
    try { text = gameToPaipu(game); } catch { text = null; }
    if (text) return { name: paipuThreadName(game, index), content: withReviewNote(text), tags: paipuTags(game), verified: true };
    skip = '牌譜轉換失敗';
  }
  const reason = game.end ? skip : unverifiedReason(game);
  const text = gameToPaipuLoose(game);
  const body = [`待檢視原因：${reason}`, text || '（沒有可用的牌譜資料）'].join('\n');
  return { name: unverifiedThreadName(game), content: withReviewNote(body), tags: botSeats(game).length ? ['線瓦', BOT_GAME_TAG] : ['線瓦'], verified: false };
}

/** DC 牌譜頻道（論壇）。頻道 id 不是密鑰。 */
const PAIPU_FORUM_ID = process.env.DISCORD_PAIPU_CHANNEL_ID || '1132683080134578276';

/** 附在起始訊息的圖（記錄員截的「開牌後配置」「視覺化牌譜」）。 */
export interface PaipuImage { filename: string; data: Uint8Array; contentType: string }

/**
 * 送出的內容：沒有圖時 JSON；有圖時 multipart（payload_json＋files[0]、files[1]…，
 * attachments 寫在 `attachmentsAt` 這一層：開論壇討論串是 message 裡，webhook 是最外層）。
 */
export function discordBody(payload: Record<string, unknown>, images: PaipuImage[], attachmentsAt?: string): { body: string | FormData; json: boolean } {
  if (!images.length) return { body: JSON.stringify(payload), json: true };
  const attachments = images.map((im, i) => ({ id: i, filename: im.filename }));
  const full = attachmentsAt
    ? { ...payload, [attachmentsAt]: { ...(payload[attachmentsAt] as Record<string, unknown>), attachments } }
    : { ...payload, attachments };
  const form = new FormData();
  form.append('payload_json', JSON.stringify(full));
  images.forEach((im, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(im.data)], { type: im.contentType }), im.filename));
  return { body: form, json: false };
}

/**
 * 送一次；帶圖被 Discord 以 4xx 拒收（圖太大、格式不收）時改成不帶圖再送一次——文字一定要貼出去。
 * 5xx／網路錯誤不重送（Discord 可能已經收了，重送會貼兩篇）。
 */
async function sendWithImageFallback(
  url: string, headers: Record<string, string>, payload: Record<string, unknown>, images: PaipuImage[], attachmentsAt?: string,
): Promise<Response> {
  const send = (imgs: PaipuImage[]): Promise<Response> => {
    const { body, json } = discordBody(payload, imgs, attachmentsAt);
    return fetch(url, { method: 'POST', headers: json ? { ...headers, 'Content-Type': 'application/json' } : headers, body });
  };
  const res = await send(images);
  if (!res.ok && images.length && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
    console.log(`Discord 帶圖 ${res.status}，改成不帶圖`);
    return send([]);
  }
  return res;
}

/**
 * 貼到 DC 牌譜頻道，開一個新討論串。有 DISCORD_BOT_TOKEN 時用機器人發（可以掛結果標籤；GitHub Actions 排程用這個），
 * 否則用 DISCORD_PAIPU_WEBHOOK_URL；兩個都沒有時不做事，回傳 false。`images` 附在起始訊息（兩種都支援）。
 */
export async function postPaipu(text: string, threadName?: string, tags: string[] = [], images: PaipuImage[] = []): Promise<boolean> {
  const bot = process.env.DISCORD_BOT_TOKEN;
  if (bot && threadName) {
    const api = 'https://discord.com/api/v10';
    const headers = { Authorization: `Bot ${bot}` };
    let appliedTags: string[] = [];
    if (tags.length) {
      const ch = await fetch(`${api}/channels/${PAIPU_FORUM_ID}`, { headers });
      if (ch.ok) {
        const avail = ((await ch.json()) as { available_tags?: { id: string; name: string }[] }).available_tags ?? [];
        appliedTags = tags.map((n) => avail.find((t) => t.name === n)?.id).filter((x): x is string => Boolean(x));
      }
    }
    const res = await sendWithImageFallback(`${api}/channels/${PAIPU_FORUM_ID}/threads`, headers, {
      name: threadName, applied_tags: appliedTags,
      message: { content: text.slice(0, 1990), allowed_mentions: { parse: [] } },
    }, images, 'message');
    // 錯誤只印狀態碼：公開 repo 的 Actions log 不放牌譜內容與暱稱
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    return true;
  }
  const url = process.env.DISCORD_PAIPU_WEBHOOK_URL;
  if (!url) return false;
  const res = await sendWithImageFallback(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {}, {
    username: '阿瓦隆百科記錄員', content: text.slice(0, 1990), allowed_mentions: { parse: [] },
    ...(threadName ? { thread_name: threadName } : {}),
  }, images);
  if (!res.ok) throw new Error(`Discord webhook ${res.status}`);
  return true;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('signagePaipu')) {
  const args = process.argv.slice(2);
  const post = args.includes('--post');
  const files = args.filter((a) => a !== '--post' && a !== '--json');
  void (async () => {
    for (const f of files) {
      const game = JSON.parse(fs.readFileSync(f, 'utf-8')) as RecordedGame;
      if (game.incomplete) { console.log(`# ${path.basename(f)}：未完成檔，略過`); continue; }
      const noPost = noPostReason(game);
      if (noPost) { console.log(`# ${path.basename(f)}：不貼 DC：${noPost}`); continue; }
      // Edward 11/03：每局都貼；沒通過檢查的標題加【待檢視】（buildPaipuPost）
      const p = buildPaipuPost(game, isPostable(game) ? dayIndex(f) : undefined);
      if (process.argv.includes('--json')) { console.log(JSON.stringify({ text: p.content, thread: p.name, tags: p.tags, verified: p.verified })); continue; }
      if (post) {
        const ok = await postPaipu(p.content, p.name, p.tags);
        console.log(ok ? `已貼出 ${path.basename(f)}${p.verified ? '' : '（待檢視）'}` : '沒有設定 DISCORD_BOT_TOKEN 或 DISCORD_PAIPU_WEBHOOK_URL，未貼出');
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        console.log(`# ${p.name}\n${p.content}\n`);
      }
    }
    process.exit(0);
  })();
}
