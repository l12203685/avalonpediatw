/**
 * 模擬瓦測試用的對局（2026-10-14）。全部是編的：名字是「假名01」…「假名10」，
 * 日期、備註也是假的——測試確認它們不會出現在題庫或任何回覆裡。
 *
 * GAME_WIKI 的第 1 局前四次派票跟配置取自百科的模擬題「覆盤_模擬_753921」
 * （460 1+ / 279 / 370 / 469，刺7娜5莫3奧9派2梅1；只有座位），後面是編的。
 */

import { parseReplayGame, type PaipuRow, type ReplayGame } from '../../ai/benchmark/sheetsReplay';
import { buildSimBank, type SimBank } from '../../bots/simulation/bank';
import { bankEntryFor } from '../../bots/simulation/bankCodec';

export const FAKE_NAMES = ['假名01', '假名02', '假名03', '假名04', '假名05', '假名06', '假名07', '假名08', '假名09', '假名10'];
export const FAKE_DATE = '2025/12/31 21:05';
export const FAKE_NOTE = '測試備註請勿外流';

export function simRow(id: string, text: string, cfg: string, kill: string, result: string, category = '線瓦'): PaipuRow {
  const r: Record<string, string> = {
    流水號: id, 文字記錄: text, 配置: cfg, 刺殺: kill, 結果: result, 分類: category, 日期時間: FAKE_DATE, note: FAKE_NOTE,
  };
  ['玩1', '玩2', '玩3', '玩4', '玩5', '玩6', '玩7', '玩8', '玩9', '玩0'].forEach((col, i) => { r[col] = FAKE_NAMES[i]; });
  return r;
}

/**
 * 刺7 娜5 德3 奧9 派2 梅1；紅 3 5 7 9。第 1 局失敗，第 2–4 局成功，刺中梅林 → 三藍死。
 * 第 2 局派滿 5 次，所以 1～4 家第 3 局又當隊長（4家第二次派票在第 3 局第 4 次）。
 */
export const GAME_WIKI_TEXT = [
  '460 1+', '279', '370', '469', '157', 'oox',
  '1246', '3579', '2468', '4689', '1460', 'oooo',
  '0>4 o',
  '1246', '1257', '3579', '1468 20+', 'oooo',
  '4>3 x',
  '13579', '12468 0+', 'ooooo',
].join('\n');
export const GAME_WIKI_CFG = '753921';

/** 刺1 娜2 德8 奧0 派6 梅4；紅 1 2 8 10。第 1 局第 2 次就出發（3～5 家沒有第 1 局派票）。 */
export const GAME_SHORT_TEXT = [
  '359', '367 120+', 'ooo',
  '4567', '3567 12+', 'oooo',
  '0>9 o',
  '3567 49+', 'oooo',
].join('\n');
export const GAME_SHORT_CFG = '128064';

export function wikiRow(id = 'T-0001'): PaipuRow {
  return simRow(id, GAME_WIKI_TEXT, GAME_WIKI_CFG, '1', '三藍死');
}

export function shortRow(id = 'T-0002'): PaipuRow {
  return simRow(id, GAME_SHORT_TEXT, GAME_SHORT_CFG, '6', '三藍活');
}

/** 題庫建置的各種情況：正常兩局、娛樂、湖順序錯、重複（尾巴有名字頁尾）、解析失敗、沒有紀錄。 */
export function builderRows(): PaipuRow[] {
  return [
    wikiRow('T-0001'),
    shortRow('T-0002'),
    simRow('T-0003', GAME_SHORT_TEXT, GAME_SHORT_CFG, '4', '三藍死', '娛樂'),
    simRow('T-0004', GAME_WIKI_TEXT.replace('0>4 o', '9>4 o'), GAME_WIKI_CFG, '1', '三藍死'),
    simRow('T-0005', `${GAME_WIKI_TEXT}\n1.${FAKE_NAMES[0]}\n2.${FAKE_NAMES[1]}`, GAME_WIKI_CFG, '1', '三藍死'),
    simRow('T-0006', '12\n亂打一通', GAME_WIKI_CFG, '', ''),
    simRow('T-0007', '', GAME_WIKI_CFG, '', ''),
  ];
}

export function parsedGame(row: PaipuRow): ReplayGame {
  const r = parseReplayGame(row);
  if (!r.ok) throw new Error(r.reason);
  return r.game;
}

/**
 * 測試題庫：百科那局 `copies` 份（代號 W0000…，同一局不同代號，讓每個角色＋座位都有 20 題以上）
 * ＋ 第 1 局提早出發的那局（S0000）。
 */
export function fixtureBank(copies = 25): SimBank {
  const wiki = bankEntryFor(parsedGame(wikiRow()), 'X');
  const short = bankEntryFor(parsedGame(shortRow()), 'X');
  const games = Array.from({ length: copies }, (_, i) => ({ ...wiki, id: `W${String(i).padStart(4, '0')}` }));
  games.push({ ...short, id: 'S0000' });
  return buildSimBank({ version: 1, builtFrom: 'test', games });
}
