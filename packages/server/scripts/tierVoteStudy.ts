/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 57 回合（站長 2026-11-20「對上 AI/弱真人/一般真人/強真人 你都可能會需要做調整 但不會過度」）：
 * 真人桌讀法的兩個「決策」量——`humanProfileStudy.ts` 量的是信念（Brier），這裡量會改到決定的部分，分強度層：
 *
 *   cd packages/server && npx tsx scripts/tierVoteStudy.ts [--split train|test|all] [--shard k/n] [--raw out.json] [--profile 開關=值,…] [--delta 0,0.05,0.1]
 *   cd packages/server && npx tsx scripts/tierVoteStudy.ts --merge a.json b.json …
 *
 * (a) 忠臣的「還會當隊長 → 內黑」門檻位移 `leaderOppVote51Delta`（第 51 回合 L1，預設 δ 0.05）：真人局每個忠臣座位、第 3–5 局、非強制、
 *     不是隊長、自己在隊上的投票點，用 `BlueRound33.bayesVoteCriteria`（真人桌讀法 `--profile`＋各個 δ）算機器人的票。
 *     δ 只在「P(隊上的紅夠讓任務失敗) 落在 [門檻 − δ, 門檻)」的點改變票（贊成 → 內黑），所以只看這些「換票點」：
 *     隊上真的有足夠的紅（內黑才對）的比例、那位真人自己內黑的比例、座位 PR ≥ 70 的真人內黑的比例。換票點裡隊上有紅 > 50% → 換得對的多。
 * (b) 刺殺：真人局每一次刺殺（三藍之後），刺客座位用 `HeuristicAgent.assassinationReadout`（前排裡分數最高的）挑，比較基準線與真人桌讀法
 *     的刺中率；真人桌讀法只動藍方座位的信念，刺殺應該完全相同（量來確認）。
 *
 * 只輸出彙總（沒有名字、沒有局號）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesVoteCriteria } from '../src/ai/BlueRound33';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset, type DatasetReplayGame } from '../src/ai/benchmark/datasetReplay';
import { strengthTierOfS } from '../src/ai/humanProfile';
import { isAssassinator } from '../src/game/assassinator';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';
import { AVALON_CONFIG } from '@avalon/shared';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const STRONG_PR = 70;

function tuningOf(spec: string | undefined): AgentTuning {
  const t: AgentTuning = { ...DEFAULT_AGENT_TUNING };
  for (const f of (spec ?? '').split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
  return t;
}

/** key = 強度層|δ → 計數 */
interface VoteCell { flips: number; flipRed: number; flipHumanReject: number; flipStrong: number; flipStrongReject: number; points: number; correct: number }
interface AsnCell { n: number; hitBase: number; hitProfile: number; same: number; human: number }
interface Store { vote: Record<string, VoteCell>; asn: Record<string, AsnCell>; games: number; deltas: number[]; profile: string }

const newVote = (): VoteCell => ({ flips: 0, flipRed: 0, flipHumanReject: 0, flipStrong: 0, flipStrongReject: 0, points: 0, correct: 0 });

function evalGame(g: DatasetReplayGame, tier: string, prof: AgentTuning, deltas: readonly number[], st: Store): void {
  const game: ReplayGame = g.game;
  const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
  const fails = (round: number): number => AVALON_CONFIG[game.playerCount]?.questFailsRequired?.[round - 1] ?? 1;
  const tunings = deltas.map((d) => (d > 0 ? { ...prof, leaderOppVote51: prof.leaderOppVote51 || 1, leaderOppVote51Delta: d } : { ...prof, leaderOppVote51: 0 }));
  for (let seat = 1; seat <= game.playerCount; seat++) {
    if (game.seatRoles[seat - 1] !== 'loyal') continue;
    game.proposals.forEach((p, i) => {
      if (p.forced || p.round < 3 || p.leaderSeat === seat || !p.teamSeats.includes(seat)) return;
      const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
      const verdicts = tunings.map((t) => bayesVoteCriteria(t, obs));
      if (verdicts.some((v) => v === null)) return;
      const reds = p.teamSeats.filter(red).length;
      const shouldReject = reds >= fails(p.round);
      const humanReject = !p.votes[seat - 1];
      const pr = g.prs?.[seat - 1] ?? null;
      const strong = pr !== null && !(g.prov?.[seat - 1] ?? false) && pr >= STRONG_PR;
      deltas.forEach((d, di) => {
        const c = (st.vote[`${tier}|${d}`] ??= newVote());
        c.points += 1;
        const rej = verdicts[di]!.vote === false;
        if (rej === shouldReject) c.correct += 1;
        if (di === 0) return;
        if (verdicts[0]!.vote === true && rej) {
          c.flips += 1;
          if (shouldReject) c.flipRed += 1;
          if (humanReject) c.flipHumanReject += 1;
          if (strong) { c.flipStrong += 1; if (humanReject) c.flipStrongReject += 1; }
        }
      });
    });
  }
  // (b) 刺殺
  const target = game.assassinTargetSeat;
  if (target) {
    const aSeat = game.seatRoles.findIndex((r) => isAssassinator(r, game.seatRoles)) + 1;
    if (aSeat > 0) {
      const obs = hideLobbyOrder(buildReplayObservation(game, aSeat, { kind: 'assassination' }));
      const pickOf = (t: AgentTuning): string | null => {
        const r = new HeuristicAgent(seatId(aSeat), undefined, undefined, t).assassinationReadout(obs);
        if (!r || !r.front.length) return null;
        return [...r.front].sort((a, b) => (r.scores.get(b) ?? -Infinity) - (r.scores.get(a) ?? -Infinity))[0];
      };
      const merlin = seatId(game.seatRoles.indexOf('merlin') + 1);
      const b = pickOf(DEFAULT_AGENT_TUNING);
      const q = pickOf(prof);
      if (b !== null && q !== null) {
        const c = (st.asn[tier] ??= { n: 0, hitBase: 0, hitProfile: 0, same: 0, human: 0 });
        c.n += 1;
        if (b === merlin) c.hitBase += 1;
        if (q === merlin) c.hitProfile += 1;
        if (b === q) c.same += 1;
        if (seatId(target) === merlin) c.human += 1;
      }
    }
  }
  st.games += 1;
}

const pct = (k: number, n: number): string => (n ? `${((100 * k) / n).toFixed(1)}%` : '—');

function report(st: Store): string {
  const L: string[] = ['# 真人桌讀法的決策量（分強度層）', '', `- ${st.games} 局；讀法 = 預設＋${st.profile || '（無）'}；δ = ${st.deltas.join('／')}（第一個是對照）。`, ''];
  L.push('## (a) 忠臣在隊上、還會當隊長的內黑門檻位移', '');
  L.push('| 強度層 | δ | 投票點 | 票對（隊上有紅 ⇔ 內黑） | 換票點（贊成 → 內黑） | 換票點裡隊上真的有紅 | 那位真人也內黑 | 強者（PR ≥ 70）換票點 | 強者也內黑 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  const tiers = ['weak', 'avg', 'strong', 'unknown', 'all'];
  for (const t of tiers) {
    for (const d of st.deltas) {
      const cells = Object.entries(st.vote).filter(([k]) => { const [tt, dd] = k.split('|'); return (t === 'all' || tt === t) && Number(dd) === d; }).map(([, c]) => c);
      if (!cells.length) continue;
      const c = cells.reduce((a, b) => ({
        flips: a.flips + b.flips, flipRed: a.flipRed + b.flipRed, flipHumanReject: a.flipHumanReject + b.flipHumanReject, flipStrong: a.flipStrong + b.flipStrong,
        flipStrongReject: a.flipStrongReject + b.flipStrongReject, points: a.points + b.points, correct: a.correct + b.correct,
      }), newVote());
      L.push(`| ${t} | ${d} | ${c.points} | ${pct(c.correct, c.points)} | ${d === st.deltas[0] ? '—' : c.flips} | ${d === st.deltas[0] ? '—' : pct(c.flipRed, c.flips)} | ${d === st.deltas[0] ? '—' : pct(c.flipHumanReject, c.flips)} | ${d === st.deltas[0] ? '—' : c.flipStrong} | ${d === st.deltas[0] ? '—' : pct(c.flipStrongReject, c.flipStrong)} |`);
    }
  }
  L.push('', '## (b) 刺殺（刺客座位，前排裡分數最高的）', '');
  L.push('| 強度層 | 刺殺數 | 真人刺中 | 基準線刺中 | 真人桌讀法刺中 | 兩者挑同一人 |');
  L.push('|---|---|---|---|---|---|');
  for (const t of tiers) {
    const cells = Object.entries(st.asn).filter(([k]) => t === 'all' || k === t).map(([, c]) => c);
    if (!cells.length) continue;
    const c = cells.reduce((a, b) => ({ n: a.n + b.n, hitBase: a.hitBase + b.hitBase, hitProfile: a.hitProfile + b.hitProfile, same: a.same + b.same, human: a.human + b.human }), { n: 0, hitBase: 0, hitProfile: 0, same: 0, human: 0 });
    L.push(`| ${t} | ${c.n} | ${pct(c.human, c.n)} | ${pct(c.hitBase, c.n)} | ${pct(c.hitProfile, c.n)} | ${pct(c.same, c.n)} |`);
  }
  return L.join('\n');
}

function main(): void {
  const st: Store = { vote: {}, asn: {}, games: 0, deltas: [], profile: '' };
  const mergeAt = argv.indexOf('--merge');
  if (mergeAt >= 0) {
    for (const f of argv.slice(mergeAt + 1).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Store;
      for (const [k, c] of Object.entries(j.vote)) {
        const o = (st.vote[k] ??= newVote());
        for (const kk of Object.keys(o) as (keyof VoteCell)[]) o[kk] += c[kk];
      }
      for (const [k, c] of Object.entries(j.asn)) {
        const o = (st.asn[k] ??= { n: 0, hitBase: 0, hitProfile: 0, same: 0, human: 0 });
        for (const kk of Object.keys(o) as (keyof AsnCell)[]) o[kk] += c[kk];
      }
      st.games += j.games;
      st.deltas = j.deltas;
      st.profile = j.profile;
    }
  } else {
    st.profile = arg('--profile') ?? 'copyDiscount55=0.75,viewpoint53=0,viewpointPow53=0';
    st.deltas = (arg('--delta') ?? '0,0.05,0.1').split(',').map(Number);
    const prof = tuningOf(st.profile);
    const file = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
    const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(file, 'utf8'))).games.filter((g) => g.game.playerCount === 10);
    const split = arg('--split') ?? 'all';
    const keep = (gi: number): boolean => (split === 'train' ? gi % 2 === 0 : split === 'test' ? gi % 2 === 1 : true);
    const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
    let kept = -1;
    games.forEach((g, gi) => {
      if (!keep(gi)) return;
      kept += 1;
      if (kept % n !== k) return;
      evalGame(g, g.s === null ? 'unknown' : strengthTierOfS(g.s), prof, st.deltas, st);
    });
    const raw = arg('--raw');
    if (raw) fs.writeFileSync(raw, JSON.stringify(st));
  }
  console.log(report(st));
}

if (require.main === module) main();
