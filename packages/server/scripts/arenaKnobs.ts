/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * AI 擂台開關白名單的兩件事（`src/arena/knobs.ts`）：
 *
 *   pnpm --filter @avalon/server arena:knobs --table
 *     印 README 用的開關表（繁中、English）。
 *
 *   pnpm --filter @avalon/server arena:knobs --live [--games 16] [--seed arena-knobs] [--only 開關,開關]
 *     量每個開關「改了會不會真的改變打法」：10 個座位都用「只改這一個開關」的機器人，
 *     和 10 個百科AI 打同樣 N 局（同樣座位、角色、共同亂數），數有幾局的公開紀錄（派隊、投票、任務、湖、刺殺）不一樣。
 *     0 局不一樣 = 這個開關在正式路徑上沒作用，不該放進白名單。
 */
import { DEFAULT_AGENT_TUNING } from '../src/ai/AgentTuning';
import { SelfPlayEngine } from '../src/ai/SelfPlayEngine';
import { ARENA_KNOBS, type Knob } from '../src/arena/knobs';
import { PROFILE_SCHEMA_VERSION, type BotProfile, type KnobValues } from '../src/arena/profile';
import { playTable, quietly, type Entrant } from '../src/arena/table';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

/** 量測用的值：布林取反；數字取離預設最遠的一端。少數開關要搭配別的開關才有作用。 */
export function testSetting(knob: Knob): KnobValues {
  const def = (DEFAULT_AGENT_TUNING as unknown as Record<string, number | boolean>)[knob.key];
  const v: KnobValues = {};
  if (knob.kind === 'boolean') v[knob.key] = !def;
  else v[knob.key] = Math.abs(knob.max - Number(def)) >= Math.abs(Number(def) - knob.min) ? knob.max : knob.min;
  return v;
}

function fmtDefault(knob: Knob): string {
  const def = (DEFAULT_AGENT_TUNING as unknown as Record<string, number | boolean>)[knob.key];
  return String(def);
}

const SIDE_ZH: Record<Knob['side'], string> = { evil: '紅方', good: '藍方', assassin: '刺客' };
const SIDE_EN: Record<Knob['side'], string> = { evil: 'Red', good: 'Blue', assassin: 'Assassin' };

export function knobTableZh(): string {
  const rows = ARENA_KNOBS.map((k) => {
    const range = k.kind === 'boolean' ? 'true / false' : `${k.min} – ${k.max}`;
    return `| ${SIDE_ZH[k.side]} | \`${k.key}\` | ${range} | ${fmtDefault(k)} | ${k.zh} | ${k.zhUp} ${k.zhDown} |`;
  });
  return ['| 陣營 | 開關 | 範圍 | 百科AI 預設 | 白話說明 | 往上／往下 |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

export function knobTableEn(): string {
  const rows = ARENA_KNOBS.map((k) => {
    const range = k.kind === 'boolean' ? 'true / false' : `${k.min} – ${k.max}`;
    return `| ${SIDE_EN[k.side]} | \`${k.key}\` | ${range} | ${fmtDefault(k)} | ${k.en} |`;
  });
  return ['| Side | Knob | Range | Default | Meaning |', '|---|---|---|---|---|', ...rows].join('\n');
}

async function live(): Promise<void> {
  const games = Number(arg('--games') ?? 16);
  const seed = arg('--seed') ?? 'arena-knobs';
  const engine = new SelfPlayEngine();
  const baike: Entrant = { id: 'baike', profile: null };
  const base: string[] = [];
  await quietly(async () => {
    for (let i = 0; i < games; i++) base.push((await playTable(engine, Array(10).fill(baike), `${seed}|${i}`)).fingerprint);
  });
  console.log(`| 開關 | 量測值 | ${games} 局裡打法不同的局數 |`);
  console.log('|---|---|---|');
  let dead = 0;
  const only = arg('--only')?.split(',');
  for (const knob of ARENA_KNOBS) {
    if (only && !only.includes(knob.key)) continue;
    const setting = testSetting(knob);
    const profile: BotProfile = { schema: PROFILE_SCHEMA_VERSION, name: knob.key, author: 'arena', style: 'liveness', overrides: setting };
    const variant: Entrant = { id: knob.key, profile };
    let diff = 0;
    await quietly(async () => {
      for (let i = 0; i < games; i++) {
        const r = await playTable(engine, Array(10).fill(variant), `${seed}|${i}`);
        if (r.fingerprint !== base[i]) diff++;
      }
    });
    if (diff === 0) dead++;
    console.log(`| \`${knob.key}\` | ${Object.entries(setting).map(([k, v]) => `${k}=${v}`).join(', ')} | ${diff} |`);
  }
  console.log(dead === 0 ? '\n每個開關都會改變打法。' : `\n${dead} 個開關在 ${games} 局裡沒有改變任何打法。`);
}

async function main(): Promise<void> {
  if (argv.includes('--table')) {
    console.log(knobTableZh());
    console.log('');
    console.log(knobTableEn());
    return;
  }
  if (argv.includes('--live')) { await live(); return; }
  console.log('用法：arena:knobs --table | --live [--games 16]');
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}
