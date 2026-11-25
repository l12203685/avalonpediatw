/**
 * 情境題庫（第 74 回合，站長 2026-11-25「策略的優化方式可以從我說的 節點分支的拆解或是情境分析去做」）。
 *
 * 一題 = 一個公開局面（到決策點為止）＋誰在做決定（座位、角色）＋正確答案或不能接受的答案＋出處。
 * 題目寫在 `fixtures.json`（只有座位，沒有玩家名字）；每日一題題庫的題目用題號指到 `sim_bank.json`（`bank` 欄）。
 * 這個檔是純函式：把題目變成那一家當下的觀察、問正式的百科AI（ForwardAgent 包 HeuristicAgent）、對答案。
 *
 * 紀錄的寫法＝站長平常的牌譜寫法（`sheetsReplay.ts` 同一套）：
 *   - 一行一次派票：隊上的座位（0 = 10 家）＋異常票 `X+`（隊外贊成）、`X-`（隊上反對）；其他人投正常票；
 *   - 隊長從 1 家起每一次派票往下一家輪；每一局第 5 次是強制出發；
 *   - 一行 `o`／`x` = 這一局的任務牌；`X>Y o|x` = 湖（X 驗 Y，宣藍／宣紅；不寫＝沒宣告）；
 *   - `roles` = 六個座位字元：刺客／莫甘娜／莫德雷德／奧伯倫／派西維爾／梅林，其他人是忠臣。
 */
import { AVALON_CONFIG, type Role } from '@avalon/shared';
import { __internal as sheetsInternal, leaderSeatForProposal } from '../../services/sheetsGameRecordParser';
import type { AgentTuning } from '../AgentTuning';
import { HeuristicAgent } from '../HeuristicAgent';
import { ForwardAgent } from '../forward/ForwardAgent';
import { bayesOptionsOf, bayesRedShare } from '../belief/BayesBelief';
import { withSeededRandom } from '../benchmark/agreement';
import { buildReplayObservation, seatId, seatOfId, validLakeTargetSeats, type DecisionPoint } from '../benchmark/replayObservation';
import { EVIL_ROLES, ROLE_CODE_ORDER, campOf, type Camp, type ReplayGame, type ReplayLake, type ReplayProposal, type ReplayQuest } from '../benchmark/sheetsReplay';
import type { PlayerObservation } from '../types';

export const SCENARIO_SCHEMA = 1;
const PLAYERS = 10;

// ─── 題目的格式 ───────────────────────────────────────────────────────────

/** 問什麼。座位一律寫字元（'0' = 10 家）。 */
export type ScenarioAsk =
  /** 下一次派票的隊長派隊（座位照輪序；寫了 seat 就檢查是不是他）。 */
  | { kind: 'team'; seat?: string }
  /** `seat` 對下一次派票的這一隊（`team`，牌譜寫法，可帶異常票）投票。 */
  | { kind: 'vote'; seat: string; team: string }
  /** 這一隊（`team`，牌譜寫法；要過半或第 5 次）出任務，`seat` 出什麼牌。 */
  | { kind: 'card'; seat: string; team: string }
  /** 這一隊（`team`，牌譜寫法）出任務，隊上每一個紅方各自出牌（各看各的）；答案 = 一共幾張失敗（第 78 回合）。 */
  | { kind: 'cards'; team: string }
  /** 持湖者（照湖的順序）要驗誰。 */
  | { kind: 'lakeTarget' }
  /** 持湖者驗了 `target`，怎麼宣告。 */
  | { kind: 'lakeClaim'; target: string }
  /** 三藍之後刺客刺誰（紅方開牌）。 */
  | { kind: 'kill' };

/** 對答案；一題可以有很多條，全部成立才算對。座位寫字元。 */
export type ScenarioCheck =
  /** 派的隊是這幾個之一。 */
  | { teamIs: string[] }
  /** 派的隊不能是這幾個。 */
  | { teamNot: string[] }
  /** 隊上要有這些人。 */
  | { teamHas: string }
  /** 隊上不能有這些人。 */
  | { teamLacks: string }
  /** 隊上的紅（照真實角色）最多幾個（0 = 全藍）。 */
  | { teamRedsMax: number }
  | { vote: 'approve' | 'reject' }
  | { card: 'fail' | 'success' }
  /** 整隊的失敗張數在這個範圍裡（`cards` 題；任務牌是蓋著出的，看得到的只有張數）。 */
  | { failCards: { min?: number; max?: number } }
  /** 宣告：truth = 照驗到的說。 */
  | { claim: 'good' | 'evil' | 'none' | 'truth' }
  /** 湖／刺殺的目標是這些人之一。 */
  | { targetIs: string }
  /** 湖／刺殺的目標不能是這些人。 */
  | { targetNot: string }
  /** 刺到梅林。 */
  | { hitsMerlin: true }
  /** 信念：P(紅)(a) ＋ margin < P(紅)(b)。 */
  | { pRedBelow: [string, string]; margin?: number }
  /** 信念：P(紅)(seat) ≤ p。 */
  | { pRedAtMost: { seat: string; p: number } }
  /** 信念：P(紅)(seat) ≥ p。 */
  | { pRedAtLeast: { seat: string; p: number } }
  /** 信念：seat 在其他九家裡 P(紅) 前 n 高。 */
  | { pRedTop: { seat: string; n: number } };

export interface ScenarioFixture {
  id: string;
  /** 類別（報告照這個分組）。 */
  cls: string;
  /** 硬規則：一定要過（A0、A1 與站長寫死的裁定）；runner 只有這種題不過才回非 0。 */
  hard?: boolean;
  /** 一句話的題目。 */
  title: string;
  /** 出處（站長哪一天的話、哪一條百科原則、哪一個題號）。 */
  source: string;
  /** 自己寫的局面：六個座位字元（刺／娜／德／奧／派／梅）。 */
  roles?: string;
  /** 自己寫的局面：到決策點為止的牌譜。 */
  record?: string[];
  /** 每日一題題庫的題號（`sim_bank.json`）；有這個就不寫 roles／record／ask。 */
  bank?: string;
  ask?: ScenarioAsk;
  expect: ScenarioCheck[];
  /** 補充說明（為什麼這是正確答案）。 */
  note?: string;
}

export interface ScenarioFile {
  schema: number;
  scenarios: ScenarioFixture[];
}

// ─── 題目 → 局面 ─────────────────────────────────────────────────────────

export const seatOfChar = (c: string): number => {
  if (!/^[0-9]$/.test(c)) throw new Error(`座位要寫 0–9：${c}`);
  return c === '0' ? 10 : Number(c);
};
export const seatChar = (s: number): string => (s === 10 ? '0' : String(s));
export const seatsOf = (text: string): number[] => [...text].map(seatOfChar);
/** 隊伍的寫法：座位遞增，0 家排最後（站長的寫法）。 */
export const teamText = (seats: readonly number[]): string => [...seats].sort((a, b) => a - b).map(seatChar).join('');
const sameTeam = (a: readonly number[], b: readonly number[]): boolean => teamText(a) === teamText(b);

export function rolesOfCode(code: string): Role[] {
  if (!/^[0-9]{6}$/.test(code)) throw new Error(`roles 要六個座位字元（刺娜德奧派梅）：${code}`);
  const seatRoles: Role[] = new Array<Role>(PLAYERS).fill('loyal');
  const seen = new Set<number>();
  [...code].forEach((c, i) => {
    const seat = seatOfChar(c);
    if (seen.has(seat)) throw new Error(`roles 有重複的座位：${code}`);
    seen.add(seat);
    seatRoles[seat - 1] = ROLE_CODE_ORDER[i];
  });
  return seatRoles;
}

const LAKE_LINE = /^([0-9])>([0-9])(?:\s*([oxOX?]))?$/;
const config = AVALON_CONFIG[PLAYERS];

interface Built {
  game: ReplayGame;
  point: DecisionPoint;
  seat: number;
  /** `cards` 題：隊上的紅方座位（每一個都出牌）；`seat` 是其中第一個（座位圖用）。 */
  cardSeats?: number[];
}

function proposalOf(line: string, index: number, round: number, attempt: number, seatRoles: readonly Role[]): ReplayProposal {
  const parsed = sheetsInternal.parseProposalLine(line);
  const teamSeats = parsed.teamSeats;
  if (teamSeats.length !== config.questTeams[round - 1]) throw new Error(`第 ${round} 局要派 ${config.questTeams[round - 1]} 人：${line}`);
  if (new Set(teamSeats).size !== teamSeats.length) throw new Error(`隊上有重複的座位：${line}`);
  const team = new Set(teamSeats);
  const plusSeats: number[] = [];
  const minusSeats: number[] = [];
  for (const a of parsed.anomalies) {
    if (a.kind === 'plus') {
      if (team.has(a.seat)) throw new Error(`隊上的人不能標 +：${line}`);
      plusSeats.push(a.seat);
    } else {
      if (!team.has(a.seat)) throw new Error(`隊外的人不能標 -：${line}`);
      minusSeats.push(a.seat);
    }
  }
  const votes: boolean[] = [];
  for (let seat = 1; seat <= seatRoles.length; seat++) votes.push(team.has(seat) ? !minusSeats.includes(seat) : plusSeats.includes(seat));
  return {
    round,
    attempt,
    globalIndex: index,
    leaderSeat: leaderSeatForProposal(index, PLAYERS),
    teamSeats,
    plusSeats,
    minusSeats,
    votes,
    approveCount: votes.filter(Boolean).length,
    forced: attempt === 5,
    wentOnMission: false,
    votesReliable: attempt !== 5,
  };
}

/** 自己寫的局面 → 可以重播的（不完整的）一局＋決策點。寫錯（人數、輪序、失敗牌比紅多…）直接丟錯。 */
export function buildScenario(fx: ScenarioFixture): Built {
  if (!fx.roles || !fx.record || !fx.ask) throw new Error(`${fx.id}: 自己寫的局面要有 roles、record、ask`);
  const seatRoles = rolesOfCode(fx.roles);
  const proposals: ReplayProposal[] = [];
  const quests: ReplayQuest[] = [];
  const lakes: ReplayLake[] = [];
  let round = 1;
  let inRound = 0;
  const reds = (seats: readonly number[]): number => seats.filter((s) => EVIL_ROLES.has(seatRoles[s - 1])).length;
  const closeRound = (cards: string): void => {
    const last = proposals[proposals.length - 1];
    if (!last || inRound === 0) throw new Error(`${fx.id}: 任務牌前面沒有派票`);
    if (cards.length !== last.teamSeats.length) throw new Error(`${fx.id}: 任務牌數和隊伍人數不一樣：${cards}`);
    if (!last.forced && last.approveCount * 2 <= PLAYERS) throw new Error(`${fx.id}: 第 ${round} 局出任務的隊沒有過半（${last.approveCount} 票）`);
    const failCount = [...cards.toLowerCase()].filter((c) => c === 'x').length;
    if (failCount > reds(last.teamSeats)) throw new Error(`${fx.id}: 第 ${round} 局失敗牌比隊上的紅多`);
    last.wentOnMission = true;
    quests.push({ round, teamSeats: [...last.teamSeats], successCount: cards.length - failCount, failCount, failed: failCount >= config.questFailsRequired[round - 1] });
    round += 1;
    inRound = 0;
  };
  for (const raw of fx.record) {
    const line = raw.trim();
    if (!line) continue;
    if (sheetsInternal.isQuestLine(line)) { closeRound(line); continue; }
    const lake = LAKE_LINE.exec(line);
    if (lake) {
      if (inRound > 0 || quests.length < 2) throw new Error(`${fx.id}: 湖要寫在第 2、3、4 局任務之後：${line}`);
      const holderSeat = seatOfChar(lake[1]);
      const expected = lakes.length ? lakes[lakes.length - 1].targetSeat : PLAYERS;
      if (holderSeat !== expected) throw new Error(`${fx.id}: 這一次持湖的應該是 ${seatChar(expected)} 家：${line}`);
      const decl = (lake[3] ?? '').toLowerCase();
      lakes.push({ round: quests.length, holderSeat, targetSeat: seatOfChar(lake[2]), claim: decl === 'o' ? 'good' : decl === 'x' ? 'evil' : null });
      continue;
    }
    if (inRound >= 5) throw new Error(`${fx.id}: 一局最多 5 次派票`);
    const p = proposalOf(line, proposals.length, round, inRound + 1, seatRoles);
    proposals.push(p);
    inRound += 1;
  }
  const wins = quests.filter((q) => !q.failed).length;
  const losses = quests.length - wins;
  const game: ReplayGame = {
    id: fx.id,
    playerCount: PLAYERS,
    seatRoles,
    names: new Array<string>(PLAYERS).fill(''),
    proposals,
    quests,
    lakes,
    lakeChainValid: true,
    winner: losses >= 3 ? 'evil' : 'good',
  };
  const ask = fx.ask;
  const nextStub = (line: string | null, went: boolean): ReplayProposal => {
    if (wins >= 3 || losses >= 3) throw new Error(`${fx.id}: 這一局已經打完了`);
    if (inRound >= 5) throw new Error(`${fx.id}: 這一局已經派了 5 次`);
    const index = proposals.length;
    const base: ReplayProposal = line === null
      ? { round, attempt: inRound + 1, globalIndex: index, leaderSeat: leaderSeatForProposal(index, PLAYERS), teamSeats: [], plusSeats: [], minusSeats: [], votes: new Array<boolean>(PLAYERS).fill(false), approveCount: 0, forced: inRound + 1 === 5, wentOnMission: false, votesReliable: false }
      : proposalOf(line, index, round, inRound + 1, seatRoles);
    base.wentOnMission = went;
    proposals.push(base);
    return base;
  };
  switch (ask.kind) {
    case 'team': {
      const p = nextStub(null, false);
      if (ask.seat !== undefined && seatOfChar(ask.seat) !== p.leaderSeat) throw new Error(`${fx.id}: 下一次派票的隊長是 ${seatChar(p.leaderSeat)} 家，不是 ${ask.seat} 家`);
      return { game, point: { kind: 'team_select', proposal: p.globalIndex }, seat: p.leaderSeat };
    }
    case 'vote': {
      const p = nextStub(ask.team, false);
      if (p.forced) throw new Error(`${fx.id}: 第 5 次派票不投票`);
      return { game, point: { kind: 'team_vote', proposal: p.globalIndex }, seat: seatOfChar(ask.seat) };
    }
    case 'card': {
      const p = nextStub(ask.team, true);
      const seat = seatOfChar(ask.seat);
      if (!p.teamSeats.includes(seat)) throw new Error(`${fx.id}: ${ask.seat} 家不在出任務的隊上`);
      if (!p.forced && p.approveCount * 2 <= PLAYERS) throw new Error(`${fx.id}: 出任務的隊沒有過半（${p.approveCount} 票）；補上隊外贊成的人`);
      return { game, point: { kind: 'quest_vote', round }, seat };
    }
    case 'cards': {
      const p = nextStub(ask.team, true);
      const reds = p.teamSeats.filter((s) => campOf(seatRoles[s - 1]) === 'evil');
      if (reds.length === 0) throw new Error(`${fx.id}: 出任務的隊上沒有紅方`);
      if (!p.forced && p.approveCount * 2 <= PLAYERS) throw new Error(`${fx.id}: 出任務的隊沒有過半（${p.approveCount} 票）；補上隊外贊成的人`);
      return { game, point: { kind: 'quest_vote', round }, seat: reds[0], cardSeats: reds };
    }
    case 'lakeTarget':
    case 'lakeClaim': {
      if (inRound > 0 || quests.length < 2 || quests.length > 4 || lakes.some((l) => l.round === quests.length)) throw new Error(`${fx.id}: 現在不是用湖的時候`);
      const holderSeat = lakes.length ? lakes[lakes.length - 1].targetSeat : PLAYERS;
      const targetSeat = ask.kind === 'lakeClaim' ? seatOfChar(ask.target) : 0;
      lakes.push({ round: quests.length, holderSeat, targetSeat, claim: null });
      if (ask.kind === 'lakeClaim' && !validLakeTargetSeats(game, lakes.length - 1).includes(targetSeat)) throw new Error(`${fx.id}: ${ask.target} 家不能被湖（拿過湖）`);
      return { game, point: { kind: 'lake', lake: lakes.length - 1 }, seat: holderSeat };
    }
    case 'kill': {
      if (wins < 3) throw new Error(`${fx.id}: 還沒有三藍`);
      const seat = seatRoles.indexOf('assassin') + 1;
      return { game, point: { kind: 'assassination' }, seat };
    }
  }
}

// ─── 問百科AI ────────────────────────────────────────────────────────────

/** 百科AI 在這一題的答案（一個種子）。 */
export interface ScenarioAnswer {
  /** 派的隊（座位遞增）。 */
  team?: number[];
  vote?: 'approve' | 'reject';
  card?: 'fail' | 'success';
  /** `cards` 題：隊上的紅方一共出了幾張失敗。 */
  failCards?: number;
  /** 湖或刺殺的目標。 */
  target?: number;
  claim?: 'good' | 'evil' | 'none';
  /** 每一家的 P(紅)（index = 座位 − 1；自己是 0）；紅方視角沒有。 */
  pRed?: number[];
  /** 給人看的一句話。 */
  text: string;
}

function agentsFor(game: ReplayGame, seat: number, tuning: AgentTuning): { agent: ForwardAgent; base: HeuristicAgent } {
  const id = seatId(seat);
  const base = new HeuristicAgent(id, undefined, undefined, tuning);
  const agent = new ForwardAgent(id, base);
  // 開局的觀察：第一次派票那一刻（跟模擬瓦、每日一題的 defaultBot 一樣；大廳角色不照座位）。
  const first = game.proposals.length ? hideLobby(buildReplayObservation(game, seat, { kind: 'team_select', proposal: 0 })) : null;
  if (first) agent.onGameStart(first);
  return { agent, base };
}

const hideLobby = (o: PlayerObservation): PlayerObservation => ({ ...o, lobbyRoles: o.lobbyRoles ? [...o.lobbyRoles].sort() : o.lobbyRoles });

/** 這一題那一家當下的觀察（只有他看得到的東西）。 */
export function observationOf(built: Built): PlayerObservation {
  return hideLobby(buildReplayObservation(built.game, built.seat, built.point));
}

export function answerScenario(built: Built, tuning: AgentTuning, seed: string): ScenarioAnswer {
  const { game, point, seat } = built;
  const obs = observationOf(built);
  const { agent, base } = agentsFor(game, seat, tuning);
  const out: ScenarioAnswer = { text: '' };
  const seedOf = (key: string): string => `${game.id}|${seat}|${key}${seed ? `|${seed}` : ''}`;
  switch (point.kind) {
    case 'team_select': {
      const a = withSeededRandom(seedOf(`team-${point.proposal}`), () => agent.act(obs));
      out.team = a.type === 'team_select' ? a.teamIds.map(seatOfId).sort((x, y) => x - y) : [];
      out.text = `派 ${teamText(out.team)}`;
      break;
    }
    case 'team_vote': {
      const a = withSeededRandom(seedOf(`vote-${point.proposal}`), () => agent.act(obs));
      out.vote = a.type === 'team_vote' && a.vote ? 'approve' : 'reject';
      out.text = out.vote === 'approve' ? '贊成' : '反對';
      break;
    }
    case 'quest_vote': {
      if (built.cardSeats) {
        // 隊上每一個紅方各自出牌：各用自己的觀察、自己的機器人、自己的亂數（和真的一起出任務一樣，互相看不到對方出什麼）。
        const played = built.cardSeats.map((s) => {
          const view = hideLobby(buildReplayObservation(game, s, point));
          const who = agentsFor(game, s, tuning).agent;
          const a = withSeededRandom(`${game.id}|${s}|quest-${point.round}${seed ? `|${seed}` : ''}`, () => who.act(view));
          return { seat: s, fail: a.type === 'quest_vote' && a.vote === 'fail' };
        });
        out.failCards = played.filter((x) => x.fail).length;
        out.text = `${out.failCards} 張失敗（${played.map((x) => `${seatChar(x.seat)} 家${x.fail ? '失敗' : '成功'}`).join('、')}）`;
        break;
      }
      const a = withSeededRandom(seedOf(`quest-${point.round}`), () => agent.act(obs));
      out.card = a.type === 'quest_vote' && a.vote === 'fail' ? 'fail' : 'success';
      out.text = out.card === 'fail' ? '出失敗' : '出成功';
      break;
    }
    case 'lake': {
      const lake = game.lakes[point.lake];
      if (lake.targetSeat === 0) {
        const valid = validLakeTargetSeats({ ...game, lakes: game.lakes.map((l, i) => (i === point.lake ? { ...l, targetSeat: l.holderSeat } : l)) }, point.lake).map(seatId);
        const t = withSeededRandom(seedOf(`lake-${point.lake}`), () => base.pickLakeTarget(obs, valid));
        out.target = seatOfId(t);
        out.text = `湖 ${seatChar(out.target)} 家`;
      } else {
        const truth: Camp = campOf(game.seatRoles[lake.targetSeat - 1]);
        const c = withSeededRandom(seedOf(`claim-${point.lake}`), () => base.declareLake(obs, seatId(lake.targetSeat), truth));
        out.claim = c ?? 'none';
        out.text = c === 'good' ? '宣藍' : c === 'evil' ? '宣紅' : '不宣告';
      }
      break;
    }
    case 'assassination': {
      const a = withSeededRandom(seedOf('assassinate'), () => agent.act(obs));
      out.target = a.type === 'assassinate' ? seatOfId(a.targetId) : 0;
      out.text = `刺 ${seatChar(out.target)} 家`;
      break;
    }
  }
  // 信念在決定之後才算（跟每日一題的百科AI 答案同一個順序）：1-1 隊長自己的先驗是用決定那一刻的亂數抽的，先算信念會改到決定。
  if (obs.myTeam === 'good') {
    const share = withSeededRandom(seedOf('belief'), () => bayesRedShare(obs, bayesOptionsOf(tuning)));
    out.pRed = obs.allPlayerIds.map((id) => share.get(id) ?? 0);
  }
  return out;
}

// ─── 對答案 ──────────────────────────────────────────────────────────────

/** 一條檢查的結果；`why` 是不過的原因（過了是空字串）。 */
export function checkAnswer(built: Built, ans: ScenarioAnswer, check: ScenarioCheck): string {
  const { game, point } = built;
  const roles = game.seatRoles;
  const isRed = (s: number): boolean => EVIL_ROLES.has(roles[s - 1]);
  const p = (c: string): number => {
    if (!ans.pRed) throw new Error('紅方視角沒有 P(紅)');
    return ans.pRed[seatOfChar(c) - 1];
  };
  const team = ans.team ?? [];
  if ('teamIs' in check) return check.teamIs.some((t) => sameTeam(seatsOf(t), team)) ? '' : `派了 ${teamText(team)}，要派 ${check.teamIs.join(' 或 ')}`;
  if ('teamNot' in check) return check.teamNot.some((t) => sameTeam(seatsOf(t), team)) ? `派了不該派的 ${teamText(team)}` : '';
  if ('teamHas' in check) {
    const miss = seatsOf(check.teamHas).filter((s) => !team.includes(s));
    return miss.length ? `派了 ${teamText(team)}，少了 ${teamText(miss)}` : '';
  }
  if ('teamLacks' in check) {
    const bad = seatsOf(check.teamLacks).filter((s) => team.includes(s));
    return bad.length ? `派了 ${teamText(team)}，不該帶 ${teamText(bad)}` : '';
  }
  if ('teamRedsMax' in check) {
    const reds = team.filter(isRed);
    return reds.length > check.teamRedsMax ? `派了 ${teamText(team)}，隊上的紅：${teamText(reds)}` : '';
  }
  if ('vote' in check) return ans.vote === check.vote ? '' : `投了${ans.vote === 'approve' ? '贊成' : '反對'}`;
  if ('card' in check) return ans.card === check.card ? '' : `出了${ans.card === 'fail' ? '失敗' : '成功'}`;
  if ('failCards' in check) {
    const n = ans.failCards ?? -1;
    const { min = 0, max = Number.POSITIVE_INFINITY } = check.failCards;
    return n >= min && n <= max ? '' : `${ans.text}（要 ${min === max ? `剛好 ${min}` : Number.isFinite(max) ? `${min}–${max}` : `至少 ${min}`} 張）`;
  }
  if ('claim' in check) {
    let want: string = check.claim;
    if (check.claim === 'truth') {
      if (point.kind !== 'lake') throw new Error('claim 只能用在湖的宣告');
      want = campOf(roles[game.lakes[point.lake].targetSeat - 1]);
    }
    return ans.claim === want ? '' : `${ans.text}（要${want === 'good' ? '宣藍' : want === 'evil' ? '宣紅' : '不宣告'}）`;
  }
  if ('targetIs' in check) return ans.target !== undefined && seatsOf(check.targetIs).includes(ans.target) ? '' : `${ans.text}（要選 ${check.targetIs}）`;
  if ('targetNot' in check) return ans.target !== undefined && seatsOf(check.targetNot).includes(ans.target) ? `${ans.text}（不該選 ${check.targetNot}）` : '';
  if ('hitsMerlin' in check) return ans.target !== undefined && roles[ans.target - 1] === 'merlin' ? '' : `${ans.text}，梅林是 ${seatChar(roles.indexOf('merlin') + 1)} 家`;
  if ('pRedBelow' in check) {
    const [a, b] = check.pRedBelow;
    return p(a) + (check.margin ?? 0) < p(b) ? '' : `P(紅) ${a} 家 ${p(a).toFixed(2)}、${b} 家 ${p(b).toFixed(2)}（要 ${a} 家比較低）`;
  }
  if ('pRedAtMost' in check) return p(check.pRedAtMost.seat) <= check.pRedAtMost.p + 1e-9 ? '' : `P(紅) ${check.pRedAtMost.seat} 家 ${p(check.pRedAtMost.seat).toFixed(2)}（要 ≤ ${check.pRedAtMost.p}）`;
  if ('pRedAtLeast' in check) return p(check.pRedAtLeast.seat) >= check.pRedAtLeast.p - 1e-9 ? '' : `P(紅) ${check.pRedAtLeast.seat} 家 ${p(check.pRedAtLeast.seat).toFixed(2)}（要 ≥ ${check.pRedAtLeast.p}）`;
  if ('pRedTop' in check) {
    const me = built.seat;
    const mine = p(check.pRedTop.seat);
    const higher = (ans.pRed ?? []).filter((x, i) => i + 1 !== me && x > mine + 1e-12).length;
    return higher < check.pRedTop.n ? '' : `P(紅) ${check.pRedTop.seat} 家 ${mine.toFixed(2)}，排第 ${higher + 1}（要前 ${check.pRedTop.n}）`;
  }
  throw new Error(`不認得的檢查：${JSON.stringify(check)}`);
}

export interface ScenarioResult {
  id: string;
  cls: string;
  hard: boolean;
  /** 種子裡過的比例（0–1）。 */
  pass: number;
  /** 第一個種子的答案。 */
  answer: ScenarioAnswer;
  /** 不過的原因（去重複）。 */
  why: string[];
}

/** 一題在一套參數下跑 `seeds` 個種子。 */
export function runScenario(fx: ScenarioFixture, built: Built, tuning: AgentTuning, seeds: readonly string[] = ['']): ScenarioResult {
  let ok = 0;
  let first: ScenarioAnswer | null = null;
  const why = new Set<string>();
  for (const seed of seeds) {
    const ans = answerScenario(built, tuning, seed);
    if (!first) first = ans;
    const fails = fx.expect.map((c) => checkAnswer(built, ans, c)).filter(Boolean);
    if (fails.length === 0) ok += 1;
    for (const f of fails) why.add(f);
  }
  return { id: fx.id, cls: fx.cls, hard: fx.hard === true, pass: ok / seeds.length, answer: first as ScenarioAnswer, why: [...why] };
}

/** 檢查題目檔的格式（題號不重複、每一題都建得起來、檢查寫得對）。 */
export function validateFile(file: ScenarioFile): void {
  if (file.schema !== SCENARIO_SCHEMA) throw new Error(`schema 要是 ${SCENARIO_SCHEMA}`);
  const ids = new Set<string>();
  for (const fx of file.scenarios) {
    if (ids.has(fx.id)) throw new Error(`題號重複：${fx.id}`);
    ids.add(fx.id);
    if (!fx.title || !fx.source || !fx.cls) throw new Error(`${fx.id}: 要有 cls、title、source`);
    if (!Array.isArray(fx.expect) || fx.expect.length === 0) throw new Error(`${fx.id}: 沒有答案（expect）`);
    if (!fx.bank) buildScenario(fx);
  }
}

// ─── 座位圖（報告用） ─────────────────────────────────────────────────────

const ROLE_ZH: Readonly<Record<Role, string>> = {
  merlin: '梅林', percival: '派西', loyal: '忠臣', assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德', oberon: '奧伯倫',
} as Record<Role, string>;

/**
 * 一題的座位圖（Markdown 表格）：每一家的角色（事後）、他看得到什麼、出過哪些任務、百科AI 的 P(紅)，再列牌譜。
 * 只有座位，沒有名字。
 */
export function seatDiagram(built: Built, ans: ScenarioAnswer | null): string {
  const { game, seat, point } = built;
  const obs = observationOf(built);
  const thumbs = new Set((obs.knownWizards ?? []).map(seatOfId));
  const seen = new Set(obs.knownEvils.map(seatOfId));
  const shownQuests = point.kind === 'assassination' ? game.quests : game.quests.filter((q) => q.round < obs.currentRound || (point.kind === 'lake' && q.round <= obs.currentRound));
  const head = ['座位', ...Array.from({ length: PLAYERS }, (_, i) => `${seatChar(i + 1)}家`)];
  const row = (name: string, cell: (s: number) => string): string => `| ${name} | ${Array.from({ length: PLAYERS }, (_, i) => cell(i + 1)).join(' | ')} |`;
  const lines = [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    row('角色（事後）', (s) => ROLE_ZH[game.seatRoles[s - 1]]),
    row('這一家看到', (s) => (s === seat ? '**自己**' : thumbs.has(s) ? '拇指' : seen.has(s) ? '紅' : '')),
    ...shownQuests.map((q) => row(`第 ${q.round} 局（${q.failCount} 張失敗）`, (s) => (q.teamSeats.includes(s) ? '出' : ''))),
  ];
  if (ans?.pRed) lines.push(row('百科AI 的 P(紅)', (s) => (s === seat ? '—' : ans.pRed![s - 1].toFixed(2))));
  if (ans?.team) lines.push(row('百科AI 派', (s) => (ans.team!.includes(s) ? '●' : '')));
  return lines.join('\n');
}

/** 牌譜（到決策點為止），站長的寫法，一局一行。 */
export function recordText(built: Built): string {
  const { game, point } = built;
  const until = point.kind === 'team_select' || point.kind === 'team_vote' ? point.proposal : game.proposals.length;
  const out: string[] = [];
  for (let r = 1; r <= 5; r++) {
    const ps = game.proposals.filter((p) => p.round === r && p.globalIndex < until && p.teamSeats.length > 0);
    if (!ps.length) break;
    const q = game.quests.find((x) => x.round === r && ps.some((p) => p.wentOnMission));
    // 只列決策點之前已經用掉的湖（題庫的局有整局的紀錄，後面的不能露出來）。
    const curRound = point.kind === 'team_select' || point.kind === 'team_vote' ? game.proposals[point.proposal].round : point.kind === 'quest_vote' ? point.round : Number.POSITIVE_INFINITY;
    const lake = game.lakes.find((l) => l.round === r && l.targetSeat !== 0 && l.round < curRound && (point.kind !== 'lake' || game.lakes.indexOf(l) < point.lake));
    const txt = ps.map((p) => `${teamText(p.teamSeats)}${p.minusSeats.length ? ` ${teamText(p.minusSeats)}-` : ''}${p.plusSeats.length ? ` ${teamText(p.plusSeats)}+` : ''}`).join(' / ');
    out.push(`第 ${r} 局：${txt}${q ? ` → ${'o'.repeat(q.successCount)}${'x'.repeat(q.failCount)}` : ''}${lake ? `；湖 ${seatChar(lake.holderSeat)}>${seatChar(lake.targetSeat)} ${lake.claim === 'good' ? 'o' : lake.claim === 'evil' ? 'x' : '（沒宣告）'}` : ''}`);
  }
  return out.join('\n');
}
