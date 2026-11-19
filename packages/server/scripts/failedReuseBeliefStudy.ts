/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 55 回合（站長 11/19「第二局的任務結果資訊 跟第一局任務結果資訊要合起來看」）：失敗過的照派（成功隊 S 整隊在之後失敗的任務 F 裡）的局面，
 * 好人（忠臣／派西）的後驗說 S 有紅的機率，和真相比。拆成讀法的成分：完整、拿掉「S 成功之後到 F 之前，非出任務的提議（與它們的票）」、
 * 只用任務＋湖（拿掉全部提議與票）、`copyDiscount55` 的幾個 d（照派那一隊的提議以權重 1 − d 讀）、第 55b 回合的 `copyRepeat55b`（第二個照派起打折）與 `copyFreq55b`（照派頻率當概似）。每個決策點一列 JSON（沒有玩家名）。
 *
 *   cd packages/server && npx tsx scripts/failedReuseBeliefStudy.ts --out rows.jsonl [--flag name=v ...] [--all-seats]
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { contaminatedSuccessTeams } from '../src/ai/benchmark/knownRed54';
import { bayesOptionsOf, bayesTeamClean, bayesRedShare } from '../src/ai/belief/BayesBelief';
import type { PlayerObservation } from '../src/ai/types';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const allSeats = argv.includes('--all-seats');
  const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)));
  const opts = bayesOptionsOf(tuning);
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(path.resolve(__dirname, '..'), 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  const lines: string[] = [];
  for (let gi = 0; gi < games.length; gi++) {
    const d = games[gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    g.proposals.forEach((p, idx) => {
      if (p.round < 3) return;
      const qs = g.quests.filter((q) => q.round < p.round).map((q) => ({ round: q.round, teamSeats: q.teamSeats, failed: q.failed }));
      const cores = contaminatedSuccessTeams(qs);
      if (!cores.length) return;
      const core = cores[cores.length - 1];
      const sRound = qs.find((q) => !q.failed && q.teamSeats.length === core.length && q.teamSeats.every((s) => core.includes(s)))!.round;
      const fRound = qs.find((q) => q.failed && q.round > sRound && core.every((s) => q.teamSeats.includes(s)))!.round;
      const extra = qs.find((q) => q.round === fRound)!.teamSeats.filter((s) => !core.includes(s));
      // Decision makers: the leader (a loyal / Percival), or with --all-seats every loyal / Percival at this proposal's vote (first proposal of the round only).
      const seats = allSeats ? (p.attempt === 1 ? Array.from({ length: 10 }, (_, i) => i + 1) : []) : [p.leaderSeat];
      for (const seat of seats) {
        const role = g.seatRoles[seat - 1];
        if (role !== 'loyal' && role !== 'percival') continue;
        if (core.includes(seat) || extra.includes(seat)) continue;
        const obs0 = buildReplayObservation(g, seat, { kind: 'team_select', proposal: idx });
        const obs: PlayerObservation = { ...obs0, seatTeam: obs0.myTeam };
        const ids = core.map(seatId);
        const between = (v: PlayerObservation['voteHistory'][number]): boolean => v.round > sRound && v.round <= fRound && !v.approved && (v.attempt ?? 0) < 5;
        const variants: Record<string, [PlayerObservation, typeof opts]> = {
          full: [obs, opts],
          noCopies: [{ ...obs, voteHistory: obs.voteHistory.filter((v) => !between(v)) }, opts],
          missionsLake: [{ ...obs, voteHistory: [] }, opts],
          cd25: [obs, { ...opts, copyWeight55: 0.75 }],
          cd50: [obs, { ...opts, copyWeight55: 0.5 }],
          cd75: [obs, { ...opts, copyWeight55: 0.25 }],
          cd100: [obs, { ...opts, copyWeight55: 0 }],
          rep75: [obs, { ...opts, copyRepeatWeight55b: 0.25 }],
          rep100: [obs, { ...opts, copyRepeatWeight55b: 0 }],
          freq: [obs, { ...opts, copyFreq55b: true }],
          freqRep100: [obs, { ...opts, copyFreq55b: true, copyRepeatWeight55b: 0 }],
        };
        const pRed: Record<string, number | null> = {};
        const pExtra: Record<string, number | null> = {};
        for (const [k, [o, oo]] of Object.entries(variants)) {
          const c = bayesTeamClean(o, ids, oo);
          pRed[k] = c === null ? null : 1 - c;
          const share = bayesRedShare(o, oo);
          pExtra[k] = extra.length ? Math.max(...extra.map((s) => share.get(seatId(s)) ?? 0)) : null;
        }
        lines.push(JSON.stringify({ gi, round: p.round, attempt: p.attempt, seat, role, sRound, fRound, coreSize: core.length, pr: d.prs ? d.prs[seat - 1] : null,
          coreRed: core.some(red), extraRed: extra.some(red), pRed, pExtra }));
      }
    });
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${out}`);
}

main();
