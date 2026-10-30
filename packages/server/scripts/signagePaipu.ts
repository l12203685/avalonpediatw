/**
 * 記錄員存的局（scripts/signageRecorder.ts 的 JSON）→ 百科〈遊戲紀錄〉（wiki-65）牌譜寫法，並可貼到 Discord。
 *
 *   tsx scripts/signagePaipu.ts <局.json> [...]            印出牌譜
 *   tsx scripts/signagePaipu.ts --post <局.json> [...]     貼到 DISCORD_PAIPU_WEBHOOK_URL（DC 牌譜頻道的 Webhook）
 *
 * Edward 2026-10-30：「貼在 DC 的牌譜頻道，要附座位暱稱」。Webhook 網址是密鑰，只從環境變數讀，不寫進 repo。
 * 牌譜格式：一行一次提議（隊伍座位；`-` 內黑、`+` 外白；強制局不投票、不標記號）、任務牌 o／x、湖中 `x>y o`，
 * 最後六碼＝刺娜德奧派梅的座位；打到三藍時多一行「刺殺：X」（練習台只記得到刺客最後刺的人）。座位 10 寫成 0。
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
  const lines: string[] = [];
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
        lines.push(`${d(lk.from)}>${d(lk.to as number)} ${lk.result === true ? 'o' : lk.result === false ? 'x' : '?'}`);
      }
    }
  }
  const roleAt = (name: string): string => { const u = users.find((x) => x.role === name); return u ? d(u.set) : '?'; };
  lines.push(ROLE_ORDER.map(roleAt).join(''));
  const logs = (end.logs ?? []).map((l) => String(l.msg ?? ''));
  const stab = logs.map((x) => /背刺\s*(\d+)\s*家/.exec(x)).find(Boolean);
  if (stab) lines.push(`刺殺：${d(Number(stab[1]))}`);
  const redWon = logs.some((x) => x.includes('壞人獲勝'));
  const blueWon = logs.some((x) => x.includes('好人獲勝'));
  const blueRounds = end.missionHistorys.filter((ms, i) => ms.result.filter((r) => !r).length < (i === 3 && ms.result.length >= 4 ? 2 : 1)).length;
  const kind = blueRounds < 3 ? '三紅' : redWon ? '三藍死' : '三藍活';
  const when = (game.startedAt ?? '').slice(0, 16).replace('T', ' ');
  const seats = users.map((u) => `${d(u.set)} ${u.name}`).join(' / ');
  return [
    `**【${game.title || game.room}】** ${when} UTC`,
    `座位：${seats}`,
    '```',
    ...lines,
    '```',
    `結果：${kind}（${redWon ? '紅方勝' : blueWon ? '好人勝' : '?'}）`,
  ].join('\n');
}

/** 貼到 Discord Webhook（DISCORD_PAIPU_WEBHOOK_URL）；沒設定時不做事，回傳 false。 */
export async function postPaipu(text: string): Promise<boolean> {
  const url = process.env.DISCORD_PAIPU_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '阿瓦隆百科記錄員', content: text.slice(0, 1990), allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => '')}`);
  return true;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('signagePaipu')) {
  const args = process.argv.slice(2);
  const post = args.includes('--post');
  const files = args.filter((a) => a !== '--post');
  void (async () => {
    for (const f of files) {
      const text = gameToPaipu(JSON.parse(fs.readFileSync(f, 'utf-8')) as RecordedGame);
      if (!text) { console.log(`# ${path.basename(f)}：未完成，略過`); continue; }
      if (post) {
        const ok = await postPaipu(text);
        console.log(ok ? `已貼出 ${path.basename(f)}` : '沒有設定 DISCORD_PAIPU_WEBHOOK_URL，未貼出');
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        console.log(`${text}\n`);
      }
    }
    process.exit(0);
  })();
}
