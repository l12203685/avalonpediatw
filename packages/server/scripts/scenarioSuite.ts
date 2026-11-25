/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 情境題庫（第 74 回合）：一批有正確答案的局面，丟給百科AI 作答，印每一題、每一類過不過。
 *
 *   cd packages/server
 *   npx tsx scripts/scenarioSuite.ts                       # 自己寫的題目（fixtures.json），基準線＋真人桌各跑一次
 *   npx tsx scripts/scenarioSuite.ts --bank                # 再加每日一題題庫的全部題目（慢：約 9 千題 × 2 套）
 *   npx tsx scripts/scenarioSuite.ts --bank --bank-class thumb,kill --shard 0/2 --dump out0.jsonl
 *   npx tsx scripts/scenarioSuite.ts --report out0.jsonl out1.jsonl [--md report.md]     # 把存下來的結果合起來印表
 *   npx tsx scripts/scenarioSuite.ts --compare base.jsonl cand.jsonl                      # 同一批題目兩次結果的差（以局為單位的 95% 區間）
 *
 * 選項：--seeds N（自己寫的題目每題幾個種子，預設 5；題庫的題目固定用每日一題的種子）、--profile ai,avgHuman（預設兩個都跑）、
 *       --flag 開關=值（疊在每一套上面，可以寫很多個）、--only 題號或類別的開頭、--no-fixtures、--limit N、--quiet（不印每一題）。
 * 結束碼：只有硬規則的題目（fixtures 裡 hard: true，A0、A1 與寫死的裁定）不過才是 1；其他類別只報數字。
 * 輸出只有座位與題號，沒有玩家名字。
 */
import fs from 'fs';
import path from 'path';
import { DEFAULT_AGENT_TUNING, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { percivalRead39 } from '../src/ai/BlueRound39Percival';
import { seededRandom } from '../src/ai/benchmark/agreement';
import { seatId } from '../src/ai/benchmark/replayObservation';
import { EVIL_ROLES } from '../src/ai/benchmark/sheetsReplay';
import { parseOpponentType, tuningForOpponent, OPPONENT_LABEL, type OpponentType } from '../src/ai/humanProfile';
import { buildSimBank, readSimBankFile } from '../src/bots/simulation/bank';
import { BANK_CLASSES, bankScenarios, type BankClass } from '../src/ai/scenarios/bankScenarios';
import {
  answerScenario, buildScenario, checkAnswer, observationOf, recordText, runScenario, seatDiagram, validateFile,
  type ScenarioAnswer, type ScenarioFile, type ScenarioFixture,
} from '../src/ai/scenarios/scenarioSuite';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): boolean => argv.includes(name);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const args = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
const rest = (name: string): string[] => {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
};

/** 存下來的一列（一題 × 一套參數）。 */
interface Row {
  id: string;
  cls: string;
  hard: boolean;
  profile: string;
  /** 0–1。 */
  pass: number;
  /** 題庫的題目：真人過不過同一條檢查。 */
  human?: boolean | null;
  text: string;
  why: string[];
  /** 題庫的局（以局為單位算區間用）。 */
  game?: string;
  /** 分析用的欄位（拇指題：兩根拇指的 P(紅)、擬合讀法、梅林有沒有出過失敗的任務…）。 */
  x?: Record<string, number | string | boolean | null>;
}

const CLASS_LABEL: Record<string, string> = {
  A0: '硬規則 A0：好人持湖說實話',
  A1: '硬規則 A1：紅方已兩勝，紅一定出失敗',
  ruling: '站長寫死的裁定',
  owner: '站長的糾正與標註',
  wiki: '百科原則（還沒做的列）',
  otherAi: '其他 AI 的提案',
  r78: '紅方的任務牌（第 78 回合的量測）',
  ...Object.fromEntries(Object.entries(BANK_CLASSES).map(([k, v]) => [`bank:${k}`, v])),
};
const labelOf = (cls: string): string => CLASS_LABEL[cls] ?? cls;
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

// ─── 合併結果、印表 ───────────────────────────────────────────────────────

function readRows(files: readonly string[]): Row[] {
  const rows: Row[] = [];
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) rows.push(JSON.parse(line) as Row);
  return rows;
}

function classTable(rows: readonly Row[]): string {
  const profiles = [...new Set(rows.map((r) => r.profile))];
  const classes = [...new Set(rows.map((r) => r.cls))];
  const lines = [`| 類別 | 題數 | ${profiles.map((p) => `${p} 過`).join(' | ')} | 真人當時 |`, `|---|---|${profiles.map(() => '---').join('|')}|---|`];
  for (const cls of classes) {
    const of = (p: string): Row[] => rows.filter((r) => r.cls === cls && r.profile === p);
    const first = of(profiles[0]);
    const cells = profiles.map((p) => {
      const rs = of(p);
      return rs.length ? pct(rs.reduce((a, r) => a + r.pass, 0) / rs.length) : '—';
    });
    const hum = first.filter((r) => r.human === true || r.human === false);
    lines.push(`| ${labelOf(cls)}${first.some((r) => r.hard) ? '（硬）' : ''} | ${first.length} | ${cells.join(' | ')} | ${hum.length ? pct(hum.filter((r) => r.human).length / hum.length) : '—'} |`);
  }
  return lines.join('\n');
}

/** 以局（題庫的局；自己寫的題目一題一組）為單位的自助法 95% 區間。 */
function bootDiff(pairs: readonly { g: string; d: number }[], n = 2000): [number, number] {
  const groups = new Map<string, number[]>();
  for (const p of pairs) { const a = groups.get(p.g); if (a) a.push(p.d); else groups.set(p.g, [p.d]); }
  const gs = [...groups.values()];
  const rnd = seededRandom('scenarioSuite|round74');
  const means: number[] = [];
  for (let b = 0; b < n; b++) {
    let s = 0; let c = 0;
    for (let i = 0; i < gs.length; i++) { const g = gs[Math.floor(rnd() * gs.length)]; for (const d of g) { s += d; c += 1; } }
    means.push(c ? s / c : 0);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * n)], means[Math.floor(0.975 * n)]];
}

function compare(baseFile: string, candFile: string): void {
  // 兩次結果用「哪一套（去掉 ＋開關 的部分）＋題號」對起來。
  const bare = (profile: string): string => profile.split('＋')[0];
  const base = new Map(baseFile.split(',').flatMap((f) => readRows([f])).map((r) => [`${bare(r.profile)}|${r.id}`, r]));
  const cand = candFile.split(',').flatMap((f) => readRows([f])).map((r) => ({ ...r, profile: bare(r.profile) }));
  const keys = [...new Set(cand.map((r) => `${r.profile}|${r.cls}`))];
  console.log('| 套 | 類別 | 題數 | 前 | 後 | 差 [95%] | 變對／變錯 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const [profile, cls] = k.split('|');
    const pairs = cand.filter((r) => r.profile === profile && r.cls === cls).flatMap((r) => { const b = base.get(`${r.profile}|${r.id}`); return b ? [{ b, c: r }] : []; });
    if (!pairs.length) continue;
    const mb = pairs.reduce((a, p) => a + p.b.pass, 0) / pairs.length;
    const mc = pairs.reduce((a, p) => a + p.c.pass, 0) / pairs.length;
    const [lo, hi] = bootDiff(pairs.map((p) => ({ g: p.c.game ?? p.c.id, d: p.c.pass - p.b.pass })));
    const up = pairs.filter((p) => p.c.pass > p.b.pass).length;
    const down = pairs.filter((p) => p.c.pass < p.b.pass).length;
    console.log(`| ${profile} | ${labelOf(cls)} | ${pairs.length} | ${pct(mb)} | ${pct(mc)} | ${(100 * (mc - mb)).toFixed(2)} [${(100 * lo).toFixed(2)}, ${(100 * hi).toFixed(2)}] | ${up}／${down} |`);
  }
}

// ─── 跑題目 ──────────────────────────────────────────────────────────────

function profilesOf(): { name: string; tuning: AgentTuning }[] {
  const flags = args('--flag');
  const overlay: Partial<AgentTuning> = {};
  for (const f of flags) Object.assign(overlay, parseTuningFlag(f));
  const names = arg('--profile', 'ai,avgHuman').split(',').filter(Boolean);
  return names.map((n) => {
    const type: OpponentType | null = parseOpponentType(n);
    if (!type) throw new Error(`不認得的對手類型：${n}`);
    const label = `${type === 'ai' ? '基準線' : OPPONENT_LABEL[type]}${flags.length ? `＋${flags.join('＋')}` : ''}`;
    return { name: label, tuning: { ...tuningForOpponent(type, DEFAULT_AGENT_TUNING), ...overlay } as AgentTuning };
  });
}

/** 拇指題的分析欄位：只用派西看得到的紀錄＋事後的角色來分類。 */
function thumbExtras(s: ReturnType<typeof bankScenarios>[number], ans: ScenarioAnswer): Row['x'] {
  const g = s.game;
  const obs = observationOf(s);
  const merlin = g.seatRoles.indexOf('merlin') + 1;
  const morgana = g.seatRoles.indexOf('morgana') + 1;
  const mordred = g.seatRoles.indexOf('mordred') + 1;
  const quests = obs.questHistory;
  const failed = quests.filter((q) => q.result === 'fail');
  const on = (seat: number, qs: typeof quests): number => qs.filter((q) => q.team.includes(seatId(seat))).length;
  const read = percivalRead39(obs);
  const pReadMerlin = read ? (read.thumbs[0] === seatId(merlin) ? read.pFirst : 1 - read.pFirst) : null;
  const round = obs.currentRound;
  return {
    round,
    attempt: (obs.failCount ?? 0) + 1,
    pMerlinRed: ans.pRed ? ans.pRed[merlin - 1] : null,
    pReadMerlin,
    merlinOnFail: on(merlin, failed),
    morganaOnFail: on(morgana, failed),
    merlinOnSucc: on(merlin, quests) - on(merlin, failed),
    morganaOnSucc: on(morgana, quests) - on(morgana, failed),
    merlinWithMordredOnFail: failed.filter((q) => q.team.includes(seatId(merlin)) && q.team.includes(seatId(mordred))).length,
    merlinFailNoMorgana: failed.filter((q) => q.team.includes(seatId(merlin)) && !q.team.includes(seatId(morgana))).length,
    teamHasMerlin: ans.team ? ans.team.includes(merlin) : null,
    teamHasMorgana: ans.team ? ans.team.includes(morgana) : null,
  };
}

/** `--diagram 題號,題號`：每一題的牌譜、座位圖、百科AI（每一套）的答案和正確答案，Markdown。題庫的題號寫 `thumb:TMQ2M-3-4` 這種。 */
function diagrams(ids: readonly string[]): void {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'src/ai/scenarios/fixtures.json'), 'utf8')) as ScenarioFile;
  const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
  const all = bankFile ? bankScenarios(buildSimBank(bankFile)) : [];
  const profiles = profilesOf();
  for (const id of ids) {
    let fx = file.scenarios.find((x) => x.id === id);
    let built: Parameters<typeof observationOf>[0] | undefined;
    let human = '';
    if (fx && !fx.bank) built = buildScenario(fx);
    else {
      const s = all.find((x) => (fx ? x.fixture.bank === fx.bank : x.fixture.id === id));
      if (!s) { console.log(`（找不到 ${id}）`); continue; }
      built = s;
      human = s.humanText;
      fx = fx ?? s.fixture;
    }
    console.log(`#### ${fx.id}｜${fx.title}\n`);
    console.log(`出處：${fx.source}\n`);
    const rec = recordText(built);
    if (rec) console.log(`${rec.split('\n').map((l) => `- ${l}`).join('\n')}\n`);
    const answers = profiles.map((p) => ({ p, ans: answerScenario(built as NonNullable<typeof built>, p.tuning, '') }));
    console.log(`${seatDiagram(built, answers[answers.length - 1].ans)}\n`);
    for (const { p, ans } of answers) {
      const why = fx.expect.map((c) => checkAnswer(built as NonNullable<typeof built>, ans, c)).filter(Boolean);
      console.log(`- ${p.name}：${ans.text} → ${why.length ? `不過（${why.join('；')}）` : '過'}`);
    }
    if (human) console.log(`- ${human}`);
    if (fx.note) console.log(`- 說明：${fx.note}`);
    console.log('');
  }
}

function main(): void {
  const report = rest('--report');
  if (report.length) {
    const table = classTable(readRows(report));
    console.log(table);
    const md = arg('--md', '');
    if (md) fs.writeFileSync(md, `${table}\n`);
    return;
  }
  const cmp = rest('--compare');
  if (cmp.length === 2) { compare(cmp[0], cmp[1]); return; }
  const dia = arg('--diagram', '');
  if (dia) { diagrams(dia.split(',')); return; }

  const quiet = flag('--quiet');
  const only = arg('--only', '');
  const limit = Number(arg('--limit', '0'));
  const seeds = Array.from({ length: Math.max(1, Number(arg('--seeds', '5'))) }, (_, i) => (i === 0 ? '' : `s${i}`));
  const [shardI, shardN] = arg('--shard', '0/1').split('/').map(Number);
  const profiles = profilesOf();
  const rows: Row[] = [];
  const dumpPath = arg('--dump', '');
  const dump = dumpPath ? fs.openSync(dumpPath, 'w') : null;
  const push = (r: Row): void => { rows.push(r); if (dump !== null) fs.writeSync(dump, `${JSON.stringify(r)}\n`); };
  const keep = (fx: ScenarioFixture): boolean => !only || fx.id.startsWith(only) || fx.cls.startsWith(only);

  if (!flag('--no-fixtures')) {
    const file = JSON.parse(fs.readFileSync(path.resolve(arg('--fixtures', path.join(root, 'src/ai/scenarios/fixtures.json'))), 'utf8')) as ScenarioFile;
    validateFile(file);
    const own = file.scenarios.filter((fx) => !fx.bank && keep(fx));
    for (const fx of own) {
      const built = buildScenario(fx);
      for (const p of profiles) {
        const r = runScenario(fx, built, p.tuning, seeds);
        push({ id: fx.id, cls: fx.cls, hard: r.hard, profile: p.name, pass: r.pass, text: r.answer.text, why: r.why });
        if (!quiet) console.log(`${r.pass === 1 ? '過  ' : r.pass === 0 ? '不過' : `${Math.round(r.pass * seeds.length)}/${seeds.length} `} [${p.name}] ${fx.id}｜${fx.title} → ${r.answer.text}${r.why.length ? `（${r.why.join('；')}）` : ''}`);
      }
    }
    // 題目檔裡用題號指到題庫的題目（站長標註過的那幾題）：照它自己寫的答案對。
    const pinned = file.scenarios.filter((fx) => fx.bank && keep(fx));
    if (pinned.length) {
      const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
      if (!bankFile) throw new Error('sim_bank.json 讀不到');
      const bank = buildSimBank(bankFile);
      const all = bankScenarios(bank);
      for (const fx of pinned) {
        const s = all.find((x) => x.fixture.bank === fx.bank && (fx.ask?.kind === 'kill') === (x.point.kind === 'assassination'));
        if (!s) throw new Error(`${fx.id}: 題庫裡沒有 ${fx.bank}`);
        for (const p of profiles) {
          const ans = answerScenario(s, p.tuning, '');
          const why = fx.expect.map((c) => checkAnswer(s, ans, c)).filter(Boolean);
          push({ id: fx.id, cls: fx.cls, hard: fx.hard === true, profile: p.name, pass: why.length ? 0 : 1, text: ans.text, why, game: s.game.id });
          if (!quiet) console.log(`${why.length ? '不過' : '過  '} [${p.name}] ${fx.id}｜${fx.title} → ${ans.text}${why.length ? `（${why.join('；')}）` : ''}`);
        }
      }
    }
  }

  if (flag('--bank')) {
    const bankFile = readSimBankFile([path.join(root, 'sim_bank.json')]);
    if (!bankFile) throw new Error('sim_bank.json 讀不到');
    const bank = buildSimBank(bankFile);
    const want = arg('--bank-class', '');
    const onlyCls = want ? new Set(want.split(',') as BankClass[]) : undefined;
    let list = bankScenarios(bank, onlyCls).filter((s) => keep(s.fixture));
    list = list.filter((_, i) => i % shardN === shardI);
    if (limit > 0) list = list.slice(0, limit);
    const t0 = Date.now();
    list.forEach((s, i) => {
      for (const p of profiles) {
        // 拇指題和派西的隊是同一個決策點：答案只算一次不划算（兩題各自有種子一樣的答案），直接各算各的。
        const ans = answerScenario(s, p.tuning, '');
        const why = s.fixture.expect.map((c) => checkAnswer(s, ans, c)).filter(Boolean);
        const x = s.fixture.cls === 'bank:thumb' ? thumbExtras(s, ans) : { round: observationOf(s).currentRound, role: s.game.seatRoles[s.seat - 1], reds: ans.team ? ans.team.filter((t) => EVIL_ROLES.has(s.game.seatRoles[t - 1])).length : null };
        push({ id: s.fixture.id, cls: s.fixture.cls, hard: false, profile: p.name, pass: why.length ? 0 : 1, human: s.humanPass, text: `${ans.text}${s.humanText ? `；${s.humanText}` : ''}`, why, game: s.game.id, x });
      }
      if (!quiet && (i + 1) % 200 === 0) console.error(`題庫 ${i + 1}/${list.length}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    });
  }
  if (dump !== null) fs.closeSync(dump);

  console.log(`\n${classTable(rows)}`);
  const hardFails = rows.filter((r) => r.hard && r.pass < 1);
  if (hardFails.length) {
    console.log(`\n硬規則不過 ${hardFails.length} 題：`);
    for (const r of hardFails) console.log(`  [${r.profile}] ${r.id} → ${r.text}（${r.why.join('；')}）`);
    process.exitCode = 1;
  } else {
    console.log('\n硬規則的題目全部通過。');
  }
}

main();
