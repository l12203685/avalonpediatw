/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 67 回合（紅方）：人類 PR 量尺（`humanPrBenchmark.ts --roles assassin,morgana,mordred,oberon --dump`）的逐決策紀錄接回真人局的局面，
 * 輸出一行一個決策（JSONL，沒有名字、沒有局號，只有資料集裡的序號），給 `redSideStudy67.py` 依局面格拆量尺落差（同第 66 回合藍方的做法）。
 *
 *   cd packages/server && npx tsx scripts/redSideStudy67.ts pr_A.jsonl --out cells_A.jsonl [--dataset games_cache.json]
 *
 * 每列：決策種類、角色、桌上 S、局、第幾次、比分、強制、真人／機器人的優勢（量尺單位：勝率）、真人／機器人的選擇，
 * 以及這種決策的局面特徵：
 * - vote：位置（隊長／在隊上／不在）、隊上實際紅數、隊上看得到的隊友數（不算自己；奧伯倫看不到）、隊長是不是看得到的隊友、要幾張失敗。
 * - team：真人與機器人的隊：自己在不在、實際紅數、看得到的紅數（含自己）、莫德雷德在不在、出過失敗任務的人數、照派。
 * - quest：隊上實際紅數、隊上看得到的紅數（含自己）、要幾張失敗、出牌（F／S）。
 * - lakeTarget：目標實際陣營、目標出過失敗任務、目標是不是看得到的隊友、目標在不在上一局的隊上。
 * - lakeClaim：目標實際陣營、宣告（truth／lie／none）。
 * - assassinate：刺中與否。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { isReuse, parseSeatList, scoreBefore, taintedBefore } from '../src/ai/benchmark/humanPr';

interface Item { gi: number; seat: number; type: string; role: string; human: number; bot: number; agree: boolean; idx?: number; botAction?: string }

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main(): void {
  const input = argv.find((a, i) => a.endsWith('.jsonl') && !(i > 0 && ['--out', '--dataset'].includes(argv[i - 1])));
  const outPath = arg('--out');
  if (!input || !outPath) throw new Error('usage: redSideStudy67.ts pr.jsonl --out cells.jsonl');
  const dataset = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(dataset, 'utf8'))).games;
  const items = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Item);
  const lines: string[] = [];
  for (const it of items) {
    const d = games[it.gi];
    const g = d.game;
    if (g.playerCount !== 10 || !EVIL_ROLES.has(it.role as never)) continue;
    const seat = it.seat;
    const roleOf = (s: number): string => g.seatRoles[s - 1];
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const known = (s: number): boolean => s === seat || (it.role !== 'oberon' && red(s) && roleOf(s) !== 'oberon');
    const need = (round: number): number => AVALON_CONFIG[10].questFailsRequired?.[round - 1] ?? 1;
    const base: Record<string, unknown> = { gi: it.gi, s: d.s, role: it.role, seat, type: it.type, h: it.human, b: it.bot, agree: it.agree ? 1 : 0 };
    const teamDesc = (team: readonly number[], round: number, leader: number): Record<string, number> => {
      const tainted = taintedBefore(g, round);
      return {
        n: team.length, self: team.includes(seat) ? 1 : 0, reds: team.filter(red).length, known: team.filter(known).length,
        mord: team.some((s) => roleOf(s) === 'mordred') ? 1 : 0, ober: team.some((s) => roleOf(s) === 'oberon') ? 1 : 0,
        t: team.filter((s) => s !== leader && tainted.has(s)).length, u: isReuse(g, round, team) ? 1 : 0,
      };
    };
    if (it.type === 'vote' || it.type === 'team') {
      const p = g.proposals[it.idx ?? 0];
      Object.assign(base, { round: p.round, attempt: p.attempt, forced: p.forced ? 1 : 0, score: scoreBefore(g, p.round), need: need(p.round) });
      if (it.type === 'vote') {
        Object.assign(base, {
          pos: p.leaderSeat === seat ? 'L' : p.teamSeats.includes(seat) ? 'on' : 'off', reds: p.teamSeats.filter(red).length,
          mates: p.teamSeats.filter((s) => s !== seat && known(s)).length, leaderMate: p.leaderSeat !== seat && known(p.leaderSeat) ? 1 : 0,
          yesOthers: p.votes.filter((v, k) => v && k !== seat - 1).length, hv: p.votes[seat - 1] ? 1 : 0, bv: it.botAction === 'approve' ? 1 : 0,
          passed: p.approveCount > 5 ? 1 : 0, selfT: taintedBefore(g, p.round).has(seat) ? 1 : 0,
          teamT: p.teamSeats.filter((s) => s !== seat && taintedBefore(g, p.round).has(s)).length, u: isReuse(g, p.round, p.teamSeats) ? 1 : 0,
        });
      } else {
        const bot = parseSeatList(it.botAction ?? '');
        Object.assign(base, { ht: teamDesc(p.teamSeats, p.round, seat), bt: bot.length === p.teamSeats.length ? teamDesc(bot, p.round, seat) : null, went: p.wentOnMission ? 1 : 0 });
      }
    } else if (it.type === 'quest') {
      const round = it.idx ?? 0;
      const q = g.quests.find((x) => x.round === round);
      if (!q) continue;
      const lead = g.proposals.find((p) => p.round === round && p.wentOnMission)?.leaderSeat ?? 0;
      Object.assign(base, {
        round, score: scoreBefore(g, round), need: need(round), reds: q.teamSeats.filter(red).length, known: q.teamSeats.filter(known).length,
        selfLead: lead === seat ? 1 : 0, mateLead: lead !== seat && known(lead) ? 1 : 0, failN: q.failCount,
        // 真人的牌：量尺只收能確定的牌（全部成功 = S；失敗張數 = 紅數 = 全部 F）
        hc: q.failCount === 0 ? 0 : 1, bc: it.botAction === 'fail' ? 1 : 0,
      });
    } else if (it.type === 'lakeTarget' || it.type === 'lakeClaim') {
      const l = g.lakes[it.idx ?? 0];
      const round = l.round;
      const prevTeam = g.quests.find((q) => q.round === round)?.teamSeats ?? [];
      const tainted = taintedBefore(g, round + 1);
      const tgt = (t: number): Record<string, number> => ({ red: red(t) ? 1 : 0, known: t !== seat && known(t) ? 1 : 0, t: tainted.has(t) ? 1 : 0, prev: prevTeam.includes(t) ? 1 : 0 });
      Object.assign(base, { round: l.round, score: scoreBefore(g, round + 1) });
      if (it.type === 'lakeTarget') {
        const b = Number.parseInt(it.botAction ?? '', 10);
        Object.assign(base, { htg: tgt(l.targetSeat), btg: Number.isFinite(b) ? tgt(b) : null });
      } else {
        const truth = red(l.targetSeat) ? 'evil' : 'good';
        const act = (c: string | null): string => (c === null || (c !== 'good' && c !== 'evil') ? 'none' : c === truth ? 'truth' : 'lie');
        Object.assign(base, { truth, tknown: known(l.targetSeat) && l.targetSeat !== seat ? 1 : 0, hcl: act(l.claim), bcl: act(it.botAction ?? null) });
      }
    } else if (it.type === 'assassinate') {
      Object.assign(base, { round: 6 });
    }
    lines.push(JSON.stringify(base));
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${outPath}`);
}

main();
