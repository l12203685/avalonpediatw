/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 60 回合（分析，站長 11/23「從局勢樹來看 哪個節點任務結果&刺殺結果影響最大 就先開始針對那個spot 的動作來分析」）：
 * 局勢樹上每個決策點（提議、表決、任務牌、湖、刺殺）對藍方最後勝負的影響。這支只做資料整理，統計在 `keySpotStudy.py`。
 *
 * 三種輸出（JSONL，每列一局或一個決策點；只有座位、角色、隊伍、票、任務牌、湖、刺殺，沒有玩家名）：
 *   --export-human OUT            真人局 = games_cache.json 嚴格重播（`replayGamesFromDataset`：百科AI 局不算；ProAvalon 不在這份資料；
 *                                  網站標成壞局／事故的局不算），
 *                                  一局一列：gi、s（桌上強度）、roles、props、quests、lakes、at、out。
 *   --export-bot DIR OUT          自我對打結果目錄（`selfplay/sp.ts` 的 detail=1 'g' 欄）轉成同一個格式。
 *   --replay OUT [--min-s 55]     真人局裡 S ≥ min-s 的桌（--min-s -1 = 全部，含沒有 S 的局；--only-role assassin = 只重播那個角色的座位），
 *                                  每個座位用現行預設（或 --flag）重播到每一個決策點（`agreement.replayGame`，
 *                                  和 `agreementBenchmark.ts` 同一個 agent 與種子），一個決策點一列：gi、seat、role、type、round、attempt、human、agent。
 *
 * 共同格式（座位 1..10，10 = 0家；1 家 = 第 1 局第 1 個隊長）：
 *   props: [round, attempt, leader, team[], approvers[] | null（強制局或票不可靠）, forced, went]
 *   quests: [round, team[], fails]；lakes: [afterRound, holder, target, claim 'o'|'x'|'']；at: 刺殺目標或 null；
 *   out: 'red3' | 'blueDead' | 'blueAlive'。
 *
 *   cd packages/server && npx tsx scripts/keySpotStudy.ts --export-human h.jsonl
 *   npx tsx scripts/keySpotStudy.ts --export-bot ../../selfplay-results/results/<runId> b.jsonl
 *   npx tsx scripts/keySpotStudy.ts --replay r.jsonl --min-s 55 [--shard k/n] [--flag name=v ...]
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { parseTuningFlag, resolveAgentTuning } from '../src/ai/AgentTuning';
import { evilLakeHumanOptionsFromEnv, setEvilLakeHumanOptions } from '../src/ai/LakePolicy';
import { setVouchFollowUpOptions, vouchFollowUpOptionsFromEnv } from '../src/ai/RedLakeFollowUp';
import { goodVouchOptionsFromEnv, setGoodVouchOptions } from '../src/ai/GoodLakeFollowUp';
import { setTeamReuseOptions, teamReuseOptionsFromEnv } from '../src/ai/TeamReuse';
import { redR1TeammateOptionsFromEnv, setRedR1TeammateOptions } from '../src/ai/RedR1Teammate';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { replayGame } from '../src/ai/benchmark/agreement';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { CONFIG_ROLES, type BotDetail } from '../src/ai/benchmark/outcomeGap';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

type Out = 'red3' | 'blueDead' | 'blueAlive';
interface NormGame {
  gi: number;
  s: number | null;
  roles: string[];
  props: [number, number, number, number[], number[] | null, boolean, boolean][];
  quests: [number, number[], number][];
  lakes: [number, number, number, string][];
  at: number | null;
  out: Out;
}

const seatNum = (c: string): number => (c === '0' ? 10 : Number(c));
const seatsOf = (s: string): number[] => s.split('').filter((c) => /[0-9]/.test(c)).map(seatNum);

function outcomeFrom(roles: readonly string[], quests: readonly [number, number[], number][], at: number | null): Out | null {
  let fail = 0;
  let ok = 0;
  for (const [r, , f] of quests) {
    if (f >= (r === 4 ? 2 : 1)) fail++; else ok++;
  }
  if (fail >= 3) return 'red3';
  if (ok >= 3) return at !== null && roles[at - 1] === 'merlin' ? 'blueDead' : 'blueAlive';
  return null;
}

/** 排除的局：網站標成壞局（flag:badGame）或有事故（flag:incident）。 */
const EXCLUDED_TAGS = new Set(['flag:badGame', 'flag:incident']);

/** 真人局；`skip` = 排除的局（gi 照資料順序，`--export-human` 與 `--replay` 共用）。 */
function humanGames(): { game: ReplayGame; s: number | null; skip: boolean }[] {
  const root = path.resolve(__dirname, '..');
  const raw = JSON.parse(fs.readFileSync(arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8'));
  const { games, skipped } = replayGamesFromDataset(raw);
  console.error(`human games: ${games.length} (skipped ${JSON.stringify(skipped)})`);
  return games.map((d) => ({ game: d.game, s: d.s, skip: d.noteTags.some((t) => EXCLUDED_TAGS.has(t)) }));
}

function normHuman(gi: number, g: ReplayGame, s: number | null): NormGame | null {
  const roles = g.seatRoles.map(String);
  const quests: NormGame['quests'] = g.quests.map((q) => [q.round, [...q.teamSeats], q.failCount]);
  const at = g.assassinTargetSeat ?? null;
  const out = outcomeFrom(roles, quests, at);
  if (!out) return null;
  return {
    gi, s, roles, quests, at, out,
    props: g.proposals.map((p) => [p.round, p.attempt, p.leaderSeat, [...p.teamSeats],
      !p.forced && p.votesReliable ? p.votes.flatMap((v, i) => (v ? [i + 1] : [])) : null, p.forced, p.wentOnMission]),
    lakes: g.lakes.map((l) => [l.round, l.holderSeat, l.targetSeat, l.claim === 'good' ? 'o' : l.claim === 'evil' ? 'x' : '']),
  };
}

function normBot(gi: number, d: BotDetail): NormGame | null {
  if (typeof d.c !== 'string' || d.c.length !== CONFIG_ROLES.length || !Array.isArray(d.r)) return null;
  const roles: string[] = Array(10).fill('loyal');
  d.c.split('').forEach((c, i) => { roles[seatNum(c) - 1] = CONFIG_ROLES[i]; });
  const props: NormGame['props'] = [];
  const quests: NormGame['quests'] = [];
  let global = 0;
  d.r.forEach((r, ri) => {
    const round = ri + 1;
    const ps = r.p ?? [];
    ps.forEach((p, ai) => {
      const forced = ai === 4;
      const went = ai === ps.length - 1 && !!r.m;
      props.push([round, ai + 1, (global % 10) + 1, seatsOf(String(p[0])), forced ? null : seatsOf(String(p[1])), forced, went]);
      global++;
    });
    if (r.m) quests.push([round, seatsOf(String(ps[ps.length - 1][0])), (r.m.match(/x/g) ?? []).length]);
  });
  const lakes: NormGame['lakes'] = (d.l ?? []).map((l, i) => [i + 2, seatNum(String(l[0])), seatNum(String(l[1])), String(l[2] ?? '')]);
  const at = d.a ? seatNum(String(d.a)) : null;
  const out = outcomeFrom(roles, quests, at);
  if (!out) return null;
  return { gi, s: null, roles, props, quests, lakes, at, out };
}

function exportHuman(out: string): void {
  const lines: string[] = [];
  humanGames().forEach(({ game, s, skip }, gi) => {
    const n = skip ? null : normHuman(gi, game, s);
    if (n) lines.push(JSON.stringify(n));
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} human games → ${out}`);
}

function exportBot(dir: string, out: string): void {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const fd = fs.openSync(out, 'w');
  let n = 0;
  let gi = 0;
  for (const f of files) {
    const res = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { cols: string[]; rows: unknown[][] };
    const gAt = res.cols.indexOf('g');
    if (gAt < 0) continue;
    for (const row of res.rows) {
      const g = normBot(gi++, JSON.parse(String(row[gAt])) as BotDetail);
      if (g) { fs.writeSync(fd, JSON.stringify(g) + '\n'); n++; }
    }
  }
  fs.closeSync(fd);
  console.error(`wrote ${n} bot games from ${files.length} files → ${out}`);
}

function replay(out: string): void {
  const minS = Number(arg('--min-s') ?? 55);
  const only = arg('--only-role');
  const [shardK, shardN] = (arg('--shard') ?? '0/1').split('/').map(Number);
  setEvilLakeHumanOptions(evilLakeHumanOptionsFromEnv());
  setVouchFollowUpOptions(vouchFollowUpOptionsFromEnv());
  setGoodVouchOptions(goodVouchOptionsFromEnv());
  setTeamReuseOptions(teamReuseOptionsFromEnv());
  setRedR1TeammateOptions(redR1TeammateOptionsFromEnv());
  const tuning = resolveAgentTuning(Object.assign({}, ...args('--flag').map(parseTuningFlag)));
  const games = humanGames();
  const lines: string[] = [];
  let k = 0;
  games.forEach(({ game, s, skip }, gi) => {
    if (skip || (minS >= 0 && (s === null || s < minS))) return;
    const seats = only ? game.seatRoles.flatMap((r, i) => (r === only ? [i + 1] : [])) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    if (!seats.length) return;
    if (k++ % shardN !== shardK) return;
    const rows = replayGame(game, seats, {
      makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning),
    });
    for (const d of rows) {
      lines.push(JSON.stringify({ gi, s, seat: d.seat, role: d.role, type: d.type, round: d.round, attempt: d.attempt ?? null, human: d.human, agent: d.agent }));
    }
    if (k % 20 === 0) console.error(`${k} games replayed`);
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`wrote ${lines.length} decisions → ${out}`);
}

function main(): void {
  const h = arg('--export-human');
  if (h) return exportHuman(h);
  const bi = argv.indexOf('--export-bot');
  if (bi >= 0) return exportBot(argv[bi + 1], argv[bi + 2]);
  const r = arg('--replay');
  if (r) return replay(r);
  throw new Error('--export-human OUT | --export-bot DIR OUT | --replay OUT');
}

main();
