/**
 * SelfPlayEngine — 2026-10-12 harness fixes:
 *   - Percival's `knownEvils` is empty (wizards go to `knownWizards`),
 *     matching GameServer.buildBotObservation;
 *   - agents that expose the agent-level lake API decide the lake
 *     themselves (so per-agent AgentTuning applies);
 *   - the result carries the mission / assassination stage breakdown.
 */
import { describe, it, expect } from 'vitest';
import { SelfPlayEngine } from './SelfPlayEngine';
import { HeuristicAgent } from './HeuristicAgent';
import { RandomAgent } from './RandomAgent';
import { LEGACY_AGENT_TUNING } from './AgentTuning';
import type { AgentAction, AvalonAgent, PlayerObservation } from './types';

class ProbeAgent implements AvalonAgent {
  readonly agentId: string;
  readonly agentType = 'heuristic' as const;
  readonly inner: HeuristicAgent;
  startObs: PlayerObservation | null = null;
  lakePicks = 0;
  lakeClaims = 0;

  constructor(id: string) {
    this.agentId = id;
    this.inner = new HeuristicAgent(id, undefined, undefined, { ...LEGACY_AGENT_TUNING });
  }
  onGameStart(obs: PlayerObservation): void {
    this.startObs = obs;
    this.inner.onGameStart(obs);
  }
  act(obs: PlayerObservation): AgentAction {
    return this.inner.act(obs);
  }
  pickLakeTarget(obs: PlayerObservation, validTargets?: readonly string[]): string {
    this.lakePicks++;
    return this.inner.pickLakeTarget(obs, validTargets);
  }
  declareLake(obs: PlayerObservation, targetId: string, trueFaction: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
    this.lakeClaims++;
    return this.inner.declareLake(obs, targetId, trueFaction);
  }
  onGameEnd(obs: PlayerObservation, won: boolean): void {
    this.inner.onGameEnd(obs, won);
  }
}

describe('SelfPlayEngine — observation wiring (2026-10-12)', () => {
  const engine = new SelfPlayEngine();

  it('Percival gets knownEvils=[] and two knownWizards; Merlin sees three evils', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => new ProbeAgent(`H-${i + 1}`));
    const result = await engine.runGame(agents, false);
    expect(result.playerCount).toBe(10);

    const percival = agents.find((a) => a.startObs?.myRole === 'percival');
    expect(percival?.startObs).toBeTruthy();
    expect(percival!.startObs!.knownEvils).toEqual([]);
    expect(percival!.startObs!.knownWizards).toHaveLength(2);
    expect(percival!.startObs!.knownWizards).not.toContain(percival!.agentId);

    const merlin = agents.find((a) => a.startObs?.myRole === 'merlin');
    expect(merlin!.startObs!.knownEvils).toHaveLength(3); // 刺 + 娜 + 奧 (not Mordred)
    expect(merlin!.startObs!.knownWizards).toBeUndefined();

    const loyal = agents.find((a) => a.startObs?.myRole === 'loyal');
    expect(loyal!.startObs!.knownEvils).toEqual([]);
  }, 20_000);

  it('routes the lake decision through the holder agent when it has the lake API', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => new ProbeAgent(`H-${i + 1}`));
    await engine.runGame(agents, false);
    // Every 10-player game reaches round 3, so the lake after round 2 is used.
    const picks = agents.reduce((a, b) => a + b.lakePicks, 0);
    const claims = agents.reduce((a, b) => a + b.lakeClaims, 0);
    expect(picks).toBeGreaterThanOrEqual(1);
    expect(claims).toBe(picks);
  }, 20_000);

  it('still runs with agents that lack the lake API (policy fallback)', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => new RandomAgent(`R-${i + 1}`));
    const result = await engine.runGame(agents, false);
    expect(['good', 'evil']).toContain(result.winner);
  }, 20_000);

  it('reports the mission / assassination stages consistently with the winner', async () => {
    const agents = Array.from({ length: 10 }, (_, i) => new ProbeAgent(`H-${i + 1}`));
    for (let g = 0; g < 3; g++) {
      const r = await engine.runGame(agents, false);
      expect(r.questResults).toBeDefined();
      const successes = r.questResults!.filter((q) => q === 'success').length;
      const fails = r.questResults!.filter((q) => q === 'fail').length;
      expect(r.threeBlue).toBe(successes >= 3);
      if (r.threeBlue) {
        expect(fails).toBeLessThan(3);
        expect(r.merlinKilled).toBe(r.winner === 'evil');
      } else {
        expect(fails).toBe(3);
        expect(r.winner).toBe('evil');
        expect(r.merlinKilled).toBeNull();
      }
    }
  }, 30_000);
});
