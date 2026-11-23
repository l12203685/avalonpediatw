/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 68 回合（藍方）：人類 PR 量尺（`humanPrBenchmark.ts --roles loyal,percival,merlin --dump`）的逐決策紀錄接回真人局的局面，
 * 輸出一行一個決策（JSONL，沒有名字、沒有局號，只有資料集裡的序號），給 `blueSideStudy68.py` 依局面格拆量尺落差
 * （第 66 回合藍方、第 67 回合紅方的做法；這一版多記湖的結果怎麼被用、任務失敗之後的提議、第 5 次提議）。
 *
 *   cd packages/server && npx tsx scripts/blueSideStudy68.ts pr_A.jsonl --out cells_A.jsonl [--dataset games_cache.json]
 *
 * 每列：決策種類、角色、桌上 S、局、第幾次、比分、強制、真人／機器人的優勢（量尺單位：勝率）、真人／機器人的選擇，以及：
 * - vote：位置（隊長／在隊上／不在）、隊上實際紅數、要幾張失敗、隊上出過失敗任務的人數、照派、派西看到的拇指數、梅林看得到的紅數、
 *   湖：隊上有沒有「自己湖過、知道是紅」的人（lkr）、「被公開宣告紅」的人（ldr）、「被公開宣告好」的人（ldg）、自己是不是被宣告紅（sdr）。
 * * - team：真人與機器人的隊（自己在不在、實際紅數、會不會失敗、出過失敗、照派、拇指、看得到的紅、湖的三項），上一局失敗沒有（pf）、上一局的失敗張數（pfc）。
 * - lakeTarget：真人與機器人的目標（實際陣營、出過失敗、上一局隊上、拇指、梅林看得到的紅、被宣告過）。
 * - lakeClaim：目標實際陣營、宣告（truth／lie／none）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { isReuse, parseSeatList, scoreBefore, taintedBefore } from '../src/ai/benchmark/humanPr';

interface Item { gi: number; seat: number; type: string; role: string; human: number; bot: number; agree: boolean; idx?: number; botAction?: string }

const BLUE = new Set(['loyal', 'percival', 'merlin']);
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const input = argv.find((a, i) => a.endsWith('.jsonl') && !(i > 0 && ['--out', '--dataset'].includes(argv[i - 1])));
  const outPath = arg('--out');
  if (!input || !outPath) throw new Error('usage: blueSideStudy68.ts pr.jsonl --out cells.jsonl');
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8'))).games;
  const items = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Item);
  const lines: string[] = [];
  for (const it of items) {
    const d = games[it.gi];
    const g = d.game;
    if (g.playerCount !== 10 || !BLUE.has(it.role)) continue;
    const seat = it.seat;
    const roleOf = (s: number): string => g.seatRoles[s - 1];
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1] as never);
    const thumb = (s: number): boolean => it.role === 'percival' && (roleOf(s) === 'merlin' || roleOf(s) === 'morgana');
    const seen = (s: number): boolean => it.role === 'merlin' && red(s) && roleOf(s) !== 'mordred';
    const need = (round: number): number => AVALON_CONFIG[10].questFailsRequired?.[round - 1] ?? 1;
    // 湖：第 round 局開始前公開的宣告；自己持湖看到的真相。
    const lakesBefore = (round: number): typeof g.lakes => g.lakes.filter((l) => l.round < round);
    const lakeSets = (round: number): { ownRed: Set<number>; declRed: Set<number>; declGood: Set<number>; n: number } => {
      const ls = lakesBefore(round);
      const ownRed = new Set(ls.filter((l) => l.holderSeat === seat && red(l.targetSeat)).map((l) => l.targetSeat));
      const declRed = new Set(ls.filter((l) => l.holderSeat !== seat && l.claim === 'evil').map((l) => l.targetSeat));
      const declGood = new Set(ls.filter((l) => l.holderSeat !== seat && l.claim === 'good').map((l) => l.targetSeat));
      return { ownRed, declRed, declGood, n: ls.length };
    };
    const base: Record<string, unknown> = { gi: it.gi, s: d.s, role: it.role, seat, type: it.type, h: it.human, b: it.bot, agree: it.agree ? 1 : 0 };
    const teamDesc = (team: readonly number[], round: number, leader: number): Record<string, number> => {
      const tainted = taintedBefore(g, round);
      const lk = lakeSets(round);
      const reds = team.filter(red).length;
      return {
        n: team.length, self: team.includes(seat) ? 1 : 0, reds, dirty: reds >= need(round) ? 1 : 0,
        t: team.filter((s) => s !== leader && tainted.has(s)).length, u: isReuse(g, round, team) ? 1 : 0,
        th: team.filter(thumb).length, kr: team.filter(seen).length,
        lkr: team.filter((s) => lk.ownRed.has(s)).length, ldr: team.filter((s) => lk.declRed.has(s)).length, ldg: team.filter((s) => lk.declGood.has(s)).length,
      };
    };
    if (it.type === 'vote' || it.type === 'team') {
      const p = g.proposals[it.idx ?? 0];
      const prev = g.quests.filter((q) => q.round < p.round);
      Object.assign(base, {
        round: p.round, attempt: p.attempt, forced: p.forced ? 1 : 0, score: scoreBefore(g, p.round), need: need(p.round),
        pf: prev.length > 0 && prev[prev.length - 1].failed ? 1 : 0, pfc: prev.length > 0 ? prev[prev.length - 1].failCount : 0, lakes: lakesBefore(p.round).length,
      });
      if (it.type === 'vote') {
        const t = teamDesc(p.teamSeats, p.round, p.leaderSeat);
        const lk = lakeSets(p.round);
        Object.assign(base, {
          pos: p.leaderSeat === seat ? 'L' : p.teamSeats.includes(seat) ? 'on' : 'off', reds: t.reds, dirty: t.dirty,
          teamT: p.teamSeats.filter((s) => s !== seat && taintedBefore(g, p.round).has(s)).length, selfT: taintedBefore(g, p.round).has(seat) ? 1 : 0,
          u: t.u, th: t.th, kr: t.kr, lkr: t.lkr, ldr: t.ldr, ldg: t.ldg, sdr: lk.declRed.has(seat) ? 1 : 0,
          leaderRed: red(p.leaderSeat) ? 1 : 0, leaderDR: lk.declRed.has(p.leaderSeat) ? 1 : 0, leaderOwnRed: lk.ownRed.has(p.leaderSeat) ? 1 : 0,
          hv: p.votes[seat - 1] ? 1 : 0, bv: it.botAction === 'approve' ? 1 : 0, passed: p.approveCount > 5 ? 1 : 0, yes: p.approveCount,
        });
      } else {
        const bot = parseSeatList(it.botAction ?? '');
        Object.assign(base, { ht: teamDesc(p.teamSeats, p.round, seat), bt: bot.length === p.teamSeats.length ? teamDesc(bot, p.round, seat) : null, went: p.wentOnMission ? 1 : 0 });
      }
    } else if (it.type === 'lakeTarget' || it.type === 'lakeClaim') {
      const l = g.lakes[it.idx ?? 0];
      const round = l.round;
      const prevTeam = g.quests.find((q) => q.round === round)?.teamSeats ?? [];
      const tainted = taintedBefore(g, round + 1);
      const lk = lakeSets(round + 1);
      const tgt = (x: number): Record<string, number> => ({
        red: red(x) ? 1 : 0, t: tainted.has(x) ? 1 : 0, prev: prevTeam.includes(x) ? 1 : 0, th: thumb(x) ? 1 : 0, kr: seen(x) ? 1 : 0,
        ldr: lk.declRed.has(x) ? 1 : 0, ldg: lk.declGood.has(x) ? 1 : 0,
      });
      Object.assign(base, { round: l.round, score: scoreBefore(g, round + 1), lakes: lakesBefore(round + 1).length - 1 });
      if (it.type === 'lakeTarget') {
        const b = Number.parseInt(it.botAction ?? '', 10);
        Object.assign(base, { htg: tgt(l.targetSeat), btg: Number.isFinite(b) ? tgt(b) : null });
      } else {
        const truth = red(l.targetSeat) ? 'evil' : 'good';
        const act = (c: string | null): string => (c === null || (c !== 'good' && c !== 'evil') ? 'none' : c === truth ? 'truth' : 'lie');
        Object.assign(base, { truth, hcl: act(l.claim), bcl: act(it.botAction ?? null) });
      }
    } else {
      continue;
    }
    lines.push(JSON.stringify(base));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
