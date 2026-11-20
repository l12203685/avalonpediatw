/**
 * 模擬瓦題庫改從牌譜總庫 game_db.json 建（站長 2026-11-20「整個系統要完全同步同來源」）：
 * 來源的篩選、牌譜文字的往返、上一版題號沿用、commit 進來的題庫跟總庫同步，以及重建時 Threads 計畫的釘選。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { ReplayGame } from '../ai/benchmark/sheetsReplay';
import { buildSimBank } from '../bots/simulation/bank';
import { assignIds, bankEntryFor, buildBankFile, recordFingerprint, type SimBankFile } from '../bots/simulation/bankCodec';
import { recordTextOf, rowsFromGameDb } from '../bots/simulation/bankSource';
import { seatChar } from '../bots/simulation/seats';
import { ThreadsGenerator } from '../bots/threads/generate';
import { addDays, exerciseIdOfPick } from '../bots/threads/plan';
import { pickOverrideOf } from '../bots/threads/picksFile';
import { planPins } from '../bots/threads/planPins';
import { builderRows, parsedGame, shortRow, wikiRow } from './fixtures/simGames';

const SERVER = path.resolve(__dirname, '..', '..');
const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(SERVER, f), 'utf8'));

/** 解析後的一局 → 總庫 game 的形狀（game_db.py：每局的派票＋異常票記號、任務、湖、刺殺、結果）。 */
function dbGameOf(g: ReplayGame, res: string): Record<string, unknown> {
  const rounds = g.quests.map((q) => ({
    proposals: g.proposals.filter((p) => p.round === q.round).map((p) => ({
      team: p.teamSeats.map(seatChar).join(''),
      votes: [
        ...(p.minusSeats.length ? [`${p.minusSeats.map(seatChar).join('')}-`] : []),
        ...(p.plusSeats.length ? [`${p.plusSeats.map(seatChar).join('')}+`] : []),
      ],
    })),
    mission: 'o'.repeat(q.successCount) + 'x'.repeat(q.failCount),
  }));
  const lakes = g.lakes.map((l) => ({ after: l.round, holder: seatChar(l.holderSeat), target: seatChar(l.targetSeat), claim: l.claim === 'good' ? 'o' : l.claim === 'evil' ? 'x' : '' }));
  const config = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin'].map((r) => seatChar(g.seatRoles.indexOf(r as never) + 1)).join('');
  return { config, rounds, lakes, assassination: g.assassinTargetSeat !== undefined ? seatChar(g.assassinTargetSeat) : '', outcome: res };
}

describe('sim bank source: game_db.json', () => {
  const wiki = parsedGame(wikiRow());
  const short = parsedGame(shortRow());
  const ok = { kind: 'real', status: 'ok', game: dbGameOf(wiki, '三藍死') };

  it('writes the same record text as the bank (round trip through the strict parser)', () => {
    const { rows } = rowsFromGameDb({ games: [ok, { kind: 'real', status: 'warn', game: dbGameOf(short, '三藍活') }] });
    const { file } = buildBankFile(rows, 'game_db.json');
    expect(file.games.map((g) => g.rec).sort()).toEqual([bankEntryFor(wiki, 'X').rec, bankEntryFor(short, 'X').rec].sort());
    expect(recordTextOf(dbGameOf(wiki, '三藍死') as never)).toBe(bankEntryFor(wiki, 'X').rec);
  });

  it('keeps only real, readable, rule-abiding, played games (no 模擬, 百科AI, ProAvalon, completed, 娛樂)', () => {
    const { rows, counts } = rowsFromGameDb({
      games: [
        ok,
        { ...ok, kind: 'sim' },
        { ...ok, kind: 'bot' },
        { ...ok, external: true },
        { ...ok, status: 'error' },
        { ...ok, completed: { rounds: [4, 5], team: '12345' } },
        { kind: 'real', status: 'unreadable', game: null },
        { ...ok, legacyCategory: ['娛樂'] },
      ],
    });
    expect(counts).toEqual({ rows: 8, notReal: 2, external: 1, unreadable: 1, ruleErrors: 1, completed: 1, passed: 2 });
    const built = buildBankFile(rows, 'game_db.json');
    expect(built.counts).toMatchObject({ entertainment: 1, games: 1 });
  });
});

describe('sim bank ids stay put across rebuilds', () => {
  it('a taken id is never handed to another game; the newcomer gets a longer prefix', () => {
    expect(assignIds(['ABCDE111', 'XYZ00000'], new Set(['ABCDE']))).toEqual(['ABCDE1', 'XYZ00']);
  });

  it('a game that was in the previous bank keeps its id, whatever its hash prefix', () => {
    const first = buildBankFile(builderRows()).file;
    const renamed: SimBankFile = { ...first, games: first.games.map((g, i) => ({ ...g, id: `OLD0${i}` })) };
    const again = buildBankFile(builderRows(), 'sheets_cache.json', renamed);
    expect(again.file.games.map((g) => g.id).sort()).toEqual(['OLD00', 'OLD01']);
    expect(again.counts).toMatchObject({ keptIds: 2, newIds: 0, droppedIds: 0 });
    expect(buildBankFile(builderRows(), 'sheets_cache.json', first).file).toEqual(first);
  });
});

describe('the committed sim_bank.json', () => {
  const bank = readJson('sim_bank.json') as SimBankFile;

  it('is built from the committed game_db.json (rebuild it: tsx scripts/buildSimBank.ts)', () => {
    expect(bank.builtFrom).toBe('game_db.json');
    const rebuilt = buildBankFile(rowsFromGameDb(readJson('game_db.json') as { games?: unknown }).rows, 'game_db.json', bank).file;
    expect(rebuilt.games.length).toBe(bank.games.length);
    expect(rebuilt).toEqual(bank);
  }, 60_000);
});

describe('Threads plan pins when the bank changes', () => {
  it('pins the old plan for the coming days so pre-written first comments still match', () => {
    const file = readJson('sim_bank.json') as SimBankFile;
    const oldBank = buildSimBank(file);
    const start = '2026-11-23';
    const dates = Array.from({ length: 8 }, (_, i) => addDays(start, i));
    const gen = (bank: typeof oldBank, picks: ReadonlyMap<string, string>): ThreadsGenerator =>
      new ThreadsGenerator({ bank, titles: new Map(), readSaved: () => null, pickOverride: pickOverrideOf(picks) });
    const ex = (g: ThreadsGenerator, d: string): string | null => {
      const p = g.pickFor(d);
      const hit = p ? g.gameOf(p.gameId) : null;
      return p && hit ? exerciseIdOfPick(p, hit.game) : null;
    };
    const oldGen = gen(oldBank, new Map());
    const planned = new Set(dates.map((d) => oldGen.pickFor(d)?.gameId).filter(Boolean));
    // 新題庫：拿掉一些沒排進計畫的局（池子變小，第 k 週拿第 k 個就換了人）。
    const smaller = buildSimBank({ ...file, games: file.games.filter((g, i) => planned.has(g.id) || i % 5 !== 0) });
    const res = planPins(oldBank, smaller, new Map(), dates);
    expect(res.lost.size).toBe(0);
    expect(res.pins.size).toBeGreaterThan(0);
    const after = gen(smaller, res.pins);
    for (const d of dates) expect(ex(after, d), d).toBe(ex(oldGen, d));
    // 計畫沒變就不釘
    expect(planPins(oldBank, oldBank, new Map(), dates).pins.size).toBe(0);
    // 站長已經選的日子不碰
    expect(planPins(oldBank, smaller, new Map([[dates[0], 'ZZZZZ-A']]), dates).pins.has(dates[0])).toBe(false);
  }, 120_000);

  it('fingerprints of the fixtures match generate_cache (sanity)', () => {
    expect(recordFingerprint(parsedGame(wikiRow()))).toMatch(/^\d{6}\|/);
  });
});
