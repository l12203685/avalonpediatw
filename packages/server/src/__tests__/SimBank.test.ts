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
import { SIM_REPLY_MAX_CHARS } from '../bots/simulation/config';
import { analyze, logicModel } from '../bots/simulation/logic';
import { claimMaskOf, logicPanel, overlapLabel, releasePanel } from '../bots/simulation/reading';
import { buildRecordSvg, renderRecordPng } from '../bots/simulation/recordImage';
import { SimEngine } from '../bots/simulation/session';
import {
  decisionsOf,
  eventIndexOfProposal,
  exerciseIdOf,
  firstDecision,
  publicEvents,
  sightFor,
  sightSeats,
  viewAt,
} from '../bots/simulation/scenario';
import { maskOf, seatBit, teamDigits } from '../bots/simulation/seats';
import { popcount } from '../ai/worlds';
import { builderRows, FAKE_DATE, FAKE_NAMES, FAKE_NOTE, GAME_MID_TEXT, GAME_WIKI_CFG, midRow, parsedGame, shortRow, simRow, wikiRow } from './fixtures/simGames';

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
    expect(counts).toEqual({ rows: 7, recorded: 6, replayable: 5, lakeChainInvalid: 1, entertainment: 1, simulated: 0, duplicates: 1, games: 2, idCollisions: 0 });
    expect(file.games.map((g) => g.cfg).sort()).toEqual(['128064', '753921']);
  });

  it('only real games: a row whose 分類 says 模擬 never enters the bank (Edward 2026-11-16：「模擬畢竟只是模擬」)', () => {
    const r = buildBankFile([...builderRows(), simRow('T-0009', GAME_MID_TEXT, GAME_WIKI_CFG, '1', '三藍死', '模擬'), simRow('T-0010', GAME_MID_TEXT, GAME_WIKI_CFG, '1', '三藍死', '模擬局')]);
    expect(r.counts).toMatchObject({ simulated: 2, games: 2 });
    // The committed bank came from the sheet's 牌譜 tab, which has no 模擬 rows (checked 2026-11-16; this guard keeps it so).
    expect(r.file.games.some((g) => g.rec === bankEntryFor(parsedGame(midRow()), 'X').rec)).toBe(false);
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
    expect(loader.status()).toEqual({ loaded: false, games: 0, dropped: 0, decisionPoints: 0, linked: 0 });
  });
});

// ─── The committed bank ────────────────────────────────────────────────────

const ALLOWED = /^[\p{Script=Han}0-9A-Za-z :\u3000\n①②③④—・｜、，。：；（）()「」【】＋＞＝→✓✗…*%/／\-+.<>=`?]+$/u;

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

  it('Edward 2026-11-17: the opening of QRSZY-3-5 in a group is exactly his compact shape', async () => {
    const engine = new SimEngine({ bank: async () => bank, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const r = await engine.handleText('/模擬 題 QRSZY-3-5', { platform: 'line', chatId: 'G', userId: 'U', shared: true });
    expect(r?.text).toBe([
      '【模擬瓦 QRSZY-3-5】你是 5家・忠臣',
      '257 1+', '239', '367', '237 49+', '159', 'ooo',
      '1459 6+', '1359 7+', '1359 8+', '1590', '1590', 'ooox',
      '0>9 x',
      '1237', '1267 6-', '1356', '1456 3+',
      '',
      '/派 座位 作答 (沒開題的人也能作答)',
      '/區間 (百科AI 怎麼讀)',
      '/help 模擬',
      '/公布 (結束這題)',
    ].join('\n'));
  });

  it('Edward 2026-11-17: /區間 without content shows how 百科AI reads QRSZY-3-5 and the team it would send', async () => {
    let now = 1;
    const engine = new SimEngine({ bank: async () => bank, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const req = { platform: 'line' as const, chatId: 'G', userId: 'U', shared: true };
    const open = await engine.handleText('/模擬 題 QRSZY-3-5', req);
    open?.commit();
    now += 1000;
    const r = await engine.handleText('/區間', req);
    r?.commit();
    const text = r?.text ?? '';
    const lines = text.split('\n');
    expect(lines[0]).toBe('【QRSZY-3-5 百科AI 怎麼讀】');
    // 紅機率列出另外 9 家（不含 5家），由高到低。
    const reds = /^紅機率：(.*)$/u.exec(lines[1])?.[1].split('・') ?? [];
    expect(reds).toHaveLength(9);
    expect(reds.some((x) => x.startsWith('5 '))).toBe(false);
    const ps = reds.map((x) => Number(/ (\d+(?:\.\d)?)%$/u.exec(x)?.[1]));
    expect([...ps].sort((a, b) => b - a)).toEqual(ps);
    expect(lines[2]).toMatch(/^最可能的紅方：\d{4} \d+%/u);
    expect(lines[3]).toMatch(/^百科AI 會派：(?=\d*5)\d{4}（全好 \d+(?:\.\d)?%）$/u);
    expect(lines.at(-1)).toBe('/派｜/公布');
    // 同一題每次讀法一樣（固定種子）。
    const again = await engine.handleText('/區間', req);
    expect(again?.text).toBe(text);
  });

  it('Edward 2026-11-17: /公布 of QRSZY-3-5 is three lines (配置, 原始結果, 完整牌譜) and carries the full record image', async () => {
    const engine = new SimEngine({ bank: async () => bank, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const req = { platform: 'line' as const, chatId: 'R', userId: 'U' };
    (await engine.handleText('/模擬 題 QRSZY-3-5', req))?.commit();
    const r = await engine.handleText('/公布', req);
    const lines = (r?.text ?? '').split('\n');
    expect(lines.slice(0, 2)).toEqual(['【QRSZY-3-5 公布】配置: 刺娜莫奧派梅 893270', '1忠 2奧 3莫 4忠 5忠 6忠 7派 8刺 9娜 0梅']);
    expect(lines[2]).toBe('原始結果: 三藍活');
    expect(lines[3]).toMatch(/^完整牌譜(: https:\/\/avalon-game-platform\.web\.app\/#records=\S+|（網站上沒有這一局）:)$/u);
    expect(r?.text).not.toContain('/模擬 再來一題');
    expect(r?.image?.title).toBe('QRSZY-3-5');
    const png = renderRecordPng(r!.image!.game, r!.image!.title);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // 整局（沒有截斷）、有角色、沒有名字。
    const svg = buildRecordSvg(r!.image!.game, 'QRSZY-3-5');
    expect(svg).toContain('第 4 輪任務');
    expect(svg).toContain('刺殺：刺 7 家（沒刺中）');
    expect(svg).toContain('>梅<');
  });

  it('/下一步 was removed: one line pointing to /派 /區間 /公布', async () => {
    const engine = new SimEngine({ bank: async () => bank, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const r = await engine.handleText('/下一步', { platform: 'line', chatId: 'C', userId: 'U' });
    expect(r?.text).toBe('/下一步 已經拿掉了。直接 /派 作答；想看百科AI 怎麼讀打 /區間，看答案打 /公布');
  });

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
    await say('/派 140');
    expect(await say('/分析')).toMatch(/・跟 1家 367：延伸（1 3），回選 1 → 都對時只剩紅 2589/u);
    await say('/模擬 題 046Z5-6');
    await say('/派 2569');
    const fb = await say('/分析');
    expect(fb).toMatch(/・跟 2家 139：延伸（2 9），回選 2/u);
    expect(fb).not.toMatch(/派 2560 跟 2家 139 打對邊/);
    // 同一個決定點（2家 第 5 局第 4 次）用局面題開（/下一步 2026-11-17 拿掉）。
    await say('/模擬 題 046Z5-5-4');
    await say('/派 23678');
    expect(await say('/分析')).toMatch(/0家 13689 不可能全好：連你在內會有 7 個好人，超過 6 個/u);
  });

  it('every reply of every exercise (each seat of each game, its decision) fits 1800 characters and uses only expected characters', async () => {
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
          // A group (shared): the longest form, with the 「別人也能幫忙答」 line at the end of the start and /派 replies.
          const req = { platform, chatId: 'C', userId: `U${seat}`, shared: true };
          const run = async (cmd: string): Promise<string | null> => {
            // 回傳回覆的種類（不是文字）。
            now += 1000;
            const r = await engine.handleText(cmd, req);
            if (!r) return null;
            r.commit();
            replies++;
            longest = Math.max(longest, r.text.length);
            expect(r.text.length).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
            // /派 is the two-line result since 2026-11-16 (the full reading is /分析).
            if (r.kind === 'propose') expect(r.text).toMatch(/^(（代答：[^\n]*\n)?【[^】]+】你派 \d+：\d 好 \d 壞\n\/分析 看完整解讀｜\/區間 百科AI 怎麼讀｜\/公布$/u);
            if (!ALLOWED.test(r.text)) {
              const bad = [...r.text].filter((ch) => !ALLOWED.test(ch)).map((ch) => `U+${ch.codePointAt(0)?.toString(16)}`);
              throw new Error(`unexpected character ${bad.join(',')} in a reply for ${g.id}-${seat}`);
            }
            return r.kind;
          };
          if ((await run(`/模擬 題 ${exerciseIdOf(g.id, seat)}`)) !== 'start') continue;
          starts++;
          // 一題一個決定點（/下一步 2026-11-17 拿掉）；百科AI 怎麼讀（/區間）比較慢，每 25 局跑一次。
          const d = firstDecision(g, seat);
          if (d !== null && d !== undefined) {
            await run(`/派 ${teamDigits(g.proposals[d].teamSeats)}`);
            await run('/分析');
            await run('/區間 789=2 460=1');
            if (gi % 25 === 0 && platform === 'line') await run('/區間');
          }
          await run('/公布');
        }
      }
    }
    expect(starts).toBeGreaterThan(15_000);
    expect(replies).toBeGreaterThan(70_000);
    expect(longest).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
  }, 300_000);

  it('every 局面 / 刺殺 exercise of the real bank (1-5…4-5, 5局, -A) fits 1800 characters with expected characters only', async () => {
    let now = 5_000_000;
    const engine = new SimEngine({ bank: async () => bank, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const req = { platform: 'line' as const, chatId: 'ST', userId: 'U', shared: true };
    let starts = 0;
    let kills = 0;
    const run = async (cmd: string): Promise<string> => {
      now += 1000;
      const r = await engine.handleText(cmd, req);
      r?.commit();
      const text = r?.text ?? '';
      expect(text.length, cmd).toBeLessThanOrEqual(SIM_REPLY_MAX_CHARS);
      if (text && !ALLOWED.test(text)) throw new Error(`unexpected character in a reply to ${cmd}`);
      return text;
    };
    for (const [key, refs] of bank.midPool) {
      for (const ref of refs.filter((_, i) => i % 7 === 0)) {
        const g = bank.games[ref.game];
        const p = g.proposals[ref.proposal];
        const start = await run(`/模擬 題 ${g.id}-${p.round}-${p.attempt}`);
        // 精簡牌譜：前面 round-1 行任務牌、這一局前面 attempt-1 次派票，接著是指令列。
        const lines = start.split('\n');
        expect(lines.filter((l) => /^[ox]+$/u.test(l)), key).toHaveLength(p.round - 1);
        expect(start, key).toContain('\n\n/派 座位 作答');
        starts++;
        await run(`/派 ${teamDigits(p.teamSeats)}`);
        await run('/分析');
        await run('/公布');
      }
    }
    for (const gi of bank.assassinPool) {
      const g = bank.games[gi];
      expect(await run(`/模擬 題 ${g.id}-A`)).toContain('三藍，輪到你刺');
      const blue = g.seatRoles.findIndex((r) => r === 'loyal') + 1;
      await run(`/刺 ${blue === 10 ? 0 : blue}`);
      expect(await run('/公布')).toMatch(/你刺 \d家：(刺中梅林 ✓|沒刺中 ✗)/u);
      kills++;
    }
    expect(starts).toBeGreaterThan(800);
    expect(kills).toBeGreaterThan(900);
  }, 300_000);

  it('no reply before /公布 depends on a role the viewer cannot see: shuffling those roles changes nothing, byte for byte (non-interference, every 5th game)', async () => {
    // 2026-10-22 review fix (the ② count used to drop every proposal of this game in the viewer's bucket,
    // other seats' included, so it told how many of this round's leaders share your role).
    // The variant keeps the record, the viewer's own role and what the viewer sees: within each class
    // (red or good) × (in the viewer's sight or not), the other seats' roles are rotated by one.
    const games2 = [...bank.games];
    const bank2 = { ...bank, games: games2 };
    let now = 1_000_000;
    const real = new SimEngine({ bank: async () => bank, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const shuffled = new SimEngine({ bank: async () => bank2, now: () => now, rateLimit: { windowMs: 1, max: 1_000_000 } });
    const isRedRole = (r: string): boolean => ['assassin', 'morgana', 'mordred', 'oberon'].includes(r);
    let compared = 0;
    let variants = 0;
    for (let gi = 0; gi < bank.games.length; gi += 5) {
      const g = bank.games[gi];
      for (let seat = 1; seat <= 10; seat++) {
        const seen = new Set(sightSeats(sightFor(g, seat)));
        const classes = new Map<string, number[]>();
        for (let s = 1; s <= 10; s++) {
          if (s === seat) continue;
          const k = `${isRedRole(g.seatRoles[s - 1])}|${seen.has(s)}`;
          classes.set(k, [...(classes.get(k) ?? []), s]);
        }
        const roles = [...g.seatRoles];
        for (const seats of classes.values()) seats.forEach((s, i) => { roles[s - 1] = g.seatRoles[seats[(i + 1) % seats.length] - 1]; });
        if (roles.every((r, i) => r === g.seatRoles[i])) continue;
        const variant = { ...g, seatRoles: roles };
        expect(sightFor(variant, seat)).toEqual(sightFor(g, seat));
        variants++;
        games2[gi] = variant;
        const req = { platform: 'line' as const, chatId: 'NI', userId: 'U', shared: true };
        const both = async (cmd: string): Promise<string | undefined> => {
          now += 1000;
          const a = await real.handleText(cmd, req);
          const b = await shuffled.handleText(cmd, req);
          a?.commit();
          b?.commit();
          if (a?.text !== b?.text) throw new Error(`${g.id}-${seat} ${cmd}: a reply depends on a hidden role`);
          compared++;
          return a?.kind;
        };
        if ((await both(`/模擬 題 ${exerciseIdOf(g.id, seat)}`)) === 'start') {
          const d = firstDecision(g, seat);
          if (d !== null && d !== undefined) {
            // /派 itself tells 幾好幾壞 (Edward 2026-11-16) — that is red/good, which this shuffle keeps; /分析 must
            // still not depend on which hidden role sits where. 百科AI 怎麼讀（/區間）也不能（每 10 局查一次，比較慢）。
            await both(`/派 ${teamDigits(g.proposals[d].teamSeats)}`);
            await both('/分析');
            await both('/區間 789=2 460=1');
            if (gi % 10 === 0) await both('/區間');
          }
          await both('/結束');
        }
        games2[gi] = g;
      }
    }
    expect(variants).toBeGreaterThan(2_000);
    expect(compared).toBeGreaterThan(15_000);
  }, 300_000);
});
