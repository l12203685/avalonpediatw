/**
 * 5p Baseline alignment tests — Edward 2026-05-06.
 *
 * Verifies the 5p R1-P1 banned-combo enforcement (HR-5/HR-7 alignment).
 * 5p teamSize=2 at R1, banned set is {12, 34, 45, 15} (consecutive
 * pairs including the ring wrap-around 51).
 *
 * Edward 2026-05-06 16:09 校正:
 *   「23 不算無腦組合, 因為這是五人局」 — 23 從 banned set 中移除.
 *
 * See:
 *   - staging/subagent_results/5p_baseline_audit_2026-05-06.md (HR audit)
 *   - staging/subagent_results/wiki_merged_to_M_2026-05-05.md (HR-5/HR-7)
 *   - staging/subagent_results/top10_red_blue_decision_pattern_2026-05-05.md (TOP10 49.1% mix)
 *   - staging/subagent_results/5p_baseline_v2_fix_2026-05-06.md (16:09 verbatim 7-correction)
 */

import { describe, expect, it, vi } from 'vitest';
import { HeuristicAgent } from './HeuristicAgent';
import type { PlayerObservation } from './types';

// ── Helpers ────────────────────────────────────────────────────
function buildR1P1Obs(
  myPlayerId: string,
  myRole: 'merlin' | 'percival' | 'loyal' | 'assassin' | 'morgana',
  myTeam: 'good' | 'evil',
  knownEvils: string[] = [],
  knownWizards: string[] = [],
): PlayerObservation {
  return {
    myPlayerId,
    myRole,
    myTeam,
    knownEvils,
    knownWizards,
    allPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    playerCount: 5,
    currentRound: 1,
    currentLeader: myPlayerId,
    proposedTeam: [],
    questResults: [],
    questHistory: [],
    voteHistory: [],
    failCount: 0,
    gamePhase: 'team_select',
  } as PlayerObservation;
}

// ── Tests ────────────────────────────────────────────────────
describe('5p Baseline R1-P1 banned combos', () => {
  describe('HR-5 + HR-7 — consecutive pair seats banned', () => {
    it('5p R1-P1 leader p1 (Merlin) — must NOT propose 12/15', () => {
      const agent = new HeuristicAgent('p1', 'normal');
      const obs = buildR1P1Obs(
        'p1',
        'merlin',
        'good',
        ['p4', 'p5'], // assassin + morgana
        [],
      );
      // Force deterministic behaviour for any RNG branches.
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        expect(action.type).toBe('team_select');
        if (action.type !== 'team_select') return;
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        // Banned: 12, 15 — leader p1 (seat 1) cannot pair with seat 2 or seat 5.
        expect(seats).not.toBe('12');
        expect(seats).not.toBe('15');
        expect(action.teamIds).toContain('p1'); // leader always on team
        expect(action.teamIds.length).toBe(2);
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R1-P1 leader p2 (Loyal) — must NOT propose 12 (23 allowed per Edward 16:09)', () => {
      const agent = new HeuristicAgent('p2', 'normal');
      const obs = buildR1P1Obs('p2', 'loyal', 'good', [], []);
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        if (action.type !== 'team_select') return;
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        expect(seats).not.toBe('12');
        // 23 is now ALLOWED per Edward 2026-05-06 16:09 verbatim:
        //   「23 不算無腦組合, 因為這是五人局」
        expect(action.teamIds).toContain('p2');
        expect(action.teamIds.length).toBe(2);
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R1-P1 leader p3 (Percival) — must NOT propose 34 (23 allowed per Edward 16:09)', () => {
      const agent = new HeuristicAgent('p3', 'normal');
      const obs = buildR1P1Obs(
        'p3',
        'percival',
        'good',
        [],
        ['p1', 'p4'], // wizards = merlin + morgana candidates
      );
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        if (action.type !== 'team_select') return;
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        // 23 is now ALLOWED per Edward 2026-05-06 16:09 校正.
        expect(seats).not.toBe('34');
        expect(action.teamIds).toContain('p3');
        expect(action.teamIds.length).toBe(2);
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R1-P1 leader p4 (Assassin) — must NOT propose 34/45', () => {
      const agent = new HeuristicAgent('p4', 'normal');
      const obs = buildR1P1Obs(
        'p4',
        'assassin',
        'evil',
        ['p4', 'p5'], // self + morgana
        [],
      );
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        if (action.type !== 'team_select') return;
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        expect(seats).not.toBe('34');
        expect(seats).not.toBe('45');
        expect(action.teamIds).toContain('p4');
        expect(action.teamIds.length).toBe(2);
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R1-P1 leader p5 (Morgana) — must NOT propose 45/15', () => {
      const agent = new HeuristicAgent('p5', 'normal');
      const obs = buildR1P1Obs(
        'p5',
        'morgana',
        'evil',
        ['p4', 'p5'], // assassin + self
        [],
      );
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        if (action.type !== 'team_select') return;
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        expect(seats).not.toBe('45');
        expect(seats).not.toBe('15');
        expect(action.teamIds).toContain('p5');
        expect(action.teamIds.length).toBe(2);
      } finally {
        rng.mockRestore();
      }
    });
  });

  describe('5p R1-P2 onwards — banned-set NOT applied', () => {
    it('5p R1-P2 leader can propose 12 (banned only at R1-P1)', () => {
      const agent = new HeuristicAgent('p1', 'normal');
      const obs = buildR1P1Obs('p1', 'loyal', 'good', [], []);
      // Add a prior vote attempt → no longer R1-P1.
      (obs as { voteHistory: unknown[] }).voteHistory = [
        {
          round: 1,
          attempt: 1,
          leader: 'p2',
          team: ['p2', 'p3'],
          approved: false,
          votes: { p1: false, p2: true, p3: true, p4: false, p5: false },
        },
      ];
      // Should be allowed to land on banned combos when not R1-P1.
      const action = agent.act(obs);
      expect(action.type).toBe('team_select');
    });
  });

  describe('5p R1-P1 fallback — emergency degenerate', () => {
    it('5p R1-P1 always returns a team of size 2', () => {
      // Try every possible leader seat; verify team size is always 2.
      for (let seat = 0; seat < 5; seat++) {
        const myId = `p${seat + 1}`;
        const agent = new HeuristicAgent(myId, 'normal');
        const obs = buildR1P1Obs(
          myId,
          seat === 0 ? 'merlin' : seat === 1 ? 'loyal' : seat === 2 ? 'percival' : seat === 3 ? 'assassin' : 'morgana',
          seat <= 2 ? 'good' : 'evil',
          seat >= 3 ? ['p4', 'p5'] : [],
          [],
        );
        const action = agent.act(obs);
        expect(action.type).toBe('team_select');
        if (action.type === 'team_select') {
          expect(action.teamIds.length).toBe(2);
          expect(action.teamIds).toContain(myId);
        }
      }
    });
  });
});
