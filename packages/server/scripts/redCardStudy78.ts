/* eslint-disable no-console -- CLI script: stdout is the interface */
/**
 * 第 78 回合：紅方的任務牌，全部真人局逐點重播（站長 2026-11-25「各角色的強者 × 百科AI」線索表第 2、5 項）。
 *
 *   cd packages/server && npx tsx scripts/redCardStudy78.ts --out rows.jsonl [--shard k/n] [--h-flag 開關=值 …] [--variant 標籤:開關=值,開關=值 …]
 *
 * 真人局 `games_cache.json` 十人局（百科AI 局不算），每一次任務、隊上的每一個紅方座位，用第 1 關的同一套重播
 * （同 `agreement.replaySeat`：只給那個座位當時知道的東西、亂數照「局號|座位|quest-局」）讓機器人出一次牌。
 * 和 `replaySeat` 不同的是「看不出是誰出的」那些牌（隊上兩個以上的紅、只出了一部分失敗）也重播——真人那一欄只有整隊的失敗張數。
 * 每點記：
 *   - 機器人的牌：H = 真人桌策略層（照開打前的 S 分弱／一般／強；S 不明 = 一般）、A = 基準線；兩個都記理由（`ForwardAgent` 的那一條規則）。
 *   - `--variant` 的開關各疊在 H、A 上面再出一次（欄位 `H標籤`、`A標籤`）。
 *   - 這個座位自己的後驗：P(隊上的紅 ≥ 2)、P(隊上的紅 ≥ 自己看得到的＋1)（= 隊上還有自己看不到的紅）。
 *   - 局面：第幾局、比分、隊伍人數、要幾張失敗、是不是強制局、自己是不是隊長；隊上實際的紅方角色、自己看得到幾個隊友在隊上；
 *     隊上其他人有幾個出過「有失敗牌的任務」（公開）。
 *   - 隊上剛好兩個相認紅、一張失敗就夠的格子（`Round78.pairMate78`）：兩個人的公開紀錄（`pairSt`：自己、隊友各一個字，F 出過／H 藏過／N 沒有）。
 *   - 牌譜：整隊的失敗張數、這個座位的牌能不能確定（0 張 = 都出成功、張數 = 紅方人數 = 都出失敗）、任務有沒有失敗、這一局最後紅方有沒有贏。
 *   - 座位 PR、桌上 S 與強度層。
 * 輸出一行一點的 JSONL（沒有名字；局號只用來對 `roleSpots.ts games` 的玩家編號，選強者用），另外每個紅方座位一行 `k:"seat"`（量尺換算的分母）。
 * 給 `redCardStudy78.py` 彙總。輸出放在 repo 外。
 */
import * as fs from 'fs';
import * as path from 'path';
import { AVALON_CONFIG } from '@avalon/shared';
import { getDefaultAgentTuning, parseTuningFlag, type AgentTuning } from '../src/ai/AgentTuning';
import { HeuristicAgent } from '../src/ai/HeuristicAgent';
import { ForwardAgent } from '../src/ai/forward/ForwardAgent';
import { PROFILE_OVERRIDES, opponentTypeOfTable } from '../src/ai/humanProfile';
import { pinnedQuestCard, withSeededRandom } from '../src/ai/benchmark/agreement';
import { buildReplayObservation, seatId } from '../src/ai/benchmark/replayObservation';
import { campOf } from '../src/ai/benchmark/sheetsReplay';
import { replayGamesFromDataset } from '../src/ai/benchmark/datasetReplay';
import { bayesOptionsOf, bayesTeamRedsBelow } from '../src/ai/belief/BayesBelief';
import { pairMate78, pairStatus78 } from '../src/ai/Round78';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const args = (name: string): string[] => argv.flatMap((x, i) => (x === name ? [argv[i + 1]] : []));

function flags(spec: string): Partial<AgentTuning> {
  const t: Partial<AgentTuning> = {};
  for (const f of spec.split(',').filter(Boolean)) Object.assign(t, parseTuningFlag(f));
  return t;
}

interface Variant { label: string; tuning: Partial<AgentTuning> }

const hFlags: Partial<AgentTuning> = flags(args('--h-flag').join(','));
const variants: Variant[] = args('--variant').map((v) => {
  const i = v.indexOf(':');
  return { label: v.slice(0, i), tuning: flags(v.slice(i + 1)) };
});
const ROLE_LETTER: Readonly<Record<string, string>> = { assassin: 'A', morgana: 'M', mordred: 'D', oberon: 'O' };

function main(): void {
  const file = arg('--dataset') ?? path.resolve(__dirname, '..', 'games_cache.json');
  const out = arg('--out');
  if (!out) throw new Error('--out required');
  const [k, n] = (arg('--shard') ?? '0/1').split('/').map(Number);
  const games = replayGamesFromDataset(JSON.parse(fs.readFileSync(file, 'utf8'))).games;
  const lines: string[] = [];
  let ti = -1;
  let points = 0;
  games.forEach((g, gi) => {
    const game = g.game;
    if (game.playerCount !== 10) return;
    ti += 1;
    if (ti % n !== k) return;
    const opp = opponentTypeOfTable({ humans: 9, tableS: g.s });
    const tier = g.s === null ? 'unknown' : opp;
    const red = (s: number): boolean => campOf(game.seatRoles[s - 1]) === 'evil';
    const redWon = game.winner === 'evil' ? 1 : 0;
    for (let seat = 1; seat <= 10; seat++) {
      if (!red(seat)) continue;
      const role = game.seatRoles[seat - 1];
      const id = seatId(seat);
      lines.push(JSON.stringify({ k: 'seat', gi, ti, gid: game.id, seat, role, tier, s: g.s, redWon }));
      const card = (tuning: Partial<AgentTuning>, round: number, why: boolean): { card: string; why: string } => {
        const obs = buildReplayObservation(game, seat, { kind: 'quest_vote', round });
        const seed = `${game.id}|${seat}|quest-${round}`;
        const agent = new HeuristicAgent(id, undefined, undefined, tuning);
        agent.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
        const act = withSeededRandom(seed, () => agent.act(obs));
        let reason = '';
        if (why) {
          try {
            const shadow = new HeuristicAgent(id, undefined, undefined, tuning);
            shadow.onGameStart(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 }));
            const d = withSeededRandom(seed, () => new ForwardAgent(id, shadow).decide(obs));
            reason = d.reasoningTrace.chosen.description.slice(0, 70);
          } catch { reason = 'err'; }
        }
        return { card: act.type === 'quest_vote' && act.vote === 'fail' ? 'F' : 'S', why: reason };
      };
      for (const q of game.quests) {
        if (!q.teamSeats.includes(seat)) continue;
        const round = q.round;
        const obs = buildReplayObservation(game, seat, { kind: 'quest_vote', round });
        const req = AVALON_CONFIG[10].questFailsRequired?.[round - 1] ?? 1;
        const prior = game.quests.filter((x) => x.round < round);
        const redSeats = q.teamSeats.filter(red);
        const pinned = pinnedQuestCard(game, round, seat);
        const approved = game.proposals.filter((p) => p.round === round).slice(-1)[0];
        const stained = new Set<number>();
        for (const x of prior) if (x.failCount > 0) for (const s of x.teamSeats) stained.add(s);
        const knownOn = q.teamSeats.filter((s) => s !== seat && obs.knownEvils.includes(seatId(s))).length;
        const row: Record<string, unknown> = {
          gi, ti, gid: game.id, seat, tier, s: g.s, pr: g.prs?.[seat - 1] ?? null, prov: g.prov?.[seat - 1] ?? null,
          role, round, bw: prior.filter((x) => !x.failed).length, rw: prior.filter((x) => x.failed).length,
          size: q.teamSeats.length, req, forced: approved?.forced ? 1 : 0, leader: approved?.leaderSeat === seat ? 1 : 0,
          reds: redSeats.length, redRoles: redSeats.map((s) => ROLE_LETTER[game.seatRoles[s - 1]] ?? '?').sort().join(''),
          knownOn, stainedOthers: q.teamSeats.filter((s) => s !== seat && stained.has(s)).length, selfStained: stained.has(seat) ? 1 : 0,
          fails: q.failCount, failed: q.failed ? 1 : 0, human: pinned === null ? null : pinned === 'fail' ? 'F' : 'S', redWon,
        };
        // 兩個相認紅同隊的格子（Round78.pairMate78）：自己／隊友的公開紀錄（F 出過、H 藏過、N 沒有）、自己的座位是不是在前面。
        const mate = pairMate78(obs);
        if (mate !== null) {
          row.pairSt = pairStatus78(obs, id, mate).join('');
          row.seatFirst = obs.allPlayerIds.indexOf(id) < obs.allPlayerIds.indexOf(mate) ? 1 : 0;
        }
        const team = q.teamSeats.map(seatId);
        const hOver: Partial<AgentTuning> = { ...PROFILE_OVERRIDES[opp], ...hFlags };
        for (const [col, over] of [['H', hOver], ['A', {}]] as const) {
          const v = card(over, round, true);
          row[col] = v.card;
          row[`${col}_why`] = v.why;
          const opts = bayesOptionsOf({ ...getDefaultAgentTuning(), ...over } as AgentTuning);
          const b2 = bayesTeamRedsBelow(obs, team, 2, opts);
          const bMore = bayesTeamRedsBelow(obs, team, knownOn + 2, opts);
          row[`${col}_p2`] = b2 === null ? null : +(1 - b2).toFixed(4);
          row[`${col}_pMore`] = bMore === null ? null : +(1 - bMore).toFixed(4);
          for (const v2 of variants) row[`${col}${v2.label}`] = card({ ...over, ...v2.tuning }, round, false).card;
        }
        lines.push(JSON.stringify(row));
        points += 1;
      }
    }
  });
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`shard ${k}/${n}: ${points} points`);
}

if (require.main === module) main();
