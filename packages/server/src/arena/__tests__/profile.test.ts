import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_AGENT_TUNING, AGENT_TUNING_KEYS } from '../../ai/AgentTuning';
import { ARENA_KNOBS } from '../knobs';
import { resolveProfileTuning, validateProfile, validateRoster, profileKnobSummary, type BotProfile } from '../profile';
import { checkBotFolder, loadRoster, parseExtraProfiles, defaultCommunityDir } from '../registry';

const base = { schema: 1, name: '測試機器人', author: 'octocat', style: '紅方很衝。' };

describe('arena knob whitelist', () => {
  it('only lists real AgentTuning keys, each once, with defaults inside the range', () => {
    const keys = new Set<string>(AGENT_TUNING_KEYS);
    const seen = new Set<string>();
    for (const k of ARENA_KNOBS) {
      expect(keys.has(k.key)).toBe(true);
      expect(seen.has(k.key)).toBe(false);
      seen.add(k.key);
      const def = (DEFAULT_AGENT_TUNING as unknown as Record<string, unknown>)[k.key];
      if (k.kind === 'boolean') expect(typeof def).toBe('boolean');
      else {
        expect(typeof def).toBe('number');
        expect(def as number).toBeGreaterThanOrEqual(k.min);
        expect(def as number).toBeLessThanOrEqual(k.max);
      }
    }
  });

  it('never opens the hard-rule guards', () => {
    const keys = ARENA_KNOBS.map((k) => k.key as string);
    for (const guard of ['goodQuestSuccessGuard', 'mustFailGate', 'teamDominanceGate', 'leaderSelfApprove', 'beliefCertainFacts']) {
      expect(keys).not.toContain(guard);
    }
  });
});

describe('validateProfile', () => {
  it('accepts a minimal profile and warns that nothing changed', () => {
    const v = validateProfile(base, 'my-bot');
    expect(v.ok).toBe(true);
    expect(v.warnings.join()).toContain('一模一樣');
  });

  it('accepts overrides, sides and roles inside the ranges', () => {
    const v = validateProfile({
      ...base,
      overrides: { goodCleanVote: 0.5 },
      sides: { evil: { redNormalVote: 0, redHideHuman: false } },
      roles: { merlin: { merlinNormalVote: 0.5 } },
    }, 'my-bot');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(profileKnobSummary(v.profile!)).toEqual(['goodCleanVote=0.5', 'evil.redNormalVote=0', 'evil.redHideHuman=false', 'merlin.merlinNormalVote=0.5']);
  });

  it('rejects keys outside the whitelist, wrong types and out-of-range values', () => {
    const v = validateProfile({
      ...base,
      overrides: { goodQuestSuccessGuard: false, goodCleanVote: 2, redHideHuman: 1 },
      roles: { lancelot: {} },
      extra: 1,
    }, 'my-bot');
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    expect(all).toContain('goodQuestSuccessGuard');
    expect(all).toContain('0 到 0.9');
    expect(all).toContain('true 或 false');
    expect(all).toContain('lancelot');
    expect(all).toContain('extra');
  });

  it('enforces name, author, style and folder rules', () => {
    expect(validateProfile({ ...base, name: '百科AI 二號' }, 'my-bot').errors.join()).toContain('保留給官方');
    expect(validateProfile({ ...base, name: 'x'.repeat(30) }, 'my-bot').errors.join()).toContain('最多 24');
    expect(validateProfile({ ...base, author: '@octocat' }, 'my-bot').ok).toBe(false);
    expect(validateProfile({ ...base, style: '看這裡 https://spam.example' }, 'my-bot').errors.join()).toContain('網址');
    expect(validateProfile({ ...base, style: '問 @someone' }, 'my-bot').errors.join()).toContain('@');
    expect(validateProfile({ ...base, name: 'a​b' }, 'my-bot').errors.join()).toContain('看不見');
    expect(validateProfile(base, 'My Bot').errors.join()).toContain('資料夾名稱');
    expect(validateProfile({ ...base, schema: 2 }, 'my-bot').ok).toBe(false);
  });

  it('warns about knobs placed where they cannot act', () => {
    const v = validateProfile({ ...base, sides: { good: { redNormalVote: 0.5 } }, roles: { assassin: { goodCleanVote: 0.5 } } }, 'my-bot');
    expect(v.ok).toBe(true);
    expect(v.warnings.length).toBe(2);
  });
});

describe('validateRoster', () => {
  const p = (name: string, author: string): BotProfile => ({ ...base, name, author });
  it('flags duplicate names and a second bot by the same author', () => {
    const errs = validateRoster([
      { id: 'a', profile: p('Alpha', 'one') },
      { id: 'b', profile: p('al pha', 'two') },
      { id: 'c', profile: p('Gamma', 'ONE') },
    ]);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatch(/^b：/);
    expect(errs[1]).toMatch(/^c：/);
  });
});

describe('resolveProfileTuning', () => {
  const profile: BotProfile = {
    ...base,
    overrides: { goodCleanVote: 0.1, redNormalVote: 0.9 },
    sides: { evil: { redNormalVote: 0.5 } },
    roles: { assassin: { redNormalVote: 0 } },
  };
  it('layers default → overrides → side → role', () => {
    expect(resolveProfileTuning(profile, 'merlin', 'good').redNormalVote).toBe(0.9);
    expect(resolveProfileTuning(profile, 'morgana', 'evil').redNormalVote).toBe(0.5);
    expect(resolveProfileTuning(profile, 'assassin', 'evil').redNormalVote).toBe(0);
    expect(resolveProfileTuning(profile, 'loyal', 'good').goodCleanVote).toBe(0.1);
  });
  it('is the plain production default for the reference bot and ignores unknown keys', () => {
    expect(resolveProfileTuning(null, 'loyal', 'good')).toEqual(DEFAULT_AGENT_TUNING);
    const sneaky = { ...base, overrides: { goodQuestSuccessGuard: false } } as unknown as BotProfile;
    expect(resolveProfileTuning(sneaky, 'loyal', 'good').goodQuestSuccessGuard).toBe(DEFAULT_AGENT_TUNING.goodQuestSuccessGuard);
  });
});

describe('bot folders and roster', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'arena-test-'));
  const writeBot = (dir: string, id: string, profile: unknown, extra: Record<string, string> = {}): string => {
    const folder = path.join(dir, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'profile.json'), typeof profile === 'string' ? profile : JSON.stringify(profile));
    for (const [f, text] of Object.entries(extra)) fs.writeFileSync(path.join(folder, f), text);
    return folder;
  };

  it('allows only profile.json and README.md', () => {
    const dir = tmp();
    try {
      expect(checkBotFolder(writeBot(dir, 'ok-bot', base, { 'README.md': '# hi' })).ok).toBe(true);
      const bad = checkBotFolder(writeBot(dir, 'code-bot', base, { 'bot.js': 'process.exit()' }));
      expect(bad.ok).toBe(false);
      expect(bad.errors.join()).toContain('bot.js');
      expect(checkBotFolder(writeBot(dir, 'json-bot', '{not json')).errors.join()).toContain('JSON');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads reference, examples, community bots and extra profiles; skips _template; rejects duplicates', () => {
    const dir = tmp();
    try {
      writeBot(dir, '_template', base);
      writeBot(path.join(dir, '_examples'), 'demo', { ...base, name: '示範', author: 'avalonpediatw' });
      writeBot(dir, 'alpha', { ...base, name: 'Alpha', author: 'one' });
      writeBot(dir, 'beta', { ...base, name: 'Beta', author: 'one' });
      writeBot(dir, 'gamma', { ...base, name: 'Gamma', author: 'two', overrides: { nope: 1 } });
      const extra = parseExtraProfiles({ profiles: [
        { id: 'knight-1', title: '騎士', profile: { ...base, name: 'Knight', author: 'three' } },
        { id: 'BAD', profile: base },
      ] });
      expect(extra.bots).toHaveLength(1);
      expect(extra.bots[0].title).toBe('騎士');
      expect(extra.rejected).toHaveLength(1);
      const roster = loadRoster({ dir, extra: extra.bots });
      expect(roster.bots.map((b) => b.id)).toEqual(['baike', 'example-demo', 'alpha', 'knight-1']);
      expect(roster.rejected.map((r) => r.id).sort()).toEqual(['beta', 'gamma']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed community-bots folder, template and examples all pass', () => {
    const dir = defaultCommunityDir();
    expect(checkBotFolder(path.join(dir, '_template')).ok).toBe(true);
    const roster = loadRoster({ dir });
    expect(roster.rejected).toEqual([]);
    expect(roster.bots.filter((b) => b.source === 'example').length).toBeGreaterThanOrEqual(2);
  });
});
