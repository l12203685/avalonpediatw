/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 指定玩家 × 現行百科AI 的逐決策點一致度（站長 2026-11-21）。
 *
 *   cd packages/server && npx tsx scripts/playerAgreement.ts --player 甲 --player 乙 --out /某個 repo 外的資料夾 [--workers 3]
 *
 * 選項：
 *   --player NAME        玩家（可重複）；名字對法同網站個人頁（完全相同 → 只差大小寫／全半形 → player_aliases.json 的舊名）
 *   --out DIR            輸出資料夾（必填，不可以在 repo 裡：輸出有玩家名字）；寫 agreement.json 與 summary.md
 *   --dataset PATH       每局資料集（預設 ./games_cache.json = 網站戰績／數據分析用的那一批真人局；百科AI 局不算）
 *   --game-db PATH       牌譜總庫（預設 ./game_db.json）：錯誤局、疑似重複局、記錯的來源、同一局兩個來源只留一份
 *   --corrections PATH   站長更正（預設 ./game_db_corrections.json）：exclude／duplicateOf 的局不算
 *   --aliases PATH       玩家別名（預設 ./player_aliases.json）：列出併進來的舊名與拆分規則
 *   --spellings-from P   另外掃這些 JSON 檔裡和玩家同一人的原始寫法（可重複；例如 records_cache.json），只用來報告
 *   --workers N          平行子行程（預設 min(3, CPU 數)）
 *   --limit N            每位玩家只用前 N 局（測試用）
 *   --top K / --examples E  每位玩家列前 K 種不同、每種 E 個例子（預設 5／2）
 *   --roles A,B          只算玩家拿這些角色的座位（loyal、percival、merlin、assassin、morgana、mordred、oberon；預設全部）
 *   --dump-spots         另外寫 spots.json：每一個決策點（每一張票都在，不只異常票）＋局面欄位（`spotContext.ts`：
 *                        比數、隊伍組成、湖中對象的種類、事後真相），給分情境的統計用（`playerAgreementBreakdown.py`）
 *   --dump-reasons       spots.json 裡和玩家不同的決策點（human 層）附上機器人的一句理由（要多跑一次解釋，比較慢）
 *
 * 做法：網站的真人局（排除 flag:badGame 與總庫標的錯誤／重複局）裡玩家坐的每一個座位，用 `agreement.replaySeat`
 * （第 1 關的座位一致度、人類 PR 量尺的同一套重播：只給那個座位當時知道的東西）讓機器人在每個決策點做決定，和玩家實際的選擇比。
 * 兩欄策略層：
 *   human  真人桌會用的那一層（`humanProfile.ts`：照那一局開打前的桌上強度 S 分弱／一般／強真人桌；S 不明 = 一般）
 *   ai     基準線（`DEFAULT_AGENT_TUNING`，自我對打量的那一套）
 * 決策與異常票的定義見 `src/ai/benchmark/playerAgreement.ts`。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, fork } from 'child_process';
import { findSamePlayerName, playerIdentityKey } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { PROFILE_OVERRIDES, opponentTypeOfTable, type OpponentType } from '../src/ai/humanProfile';
import { replaySeat, type DecisionOutcome } from '../src/ai/benchmark/agreement';
import { replayGameFromDataset, type DatasetHeader, type DatasetReplayGame, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { buildReplayObservation, seatId, validLakeTargetSeats } from '../src/ai/benchmark/replayObservation';
import { spotContext } from '../src/ai/benchmark/spotContext';
import { explainAssassination, explainLakeClaim, explainLakeTarget, explainQuestCard, explainTeamProposal, explainTeamVote, type DecisionExplanation } from '../src/ai/explain';
import {
  METRICS,
  METRIC_ZH,
  ROLE_ORDER,
  ROLE_ZH,
  aggregateSpots,
  assassinationForTeammate,
  excludedDatasetKeys,
  isInside,
  spotFromOutcome,
  topDisagreements,
  topDisagreementsByType,
  type GameDbCorrection,
  type GameDbRow,
  type Metric,
  type PlayerProfileResult,
  type PlayerSpot,
  type Profile,
} from '../src/ai/benchmark/playerAgreement';

const SERVER = path.resolve(__dirname, '..');
const REPO = path.resolve(SERVER, '..', '..');
const PROFILES: readonly Profile[] = ['human', 'ai'];

interface Args {
  players: string[];
  out?: string;
  dataset: string;
  gameDb: string;
  corrections: string;
  aliases: string;
  spellingsFrom: string[];
  workers: number;
  limit?: number;
  top: number;
  examples: number;
  roles?: string[];
  dumpSpots: boolean;
  dumpReasons: boolean;
  shard?: [number, number];
  shardOut?: string;
  jobs?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    players: [],
    dataset: path.join(SERVER, 'games_cache.json'),
    gameDb: path.join(SERVER, 'game_db.json'),
    corrections: path.join(SERVER, 'game_db_corrections.json'),
    aliases: path.join(SERVER, 'player_aliases.json'),
    spellingsFrom: [],
    workers: Math.max(1, Math.min(3, os.cpus().length)),
    top: 5,
    examples: 2,
    dumpSpots: false,
    dumpReasons: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    switch (k) {
      case '--player': a.players.push(next()); break;
      case '--out': a.out = path.resolve(next()); break;
      case '--dataset': a.dataset = path.resolve(next()); break;
      case '--game-db': a.gameDb = path.resolve(next()); break;
      case '--corrections': a.corrections = path.resolve(next()); break;
      case '--aliases': a.aliases = path.resolve(next()); break;
      case '--spellings-from': a.spellingsFrom.push(path.resolve(next())); break;
      case '--workers': a.workers = Math.max(1, Number.parseInt(next(), 10)); break;
      case '--limit': a.limit = Number.parseInt(next(), 10); break;
      case '--top': a.top = Number.parseInt(next(), 10); break;
      case '--examples': a.examples = Number.parseInt(next(), 10); break;
      case '--roles': {
        a.roles = next().split(',').map((r) => r.trim()).filter(Boolean);
        const bad = a.roles.filter((r) => !(ROLE_ORDER as readonly string[]).includes(r));
        if (bad.length) throw new Error(`unknown role ${bad.join(', ')} (use ${ROLE_ORDER.join(', ')})`);
        break;
      }
      case '--dump-spots': a.dumpSpots = true; break;
      case '--dump-reasons': a.dumpSpots = true; a.dumpReasons = true; break;
      case '--shard': { const [x, n] = next().split('/').map((v) => Number.parseInt(v, 10)); a.shard = [x, n]; break; }
      case '--shard-out': a.shardOut = next(); break;
      case '--jobs': a.jobs = next(); break;
      case '--help': case '-h': console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

type Dataset = DatasetHeader & { games: DatasetTuple[]; players: string[]; aliases?: Record<string, string> };

/** 一局要重播的座位：[資料集 id, [[玩家, 座位], ...]]。 */
type Job = [string, Array<[string, number]>];

function opponentOf(g: DatasetReplayGame): OpponentType {
  // 真人局：桌上一定有真人；層照開打前的 S（資料集 lineup），S 不明 = 一般真人桌。
  return opponentTypeOfTable({ humans: 9, tableS: g.s });
}

function makeAgentFor(profile: Profile, opp: OpponentType): (id: string) => HeuristicAgent {
  // 同 GameServer：真人桌 = new HeuristicAgent(id, _, _, PROFILE_OVERRIDES[type])；機器人桌 = new HeuristicAgent(id)。
  return profile === 'human'
    ? (id): HeuristicAgent => new HeuristicAgent(id, undefined, undefined, PROFILE_OVERRIDES[opp])
    : (id): HeuristicAgent => new HeuristicAgent(id);
}

/** 一局、一位玩家的座位、一個策略層 → 決策點。 */
function replayJob(g: DatasetReplayGame, player: string, seat: number, profile: Profile, assassinCache: Map<string, DecisionOutcome | null>): PlayerSpot[] {
  const opp = opponentOf(g);
  const opts = { makeAgent: makeAgentFor(profile, opp) };
  const game = g.game;
  const role = game.seatRoles[seat - 1];
  const out = replaySeat(game, seat, opts).map((o) => spotFromOutcome(o, player, profile, opp));
  if (campOf(role) === 'evil' && role !== 'assassin' && game.assassinTargetSeat !== undefined) {
    const aSeat = game.seatRoles.indexOf('assassin') + 1;
    const key = `${game.id}|${profile}`;
    if (!assassinCache.has(key)) {
      assassinCache.set(key, aSeat > 0 ? replaySeat(game, aSeat, opts).find((o) => o.type === 'assassinate') ?? null : null);
    }
    const a = assassinCache.get(key);
    if (a) out.push(assassinationForTeammate(a, seat, role, player, profile, opp));
  }
  return out;
}

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function replayGamesById(ds: Dataset): Map<string, { row: DatasetTuple; res: ReturnType<typeof replayGameFromDataset> }> {
  const iId = ds.fields.indexOf('id');
  const out = new Map<string, { row: DatasetTuple; res: ReturnType<typeof replayGameFromDataset> }>();
  for (const row of ds.games) out.set(String(row[iId]), { row, res: replayGameFromDataset(row, ds) });
  return out;
}

function runShard(a: Args): void {
  const ds = loadJson<Dataset>(a.dataset);
  const jobs = loadJson<Job[]>(a.jobs!);
  const [k, n] = a.shard!;
  const iId = ds.fields.indexOf('id');
  const rowOf = new Map(ds.games.map((r) => [String(r[iId]), r]));
  const spots: PlayerSpot[] = [];
  for (let j = k; j < jobs.length; j += n) {
    const [gid, seats] = jobs[j];
    const res = replayGameFromDataset(rowOf.get(gid)!, ds);
    if (!res.ok) continue;
    const cache = new Map<string, DecisionOutcome | null>();
    for (const [player, seat] of seats) for (const profile of PROFILES) spots.push(...replayJob(res.value, player, seat, profile, cache));
  }
  fs.writeFileSync(a.shardOut!, JSON.stringify(spots));
}

async function replayAll(a: Args, jobs: Job[]): Promise<PlayerSpot[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'player-agreement-'));
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs));
  const started = Date.now();
  await Promise.all(Array.from({ length: a.workers }, (_, k) => new Promise<void>((resolve, reject) => {
    const child = fork(process.argv[1], ['--dataset', a.dataset, '--jobs', jobsFile, '--shard', `${k}/${a.workers}`, '--shard-out', path.join(dir, `s${k}.json`)], {
      execArgv: process.execArgv, stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${k} exited ${code}`))));
  })));
  let spots: PlayerSpot[] = [];
  for (let k = 0; k < a.workers; k++) spots = spots.concat(loadJson<PlayerSpot[]>(path.join(dir, `s${k}.json`)));
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(`replayed ${jobs.length} games → ${spots.length} decision points in ${((Date.now() - started) / 1000).toFixed(0)}s (${a.workers} workers)`);
  return spots;
}

// ── 解釋（例子用）────────────────────────────────────────

function oneLine(e: DecisionExplanation): string {
  // 「前向推理：評估 N 個選項…」只是走了哪條路，不是理由；其他規則名放在理由後面。
  const rule = e.rule && !/^前向推理：評估/.test(e.rule) ? `（${e.rule}）` : '';
  const t = `${e.reason}${rule}`.replace(/\s+/g, ' ');
  return t.length > 180 ? `${t.slice(0, 178)}…` : t;
}

function explainSpot(g: DatasetReplayGame, s: PlayerSpot): string {
  try {
    const game = g.game;
    const opp = opponentOf(g);
    const actor = s.actorSeat ?? s.seat;
    const agent = makeAgentFor(s.profile, opp)(seatId(actor));
    switch (s.type) {
      case 'team': case 'vote': {
        const idx = game.proposals.findIndex((p) => p.round === s.round && p.attempt === s.attempt);
        if (s.type === 'team') {
          const obs = buildReplayObservation(game, actor, { kind: 'team_select', proposal: idx });
          return oneLine(explainTeamProposal(obs, s.agent.split(',').filter(Boolean).map((x) => seatId(Number(x))), agent));
        }
        const obs = buildReplayObservation(game, actor, { kind: 'team_vote', proposal: idx });
        return oneLine(explainTeamVote(obs, s.agent === 'approve', agent));
      }
      case 'quest': {
        const obs = buildReplayObservation(game, actor, { kind: 'quest_vote', round: s.round });
        return oneLine(explainQuestCard(obs, s.agent === 'fail' ? 'fail' : 'success', agent));
      }
      case 'lakeTarget': case 'lakeClaim': {
        const li = game.lakes.findIndex((l) => l.round === s.round);
        const obs = buildReplayObservation(game, actor, { kind: 'lake', lake: li });
        if (s.type === 'lakeTarget') {
          return oneLine(explainLakeTarget(obs, seatId(Number(s.agent)), validLakeTargetSeats(game, li).map(seatId), agent.tuning));
        }
        const target = game.lakes[li].targetSeat;
        const claim = s.agent === 'good' || s.agent === 'evil' ? s.agent : null;
        return oneLine(explainLakeClaim(obs, seatId(target), campOf(game.seatRoles[target - 1]), claim, agent.tuning));
      }
      case 'assassinate': {
        const obs = buildReplayObservation(game, actor, { kind: 'assassination' });
        return oneLine(explainAssassination(obs, seatId(Number(s.agent)), agent));
      }
      default: return '';
    }
  } catch (err) {
    return `（解釋失敗：${(err as Error).message}）`;
  }
}

// ── 主程式 ─────────────────────────────────────────────

interface PlayerInfo {
  query: string;
  canonical: string;
  aliasEntries: string[];
  splitRules: unknown[];
  spellingsSeen: string[];
  games: {
    inDataset: number;
    excluded: Record<string, number>;
    botGame: number;
    unreplayable: Record<string, number>;
    /** --roles：玩家在這一局沒有拿到指定的角色。 */
    otherRole: number;
    replayed: number;
    seatGames: number;
    tiers: Record<string, number>;
    flags: Record<string, number>;
    roles: Record<string, number>;
  };
}

function walkStrings(o: unknown, acc: Set<string>): void {
  if (typeof o === 'string') { if (o.length <= 24) acc.add(o); return; }
  if (Array.isArray(o)) { for (const v of o) walkStrings(v, acc); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k.length <= 24) acc.add(k); walkStrings(v, acc); }
}

const fmtCell = (c: { samePct: number | null; n: number } | undefined): string => (c && c.n ? `${c.samePct!.toFixed(1)}%（${c.n}）` : '—');

const HEADLINE: ReadonlyArray<[Metric, string]> = [
  ['quest_red', '出任務（紅）'],
  ['lakeTarget', '湖中目標'],
  ['lakeClaim_red', '湖中宣告（紅）'],
  ['team', '派隊（整隊）'],
  ['abn_player', '異常票 玩家→AI'],
  ['abn_bot', '異常票 AI→玩家'],
  ['assassinate', '刺殺（紅方全員）'],
];

function summaryMd(
  infos: PlayerInfo[],
  results: Record<string, Record<Profile, PlayerProfileResult>>,
  disagreements: Record<string, Array<{ kind: string; count: number; share: number; examples: Array<Record<string, unknown>> }>>,
  byType: Record<string, ReturnType<typeof topDisagreementsByType>>,
  meta: Record<string, unknown>,
): string {
  const L: string[] = [];
  L.push('# 百科AI × 指定玩家：同一個局面的決策相同比例', '');
  L.push(`產生：${meta.generatedAt}｜程式 ${meta.gitSha}｜資料集 ${meta.datasetGames} 局（網站戰績的真人局，百科AI 局不算）`, '');
  L.push('**做法**：玩家坐過的每個座位，用第 1 關／人類 PR 量尺的同一套重播（`agreement.replaySeat`）：機器人只拿到那個座位當時的公開紀錄＋自己角色的資訊（刺殺時紅方開牌），每個決策點獨立比對，之後照真人牌譜走。');
  L.push('**策略層**：human = 真人桌會用的層（照該局開打前的桌上強度 S：S<38 弱、38–55 一般、≥55 強，S 不明算一般）；ai = 基準線（自我對打那一套）。真人桌的開關只改藍方讀人，紅方決策兩欄相同。', '');
  L.push('**異常票**（同數據分析 `abnormalVotes.ts`）：內黑 = 在隊上投反對、外白 = 不在隊上投贊成；只算第 1～4 次提議、票數對得上結果的提議（強制局沒有投票）。兩個方向都列。');
  L.push('**出任務**只算紅方而且牌可以確定的（任務 0 張失敗 → 成功；失敗張數 = 隊上紅方數 → 失敗）；藍方只能出成功，不列。**刺殺**：玩家是任何紅方的局都算（紅方一起討論），AI = 機器人坐刺客座位的選擇。', '');
  if (Array.isArray(meta.roles)) L.push(`**只算這些角色的座位**：${(meta.roles as string[]).map((r) => ROLE_ZH[r] ?? r).join('、')}（玩家拿其他角色的局不比）。`, '');
  L.push('## 玩家與局數', '');
  L.push('| 輸入 | 正式名字 | 併進來的寫法 | 資料集裡的局 | 排除 | 無法嚴格重播 | 比對的局 | 桌層（弱／一般／強） |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const p of infos) {
    const ex = Object.values(p.games.excluded).reduce((x, y) => x + y, 0);
    const un = Object.values(p.games.unreplayable).reduce((x, y) => x + y, 0);
    const spell = [...new Set([...p.spellingsSeen, ...p.aliasEntries])].join('、') || p.canonical;
    const t = p.games.tiers;
    L.push(`| ${p.query} | ${p.canonical} | ${spell}${p.splitRules.length ? `（拆分規則 ${p.splitRules.length} 條）` : ''} | ${p.games.inDataset} | ${ex} | ${un + p.games.botGame} | ${p.games.replayed}${p.games.otherRole ? `（另有 ${p.games.otherRole} 局拿其他角色，不比）` : ''} | ${t.weakHuman ?? 0}／${t.avgHuman ?? 0}／${t.strongHuman ?? 0} |`);
  }
  L.push('');
  for (const profile of PROFILES) {
    L.push(`## 總表（${profile === 'human' ? 'human：真人桌策略層' : 'ai：基準線'}）相同%（樣本數）`, '');
    L.push(`| 玩家 | ${HEADLINE.map((h) => h[1]).join(' | ')} | 派隊 Jaccard |`);
    L.push(`|---|${HEADLINE.map(() => '---').join('|')}|---|`);
    for (const p of infos) {
      const r = results[p.canonical][profile].all;
      L.push(`| ${p.canonical} | ${HEADLINE.map(([m]) => fmtCell(r[m])).join(' | ')} | ${r.team?.jaccardMean?.toFixed(3) ?? '—'} |`);
    }
    L.push('');
  }
  L.push('## 異常票細分（human）', '');
  L.push('| 玩家 | 玩家內黑→AI同 | 玩家外白→AI同 | AI內黑→玩家同 | AI外白→玩家同 | 湖中宣告（藍） |');
  L.push('|---|---|---|---|---|---|');
  for (const p of infos) {
    const r = results[p.canonical].human.all;
    L.push(`| ${p.canonical} | ${fmtCell(r['abn_player_內黑'])} | ${fmtCell(r['abn_player_外白'])} | ${fmtCell(r['abn_bot_內黑'])} | ${fmtCell(r['abn_bot_外白'])} | ${fmtCell(r.lakeClaim_blue)} |`);
  }
  L.push('');
  for (const p of infos) {
    const r = results[p.canonical].human;
    const roles = ROLE_ORDER.filter((x) => r.byRole[x]);
    L.push(`## ${p.canonical}：決策 × 角色（human）相同%（樣本數）`, '');
    L.push(`| 決策 | ${roles.map((x) => ROLE_ZH[x]).join(' | ')} |`);
    L.push(`|---|${roles.map(() => '---').join('|')}|`);
    for (const m of METRICS) {
      if (!roles.some((x) => r.byRole[x][m])) continue;
      L.push(`| ${METRIC_ZH[m]} | ${roles.map((x) => fmtCell(r.byRole[x][m])).join(' | ')} |`);
    }
    L.push('');
    L.push(`### ${p.canonical}：分座位（human，所有角色）`, '');
    L.push(`| 座位 | ${HEADLINE.map((h) => h[1]).join(' | ')} |`);
    L.push(`|---|${HEADLINE.map(() => '---').join('|')}|`);
    for (let seat = 1; seat <= 10; seat++) {
      const c = r.bySeat[String(seat)];
      if (c) L.push(`| ${seat === 10 ? 0 : seat}家 | ${HEADLINE.map(([m]) => fmtCell(c[m])).join(' | ')} |`);
    }
    L.push('');
    L.push(`### ${p.canonical}：最常見的 ${disagreements[p.canonical].length} 種不同（human）`, '');
    disagreements[p.canonical].forEach((d, i) => {
      L.push(`${i + 1}. **${d.kind}** — ${d.count} 次（佔不同的 ${d.share}%）`);
      for (const e of d.examples) {
        const at = e.attempt !== undefined ? `R${e.round}-${e.attempt}` : `R${e.round}`;
        L.push(`   - 局 ${e.gameId}｜${at}｜${e.seat === 10 ? 0 : e.seat}家 ${ROLE_ZH[String(e.role)] ?? e.role}${e.actorSeat ? `（刺客 ${e.actorSeat === 10 ? 0 : e.actorSeat}家）` : ''}｜玩家 ${e.humanZh} vs AI ${e.agentZh}｜AI：${e.reason}`);
      }
    });
    L.push('');
    L.push(`各決策自己最常見的不同（佔該決策所有不同的比例）：`);
    const TYPE_ZH: Record<string, string> = { team: '派隊', vote: '投票', quest: '出任務', lakeTarget: '湖中目標', lakeClaim: '湖中宣告', assassinate: '刺殺' };
    for (const t of ['team', 'vote', 'quest', 'lakeTarget', 'lakeClaim', 'assassinate']) {
      const g = byType[p.canonical][t]?.[0];
      if (g) L.push(`- ${TYPE_ZH[t]}：${g.kind}（${g.count}／${g.ofType}，${((100 * g.count) / g.ofType).toFixed(0)}%）`);
    }
    L.push('');
  }
  return L.join('\n');
}

function choiceZh(s: PlayerSpot, v: string): string {
  const seat = (x: string): string => (x === '10' ? '0' : x);
  switch (s.type) {
    case 'team': return `派 ${v.split(',').filter(Boolean).map(seat).join('')}`;
    case 'vote': return v === 'approve' ? '贊成' : '反對';
    case 'quest': return v === 'fail' ? '失敗' : '成功';
    case 'lakeTarget': return `驗 ${seat(v)}家`;
    case 'lakeClaim': return v === 'good' ? '宣告藍' : v === 'evil' ? '宣告紅' : '不宣告';
    case 'assassinate': return `刺 ${seat(v)}家`;
    default: return v;
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (a.shard) { runShard(a); return; }
  if (a.players.length === 0) throw new Error('give at least one --player');
  if (!a.out) throw new Error('--out DIR is required (outside the repo: the output has player names)');
  if (isInside(a.out, REPO)) throw new Error(`--out must be outside the repo (${REPO}): the output has player names`);
  fs.mkdirSync(a.out, { recursive: true });

  const ds = loadJson<Dataset>(a.dataset);
  const aliasMap = ds.aliases ?? {};
  const aliasFile = fs.existsSync(a.aliases) ? loadJson<{ aliases?: Record<string, string>; splits?: Record<string, unknown[]> }>(a.aliases) : {};
  const iSeats = ds.fields.indexOf('seats');
  const iId = ds.fields.indexOf('id');
  const iSrc = ds.fields.indexOf('src');
  const iCat = ds.fields.indexOf('cat');
  const iNote = ds.fields.indexOf('note');
  const gamesOf = new Map<number, number>();
  for (const row of ds.games) for (const k of row[iSeats] as number[]) if (k >= 0) gamesOf.set(k, (gamesOf.get(k) ?? 0) + 1);
  const rank = (name: string): number => gamesOf.get(ds.players.indexOf(name)) ?? 0;

  const dbRows = fs.existsSync(a.gameDb) ? loadJson<{ games: GameDbRow[] }>(a.gameDb).games : [];
  const corrections = fs.existsSync(a.corrections) ? loadJson<{ corrections: Record<string, GameDbCorrection> }>(a.corrections).corrections : {};
  const excluded = excludedDatasetKeys(dbRows, corrections);
  const replays = replayGamesById(ds);

  const spellSources = a.spellingsFrom.map((f) => { const acc = new Set<string>(); walkStrings(loadJson<unknown>(f), acc); return acc; });

  const infos: PlayerInfo[] = [];
  const jobsByGame = new Map<string, Array<[string, number]>>();
  for (const q of a.players) {
    const canonical = findSamePlayerName(q, ds.players, rank, aliasMap);
    if (!canonical) throw new Error(`player not found: ${q}`);
    if (infos.some((x) => x.canonical === canonical)) throw new Error(`${q} is the same player as another --player (${canonical})`);
    const pk = ds.players.indexOf(canonical);
    const key = playerIdentityKey(canonical, aliasMap);
    const aliasEntries = Object.entries(aliasFile.aliases ?? aliasMap).filter(([, to]) => playerIdentityKey(to, aliasMap) === key).map(([from]) => from);
    const splitRules = Object.entries(aliasFile.splits ?? {}).flatMap(([name, rules]) =>
      (playerIdentityKey(name, aliasMap) === key ? rules : (rules as Array<{ as?: string }>).filter((r) => r.as && playerIdentityKey(r.as, aliasMap) === key)).map((r) => ({ name, ...(r as object) })));
    const spellingsSeen = [...new Set(spellSources.flatMap((acc) => [...acc].filter((s) => { try { return playerIdentityKey(s, aliasMap) === key; } catch { return false; } })))].sort();
    const info: PlayerInfo = {
      query: q, canonical, aliasEntries, splitRules, spellingsSeen,
      games: { inDataset: 0, excluded: {}, botGame: 0, unreplayable: {}, otherRole: 0, replayed: 0, seatGames: 0, tiers: {}, flags: {}, roles: {} },
    };
    let used = 0;
    for (const row of ds.games) {
      const allSeats = (row[iSeats] as number[]).map((k, i) => (k === pk ? i + 1 : 0)).filter((s) => s > 0);
      if (allSeats.length === 0) continue;
      info.games.inDataset += 1;
      const gid = String(row[iId]);
      const why = excluded.get(`${row[iSrc]}|${gid}`);
      const notes = ((row[iNote] as number[] | undefined) ?? []).map((i) => ds.vocab.noteTags[i]);
      if (ds.vocab.category?.[row[iCat] as number] === '百科AI') { info.games.botGame += 1; continue; }
      if (why || notes.includes('flag:badGame')) { const w = why ?? '試算表標 badGame'; info.games.excluded[w] = (info.games.excluded[w] ?? 0) + 1; continue; }
      const rep = replays.get(gid)!.res;
      if (!rep.ok) { info.games.unreplayable[rep.reason] = (info.games.unreplayable[rep.reason] ?? 0) + 1; continue; }
      const seats = a.roles ? allSeats.filter((s) => a.roles!.includes(rep.value.game.seatRoles[s - 1])) : allSeats;
      if (seats.length === 0) { info.games.otherRole += 1; continue; }
      if (a.limit !== undefined && used >= a.limit) continue;
      used += 1;
      info.games.replayed += 1;
      info.games.seatGames += seats.length;
      const opp = opponentOf(rep.value);
      info.games.tiers[opp] = (info.games.tiers[opp] ?? 0) + 1;
      for (const n of notes) if (n.startsWith('flag:')) info.games.flags[n] = (info.games.flags[n] ?? 0) + 1;
      for (const s of seats) { const r = rep.value.game.seatRoles[s - 1]; info.games.roles[r] = (info.games.roles[r] ?? 0) + 1; }
      const js = jobsByGame.get(gid) ?? [];
      for (const s of seats) js.push([canonical, s]);
      jobsByGame.set(gid, js);
    }
    infos.push(info);
    console.error(`${q} → ${canonical}: ${info.games.inDataset} games in dataset, ${info.games.replayed} replayed${a.roles ? ` (${a.roles.join(',')}; other roles ${info.games.otherRole})` : ''}`);
  }

  const jobs: Job[] = [...jobsByGame.entries()];
  const spots = await replayAll(a, jobs);

  const results: Record<string, Record<Profile, PlayerProfileResult>> = {};
  const disagreements: Record<string, Array<{ kind: string; count: number; share: number; examples: Array<Record<string, unknown>> }>> = {};
  const disagreementsAi: Record<string, Array<{ kind: string; count: number; share: number }>> = {};
  const byType: Record<string, ReturnType<typeof topDisagreementsByType>> = {};
  for (const p of infos) {
    const mine = (profile: Profile): PlayerSpot[] => spots.filter((s) => s.player === p.canonical && s.profile === profile);
    results[p.canonical] = { human: aggregateSpots(mine('human')), ai: aggregateSpots(mine('ai')) };
    disagreements[p.canonical] = topDisagreements(mine('human'), a.top, a.examples).map((d) => ({
      kind: d.kind, count: d.count, share: d.share,
      examples: d.examples.map((s) => {
        const g = replays.get(s.gameId)!.res;
        return {
          gameId: s.gameId, round: s.round, ...(s.attempt !== undefined ? { attempt: s.attempt } : {}), seat: s.seat, role: s.role,
          ...(s.actorSeat ? { actorSeat: s.actorSeat } : {}),
          human: s.human, agent: s.agent, humanZh: choiceZh(s, s.human), agentZh: choiceZh(s, s.agent), tier: s.tier,
          reason: g.ok ? explainSpot(g.value, s) : '',
        };
      }),
    }));
    byType[p.canonical] = topDisagreementsByType(mine('human'), 3);
    disagreementsAi[p.canonical] = topDisagreements(mine('ai'), a.top, 0).map((d) => ({ kind: d.kind, count: d.count, share: d.share }));
  }

  let gitSha = '';
  try { gitSha = execSync('git rev-parse HEAD', { cwd: SERVER }).toString().trim(); } catch { /* not a checkout */ }
  const meta = {
    generatedAt: new Date().toISOString(),
    gitSha,
    dataset: path.basename(a.dataset),
    datasetGames: ds.games.length,
    profiles: {
      human: '真人桌策略層：HeuristicAgent(id, _, _, PROFILE_OVERRIDES[opponentTypeOfTable({ humans, tableS: 該局開打前 S })])',
      ai: '基準線：HeuristicAgent(id)（DEFAULT_AGENT_TUNING）',
    },
    ...(a.roles ? { roles: a.roles } : {}),
    abnormalVote: '內黑 = 在隊上投反對；外白 = 不在隊上投贊成；第 1～4 次提議、票數對得上結果（agreement.replaySeat: !forced && votesReliable）；定義同 packages/shared/src/stats/abnormalVotes.ts、packages/server/src/ai/infl/abnormalVotes.ts',
    questCard: '紅方、可確定的牌（agreement.pinnedQuestCard）',
    assassinate: '玩家是任何紅方的局；AI = 機器人在刺客座位的刺殺選擇（玩家是刺客時就是玩家的座位）',
    metrics: METRIC_ZH,
  };
  const json = { meta, players: infos, results, disagreements, disagreementsByType: byType, disagreementsAi };
  fs.writeFileSync(path.join(a.out, 'agreement.json'), JSON.stringify(json, null, 1));
  if (a.dumpSpots) {
    const dump = spots.map((s) => {
      const g = replays.get(s.gameId)!.res;
      if (!g.ok) return s;
      const ctx = spotContext(g.value.game, s);
      const reason = a.dumpReasons && !s.match && s.profile === 'human' ? explainSpot(g.value, s) : undefined;
      return { ...s, tableS: g.value.s, date: g.value.date, ...(ctx ? { ctx } : {}), ...(reason !== undefined ? { reason } : {}) };
    });
    fs.writeFileSync(path.join(a.out, 'spots.json'), JSON.stringify({ meta, players: infos, spots: dump }));
    console.error(`wrote ${path.join(a.out, 'spots.json')} (${dump.length} decision points)`);
  }
  fs.writeFileSync(path.join(a.out, 'summary.md'), summaryMd(infos, results, disagreements, byType, meta));
  console.error(`wrote ${path.join(a.out, 'agreement.json')} and summary.md`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
