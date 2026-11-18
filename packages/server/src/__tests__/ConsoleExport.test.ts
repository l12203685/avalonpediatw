/**
 * 主控台匯出（scripts/consoleExport.ts、scripts/console/exportLib.ts）：百科文章清單、文章最後修改的 commit、觀念卡、
 * 一週草稿的一天、manifest；整支程式（不跑牌譜那一半、不畫圖）重跑兩次輸出一字不差。
 * 牌譜那一半（problem_games.json、game_counts.json）由 packages/server/test_console_export.py 測。
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { SITE_URL, articleHistory, conceptsExport, manifest, weekDay, wikiIndex, type GitRunner } from '../../scripts/console/exportLib';

vi.setConfig({ testTimeout: 120_000 });

const serverRoot = path.resolve(__dirname, '..', '..');

const ARTICLE = {
  id: 'wiki-x',
  title: '測試文章',
  category: 'rules',
  content: '---\ntitle: 測試文章\n---\n# 測試文章\n\n## 一、開局\n\n文字\n\n```\n## 不是標題\n```\n\n### 【邏輯】派隊的原則\n\n## 一、開局\n',
};

describe('wikiIndex', () => {
  it('lists h2+ sections with the site anchors and deep links', () => {
    const [a] = wikiIndex([ARTICLE], new Map());
    expect(a.url).toBe(`${SITE_URL}/#wiki=wiki-x`);
    expect(a.shareUrl).toBe(`${SITE_URL}/w/wiki-x/`);
    expect(a.sections.map((s) => [s.level, s.title, s.slug])).toEqual([
      [2, '一、開局', '一、開局'],
      [3, '派隊的原則', '派隊的原則'],
      [2, '一、開局', '一、開局-2'],
    ]);
    expect(a.sections[1].url).toBe(`${SITE_URL}/#wiki=wiki-x&sec=${encodeURIComponent('派隊的原則')}`);
    expect(a.lastChanged).toBeNull();
  });
});

describe('articleHistory', () => {
  // 三個 commit（新 → 舊）：c3 改了 a、c2 加了 b、c1 是最舊的一版。
  const versions: Record<string, unknown[]> = {
    c3: [{ id: 'a', content: 'a2' }, { id: 'b', content: 'b1' }, { id: 'c', content: 'c1' }],
    c2: [{ id: 'a', content: 'a1' }, { id: 'b', content: 'b1' }, { id: 'c', content: 'c1' }],
    c1: [{ id: 'a', content: 'a1' }, { id: 'c', content: 'c1' }],
  };
  const fakeGit =
    (shallow: boolean): GitRunner =>
    (args) => {
      if (args[0] === 'log') return 'c3\t2026-11-03T00:00:00+08:00\nc2\t2026-11-02T00:00:00+08:00\nc1\t2026-11-01T00:00:00+08:00\n';
      if (args[0] === 'rev-parse') return shallow ? 'true\n' : 'false\n';
      if (args[0] === 'show') return JSON.stringify(versions[args[1].split(':')[0]]);
      throw new Error(`unexpected git ${args.join(' ')}`);
    };

  it('finds the newest commit that changed each article', () => {
    const h = articleHistory('/repo', 'wiki.json', ['a', 'b', 'c'], fakeGit(false));
    expect(h.get('a')).toEqual({ commit: 'c3', date: '2026-11-03T00:00:00+08:00', exact: true });
    expect(h.get('b')).toEqual({ commit: 'c2', date: '2026-11-02T00:00:00+08:00', exact: true });
    expect(h.get('c')).toEqual({ commit: 'c1', date: '2026-11-01T00:00:00+08:00', exact: true });
  });

  it('marks the oldest commit of a shallow clone as inexact', () => {
    const h = articleHistory('/repo', 'wiki.json', ['a', 'c'], fakeGit(true));
    expect(h.get('a')?.exact).toBe(true);
    expect(h.get('c')).toEqual({ commit: 'c1', date: '2026-11-01T00:00:00+08:00', exact: false });
  });

  it('returns nothing when git is unavailable', () => {
    const h = articleHistory('/repo', 'wiki.json', ['a'], () => {
      throw new Error('no git');
    });
    expect(h.size).toBe(0);
  });
});

describe('conceptsExport', () => {
  it('reports a missing concepts file without a stale field', () => {
    const c = conceptsExport(path.join(os.tmpdir(), 'no-such-concepts.json'), 'x/concepts.json');
    expect(c).toMatchObject({ available: false, count: 0, concepts: [] });
    expect(c).not.toHaveProperty('stale');
  });

  it('copies the bank as is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-'));
    const file = path.join(dir, 'concepts.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, concepts: [{ id: 'k1' }, { id: 'k2' }] }));
    expect(conceptsExport(file, 'x/concepts.json')).toEqual({ available: true, source: 'x/concepts.json', version: 1, count: 2, concepts: [{ id: 'k1' }, { id: 'k2' }] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('weekDay and manifest', () => {
  const draft = { theme: '週三・1-5 尾派', exerciseId: 'ABCDE-1-5', recordId: 'S1', post: { text: '【標題】\n#阿瓦隆' } };

  it('counts characters, links the record and passes template parts through when the draft has them', () => {
    const d = weekDay({ date: '2026-11-18', weekday: 3, draft, comment: '留言', commentSource: 'file', images: ['2026-11-18.png'], frozen: false });
    expect(d).toMatchObject({ weekday: '週三', chars: { post: 9, comment: 2 }, recordUrl: `${SITE_URL}/#records=S1` });
    expect(d).not.toHaveProperty('parts');
    const withParts = weekDay({ date: '2026-11-18', weekday: 3, draft: { ...draft, parts: { 標題: '【標題】' } }, comment: '', commentSource: 'fallback', images: [], frozen: true });
    expect(withParts.parts).toEqual({ 標題: '【標題】' });
    expect(withParts).not.toHaveProperty('type');
    // #89：draft.parts.type 是題型物件 { kind, name }，拆成 day.type，parts 只留佔位符的字串
    const typed = weekDay({
      date: '2026-11-18',
      weekday: 3,
      draft: { ...draft, parts: { 標題: '【標題】', type: { kind: 'tail', name: '尾派' } } },
      comment: '',
      commentSource: 'fallback',
      images: [],
      frozen: false,
    });
    expect(typed.parts).toEqual({ 標題: '【標題】' });
    expect(typed.type).toEqual({ kind: 'tail', name: '尾派' });
    expect(withParts.frozen).toBe(true);
  });

  it('sorts the file entries', () => {
    const m = manifest({ sha: 'abc', dirty: false, generatedAt: 'T', files: { 'b.json': { n: 1 }, 'a.json': { n: 2 } }, notes: [] });
    expect(Object.keys(m.files as object)).toEqual(['a.json', 'b.json']);
    expect(m.source).toEqual({ repo: 'l12203685/avalonpediatw', sha: 'abc', dirty: false });
    expect(m.sourceSha).toBe('abc');
    expect(m.generatedAt).toBe('T');
  });
});

describe('consoleExport CLI', () => {
  const run = (out: string): void => {
    execFileSync(
      process.execPath,
      [
        path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(serverRoot, 'scripts', 'consoleExport.ts'),
        '--out', out, '--skip-games', '--no-image', '--days', '2', '--date', '2026-11-18', '--now', '2026-11-18T00:00:00+08:00', '--sha', 'testsha',
      ],
      { cwd: serverRoot, stdio: 'pipe' },
    );
  };

  it('writes the same bytes twice and refuses an --out inside the repo', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cexp-b-'));
    run(a);
    run(b);
    const names = ['concepts.json', 'manifest.json', 'week_drafts.json', 'wiki_index.json'];
    for (const n of names) expect(fs.readFileSync(path.join(a, n), 'utf8'), n).toBe(fs.readFileSync(path.join(b, n), 'utf8'));
    const week = JSON.parse(fs.readFileSync(path.join(a, 'week_drafts.json'), 'utf8')) as { days: { date: string }[] };
    expect(week.days.map((d) => d.date)).toEqual(['2026-11-18', '2026-11-19']);
    const m = JSON.parse(fs.readFileSync(path.join(a, 'manifest.json'), 'utf8')) as { sourceSha: string; generatedAt: string; source: { sha: string }; files: Record<string, unknown> };
    expect(m.sourceSha).toBe('testsha');
    expect(m.source.sha).toBe('testsha');
    expect(m.generatedAt).toBe('2026-11-17T16:00:00Z'); // --now 2026-11-18T00:00:00+08:00 換成 UTC
    expect(Object.keys(m.files)).toEqual(['concepts.json', 'week_drafts.json', 'wiki_index.json']);
    expect(() => run(path.join(serverRoot, 'tmp-console-out'))).toThrow();
    expect(fs.existsSync(path.join(serverRoot, 'tmp-console-out'))).toBe(false);
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  });
});
