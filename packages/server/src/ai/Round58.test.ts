/**
 * 第 58 回合（站長 2026-11-20：梅林「要從公開資訊中找到符合自己內建資訊 盡可能避開三個可見紅方拇指…除非逼不得已…只能依據忠臣資訊去派拇指」）：
 * `merlinPublicThumb58`／`merlinPublicThumbScope58`／`merlinOwnRank58`（預設關），以及網站 Room-17 一局（2026-11-20，DC #牌譜紀錄與覆盤，決策 #130）的驗收案例。
 */
import { describe, expect, it } from 'vitest';
import type { AgentTuning } from './AgentTuning';
import type { PlayerObservation } from './types';
import { DEFAULT_AGENT_TUNING, LEGACY_AGENT_TUNING, parseTuningFlag } from './AgentTuning';
import { publicThumb58Applies, publicThumb58FallbackOn, round58Stats } from './Round58';
import { tuningForOpponent } from './humanProfile';
import { HeuristicAgent } from './HeuristicAgent';
import { ForwardAgent } from './forward/ForwardAgent';
import { withSeededRandom } from './benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId } from './benchmark/replayObservation';
import type { ReplayGame, ReplayProposal } from './benchmark/sheetsReplay';

const T = (over: Partial<AgentTuning> = {}): AgentTuning => ({ ...DEFAULT_AGENT_TUNING, ...over });
const obsAt = (round: number, failCount: number, role = 'merlin'): PlayerObservation =>
  ({ myRole: role, currentRound: round, failCount } as unknown as PlayerObservation);

describe('round 58 flags', () => {
  it('exist, off in both tables, parse', () => {
    for (const t of [LEGACY_AGENT_TUNING, DEFAULT_AGENT_TUNING]) {
      expect(t.merlinPublicThumb58).toBe(0);
      expect(t.merlinPublicThumbScope58).toBe(0);
      expect(t.merlinOwnRank58).toBe(0);
    }
    expect(parseTuningFlag('merlinPublicThumb58')).toEqual({ merlinPublicThumb58: 0.5 });
    expect(parseTuningFlag('merlinPublicThumb58=0.7')).toEqual({ merlinPublicThumb58: 0.7 });
    expect(parseTuningFlag('merlinPublicThumbScope58=2')).toEqual({ merlinPublicThumbScope58: 2 });
    expect(parseTuningFlag('merlinOwnRank58')).toEqual({ merlinOwnRank58: 0.5 });
    expect(() => parseTuningFlag('merlinPublicThumb58=1.5')).toThrow();
    expect(() => parseTuningFlag('merlinPublicThumbScope58=5')).toThrow();
    expect(() => parseTuningFlag('merlinOwnRank58=2')).toThrow();
    // own ranking alone (no thumb step): applies at every Merlin proposal
    expect(publicThumb58Applies(T({ merlinOwnRank58: 0.5 }), obsAt(1, 0))).toBe(true);
    expect(publicThumb58FallbackOn(T({ merlinOwnRank58: 0.5 }), obsAt(1, 0))).toBe(false);
  });

  it('scope: low go-rate proposals (R1–R2 non-forced) by default; 2 = every non-forced; 3 = every proposal; Merlin only', () => {
    const on = T({ merlinPublicThumb58: 0.7 });
    expect(publicThumb58FallbackOn(on, obsAt(1, 0))).toBe(true);
    expect(publicThumb58FallbackOn(on, obsAt(2, 3))).toBe(true);
    expect(publicThumb58FallbackOn(on, obsAt(2, 4))).toBe(false); // forced
    expect(publicThumb58FallbackOn(on, obsAt(3, 0))).toBe(false); // 25% go
    expect(publicThumb58FallbackOn(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 2 }), obsAt(3, 0))).toBe(true);
    expect(publicThumb58FallbackOn(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 2 }), obsAt(3, 4))).toBe(false);
    expect(publicThumb58FallbackOn(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 3 }), obsAt(3, 4))).toBe(true);
    expect(publicThumb58FallbackOn(on, obsAt(1, 0, 'loyal'))).toBe(false);
    // 4 = never (own ranking only)
    expect(publicThumb58FallbackOn(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 4 }), obsAt(1, 0))).toBe(false);
    expect(publicThumb58Applies(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 4 }), obsAt(1, 0))).toBe(false);
    expect(publicThumb58Applies(T({ merlinPublicThumb58: 0.7, merlinPublicThumbScope58: 4, merlinOwnRank58: 1 }), obsAt(1, 0))).toBe(true);
    expect(publicThumb58Applies(T(), obsAt(1, 0))).toBe(false);
    // own ranking: every Merlin proposal (the thumb step keeps its scope)
    expect(publicThumb58Applies(T({ merlinPublicThumb58: 0.7, merlinOwnRank58: 1 }), obsAt(3, 4))).toBe(true);
    expect(publicThumb58FallbackOn(T({ merlinPublicThumb58: 0.7, merlinOwnRank58: 1 }), obsAt(3, 4))).toBe(false);
  });
});

/**
 * 網站 Room-17（2026-11-20 13:07，十人局，百科AI 九席＋真人一席；座位照網站，10 = 0 家）：1 奧伯倫、3 莫甘娜、5 梅林、6 莫德雷德、10 刺客、9 派西，其他忠臣。
 * 第 1 局 456 失敗一張、第 2 局 3·6·8·10 失敗一張、湖 10 > 6 說好；第 3 局 3-5 由梅林 5 家派（紅方已兩勝，這一隊決定勝負）。
 * 梅林看得到 1、3、10：第 1 局 456 失敗 → 莫德雷德在 4、6 之一。現場派 5·6·7·9（6 = 莫德雷德）失敗，紅方三勝。
 * 票照現場（trace.json 的 approve）。
 */
const ROOM17_TEAMS = [
  [[1, 4, 6], [2, 6, 8], [3, 5, 10], [4, 5, 6], [4, 5, 6]],
  [[2, 3, 6, 8], [1, 6, 7, 9], [3, 6, 8, 10], [1, 5, 7, 9], [3, 6, 8, 10]],
  [[1, 3, 4, 5], [2, 5, 7, 9], [3, 5, 6, 7], [4, 7, 8, 9], [5, 6, 7, 9]],
];
const ROOM17_VOTES = ['1001010000', '0100010100', '0010100001', '0001110000', '0000000000', '0110010100', '1000011010', '0010010101', '1000101010', '0000000000',
  '1010000000', '0100000000', '0010010000', '0001000000', '0000000000'];

function room17(): ReplayGame {
  const proposals: ReplayProposal[] = [];
  let g = 0;
  ROOM17_TEAMS.forEach((rp, ri) => rp.forEach((t, ai) => {
    const votes = Array.from({ length: 10 }, (_, k) => ROOM17_VOTES[g][k] === '1');
    proposals.push({ round: ri + 1, attempt: ai + 1, globalIndex: g, leaderSeat: (g % 10) + 1, teamSeats: t, plusSeats: [], minusSeats: [], votes,
      approveCount: votes.filter(Boolean).length, forced: ai === 4, wentOnMission: ai === 4, votesReliable: ai < 4 });
    g++;
  }));
  return {
    id: 'room17', playerCount: 10, names: Array(10).fill(''), proposals,
    seatRoles: ['oberon', 'loyal', 'morgana', 'loyal', 'merlin', 'mordred', 'loyal', 'loyal', 'percival', 'assassin'],
    quests: [{ round: 1, teamSeats: [4, 5, 6], successCount: 2, failCount: 1, failed: true }, { round: 2, teamSeats: [3, 6, 8, 10], successCount: 3, failCount: 1, failed: true }],
    lakes: [{ round: 2, holderSeat: 10, targetSeat: 6, claim: 'good' }], lakeChainValid: true, winner: 'evil',
  } as unknown as ReplayGame;
}

/** 梅林 5 家的持續 agent 照現場的紀錄走到 3-5（第 15 次提議），回傳他在 1-5 與 3-5 派的隊。 */
function merlinTeams(tuning: AgentTuning): Record<string, number[]> {
  const game = room17();
  const seat = 5;
  const agent = new ForwardAgent(seatId(seat), new HeuristicAgent(seatId(seat), undefined, undefined, tuning));
  agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
  const out: Record<string, number[]> = {};
  for (let i = 0; i <= 14; i++) {
    const p = game.proposals[i];
    if (p.leaderSeat === seat) {
      const a = withSeededRandom(`room17|${seat}|team-${i}`, () => agent.act(buildReplayObservation(game, seat, { kind: 'team_select', proposal: i })));
      out[`${p.round}-${p.attempt}`] = a.type === 'team_select' ? a.teamIds.map(seatOfId).sort((x, y) => x - y) : [];
    }
    if (i < 14 && !p.forced) withSeededRandom(`room17|${seat}|vote-${i}`, () => agent.act(buildReplayObservation(game, seat, { kind: 'team_vote', proposal: i })));
  }
  return out;
}

describe('Room-17 (site, 2026-11-20, decision #130): Merlin 5 at 3-5', () => {
  it('current default re-sends 6 (the Mordred his own sight pins to {4, 6}); the thumb rule alone does not touch it (6 is no thumb)', () => {
    expect(merlinTeams(T())['3-5']).toEqual([5, 6, 7, 9]);
    expect(merlinTeams(T({ merlinPublicThumb58: 0.7 }))['3-5']).toEqual([5, 6, 7, 9]);
  }, 60000);

  it('merlinOwnRank58: a publicly reasonable team that leaves out both 4 and 6 (and every red he sees)', () => {
    const before = round58Stats.ownChanged;
    for (const r of [0.5, 0.7]) {
      const team = merlinTeams(T({ merlinPublicThumb58: r, merlinOwnRank58: 1 }))['3-5'];
      expect(team).toHaveLength(4);
      expect(team).toContain(5);
      expect(team.some((s) => [1, 3, 4, 6, 10].includes(s))).toBe(false);
    }
    expect(round58Stats.ownChanged).toBeGreaterThan(before);
    // the single-switch form used by the human-table profiles (round 58: merlinOwnRank58=0.5, no thumb step)
    expect(merlinTeams(T({ merlinOwnRank58: 0.5 }))['3-5']).toEqual([5, 7, 8, 9]);
    expect(merlinTeams(tuningForOpponent('avgHuman', T()))['3-5']).toEqual([5, 7, 8, 9]);
  }, 60000);
});
