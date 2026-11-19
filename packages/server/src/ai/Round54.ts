/**
 * 第 54 回合（網站玩家回報 2026-11-19；站長「這種 bug 蠻嚴重的」）：10 人局，第 1 局 457 成功，第 2 局大家都派「457＋1」，
 * 0 家的 4570 失敗；第 3 局 1–4 家又都派 457＋1——連梅林 2 家都派 2457，5 家是他看得到的紅（莫甘娜）。
 *
 * 原因（`scripts/knownRedStudy.ts`、第 54 回合紀錄）：
 *   - 梅林：`merlinReuseNorm=3` 在第 3 局起照派「最近一次成功的任務」，上一局失敗時回到之前成功的隊——那一隊整隊在剛失敗的任務裡、
 *     隊上看得到的紅剛出過失敗的任務，仍然照派（邏輯閘門是公開視角的，擋不到）。真人梅林在這種局面帶這個紅 3.3%，機器人 29.9%（自我對打）。
 *   - 忠臣／派西：後驗把第 1 局成功的隊讀得太乾淨（第 52 回合也看到），失敗過的照派仍然整隊留著：真人 32%（第 3 局），機器人 78%；
 *     真人局裡那一隊其實有紅 55%（第 3 局）。
 *
 * 開關（預設全部 0）：
 *   - `merlinKnownRed54`（位元）：1 = 梅林照派成功的隊（`merlinReuseNorm`）時，那一隊上看得到的紅在之後失敗的任務上就不照派（改派照忠臣方式的隊）；
 *     2 = 第 2、3、5 局（第 4 局要兩張失敗，真人 11.9% 會帶，不管）梅林的隊不放出過失敗任務、他看得到的紅（照派、順著派、派拇指躲刺都一樣）；
 *     4 = 位元 1 在第 4 局也不管（第 4 局照舊照派）。
 *   - `failedReuse54`：忠臣／派西當隊長、局面裡有「失敗過的照派」（成功隊 S 整隊在之後失敗的任務 F 裡）、提議整隊包含 S 時，
 *     把 S 裡（自己以外）後驗最紅的一個換成隊外最乾淨、過得了隊長自己關卡的人。1 = 每次換；2 = 照真人留 S 的比例（第 3 局 32%、第 4 局 25%、
 *     第 5 局 16.5%，照局面雜湊）其餘換；3 = 一半（第 1C 節的 50%）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

const subset = (a: readonly string[], b: readonly string[]): boolean => a.every((x) => b.includes(x));

/** 任務出了失敗牌（第 4 局一張失敗仍算成功，但一樣公開證明隊上有紅；INV-B3：不只看結果）。 */
const failCards = (q: { failCount: number }): boolean => (q.failCount ?? 0) > 0;

/** 失敗過的照派的成功隊：沒有失敗牌的成功隊 S 整隊在之後某一個出了失敗牌的任務隊 F 裡（照回合，舊的在前）。 */
export function failedReuseCores(obs: PlayerObservation): string[][] {
  const qs = obs.questHistory;
  return qs.filter((s) => !failCards(s) && qs.some((f) => failCards(f) && f.round > s.round && subset(s.team, f.team))).map((s) => [...s.team]);
}

/** 出過有失敗牌的任務、梅林看得到的紅（不是梅林 = 空的）。 */
export function seenRedsOnFailedMissions(obs: PlayerObservation): string[] {
  if (obs.myRole !== 'merlin') return [];
  const failed = obs.questHistory.filter(failCards);
  return obs.knownEvils.filter((id) => failed.some((q) => q.team.includes(id)));
}

/** `merlinKnownRed54` 位元 1：照派成功的隊 `succ`（第 `succRound` 局）時，隊上看得到的紅在之後失敗的任務上 → 不照派。 */
export function merlinReuseTainted54(tuning: Readonly<AgentTuning>, obs: PlayerObservation, succ: readonly string[], succRound: number): boolean {
  if (((tuning.merlinKnownRed54 ?? 0) & 1) === 0 || obs.myRole !== 'merlin') return false;
  // Bit 4: round 4 as before (two fails needed; human Merlins keep such a red there 11.9%).
  if (((tuning.merlinKnownRed54 ?? 0) & 4) !== 0 && (obs.currentRound ?? 1) === 4) return false;
  const later = obs.questHistory.filter((q) => failCards(q) && q.round > succRound);
  return succ.some((id) => obs.knownEvils.includes(id) && later.some((q) => q.team.includes(id)));
}

/** `merlinKnownRed54` 位元 2：這一次提議梅林的隊不能放的紅（第 2、3、5 局：出過失敗任務、他看得到的紅）；不適用 = 空的。 */
export function merlinBarredReds54(tuning: Readonly<AgentTuning>, obs: PlayerObservation): string[] {
  if (((tuning.merlinKnownRed54 ?? 0) & 2) === 0 || obs.myRole !== 'merlin') return [];
  const round = obs.currentRound ?? 1;
  if (round < 2 || round === 4) return [];
  return seenRedsOnFailedMissions(obs);
}

/** 真人忠臣／派西在有「失敗過的照派」的局面整隊留 S 的比例（`knownRedStudy`，2,236 局：第 3 局 406／1,269、第 4 局 259／1,037、第 5 局 86／521）。 */
export const FAILED_REUSE_KEEP_54: Readonly<Record<number, number>> = { 3: 0.32, 4: 0.25, 5: 0.165 };

/**
 * `failedReuse54`：要不要把這次提議裡的「失敗過的照派」S 換掉一個人。忠臣／派西（真的藍方座位，不是紅方的忠臣視角）、提議整隊包含 S 時，
 * S 裡（自己以外）後驗最紅的一個換成隊外第一個過得了 `ok` 的人（`outsiders` 由呼叫端照乾淨排好，只在真的要換時才呼叫）。沒有可換的就照原本（null）。
 */
export function failedReuseBreakTeam54(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  team: readonly string[],
  share: ReadonlyMap<string, number>,
  outsiders: () => readonly string[],
  ok: (team: readonly string[]) => boolean,
): string[] | null {
  const mode = tuning.failedReuse54 ?? 0;
  if (mode <= 0 || obs.myTeam !== 'good' || obs.publicLoyalView === true) return null;
  if ((obs.seatTeam ?? obs.myTeam) !== 'good' || (obs.myRole !== 'loyal' && obs.myRole !== 'percival')) return null;
  const round = obs.currentRound ?? 1;
  const core = failedReuseCores(obs).reverse().find((s) => subset(s, team));
  if (!core) return null;
  const keep = mode === 2 ? FAILED_REUSE_KEEP_54[round] ?? 0 : mode === 3 ? 0.5 : 0;
  if (keep > 0 && hash01(`${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${[...team].sort().join(',')}|failedreuse54`) < keep) return null;
  const me = obs.myPlayerId;
  const drop = core.filter((id) => id !== me).sort((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0) || obs.allPlayerIds.indexOf(a) - obs.allPlayerIds.indexOf(b));
  const outs = outsiders();
  for (const out of drop) {
    for (const inn of outs) {
      if (team.includes(inn)) continue;
      const t = team.map((id) => (id === out ? inn : id));
      if (ok(t)) return t;
    }
  }
  return null;
}
