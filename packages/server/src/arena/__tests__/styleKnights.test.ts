import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING } from '../../ai/AgentTuning';
import { knobFor } from '../knobs';
import { BOT_ID_RE, HOUSE_AUTHOR, resolveProfileTuning, validateProfile } from '../profile';
import { HOUSE_DIR, HOUSE_TITLE, loadRoster } from '../registry';
import {
  STYLE_VOCAB,
  STYLE_WORDS,
  buildFamilies,
  buildKnightProfile,
  buildProbes,
  chooseShrunk,
  choicesToLayers,
  describeStyle,
  expectedMatch,
  familyAgreement,
  familyOf,
  knightFolderId,
  knightName,
  knightNameFits,
  scoreFamily,
  styleTag,
  type CandidateScore,
  type DecisionType,
  type ScoredSpot,
  type SpotLite,
} from '../styleKnights';

const ROLES = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon'];
const TYPES: DecisionType[] = ['team', 'vote', 'quest', 'assassinate'];

function allSpots(): SpotLite[] {
  const out: SpotLite[] = [];
  for (const type of TYPES) for (const role of ROLES) for (let round = 1; round <= 5; round++) {
    for (const redFails of [0, 1, 2]) for (const onTeam of [true, false]) out.push({ type, role, round, redFails, onTeam });
  }
  return out;
}

describe('decision families and probes', () => {
  const families = buildFamilies();
  const probes = buildProbes();

  it('families never overlap: a decision point belongs to at most one', () => {
    for (const s of allSpots()) {
      const hits = families.filter((f) => f.type === s.type && (f.roles as readonly string[]).includes(s.role) && f.match(s));
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it('every family knob is on the arena whitelist and every grid value is in range', () => {
    for (const f of families) for (const axis of f.axes) {
      const knob = knobFor(axis.key);
      expect(knob, axis.key).toBeDefined();
      for (const v of axis.values) {
        if (knob!.kind === 'number') {
          expect(typeof v).toBe('number');
          expect(v as number).toBeGreaterThanOrEqual(knob!.min);
          expect(v as number).toBeLessThanOrEqual(knob!.max);
        } else expect(typeof v).toBe('boolean');
      }
    }
  });

  it('every candidate reads probes that exist and that compute that family’s decision points', () => {
    const byId = new Map(probes.map((p) => [p.id, p]));
    for (const s of allSpots()) {
      const f = familyOf(families, s);
      if (!f) continue;
      for (const axis of f.axes) for (const v of axis.values) {
        const c = axis.candidate(v);
        const ids = c.kind === 'pick' ? [c.probe] : [c.probe0, c.probe1];
        for (const id of ids) {
          const p = byId.get(id);
          expect(p, `${f.id} ${String(v)} → ${id}`).toBeDefined();
          expect(p!.wants(s), `${id} must compute ${f.id} at ${JSON.stringify(s)}`).toBe(true);
        }
      }
    }
  });

  it('probe knobs are whitelisted and the default probe changes nothing', () => {
    for (const p of probes) for (const k of Object.keys(p.knobs)) expect(knobFor(k), k).toBeDefined();
    expect(probes.find((p) => p.id === 'D')!.knobs).toEqual({});
  });

  it('a pick candidate at the default value reads the default replay', () => {
    for (const f of families) for (const axis of f.axes) {
      const def = (DEFAULT_AGENT_TUNING as unknown as Record<string, number | boolean>)[axis.key];
      const c = axis.candidate(def);
      if (c.kind === 'pick') expect(c.probe).toBe('D');
    }
  });
});

describe('expected agreement and shrinkage', () => {
  const spot = (human: string, agent: Record<string, string>): ScoredSpot => ({ type: 'vote', role: 'assassin', round: 3, redFails: 0, human, agent });

  it('mixes the two branches of a probability knob', () => {
    const c = { kind: 'mix' as const, key: 'redNormalVote' as const, probe0: 'P1', probe1: 'D' };
    expect(expectedMatch(spot('reject', { D: 'approve', P1: 'reject' }), c, 0.3)).toBeCloseTo(0.7);
    expect(expectedMatch(spot('reject', { D: 'approve' }), c, 0.3)).toBeNull();
  });

  it('thin data follows the population, plenty of data follows the player, ties keep the default', () => {
    const pop: CandidateScore[] = [
      { key: 'goodBayesBad', value: 0.6, sum: 700, n: 1000 },
      { key: 'goodBayesBad', value: 0.8, sum: 800, n: 1000 },
    ];
    // 2 個決策點都比較像 0.6，但全體強烈偏好 0.8 → 留在 0.8。
    expect(chooseShrunk([{ key: 'goodBayesBad', value: 0.6, sum: 2, n: 2 }, { key: 'goodBayesBad', value: 0.8, sum: 0, n: 2 }], pop, 20)).toEqual({ key: 'goodBayesBad', value: 0.8 });
    // 200 個決策點都比較像 0.6 → 0.6。
    expect(chooseShrunk([{ key: 'goodBayesBad', value: 0.6, sum: 190, n: 200 }, { key: 'goodBayesBad', value: 0.8, sum: 120, n: 200 }], pop, 20)).toEqual({ key: 'goodBayesBad', value: 0.6 });
    // 完全同分 → 預設值。
    const flat: CandidateScore[] = [{ key: 'goodBayesBad', value: 0.6, sum: 5, n: 10 }, { key: 'goodBayesBad', value: 0.8, sum: 5, n: 10 }];
    expect(chooseShrunk(flat, flat, 20)).toEqual({ key: 'goodBayesBad', value: 0.8 });
    expect(chooseShrunk([], pop, 20)).toBeNull();
  });

  it('scores a family and reports default vs chosen agreement', () => {
    const f = buildFamilies().find((x) => x.id === 'redVote')!;
    const spots = [
      spot('reject', { D: 'approve', P1: 'reject', P2: 'approve', P3: 'approve' }),
      spot('reject', { D: 'approve', P1: 'reject', P2: 'approve', P3: 'approve' }),
      spot('approve', { D: 'approve', P1: 'approve', P2: 'approve', P3: 'approve' }),
    ];
    const scores = scoreFamily(f, spots);
    const best = scores.reduce((a, b) => (b.sum > a.sum ? b : a));
    expect(best).toMatchObject({ key: 'redNormalVote', value: 0, sum: 3 });
    expect(familyAgreement(f, spots, null)).toEqual({ sum: 1, n: 3 });
    expect(familyAgreement(f, spots, { key: 'redNormalVote', value: 0 })).toEqual({ sum: 3, n: 3 });
  });
});

describe('style tag vocabulary', () => {
  it('uses only words from the fixed vocabulary (one word or two joined)', () => {
    const samples = [
      {},
      { sides: { evil: { redNormalVote: 0, redStackRate65: 1 } } },
      { sides: { evil: { redCleanWhite: 1 } } },
      { roles: { loyal: { goodBayesGood: 0.9, goodBayesBad: 0.6 }, percival: { goodBayesGood: 0.9, goodBayesBad: 0.6 } } },
      { roles: { loyal: { goodBayesGood: 0.5 }, percival: { goodBayesGood: 0.5 } } },
      { roles: { merlin: { merlinNormalVote: 0 } } },
      { roles: { merlin: { merlinCover77: 1 } } },
      { sides: { evil: { redNormalVote: 0 } }, roles: { loyal: { goodBayesGood: 0.9, goodBayesBad: 0.6 }, percival: { goodBayesGood: 0.9, goodBayesBad: 0.6 } } },
    ];
    for (const layers of samples) {
      const tag = styleTag(layers);
      const words = tag.length === 2 ? [tag] : [tag.slice(0, 2), tag.slice(2)];
      expect([2, 4]).toContain(tag.length);
      for (const w of words) expect(STYLE_VOCAB).toContain(w);
    }
  });

  it('maps knob directions to the expected words', () => {
    expect(styleTag({})).toBe(STYLE_WORDS.steady);
    expect(styleTag({ sides: { evil: { redNormalVote: 0 } } })).toBe(STYLE_WORDS.redBold);
    expect(styleTag({ sides: { evil: { redCleanWhite: 1 } } })).toBe(STYLE_WORDS.redSly);
    expect(styleTag({ roles: { loyal: { goodBayesBad: 0.6 }, percival: { goodBayesBad: 0.6 } } })).toBe(STYLE_WORDS.blueStrict);
    expect(styleTag({ roles: { loyal: { goodBayesGood: 0.5 }, percival: { goodBayesGood: 0.5 } } })).toBe(STYLE_WORDS.blueLoose);
    expect(styleTag({ roles: { merlin: { merlinNormalVote: 0 } } })).toBe(STYLE_WORDS.merlinOpen);
    expect(styleTag({ roles: { merlin: { merlinCover77: 1 } } })).toBe(STYLE_WORDS.merlinHidden);
    // 紅方很衝、藍方也很嚴 → 兩個詞。
    expect(styleTag({ sides: { evil: { redNormalVote: 0, redStackRate65: 1 } }, roles: { loyal: { goodBayesBad: 0.6 }, percival: { goodBayesBad: 0.6 } } }))
      .toBe(`${STYLE_WORDS.redBold}${STYLE_WORDS.blueStrict}`);
    // 偏離太小 → 穩健。
    expect(styleTag({ sides: { evil: { redNormalVote: 0.9 } } })).toBe(STYLE_WORDS.steady);
  });
});

describe('knight names, folders and profiles', () => {
  it('names knights AI騎士_{玩家ID}_{##}', () => {
    expect(knightName('測試玩家', 1)).toBe('AI騎士_測試玩家_01');
    expect(knightName('tester', 12)).toBe('AI騎士_tester_12');
    expect(knightNameFits('一二三四五六七八九十一二三四五六')).toBe(true);
    expect(knightNameFits('一二三四五六七八九十一二三四五六七')).toBe(false);
  });

  it('makes valid, distinct folder ids for ASCII and non-ASCII IDs', () => {
    const ids = ['Tester', 'tester.2', '測試玩家', '測試玩家乙', 'A B C', 'x'.repeat(40)].map((p) => knightFolderId(p, 1));
    for (const id of ids) expect(id).toMatch(BOT_ID_RE);
    expect(new Set(ids).size).toBe(ids.length);
    expect(knightFolderId('Tester', 1)).toBe('knight-tester-01');
    expect(knightFolderId('測試玩家', 2)).toMatch(/^knight-[0-9a-f]{8}-02$/);
  });

  it('puts whole-side families in sides and role families in roles', () => {
    const layers = choicesToLayers(buildFamilies(), {
      redVote: { key: 'redNormalVote', value: 0.4 },
      redQuest: { key: 'redHideHuman', value: false },
      blueOn: { key: 'goodBayesBad', value: 0.7 },
      merlinVote: { key: 'merlinNormalVote', value: 1 }, // 預設值：不寫
    });
    expect(layers.sides).toEqual({ evil: { redNormalVote: 0.4 } });
    expect(layers.roles).toEqual({
      percival: { goodBayesBad: 0.7 },
      loyal: { goodBayesBad: 0.7 },
      assassin: { redHideHuman: false },
      morgana: { redHideHuman: false },
      mordred: { redHideHuman: false },
    });
    // 奧伯倫不藏牌的開關沒有套上（擬合時沒有用奧伯倫的牌）。
    expect(resolveProfileTuning({ schema: 1, name: 'x', author: HOUSE_AUTHOR, style: 'x', ...layers }, 'oberon', 'evil').redHideHuman).toBe(DEFAULT_AGENT_TUNING.redHideHuman);
  });

  it('builds a house profile that passes validation only as a house knight', () => {
    const layers = { sides: { evil: { redNormalVote: 0.2 } }, roles: { merlin: { merlinCover77: 0.6 } } };
    const p = buildKnightProfile('測試玩家', 1, layers);
    expect(p.author).toBe(HOUSE_AUTHOR);
    expect(p.official).toBe(true);
    expect(validateProfile({ ...p, official: undefined }, 'knight-x-01', { house: true }).errors.join(' ')).toMatch(/official/);
    expect(p.tag).toBe(styleTag(layers));
    expect(p.style).toContain('紅方');
    expect(p.style).toContain('梅林');
    expect([...p.style].length).toBeLessThanOrEqual(300);
    const house = validateProfile(p, knightFolderId('測試玩家', 1), { house: true });
    expect(house.errors).toEqual([]);
    expect(house.profile?.tag).toBe(p.tag);
    const community = validateProfile(p, 'someone');
    expect(community.ok).toBe(false);
    expect(community.errors.join(' ')).toMatch(/AI騎士_/);
    expect(community.errors.join(' ')).toMatch(/official/);
  });

  it('describes a default-like profile plainly', () => {
    expect(describeStyle({}, STYLE_WORDS.steady)).toContain('和百科AI 幾乎一樣');
  });
});

describe('house knights in the roster', () => {
  function tmpRoster(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-house-'));
    const write = (rel: string, obj: unknown): void => {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
      fs.writeFileSync(path.join(dir, rel, 'profile.json'), JSON.stringify(obj));
    };
    write(`${HOUSE_DIR}/knight-aaaa-01`, buildKnightProfile('測試玩家', 1, { sides: { evil: { redNormalVote: 0 } } }));
    write(`${HOUSE_DIR}/knight-bbbb-01`, buildKnightProfile('tester', 1, { roles: { merlin: { merlinCover77: 1 } } }));
    write(`${HOUSE_DIR}/knight-cccc-01`, buildKnightProfile('tester', 1, {})); // 名字重複 → 不收
    write(`${HOUSE_DIR}/knight-bad-01`, { schema: 1, name: 'AI騎士_x_01', author: 'octocat', official: true, style: 'x' }); // 作者不對
    write('knight-aaaa-01', { schema: 1, name: '撞名的資料夾', author: 'octocat', style: 'x', overrides: { redNormalVote: 0.5 } });
    write('fast-red', { schema: 1, name: 'AI騎士_假的_01', author: 'someone', style: 'x', overrides: { redNormalVote: 0.5 } });
    return dir;
  }

  it('loads house knights with the house title, no author slot and no one-per-author limit', () => {
    const dir = tmpRoster();
    try {
      const r = loadRoster({ dir, includeExamples: false });
      const house = r.bots.filter((b) => b.source === 'house');
      expect(house.map((b) => b.id).sort()).toEqual(['knight-aaaa-01', 'knight-bbbb-01']);
      expect(house.every((b) => b.title === HOUSE_TITLE && b.profile?.author === HOUSE_AUTHOR)).toBe(true);
      const rejected = r.rejected.map((x) => x.id).sort();
      expect(rejected).toEqual([`${HOUSE_DIR}/knight-bad-01`, `${HOUSE_DIR}/knight-cccc-01`, 'fast-red', 'knight-aaaa-01'].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
