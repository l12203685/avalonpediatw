/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 信念校準曲線（docs/ai/methods_backlog.md 第 1 項）：百科AI 在真人局的決策點說「某人是紅的機率 p」，那些人真的有 p 是紅嗎？
 *
 *   cd packages/server && npx tsx scripts/beliefCalibrationCurve.ts [--limit N] [--shard k/n] [--flag 開關=值 ...]
 *       [--viewers loyal,percival,merlin] [--strong-s 55] [--raw shard.json] [--json out.json] [--md out.md]
 *   cd packages/server && npx tsx scripts/beliefCalibrationCurve.ts --merge s0.json s1.json ... [--json out.json] [--md out.md]
 *   （--raw 存累加器給 --merge 合併分片；--json 是報告的摘要）
 *   pnpm --filter @avalon/server bot:calibration -- ...
 *
 * 資料：`games_cache.json`（`datasetReplay` 嚴格重播，不含百科AI 局；10 人局）。決策點 = 每一次非強制提議的投票點，
 * 每個藍方座位（忠臣、派西、梅林；--viewers 可改），觀察用 `buildReplayObservation`（只放那一家當下知道的事）再經
 * `aiRead.hideLobbyOrder`（大廳角色不照座位），信念 = `bayesRedShare(觀察, bayesOptionsOf(預設))`——和模擬瓦 /區間、
 * Threads 百科AI 作答顯示的紅機率同一個函式。目標 = 其他 9 人，y = 真的是紅。
 * 變體：`預設`、`均分`（L1* 世界均分：只用規則，不讀任何動作）、`--flag` 給了再加 `候選`（預設 + 這些開關）。
 * p 是 0 或 1（規則推得出來）的點另外算「確定點」，確定點說錯 = 邏輯錯誤，應該是 0。
 */
import { DEFAULT_COHORT_CUTS } from '@avalon/shared/stats';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { bayesOptionsOf, bayesRedShare, type BayesOptions } from '../src/ai/belief/BayesBelief';
import { buildCertainty } from '../src/ai/belief/Certainty';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf, type ReplayGame } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset, type DatasetHeader, type DatasetTuple } from '../src/ai/benchmark/datasetReplay';
import { addPoint, mergeAcc, newAcc, summarize, type CalAcc, type CurveSummary } from '../src/ai/benchmark/calibration';
import { hideLobbyOrder } from '../src/bots/simulation/aiRead';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const CERTAIN = 1e-9;
const ROLE_LABEL: Record<string, string> = { loyal: '忠臣', percival: '派西', merlin: '梅林' };

export interface Variant { name: string; opts: BayesOptions | 'uniform' }

/** key = 變體|視角|R回合|S(高端桌)/N|u(不確定)/c(確定) → 累加器；確定點另記說錯的次數。 */
export interface Store {
  acc: Record<string, CalAcc>;
  certainWrong: Record<string, number>;
  /** 確定點說錯、而且只用遊戲規則（L0：不含「好人持湖說實話」「兩敗後紅方必出失敗」「還湖」三條慣例）推不出來的。 */
  certainWrongConvention: Record<string, number>;
  games: number;
  points: number;
}

export function variants(): Variant[] {
  const base: AgentTuning = { ...DEFAULT_AGENT_TUNING };
  const out: Variant[] = [{ name: '預設', opts: bayesOptionsOf(base) }, { name: '均分', opts: 'uniform' }];
  const flags: string[] = [];
  argv.forEach((a, i) => { if (a === '--flag') flags.push(argv[i + 1]); });
  if (flags.length) {
    const t: AgentTuning = { ...base };
    for (const f of flags) Object.assign(t, parseTuningFlag(f));
    out.push({ name: '候選', opts: bayesOptionsOf(t) });
  }
  return out;
}

function shares(obs: ReturnType<typeof buildReplayObservation>, v: Variant): Map<string, number> {
  if (v.opts !== 'uniform') return bayesRedShare(obs, v.opts);
  const view = buildCertainty(obs);
  const n = view.worlds('L1*').length;
  return new Map(obs.allPlayerIds.map((id) => [id, n ? view.uniformRedShare(id) : 0.5]));
}

export function evalGame(game: ReplayGame, strong: boolean, vs: readonly Variant[], viewers: ReadonlySet<string>, st: Store): void {
  const red = (seat: number): boolean => campOf(game.seatRoles[seat - 1]) === 'evil';
  for (let seat = 1; seat <= game.playerCount; seat++) {
    const role = game.seatRoles[seat - 1];
    if (!viewers.has(role)) continue;
    const me = seatId(seat);
    game.proposals.forEach((p, i) => {
      if (p.forced) return;
      const obs = hideLobbyOrder(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i }));
      const l0 = buildCertainty(obs);
      st.points++;
      for (const v of vs) {
        const sh = shares(obs, v);
        for (let t = 1; t <= game.playerCount; t++) {
          const id = seatId(t);
          if (id === me) continue;
          const x = sh.get(id) ?? 0.5;
          const y: 0 | 1 = red(t) ? 1 : 0;
          const certain = x <= CERTAIN || x >= 1 - CERTAIN;
          const key = `${v.name}|${role}|R${p.round}|${strong ? 'S' : 'N'}|${certain ? 'c' : 'u'}`;
          addPoint((st.acc[key] ??= newAcc()), x, y);
          if (certain && (x >= 0.5 ? 1 : 0) !== y) {
            st.certainWrong[key] = (st.certainWrong[key] ?? 0) + 1;
            const r0 = l0.worlds('L0').length ? l0.uniformRedShare(id, 'L0') : 0.5;
            if (r0 > CERTAIN && r0 < 1 - CERTAIN) st.certainWrongConvention[key] = (st.certainWrongConvention[key] ?? 0) + 1;
          }
        }
      }
    });
  }
  st.games++;
}

/** 依條件合併累加器。 */
export function pick(st: Store, pred: (variant: string, viewer: string, round: string, strong: string, certain: string) => boolean): CalAcc {
  return mergeAcc(...Object.entries(st.acc).filter(([k]) => { const [v, w, r, s, c] = k.split('|'); return pred(v, w, r, s, c); }).map(([, a]) => a));
}
function wrong(st: Store, pred: (variant: string) => boolean, convention = false): number {
  return Object.entries(convention ? st.certainWrongConvention : st.certainWrong).filter(([k]) => pred(k.split('|')[0])).reduce((a, [, n]) => a + n, 0);
}

const pc = (x: number, d = 1): string => (Number.isFinite(x) ? (100 * x).toFixed(d) : '—');
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : '—');
const f4 = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : '—');

function summaryRow(name: string, s: CurveSummary, sep?: number): string {
  return `| ${name} | ${s.n} | ${pc(s.baseRate)} | ${pc(s.meanP)} | ${f4(s.brier)}（${f4(s.brierBase)}） | ${f3(s.logLoss)}（${f3(s.logLossBase)}） | ${pc(s.ece, 2)} | ${pc(s.mce)} | ${f4(s.reliability)} / ${f4(s.resolution)} | ${s.platt ? `${s.platt.b.toFixed(2)}（a ${s.platt.a >= 0 ? '+' : ''}${s.platt.a.toFixed(2)}）` : '—'} |${sep !== undefined ? ` ${f3(sep)} |` : ''}`;
}
const SUMMARY_HEAD = [
  '| 範圍 | 點數 | 真紅比例 % | 平均 p % | Brier（只猜基準率） | 對數損失 nats（只猜基準率） | ECE pp | 最大格差 pp | 可靠度 / 鑑別度 | Platt 斜率 b（截距） | 分離度（真紅 − 真藍 平均 p） |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];

/** 真紅 − 真藍 的平均 p（分離度）。 */
function separation(a: CalAcc): number {
  let sr = 0; let nr = 0; let sb = 0; let nb = 0;
  for (let i = 0; i < a.n.length; i++) { sr += a.spy[i]; nr += a.sy[i]; sb += a.sp[i] - a.spy[i]; nb += a.n[i] - a.sy[i]; }
  return (nr ? sr / nr : NaN) - (nb ? sb / nb : NaN);
}

function report(st: Store, names: readonly string[], meta: Record<string, unknown>): { md: string; json: Record<string, unknown> } {
  const L: string[] = [];
  const out: Record<string, unknown> = { meta };
  L.push(`# 百科AI 信念校準曲線（真人局）`, '');
  L.push(`- 資料：${String(meta.source)}，${st.games} 局、${st.points} 個（座位 × 投票點）；視角 ${String(meta.viewers)}；高端桌 = S ≥ ${String(meta.strongS)}`);
  L.push('- 每個點 = 一個藍方座位在一次非強制提議的投票點，對另外一個人說的紅機率 p；y = 那個人真的是紅。主表只算 0 < p < 1 的點（規則推不出來的）；p = 0／1 的確定點另列。');
  L.push('- ECE = Σ n_k|平均 p − 真紅比例| / N（10 格）；Platt：logit(真紅) = a + b·logit(p)，b < 1 = 過度自信（說得太篤定）。');
  for (const v of names) {
    const sumAll = summarize(pick(st, (vv, _w, _r, _s, c) => vv === v && c === 'u'));
    const certainN = pick(st, (vv, _w, _r, _s, c) => vv === v && c === 'c').n.reduce((a, b) => a + b, 0);
    const certainWrong = wrong(st, (vv) => vv === v);
    const certainConv = wrong(st, (vv) => vv === v, true);
    const res: Record<string, unknown> = { all: sumAll, certain: { n: certainN, wrong: certainWrong, wrongFromConventions: certainConv } };
    L.push('', `## ${v}`, '');
    L.push(`確定點（p = 0 或 1）：${certainN} 個，說錯 ${certainWrong} 個（${pc(certainN ? certainWrong / certainN : NaN, 2)}%），其中 ${certainConv} 個只用遊戲規則（L0）推不出來、是桌上慣例（A0 好人持湖說實話、A1 兩敗後紅方必出失敗、A2 還湖）推出來的。`);
    const byRound = ['R1', 'R2', 'R3', 'R4', 'R5'].map((r) => {
      const n = pick(st, (vv, _w, rr, _s, c) => vv === v && rr === r && c === 'c').n.reduce((a, b) => a + b, 0);
      const w = Object.entries(st.certainWrong).filter(([k]) => { const [vv, , rr] = k.split('|'); return vv === v && rr === r; }).reduce((a, [, x]) => a + x, 0);
      return `${r} ${w}／${n}`;
    });
    const byViewer = ['loyal', 'percival', 'merlin'].map((w) => {
      const n = pick(st, (vv, ww, _r, _s, c) => vv === v && ww === w && c === 'c').n.reduce((a, b) => a + b, 0);
      const x = Object.entries(st.certainWrong).filter(([k]) => { const [vv, ww] = k.split('|'); return vv === v && ww === w; }).reduce((a, [, y]) => a + y, 0);
      return `${ROLE_LABEL[w]} ${x}／${n}`;
    });
    L.push(`說錯／確定點，分回合：${byRound.join('、')}；分視角：${byViewer.join('、')}。`, '');
    L.push('**可靠度圖**（全部藍方視角、不確定的點）：', '', '| p 格 | 點數 | 平均 p % | 真紅比例 %（Wilson 95%） | 差（真紅 − p，pp） |', '|---|---|---|---|---|');
    for (const b of sumAll.bins) {
      L.push(`| ${pc(b.lo, 0)}–${pc(b.hi, 0)}% | ${b.n} | ${pc(b.meanP)} | ${pc(b.freq)} [${pc(b.ciLo)}, ${pc(b.ciHi)}] | ${b.n ? `${b.freq - b.meanP >= 0 ? '+' : ''}${pc(b.freq - b.meanP)}` : '—'} |`);
    }
    L.push('', '**分視角、分回合、分桌**：', '', ...SUMMARY_HEAD);
    const rows: [string, CalAcc][] = [['全部', pick(st, (vv, _w, _r, _s, c) => vv === v && c === 'u')]];
    for (const w of ['loyal', 'percival', 'merlin']) rows.push([ROLE_LABEL[w], pick(st, (vv, ww, _r, _s, c) => vv === v && ww === w && c === 'u')]);
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) rows.push([`${r}（全部視角）`, pick(st, (vv, _w, rr, _s, c) => vv === v && rr === r && c === 'u')]);
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) rows.push([`${r}（忠臣）`, pick(st, (vv, ww, rr, _s, c) => vv === v && ww === 'loyal' && rr === r && c === 'u')]);
    rows.push(['高端桌', pick(st, (vv, _w, _r, s, c) => vv === v && s === 'S' && c === 'u')]);
    rows.push(['其他桌', pick(st, (vv, _w, _r, s, c) => vv === v && s === 'N' && c === 'u')]);
    const table: Record<string, CurveSummary & { separation: number }> = {};
    for (const [name, a] of rows) {
      const s = summarize(a);
      if (!s.n) continue;
      const sep = separation(a);
      table[name] = { ...s, separation: sep };
      L.push(summaryRow(name, s, sep));
    }
    res.table = table;
    // Round 48: every point, the certain ones (p = 0 / 1) included — a candidate that softens the conventions moves points between the two tables.
    L.push('', '**全部點（含確定點；對數損失把 p 夾在 [1e-6, 1 − 1e-6]）**：', '', '| 範圍 | 點數 | Brier | 對數損失 nats | ECE pp |', '|---|---|---|---|---|');
    const allRows: Record<string, { n: number; brier: number; logLoss: number; ece: number }> = {};
    for (const r of ['全部', 'R1', 'R2', 'R3', 'R4', 'R5']) {
      const s = summarize(pick(st, (vv, _w, rr) => vv === v && (r === '全部' || rr === r)));
      if (!s.n) continue;
      allRows[r] = { n: s.n, brier: s.brier, logLoss: s.logLoss, ece: s.ece };
      L.push(`| ${r} | ${s.n} | ${f4(s.brier)} | ${f3(s.logLoss)} | ${pc(s.ece, 2)} |`);
    }
    res.allPoints = allRows;
    // 忠臣的可靠度圖（藍方決策最多的視角）
    const loyal = summarize(pick(st, (vv, ww, _r, _s, c) => vv === v && ww === 'loyal' && c === 'u'));
    L.push('', '**忠臣視角的可靠度圖**：', '', '| p 格 | 點數 | 平均 p % | 真紅比例 %（Wilson 95%） |', '|---|---|---|---|');
    for (const b of loyal.bins) L.push(`| ${pc(b.lo, 0)}–${pc(b.hi, 0)}% | ${b.n} | ${pc(b.meanP)} | ${pc(b.freq)} [${pc(b.ciLo)}, ${pc(b.ciHi)}] |`);
    res.loyal = loyal;
    out[v] = res;
  }
  return { md: L.join('\n'), json: out };
}

export const newStore = (): Store => ({ acc: {}, certainWrong: {}, certainWrongConvention: {}, games: 0, points: 0 });

export function loadHuman(file?: string): { game: ReplayGame; s: number | null }[] {
  const root = path.resolve(__dirname, '..');
  const dataset = JSON.parse(fs.readFileSync(file ?? arg('--dataset') ?? path.join(root, 'games_cache.json'), 'utf8')) as DatasetHeader & { games: readonly DatasetTuple[] };
  return replayGamesFromDataset(dataset).games.filter((g) => g.game.playerCount === 10).map((g) => ({ game: g.game, s: g.s }));
}

function main(): void {
  const strongS = Number(arg('--strong-s') ?? DEFAULT_COHORT_CUTS.sHi); // 高端桌：網站分組的 S 上切點（第 1G 節）
  const viewersList = (arg('--viewers') ?? 'loyal,percival,merlin').split(',').filter(Boolean);
  const mergeAt = argv.indexOf('--merge');
  const st = newStore();
  let names: string[];
  let meta: Record<string, unknown>;
  if (mergeAt >= 0) {
    const files = argv.slice(mergeAt + 1).filter((x, i, all) => !x.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
    names = [];
    meta = {};
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { store: Store; names: string[]; meta: Record<string, unknown> };
      for (const [k, a] of Object.entries(j.store.acc)) st.acc[k] = st.acc[k] ? mergeAcc(st.acc[k], a) : a;
      for (const [k, n] of Object.entries(j.store.certainWrong)) st.certainWrong[k] = (st.certainWrong[k] ?? 0) + n;
      for (const [k, n] of Object.entries(j.store.certainWrongConvention ?? {})) st.certainWrongConvention[k] = (st.certainWrongConvention[k] ?? 0) + n;
      st.games += j.store.games;
      st.points += j.store.points;
      names = j.names;
      meta = j.meta;
    }
  } else {
    const vs = variants();
    names = vs.map((v) => v.name);
    const limit = arg('--limit') !== undefined ? Number(arg('--limit')) : undefined;
    const games = loadHuman().slice(0, limit);
    const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
    // Round 48: --split train = the even-indexed games (where `beliefRecalib` was fitted), test = the odd-indexed ones (held out).
    const split = arg('--split') ?? 'all';
    const keep = (gi: number): boolean => (split === 'train' ? gi % 2 === 0 : split === 'test' ? gi % 2 === 1 : true);
    const viewers = new Set(viewersList);
    const started = Date.now();
    games.forEach((g, gi) => {
      if (!keep(gi) || gi % n !== k) return;
      evalGame(g.game, g.s !== null && g.s >= strongS, vs, viewers, st);
      if (st.games % 100 === 0) process.stderr.write(`[calib ${k}/${n}] ${st.games} games, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    });
    meta = { source: `games_cache.json 真人局（datasetReplay 嚴格重播${split === 'train' ? '，偶數序號的局' : split === 'test' ? '，奇數序號的局（第 48 回合的驗證組）' : ''}）`, viewers: viewersList.map((w) => ROLE_LABEL[w] ?? w).join('、'), strongS, flags: argv.filter((_, i) => argv[i - 1] === '--flag'), seconds: Math.round((Date.now() - started) / 1000) };
    const raw = arg('--raw');
    if (raw) fs.writeFileSync(raw, JSON.stringify({ store: st, names, meta }));
  }
  const { md, json } = report(st, names, meta);
  console.log(md);
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(json, null, 1));
  const mdOut = arg('--md');
  if (mdOut) fs.writeFileSync(mdOut, md);
}

if (require.main === module) main();
