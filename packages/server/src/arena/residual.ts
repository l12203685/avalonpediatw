/**
 * AI騎士 的「每人殘差層」（v2，站長 2026-11-26：「80% 其實還是不是很像…至少要做到 90% 甚至 95% / 而且要切每個動作來看」）。
 *
 * 一隻官方 AI騎士 = 百科AI 的引擎（加上白名單開關，v1）＋ 這一層：每一種決策，引擎先照平常決定，
 * 這一層再用那位玩家自己的牌局學到的權重，對同一組合法選項重新打分（線性分數 → softmax／logistic）：
 *
 *   派隊      所有合法的隊（n 選 k，10 人局最多 252 組）；分數 = 隊員座位特徵的加總 ＋ 幾個整隊特徵。
 *             會給出前三名的隊與機率（`rankTeams`）。
 *   投票      贊成的機率（logistic；角色群組 × 在不在隊上各一組權重）。
 *   任務牌    紅方出失敗的機率（logistic）。
 *   湖中對象  合法對象裡挑一個（softmax，座位特徵）。
 *   湖中宣告  紅方持湖者宣告「紅」的機率（logistic）。藍方持湖者一律說實話（A0，不學）。
 *   刺殺      不是已知紅的座位裡挑一個（softmax）。刺殺常是紅方一起討論的結果，擬合時是弱訊號。
 *
 * 硬規則不交給權重：藍方任務一定成功；紅方已拿兩局時任務牌照引擎（A1：兩敗後不拖）；藍方湖中宣告照實（A0）；
 * 刺客不刺已知的紅；隊伍人數、湖中對象一定合法。
 *
 * 特徵全部只用那個座位當時看得到的東西（同一份 `PlayerObservation`）＋ 引擎自己的決定與信念（`bayesRedShare`、`bayesTeamClean`）。
 * 擬合（`scripts/knightFidelity.ts`）和上場（`table.ts` 的擂台座位）用同一組函式算特徵，所以學到的權重上場時意思一樣。
 * 權重存成 profile 的 `residual`（`{特徵名: 權重}`，沒寫的特徵 = 0），只有官方 AI騎士 可以帶（`profile.ts`）。
 */
import { AVALON_CONFIG } from '@avalon/shared';
import type { AgentTuning } from '../ai/AgentTuning';
import type { PlayerObservation } from '../ai/types';
import { bayesOptionsOf, bayesRedShare, bayesTeamClean } from '../ai/belief/BayesBelief';

export const RESIDUAL_VERSION = 1;

/** 每個座位的特徵（派隊加總、湖中對象、刺殺共用）。 */
export const SEAT_FEATURES = [
  'self', 'eng', 'pRed', 'knownRed', 'thumb', 'failOn', 'succOn', 'lastProp', 'lastMission',
  'lakeGood', 'lakeBad', 'myLakeGood', 'myLakeBad', 'adjacent', 'dist', 'approvedFailed', 'ledFailed',
  'propRound', 'approvedLast', 'ledRound',
  // 完整紀錄讀出來的證據（站長 11/26：「每個 spot 都不同」——同一個局面要照他自己讀紀錄的方式讀）。
  'failExp', 'failOnLast', 'fail2', 'succAll', 'rejSucc', 'appMine', 'rejMine', 'inclMe', 'exclSelf',
  'lakeHolder', 'lakeAccuser', 'votedLikeMe', 'appRate', 'appDirty',
  // 和局面的交互作用：第 1 局、第 3 局起、強制局（第 5 次提議）。
  'self_R1', 'self_R3', 'self_forced', 'lastProp_R1', 'lastProp_forced', 'propRound_R1', 'eng_R1', 'pRed_R3',
  'dist_R1', 'adjacent_R1', 'approvedLast_R1', 'failExp_R3',
] as const;
/** 整隊多加的特徵。 */
export const TEAM_EXTRA_FEATURES = ['exactEng', 'exactPrevProp', 'exactLastMission'] as const;
export const TEAM_FEATURES = [...SEAT_FEATURES, ...TEAM_EXTRA_FEATURES] as const;
export const VOTE_FEATURES = [
  'bias', 'eng', 'leader', 'attempt', 'preForced', 'round3', 'redFails', 'blueWins', 'cleanLogit',
  'teamKnownRed', 'teamThumb', 'teamFailOn', 'teamSuccOn', 'teamLastMission', 'exactLastMission', 'exactPrevProp',
  'teamLakeBad', 'teamLakeGood', 'teamPRedMax', 'leaderPRed', 'leaderKnownRed', 'matchPoint',
  'teamFailExp', 'teamFailOnLast', 'teamRejSucc', 'teamLikeMe', 'teamAppDirty', 'teamLakeHolder', 'leaderLikeMe', 'leaderInclMe',
  'leaderLedFailed', 'leaderExclSelf', 'iApprovedLast', 'sameAsMyLast', 'outsideFailExp', 'cleanLogit_R3', 'eng_preForced',
] as const;
export const QUEST_FEATURES = [
  'bias', 'eng', 'round', 'teamKnownRed', 'solo', 'teamSize', 'failsNeeded', 'redFails', 'blueWins',
  'assassin', 'morgana', 'mordred', 'oberon',
] as const;
export const CLAIM_FEATURES = [
  'bias', 'eng', 'truthEvil', 'targetAlly', 'round', 'targetPRed', 'targetFailOn', 'blueWins', 'redFails',
] as const;

export type TeamGroup = 'red' | 'merlin' | 'percival' | 'loyal';
export type VoteGroup = `${TeamGroup}_${'on' | 'off'}`;
export const TEAM_GROUPS: readonly TeamGroup[] = ['red', 'merlin', 'percival', 'loyal'];
export const VOTE_GROUPS: readonly VoteGroup[] = TEAM_GROUPS.flatMap((g) => [`${g}_on`, `${g}_off`] as VoteGroup[]);

/** 權重：特徵名 → 權重（沒寫 = 0）。 */
export type Weights = Record<string, number>;

export interface ResidualWeights {
  version: number;
  team?: Partial<Record<TeamGroup, Weights>>;
  vote?: Partial<Record<VoteGroup, Weights>>;
  quest?: Weights;
  lakeTarget?: Partial<Record<'good' | 'evil', Weights>>;
  lakeClaim?: Weights;
  assassinate?: Weights;
}

export function teamGroupOf(role: string, team: 'good' | 'evil'): TeamGroup {
  if (team === 'evil') return 'red';
  if (role === 'merlin') return 'merlin';
  if (role === 'percival') return 'percival';
  return 'loyal';
}

export function voteGroupOf(role: string, team: 'good' | 'evil', onTeam: boolean): VoteGroup {
  return `${teamGroupOf(role, team)}_${onTeam ? 'on' : 'off'}`;
}

// ── 小工具 ─────────────────────────────────────────────────

export function dot(w: Weights | undefined, names: readonly string[], x: readonly number[]): number {
  if (!w) return 0;
  let s = 0;
  for (let i = 0; i < names.length; i++) {
    const v = w[names[i]];
    if (v !== undefined && x[i] !== 0) s += v * x[i];
  }
  return s;
}

export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** n 選 k 的所有組合（索引，遞增）。 */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); rec(i + 1); cur.pop(); }
  };
  rec(0);
  return out;
}

const comboCache = new Map<string, number[][]>();
function combosOf(n: number, k: number): number[][] {
  const key = `${n}|${k}`;
  let c = comboCache.get(key);
  if (!c) { c = combinations(n, k); comboCache.set(key, c); }
  return c;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function teamSize(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount]?.questTeams[obs.currentRound - 1] ?? 3;
}

function failsNeeded(obs: PlayerObservation): number {
  return AVALON_CONFIG[obs.playerCount]?.questFailsRequired[obs.currentRound - 1] ?? 1;
}

const fails = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'fail').length;
const wins = (obs: PlayerObservation): number => (obs.questResults ?? []).filter((r) => r === 'success').length;

function clampLogit(p: number | null): number {
  if (p === null || !Number.isFinite(p)) return 0;
  const q = Math.min(0.99, Math.max(0.01, p));
  return Math.log(q / (1 - q));
}

/** 這個座位眼中每個座位的 P(紅)（引擎的貝氏信念；沒有世界時 0.5）。 */
function redShares(obs: PlayerObservation, tuning: Readonly<Partial<AgentTuning>>): Map<string, number> {
  try {
    return bayesRedShare(obs, bayesOptionsOf(tuning));
  } catch {
    return new Map(obs.allPlayerIds.map((id) => [id, id === obs.myPlayerId ? (obs.myTeam === 'evil' ? 1 : 0) : 0.5]));
  }
}

// ── 特徵 ───────────────────────────────────────────────────

/** 公開紀錄的整理（每個決策點算一次）。 */
export interface History {
  failOn: Map<string, number>;
  succOn: Map<string, number>;
  lastProp: readonly string[];
  lastMission: readonly string[];
  lakeGood: Set<string>;
  lakeBad: Set<string>;
  myLakeGood: Set<string>;
  myLakeBad: Set<string>;
  approvedFailed: Map<string, number>;
  ledFailed: Map<string, number>;
  /** 這一局（同一個任務回合）已經有幾次提議帶了這個座位。 */
  propRound: Map<string, number>;
  /** 上一次提議投贊成的座位。 */
  approvedLast: Set<string>;
  /** 這一局已經當過隊長的座位。 */
  ledRound: Set<string>;
  /** Σ（失敗張數 ÷ 隊伍人數），這個座位上過的失敗任務。 */
  failExp: Map<string, number>;
  failOnLast: Set<string>;
  fail2: Set<string>;
  succAll: Set<string>;
  /** 投反對、結果那隊出去成功了的次數。 */
  rejSucc: Map<string, number>;
  /** 我最近一次提議：誰贊成、誰反對。 */
  appMine: Set<string>;
  rejMine: Set<string>;
  /** 這個座位的提議帶我的次數；有沒有派過不含自己的隊。 */
  inclMe: Map<string, number>;
  exclSelf: Set<string>;
  lakeHolder: Set<string>;
  /** 持湖宣告別人是紅的人。 */
  lakeAccuser: Set<string>;
  /** 和我投一樣票的比例（我投過的票裡）。 */
  likeMe: Map<string, number>;
  /** 贊成率。 */
  appRate: Map<string, number>;
  /** 贊成過「帶了失敗任務隊員」的隊的次數。 */
  appDirty: Map<string, number>;
  /** 我上一次投票的隊與票。 */
  myLast?: { team: readonly string[]; approve: boolean };
}

export function history(obs: PlayerObservation): History {
  const failOn = new Map<string, number>();
  const succOn = new Map<string, number>();
  for (const q of obs.questHistory) {
    const m = q.result === 'fail' ? failOn : succOn;
    for (const id of q.team) m.set(id, (m.get(id) ?? 0) + 1);
  }
  const votes = obs.voteHistory ?? [];
  const lastProp = votes.length ? votes[votes.length - 1].team : [];
  const lastQuest = obs.questHistory.length ? obs.questHistory[obs.questHistory.length - 1] : undefined;
  const lakeGood = new Set<string>();
  const lakeBad = new Set<string>();
  for (const l of obs.lakeHistory ?? []) {
    if (l.declaredClaim === 'good') lakeGood.add(l.targetId);
    if (l.declaredClaim === 'evil') lakeBad.add(l.targetId);
  }
  const myLakeGood = new Set<string>();
  const myLakeBad = new Set<string>();
  for (const l of obs.myLakeResults ?? []) (l.result === 'good' ? myLakeGood : myLakeBad).add(l.targetId);
  // 投過贊成、後來失敗的隊；派過、後來失敗的隊（任務隊 = 那一局最後一次通過的提議）。
  const approvedFailed = new Map<string, number>();
  const ledFailed = new Map<string, number>();
  for (const q of obs.questHistory) {
    if (q.result !== 'fail') continue;
    const passed = [...votes].reverse().find((v) => v.round === q.round && sameSet(v.team, q.team));
    if (!passed) continue;
    ledFailed.set(passed.leader, (ledFailed.get(passed.leader) ?? 0) + 1);
    for (const [id, yes] of Object.entries(passed.votes ?? {})) if (yes) approvedFailed.set(id, (approvedFailed.get(id) ?? 0) + 1);
  }
  const propRound = new Map<string, number>();
  const ledRound = new Set<string>();
  for (const v of votes) {
    if (v.round !== obs.currentRound) continue;
    ledRound.add(v.leader);
    for (const id of v.team) propRound.set(id, (propRound.get(id) ?? 0) + 1);
  }
  const last = votes.length ? votes[votes.length - 1] : undefined;
  const approvedLast = new Set(Object.entries(last?.votes ?? {}).filter(([, yes]) => yes).map(([id]) => id));
  const failExp = new Map<string, number>();
  const fail2 = new Set<string>();
  const failQuests = obs.questHistory.filter((q) => q.result === 'fail');
  for (const q of failQuests) {
    for (const id of q.team) failExp.set(id, (failExp.get(id) ?? 0) + (q.failCount || 1) / Math.max(1, q.team.length));
    if (q.failCount >= 2) for (const id of q.team) fail2.add(id);
  }
  const failOnLast = new Set(failQuests.length ? failQuests[failQuests.length - 1].team : []);
  const succQuests = obs.questHistory.filter((q) => q.result === 'success');
  const succAll = new Set(succQuests.length ? obs.allPlayerIds.filter((id) => succQuests.every((q) => q.team.includes(id))) : []);
  // 每一次提議：有沒有出任務、結果（出任務 = 那一局通過、和任務隊一樣的那一次）。
  const outcomeOf = (v: (typeof votes)[number]): 'fail' | 'success' | null => {
    if (!v.approved) return null;
    const q = obs.questHistory.find((x) => x.round === v.round && sameSet(x.team, v.team));
    return q ? q.result : null;
  };
  const rejSucc = new Map<string, number>();
  const inclMe = new Map<string, number>();
  const exclSelf = new Set<string>();
  const likeMe = new Map<string, number>();
  const likeN = new Map<string, number>();
  const appRate = new Map<string, number>();
  const voteN = new Map<string, number>();
  const appDirty = new Map<string, number>();
  const me = obs.myPlayerId;
  let myLast: History['myLast'];
  let mineLast: (typeof votes)[number] | undefined;
  for (const v of votes) {
    const out = outcomeOf(v);
    const failedBefore = new Set(obs.questHistory.filter((q) => q.result === 'fail' && q.round < v.round).flatMap((q) => q.team));
    const dirty = v.team.some((id) => id !== v.leader && failedBefore.has(id));
    const myVote = v.votes?.[me];
    for (const [id, yes] of Object.entries(v.votes ?? {})) {
      voteN.set(id, (voteN.get(id) ?? 0) + 1);
      if (yes) appRate.set(id, (appRate.get(id) ?? 0) + 1);
      if (!yes && out === 'success') rejSucc.set(id, (rejSucc.get(id) ?? 0) + 1);
      if (yes && dirty) appDirty.set(id, (appDirty.get(id) ?? 0) + 1);
      if (myVote !== undefined && id !== me) {
        likeN.set(id, (likeN.get(id) ?? 0) + 1);
        if (yes === myVote) likeMe.set(id, (likeMe.get(id) ?? 0) + 1);
      }
    }
    if (v.leader !== me && v.team.includes(me)) inclMe.set(v.leader, (inclMe.get(v.leader) ?? 0) + 1);
    if (!v.team.includes(v.leader)) exclSelf.add(v.leader);
    if (v.leader === me) mineLast = v;
    if (myVote !== undefined) myLast = { team: v.team, approve: myVote };
  }
  for (const [id, n] of voteN) appRate.set(id, (appRate.get(id) ?? 0) / n);
  for (const [id, n] of likeN) likeMe.set(id, (likeMe.get(id) ?? 0) / n);
  const appMine = new Set<string>();
  const rejMine = new Set<string>();
  for (const [id, yes] of Object.entries(mineLast?.votes ?? {})) if (id !== me) (yes ? appMine : rejMine).add(id);
  const lakeHolder = new Set<string>();
  const lakeAccuser = new Set<string>();
  for (const l of obs.lakeHistory ?? []) {
    lakeHolder.add(l.holderId);
    if (l.declaredClaim === 'evil') lakeAccuser.add(l.holderId);
  }
  return {
    failOn, succOn, lastProp, lastMission: lastQuest?.team ?? [], lakeGood, lakeBad, myLakeGood, myLakeBad, approvedFailed, ledFailed,
    propRound, approvedLast, ledRound,
    failExp, failOnLast, fail2, succAll, rejSucc, appMine, rejMine, inclMe, exclSelf, lakeHolder, lakeAccuser, likeMe, appRate, appDirty, myLast,
  };
}

/**
 * 每個座位的特徵（`SEAT_FEATURES` 的順序），座位照 `obs.allPlayerIds`。`eng` = 引擎這一次選了這個座位（派隊：在引擎的隊上；湖、刺殺：引擎的對象）。
 */
export function seatFeatures(obs: PlayerObservation, engine: readonly string[], tuning: Readonly<Partial<AgentTuning>>, h: History = history(obs)): number[][] {
  const ids = obs.allPlayerIds;
  const n = ids.length;
  const me = ids.indexOf(obs.myPlayerId);
  const pRed = redShares(obs, tuning);
  const eng = new Set(engine);
  return ids.map((id, i) => {
    const d = (i - me + n) % n;
    const base = [
      id === obs.myPlayerId ? 1 : 0,
      eng.has(id) ? 1 : 0,
      pRed.get(id) ?? 0.5,
      obs.knownEvils.includes(id) ? 1 : 0,
      (obs.knownWizards ?? []).includes(id) ? 1 : 0,
      Math.min(2, h.failOn.get(id) ?? 0),
      Math.min(3, h.succOn.get(id) ?? 0),
      h.lastProp.includes(id) ? 1 : 0,
      h.lastMission.includes(id) ? 1 : 0,
      h.lakeGood.has(id) ? 1 : 0,
      h.lakeBad.has(id) ? 1 : 0,
      h.myLakeGood.has(id) ? 1 : 0,
      h.myLakeBad.has(id) ? 1 : 0,
      d === 1 || d === n - 1 ? 1 : 0,
      d / Math.max(1, n - 1),
      Math.min(2, h.approvedFailed.get(id) ?? 0),
      Math.min(2, h.ledFailed.get(id) ?? 0),
      Math.min(4, h.propRound.get(id) ?? 0) / 4,
      h.approvedLast.has(id) ? 1 : 0,
      h.ledRound.has(id) ? 1 : 0,
    ];
    const self = base[0];
    const r1 = obs.currentRound === 1 ? 1 : 0;
    const r3 = obs.currentRound >= 3 ? 1 : 0;
    const forced = (obs.failCount ?? 0) >= 4 ? 1 : 0;
    const fe = Math.min(2, h.failExp.get(id) ?? 0);
    return [
      ...base,
      fe,
      h.failOnLast.has(id) ? 1 : 0,
      h.fail2.has(id) ? 1 : 0,
      h.succAll.has(id) ? 1 : 0,
      Math.min(2, h.rejSucc.get(id) ?? 0) / 2,
      h.appMine.has(id) ? 1 : 0,
      h.rejMine.has(id) ? 1 : 0,
      Math.min(2, h.inclMe.get(id) ?? 0) / 2,
      h.exclSelf.has(id) ? 1 : 0,
      h.lakeHolder.has(id) ? 1 : 0,
      h.lakeAccuser.has(id) ? 1 : 0,
      id === obs.myPlayerId ? 1 : h.likeMe.get(id) ?? 0.5,
      h.appRate.get(id) ?? 0.5,
      Math.min(2, h.appDirty.get(id) ?? 0) / 2,
      self * r1, self * r3, self * forced,
      base[7] * r1, base[7] * forced, base[17] * r1, base[1] * r1, base[2] * r3,
      base[14] * r1, base[13] * r1, base[18] * r1, fe * r3,
    ];
  });
}

export interface TeamCandidates {
  /** 每一組候選隊（座位 id，照 `allPlayerIds` 順序）。 */
  teams: string[][];
  /** 每一組的特徵（`TEAM_FEATURES` 的順序）。 */
  X: number[][];
}

/** 從座位特徵組出所有合法隊伍的特徵（擬合時從存下來的座位特徵重建，用同一個函式）。 */
export function teamCandidatesFrom(ids: readonly string[], S: readonly (readonly number[])[], k: number, engine: readonly string[], prevProp: readonly string[], lastMission: readonly string[]): TeamCandidates {
  const F = SEAT_FEATURES.length;
  const combos = combosOf(ids.length, k);
  const teams: string[][] = [];
  const X: number[][] = [];
  const engSet = new Set(engine.map((id) => ids.indexOf(id)));
  const prevSet = new Set(prevProp.map((id) => ids.indexOf(id)));
  const lastSet = new Set(lastMission.map((id) => ids.indexOf(id)));
  for (const c of combos) {
    const x = new Array<number>(F + TEAM_EXTRA_FEATURES.length).fill(0);
    for (const i of c) { const s = S[i]; for (let f = 0; f < F; f++) x[f] += s[f]; }
    x[F] = engSet.size === k && c.every((i) => engSet.has(i)) ? 1 : 0;
    x[F + 1] = prevSet.size === k && c.every((i) => prevSet.has(i)) ? 1 : 0;
    x[F + 2] = lastSet.size === k && c.every((i) => lastSet.has(i)) ? 1 : 0;
    teams.push(c.map((i) => ids[i]));
    X.push(x);
  }
  return { teams, X };
}

export interface TeamSpotFeatures {
  ids: string[];
  S: number[][];
  k: number;
  prevProp: string[];
  lastMission: string[];
}

export function teamSpotFeatures(obs: PlayerObservation, engineTeam: readonly string[], tuning: Readonly<Partial<AgentTuning>>): TeamSpotFeatures {
  const h = history(obs);
  return { ids: [...obs.allPlayerIds], S: seatFeatures(obs, engineTeam, tuning, h), k: teamSize(obs), prevProp: [...h.lastProp], lastMission: [...h.lastMission] };
}

export function voteFeatures(obs: PlayerObservation, engineVote: boolean, tuning: Readonly<Partial<AgentTuning>>): number[] {
  const h = history(obs);
  const team = obs.proposedTeam;
  const me = obs.myPlayerId;
  const pRed = redShares(obs, tuning);
  let clean: number | null = null;
  try { clean = bayesTeamClean(obs, team.filter((id) => id !== me), bayesOptionsOf(tuning)); } catch { clean = null; }
  const others = team.filter((id) => id !== me);
  const sum = (f: (id: string) => number): number => others.reduce((s, id) => s + f(id), 0);
  const k = Math.max(1, team.length);
  const leader = obs.currentLeader;
  const attempt = (obs.failCount ?? 0) + 1;
  return [
    1,
    engineVote ? 1 : -1,
    leader === me ? 1 : 0,
    (attempt - 1) / 4,
    attempt === 4 ? 1 : 0,
    obs.currentRound >= 3 ? 1 : 0,
    fails(obs),
    wins(obs),
    clampLogit(clean),
    sum((id) => (obs.knownEvils.includes(id) ? 1 : 0)),
    sum((id) => ((obs.knownWizards ?? []).includes(id) ? 1 : 0)),
    sum((id) => Math.min(2, h.failOn.get(id) ?? 0)),
    sum((id) => Math.min(3, h.succOn.get(id) ?? 0)) / k,
    team.filter((id) => h.lastMission.includes(id)).length / k,
    h.lastMission.length === team.length && sameSet(h.lastMission, team) ? 1 : 0,
    h.lastProp.length === team.length && sameSet(h.lastProp, team) ? 1 : 0,
    sum((id) => (h.lakeBad.has(id) ? 1 : 0)),
    sum((id) => (h.lakeGood.has(id) ? 1 : 0)),
    others.reduce((m, id) => Math.max(m, pRed.get(id) ?? 0.5), 0),
    leader === me ? 0 : pRed.get(leader) ?? 0.5,
    leader !== me && obs.knownEvils.includes(leader) ? 1 : 0,
    fails(obs) >= 2 || wins(obs) >= 2 ? 1 : 0,
    sum((id) => Math.min(2, h.failExp.get(id) ?? 0)),
    sum((id) => (h.failOnLast.has(id) ? 1 : 0)),
    sum((id) => Math.min(2, h.rejSucc.get(id) ?? 0) / 2),
    others.length ? sum((id) => h.likeMe.get(id) ?? 0.5) / others.length : 0.5,
    sum((id) => Math.min(2, h.appDirty.get(id) ?? 0) / 2),
    sum((id) => (h.lakeHolder.has(id) ? 1 : 0)),
    leader === me ? 1 : h.likeMe.get(leader) ?? 0.5,
    leader === me ? 0 : Math.min(2, h.inclMe.get(leader) ?? 0) / 2,
    leader === me ? 0 : Math.min(2, h.ledFailed.get(leader) ?? 0),
    team.includes(leader) ? 0 : 1,
    h.myLast?.approve ? 1 : 0,
    h.myLast && sameSet(h.myLast.team, team) ? (h.myLast.approve ? 1 : -1) : 0,
    obs.allPlayerIds.filter((id) => id !== me && !team.includes(id)).reduce((s, id) => s + Math.min(2, h.failExp.get(id) ?? 0), 0),
    obs.currentRound >= 3 ? clampLogit(clean) : 0,
    attempt === 4 ? (engineVote ? 1 : -1) : 0,
  ];
}

export function questFeatures(obs: PlayerObservation, engineCard: 'success' | 'fail'): number[] {
  const team = obs.proposedTeam;
  const seen = team.filter((id) => id !== obs.myPlayerId && obs.knownEvils.includes(id)).length;
  const role = obs.myRole as string;
  return [
    1,
    engineCard === 'fail' ? 1 : -1,
    obs.currentRound,
    seen,
    seen === 0 ? 1 : 0,
    team.length,
    failsNeeded(obs),
    fails(obs),
    wins(obs),
    role === 'assassin' ? 1 : 0,
    role === 'morgana' ? 1 : 0,
    role === 'mordred' ? 1 : 0,
    role === 'oberon' ? 1 : 0,
  ];
}

export function claimFeatures(obs: PlayerObservation, targetId: string, truth: 'good' | 'evil', engineClaim: 'good' | 'evil' | null, tuning: Readonly<Partial<AgentTuning>>): number[] {
  const h = history(obs);
  const pRed = redShares(obs, tuning);
  const engEvil = engineClaim === null ? truth === 'evil' : engineClaim === 'evil';
  return [
    1,
    engEvil ? 1 : -1,
    truth === 'evil' ? 1 : 0,
    obs.knownEvils.includes(targetId) ? 1 : 0,
    obs.currentRound,
    pRed.get(targetId) ?? 0.5,
    Math.min(2, h.failOn.get(targetId) ?? 0),
    wins(obs),
    fails(obs),
  ];
}

/** 湖中對象／刺殺的候選與特徵（座位特徵；`eng` = 引擎的對象）。 */
export function pickCandidates(obs: PlayerObservation, candidates: readonly string[], engineTarget: string, tuning: Readonly<Partial<AgentTuning>>): { ids: string[]; X: number[][] } {
  const S = seatFeatures(obs, [engineTarget], tuning);
  const ids = candidates.filter((id) => obs.allPlayerIds.includes(id));
  return { ids, X: ids.map((id) => S[obs.allPlayerIds.indexOf(id)]) };
}

// ── 打分與決定（上場用；擬合後的評估也用同一組） ─────────────

export interface RankedTeam { team: string[]; p: number }

/** softmax 機率（數值穩定）。 */
export function softmax(z: readonly number[]): number[] {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** 依分數排前 `top` 名（同分照候選順序）。 */
export function topK(z: readonly number[], top: number): number[] {
  return z.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, top).map(([, i]) => i);
}

export function rankTeamsFrom(c: TeamCandidates, w: Weights | undefined, top = 3): RankedTeam[] {
  const z = c.X.map((x) => dot(w, TEAM_FEATURES, x));
  const p = softmax(z);
  return topK(z, top).map((i) => ({ team: c.teams[i], p: p[i] }));
}

/**
 * 一位 AI騎士 的殘差層（一個座位一局一個）。沒有那一種決策的權重時，照引擎原本的決定。
 */
export class ResidualPolicy {
  constructor(private readonly weights: ResidualWeights, private readonly tuning: Readonly<Partial<AgentTuning>>) {}

  /** 前三名的隊與機率（第一名就是會派的隊）。沒有派隊權重時只回引擎的隊（機率 1）。 */
  rankTeams(obs: PlayerObservation, engineTeam: readonly string[], top = 3): RankedTeam[] {
    const w = this.weights.team?.[teamGroupOf(obs.myRole as string, obs.myTeam)];
    if (!w) return [{ team: [...engineTeam], p: 1 }];
    const f = teamSpotFeatures(obs, engineTeam, this.tuning);
    if (f.k > f.ids.length || engineTeam.length !== f.k) return [{ team: [...engineTeam], p: 1 }];
    return rankTeamsFrom(teamCandidatesFrom(f.ids, f.S, f.k, engineTeam, f.prevProp, f.lastMission), w, top);
  }

  team(obs: PlayerObservation, engineTeam: readonly string[]): string[] {
    return this.rankTeams(obs, engineTeam, 1)[0].team;
  }

  /** 贊成的機率。 */
  approveProb(obs: PlayerObservation, engineVote: boolean): number | null {
    const on = obs.proposedTeam.includes(obs.myPlayerId);
    const w = this.weights.vote?.[voteGroupOf(obs.myRole as string, obs.myTeam, on)];
    if (!w) return null;
    return sigmoid(dot(w, VOTE_FEATURES, voteFeatures(obs, engineVote, this.tuning)));
  }

  vote(obs: PlayerObservation, engineVote: boolean): boolean {
    const p = this.approveProb(obs, engineVote);
    return p === null ? engineVote : p >= 0.5;
  }

  questCard(obs: PlayerObservation, engineCard: 'success' | 'fail'): 'success' | 'fail' {
    if (obs.myTeam !== 'evil') return 'success';
    // A1：紅方已拿兩局 → 照引擎（兩敗後不拖）。
    if (fails(obs) >= 2) return engineCard;
    const w = this.weights.quest;
    if (!w) return engineCard;
    return sigmoid(dot(w, QUEST_FEATURES, questFeatures(obs, engineCard))) >= 0.5 ? 'fail' : 'success';
  }

  lakeTarget(obs: PlayerObservation, valid: readonly string[], engineTarget: string): string {
    const w = this.weights.lakeTarget?.[obs.myTeam];
    if (!w || valid.length === 0) return engineTarget;
    const c = pickCandidates(obs, valid, engineTarget, this.tuning);
    if (c.ids.length === 0) return engineTarget;
    return c.ids[topK(c.X.map((x) => dot(w, SEAT_FEATURES, x)), 1)[0]];
  }

  lakeClaim(obs: PlayerObservation, targetId: string, truth: 'good' | 'evil' | undefined, engineClaim: 'good' | 'evil' | null): 'good' | 'evil' | null {
    // A0：藍方持湖者照實宣告（不學）。
    if (obs.myTeam !== 'evil' || truth === undefined) return engineClaim;
    const w = this.weights.lakeClaim;
    if (!w) return engineClaim;
    return sigmoid(dot(w, CLAIM_FEATURES, claimFeatures(obs, targetId, truth, engineClaim, this.tuning))) >= 0.5 ? 'evil' : 'good';
  }

  assassinate(obs: PlayerObservation, engineTarget: string): string {
    const w = this.weights.assassinate;
    if (!w) return engineTarget;
    const evil = new Set([...(obs.allEvilIds ?? []), ...obs.knownEvils, obs.myPlayerId]);
    const cands = obs.allPlayerIds.filter((id) => !evil.has(id));
    if (cands.length === 0) return engineTarget;
    const c = pickCandidates(obs, cands, engineTarget, this.tuning);
    return c.ids[topK(c.X.map((x) => dot(w, SEAT_FEATURES, x)), 1)[0]];
  }
}

// ── 檢查（profile.ts 用） ───────────────────────────────────

const WEIGHT_MAX = 50;

function checkWeights(where: string, raw: unknown, names: readonly string[], errors: string[]): Weights | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push(`${where} 要是物件 {"特徵": 權重}`); return undefined; }
  const out: Weights = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!names.includes(k)) { errors.push(`${where}.${k}：不認得的特徵`); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > WEIGHT_MAX) { errors.push(`${where}.${k} 要是 −${WEIGHT_MAX} 到 ${WEIGHT_MAX} 的數字`); continue; }
    out[k] = v;
  }
  return out;
}

function checkGroups<G extends string>(where: string, raw: unknown, groups: readonly G[], names: readonly string[], errors: string[]): Partial<Record<G, Weights>> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push(`${where} 要是物件`); return undefined; }
  const out: Partial<Record<G, Weights>> = {};
  for (const [g, v] of Object.entries(raw)) {
    if (!(groups as readonly string[]).includes(g)) { errors.push(`${where} 不認得「${g}」（可用：${groups.join('、')}）`); continue; }
    const w = checkWeights(`${where}.${g}`, v, names, errors);
    if (w) out[g as G] = w;
  }
  return out;
}

const RESIDUAL_KEYS = new Set(['version', 'team', 'vote', 'quest', 'lakeTarget', 'lakeClaim', 'assassinate']);

/** 檢查 profile 的 `residual`；回傳整理過的權重（有錯時 undefined）。 */
export function validateResidual(raw: unknown, errors: string[]): ResidualWeights | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push('residual 要是物件'); return undefined; }
  const r = raw as Record<string, unknown>;
  const before = errors.length;
  for (const k of Object.keys(r)) if (!RESIDUAL_KEYS.has(k)) errors.push(`residual 不認得的欄位「${k}」`);
  if (r.version !== RESIDUAL_VERSION) errors.push(`residual.version 要是 ${RESIDUAL_VERSION}`);
  const out: ResidualWeights = { version: RESIDUAL_VERSION };
  const team = checkGroups('residual.team', r.team, TEAM_GROUPS, TEAM_FEATURES, errors);
  if (team) out.team = team;
  const vote = checkGroups('residual.vote', r.vote, VOTE_GROUPS, VOTE_FEATURES, errors);
  if (vote) out.vote = vote;
  if (r.quest !== undefined) { const w = checkWeights('residual.quest', r.quest, QUEST_FEATURES, errors); if (w) out.quest = w; }
  const lake = checkGroups('residual.lakeTarget', r.lakeTarget, ['good', 'evil'] as const, SEAT_FEATURES, errors);
  if (lake) out.lakeTarget = lake;
  if (r.lakeClaim !== undefined) { const w = checkWeights('residual.lakeClaim', r.lakeClaim, CLAIM_FEATURES, errors); if (w) out.lakeClaim = w; }
  if (r.assassinate !== undefined) { const w = checkWeights('residual.assassinate', r.assassinate, SEAT_FEATURES, errors); if (w) out.assassinate = w; }
  return errors.length === before ? out : undefined;
}

