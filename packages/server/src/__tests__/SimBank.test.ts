/**
 * 模擬瓦（2026-10-14）— 題庫：格式、題號、篩選、沒有名字和日期，以及對 commit 進來的
 * `sim_bank.json` 跑的性質測試（慢，跟 benchmark.test.ts 一樣讀真資料）：
 *   每個決定點真正的紅方都還在世界裡、每則回覆 ≤ 1800 字（/派 ≤ 900 字）、只有預期的字元；
 *   ④ 的延伸／部分／打對邊照全好讀法（隊長＋隊員）算、對照真的打對邊、派西的拇指機率跟 ③ 一致
 *   （Edward 2026-10-14 審查修正）；分段載入跟一次載入一模一樣。
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parseReplayGame, type ReplayGame } from '../ai/benchmark/sheetsReplay';
import { buildSimBank, buildSimBankAsync, readSimBankFile, SimBankLoader } from '../bots/simulation/bank';
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
import { SIM_PROPOSE_SOFT_MAX_CHARS, SIM_REPLY_MAX_CHARS } from '../bots/simulation/config';
import { analyze, logicModel } from '../bots/simulation/logic';
import { claimMaskOf, logicPanel, overlapLabel, releasePanel } from '../bots/simulation/reading';
import { SimEngine } from '../bots/simulation/session';
import {
  decisionsOf,
  eventIndexOfProposal,
  exerciseIdOf,
  firstDecision,
  publicEvents,
  viewAt,
} from '../bots/simulation/scenario';
import { maskOf, seatBit, teamDigits } from '../bots/simulation/seats';
import { popcount } from '../ai/worlds';
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
  it('the boot-time build yields between chunks and gives exactly the same bank', async () => {
    const { file } = buildBankFile(builderRows());
    let pauses = 0;
    const chunked = await buildSimBankAsync(file, 1, async () => { pauses++; });
    expect(pauses).toBeGreaterThanOrEqual(4); // 2 entries + 2 games, one pause each
    const once = buildSimBank(file);
    expect(chunked.games).toEqual(once.games);
    expect([...chunked.byId]).toEqual([...once.byId]);
    expect([...chunked.pool]).toEqual([...once.pool]);
    expect([...chunked.humans]).toEqual([...once.humans]);
    expect(chunked.decisionPoints).toBe(once.decisionPoints);
    const loader = new SimBankLoader(async () => chunked);
    expect(await loader.get()).toBe(chunked);
    expect(loader.status()).toMatchObject({ loaded: true, games: 2 });
  });

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

  it('the chunked boot-time build equals the one-shot build on the real bank', async () => {
    const chunked = await buildSimBankAsync(file);
    expect(chunked.games).toEqual(bank.games);
    expect([...chunked.humans]).toEqual([...bank.humans]);
  });

  it('④ labels compare whole readings; the 對照 is really 打對邊; 派西 odds match ③; impossible readings always say why', () => {
    let checked = 0;
    for (const g of bank.games) {
      const events = publicEvents(g);
      for (let seat = 1; seat <= 10; seat++) {
        for (const d of decisionsOf(g, seat)) {
          const view = viewAt(g, seat, eventIndexOfProposal(events, d), events);
          const team = g.proposals[d].teamSeats;
          const analysis = analyze(logicModel.worlds(view));
          const r = releasePanel(view, team, analysis);
          const mine = maskOf(team) | seatBit(seat);
          for (const v of r.vs) {
            const shared = popcount(mine & claimMaskOf(v.proposal));
            if (v.label !== overlapLabel(shared) || v.shared.length !== shared) throw new Error(`label at ${g.id} seat ${seat} proposal ${d}`);
          }
          if (r.contrast && (maskOf([...r.contrast.alternative, seat]) & claimMaskOf(r.contrast.proposal)) !== 0) {
            throw new Error(`contrast not opposite at ${g.id} seat ${seat} proposal ${d}`);
          }
          if (r.privateCheck.kind === 'percival') {
            const pc = r.privateCheck;
            pc.thumbsOnTeam.forEach((t, i) => { if (pc.odds[i] !== analysis.marginal(t)) throw new Error('odds'); });
          }
          for (const c of logicPanel(view, logicModel).claims) {
            if (c.weight > 0) continue;
            if (c.impossible === 'sight' && (!c.reason || (c.reason.kind === 'known-red' && c.reason.seats.length === 0))) {
              throw new Error(`no reason at ${g.id} seat ${seat} proposal ${d}`);
            }
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(bank.decisionPoints);
  }, 300_000);

  it('the reviewers\' cases: 回選 is 延伸, the 對照 drops the earlier leader too, a 6-seat reading is 7 good with you', async () => {
    let now = 1;
    const engine = new SimEngine({ bank: async () => bank, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const req = { platform: 'line' as const, chatId: 'C', userId: 'U' };
    const say = async (t: string): Promise<string> => {
      now += 1000;
      const r = await engine.handleText(t, req);
      r?.commit();
      return r?.text ?? '';
    };
    await say('/模擬 題 01RH8-3');
    expect(await say('/派 140')).toMatch(/・跟 1家 367 比：延伸（(有 2 人以上一樣：)?1 3），回選 1（把前面的隊長派進隊裡）→ 兩次都對（兩次派票的人全是好人）時只剩紅 2589（紅方就只能是這幾個）/u);
    await say('/模擬 題 046Z5-6');
    const fb = await say('/派 2569');
    expect(fb).toMatch(/・跟 2家 139 比：延伸（(有 2 人以上一樣：)?2 9），回選 2/u);
    expect(fb).not.toMatch(/派 2560 會跟 2家 139 打對邊/);
    await say('/模擬 題 046Z5-2');
    await say('/下一步');
    await say('/下一步');
    expect(await say('/派 23678')).toMatch(/0家 13689 的全好讀法(（[^）]*）)?不成立：連你在內會有 7 個好人，超過 6 個/u);
    await say('/模擬 題 00VG7-2');
    expect(await say('/下一步')).toContain('1家 2480（票沒記全） → 出發');
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
            // /派 stays short enough for a phone (SIM_PROPOSE_SOFT_MAX_CHARS).
            if (r.kind === 'propose') expect(r.text.length).toBeLessThanOrEqual(SIM_PROPOSE_SOFT_MAX_CHARS);
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
