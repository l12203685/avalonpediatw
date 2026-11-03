import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_NOTE, UNVERIFIED_PREFIX, buildPaipuPost, dayIndex, discordBody, gameToPaipu, gameToPaipuLoose,
  unverifiedThreadName, withReviewNote, type RecordedGame,
} from '../../scripts/signagePaipu';

// 虛構的 10 人局（暱稱都是編的）：配置 936758（刺 9、娜 3、德 6、奧 7、派 5、梅 8），三藍、梅林被刺。
const ROLES: Record<number, string> = { 9: '刺客', 3: '莫甘娜', 6: '莫德雷德', 7: '奧伯倫', 5: '派西維爾', 8: '梅林' };
const users = (robot = false, n = 10) => Array.from({ length: n }, (_, i) => ({
  set: i + 1, name: `測試${i + 1}`, role: ROLES[i + 1] ?? '雜魚', ...(robot && i === 1 ? { is_robot: true } : {}),
}));
const rounds: [number[], boolean[], number][] = [
  [[1, 4, 7], [true, true, true], 1],
  [[5, 6, 8, 10], [true, true, true, false], 2],
  [[1, 3, 6, 9], [true, true, true, true], 3],
  [[1, 4, 5, 8, 10], [true, true, true, true, true], 4],
];
const end = (robot = false, n = 10) => ({
  users: users(robot, n),
  meetings: rounds.map(([team, , cap]) => ({ ticks_set: team, white_ball_set: team, captain_set: cap })),
  missionHistorys: rounds.map(([team, result, cap]) => ({ member: team, result, crown_set: cap })),
  lake: [{ from: 10, to: 8, result: true }, { from: 8, to: 4, result: true }],
  logs: [{ msg: '刺客背刺 8家 梅林' }, { msg: '壞人獲勝' }],
});
const game = (extra: Record<string, unknown> = {}): RecordedGame => ({
  room: 'Room-1417', startedAt: '2026-11-03T12:00:00.000Z', endedAt: '2026-11-03T12:40:00.000Z', end: end(), ...extra,
}) as unknown as RecordedGame;
const RESULT_TAGS = ['三紅', '三藍被刀', '三藍躲刺'];

describe('記錄員每局都貼（Edward 11/03）', () => {
  it('通過檢查：正式標題、結果標籤、最後一行備註', () => {
    const p = buildPaipuPost(game(), 2);
    expect(p.verified).toBe(true);
    expect(p.name).toBe('20261103_第2局_936758');
    expect(p.tags).toEqual(['三藍被刀', '線瓦']);
    expect(p.content).toBe(`${gameToPaipu(game())}\n${REVIEW_NOTE}`);
    expect(p.content.split('\n')).toContain('刺客刺殺:8');
  });

  it('沒通過：標題【待檢視】、不掛結果標籤、內文寫原因＋盡量轉出的牌譜', () => {
    const p = buildPaipuPost(game({ end: end(true) }), 3);
    expect(p.verified).toBe(false);
    expect(p.name).toBe(`${UNVERIFIED_PREFIX}20261103_2000_Room-1417_936758`); // 台灣時間 20:00 開局，不寫第幾局
    expect(p.tags).toEqual(['線瓦']);
    const lines = p.content.split('\n');
    expect(lines[0]).toBe('待檢視原因：有機器人');
    expect(lines.at(-1)).toBe(REVIEW_NOTE);
    expect(lines).toContain('147');
    expect(lines).toContain('936758');
    expect(lines).toContain('2.測試2');
  });

  it('各種原因都照貼、都不掛結果標籤', () => {
    const cases: [RecordedGame, string][] = [
      [game({ joinedMidGame: true }), '中途加入'],
      [game({ end: end(false, 7) }), '7 人局'],
      [game({ end: { ...end(), missionHistorys: end().missionHistorys.slice(0, 2) } }), '牌譜不完整（沒打完或提議／任務人數不對）'],
      [game({ end: null }), '沒有抓到局末畫面資料'],
    ];
    for (const [g, reason] of cases) {
      const p = buildPaipuPost(g, 1);
      expect(p.verified).toBe(false);
      expect(p.name.startsWith(UNVERIFIED_PREFIX)).toBe(true);
      expect(p.name).not.toMatch(/第\d+局/);
      expect(p.tags.filter((t) => RESULT_TAGS.includes(t))).toEqual([]);
      expect(p.content.split('\n')[0]).toBe(`待檢視原因：${reason}`);
      expect(p.content.endsWith(`\n${REVIEW_NOTE}`)).toBe(true);
    }
    expect(buildPaipuPost(game({ end: null })).content).toBe(`待檢視原因：沒有抓到局末畫面資料\n（沒有可用的牌譜資料）\n${REVIEW_NOTE}`);
  });

  it('配置不齊時標題不接六碼', () => {
    const noRoles = { ...end(false, 7), users: users(false, 7).map((u) => ({ ...u, role: '雜魚' })) };
    expect(unverifiedThreadName(game({ end: noRoles }))).toBe(`${UNVERIFIED_PREFIX}20261103_2000_Room-1417`);
    expect(unverifiedThreadName({ room: '' } as RecordedGame)).toBe(`${UNVERIFIED_PREFIX}未知局`);
  });

  it('殘缺的資料不丟錯', () => {
    const broken = game({ end: { users: [null, { set: 1, name: '測試1' }], meetings: [{}, null], missionHistorys: [null, {}], lake: [null] } });
    expect(() => gameToPaipuLoose(broken)).not.toThrow();
    const p = buildPaipuPost(broken);
    expect(p.verified).toBe(false);
    expect(p.content.endsWith(REVIEW_NOTE)).toBe(true);
    expect(gameToPaipuLoose(game({ end: undefined }))).toBe('');
  });

  it('太長時截內文、備註一定留著', () => {
    const text = withReviewNote('o'.repeat(5000));
    expect(text.length).toBeLessThanOrEqual(1990);
    expect(text.endsWith(`\n${REVIEW_NOTE}`)).toBe(true);
    expect(withReviewNote('')).toBe(REVIEW_NOTE);
  });

  it('第幾局只數通過檢查的局', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paipu-'));
    try {
      const write = (name: string, g: RecordedGame) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(g)); return f; };
      write('a.json', game({ endedAt: '2026-11-03T12:40:00.000Z' }));
      write('b.json', game({ endedAt: '2026-11-03T13:00:00.000Z', end: end(true) })); // 有機器人：待檢視
      write('c.json', game({ endedAt: '2026-11-03T13:10:00.000Z', joinedMidGame: true })); // 中途加入：待檢視
      const d = write('d.json', game({ endedAt: '2026-11-03T13:30:00.000Z' }));
      expect(dayIndex(d)).toBe(2);
      expect(buildPaipuPost(JSON.parse(fs.readFileSync(d, 'utf-8')), dayIndex(d)).name).toBe('20261103_第2局_936758');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Discord 送出內容', () => {
  it('沒有圖：JSON', () => {
    const { body, json } = discordBody({ name: 't', message: { content: 'x' } }, [], 'message');
    expect(json).toBe(true);
    expect(JSON.parse(body as string)).toEqual({ name: 't', message: { content: 'x' } });
  });

  it('有圖：multipart，論壇討論串的 attachments 在 message 裡', async () => {
    const images = [
      { filename: 'board.jpg', data: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' },
      { filename: 'stats.jpg', data: new Uint8Array([4, 5]), contentType: 'image/jpeg' },
    ];
    const { body, json } = discordBody({ name: 't', applied_tags: [], message: { content: 'x' } }, images, 'message');
    expect(json).toBe(false);
    const form = body as FormData;
    expect(JSON.parse(form.get('payload_json') as string)).toEqual({
      name: 't', applied_tags: [],
      message: { content: 'x', attachments: [{ id: 0, filename: 'board.jpg' }, { id: 1, filename: 'stats.jpg' }] },
    });
    const f0 = form.get('files[0]') as File;
    expect(f0.name).toBe('board.jpg');
    expect(f0.type).toBe('image/jpeg');
    expect([...new Uint8Array(await f0.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((form.get('files[1]') as File).name).toBe('stats.jpg');
  });

  it('webhook：attachments 在最外層', () => {
    const images = [{ filename: 'board.jpg', data: new Uint8Array([1]), contentType: 'image/jpeg' }];
    const { body } = discordBody({ content: 'x', thread_name: 't' }, images);
    expect(JSON.parse((body as FormData).get('payload_json') as string)).toEqual({
      content: 'x', thread_name: 't', attachments: [{ id: 0, filename: 'board.jpg' }],
    });
  });
});
