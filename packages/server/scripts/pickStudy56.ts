/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 56 回合：真人局每一次忠臣／派西當隊長的提議（全部回合、全部第幾次），真人派的隊和機器人（現行預設與各個候選）在同一個決策點派的隊，
 * 用同一個評分者（現行預設的後驗，隊長自己的視角）打分數：
 *   （評分者不含 `ownView` 的個人先驗）F = 完整後驗說這隊沒有紅的機率、M = 只用規則＋任務結果＋湖＋自己視野的後驗（拿掉全部提議與票，`Round56.missionOnlyObs`）；
 *   F*、M* = 含自己、人數對的隊裡的最高；真相 allGood。
 * 每個決策點一列 JSON（`--out`，JSONL；沒有玩家名），交給 `pickStudy56.py` 彙總。
 *
 *   cd packages/server && npx tsx scripts/pickStudy56.ts --out rows.jsonl [--variant 標籤=k=v,k=v ...] [--rounds 1,2] [--shard k/n]
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { evilLakeHumanOptionsFromEnv, setEvilLakeHumanOptions } from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import { goodVouchOptionsFromEnv, setGoodVouchOptions } from '../src/ai/GoodLakeFollowUp';
import { setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { missionJointScores56 } from '../src/ai/Round56';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

/** The bot's team at proposal `target` (the same persistent agent and seeds as `tailPickStudy.botTeamAt`). */
function botTeamAt(game: ReplayGame, seat: number, target: number, tuning: AgentTuning): number[] {
  const id = seatId(seat);
  const agent = new HeuristicAgent(id, undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const act = (key: string, fn: () => ReturnType<HeuristicAgent['act']>): ReturnType<HeuristicAgent['act']> =>
    withSeededRandom(`${game.id}|${seat}|${key}`, fn);
  for (let i = 0; i <= target; i++) {
    const p = game.proposals[i];
    if (p.leaderSeat === seat) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: i });
      const a = act(`team-${i}`, () => agent.act(obs));
      if (i === target) return a.type === 'team_select' ? a.teamIds.map(seatOfId) : [];
    }
    if (i < target && !p.forced && p.votesReliable) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i });
      act(`vote-${i}`, () => agent.act(obs));
    }
  }
  return [];
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  const variants: [string, AgentTuning][] = [['DEF', resolveAgentTuning({})]];
  for (const v of args('--variant')) {
    const [label, spec] = [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)];
    variants.push([label, resolveAgentTuning(Object.assign({}, ...spec.split(',').map(parseTuningFlag)))]);
  }
  // 評分者：現行預設的後驗，但不加第 38 回合 `ownView` 的個人先驗（它照「這次提議會不會出任務」加權，第 1、2 局幾乎全重、強制局 0）。
  const EVAL = resolveAgentTuning({ ownView: 0, ownViewKeep: 0 });
  const rounds = new Set((arg('--rounds') ?? '1,2,3,4,5').split(',').map(Number));
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  const lines: string[] = [];
  let n = 0;
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    g.proposals.forEach((p, idx) => {
      if (!rounds.has(p.round)) return;
      const role = g.seatRoles[p.leaderSeat - 1];
      if (role !== 'loyal' && role !== 'percival') return;
      if (!p.teamSeats.includes(p.leaderSeat)) return; // 評分只看含自己的隊
      const obs = { ...buildReplayObservation(g, p.leaderSeat, { kind: 'team_select', proposal: idx }), seatTeam: 'good' as const };
      const scores = missionJointScores56(EVAL, obs, p.teamSeats.length);
      if (!scores) return;
      const key = (t: readonly number[]): string => [...t].sort((a, b) => a - b).join(',');
      const byKey = new Map(scores.map((s) => [key(s.team.map(seatOfId)), s] as const));
      const fBest = Math.max(...scores.map((s) => s.f));
      const mBest = Math.max(...scores.map((s) => s.m));
      const topClean = (pick: (s: typeof scores[number]) => number, best: number): number => {
        const top = scores.filter((s) => pick(s) >= best - 1e-9);
        return r3(top.filter((s) => !s.team.map(seatOfId).some(red)).length / top.length);
      };
      const evalTeam = (t: readonly number[]): { team: string; allGood: boolean; f: number; m: number } | null => {
        const s = byKey.get(key(t));
        return s ? { team: key(t), allGood: !t.some(red), f: r3(s.f), m: r3(s.m) } : null;
      };
      const bots: Record<string, ReturnType<typeof evalTeam>> = {};
      for (const [label, tuning] of variants) bots[label] = evalTeam(botTeamAt(g, p.leaderSeat, idx, tuning));
      n++;
      lines.push(JSON.stringify({
        gi, round: p.round, attempt: p.attempt, forced: p.forced, role, leader: p.leaderSeat,
        pr: d.prs ? d.prs[p.leaderSeat - 1] : null, s: d.s, fails: g.quests.filter((q) => q.round < p.round && q.failed).length,
        fBest: r3(fBest), mBest: r3(mBest), fTopClean: topClean((s) => s.f, fBest), mTopClean: topClean((s) => s.m, mBest),
        human: evalTeam(p.teamSeats), bots,
      }));
      if (n % 200 === 0) console.error(`${n} decision points`);
    });
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${n} decision points → ${out}`);
}

main();
