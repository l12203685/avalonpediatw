/**
 * Threads 知識卡（2026-11-18，站長：「能跟阿瓦隆百科的文章觀念做連結 (文章觀念最好三句話之內可以清楚表達? 情境 觀念 應用?)
 * 再配上完整文章的連結」）：
 *   - concepts.json 的格式：id 不重複、三句各一句且不超過 40 字、座位寫「N家」、證據標籤只用 WIKI_EVIDENCE_STANDARD 的三種；
 *   - 每張卡的文章、標題、章節錨點都對得上 wiki_data.json，網址就是網站的 #wiki=<id>&sec=<章節>、分享網址是 /w/<id>/；
 *   - conceptsFor 的配對規則；
 *   - 對整個題庫（sim_bank.json）與 Threads 的候選題跑一次，回報有幾成題目配得到卡。
 */

import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hasWikiSection } from '../../../web/src/utils/wikiSections';
import { parseWikiHash, wikiHash, wikiShareUrl } from '../../../web/src/utils/wikiHash';
import { buildSimBank, readSimBankFile, type SimBank } from '../bots/simulation/bank';
import { BLUE_ROLES, RED_ROLES, assassinSeat } from '../bots/simulation/scenario';
import { STATS_SITE_URL } from '../bots/stats/statsReplies';
import {
  CONCEPT_PARTS,
  CONCEPT_SENTENCE_MAX,
  conceptBank,
  conceptMatches,
  conceptProblems,
  conceptsFor,
  exerciseOf,
  exerciseOfPick,
  lakeHolderOf,
  loadConceptBank,
  sentenceProblem,
  type ConceptExercise,
} from '../bots/threads/concepts';
import { buildCandidates } from '../bots/threads/plan';

// 整個題庫建池子、每一題都配一次：單獨跑約 1 秒，整套平行跑時 CI 上可能超過預設的 5 秒。
vi.setConfig({ testTimeout: 60_000 });

const serverRoot = path.resolve(__dirname, '..', '..');

interface WikiArticle {
  id: string;
  title: string;
  content: string;
}

const wiki = new Map<string, WikiArticle>(
  (JSON.parse(fs.readFileSync(path.join(serverRoot, 'wiki_data.json'), 'utf8')) as WikiArticle[]).map((a) => [a.id, a]),
);

const bank = conceptBank();

describe('concepts.json format', () => {
  it('passes the schema check (ids, sentences, evidence, tags)', () => {
    expect(conceptProblems(bank)).toEqual([]);
    expect(() => loadConceptBank(bank)).not.toThrow();
  });

  it('has unique ids and a reasonable size', () => {
    const ids = bank.concepts.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(ids.length).toBeLessThanOrEqual(100);
  });

  it('keeps every part to one sentence of at most 40 characters', () => {
    const long = bank.concepts.flatMap((c) =>
      CONCEPT_PARTS.filter((p) => Array.from(c[p]).length > CONCEPT_SENTENCE_MAX).map((p) => `${c.id} ${p}`),
    );
    expect(long).toEqual([]);
  });

  it('flags the sentence mistakes it is meant to catch', () => {
    expect(sentenceProblem('你是5家忠臣，要派3人。')).toBe('');
    expect(sentenceProblem('派自己加2人全好約27.8%。')).toBe('');
    expect(sentenceProblem('')).not.toBe('');
    expect(sentenceProblem('沒有句號')).toMatch(/。/);
    expect(sentenceProblem('第一句。第二句。')).toMatch(/one sentence/);
    expect(sentenceProblem('你是 5 家忠臣。')).toMatch(/space/);
    expect(sentenceProblem('你是10家忠臣。')).toMatch(/0家/);
    expect(sentenceProblem('派147。')).toMatch(/digits/);
    expect(sentenceProblem(`${'一'.repeat(CONCEPT_SENTENCE_MAX)}。`)).toMatch(/longer/);
  });

  it('rejects a broken bank', () => {
    const c = bank.concepts[0];
    expect(conceptProblems({ site: bank.site, concepts: [c, c] }).join()).toMatch(/duplicate id/);
    expect(conceptProblems({ site: bank.site, concepts: [{ ...c, evidence: '資料證明' }] }).join()).toMatch(/evidence/);
    expect(conceptProblems({ site: bank.site, concepts: [{ ...c, tags: { ...c.tags, round: ['1-6'] } }] }).join()).toMatch(/round/);
    expect(() => loadConceptBank({ concepts: 'x' })).toThrow();
  });
});

describe('concepts.json links', () => {
  it('uses the site the Threads drafts link to', () => {
    expect(bank.site).toBe(STATS_SITE_URL);
  });

  it('points every card at an existing article, its title and an existing section anchor', () => {
    const problems: string[] = [];
    for (const c of bank.concepts) {
      const a = wiki.get(c.article.slug);
      if (!a) {
        problems.push(`${c.id}: no article ${c.article.slug}`);
        continue;
      }
      if (a.title !== c.article.title) problems.push(`${c.id}: title differs from wiki_data.json`);
      if (c.article.section && !hasWikiSection(a.content, c.article.section)) problems.push(`${c.id}: no section ${c.article.section}`);
      if (c.article.url !== `${bank.site}/${wikiHash(a.id, c.article.section)}`) problems.push(`${c.id}: url is not the site deep link`);
      const target = parseWikiHash(c.article.url.slice(c.article.url.indexOf('#')));
      if (target?.id !== a.id || target.section !== c.article.section) problems.push(`${c.id}: url does not parse back`);
      if (c.article.shareUrl !== wikiShareUrl(bank.site, a.id)) problems.push(`${c.id}: shareUrl is not /w/<id>/`);
    }
    expect(problems).toEqual([]);
  });
});

// ─── 配對規則 ─────────────────────────────────────────────────────────────

const ex = (over: Partial<ConceptExercise>): ConceptExercise => ({
  decision: '派隊',
  round: 1,
  attempt: 1,
  seat: 1,
  role: 'loyal',
  score: '0:0',
  lakeHolder: false,
  lastQuestMember: null,
  lastQuestFails: null,
  thumbsLed: null,
  ...over,
});
const ids = (e: ConceptExercise, opts?: Parameters<typeof conceptsFor>[1]): string[] => conceptsFor(e, opts).map((c) => c.id);

describe('conceptsFor', () => {
  it('puts the seat-and-role card first for 1家 at 1-1', () => {
    expect(ids(ex({}))[0]).toBe('w205-loyal-seat1');
    expect(ids(ex({ role: 'merlin' }))[0]).toBe('w205-merlin-seat1');
    expect(ids(ex({ role: 'oberon' }))[0]).toBe('w205-oberon-seat1');
  });

  it('only gives assassination cards to an assassination question, and only red-side ones', () => {
    const m = conceptMatches(ex({ decision: '刺殺', round: null, attempt: null, seat: 3, role: 'assassin', score: '3:0' }));
    expect(m.length).toBeGreaterThan(5);
    expect(m.every((x) => x.concept.tags.decision.includes('刺殺'))).toBe(true);
    expect(m.every((x) => !x.concept.tags.roles || x.concept.tags.roles.includes('assassin'))).toBe(true);
  });

  it('never gives a blue-only card to a red leader, or a red-only card to a blue leader', () => {
    const red = conceptMatches(ex({ round: 1, attempt: 5, seat: 5, role: 'morgana' }));
    const blue = conceptMatches(ex({ round: 1, attempt: 5, seat: 5, role: 'percival', thumbsLed: 2 }));
    expect(red.every((m) => !m.concept.tags.roles || m.concept.tags.roles.includes('morgana'))).toBe(true);
    expect(blue.every((m) => !m.concept.tags.roles || m.concept.tags.roles.includes('percival'))).toBe(true);
    expect(red.map((m) => m.concept.id)).toContain('w206-red-reasonable');
    expect(blue.map((m) => m.concept.id)).toContain('w206-percival-tail');
  });

  it('needs the lake to be in your hand for the 2-5 lake-plan card', () => {
    const holder = ex({ round: 2, attempt: 5, seat: 10, score: '1:0', lakeHolder: true, lastQuestMember: false, lastQuestFails: 0 });
    expect(conceptMatches(holder).map((m) => m.concept.id)).toContain('w206-2-5-lake');
    expect(conceptMatches({ ...holder, lakeHolder: false }).map((m) => m.concept.id)).not.toContain('w206-2-5-lake');
  });

  it('uses the score: 紅方聽牌 and 藍方聽牌 get different cards', () => {
    const redMatch = conceptMatches(ex({ round: 3, attempt: 2, seat: 8, role: 'loyal', score: '0:2' })).map((m) => m.concept.id);
    const blueMatch = conceptMatches(ex({ round: 3, attempt: 2, seat: 8, role: 'loyal', score: '2:0' })).map((m) => m.concept.id);
    expect(redMatch).toContain('w207-red-match-blue');
    expect(redMatch).not.toContain('w207-blue-match-team');
    expect(blueMatch).toContain('w207-blue-match-team');
  });

  it('takes one card per article by default, and can drop the general (any) cards', () => {
    const e = ex({ round: 1, attempt: 5, seat: 5, role: 'loyal' });
    const all = conceptsFor(e, { limit: 10 });
    expect(new Set(all.map((c) => c.article.slug)).size).toBe(all.length);
    const specific = conceptsFor(e, { limit: 10, specificOnly: true });
    expect(specific.length).toBeGreaterThan(0);
    expect(specific.every((c) => !c.tags.round.includes('any') || c.tags.round.some((r) => r === '1-5' || r === '1-*'))).toBe(true);
  });
});

// ─── 題庫覆蓋率 ───────────────────────────────────────────────────────────

interface Item {
  key: string;
  group: string;
  ex: ConceptExercise;
}

function groupOf(e: ConceptExercise): string {
  if (e.round === null) return '刺殺';
  if (e.round === 5) return '5-x';
  return e.attempt === 5 ? `${e.round}-5` : e.round === 1 ? '1-1～1-4' : `${e.round}-1～${e.round}-4`;
}

/** 卡片寫給整個陣營（藍方三種角色、紅方四種角色）的不算「針對角色」。 */
const isWholeCamp = (roles: readonly string[]): boolean =>
  [BLUE_ROLES, RED_ROLES].some((camp) => camp.length === roles.length && camp.every((r) => roles.includes(r)));

/** 每一題：配得到卡、配得到局面專屬的卡（不算 any）、配得到「局-次」（刺殺 A）完全對上的卡、配得到針對他角色（不是整個陣營）的卡。 */
type Tally = [n: number, any: number, specific: number, exact: number, role: number];

function coverage(items: readonly Item[]): { total: Tally; byGroup: Map<string, Tally> } {
  const byGroup = new Map<string, Tally>();
  const total: Tally = [0, 0, 0, 0, 0];
  for (const it of items) {
    const ms = conceptMatches(it.ex);
    const flags = [
      true,
      conceptsFor(it.ex).length > 0,
      conceptsFor(it.ex, { specificOnly: true }).length > 0,
      ms.some((m) => m.roundMatch === 'exact'),
      ms.some((m) => !!m.concept.tags.roles && !isWholeCamp(m.concept.tags.roles)),
    ];
    const g = byGroup.get(it.group) ?? [0, 0, 0, 0, 0];
    flags.forEach((f, i) => {
      if (f) {
        g[i]++;
        total[i]++;
      }
    });
    byGroup.set(it.group, g);
  }
  return { total, byGroup };
}

const pct = (a: number, n: number): string => `${n ? ((100 * a) / n).toFixed(1) : '0.0'}%`;
const line = ([n, a, s, e, r]: Tally): string =>
  `${n} 題｜有卡 ${pct(a, n)}｜局面專屬 ${pct(s, n)}｜「局-次」完全對上 ${pct(e, n)}｜針對角色 ${pct(r, n)}`;

function report(name: string, c: ReturnType<typeof coverage>): string {
  const rows = [...c.byGroup.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [`${name}：${line(c.total)}`, ...rows.map(([g, t]) => `  ${g}：${line(t)}`)].join('\n');
}

describe('coverage over the exercise bank', () => {
  let sim: SimBank;
  let bankItems: Item[];
  let threadsItems: Item[];

  beforeAll(() => {
    const file = readSimBankFile([path.join(serverRoot, 'sim_bank.json')]);
    if (!file) throw new Error('sim_bank.json missing');
    sim = buildSimBank(file);
    const seen = new Map<string, Item>();
    const add = (gi: number, proposal: number | null, seat: number): void => {
      const key = `${sim.games[gi].id}/${proposal ?? 'A'}`;
      if (!seen.has(key)) {
        const e = exerciseOf(sim.games[gi], proposal, seat);
        seen.set(key, { key, group: groupOf(e), ex: e });
      }
    };
    // 模擬瓦的題目：每一家第一個決定、局面池（尾派、第 5 局、派西）、刺殺題。
    for (const refs of [...sim.pool.values(), ...sim.midPool.values()]) {
      for (const r of refs) add(r.game, r.proposal, sim.games[r.game].proposals[r.proposal].leaderSeat);
    }
    for (const gi of sim.assassinPool) add(gi, null, assassinSeat(sim.games[gi]) as number);
    bankItems = [...seen.values()];

    const byId = new Map(sim.games.map((g) => [g.id, g]));
    const tSeen = new Map<string, Item>();
    for (const pool of Object.values(buildCandidates({ games: sim.games }))) {
      for (const cand of pool) {
        for (const p of cand.picks) {
          const g = byId.get(p.gameId);
          const key = `${p.gameId}/${p.proposal ?? 'A'}`;
          if (!g || tSeen.has(key)) continue;
          const e = exerciseOfPick(g, p);
          tSeen.set(key, { key, group: groupOf(e), ex: e });
        }
      }
    }
    threadsItems = [...tSeen.values()];
  });

  it('computes the lake holder from the chain (0家 first)', () => {
    for (const g of sim.games.slice(0, 200)) {
      if (!g.lakeChainValid) continue;
      expect(lakeHolderOf(g, 2)).toBe(10);
      const l2 = g.lakes.find((l) => l.round === 2);
      const l3 = g.lakes.find((l) => l.round === 3);
      if (l2 && l3) expect(l3.holderSeat).toBe(l2.targetSeat);
    }
  });

  it('gives the "both thumbs have proposed" Percival cards only when both thumbs have led (A9CQS, proposal 5, 6家)', () => {
    const g = sim.games.find((x) => x.id === 'A9CQS');
    if (!g) throw new Error('A9CQS missing from sim_bank.json');
    const e = exerciseOf(g, 5, 6);
    expect(e.role).toBe('percival');
    expect(e.thumbsLed).not.toBe(2);
    const got = conceptMatches(e).map((m) => m.concept.id);
    expect(got).not.toContain('w176-sop');
    expect(got).not.toContain('w206-percival-tail');
    expect(conceptMatches({ ...e, thumbsLed: 2 }).map((m) => m.concept.id)).toContain('w176-sop');
    expect(conceptMatches({ ...e, thumbsLed: 0 }).map((m) => m.concept.id)).toContain('w176-no-blind');
    // 只對派西的題有意義：別的角色沒有這個資訊，這三張都配不到。
    expect(conceptMatches({ ...e, role: 'loyal', thumbsLed: null }).map((m) => m.concept.tags.thumbsLed)).not.toContainEqual(expect.anything());
  });

  it('gives every exercise at least one card, and most a card made for its situation', () => {
    const b = coverage(bankItems);
    const t = coverage(threadsItems);
    // eslint-disable-next-line no-console
    console.log(`${report('模擬瓦題庫', b)}\n${report('Threads 候選題', t)}`);
    expect(b.total[1]).toBe(b.total[0]);
    expect(t.total[1]).toBe(t.total[0]);
    // 每一個刺殺題、尾派題都要有局面專屬的卡。
    for (const g of ['刺殺', '1-5', '2-5', '3-5', '4-5']) {
      const [n, , s] = t.byGroup.get(g) ?? [0, 0, 0];
      expect(n).toBeGreaterThan(0);
      expect(s).toBe(n);
    }
    expect(b.total[2] / b.total[0]).toBeGreaterThan(0.9);
  });
});
