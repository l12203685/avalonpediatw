import { describe, expect, it } from 'vitest';
import { SelfPlayEngine } from '../../ai/SelfPlayEngine';
import { playTable, quietly, type Entrant } from '../table';
import type { BotProfile } from '../profile';

const baike: Entrant = { id: 'baike', profile: null };
const loud: BotProfile = { schema: 1, name: 'Loud', author: 'octocat', style: 's', sides: { evil: { redNormalVote: 0, redHideHuman: false } } };
const bot: Entrant = { id: 'loud', profile: loud };

describe('arena table', () => {
  it('plays a mixed 5-player table reproducibly and reports every seat', async () => {
    const engine = new SelfPlayEngine();
    const seats = [bot, baike, bot, baike, baike];
    const a = await quietly(() => playTable(engine, seats, 'arena-test|0'));
    const b = await quietly(() => playTable(engine, seats, 'arena-test|0'));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.winner).toBe(b.winner);
    expect(a.seats).toHaveLength(5);
    expect(a.seats.filter((s) => s.team === 'evil')).toHaveLength(2);
    for (const s of a.seats) expect(s.won).toBe(s.team === a.winner);
    expect(a.seats.map((s) => s.entrant)).toEqual(['loud', 'baike', 'loud', 'baike', 'baike']);
    if (a.outcome === 'threeRed') expect(a.winner).toBe('evil');
    if (a.outcome === 'threeBlue') expect(a.winner).toBe('good');
    const assassins = a.seats.filter((s) => s.assassinHit !== undefined);
    expect(assassins.length).toBe(a.outcome === 'threeRed' ? 0 : 1);
  }, 60_000);
});
