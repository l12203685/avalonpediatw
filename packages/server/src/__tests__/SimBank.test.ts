/**
 * 模擬瓦（2026-10-14）— 題庫：格式、題號、篩選、沒有名字和日期，以及對 commit 進來的
 * `sim_bank.json` 跑的性質測試（慢，跟 benchmark.test.ts 一樣讀真資料）：
 *   每個決定點真正的紅方都還在世界裡、每則回覆 ≤ 1800 字、只有預期的字元。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseReplayGame, type ReplayGame } from '../ai/benchmark/sheetsReplay';
import { buildSimBank, readSimBankFile, SimBankLoader } from '../bots/simulation/bank';
import {
  assignIds,
  bankEntryFor,
  buildBankFile,
  crockfordBase32,
  parseBankEntry,
  recordFingerprint,
  serialiseRecord,
  type SimBankFile,
} from '../bots/simulation/bankCodec';
import { SIM_REPLY_MAX_CHARS } from '../bots/simulation/config';
import { logicModel } from '../bots/simulation/logic';
import { SimEngine } from '../bots/simulation/session';
import {
  decisionsOf,
  eventIndexOfProposal,
  exerciseIdOf,
  firstDecision,
  publicEvents,
  viewAt,
} from '../bots/simulation/scenario';
import { maskOf, teamDigits } from '../bots/simulation/seats';
import { builderRows, FAKE_DATE, FAKE_NAMES, FAKE_NOTE, shortRow, wikiRow } from './fixtures/simGames';

const BANK_PATH = path.resolve(__dirname, '..', '..', 'sim_bank.json');

function game(row: ReturnType<typeof wikiRow>): ReplayGame {
  const r = parseReplayGame(row);
  if (!r.ok) throw new Error(r.reason);
  return r.game;
}

/** 名字、流水號以外的欄位。 */
function comparable(g: ReplayGame): Omit<ReplayGame, 'names' | 'id'> {
  const rest: Partial<ReplayGame> = { ...g };
  delete rest.names;
  delete rest.id;
  return rest as Omit<ReplayGame, 'names' | 'id'>;
}

const FORBIDDEN = [...FAKE_NAMES, FAKE_DATE, '2025/12/31', FAKE_NOTE, 'T-0001', 'T-0002', 'T-0005'];

describe('bank codec', () => {
  it('round trip: parse(serialise(g)) ≡ g, names and the sheet id aside', () => {
    for (const row of [wikiRow(), shortRow()]) {
      const g = game(row);
      const entry = bankEntryFor(g, 'ABCDE');
      const back = parseBankEntry(entry);
      expect(back.ok).toBe(true);
      if (back.ok) {
        expect(comparable(back.game)).toEqual(comparable(g));
        expect(back.game.id).toBe('ABCDE');
        expect(back.game.names.every((n) => n === '')).toBe(true);
      }
      expect(entry.rec).toMatch(/^[0-9ox+\-> \n]+$/);
    }
  });

  it('the record is the canonical 牌譜, quests as o…x, lakes as H>T o|x', () => {
    expect(serialiseRecord(game(wikiRow()))).toBe(
      [
        '460 1+', '279', '370', '469', '157', 'oox', '1246', '3579', '2468', '4689', '1460', 'oooo', '0>4 o',
        '1246', '1257', '3579', '1468 20+', 'oooo', '4>3 x', '13579', '12468 0+', 'ooooo',
      ].join('\n'),
    );
    expect(recordFingerprint(game(wikiRow()))).toBe(
      '753921|460,279,370,469,157,1246,3579,2468,4689,1460,1246,1257,3579,1468,13579,12468|oox,oooo,oooo,ooooo',
    );
  });

  it('Crockford base32 and ids: 5 chars, extended together on a collision', () => {
    expect(crockfordBase32(new Uint8Array([0xff, 0xff]))).toBe('ZZZG');
    expect(crockfordBase32(new Uint8Array([0, 0, 0]))).toBe('00000');
    expect(assignIds(['ABCDE111', 'ABCDE222', 'XYZ00000'])).toEqual(['ABCDE1', 'ABCDE2', 'XYZ00']);
  });

  it('rejects entries with characters outside the record alphabet', () => {
    const entry = bankEntryFor(game(wikiRow()), 'ABCDE');
    expect(parseBankEntry({ ...entry, rec: `${entry.rec}\n1.${FAKE_NAMES[0]}` }).ok).toBe(false);
  });
});

describe('buildBankFile', () => {
  const { file, counts } = buildBankFile(builderRows());

  it('keeps strict-replay, valid-lake, non-娛樂 games once', () => {
    expect(counts).toEqual({ rows: 7, recorded: 6, replayable: 5, lakeChainInvalid: 1, entertainment: 1, duplicates: 1, games: 2, idCollisions: 0 });
    expect(file.games.map((g) => g.cfg).sort()).toEqual(['128064', '753921']);
  });

  it('no names, dates, notes or sheet ids anywhere in the bank', () => {
    const json = JSON.stringify(file);
    for (const s of FORBIDDEN) expect(json).not.toContain(s);
    expect(Object.keys(file.games[0]).sort()).toEqual(['cfg', 'id', 'kill', 'rec', 'res']);
  });

  it('ids are stable, unique, independent of row order and of the 流水號; games sorted by id', () => {
    const reordered = buildBankFile([...builderRows()].reverse().map((r, i) => ({ ...r, 流水號: `X-${i}` }))).file;
    expect(reordered).toEqual(file);
    const ids = file.games.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{5}$/.test(id))).toBe(true);
  });

  it('the server bank has no names field and drops broken or duplicate-id entries (counted)', () => {
    const broken: SimBankFile = { ...file, games: [...file.games, { ...file.games[0] }, { ...file.games[1], id: 'ZZZZZ', rec: 'garbage' }] };
    const bank = buildSimBank(broken);
    expect(bank.games).toHaveLength(2);
    expect(bank.dropped).toBe(2);
    expect(bank.games.every((g) => !('names' in g))).toBe(true);
    for (const s of FORBIDDEN) expect(JSON.stringify(bank.games)).not.toContain(s);
  });
});

describe('loader', () => {
  it('a missing file → not loaded (fixed log text only)', async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => { warns.push(String(m)); };
    try {
      expect(readSimBankFile(['/nonexistent/sim_bank.json'])).toBeNull();
    } finally {
      console.warn = orig;
    }
    expect(warns).toEqual(['[sim] sim_bank.json not found; /模擬 answers 題庫還沒準備好']);
    const loader = new SimBankLoader(() => null);
    expect(await loader.get()).toBeNull();
    expect(loader.status()).toEqual({ loaded: false, games: 0, dropped: 0, decisionPoints: 0 });
  });
});

// ─── The committed bank ────────────────────────────────────────────────────

const ALLOWED = /^[\p{Script=Han}0-9A-Za-z \u3000\n①②③④—・｜、，。：；（）「」【】＋＞＝→✓✗…*%/／\-+.<>=`]+$/u;

describe('committed sim_bank.json (property test over the real bank)', () => {
  const file = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8')) as SimBankFile;
  const bank = buildSimBank(file);

  it('loads strictly: every entry parses, ids unique, sorted, record alphabet only, no extra fields', () => {
    expect(bank.games.length).toBeGreaterThan(1000);
    expect(bank.dropped).toBe(0);
    const ids = file.games.map((g) => g.id);
    expect([...ids].sort()).toEqual(ids);
    for (const e of file.games) {
      expect(Object.keys(e).sort()).toEqual(['cfg', 'id', 'kill', 'rec', 'res']);
      expect(e.rec).toMatch(/^[0-9ox+\-> \n]+$/);
      const back = parseBankEntry(e);
      expect(back.ok && serialiseRecord(back.game)).toBe(e.rec);
    }
  });

  it('the true red set is consistent at every decision point of every seat', () => {
    let points = 0;
    for (const g of bank.games) {
      const events = publicEvents(g);
      const truth = maskOf(g.seatRoles.map((r, i) => (['assassin', 'morgana', 'mordred', 'oberon'].includes(r) ? i + 1 : 0)).filter(Boolean));
      for (let seat = 1; seat <= 10; seat++) {
        for (const d of decisionsOf(g, seat)) {
          const worlds = logicModel.worlds(viewAt(g, seat, eventIndexOfProposal(events, d), events));
          if (!worlds.some((w) => w.redMask === truth)) throw new Error(`truth dropped at ${g.id} seat ${seat} proposal ${d}`);
          points++;
        }
      }
    }
    expect(points).toBe(bank.decisionPoints);
  });

  it('every reply of every exercise (each seat of each game, all its decisions) fits 1800 characters and uses only expected characters', async () => {
    let now = 1_000_000;
    const engine = new SimEngine({ bank: async () => bank, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    let replies = 0;
    let longest = 0;
    let starts = 0;
    for (let gi = 0; gi < bank.games.length; gi++) {
      const g = bank.games[gi];
      for (let seat = 1; seat <= 10; seat++) {
        // 每一局每一家都跑 LINE；Discord（多了 code block）每 4 局跑一次。
        for (const platform of gi % 4 === 0 ? (['line', 'discord'] as const) : (['line'] as const)) {
          const req = { platform, chatId: 'C', userId: `U${seat}` };
          const run = async (cmd: string): Promise<string | null> => {
            // 回傳回覆的種類（不是文字）。
            now += 1000;
            const r = await engine.handleText(cmd, req);
            if (!r) return null;
            r.commit();
            replies++;
            longest = Math.max(longest, r.text.length);
            expect(r.text.length).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
            if (!ALLOWED.test(r.text)) {
              const bad = [...r.text].filter((ch) => !ALLOWED.test(ch)).map((ch) => `U+${ch.codePointAt(0)?.toString(16)}`);
              throw new Error(`unexpected character ${bad.join(',')} in a reply for ${g.id}-${seat}`);
            }
            return r.kind;
          };
          if ((await run(`/模擬 題 ${exerciseIdOf(g.id, seat)}`)) !== 'start') continue;
          starts++;
          for (const d of decisionsOf(g, seat)) {
            if (d < (firstDecision(g, seat) ?? 0)) continue;
            await run(`/派 ${teamDigits(g.proposals[d].teamSeats)}`);
            await run('/區間 789=2 460=1');
            await run('/下一步');
          }
          await run('/公布');
        }
      }
    }
    expect(starts).toBeGreaterThan(15_000);
    expect(replies).toBeGreaterThan(100_000);
    expect(longest).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
  }, 300_000);
});
