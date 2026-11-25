/**
 * Threads 每日一題「一眼看懂」（2026-11-25，站長：「關於數據分析跟每日一題 希望能更直觀讓看到的人一目瞭然」）：
 *   - choices.ts：每一題三個選項 A／B／C（真人的、純邏輯最好的、前一個隊長的；刺殺題是梅林、派西、真人刺的），
 *     同一題永遠同一組、照座位排、字母看不出哪個是真人選的；
 *   - card.ts 題目卡：1080×1350、最上面一行大字的問題、你是誰、比數與五局任務、大圓桌（你黃圈有光暈、出過的任務是座位旁的方塊、
 *     湖中女神是箭頭）、三個選項、每天一樣的記號說明；內文很少；只畫到出題那一刻、不洩漏答案；
 *   - card.ts 答案卡：真人選了哪一個（大字）、三個選項的真相、一句話理由、角色（紅方在上）、結果，每張 ≤ 1350；
 *   - 貼文第一行是一句話的問題；牌譜卡（原本的題目卡）變成輪播第 2 張（renderGridPngs 的第 1 張）。
 * 用 commit 進 repo 的題庫 sim_bank.json（實戰的局，沒有名字）。
 */

import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { readRecordPosts } from '../bots/simulation/recordsIndex';
import { TEAM_SIZES, isRed, midDecision } from '../bots/simulation/scenario';
import { CARD_H, CARD_LEGEND, buildAnswerSvg, buildPuzzleSvg, cardBodyText, cardQuestion, identityChips, renderAnswerPng, renderPuzzlePng, seatMissions, bigSeatPosition } from '../bots/threads/card';
import { CHOICE_LETTERS, choiceLines, choiceReveal, choicesFor, realLetter } from '../bots/threads/choices';
import { hookQuestion, legacyPostTitle, pickView, postTitle, reasonSentence, scoreOf, type PickView } from '../bots/threads/draft';
import { buildRecordSvg, buildRecordSvgs, gridPages, recordImageCount, renderGridPngs, sheetRows } from '../bots/threads/image';
import { planWeek, type ThreadsKind, type ThreadsPick } from '../bots/threads/plan';

const serverRoot = path.resolve(__dirname, '..', '..');
let bank: SimBank;
let views: PickView[];

beforeAll(() => {
  const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
  if (!file) throw new Error('sim_bank.json missing');
  bank = buildSimBank(file, readRecordPosts([path.join(serverRoot, 'records_cache.json')]));
  views = [];
  for (let w = 0; w < 6; w++) {
    for (const pick of planWeek(bank, w) as ThreadsPick[]) views.push(pickView(bank.games[bank.byId.get(pick.gameId) as number], pick));
  }
  // 第五種題型（週六沒有能接的局時的「第四局忠臣派 5 人」）：正常的排程排不到，用少一些局的題庫排一題出來
  const small = { games: bank.games.filter((g) => midDecision(g, 2) === null || midDecision(g, 4) === null), records: new Map<number, string>() };
  const sat = (planWeek(small, 0) as (ThreadsPick | null)[])[5] as ThreadsPick;
  views.push(pickView(bank.games[bank.byId.get(sat.gameId) as number], sat));
});

const cjk = (s: string): number => [...s].filter((ch) => /[一-鿿]/.test(ch)).length;
const count = (svg: string, re: RegExp): number => (svg.match(re) ?? []).length;
const key = (seats: readonly number[]): string => seats.join(',');

describe('choices A／B／C', () => {
  it('every question type gets exactly three distinct choices, sorted by seat, lettered A B C, the same every time', () => {
    const kinds = new Set<ThreadsKind>();
    for (const pv of views) {
      kinds.add(pv.pick.kind);
      const c = choicesFor(pv);
      expect(c.items.map((x) => x.letter)).toEqual([...CHOICE_LETTERS]);
      expect(new Set(c.items.map((x) => key(x.seats))).size).toBe(3);
      expect(choicesFor(pv)).toEqual(c);
      // 照座位由小到大排（0家＝10 排最後）：字母看不出哪一個是真人選的
      const sorted = [...c.items].sort((a, b) => {
        for (let i = 0; i < a.seats.length; i++) if (a.seats[i] !== b.seats[i]) return a.seats[i] - b.seats[i];
        return 0;
      });
      expect(c.items).toEqual(sorted);
      if (pv.pick.proposal === null) {
        expect(c.kind).toBe('assassin');
        const roles = pv.game.seatRoles;
        for (const x of c.items) {
          expect(x.seats).toHaveLength(1);
          expect(isRed(roles[x.seats[0] - 1])).toBe(false); // 刺客知道誰是紅方，選項都是好人
        }
        expect(c.items.some((x) => roles[x.seats[0] - 1] === 'merlin')).toBe(true); // 正確答案一定在裡面
        expect(c.items.some((x) => roles[x.seats[0] - 1] === 'percival')).toBe(true);
        const target = pv.game.assassinTargetSeat;
        if (target) expect(realLetter(c)).not.toBeNull(); // 真人刺的那一家也在裡面
      } else {
        expect(c.kind).toBe('team');
        const p = pv.game.proposals[pv.pick.proposal];
        for (const x of c.items) {
          expect(x.seats).toHaveLength(TEAM_SIZES[p.round - 1]);
          expect([...x.seats].sort((a, b) => a - b)).toEqual(x.seats);
        }
        // 真人派的那一隊剛好是其中一個
        expect(c.items.filter((x) => x.real)).toHaveLength(1);
        expect(key(c.items.find((x) => x.real)!.seats)).toBe(key([...p.teamSeats].sort((a, b) => a - b)));
      }
    }
    expect([...kinds].sort()).toEqual(['assassin', 'final', 'percival', 'round4', 'tail']); // 五種題型都有
  });

  it('the real choice is not always the same letter', () => {
    const letters = new Set(views.map((pv) => realLetter(choicesFor(pv))).filter(Boolean));
    expect(letters.size).toBeGreaterThanOrEqual(2);
  });

  it('post lines: one choice per line plus a 都不是 line; seat 10 is written 0家; the reveal tells each choice’s truth', () => {
    for (const pv of views) {
      const c = choicesFor(pv);
      const lines = choiceLines(c);
      expect(lines).toHaveLength(4);
      const team = c.kind === 'team';
      lines.slice(0, 3).forEach((l, i) => expect(l).toMatch(team ? new RegExp(`^${'ABC'[i]} 派 \\d(、\\d)+家$`) : new RegExp(`^${'ABC'[i]} 刺 \\d家$`)));
      expect(lines[3]).toBe(team ? '都不是？留言你的隊' : '都不是？留言你覺得的座位');
      expect(lines.join('\n')).not.toMatch(/10/);
      const reveal = choiceReveal(pv);
      expect(reveal.map((r) => r.letter)).toEqual(['A', 'B', 'C']);
      for (const r of reveal) {
        expect(r.reds).toEqual(r.seats.filter((s) => isRed(pv.game.seatRoles[s - 1])));
        expect(r.text).toMatch(team ? /^[ABC] \d+（\d 好 \d 壞）$/ : /^[ABC] \d家（\S+）$/);
      }
    }
  });
});

describe('question card (carousel image 1)', () => {
  it('is a fixed 1080×1350 card: one large question line on top, identity chips, score strip, three choice chips, the same legend every day', () => {
    for (const pv of views) {
      const svg = buildPuzzleSvg(pv, 3);
      expect(svg).toMatch(new RegExp(`^<svg[^>]* width="1080" height="${CARD_H}"`));
      expect(CARD_H).toBe(1350);
      // 問題：一行、字級 ≥ 56（手機上約 20px），在其他內容上面
      const q = /<text class="question" x="40" y="([\d.]+)" font-size="(\d+)"><tspan[^>]*>([^<]+)</.exec(svg);
      expect(q).not.toBeNull();
      expect(q![3]).toBe(cardQuestion(pv).big);
      expect(Number(q![2])).toBeGreaterThanOrEqual(56);
      expect(Number(q![1])).toBeLessThan(200);
      expect(q![3]).toMatch(/？$/);
      // 你是誰（黃框）
      const [who, info] = identityChips(pv);
      expect(who).toMatch(/^你是 \d家 \S+$/);
      expect(svg).toContain(`>${who}<`);
      expect(svg).toContain(`>${info.replace(/&/g, '&amp;')}<`);
      // 比數
      const score = scoreOf(pv);
      expect(svg).toMatch(new RegExp(`<text class="score"[^>]*><tspan[^>]*>${score.good}</tspan><tspan[^>]*>：</tspan><tspan[^>]*>${score.evil}</tspan>`));
      // 三個選項
      for (const l of CHOICE_LETTERS) expect(count(svg, new RegExp(`class="choice choice-${l}"`, 'g'))).toBe(1);
      const c = choicesFor(pv);
      if (c.kind === 'team') expect(count(svg, /class="choice-seat"/g)).toBe(3 * c.items[0].seats.length);
      // 固定的記號說明
      for (const line of CARD_LEGEND) expect(svg).toContain(`>${line}<`);
      expect(svg).not.toMatch(/10\s*家/);
    }
  });

  it('keeps the body text short (about forty Chinese characters): question, one line of context, who you are, what you know', () => {
    let max = 0;
    for (const pv of views) {
      const n = cardBodyText(pv).reduce((sum, s) => sum + cjk(s), 0);
      max = Math.max(max, n);
      expect(n).toBeLessThanOrEqual(46);
      expect(cjk(cardQuestion(pv).big)).toBeLessThanOrEqual(10);
    }
    expect(max).toBeGreaterThan(20);
  });

  it('the table shows the decision-maker and the key facts visually: you (yellow, glow), mission squares beside the seats, lake arrows', () => {
    for (const pv of views) {
      const svg = buildPuzzleSvg(pv, 3);
      const rows = sheetRows(pv);
      // 你：只有一個座位是黃字、有光暈
      const me = [...svg.matchAll(/<text class="big-seat big-seat-me"[^>]*><tspan[^>]*>(\d)</g)].map((m) => m[1]);
      expect(me).toEqual([String(pv.pick.seat % 10)]);
      expect(count(svg, /class="me-glow"/g)).toBe(1);
      expect(count(svg, /<text class="big-seat[ "]/g)).toBe(10);
      // 出過的任務：每個出過任務的座位一個方塊，藍＝成功、紅＝失敗
      const quests = rows.filter((r) => r.kind === 'quest');
      const missions = seatMissions(rows);
      const pips = [...missions.values()].flat();
      expect(count(svg, /class="pip pip-ok"/g)).toBe(pips.filter((m) => !m.failed).length);
      expect(count(svg, /class="pip pip-failed"/g)).toBe(pips.filter((m) => m.failed).length);
      // 五局任務格：打過的局各一格（成功／失敗），正在派的那一局一格「輪到你」
      expect(count(svg, /class="mission mission-ok"/g)).toBe(quests.filter((r) => r.kind === 'quest' && !r.failed).length);
      expect(count(svg, /class="mission mission-failed"/g)).toBe(quests.filter((r) => r.kind === 'quest' && r.failed).length);
      expect(count(svg, /class="mission mission-now"/g)).toBe(pv.pick.proposal === null ? 0 : 1);
      // 湖中女神：一次湖一條箭頭、一個「好／壞」標籤、右邊一行
      const lakes = rows.filter((r) => r.kind === 'lake').length;
      expect(count(svg, /class="lake-line"/g)).toBe(lakes);
      expect(count(svg, /class="lake-claim"/g)).toBe(lakes);
      expect(count(svg, /class="lake-row"/g)).toBe(lakes);
      // 這一局已經派過的隊
      if (pv.pick.proposal !== null) {
        const round = pv.game.proposals[pv.pick.proposal].round;
        expect(count(svg, /class="round-team"/g)).toBe(rows.filter((r) => r.kind === 'proposal' && r.round === round).length);
      }
    }
  });

  it('lake labels on the table never sit on top of each other', () => {
    for (const pv of views) {
      const svg = buildPuzzleSvg(pv, 3);
      const pts = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="21"[^>]*class="lake-claim"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
      for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(40);
    }
  });

  it('seats sit on the same clock as the record card: 0 at twelve, clockwise, 5 at six', () => {
    const at = (seat: number) => bigSeatPosition(seat, 0, 0);
    expect(at(10).x).toBeCloseTo(0);
    expect(at(10).y).toBeLessThan(0);
    expect(at(5).x).toBeCloseTo(0);
    expect(at(5).y).toBeGreaterThan(0);
    expect(at(2).x).toBeGreaterThan(0);
    expect(at(8).x).toBeLessThan(0);
  });

  it('does not leak the answer: nothing after the question moment, no role names beyond what the viewer knows, the real choice is not marked', () => {
    for (const pv of views) {
      const svg = buildPuzzleSvg(pv, 3);
      expect(svg).not.toContain('真人');
      expect(svg).not.toContain('answer-real');
      expect(svg).not.toContain('結果：');
      if (pv.pick.proposal !== null) {
        // 提議題：出題之後才出的任務不會有方塊（方塊數只算看得到的任務）
        const shownQuests = pv.shown.filter((e) => e.kind === 'quest').length;
        expect(count(svg, /class="mission mission-(ok|failed)"/g)).toBe(shownQuests);
        expect(shownQuests).toBeLessThan(pv.game.proposals[pv.pick.proposal].round);
        if (pv.view.sight.kind !== 'merlin' && pv.view.sight.kind !== 'percival') expect(svg).not.toContain('梅林');
      }
    }
  });

  it('renders as PNG; the record card (the old question card) is now image 2 and is always produced', () => {
    const pv = views.find((v) => v.pick.kind === 'tail') as PickView;
    expect(renderPuzzlePng(pv, 3).subarray(1, 4).toString('ascii')).toBe('PNG');
    for (const v of views.slice(0, 7)) {
      const svgs = buildRecordSvgs(v, 3);
      expect(svgs).toHaveLength(recordImageCount(v));
      expect(recordImageCount(v)).toBe(1 + gridPages(v).length);
      expect(svgs[0]).toBe(buildRecordSvg(v, 3));
      expect(svgs[0]).toContain('class="viewer-line'); // 整份牌譜的格子那一張
    }
    const pngs = renderGridPngs(pv, 3);
    expect(pngs.length).toBeGreaterThanOrEqual(1);
    expect(pngs[0].subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});

describe('answer card', () => {
  it('says which choice the real player took in large type, each choice’s truth, one sentence why, then roles and result; never taller than 1350', () => {
    for (const pv of views) {
      const svg = buildAnswerSvg(pv);
      const height = Number(/^<svg[^>]* height="(\d+)"/.exec(svg)?.[1]);
      expect(height).toBeLessThanOrEqual(1350);
      const head = /<text class="answer-head" x="40" y="[\d.]+" font-size="(\d+)">(.*?)<\/text>/.exec(svg);
      expect(head).not.toBeNull();
      expect(Number(head![1])).toBeGreaterThanOrEqual(40);
      const headText = head![2].replace(/<[^>]+>/g, '');
      expect(count(svg, /class="answer-choice/g)).toBe(3);
      const c = choicesFor(pv);
      if (c.kind === 'team') {
        const p = pv.game.proposals[pv.pick.proposal as number];
        const reds = p.teamSeats.filter((s) => isRed(pv.game.seatRoles[s - 1])).length;
        expect(headText).toMatch(new RegExp(`^真人選 ${realLetter(c)} \\d+：${p.teamSeats.length - reds} 好 ${reds} 壞，(任務成功|任務失敗|投票沒過)$`));
        expect(count(svg, /class="answer-choice answer-real"/g)).toBe(1);
        expect(svg).toContain('真人選這一隊');
        // 一句話理由（分號前後各一行）
        const why = reasonSentence(pv) as string;
        expect(why).toMatch(/^只看當時的資訊：這隊在 [\d.]+% 的可能裡全是好人；(已經是最高的|最高的隊（\d+( 等 \d+ 隊)?）是 [\d.]+%)$/);
        expect(count(svg, /class="answer-why"/g)).toBe(2);
      } else {
        const merlin = pv.game.seatRoles.indexOf('merlin') + 1;
        expect(headText).toMatch(new RegExp(`^梅林是 [ABC] ${merlin % 10}家$`));
        expect(reasonSentence(pv)).toBeNull();
        if (pv.game.assassinTargetSeat) expect(svg).toMatch(/真人刺 \d家：/);
      }
      // 角色：紅方在上（刺娜德奧）、藍方在下（派梅）
      const body = svg.slice(svg.indexOf('>紅方<'));
      expect(body.indexOf('>紅方<')).toBeLessThan(body.indexOf('>藍方<'));
      const roles = [...body.matchAll(/<text class="roles"[^>]*><tspan[^>]*>([^<]+)</g)].map((m) => m[1]);
      expect(roles).toHaveLength(2);
      expect(roles[0]).toMatch(/^刺客 \d家\u3000莫甘娜 \d家\u3000莫德雷德 \d家\u3000奧伯倫 \d家$/);
      expect(roles[1]).toMatch(/^派西維爾 \d家\u3000梅林 \d家$/);
      expect(svg).toContain('結果：');
      expect(svg).toContain(`[${pv.pick.gameId}] · 答案`);
      expect(svg).not.toMatch(/10\s*家/);
    }
  });

  it('two questions revealed together (Wed 1-5 + Thu 3-5): the earlier one gets its own headline above', () => {
    const [, , wed, thu] = planWeek(bank, 0) as ThreadsPick[];
    expect(thu.gameId).toBe(wed.gameId);
    const game = bank.games[bank.byId.get(wed.gameId) as number];
    const wedPv = pickView(game, wed);
    const thuPv = pickView(game, thu);
    const svg = buildAnswerSvg(thuPv, [wedPv.exerciseId, thuPv.exerciseId], wedPv);
    expect(count(svg, /class="answer-head"/g)).toBe(2);
    expect(count(svg, /class="answer-choice/g)).toBe(3); // 三個選項只畫昨天那一題的
    expect(svg).toContain('1-5、3-5');
    expect(Number(/^<svg[^>]* height="(\d+)"/.exec(svg)?.[1])).toBeLessThanOrEqual(1350);
    expect(renderAnswerPng(thuPv, [wedPv.exerciseId, thuPv.exerciseId], { earlier: wedPv }).subarray(1, 4).toString('ascii')).toBe('PNG');
  });
});

describe('post title', () => {
  it('the first line is the series name, the weekday and a plain one-sentence question for every question type', () => {
    const cases: [number, Pick<ThreadsPick, 'kind' | 'round' | 'continues'>, string][] = [
      [1, { kind: 'assassin' }, '【阿瓦隆每日一題｜週一】好人拿下三局，你是刺客：誰是梅林？'],
      [2, { kind: 'percival' }, '【阿瓦隆每日一題｜週二】你是派西維爾，兩根拇指分不出誰是梅林，這一隊派誰？'],
      [3, { kind: 'tail', round: 1 }, '【阿瓦隆每日一題｜週三】第 1 局前四隊都沒過，最後一隊輪到你派，派誰？'],
      [4, { kind: 'tail', round: 3, continues: true }, '【阿瓦隆每日一題｜週四】第 3 局前四隊都沒過，最後一隊輪到你派，派誰？'],
      [6, { kind: 'round4', round: 4 }, '【阿瓦隆每日一題｜週六】第 4 局要 2 張失敗才算失敗，輪到你派 5 人，派誰？'],
      [0, { kind: 'final', round: 5 }, '【阿瓦隆每日一題｜週日】2 比 2 的最後一局，輪到你派 5 人，派誰？'],
    ];
    for (const [weekday, pick, title] of cases) {
      expect(postTitle(weekday, pick)).toBe(title);
      expect(title.endsWith(hookQuestion(pick))).toBe(true);
      expect(title).not.toMatch(/\d-\d/); // 不用認得「1-5」這種寫法
    }
    // 舊貼文（11/25 以前手動發的）的標題還認得
    expect(legacyPostTitle(3, { kind: 'tail', round: 1 })).toBe('【阿瓦隆每日一題｜週三・1-5 尾派】');
    expect(legacyPostTitle(4, { kind: 'tail', round: 3, continues: true })).toBe('【阿瓦隆每日一題｜週四・同一局接到 3-5】');
  });
});
