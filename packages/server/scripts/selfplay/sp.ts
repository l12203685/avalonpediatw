/* Self-play chunk runner for parallel runs (GitHub Actions selfplay.yml, or locally).
 * One arrangement per run: blue seats = DEFAULT_AGENT_TUNING + --flag k=v ..., red seats = DEFAULT.
 * Same seeding as the optimization loop's scratchpad runner (gameSeed = `${seed}|${i}`; every decision under
 * withSeededRandom), so a chunk here is game-by-game identical to the same chunk run locally.
 *
 *   cd packages/server && USE_FORWARD_REASONING=true npx tsx scripts/selfplay/sp.ts \
 *     --seed 423001 --from 0 --games 1000 --out X.json [--flag k=v ...]
 *
 * Output (compact, no game logs): {meta, cols, rows} with one row per game:
 *   [i, blueWon 0/1, threeBlue 0/1, merlinKilled 0/1/-1(n/a), firstMissionFailed 0/1, missionsFailed, h]
 * (round 44 adds: 1-1 leader's role, the 1-1 team relative to its leader (0 = the seat before), 1-1 approved, the leader+4 seat
 *  (5家) red, the seat before the leader (0家) red, first lake holder relative seat, first lake holder red)
 * where h = first 12 hex of sha1 over the game's proposals/quests/lakes/assassination (identity checks).
 * Logs print only progress counts (Actions logs are public).
 */
import * as fs from 'fs';
import { createHash } from 'crypto';
import type { Role } from '@avalon/shared';
import type { AgentAction, PlayerObservation } from '../../src/ai/types';
import { replayGameFromSelfPlay } from '../../src/ai/infl/strongData';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const { HeuristicAgent } = await import('../../src/ai/HeuristicAgent');
  const { SelfPlayEngine } = await import('../../src/ai/SelfPlayEngine');
  const { DEFAULT_AGENT_TUNING, parseTuningFlag, describeAgentTuning } = await import('../../src/ai/AgentTuning');
  const { cleanScores53, teamClean53 } = await import('../../src/ai/Round53');
  const { seededRandom, withSeededRandom } = await import('../../src/ai/benchmark/agreement');
  const n = Number(arg('--games') ?? 1000);
  const from = Number(arg('--from') ?? 0);
  const seed = arg('--seed') ?? '423001';
  const out = arg('--out');
  if (!out) throw new Error('--out PATH');
  const variant = { ...DEFAULT_AGENT_TUNING };
  const redTuning = { ...DEFAULT_AGENT_TUNING };
  // Round 44 (analysis only): pseudo-flag force11=<c1|c2|c3|c23|c4|c5|tXYZ> forces a loyal 1-1 leader's first proposal
  // (seats relative to the 1-1 leader = P1; 0 = P10): c1 = leader + two of 4..0, c2 = leader + 2 + one of 4..0,
  // c3 = leader + 3 + one of 4..0, c23 = 1,2,3, c4 = leader out, three of 4..0, c5 = leader out, three of 2..0 holding 2 or 3;
  // tXYZ = that exact team. Uniform within the category under the decision's seeded random. Everything else is the default.
  let force11 = '';
  // round 44b: onlyLoyal11=1 stops a game at the 1-1 when its leader is not a loyal (no row); loyal-leader games run in full, unchanged
  let onlyLoyal11 = false;
  // round 45 (diagnosis only): detail=1 adds a column 'g' with the whole game in the game_db shape, seats relative to the
  // 1-1 leader (1..9, 0 = the seat before it): {c: config (assassin, morgana, mordred, oberon, percival, merlin), r: rounds
  // [{p: [[team, approvers]] ('' approvers = forced 5th), m: 'o'/'x' cards, f: seats that played fail}], l: lakes
  // [[holder, target, claim o/x/'']], a: assassination target}. Behaviour is unchanged (it only records).
  let detail = false;
  // round 46: lake45=1 adds the first lake's target (relative seat), whether it is red, and the claim (o / x / '').
  let lake45 = false;
  // 實驗 E-loyal（selfplay-runs-eloyal 分支限定，不在 main 的預設路徑）：eloyal=A|B 讓非忠臣座位（梅林、派西、紅方含奧伯倫）的
  // 提議與投票都交給「同一座位、只看公開資訊的預設忠臣」：myRole loyal、myTeam good，看不到紅方（knownEvils 清空）、
  // 拇指（knownWizards）、刺殺時的紅方名單；自己拿湖看到的結果保留（坐在那個位置的忠臣拿湖也會看到）。
  // 任務牌、湖的選人與宣告、刺殺照預設（紅方照預設出失敗、壞人持湖照預設宣告）。
  // A = 紅方連第 5 次強制提議也照忠臣；B = 紅方當第 5 次強制提議的隊長時照預設紅方挑隊（「除非是尾派自己是紅方」）；
  // C = 同 A，但派西照預設（用拇指；站長 11/19「除了派西維爾 所有人都用忠臣資訊去玩」）。
  let eloyal = '';
  const redDesc: string[] = [];
  let failLog: [number, string][] = [];
  // 第 53 回合（只量，行為不變）：pickAudit=1 在每一次「忠臣視角的好人隊長」（真的忠臣、派西，E-loyal 裡照忠臣的座位）挑隊時，記下
  // 機器人的隊和精確挑隊（含自己的隊裡 P(沒有紅) 最高；後驗權重、L1* 均勻權重）的比較，加一欄 'pa'：每個決策
  // [回合, 第幾次提議, 真角色碼 L/P/M/R, 機器人的隊真的全好 0/1, 後驗 P(機器人的隊), 後驗最高, 後驗最高那幾隊真的全好的平均,
  //  均勻 P(機器人的隊), 均勻最高, 均勻最高那幾隊真的全好的平均, 機器人的隊真的紅數]（P 取 3 位小數；算不出來 = −1）。
  let pickAudit = false;
  let paLog: (number | string)[][] = [];
  let gameAgents: { agentId: string; role: Role }[] = [];
  class SkipGame extends Error {}
  argv.forEach((a, i) => {
    if (a !== '--flag') return;
    const f = argv[i + 1];
    if (f.startsWith('force11=')) { force11 = f.slice('force11='.length); return; }
    if (f === 'onlyLoyal11=1') { onlyLoyal11 = true; return; }
    if (f === 'detail=1') { detail = true; return; }
    if (f === 'lake45=1') { lake45 = true; return; }
    if (f === 'pickAudit=1') { pickAudit = true; return; }
    if (f.startsWith('eloyal=')) { eloyal = f.slice('eloyal='.length); if (eloyal !== 'A' && eloyal !== 'B' && eloyal !== 'C') throw new Error(`eloyal=${eloyal}?`); return; }
    // round 46: red.k=v applies an AgentTuning switch to the red seats (the usual --flag k=v is blue seats only)
    if (f.startsWith('red.')) { Object.assign(redTuning, parseTuningFlag(f.slice(4))); redDesc.push(f.slice(4)); return; }
    Object.assign(variant, parseTuningFlag(f));
  });
  // seats are relative to the 1-1 leader (the engine's first leader is not always P1): rel k -> the k-th seat from the leader
  // Seating = obs.allPlayerIds order (the engine shuffles seats; agent ids are not seat numbers).
  const relSeat = (seats: readonly string[], leader: string, c: string): string => {
    const L = seats.indexOf(leader); const k = c === '0' ? 10 : Number(c); return seats[(L + k - 1) % seats.length];
  };
  const relOf = (seats: readonly string[], leader: string, id: string): string => {
    const k = ((seats.indexOf(id) - seats.indexOf(leader) + seats.length) % seats.length) + 1; return k === 10 ? '0' : String(k);
  };
  const pickK = (pool: string[], k: number): string[] => {
    const a = [...pool];
    for (let j = a.length - 1; j > 0; j--) { const r = Math.floor(Math.random() * (j + 1)); [a[j], a[r]] = [a[r], a[j]]; }
    return a.slice(0, k);
  };
  const forcedTeam = (seats: readonly string[], leader: string, size: number): string[] | null => {
    const seatId = (c: string): string => relSeat(seats, leader, c);
    if (!force11 || size !== 3) return null;
    const rest = ['4', '5', '6', '7', '8', '9', '0'];
    if (force11.startsWith('t')) return force11.slice(1).split('').map(seatId);
    if (force11 === 'c1') return ['1', ...pickK(rest, 2)].map(seatId);
    if (force11 === 'c2') return ['1', '2', ...pickK(rest, 1)].map(seatId);
    if (force11 === 'c3') return ['1', '3', ...pickK(rest, 1)].map(seatId);
    if (force11 === 'c23') return ['1', '2', '3'].map(seatId);
    if (force11 === 'c4') return pickK(rest, 3).map(seatId);
    if (force11 === 'rand') return pickK(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], 3).map(seatId); // round 44b: any of the 120
    if (force11 === 'c5') {
      for (;;) { const t = pickK(['2', '3', ...rest], 3); if (t.includes('2') || t.includes('3')) return t.map(seatId); }
    }
    throw new Error(`force11=${force11}?`);
  };

  // The observation a real loyal in this seat would have: public information plus its own lake results only.
  const loyalOf = (obs: PlayerObservation): PlayerObservation => ({
    ...obs, myRole: 'loyal', myTeam: 'good', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, allEvilRoles: undefined,
    publicLoyalView: undefined, redLoyalView: undefined, seatTeam: 'good',
  });
  // E-loyal: this decision goes to the loyal shadow (team picks and votes of every non-loyal seat; B keeps a red forced-5th leader red)
  const blindHere = (obs: PlayerObservation): boolean => {
    if (!eloyal || obs.myRole === 'loyal') return false;
    if (eloyal === 'C' && obs.myRole === 'percival') return false;
    if (obs.gamePhase !== 'team_select' && obs.gamePhase !== 'team_vote') return false;
    if (eloyal === 'B' && obs.myTeam === 'evil' && obs.gamePhase === 'team_select' && obs.failCount >= 4) return false;
    return true;
  };

  class Seat {
    readonly agentType = 'heuristic' as const;
    private readonly blue: InstanceType<typeof HeuristicAgent>;
    private readonly red: InstanceType<typeof HeuristicAgent>;
    private inner: InstanceType<typeof HeuristicAgent>;
    private readonly shadow: InstanceType<typeof HeuristicAgent>;
    gameSeed = '';
    role: Role = 'loyal';
    final: PlayerObservation | null = null;
    killed: string | undefined;
    constructor(readonly agentId: string) {
      this.blue = new HeuristicAgent(agentId, undefined, undefined, { ...variant });
      this.red = new HeuristicAgent(agentId, undefined, undefined, { ...redTuning });
      this.inner = this.red;
      this.shadow = new HeuristicAgent(agentId, undefined, undefined, { ...variant });
    }
    private seedFor(obs: PlayerObservation, extra = ''): string {
      return [this.gameSeed, obs.myPlayerId, obs.gamePhase, `R${obs.currentRound}`, `A${obs.failCount}`,
        `V${obs.voteHistory.length}`, `Q${obs.questHistory.length}`, `L${obs.lakeHistory?.length ?? 0}`, obs.proposedTeam.join(','), extra].join('|');
    }
    onGameStart(obs: PlayerObservation): void {
      this.role = obs.myRole; this.final = null; this.killed = undefined;
      this.inner = obs.myTeam === 'good' ? this.blue : this.red; this.inner.onGameStart(obs);
      if (eloyal) this.shadow.onGameStart(loyalOf(obs));
    }
    act(obs: PlayerObservation): AgentAction {
      if (onlyLoyal11 && obs.gamePhase === 'team_select' && (obs.currentRound ?? 1) === 1 && obs.voteHistory.length === 0 && obs.myRole !== 'loyal') throw new SkipGame();
      const blind = blindHere(obs);
      const dobs: PlayerObservation = blind ? loyalOf(obs) : { ...obs, seatTeam: obs.myTeam };
      let a = withSeededRandom(this.seedFor(obs), () => (blind ? this.shadow.act(dobs) : this.inner.act(dobs)));
      if (pickAudit && a.type === 'team_select' && dobs.myTeam === 'good' && (dobs.myRole === 'loyal' || dobs.myRole === 'percival')) {
        const team = a.teamIds;
        withSeededRandom(this.seedFor(obs, 'audit'), () => {
          const reds = new Set(gameAgents.filter((x) => ['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(x.role)).map((x) => x.agentId));
          const clean = (t: readonly string[]): number => (t.some((id) => reds.has(id)) ? 0 : 1);
          const code = this.role === 'loyal' ? 'L' : this.role === 'percival' ? 'P' : this.role === 'merlin' ? 'M' : 'R';
          const r3 = (x: number | null): number => (x === null ? -1 : Math.round(x * 1000) / 1000);
          const argExp = (sc: { team: string[]; p: number }[] | null): [number, number] => {
            if (!sc || sc.length === 0) return [-1, -1];
            const best = Math.max(...sc.map((x) => x.p));
            const top = sc.filter((x) => x.p >= best - 1e-9);
            return [best, top.reduce((m, x) => m + clean(x.team), 0) / top.length];
          };
          const post = cleanScores53(dobs, team.length, 'posterior', variant);
          const unif = cleanScores53(dobs, team.length, 'uniform', variant);
          const [pm, pe] = argExp(post);
          const [um, ue] = argExp(unif);
          paLog.push([obs.currentRound ?? 0, (obs.failCount ?? 0) + 1, code, clean(team), r3(team.includes(dobs.myPlayerId) ? teamClean53(dobs, team, 'posterior', variant) : null), r3(pm), r3(pe),
            r3(team.includes(dobs.myPlayerId) ? teamClean53(dobs, team, 'uniform', variant) : null), r3(um), r3(ue), team.filter((id) => reds.has(id)).length]);
        });
      }
      if (force11 && a.type === 'team_select' && obs.myRole === 'loyal' && (obs.currentRound ?? 1) === 1 && obs.voteHistory.length === 0) {
        const t = withSeededRandom(this.seedFor(obs, 'force11'), () => forcedTeam(obs.allPlayerIds, obs.myPlayerId, a.type === 'team_select' ? a.teamIds.length : 0));
        if (t) a = { type: 'team_select', teamIds: t };
      }
      if (a.type === 'assassinate') this.killed = a.targetId;
      if (detail && a.type === 'quest_vote' && a.vote === 'fail') failLog.push([obs.currentRound ?? 0, obs.myPlayerId]);
      return a;
    }
    pickLakeTarget(obs: PlayerObservation, valid?: readonly string[]): string {
      return withSeededRandom(this.seedFor(obs, 'lake'), () => this.inner.pickLakeTarget(obs, valid));
    }
    declareLake(obs: PlayerObservation, target: string, truth: 'good' | 'evil' | undefined): 'good' | 'evil' | null {
      return withSeededRandom(this.seedFor(obs, `claim-${target}`), () => this.inner.declareLake(obs, target, truth));
    }
    onGameEnd(obs: PlayerObservation, won: boolean): void { this.final = obs; this.inner.onGameEnd(obs, won); if (eloyal) this.shadow.onGameEnd(obs, won); }
  }

  const engine = new SelfPlayEngine();
  const rows: (number | string)[][] = [];
  const started = Date.now();
  const originalLog = console.log;
  const originalRandom = Math.random;
  const tag = out.split('/').pop();
  console.log = (): void => undefined;
  try {
    for (let i = from; i < from + n; i++) {
      const agents = Array.from({ length: 10 }, (_, s) => new Seat(`P${s + 1}`));
      const gameSeed = `${seed}|${i}`;
      for (const a of agents) a.gameSeed = gameSeed;
      failLog = [];
      paLog = [];
      gameAgents = agents;
      Math.random = seededRandom(`${gameSeed}|setup`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let res: any;
      try { res = await engine.runGame(agents, false); } catch (e) { if (e instanceof SkipGame) continue; throw e; } finally { Math.random = originalRandom; }
      const final = agents[0].final;
      if (!final) throw new Error('game did not end');
      const byId = new Map(agents.map((a) => [a.agentId, a]));
      const killer = agents.find((a) => a.killed !== undefined);
      const g = replayGameFromSelfPlay(`SP${i}`, final, (id) => byId.get(id)!.role, killer?.killed);
      const tb = res.threeBlue ? 1 : 0;
      const mk = res.merlinKilled === undefined || res.merlinKilled === null ? -1 : res.merlinKilled ? 1 : 0;
      const quests = g?.quests ?? [];
      const h = g
        ? createHash('sha1').update(JSON.stringify([g.seatRoles, g.proposals.map((p) => [p.leaderSeat, p.teamSeats, p.votes]),
          quests.map((q) => [q.teamSeats, q.failCount]), g.lakes, g.assassinTargetSeat])).digest('hex').slice(0, 12)
        : 'bad';
      // round 44 columns: 1-1 leader (P1) role, first proposal (seats, 0 = P10) and whether it was approved, P5 / P10 red
      const red = (id: string): number => (['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(byId.get(id)!.role) ? 1 : 0);
      const v0 = final.voteHistory[0];
      const L = v0 ? v0.leader : 'P1';
      const seats = final.allPlayerIds;
      const order = (c: string): number => (c === '0' ? 10 : Number(c));
      const t11 = v0 ? v0.team.map((id) => relOf(seats, L, id)).sort((x, y) => order(x) - order(y)).join('') : '';
      const lake0 = final.lakeHistory && final.lakeHistory[0] ? relOf(seats, L, final.lakeHistory[0].holderId) : '';
      rows.push([i, res.winner === 'good' ? 1 : 0, tb, mk, quests.length && quests[0].failed ? 1 : 0, quests.filter((q) => q.failed).length, h,
        byId.get(L)!.role, t11, v0 && v0.approved ? 1 : 0, red(relSeat(seats, L, '5')), red(relSeat(seats, L, '0')), lake0, final.lakeHistory && final.lakeHistory[0] ? red(final.lakeHistory[0].holderId) : -1]);
      if (lake45) {
        const lk = final.lakeHistory && final.lakeHistory[0];
        rows[rows.length - 1].push(lk ? relOf(seats, L, lk.targetId) : '', lk ? red(lk.targetId) : -1, lk ? (lk.declaredClaim === 'good' ? 'o' : lk.declaredClaim === 'evil' ? 'x' : '') : '');
      }
      if (pickAudit) rows[rows.length - 1].push(JSON.stringify(paLog));
      if (detail) {
        const rel = (id: string): string => relOf(seats, L, id);
        const roleSeat = (r: string): string => { const a = agents.find((x) => x.role === r); return a ? rel(a.agentId) : '-'; };
        const c = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin'].map(roleSeat).join('');
        const rounds: { p: string[][]; m: string; f: string }[] = [];
        for (const v of final.voteHistory) {
          let r = rounds[v.round - 1];
          if (!r) { r = { p: [], m: '', f: '' }; rounds[v.round - 1] = r; }
          const forced = v.attempt >= 5;
          const yes = forced ? '' : seats.filter((id) => v.votes[id] === true).map(rel).join('');
          r.p.push([v.team.map(rel).join(''), yes]);
        }
        for (const q of final.questHistory) {
          const r = rounds[q.round - 1];
          if (!r) continue;
          r.m = 'o'.repeat(q.team.length - q.failCount) + 'x'.repeat(q.failCount);
          r.f = failLog.filter(([rd]) => rd === q.round).map(([, id]) => rel(id)).join('');
        }
        const lakes = (final.lakeHistory ?? []).map((l) => [rel(l.holderId), rel(l.targetId), l.declaredClaim === 'good' ? 'o' : l.declaredClaim === 'evil' ? 'x' : '']);
        rows[rows.length - 1].push(JSON.stringify({ c, r: rounds, l: lakes, a: killer?.killed ? rel(killer.killed) : '' }));
      }
      if ((i + 1 - from) % 250 === 0) process.stderr.write(`[sp ${tag}] ${i + 1 - from}/${n} ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  } finally { console.log = originalLog; }
  const meta = { games: rows.length, seed, from, blue: describeAgentTuning(variant), force11, onlyLoyal11, detail, lake45, eloyal, pickAudit, red: redDesc.join(' '), seconds: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync(out + '.tmp', JSON.stringify({ meta, cols: ['i', 'blueWon', 'threeBlue', 'merlinKilled', 'r1Failed', 'failedMissions', 'h', 'leaderRole', 't11', 'ok11', 'red5', 'red0', 'lake0', 'redLake', ...(lake45 ? ['lkT', 'lkTRed', 'lkClaim'] : []), ...(pickAudit ? ['pa'] : []), ...(detail ? ['g'] : [])], rows }));
  fs.renameSync(out + '.tmp', out);
  process.stderr.write(`[sp ${tag}] done ${rows.length} games ${meta.seconds}s\n`);
  process.exit(0);
}
void main();
