/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 62 回合（藍方：1-5 與 2-5 的尾派；第 60 回合的兩個最大決策點）：
 * 真人局第 1、2 局強制局（第 5 次提議）由藍方（忠臣／派西／梅林）當隊長的每一個決策點，
 * 機器人在同一個座位、同一份公開紀錄下派什麼隊——一次跑好幾個版本（基準線 A、真人桌策略層 H、候選開關）。
 *
 * 每個決策點一列 JSON（`--out`，JSONL；只有座位、角色、隊伍，沒有玩家名），交給 `tailSpot62.py`，
 * 和 `keySpotStudy.ts --export-human` 的整局資料（同一個 gi）合起來算：
 *   gi、idx（提議序號）、round、leader、role、s（桌上強度）、pr（隊長開打前 PR）、
 *   human（真人的隊）、teams：{版本標籤: 機器人的隊}、pc：{版本標籤: 基準線後驗說「這隊沒紅」的機率}（真人的隊在 'human'）、
 *   redA／redH：每個座位的紅機率（基準線／真人桌策略層的後驗；隊長自己是 null）、f62：第 62 回合公開讀法的特徵（2-5、第 1 局失敗）。
 *
 *   cd packages/server && npx tsx scripts/tailSpot62.ts --out rows.jsonl [--shard k/n]
 *     [--variant 標籤:開關=值,開關=值 ...]   （預設：A = 基準線、H = 照桌上 S 的真人桌策略層）
 *   `--w62 even.json,odd.json`：`tailRead62` 交叉驗證（奇數局用偶數局擬合的權重，反之亦然）。
 *   版本裡寫 `@profile` = 在照桌上 S 的真人桌策略層上再加開關（例：`H62:@profile,tailR1Avoid62=1`）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { getDefaultAgentTuning, parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { evilLakeHumanOptionsFromEnv, setEvilLakeHumanOptions } from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import { goodVouchOptionsFromEnv, setGoodVouchOptions } from '../src/ai/GoodLakeFollowUp';
import { setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from '../src/ai/benchmark/replayObservation';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from '../src/ai/belief/BayesBelief';
import { opponentTypeOfTable, tuningForOpponent } from '../src/ai/humanProfile';
import { FEATURES_62, setTailRead62Weights, tailRead62Features, type SeatFeatures62 } from '../src/ai/Round62';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

const BLUE = new Set(['loyal', 'percival', 'merlin']);
/** 排除的局：網站標成壞局或事故（同 `keySpotStudy.ts`）。 */
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);

interface Variant { label: string; profile: boolean; flags: Partial<AgentTuning> }

function parseVariant(raw: string): Variant {
  const [label, rest = ''] = raw.split(':');
  const parts = rest.split(',').filter(Boolean);
  const profile = parts.includes('@profile');
  const flags = Object.assign({}, ...parts.filter((p) => p !== '@profile').map(parseTuningFlag)) as Partial<AgentTuning>;
  return { label, profile, flags };
}

/** 機器人在 `target` 派的隊：同 `tailPickStudy.botTeamAt`（持續的 agent、同一組種子，只重播到這個決策點）。 */
function botTeamAt(game: ReplayGame, seat: number, target: number, tuning: AgentTuning): number[] {
  const agent = new HeuristicAgent(seatId(seat), undefined, undefined, tuning);
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const act = (key: string, fn: () => ReturnType<HeuristicAgent['act']>): ReturnType<HeuristicAgent['act']> =>
    withSeededRandom(`${game.id}|${seat}|${key}`, fn);
  for (let i = 0; i <= target; i++) {
    const p = game.proposals[i];
    if (p.leaderSeat === seat) {
      const obs = buildReplayObservation(game, seat, { kind: 'team_select', proposal: i });
      const a = act(`team-${i}`, () => agent.act(obs));
      if (i === target) return a.type === 'team_select' ? a.teamIds.map(seatOfId).sort((x, y) => x - y) : [];
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
  const raws = args('--variant');
  const variants = (raws.length ? raws : ['A:', 'H:@profile']).map(parseVariant);
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  // `--w62 even.json,odd.json`：交叉驗證——奇數局用偶數局擬合的權重、偶數局用奇數局擬合的權重（`tailRead62` 的版本才有差）。
  const w62 = arg('--w62')?.split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as SeatFeatures62) ?? null;
  const base = resolveAgentTuning({});
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games } = replayGamesFromDataset(raw);
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const lines: string[] = [];
  for (let gi = shardK; gi < games.length; gi += shardN) {
    const d = games[gi];
    if (d.noteTags.some((t) => EXCLUDED_TAGS.has(t))) continue;
    const g = d.game;
    const prof = tuningForOpponent(opponentTypeOfTable({ humans: 10, tableS: d.s }), getDefaultAgentTuning());
    if (w62) setTailRead62Weights(gi % 2 === 1 ? w62[0] : w62[1]);
    g.proposals.forEach((p, idx) => {
      if (!p.forced || p.round > 2) return;
      const role = String(g.seatRoles[p.leaderSeat - 1]);
      if (!BLUE.has(role)) return;
      const obs = buildReplayObservation(g, p.leaderSeat, { kind: 'team_select', proposal: idx });
      const pClean = (team: readonly number[]): number | null =>
        team.length ? bayesTeamClean({ ...obs, seatTeam: obs.myTeam }, team.map(seatId), bayesOptionsOf(base)) : null;
      const human = [...p.teamSeats].sort((x, y) => x - y);
      const teams: Record<string, number[]> = {};
      const pc: Record<string, number | null> = { human: pClean(human) };
      for (const v of variants) {
        const tuning = resolveAgentTuning({ ...(v.profile ? prof : {}), ...v.flags });
        teams[v.label] = botTeamAt(g, p.leaderSeat, idx, tuning);
        pc[v.label] = pClean(teams[v.label]);
      }
      // 每個座位的紅機率（基準線 A 與真人桌策略層 H 的後驗；殘差擬合用）
      const share = (t: AgentTuning): (number | null)[] => {
        const m = bayesRedShare({ ...obs, seatTeam: obs.myTeam }, bayesOptionsOf(t));
        return Array.from({ length: 10 }, (_, i) => (i + 1 === p.leaderSeat ? null : m.get(seatId(i + 1)) ?? null));
      };
      lines.push(JSON.stringify({
        gi, idx, round: p.round, leader: p.leaderSeat, role, s: d.s,
        pr: d.prs ? d.prs[p.leaderSeat - 1] : null, human, teams, pc,
        redA: share(base), redH: share(resolveAgentTuning(prof)),
        // 第 62 回合的公開讀法（`Round62.tailRead62Features`；只在 2-5、第 1 局失敗時）：座位 → 特徵（FEATURES_62 的順序）
        f62: p.round === 2 && g.quests[0]?.failed
          ? Object.fromEntries([...tailRead62Features(obs)].map(([id, f]) => [seatOfId(id), FEATURES_62.map((k) => f[k])]))
          : null,
      }));
    });
    if (lines.length && gi % 200 < shardN) console.error(`game ${gi}: ${lines.length} decision points`);
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} decision points → ${out}`);
}

main();
