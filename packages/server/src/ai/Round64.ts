/**
 * 第 64 回合（藍方・梅林的拇指，加上紅方奧伯倫第 1 局的牌）：站長 2026-11-23 對 Gemini 第二意見（Issue #149，`docs/ai/gemini_strategy_review.md`）的裁定。
 *
 * G4（站長原話）：
 * > 這個的問題在於忠臣/派西維爾沒有足夠推理或思考能力, 所以梅林應該是先去推測, 後續其他好人有沒有能力不派到任何拇指, 有的話就沒必要刻意去派可見紅方
 *
 * `merlinForecast64`（位元；0 = 關）：第 58 回合 `merlinPublicThumb58` 判定「逼不得已」、要照公開視角派一支帶拇指的隊時（第 1、2 局第 1–4 次提議），
 * 梅林先推測：這一局後面輪到的隊長裡，他看得到的紅以外的人（他眼中的好人）照機器人自己的忠臣派法、只用公開紀錄（`forecastView64`，坐在那個座位的忠臣），
 * 會不會派出沒有拇指的隊。
 *   - 1 = 開：後面的好人隊長**任何一個**會派沒有拇指的隊 → 梅林也派乾淨的隊（不刻意放可見紅；同現行沒有第 58 回合時那一支）；
 *   - 2 = 改成**每一個**都會派沒有拇指的隊才算；
 *   - 4 = 後面的好人隊長都派不出（照樣要派拇指）時，不取公開分數最高的那支，在公開上說得通的隊裡照公開分數做溫度抽樣（Gemini 問題三，τ = 0.15，
 *         照局面雜湊抽，同一個局面每次一樣）。
 * G5 `merlinForcedThumbGate64`（值 = 分數差門檻 θ；0 = 關；Gemini 問題四）：「逼不得已」改成量化的條件——紅方沒有聽牌（紅方兩勝而且不是第 4 局、或第 5 局都不派）、
 *   公開最佳隊與不帶拇指最佳隊的公開「這隊沒有紅」機率差 > θ、而且不帶拇指最佳隊的公開排名掉出前 35%，才派**恰好 1 根**拇指（公開分數最高的一拇指隊）；
 *   否則照現行的乾淨隊。範圍同 `merlinPublicThumbScope58`。
 * G7 `oberonR1AlwaysFail64`（1 = 開；Gemini 問題五；站長「只在真人桌測」）：奧伯倫第 1 局上任務一律出失敗（取代第 27 回合 `redHideHuman` 的 45% 藏牌）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

/** 診斷計數（研究腳本、自我對打拆解用；不影響決策）。 */
export const round64Stats = {
  forecast: 0, forecastClean: 0, forecastMix: 0, sampled: 0, gate: 0, gateThumb: 0, oberon: 0,
  /** G5 的分數差（0.01 一格）×「排名掉出前 35%」的次數：gapHist[格][0 = 前 35% 內, 1 = 掉出]。 */
  gapHist: Array.from({ length: 21 }, () => [0, 0]),
};

/** Gemini 問題三的溫度（公開分數 = log P(沒有紅) 的尺度）。 */
export const FORECAST_TAU_64 = 0.15;
/** Gemini 問題四：不帶拇指最佳隊的公開排名掉出前這個比例才算「說不通」。 */
export const GATE_RANK_64 = 0.35;

/** 這一局後面（到第 5 次提議為止）輪到的隊長，扣掉梅林自己看得到的紅（他眼中的好人），依輪序。 */
export function upcomingGoodLeaders64(obs: PlayerObservation): { leader: string; fc: number }[] {
  const ids = obs.allPlayerIds;
  const me = obs.myPlayerId;
  const fc = obs.failCount ?? 0;
  const i = ids.indexOf(obs.currentLeader ?? me);
  if (i < 0) return [];
  const seen = new Set(obs.knownEvils);
  const out: { leader: string; fc: number }[] = [];
  for (let k = 1; fc + k <= 4; k++) {
    const leader = ids[(i + k) % ids.length];
    if (leader === me || seen.has(leader)) continue;
    out.push({ leader, fc: fc + k });
  }
  return out;
}

/** 坐在 `leader` 位置、只看公開紀錄的忠臣在第 fc + 1 次提議當隊長時的觀察（梅林的私人資訊、湖的私人結果都拿掉）。 */
export function forecastView64(obs: PlayerObservation, leader: string, fc: number): PlayerObservation {
  return {
    ...obs,
    myPlayerId: leader,
    myRole: 'loyal',
    myTeam: 'good',
    knownEvils: [],
    knownWizards: undefined,
    allEvilIds: undefined,
    allEvilRoles: undefined,
    myLakeResults: [],
    currentLeader: leader,
    failCount: fc,
    gamePhase: 'team_select',
    proposedTeam: [],
    publicLoyalView: false,
    redLoyalView: false,
    seatTeam: 'good',
    goLikeOwnViewFc: undefined,
  };
}

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 100000) / 100000;
}

/** 紅方聽牌（Gemini 問題四條件 1）：紅方兩勝而且不是第 4 局，或第 5 局。 */
function redMatchPoint(obs: PlayerObservation): boolean {
  const fails = (obs.questResults ?? []).filter((r) => r === 'fail').length;
  const round = obs.currentRound ?? 1;
  return (fails >= 2 && round !== 4) || round === 5;
}

export interface Fallback64Ctx {
  /** 公開上合法的隊（帶公開「沒有紅」機率 p 與現行的公開分數）。 */
  pub: readonly { team: string[]; p: number; score: number }[];
  /** 不帶看得到的紅、過梅林自己關卡的隊（現行的順序；第一支 = 現行的乾淨隊）。 */
  clean: readonly { team: string[]; p: number }[];
}

/**
 * 第 64 回合 G5 的「逼不得已」判斷：回傳 'thumb'（派一根拇指）、'clean'（照現行的乾淨隊）。
 */
export function forcedThumbGate64(theta: number, obs: PlayerObservation, ctx: Fallback64Ctx): 'thumb' | 'clean' {
  round64Stats.gate++;
  if (redMatchPoint(obs) || ctx.clean.length === 0 || ctx.pub.length === 0) return 'clean';
  const top = Math.max(...ctx.pub.map((c) => c.p));
  const pc = ctx.clean[0].p;
  const gap = top - pc;
  const above = ctx.pub.filter((c) => c.p > pc + 1e-12).length;
  const rankPct = above / ctx.pub.length;
  round64Stats.gapHist[Math.min(20, Math.max(0, Math.floor(gap * 100)))][rankPct > GATE_RANK_64 ? 1 : 0]++;
  if (gap > theta && rankPct > GATE_RANK_64) { round64Stats.gateThumb++; return 'thumb'; }
  return 'clean';
}

/** G5：公開分數最高、恰好一根拇指的隊（沒有 → null）。 */
export function oneThumbTeam64(obs: PlayerObservation, pub: Fallback64Ctx['pub']): string[] | null {
  const seen = new Set(obs.knownEvils);
  let best: { team: string[]; score: number } | null = null;
  for (const c of pub) {
    if (c.team.filter((id) => seen.has(id)).length !== 1) continue;
    if (!best || c.score > best.score) best = c;
  }
  return best ? best.team : null;
}

/**
 * G4：梅林要派拇指之前先推測後面的好人隊長。true = 後面的好人隊長派得出沒有拇指的隊（梅林派乾淨的隊）。
 */
export function goodLeadersCanGoClean64(tuning: Readonly<AgentTuning>, obs: PlayerObservation, forecast: (view: PlayerObservation) => string[] | null): boolean {
  const mode = tuning.merlinForecast64 ?? 0;
  const leaders = upcomingGoodLeaders64(obs);
  round64Stats.forecast++;
  if (leaders.length === 0) return false;
  const seen = new Set(obs.knownEvils);
  const needAll = (mode & 2) !== 0;
  let clean = 0;
  let total = 0;
  for (const { leader, fc } of leaders) {
    const team = forecast(forecastView64(obs, leader, fc));
    if (!team || team.length === 0) continue;
    total++;
    const free = !team.some((id) => seen.has(id));
    if (free) clean++;
    if (!needAll && free) break;
    if (needAll && !free) break;
  }
  const ok = total > 0 && (needAll ? clean === total && total === leaders.length : clean > 0);
  if (ok) round64Stats.forecastClean++; else round64Stats.forecastMix++;
  return ok;
}

/** G4 位元 4：公開上說得通的隊裡照公開分數做溫度抽樣（照局面雜湊）。 */
export function temperedPick64(obs: PlayerObservation, pub: Fallback64Ctx['pub'], floor: number, allowed: (team: readonly string[]) => boolean): string[] | null {
  const seen = new Set(obs.knownEvils);
  const pool = pub.filter((c) => c.p >= floor && (c.team.some((id) => seen.has(id)) || allowed(c.team)));
  if (pool.length === 0) return null;
  const top = Math.max(...pool.map((c) => c.score));
  const w = pool.map((c) => Math.exp((c.score - top) / FORECAST_TAU_64));
  const sum = w.reduce((s, x) => s + x, 0);
  let u = hash01(`${obs.myPlayerId}|${obs.currentRound ?? 1}|${obs.failCount ?? 0}|${obs.voteHistory.length}|forecast64`) * sum;
  for (let i = 0; i < pool.length; i++) { u -= w[i]; if (u <= 0) { round64Stats.sampled++; return pool[i].team; } }
  return pool[pool.length - 1].team;
}

/** 這一次梅林的提議要不要套 G4／G5（範圍另外由第 58 回合的 `publicThumb58FallbackOn` 決定）。 */
export function round64MerlinOn(tuning: Readonly<AgentTuning>): boolean {
  return (tuning.merlinForecast64 ?? 0) > 0 || (tuning.merlinForcedThumbGate64 ?? 0) > 0;
}

/**
 * G7：奧伯倫第 1 局在任務隊上一律出失敗；null = 不適用（開關關、不是奧伯倫、不是第 1 局、不在隊上）。
 */
export function oberonR1Card64(tuning: Readonly<AgentTuning>, obs: PlayerObservation): 'fail' | null {
  if ((tuning.oberonR1AlwaysFail64 ?? 0) <= 0 || obs.gamePhase !== 'quest_vote' || obs.myRole !== 'oberon') return null;
  if ((obs.currentRound ?? 1) !== 1 || !(obs.proposedTeam ?? []).includes(obs.myPlayerId)) return null;
  round64Stats.oberon++;
  return 'fail';
}
