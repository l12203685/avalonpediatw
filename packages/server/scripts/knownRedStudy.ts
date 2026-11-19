/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 54 回合（網站玩家回報 2026-11-19、站長「這種 bug 蠻嚴重的」）：梅林當隊長時隊上有他看得到的紅、好人一起照派失敗過的 3+1。
 * 真人局每一次「好人當隊長」的提議（梅林全部回合；忠臣／派西第 2 局起）輸出一列 JSON（`--out`，JSONL；沒有玩家名），
 * 交給 `knownRedStudy.py` 彙總。機器人只在兩種決策點重播（同一個座位、同一個角色，只看當時的資訊；`tailPickStudy` 的持續 agent 與種子）：
 *   - 梅林當隊長、第 2 局起；
 *   - 忠臣／派西當隊長、局面裡有「失敗過的照派」（成功隊 S 整隊在之後失敗的任務 F 裡，`knownRed54.contaminatedSuccessTeams`）。
 *
 * 每列：gi、round、attempt、forced、leader、role、pr、s、sitContaminated（局面有失敗過的照派）、sitSeenFailed（梅林：有看得到的紅出過失敗的任務）、
 *   human／bot：隊伍、`knownRedFeatures`、全好隊、隊上紅數；missionWent（人類的隊出任務）、missionOk、outcome（三紅／三藍死／三藍活）。
 *
 *   cd packages/server && npx tsx scripts/knownRedStudy.ts --out rows.jsonl [--flag name=v ...] [--no-bot] [--shard k/n]
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
import { contaminatedSuccessTeams, knownRedFeatures, type KnownRedQuest } from '../src/ai/benchmark/knownRed54';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

/** 一個座位的持續 agent 重播到 `targets` 裡最後一個提議為止，回傳每個目標提議機器人派的隊。 */
function botTeamsAt(game: ReplayGame, seat: number, targets: ReadonlySet<number>, tuning: AgentTuning): Map<number, number[]> {
  const id = seatId(seat);
  const agent = new HeuristicAgent(id, undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const act = (key: string, fn: () => ReturnType<HeuristicAgent['act']>): ReturnType<HeuristicAgent['act']> =>
    withSeededRandom(`${game.id}|${seat}|${key}`, fn);
  const last = Math.max(...targets);
  const out = new Map<number, number[]>();
  for (let i = 0; i <= last; i++) {
    const p = game.proposals[i];
    if (p.leaderSeat === seat) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: i });
      const a = act(`team-${i}`, () => agent.act(obs));
      if (targets.has(i)) out.set(i, a.type === 'team_select' ? a.teamIds.map(seatOfId) : []);
    }
    if (i < last && !p.forced && p.votesReliable) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i });
      act(`vote-${i}`, () => agent.act(obs));
    }
  }
  return out;
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const noBot = argv.includes('--no-bot');
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
    if (g.playerCount !== 10) continue;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const merlin = g.seatRoles.indexOf('merlin') + 1;
    const seen = new Set(g.seatRoles.flatMap((r, i) => (EVIL_ROLES.has(r) && r !== 'mordred' ? [i + 1] : [])));
    const fails = g.quests.filter((q) => q.failed).length;
    const succ = g.quests.length - fails;
    const outcome = fails >= 3 ? '三紅' : succ >= 3 ? (g.assassinTargetSeat === merlin ? '三藍死' : '三藍活') : '?';
    const questsBefore = (round: number): KnownRedQuest[] => g.quests.filter((q) => q.round < round).map((q) => ({ round: q.round, teamSeats: q.teamSeats, failed: q.failed }));
    type Point = { idx: number; role: string; sitContaminated: boolean; sitSeenFailed: boolean; bot: boolean };
    const points: Point[] = [];
    g.proposals.forEach((p, idx) => {
      const role = g.seatRoles[p.leaderSeat - 1];
      if (role !== 'merlin' && role !== 'loyal' && role !== 'percival') return;
      if (role !== 'merlin' && p.round < 2) return;
      const qs = questsBefore(p.round);
      const sitContaminated = contaminatedSuccessTeams(qs).length > 0;
      const sitSeenFailed = qs.some((q) => q.failed && q.teamSeats.some((s) => seen.has(s)));
      const bot = !noBot && ((role === 'merlin' && p.round >= 2) || (role !== 'merlin' && sitContaminated));
      points.push({ idx, role, sitContaminated, sitSeenFailed, bot });
    });
    const bySeat = new Map<number, Set<number>>();
    for (const pt of points) {
      if (!pt.bot) continue;
      const seat = g.proposals[pt.idx].leaderSeat;
      if (!bySeat.has(seat)) bySeat.set(seat, new Set());
      bySeat.get(seat)!.add(pt.idx);
    }
    const botTeams = new Map<number, number[]>();
    for (const [seat, targets] of bySeat) for (const [i, t] of botTeamsAt(g, seat, targets, tuning)) botTeams.set(i, t);
    for (const pt of points) {
      const p = g.proposals[pt.idx];
      const q = g.quests.find((x) => x.round === p.round);
      const qs = questsBefore(p.round);
      const desc = (team: readonly number[]): Record<string, unknown> => ({ team: [...team].sort((a, b) => a - b), allGood: !team.some(red), reds: team.filter(red).length, ...knownRedFeatures(team, qs, seen) });
      const bot = botTeams.get(pt.idx);
      n++;
      lines.push(JSON.stringify({
        gi, round: p.round, attempt: p.attempt, forced: p.forced, leader: p.leaderSeat, role: pt.role,
        pr: d.prs ? d.prs[p.leaderSeat - 1] : null, s: d.s,
        sitContaminated: pt.sitContaminated, sitSeenFailed: pt.sitSeenFailed,
        // 真相：失敗過的照派的成功隊 S 有沒有紅（S 不只一個時看最近的那一個）。
        coreRed: pt.sitContaminated ? contaminatedSuccessTeams(qs).slice(-1)[0].some(red) : null,
        human: desc(p.teamSeats), bot: bot && bot.length ? desc(bot) : null,
        missionWent: p.wentOnMission, missionOk: q && p.wentOnMission ? !q.failed : null, outcome,
      }));
    }
    if (gi % 200 === shardK) console.error(`game ${gi}: ${n} decision points`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${n} decision points → ${out}`);
}

main();
