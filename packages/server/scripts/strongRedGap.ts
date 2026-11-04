/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 紅方：機器人 vs 強者紅方的同局面比較（優化迴圈第 27 回合；Edward 2026-11-04「如果機器人跟真人（而且是強的真人）一樣的話
 * 兩者應該要類似或接近相同」；docs/ai/strong_metrics.md、docs/ai/optimization_loop.md 第 27 回合）。
 *
 *   cd packages/server && nice npx tsx scripts/strongRedGap.ts [--selfplay sp.json] [--flag 開關=值 ...] [--top 5（0 = 全體真人的紅方座位）] [--json out.json]
 *
 * 真人局（`games_cache.json`，`datasetReplay` 嚴格解析）裡每一個「紅方任務王前 5」的紅方座位，用 `agreement.replayGame`
 * 換成機器人重播（只給那個座位當時知道的東西），在**同一批決策點**比真人與機器人：
 *   1. 投票：角色 × 回合 × 在不在隊上 × 隊上有沒有看得到的隊友 × 比分 → 贊成率；異常票率（內黑／外白）。
 *   2. 任務牌（藏牌 = 出成功）：角色 × 回合 × 隊上幾紅 × 比分；只算可確定的牌（0 張失敗＝全出成功、失敗數＝隊上紅數＝全出失敗；
 *      單紅的隊每一張都可確定）。
 *   3. 湖的目標：目標是看得到的隊友／看不到的紅（奧伯倫）／藍方，以及目標的公開紀錄（出過失敗的任務、沒出過任務）。
 *   4. 湖的宣告：目標是隊友／看不到的紅／藍方 × 宣告紅的比例。
 * `--selfplay`：另外加自我對打（現行預設 500 局，`strongSelfPlay.ts`）同樣分格的機器人比例（機器人自己的局面分布）。
 * 輸出只寫角色與分格，不寫名字。
 */
import * as fs from 'fs';
import type { Role } from '@avalon/shared';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { describeAgentTuning, parseTuningFlag, resolveAgentTuning, type AgentTuning } from '../src/ai/AgentTuning';
import { replayGame, pinnedQuestCard } from '../src/ai/benchmark/agreement';
import type { ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import type { DatasetHeader, DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { fmtPct, table } from '../src/ai/infl/acc';
import { inFacetTop } from '../src/ai/infl/strongCohort';
import { humanGamesFromDataset, isRedRole } from '../src/ai/infl/strongData';
import { ROLE_ZH } from '../src/ai/infl/roleKings';
import { loadStrongCohorts } from './strongCohort';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** 一格：n 個決策點、真人選 X 的次數、機器人選 X 的次數。 */
interface Cell { n: number; h: number; b: number }
type Src = 'rep' | 'sp';

export class RedGapTable {
  readonly cells = new Map<string, Cell>();
  add(key: string, h: boolean, b: boolean): void {
    let c = this.cells.get(key);
    if (!c) { c = { n: 0, h: 0, b: 0 }; this.cells.set(key, c); }
    c.n++;
    c.h += h ? 1 : 0;
    c.b += b ? 1 : 0;
  }
  rate(key: string, who: 'h' | 'b'): number | null {
    const c = this.cells.get(key);
    return c && c.n > 0 ? c[who] / c.n : null;
  }
}

const RED_ROLES: readonly Role[] = ['assassin', 'morgana', 'mordred', 'oberon'];

/** 紅方座位看得到的隊友（奧伯倫看不到；其他紅看得到除了奧伯倫以外的紅）。 */
export function knownMates(game: ReplayGame, seat: number): Set<number> {
  const role = game.seatRoles[seat - 1];
  const out = new Set<number>();
  if (!isRedRole(role) || role === 'oberon') return out;
  game.seatRoles.forEach((r, k) => { if (k + 1 !== seat && isRedRole(r) && r !== 'oberon') out.add(k + 1); });
  return out;
}

/** 回合開始前的比分：「紅f-藍s」。 */
export function scoreBefore(game: ReplayGame, round: number): string {
  const prev = game.quests.filter((q) => q.round < round);
  const f = prev.filter((q) => q.failed).length;
  return `紅${f}藍${prev.length - f}`;
}

const stateOf = (score: string): string => (score.startsWith('紅2') ? '紅兩勝' : score.endsWith('藍2') ? '藍兩勝' : '其他');

/** 投票的分格（同時給真人與機器人用）。 */
function voteKeys(game: ReplayGame, p: number, seat: number): string[] {
  const prop = game.proposals[p];
  const role = game.seatRoles[seat - 1];
  const on = prop.teamSeats.includes(seat);
  const mates = knownMates(game, seat);
  const mate = prop.teamSeats.some((s) => s !== seat && mates.has(s));
  const r = prop.round;
  const band = r <= 2 ? `R${r}` : `R${r}`;
  const pos = prop.leaderSeat === seat ? (on ? '隊長' : '隊長隊外') : on ? '隊上' : '隊外';
  const st = stateOf(scoreBefore(game, r));
  const att = prop.attempt === 4 ? '第4次' : '第1-3次';
  const keys: string[] = [];
  for (const g of [ROLE_ZH[role] ?? role, '紅方']) {
    keys.push(`vote|${g}|${band}|${pos}`);
    keys.push(`vote|${g}|${band}|${pos}|${mate ? '有隊友' : '沒隊友'}`);
    keys.push(`vote|${g}|${band}|${pos}|${mate ? '有隊友' : '沒隊友'}|${st}`);
    keys.push(`vote|${g}|${band}|${pos}|${mate ? '有隊友' : '沒隊友'}|${att}`);
    keys.push(`vote|${g}|${r >= 3 ? 'R3+' : 'R1-2'}|${pos}`);
  }
  return keys;
}

const isAbnormal = (on: boolean, approve: boolean): boolean => on !== approve;

function questKeys(game: ReplayGame, round: number, seat: number): string[] {
  const q = game.quests.find((x) => x.round === round)!;
  const role = game.seatRoles[seat - 1];
  const reds = q.teamSeats.filter((s) => isRedRole(game.seatRoles[s - 1])).length;
  const mates = knownMates(game, seat);
  const seenOthers = q.teamSeats.filter((s) => s !== seat && mates.has(s)).length;
  const redKind = reds === 1 ? '單紅' : `${reds}紅`;
  const score = scoreBefore(game, round);
  const forced = game.proposals.some((pp) => pp.round === round && pp.forced);
  const keys: string[] = [];
  for (const g of [ROLE_ZH[role] ?? role, '紅方']) {
    keys.push(`quest|${g}|R${round}`);
    keys.push(`quest|${g}|R${round}|${redKind}`);
    keys.push(`quest|${g}|R${round}|${redKind}|${score}`);
    keys.push(`quest|${g}|R${round}|看得到的隊友${seenOthers}`);
    if (forced) keys.push(`quest|${g}|R${round}|${redKind}|強制局`);
  }
  return keys;
}

/** 湖目標的分類（持湖的紅方視角＋真相）。 */
function lakeCats(game: ReplayGame, holder: number, target: number, round: number): string[] {
  const mates = knownMates(game, holder);
  const tRed = isRedRole(game.seatRoles[target - 1]);
  const who = mates.has(target) ? '隊友' : tRed ? '看不到的紅' : '藍方';
  const qs = game.quests.filter((q) => q.round <= round);
  const onFail = qs.some((q) => q.failed && q.teamSeats.includes(target));
  const onAny = qs.some((q) => q.teamSeats.includes(target));
  const rec = onFail ? '出過失敗' : onAny ? '只出過成功' : '沒出過任務';
  return [`lakeT|${who}`, `lakeT|${rec}`, `lakeT|${who}|${rec}`];
}

function add(t: RedGapTable, keys: readonly string[], h: boolean, b: boolean): void { for (const k of keys) t.add(k, h, b); }

/** 自我對打：機器人自己的局面（`h` 欄 = `b` 欄 = 機器人的選擇）。 */
function addSelfPlay(t: RedGapTable, g: ReplayGame): void {
  g.proposals.forEach((prop, p) => {
    if (prop.forced || !prop.votesReliable) return;
    for (let seat = 1; seat <= g.playerCount; seat++) {
      if (!isRedRole(g.seatRoles[seat - 1])) continue;
      const v = prop.votes[seat - 1];
      const on = prop.teamSeats.includes(seat);
      add(t, voteKeys(g, p, seat), v, v);
      const abn = isAbnormal(on, v);
      for (const gg of [ROLE_ZH[g.seatRoles[seat - 1]], '紅方']) t.add(`abn|${gg}|${prop.round >= 3 ? 'R3+' : 'R1-2'}`, abn, abn);
    }
  });
  for (const q of g.quests) {
    for (const seat of q.teamSeats) {
      const card = pinnedQuestCard(g, q.round, seat);
      if (card === null) continue;
      add(t, questKeys(g, q.round, seat), card === 'success', card === 'success');
    }
  }
}

function report(rep: RedGapTable, sp: RedGapTable | null): void {
  const cell = (t: RedGapTable | null, k: string, who: 'h' | 'b'): string => {
    if (!t) return '—';
    const c = t.cells.get(k);
    return c && c.n > 0 ? `${fmtPct(c[who] / c.n)} (${c.n})` : '—';
  };
  const show = (title: string, keys: readonly string[], what: string): void => {
    const rows: string[][] = [[title, `強者 ${what}`, `機器人@強者點 ${what}`, `自我對打 ${what}`]];
    for (const k of keys) if (rep.cells.has(k) || sp?.cells.has(k)) rows.push([k.split('|').slice(1).join('·'), cell(rep, k, 'h'), cell(rep, k, 'b'), cell(sp, k, 'b')]);
    console.log(`\n${table(rows)}`);
  };
  const groups = ['紅方', ...RED_ROLES.map((r) => ROLE_ZH[r])];
  // 1. 異常票率
  show('異常票率', groups.flatMap((g) => [`abn|${g}|R1-2`, `abn|${g}|R3+`]), '異常');
  // 2. 投票：R3+ 每個角色 × 位置 × 有沒有隊友
  const voteKs: string[] = [];
  for (const g of groups) for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) for (const pos of ['隊外', '隊上']) for (const m of ['有隊友', '沒隊友']) voteKs.push(`vote|${g}|${r}|${pos}|${m}`);
  show('投票（贊成率）', voteKs, '贊成');
  const stKs: string[] = [];
  for (const g of groups) for (const r of ['R3', 'R4', 'R5']) for (const pos of ['隊外', '隊上']) for (const m of ['有隊友', '沒隊友']) for (const s of ['其他', '紅兩勝', '藍兩勝']) stKs.push(`vote|${g}|${r}|${pos}|${m}|${s}`);
  show('投票 × 比分（贊成率）', stKs, '贊成');
  const attKs: string[] = [];
  for (const g of ['紅方']) for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) for (const pos of ['隊外', '隊上']) for (const m of ['有隊友', '沒隊友']) for (const a of ['第1-3次', '第4次']) attKs.push(`vote|${g}|${r}|${pos}|${m}|${a}`);
  show('投票 × 第幾次（贊成率）', attKs, '贊成');
  // 3. 任務牌：藏牌率
  const qKs: string[] = [];
  for (const g of groups) for (let r = 1; r <= 5; r++) {
    qKs.push(`quest|${g}|R${r}`);
    for (const k of ['單紅', '2紅', '3紅']) qKs.push(`quest|${g}|R${r}|${k}`);
    for (const k of ['看得到的隊友0', '看得到的隊友1']) qKs.push(`quest|${g}|R${r}|${k}`);
  }
  show('任務牌（藏牌＝出成功；只算可確定的牌）', qKs, '藏牌');
  const qsKs: string[] = [];
  for (const g of ['紅方', ...RED_ROLES.map((r) => ROLE_ZH[r])]) for (let r = 1; r <= 5; r++) for (const f of [0, 1, 2]) for (const s of [0, 1, 2]) qsKs.push(`quest|${g}|R${r}|單紅|紅${f}藍${s}`);
  show('任務牌 × 比分（單紅的隊）', qsKs, '藏牌');
  // 4. 湖
  const lk: string[] = [];
  for (const w of ['隊友', '看不到的紅', '藍方']) { lk.push(`lakeT|${w}`); for (const rec of ['出過失敗', '只出過成功', '沒出過任務']) lk.push(`lakeT|${w}|${rec}`); }
  for (const rec of ['出過失敗', '只出過成功', '沒出過任務']) lk.push(`lakeT|${rec}`);
  show('湖目標（紅方持湖；選到這一類的比例）', [...lk, 'lakeT|一致'], '比例');
  show('湖宣告（紅方持湖；宣告紅的比例）', ['claim|隊友', 'claim|看不到的紅', 'claim|藍方', 'claim|一致'], '宣告紅');
}

function main(): void {
  const started = Date.now();
  const { cohorts, dataset } = loadStrongCohorts({ dataset: arg('--dataset'), analysis: arg('--analysis') });
  const { games: all } = humanGamesFromDataset(dataset as unknown as DatasetHeader & { games: readonly DatasetTuple[]; players: readonly string[] }, cohorts.threshold);
  const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
  const games = limit !== undefined ? all.slice(0, limit) : all;
  const flags: Partial<AgentTuning> = {};
  argv.forEach((a, i) => { if (a === '--flag') Object.assign(flags, parseTuningFlag(argv[i + 1])); });
  const tuning = resolveAgentTuning(flags);
  const top = Number(arg('--top') ?? 5);
  const rep = new RedGapTable();
  let seats = 0;
  games.forEach(({ game }, gi) => {
    const red: number[] = [];
    for (let s = 1; s <= game.playerCount; s++) {
      const role = game.seatRoles[s - 1];
      if (isRedRole(role) && (top <= 0 || inFacetTop(cohorts, role, 'vote', game.names[s - 1], top))) red.push(s);
    }
    if (red.length === 0) return;
    seats += red.length;
    const propIndex = new Map(game.proposals.map((p, i) => [`${p.round}|${p.attempt}`, i]));
    const outcomes = replayGame(game, red, { makeAgent: (id) => new HeuristicAgent(id, undefined, undefined, tuning) });
    for (const o of outcomes) {
      const role = game.seatRoles[o.seat - 1];
      if (o.type === 'vote') {
        const p = propIndex.get(`${o.round}|${o.attempt}`);
        if (p === undefined) continue;
        const on = game.proposals[p].teamSeats.includes(o.seat);
        const h = o.human === 'approve';
        const b = o.agent === 'approve';
        add(rep, voteKeys(game, p, o.seat), h, b);
        for (const g of [ROLE_ZH[role], '紅方']) rep.add(`abn|${g}|${o.round >= 3 ? 'R3+' : 'R1-2'}`, isAbnormal(on, h), isAbnormal(on, b));
      } else if (o.type === 'quest') {
        add(rep, questKeys(game, o.round, o.seat), o.human === 'success', o.agent === 'success');
      } else if (o.type === 'lakeTarget') {
        const ht = Number(o.human);
        const bt = Number(o.agent);
        const hc = new Set(lakeCats(game, o.seat, ht, o.round));
        const bc = new Set(lakeCats(game, o.seat, bt, o.round));
        for (const k of new Set([...hc, ...bc, ...lakeCats(game, o.seat, ht, o.round)])) rep.add(k, hc.has(k), bc.has(k));
        // 沒選到的分類也要算進分母
        const allCats = ['隊友', '看不到的紅', '藍方'].flatMap((w) => [`lakeT|${w}`, ...['出過失敗', '只出過成功', '沒出過任務'].map((r) => `lakeT|${w}|${r}`)])
          .concat(['出過失敗', '只出過成功', '沒出過任務'].map((r) => `lakeT|${r}`));
        for (const k of allCats) if (!hc.has(k) && !bc.has(k)) rep.add(k, false, false);
        rep.add('lakeT|一致', o.match, o.match);
      } else if (o.type === 'lakeClaim') {
        const lake = game.lakes.find((l) => l.round === o.round && l.holderSeat === o.seat);
        if (!lake) continue;
        const mates = knownMates(game, o.seat);
        const t = lake.targetSeat;
        const who = mates.has(t) ? '隊友' : isRedRole(game.seatRoles[t - 1]) ? '看不到的紅' : '藍方';
        rep.add(`claim|${who}`, o.human === 'evil', o.agent === 'evil');
        rep.add('claim|一致', o.match, o.match);
      }
    }
    if ((gi + 1) % 200 === 0) process.stderr.write(`[strongRedGap] ${gi + 1}/${games.length} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  });
  let spT: RedGapTable | null = null;
  const spPath = arg('--selfplay');
  if (spPath) {
    spT = new RedGapTable();
    const j = JSON.parse(fs.readFileSync(spPath, 'utf8')) as { games: ReplayGame[] };
    for (const g of j.games) addSelfPlay(spT, g);
  }
  // 異常票率（機器人@強者點）也要有分母：上面在投票時已加。
  console.log(`${top <= 0 ? '全體真人' : `紅方任務王前 ${top}`} 的紅方座位 ${seats}（${games.length} 局）；開關：${describeAgentTuning(tuning).slice(0, 160)}；${((Date.now() - started) / 60000).toFixed(1)} 分鐘`);
  report(rep, spT);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ rep: Object.fromEntries(rep.cells), sp: spT ? Object.fromEntries(spT.cells) : null }));
}

if (require.main === module) main();
