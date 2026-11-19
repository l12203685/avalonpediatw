/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 52 回合（站長 11/19「訓練的重點可以先放在 1-5 跟 2-5 的尾派上 看強者忠臣還有派西 在 1-5 跟 2-5(第一局開紅/藍 分開看) 會怎麼派」）：
 * 真人局第 1、2 局強制局（第 5 次提議）的派隊，忠臣／派西當隊長時派了什麼隊；同一個決策點機器人（現行預設或 --flag）派什麼隊。
 *
 * 每個決策點輸出一列 JSON（`--out`，JSONL；沒有玩家名），交給 `tailPickStudy.py` 彙總：
 *   gi、round、r1Failed（第 2 局：第 1 局任務失敗）、leader、role、pr（隊長座位開打前的 PR）、s（桌上強度）、
 *   human／bot：隊伍與特徵（`tailPickFeatures`）、隊長自己的後驗說這隊沒有紅的機率（pClean）、真相（allGood = 隊上沒有紅、reds、merlinIn／morganaIn）；
 *   人類的那一隊實際出任務：missionOk、outcome（三紅／三藍死／三藍活）。
 *
 *   cd packages/server && npx tsx scripts/tailPickStudy.ts --out rows.jsonl [--flag name=v ...] [--no-bot] [--roles loyal,percival] [--shard k/n] [--all-attempts]
 *   （第 53 回合 `--all-attempts`：第 1、2 局的每一次提議都算，不只強制局；多記 attempt、forced。）
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
import { tailPickFeatures } from '../src/ai/benchmark/tailPick';
import { bayesOptionsOf, bayesTeamClean } from '../src/ai/belief/BayesBelief';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

/**
 * 機器人在 `target`（隊長 = seat 的提議）派的隊：和 `agreement.replaySeat` 同一個持續的 agent、同一組種子，
 * 只重播到這個決策點為止（之前這個座位當隊長的派隊、可信的投票）。
 */
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
  const roles = new Set((arg('--roles') ?? 'loyal,percival').split(','));
  const noBot = argv.includes('--no-bot');
  const allAttempts = argv.includes('--all-attempts');
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)));
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  const lines: string[] = [];
  let n = 0;
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    const g = d.game;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const merlin = g.seatRoles.indexOf('merlin') + 1;
    const morgana = g.seatRoles.indexOf('morgana') + 1;
    // 真相（只用來打分數）：隊上紅數、梅林／莫甘娜（派西的兩根拇指）在不在隊上。
    const truth = (team: readonly number[]): { team: readonly number[]; allGood: boolean; reds: number; merlinIn: boolean; morganaIn: boolean } => ({
      team, allGood: !team.some(red), reds: team.filter(red).length, merlinIn: team.includes(merlin), morganaIn: team.includes(morgana),
    });
    const fails = g.quests.filter((q) => q.failed).length;
    const succ = g.quests.length - fails;
    const outcome = fails >= 3 ? '三紅' : succ >= 3 ? (g.assassinTargetSeat === merlin ? '三藍死' : '三藍活') : '?';
    g.proposals.forEach((p, idx) => {
      if ((!p.forced && !allAttempts) || p.round > 2) return;
      const role = g.seatRoles[p.leaderSeat - 1];
      if (!roles.has(role)) return;
      const q = g.quests.find((x) => x.round === p.round);
      const bot = noBot ? null : botTeamAt(g, p.leaderSeat, idx, tuning);
      // 隊長自己的後驗（同 `goodCleanLead`：bayesOptionsOf(tuning)）說這隊沒有紅的機率——機器人的派隊模型準不準。
      const obs = buildReplayObservation(g, p.leaderSeat, { kind: 'team_select', proposal: idx });
      const pClean = (team: readonly number[]): number | null => bayesTeamClean({ ...obs, seatTeam: obs.myTeam }, team.map(seatId), bayesOptionsOf(tuning));
      n++;
      lines.push(JSON.stringify({
        gi,
        round: p.round,
        attempt: p.attempt,
        forced: p.forced,
        r1Failed: p.round === 2 ? g.quests.find((x) => x.round === 1)?.failed ?? null : null,
        leader: p.leaderSeat,
        role,
        pr: d.prs ? d.prs[p.leaderSeat - 1] : null,
        prov: d.prov ? d.prov[p.leaderSeat - 1] : null,
        s: d.s,
        human: { ...truth(p.teamSeats), pClean: pClean(p.teamSeats), ...tailPickFeatures(g, idx, p.teamSeats) },
        bot: bot && bot.length ? { ...truth(bot), pClean: pClean(bot), ...tailPickFeatures(g, idx, bot) } : null,
        missionOk: q ? !q.failed : null,
        outcome,
      }));
      if (n % 100 === 0) console.error(`${n} decision points`);
    });
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${n} decision points → ${out}`);
}

main();
