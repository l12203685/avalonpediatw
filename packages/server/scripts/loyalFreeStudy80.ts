/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 80 回合（藍方・梅林；站長 11/25「梅林學忠臣的意思是 在忠臣資訊視角內 可以派出的全沒拇指組合 但如果只用忠臣資訊一定會派到拇指 那當然還是用能力避開」）：
 * 「忠臣說得通的隊」量多大、裡面有沒有不帶拇指的隊。每一次藍方座位（梅林、忠臣、派西）當隊長的提議輸出一列 JSON（`--out`，JSONL；沒有玩家名）：
 * 在隊長的座位、只看公開紀錄（`Round80.loyalFree80Set`，和梅林挑隊同一個分數）算每一支含隊長的隊的「這隊沒有紅」機率；
 * 拇指 = 梅林看得到的紅（刺客、莫甘娜、奧伯倫）。交給 `loyalFreeStudy80.py` 彙總。
 *
 * 每列：src、gi、role、round、attempt、forced、went、s（桌上強度）、size、n（候選隊數）、
 *   k[r]（說得通的隊數）、c[r]（其中不帶拇指的隊數）、ratio（實際派的隊的公開機率 ÷ 最高；隊上沒有隊長時 null，self = 隊上有沒有隊長）、thumbs（實際派的隊帶幾根拇指）、
 *   bestClean（不帶拇指的隊裡最高的公開機率 ÷ 最高：≥ r 就表示倍數 r 之下有乾淨的隊說得通）。
 *
 *   cd packages/server && npx tsx scripts/loyalFreeStudy80.ts --out h80.jsonl [--profile avgHuman] [--shard k/n]          # 真人局（games_cache.json）
 *   npx tsx scripts/loyalFreeStudy80.ts --bot b.jsonl --out b80.jsonl [--max-games 3000] [--shard k/n]                     # 自我對打（keySpotStudy --export-bot 的格式）
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, type AgentTuning } from '../src/ai/AgentTuning';
import { tuningForOpponent, type OpponentType } from '../src/ai/humanProfile';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from '../src/ai/benchmark/sheetsReplay';
import { loyalFree80Set } from '../src/ai/Round80';
import { anyGate, certaintyFor, gateOptionsFrom, teamGateBreach } from '../src/ai/LogicGates';
import type { PlayerObservation } from '../src/ai/types';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

export const RATIOS = [1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05];
const EVIL = new Set(['assassin', 'morgana', 'mordred', 'oberon', 'minion']);

interface NormGame {
  gi: number; s: number | null; roles: string[];
  props: [number, number, number, number[], number[] | null, boolean, boolean][];
  quests: [number, number[], number][];
  lakes: [number, number, number, string][];
  at: number | null; out: string;
}

/** keySpotStudy 的共同格式 → ReplayGame（票不可靠的提議 votesReliable = false）。 */
function toReplay(n: NormGame): ReplayGame {
  const proposals: ReplayProposal[] = n.props.map(([round, attempt, leader, team, appr, forced, went], g) => {
    const votes = Array.from({ length: 10 }, (_, k) => (appr ? appr.includes(k + 1) : false));
    return {
      round, attempt, globalIndex: g, leaderSeat: leader, teamSeats: team,
      plusSeats: appr ? appr.filter((s) => !team.includes(s)) : [], minusSeats: appr ? team.filter((s) => !appr.includes(s)) : [],
      votes, approveCount: votes.filter(Boolean).length, forced, wentOnMission: went, votesReliable: appr !== null,
    } as ReplayProposal;
  });
  const quests = n.quests.map(([round, team, fails]) => ({ round, teamSeats: team, successCount: team.length - fails, failCount: fails, failed: fails >= (round === 4 ? 2 : 1) }));
  const lakes = n.lakes.map(([round, holder, target, claim]) => ({ round, holderSeat: holder, targetSeat: target, claim: claim === 'o' ? 'good' : claim === 'x' ? 'evil' : null }));
  return {
    id: `b${n.gi}`, playerCount: 10, seatRoles: n.roles, names: Array(10).fill(''), proposals, quests, lakes, lakeChainValid: true,
    assassinTargetSeat: n.at ?? undefined, winner: n.out === 'red3' || n.out === 'blueDead' ? 'evil' : 'good',
  } as unknown as ReplayGame;
}

function rowsOf(src: string, gi: number, s: number | null, g: ReplayGame, tuning: AgentTuning): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = g.seatRoles.flatMap((r, i) => (EVIL.has(r) && r !== 'mordred' ? [seatId(i + 1)] : []));
  const gates = gateOptionsFrom(tuning);
  g.proposals.forEach((p, idx) => {
    const role = g.seatRoles[p.leaderSeat - 1];
    if (role !== 'merlin' && role !== 'loyal' && role !== 'percival') return;
    const obs0 = buildReplayObservation(g, p.leaderSeat, { kind: 'team_select', proposal: idx });
    // 拇指照梅林看得到的紅算；說得通的範圍只用公開紀錄（`merlinPublicScoring` 會拿掉私人資訊）。
    const obs = { ...obs0, myRole: 'merlin', knownEvils: seen } as PlayerObservation;
    const pubObs = { ...obs0, myRole: 'loyal', knownEvils: [], knownWizards: undefined, myLakeResults: [] } as PlayerObservation;
    const publicOk = (team: readonly string[]): boolean => !anyGate(gates) || teamGateBreach(pubObs, certaintyFor(pubObs), team, p.round, gates) === null;
    const set = loyalFree80Set(tuning, obs, p.teamSeats.length, 1, publicOk, []);
    if (!set || !(set.top > 0)) return;
    const ok = set.teams.filter((t) => t.publicOk);
    const k: number[] = [];
    const c: number[] = [];
    for (const r of RATIOS) {
      const pl = ok.filter((t) => t.p >= r * set.top - 1e-12);
      k.push(pl.length);
      c.push(pl.filter((t) => t.thumbs === 0).length);
    }
    const key = p.teamSeats.map(seatId).sort().join(',');
    const self = p.teamSeats.includes(p.leaderSeat);
    const mine = set.teams.find((t) => [...t.team].sort().join(',') === key);
    // 不含隊長的隊不在候選裡：ratio = null（self = false）。
    const pa = mine?.p ?? NaN;
    out.push({
      src, gi, role, round: p.round, attempt: p.attempt, forced: p.forced, went: p.wentOnMission, s, size: p.teamSeats.length, n: ok.length,
      k, c, ratio: Number.isFinite(pa) ? Math.round((pa / set.top) * 1e4) / 1e4 : null, self, thumbs: p.teamSeats.filter((x) => seen.includes(seatId(x))).length,
      bestClean: Math.round((Math.max(0, ...ok.filter((t) => t.thumbs === 0).map((t) => t.p)) / set.top) * 1e4) / 1e4,
    });
  });
  return out;
}

function main(): void {
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const lines: string[] = [];
  const bot = arg('--bot');
  if (bot) {
    const tuning = { ...DEFAULT_AGENT_TUNING };
    const max = Number(arg('--max-games') ?? 1e9);
    const text = fs.readFileSync(bot, 'utf8').split('\n').filter((l) => l.trim().length > 0).slice(0, max);
    text.forEach((l, i) => {
      if (i % shardN !== shardK) return;
      const n = JSON.parse(l) as NormGame;
      for (const r of rowsOf('bot', n.gi, null, toReplay(n), tuning)) lines.push(JSON.stringify(r));
      if (i % 200 === shardK) console.error(`bot game ${i}: ${lines.length} rows`);
    });
  } else {
    const tuning = tuningForOpponent((arg('--profile') ?? 'avgHuman') as OpponentType, DEFAULT_AGENT_TUNING);
    const root = path.resolve(__dirname, '..');
    const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
    const { games } = replayGamesFromDataset(raw);
    const excluded = new Set(['flag:badGame', 'flag:incident']);
    for (let gi = shardK; gi < games.length; gi += shardN) {
      const d = games[gi];
      if (d.game.playerCount !== 10 || d.noteTags.some((t) => excluded.has(t))) continue;
      for (const r of rowsOf('human', gi, d.s, d.game, tuning)) lines.push(JSON.stringify(r));
      if (gi % 200 === shardK) console.error(`human game ${gi}: ${lines.length} rows`);
    }
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} rows → ${out}`);
}

main();
