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
 */
import fs from 'node:fs';
import path from 'node:path';

interface Meeting { ticks_set: number[]; white_ball_set: number[]; captain_set: number }
interface Mission { result: boolean[]; member: number[]; crown_set: number }
interface Lake { from: number; to: number | null; result: boolean | null }
interface User { set: number; name: string; role: string }
interface Snapshot { users: User[]; meetings: Meeting[]; missionHistorys: Mission[]; lake: Lake[] | null; logs?: { msg?: string }[] }
export interface RecordedGame { room: string; title?: string; startedAt?: string; end?: Snapshot | null; incomplete?: boolean }

const ROLE_ORDER = ['刺客', '莫甘娜', '莫德雷德', '奧伯倫', '派西維爾', '梅林'];
const d = (seat: number): string => (seat === 10 ? '0' : String(seat));
const digits = (seats: Iterable<number>): string => [...seats].sort((a, b) => (a === 10 ? 10 : a) - (b === 10 ? 10 : b)).map(d).join('');

/** 一局 → 牌譜文字（Discord 訊息；未完成的局回傳 null）。 */
export function gameToPaipu(game: RecordedGame): string | null {
  const end = game.end;
  if (!end || game.incomplete) return null;
  const users = [...end.users].sort((a, b) => a.set - b.set);
  const lakes = (end.lake ?? []).filter((l) => l.to !== null);
  // 結果寫在文章最前面（Edward 10/31：標題只放時間和局數）；匯入程式略過牌譜前的文字
  const lines: string[] = [`結果:${resultTag(game)}`];
  let mi = 0;
  let attempt = 0;
  for (const m of end.meetings) {
    const team = new Set(m.ticks_set);
    const whites = new Set(m.white_ball_set);
    attempt += 1;
    const forced = attempt === 5 || (whites.size === 10 && team.size < 10);
    let line = digits(team);
    if (!forced) {
      const blackIn = [...team].filter((s) => !whites.has(s));
      const whiteOut = [...whites].filter((s) => !team.has(s));
      // 內黑在前、外白在後（DC 牌譜頻道過去多數文章的寫法，例：2579 7- 1+）
      if (blackIn.length) line += ` ${digits(blackIn)}-`;
      if (whiteOut.length) line += ` ${digits(whiteOut)}+`;
    }
    lines.push(line);
    const ms = end.missionHistorys[mi];
    if (ms && digits(ms.member) === digits(team) && ms.crown_set === m.captain_set) {
      const fails = ms.result.filter((r) => !r).length;
      lines.push('o'.repeat(ms.result.length - fails) + 'x'.repeat(fails));
      mi += 1;
      attempt = 0;
      if (mi >= 2 && mi <= 4 && lakes[mi - 2]) {
        const lk = lakes[mi - 2];
        // 持湖者沒在練習台按好／壞（畫面顯示「不明」）時寫「?」：DC 牌譜頻道的寫法，每日匯入（discord_records_import.py）讀得懂
        lines.push(`${d(lk.from)}>${d(lk.to as number)} ${lk.result === true ? 'o' : lk.result === false ? 'x' : '?'}`);
      }
    }
  }
  const roleAt = (name: string): string => { const u = users.find((x) => x.role === name); return u ? d(u.set) : '?'; };
  const logs = (end.logs ?? []).map((l) => String(l.msg ?? ''));
  // 刺殺對象：刺中＝「刺客背刺 N家 梅林」；刺錯＝「N家擋刀」；被刺的人在局末畫面標 dead。
  const stabbed = users.find((u) => (u as { dead?: boolean }).dead)?.set
    ?? Number(logs.map((x) => /背刺\s*(\d+)\s*家|(\d+)\s*家擋刀/.exec(x)).find(Boolean)?.slice(1).find(Boolean) ?? NaN);
  // Edward 10/31：牌譜各行 → 刺客刺殺:X（三紅寫 x，照頻道格式）→ 六碼配置（刺娜德奧派梅）→ 依座位「1.暱稱」每人一行
  lines.push(`刺客刺殺:${Number.isFinite(stabbed) ? d(stabbed) : 'x'}`);
  lines.push(ROLE_ORDER.map(roleAt).join(''));
  for (const u of users) lines.push(`${d(u.set)}.${u.name}`);
  return lines.join('\n');
}

/** 局的結果（三紅／三藍死／三藍活），討論串標題用。 */
export function gameKind(game: RecordedGame): string {
  const end = game.end;
  if (!end) return '';
  const logs = (end.logs ?? []).map((l) => String(l.msg ?? ''));
  const blueRounds = end.missionHistorys.filter((ms, i) => ms.result.filter((r) => !r).length < (i === 3 && ms.result.length >= 4 ? 2 : 1)).length;
  return blueRounds < 3 ? '三紅' : logs.some((x) => x.includes('壞人獲勝')) ? '三藍死' : '三藍活';
}

/** 只貼真人 10 人局（遊玩頁內建機器人的練習局不貼）。 */
export function isPostable(game: RecordedGame): boolean {
  const users = game.end?.users ?? [];
  return users.length === 10 && !users.some((u) => (u as { is_robot?: boolean }).is_robot);
}

/** 台灣時間的 Date（取 UTC 欄位來讀）。 */
const twTime = (iso?: string): Date | null => (iso ? new Date(Date.parse(iso) + 8 * 3600_000) : null);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const twDay = (iso?: string): string => { const t = twTime(iso); return t ? `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}` : ''; };

/**
 * 牌譜頻道是論壇頻道（要帶討論串標題）：一局一個討論串，標題「yyyymmdd_HHMM_第x局」（台灣時間、開局時刻；
 * Edward 10/31：配置與結果寫在文章裡）。第幾局＝當天第幾個打完的真人 10 人局（見 dayIndex）。
 */
export function paipuThreadName(game: RecordedGame, index?: number): string {
  const t = twTime(game.startedAt);
  const hhmm = t ? `${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}` : '';
  return [twDay(game.startedAt), hhmm, index ? `第${index}局` : ''].filter(Boolean).join('_').slice(0, 100);
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

/** DC 牌譜頻道（論壇）。頻道 id 不是密鑰。 */
const PAIPU_FORUM_ID = process.env.DISCORD_PAIPU_CHANNEL_ID || '1132683080134578276';

/**
 * 貼到 DC 牌譜頻道，開一個新討論串。有 DISCORD_BOT_TOKEN 時用機器人發（可以掛結果標籤；GitHub Actions 排程用這個），
 * 否則用 DISCORD_PAIPU_WEBHOOK_URL；兩個都沒有時不做事，回傳 false。
 */
export async function postPaipu(text: string, threadName?: string, tags: string[] = []): Promise<boolean> {
  const bot = process.env.DISCORD_BOT_TOKEN;
  if (bot && threadName) {
    const api = 'https://discord.com/api/v10';
    const headers = { Authorization: `Bot ${bot}`, 'Content-Type': 'application/json' };
    let appliedTags: string[] = [];
    if (tags.length) {
      const ch = await fetch(`${api}/channels/${PAIPU_FORUM_ID}`, { headers });
      if (ch.ok) {
        const avail = ((await ch.json()) as { available_tags?: { id: string; name: string }[] }).available_tags ?? [];
        appliedTags = tags.map((n) => avail.find((t) => t.name === n)?.id).filter((x): x is string => Boolean(x));
      }
    }
    const res = await fetch(`${api}/channels/${PAIPU_FORUM_ID}/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: threadName, applied_tags: appliedTags,
        message: { content: text.slice(0, 1990), allowed_mentions: { parse: [] } },
      }),
    });
    // 錯誤只印狀態碼：公開 repo 的 Actions log 不放牌譜內容與暱稱
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    return true;
  }
  const url = process.env.DISCORD_PAIPU_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: '阿瓦隆百科記錄員', content: text.slice(0, 1990), allowed_mentions: { parse: [] },
      ...(threadName ? { thread_name: threadName } : {}),
    }),
  });
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
      const text = isPostable(game) ? gameToPaipu(game) : null;
      if (!text) { console.log(`# ${path.basename(f)}：未完成或非真人 10 人局，略過`); continue; }
      if (process.argv.includes('--json')) { console.log(JSON.stringify({ text, thread: paipuThreadName(game, dayIndex(f)), tags: paipuTags(game) })); continue; }
      if (post) {
        const ok = await postPaipu(text, paipuThreadName(game, dayIndex(f)), paipuTags(game));
        console.log(ok ? `已貼出 ${path.basename(f)}` : '沒有設定 DISCORD_BOT_TOKEN 或 DISCORD_PAIPU_WEBHOOK_URL，未貼出');
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        console.log(`${text}\n`);
      }
    }
    process.exit(0);
  })();
}
