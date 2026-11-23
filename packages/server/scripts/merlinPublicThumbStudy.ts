/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 58 回合（站長 2026-11-20：梅林「要從公開資訊中找到符合自己內建資訊 盡可能避開三個可見紅方拇指…除非逼不得已…只能依據忠臣資訊去派拇指」）：
 * 真人局每一次梅林當隊長的提議輸出一列 JSON（`--out`，JSONL；沒有玩家名），機器人梅林在同一個決策點（同一個座位、只看當時的資訊；
 * `knownRedStudy` 的持續 agent 與種子）用每一組設定各派一次。交給 `merlinPublicThumbStudy.py` 彙總。
 *
 * 每列：gi、round、attempt、forced、pr（梅林的 PR）、s（桌上強度）、human／每一組 `--variant` 的隊：隊伍、看得到的紅數（拇指）、全好隊。
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/merlinPublicThumbStudy.ts --out rows.jsonl \
 *     --variant BASE: --variant P5:merlinPublicThumb58=0.5 [--shard k/n]
 * （`--variant 標籤:開關1,開關2`；開關 = `--flag` 的 name=v；空的 = 現行預設）
 *
 * 第 64 回合加：`--roles loyal,percival`（預設 merlin）＝改看這些角色當隊長的提議（每列多 role、seat；拇指 = 梅林看得到的紅，扣掉莫德雷德）；
 * `--max-round N`＝只看第 N 局以前的提議（第 1、2 局 = 2；重播到最後一個目標就停，省時間）；`--non-forced`＝只看第 1–4 次提議。
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
import { round58Stats } from '../src/ai/Round58';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));

/** 一個座位的持續 agent 重播到 `targets` 裡最後一個提議為止，回傳每個目標提議機器人派的隊（同 `knownRedStudy`）。 */
function botTeamsAt(game: ReplayGame, seat: number, targets: ReadonlySet<number>, tuning: AgentTuning): Map<number, { team: number[]; fallback: boolean }> {
  const id = seatId(seat);
  const agent = new HeuristicAgent(id, undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const act = (key: string, fn: () => ReturnType<HeuristicAgent['act']>): ReturnType<HeuristicAgent['act']> =>
    withSeededRandom(`${game.id}|${seat}|${key}`, fn);
  const last = Math.max(...targets);
  const out = new Map<number, { team: number[]; fallback: boolean }>();
  for (let i = 0; i <= last; i++) {
    const p = game.proposals[i];
    if (p.leaderSeat === seat) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: i });
      const before = round58Stats.fallback;
      const a = act(`team-${i}`, () => agent.act(obs));
      if (targets.has(i)) out.set(i, { team: a.type === 'team_select' ? a.teamIds.map(seatOfId) : [], fallback: round58Stats.fallback > before });
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
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  const variants = args('--variant').map((v) => {
    const k = v.indexOf(':');
    const label = k >= 0 ? v.slice(0, k) : v;
    const flags = k >= 0 ? v.slice(k + 1).split(',').filter((x) => x.length > 0) : [];
    return { label, tuning: resolveAgentTuning(Object.assign({}, ...flags.map(parseTuningFlag))) };
  });
  if (variants.length === 0) throw new Error('--variant LABEL:flags (at least one)');
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  const roles = (arg('--roles') ?? 'merlin').split(',').filter(Boolean);
  const maxRound = Number(arg('--max-round') ?? 99);
  const nonForced = argv.includes('--non-forced');
  const lines: string[] = [];
  let n = 0;
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    const g = d.game;
    if (g.playerCount !== 10) continue;
    const red = (s: number): boolean => EVIL_ROLES.has(g.seatRoles[s - 1]);
    const seen = new Set(g.seatRoles.flatMap((r, i) => (EVIL_ROLES.has(r) && r !== 'mordred' ? [i + 1] : [])));
    const merlin = g.seatRoles.indexOf('merlin') + 1;
    const fails = g.quests.filter((q) => q.failed).length;
    const succ = g.quests.length - fails;
    const outcome = fails >= 3 ? '三紅' : succ >= 3 ? (g.assassinTargetSeat === merlin ? '三藍死' : '三藍活') : '?';
    const desc = (team: readonly number[]): Record<string, unknown> => ({ team: [...team].sort((a, b) => a - b), thumbs: team.filter((s) => seen.has(s)).length, allGood: !team.some(red) });
    for (let leader = 1; leader <= g.playerCount; leader++) {
      const role = g.seatRoles[leader - 1];
      if (!roles.includes(role)) continue;
      const targets = new Set<number>();
      g.proposals.forEach((p, idx) => { if (p.leaderSeat === leader && p.round <= maxRound && !(nonForced && p.forced)) targets.add(idx); });
      if (targets.size === 0) continue;
      const bot = variants.map((v) => botTeamsAt(g, leader, targets, v.tuning));
      for (const idx of targets) {
        const p = g.proposals[idx];
        const row: Record<string, unknown> = {
          gi, role, seat: leader, round: p.round, attempt: p.attempt, forced: p.forced, pr: d.prs ? d.prs[leader - 1] : null, s: d.s,
          went: p.wentOnMission, outcome, human: desc(p.teamSeats),
        };
        variants.forEach((v, k) => {
          const b = bot[k].get(idx);
          row[v.label] = b && b.team.length ? { ...desc(b.team), fb: b.fallback } : null;
        });
        lines.push(JSON.stringify(row));
        n++;
      }
    }
    if (gi % 200 === shardK) console.error(`game ${gi}: ${n} decision points`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${n} decision points → ${out}`);
}

main();
