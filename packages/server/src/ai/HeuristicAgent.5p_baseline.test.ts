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

  // ── v2 backlog #1 — Merlin selectTeam knownEvils hard-exclude ──
  //
  // Edge bug (pre-fix): when Merlin's natural selectTeam produced a
  // banned combo at R1-P1 (e.g. seat-1 Merlin with evils at seats 3
  // & 5 → natural `12` banned), `rewriteIfBannedR1P1Combo` walked the
  // unfiltered swap pool in seat order and could surface a knownEvil
  // (e.g. swap p2 → p3 producing `13` containing the seat-3 evil).
  //
  // Fix excludes knownEvils from the swap pool for good players, so
  // Merlin's R1-P1 team can never include a privately-known evil
  // even when the natural pick is banned and a swap is required.
  //
  // Tests cover R1-R5 (every attempt). For R2-R5, no banned-combo
  // rewrite fires (R1-P1 specific) but the natural byTier+slice path
  // also excludes knownEvils — these assertions guard regression.
  describe('5p Merlin selectTeam — never includes knownEvils (R1-R5)', () => {
    it('5p R1-P1 leader seat-1 Merlin (evils seats 3 & 5) never picks knownEvil', () => {
      // Pre-fix: natural `[p1, p2]` = `12` banned → swap p2 → p3 (evil)
      // → `13` not banned but includes knownEvil seat-3.
      const agent = new HeuristicAgent('p1', 'normal');
      const obs = buildR1P1Obs(
        'p1',
        'merlin',
        'good',
        ['p3', 'p5'], // evils at seats 3 (morgana) + 5 (assassin)
        [],
      );
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        expect(action.type).toBe('team_select');
        if (action.type !== 'team_select') return;
        // Self always on team.
        expect(action.teamIds).toContain('p1');
        expect(action.teamIds.length).toBe(2);
        // Never include known evils.
        expect(action.teamIds).not.toContain('p3');
        expect(action.teamIds).not.toContain('p5');
        // Banned combos still avoided.
        const seats = action.teamIds
          .map((id) => obs.allPlayerIds.indexOf(id) + 1)
          .sort((a, b) => a - b)
          .join('');
        expect(seats).not.toBe('12');
        expect(seats).not.toBe('15');
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R1-P1 leader seat-5 Merlin (evils seats 2 & 3) never picks knownEvil', () => {
      // Pre-fix: natural `[p5, p1]` = `15` banned → swap p1 → p2 (evil)
      // → `25` not banned but includes knownEvil seat-2.
      const agent = new HeuristicAgent('p5', 'normal');
      const obs = buildR1P1Obs(
        'p5',
        'merlin',
        'good',
        ['p2', 'p3'], // evils at seats 2 + 3
        [],
      );
      const rng = vi.spyOn(Math, 'random').mockReturnValue(0.001);
      try {
        const action = agent.act(obs);
        if (action.type !== 'team_select') return;
        expect(action.teamIds).toContain('p5');
        expect(action.teamIds.length).toBe(2);
        expect(action.teamIds).not.toContain('p2');
        expect(action.teamIds).not.toContain('p3');
      } finally {
        rng.mockRestore();
      }
    });

    it('5p R2-R5 Merlin selectTeam never includes knownEvils (every attempt)', () => {
      // R2-R5 path bypasses the R1-P1 ban rewrite. Natural byTier+slice
      // sorts knownEvils last so they should never surface unless team
      // size exceeds non-evil count (impossible in 5p: 2 non-evil
      // others always cover R2/R4/R5 teamSize=3 with self).
      const merlinId = 'p1';
      const knownEvils = ['p3', 'p5'];
      // Pretend prior round happened so we're past R1-P1.
      const baseHistory = [
        {
          round: 1,
          attempt: 1,
          leader: 'p1',
          team: ['p1', 'p4'],
          approved: true,
          votes: { p1: true, p2: true, p3: true, p4: true, p5: true },
        },
      ];
      const baseQuest = [
        { round: 1, team: ['p1', 'p4'], result: 'success' as const, failCount: 0 },
      ];
      for (let round = 2; round <= 5; round++) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          const obs: PlayerObservation = {
            myPlayerId: merlinId,
            myRole: 'merlin',
            myTeam: 'good',
            knownEvils,
            knownWizards: [],
            allPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
            playerCount: 5,
            currentRound: round,
            currentLeader: merlinId,
            proposedTeam: [],
            questResults: ['success'],
            questHistory: baseQuest,
            voteHistory: baseHistory,
            failCount: attempt - 1,
            gamePhase: 'team_select',
          } as PlayerObservation;
          const agent = new HeuristicAgent(merlinId, 'normal');
          const action = agent.act(obs);
          expect(action.type).toBe('team_select');
          if (action.type !== 'team_select') continue;
          expect(action.teamIds).toContain(merlinId);
          for (const evil of knownEvils) {
            expect(
              action.teamIds,
              `R${round}-P${attempt} merlin team must not contain known evil ${evil}, got ${JSON.stringify(action.teamIds)}`,
            ).not.toContain(evil);
          }
        }
      }
    });
  });
});
