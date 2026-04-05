import { describe, it, expect } from 'vitest';
import { SelfPlayEngine } from './SelfPlayEngine';
import { RandomAgent } from './RandomAgent';
import { HeuristicAgent } from './HeuristicAgent';

describe('SelfPlayEngine', () => {
  const engine = new SelfPlayEngine();

  it('runs a 5-player random game to completion', async () => {
    const agents = Array.from({ length: 5 }, (_, i) => new RandomAgent(`R-${i + 1}`));
    const result = await engine.runGame(agents, false);

    expect(result.playerCount).toBe(5);
    expect(['good', 'evil']).toContain(result.winner);
    expect(result.rounds).toBeGreaterThan(0);
    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.roomId).toMatch(/^AI-/);
  }, 10_000);

  it('runs a 7-player heuristic game to completion', async () => {
    const agents = Array.from({ length: 7 }, (_, i) => new HeuristicAgent(`H-${i + 1}`, 'normal'));
    const result = await engine.runGame(agents, false);

    expect(result.playerCount).toBe(7);
    expect(['good', 'evil']).toContain(result.winner);
    expect(result.rounds).toBeGreaterThan(0);
  }, 10_000);

  it('runs a mixed heuristic vs random batch of 3 games', async () => {
    const agents = Array.from({ length: 6 }, (_, i) =>
      i % 2 === 0 ? new HeuristicAgent(`H-${i + 1}`, 'normal') : new RandomAgent(`R-${i + 1}`)
    );
    const { results, goodWins, evilWins } = await engine.runBatch(agents, 3, false);

    expect(results).toHaveLength(3);
    expect(goodWins + evilWins).toBe(3);
  }, 30_000);

  it('rejects invalid player counts', async () => {
    const agents = Array.from({ length: 3 }, (_, i) => new RandomAgent(`R-${i + 1}`));
    await expect(engine.runGame(agents, false)).rejects.toThrow('Invalid player count');
  });
});
