/**
 * Panel C — 對戰風格快照 per-player metric extractor.
 *
 * Edward 2026-04-26 夜間任務 3.
 *
 * Per-player metrics emitted to TSV (read by build_panel_c_playstyle.py patcher):
 *
 *  1. R3+ rejectRate split per game role camp (red vs blue):
 *       r3RejectRedNum  / r3RejectRedDen
 *       r3RejectBlueNum / r3RejectBlueDen
 *     (numerator = reject votes cast by player in R3-R5; denominator = all votes
 *      cast by player in R3-R5; per-camp = where the player's role in that game
 *      was red/blue.)
 *
 *  2. Assassin target seat preference (only when the player WAS the assassin
 *     and the game reached 三藍活/三藍死, i.e. assassinTargetSeat exists):
 *       assassinAttempts  total
 *       assassinTargetSeatHist : map seat→count (1..10)
 *     Top-3 seats picked off in patcher when attempts >= 3.
 *
 *  3. Captain (leader) stickiness — proposal-level "same team next" rate:
 *       leaderProposals       total proposals where this player was leader AND a
 *                             next-proposal exists in the same round
 *       leaderProposalsSame   subset where teamSeats(P_k) === teamSeats(P_{k+1})
 *     (mirrors L137 game-level definition but bucketed per leader-player.)
 *
 * Read-only Firestore. Idempotent. Does not mutate production cache.
 *
 * Run:
 *   GOOGLE_APPLICATION_CREDENTIALS=/mnt/c/Users/admin/.claude/credentials/avalon-game-platform-firebase-adminsdk.json \
 *   FIREBASE_PROJECT_ID=avalon-game-platform \
 *   pnpm tsx scripts/analyze_panel_c_playstyle.ts
 */
import * as fs from 'fs';
import {
  RoleLabel,
  STAGING_DIR,
  campOf,
  deriveRoleLabel,
  getPlayerCount,
  initAdmin,
  isRealGame,
  loadAllGames,
} from './_shared_3outcome';

const OUTPUT_TSV = `${STAGING_DIR}/real_games_panel_c_playstyle.tsv`;

interface PlayerAgg {
  player_id: string;
  totalGames: number;

  // R3+ reject vote split per game-role camp
  r3VotesRed: number;
  r3RejectsRed: number;
  r3VotesBlue: number;
  r3RejectsBlue: number;

  // Assassin attempts / target seats (only games where this player was assassin
  // AND game reached threeBlue_*).
  assassinAttempts: number;
  assassinTargetSeatHist: Map<number, number>;

  // Leader (captain) same-team next-proposal counts
  leaderProposals: number;
  leaderProposalsSame: number;
}

function newAgg(player_id: string): PlayerAgg {
  return {
    player_id,
    totalGames: 0,
    r3VotesRed: 0, r3RejectsRed: 0,
    r3VotesBlue: 0, r3RejectsBlue: 0,
    assassinAttempts: 0,
    assassinTargetSeatHist: new Map(),
    leaderProposals: 0, leaderProposalsSame: 0,
  };
}

function getOrInit(map: Map<string, PlayerAgg>, pid: string): PlayerAgg {
  let a = map.get(pid);
  if (!a) { a = newAgg(pid); map.set(pid, a); }
  return a;
}

async function main(): Promise<void> {
  initAdmin();

  const t0 = Date.now();
  const allGames = await loadAllGames();
  const realGames = allGames.filter(isRealGame);

  const perPlayer = new Map<string, PlayerAgg>();

  for (const g of realGames) {
    const playerCount = getPlayerCount(g.playerSeats);

    // Derive seat → role label
    const seatRole: (RoleLabel | null)[] = new Array(11).fill(null);
    for (let seat = 1; seat <= 10; seat++) {
      const pid = g.playerSeats[seat - 1];
      if (!pid) continue;
      seatRole[seat] = deriveRoleLabel(seat, g.finalResult.roles, playerCount);
    }

    // Bump game count for every player who sat in this game (regardless of role).
    for (let seat = 1; seat <= 10; seat++) {
      const pid = g.playerSeats[seat - 1];
      if (!pid) continue;
      getOrInit(perPlayer, pid).totalGames++;
    }

    if (!g.missions || g.missions.length === 0) continue;

    const sorted = [...g.missions].sort((a, b) =>
      a.round !== b.round ? a.round - b.round : a.proposalIndex - b.proposalIndex);

    // ── 1. R3+ vote stickiness (reject rate per camp) ──────────────────────
    for (const m of sorted) {
      if (m.round < 3) continue;
      if (!m.votes) continue; // sheets-imported games may have null
      // Vote array index = seat - 1? Convention: votes[seat-1] aligns with playerSeats.
      // Verify via length match.
      if (m.votes.length !== g.playerSeats.length) {
        // Some legacy games may store length === playerCount; bail per-mission gracefully.
        // Still try to align by treating index as 0-based seat index up to playerCount.
      }
      for (let seat = 1; seat <= 10; seat++) {
        const pid = g.playerSeats[seat - 1];
        if (!pid) continue;
        const v = m.votes[seat - 1];
        if (v !== 'approve' && v !== 'reject') continue;
        const role = seatRole[seat];
        if (!role || role === 'unknown') continue;
        const c = campOf(role);
        if (c === 'good') {
          const a = getOrInit(perPlayer, pid);
          a.r3VotesBlue++;
          if (v === 'reject') a.r3RejectsBlue++;
        } else if (c === 'evil') {
          const a = getOrInit(perPlayer, pid);
          a.r3VotesRed++;
          if (v === 'reject') a.r3RejectsRed++;
        }
      }
    }

    // ── 2. Assassin target seat preference ────────────────────────────────
    // Only games where assassinTargetSeat is set.
    const target = g.finalResult.assassinTargetSeat;
    const assassinSeat = g.finalResult.roles.assassin;
    if (target !== undefined && target !== null && assassinSeat !== undefined) {
      const assassinPid = g.playerSeats[assassinSeat - 1];
      if (assassinPid) {
        const a = getOrInit(perPlayer, assassinPid);
        a.assassinAttempts++;
        a.assassinTargetSeatHist.set(target, (a.assassinTargetSeatHist.get(target) || 0) + 1);
      }
    }

    // ── 3. Leader (captain) stickiness — same-team next proposal ──────────
    for (let i = 0; i + 1 < sorted.length; i++) {
      const A = sorted[i];
      const B = sorted[i + 1];
      if (A.round !== B.round) continue;
      if (B.proposalIndex !== A.proposalIndex + 1) continue;

      const leaderPid = g.playerSeats[A.leaderSeat - 1];
      if (!leaderPid) continue;

      const setA = new Set(A.teamSeats);
      const setB = new Set(B.teamSeats);
      let same = setA.size === setB.size;
      if (same) {
        for (const s of setA) if (!setB.has(s)) { same = false; break; }
      }

      const a = getOrInit(perPlayer, leaderPid);
      a.leaderProposals++;
      if (same) a.leaderProposalsSame++;
    }
  }

  const t1 = Date.now();
  const dur = ((t1 - t0) / 1000).toFixed(1);

  // Emit TSV
  const header = [
    'player_id',
    'total_games',
    'r3_votes_red', 'r3_rejects_red',
    'r3_votes_blue', 'r3_rejects_blue',
    'assassin_attempts',
    'assassin_target_seat_hist', // JSON: {"seat":count}
    'leader_proposals', 'leader_proposals_same',
  ].join('\t');

  const lines: string[] = [header];
  const sortedAggs = [...perPlayer.values()].sort((a, b) => b.totalGames - a.totalGames);
  for (const a of sortedAggs) {
    const histObj: Record<string, number> = {};
    for (const [seat, count] of a.assassinTargetSeatHist) histObj[String(seat)] = count;
    lines.push([
      a.player_id,
      a.totalGames,
      a.r3VotesRed, a.r3RejectsRed,
      a.r3VotesBlue, a.r3RejectsBlue,
      a.assassinAttempts,
      JSON.stringify(histObj),
      a.leaderProposals, a.leaderProposalsSame,
    ].join('\t'));
  }

  fs.writeFileSync(OUTPUT_TSV, lines.join('\n') + '\n');
  console.log(`[panel_c] wrote ${OUTPUT_TSV}`);
  console.log(`[panel_c] players: ${perPlayer.size}; real games: ${realGames.length}; dur ${dur}s`);

  // Sanity prints
  const top = sortedAggs.slice(0, 3);
  for (const a of top) {
    const r3RedPct = a.r3VotesRed > 0 ? ((a.r3RejectsRed / a.r3VotesRed) * 100).toFixed(1) : 'NA';
    const r3BluePct = a.r3VotesBlue > 0 ? ((a.r3RejectsBlue / a.r3VotesBlue) * 100).toFixed(1) : 'NA';
    const stk = a.leaderProposals > 0 ? ((a.leaderProposalsSame / a.leaderProposals) * 100).toFixed(1) : 'NA';
    console.log(`  ${a.player_id}: games=${a.totalGames} r3RedRej=${r3RedPct}% r3BlueRej=${r3BluePct}% asnAttempts=${a.assassinAttempts} stk=${stk}%`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
