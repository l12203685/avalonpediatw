/**
 * 優化迴圈第 49 回合・藍方（2026-11-21）：第 47 回合的下一步＋第 1F 節落差量尺的新發現。預設全部關。
 *
 *   - `r1ReuseRate49`（q）：第 1 局成功之後，忠臣／派西在第 2 局的提議整隊包含第 1 局任務隊的比例照真人。第 45／49 回合量到：
 *     機器人忠臣 34,562／34,563（100%）、真人忠臣 1,053／1,392（75.6%）、強者桌 148／188（78.7%；game_db 82d4188）。
 *     照局面雜湊，1 − q 的提議把第 1 局隊員裡自己後驗最紅的一個換成隊外最乾淨、而且過得了隊長自己的關卡的人。
 *   - `goodCleanLeadR4Fix49`（ε）：第 47 回合 `goodCleanLeadR4Fix47`（第 4 局挑「少於兩紅」機率最高）在 5 萬局 −0.43、第 1F 節 forced:R4／R5 變差。
 *     拆開（第 49 回合）：在藍方已兩勝的局面第 4 局成功率 +2.2pp，但刺中梅林 +4.5pp（忠臣改挑有一紅的隊，挑最乾淨隊的梅林就顯出來）；
 *     忠臣的提議通過率下降（投票的人還在看「沒有紅」），走到第 5 次提議 +4–8pp。修正：仍然以「沒有紅」為主，只在「少於兩紅」機率
 *     比最好的低超過 ε 的隊不派（少於兩紅當門檻、乾淨當目標）。實作在 `GoodRound5.goodCleanLeadTeam`。
 *   - `earlyWhite49`（τ）：第 2 局走到第 5 次提議前就通過的比例機器人 0.3%、真人 15.1%（game_db）。第 2 局的尾家外白
 *     （`GoodVoteAlt.loyalTailWhiteNow`，D3 第一階段，忠臣）用比較低的門檻 τ（預設的 `loyalTailWhite` 0.7 在第 2 局幾乎不觸發）。
 *   - 湖的規劃只當同分的取捨：用第 47 回合的 `lakePlanLead47` 給極小的 ε（例如 1e-6），不需要新開關。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';

function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000;
}

/** 第 1 局成功的任務隊（沒有或失敗 = null）。 */
export function r1SuccessTeam(obs: PlayerObservation): string[] | null {
  const q = obs.questHistory.find((x) => x.round === 1);
  return q && (q.failCount ?? 0) === 0 ? [...q.team] : null;
}

/**
 * `r1ReuseRate49`：要不要把這個第 2 局的提議換掉一個第 1 局隊員。忠臣／派西（真的藍方座位，不是紅方的忠臣視角）、第 2 局、第 1 局成功、
 * 這隊整隊包含第 1 局的隊，照座位、第幾次提議與隊伍雜湊 ≥ q 時換：第 1 局隊員裡（自己以外）後驗最紅的一個，換成隊外第一個過得了 `ok` 的人
 * （`outsiders` 由呼叫端照乾淨排好；只在真的要換時才呼叫）。沒有可換的就照原本。
 */
export function r1ReuseThinTeam49(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  team: readonly string[],
  share: ReadonlyMap<string, number>,
  outsiders: () => readonly string[],
  ok: (team: readonly string[]) => boolean,
): string[] | null {
  const q = tuning.r1ReuseRate49 ?? 0;
  if (q <= 0 || q >= 1 || (obs.currentRound ?? 1) !== 2 || obs.myTeam !== 'good' || obs.publicLoyalView === true) return null;
  if ((obs.seatTeam ?? obs.myTeam) !== 'good' || (obs.myRole !== 'loyal' && obs.myRole !== 'percival')) return null;
  const r1 = r1SuccessTeam(obs);
  if (!r1 || !r1.every((id) => team.includes(id))) return null;
  if (hash01(`${obs.myPlayerId}|${obs.failCount ?? 0}|${[...team].sort().join(',')}|r1reuse49`) < q) return null;
  const me = obs.myPlayerId;
  const drop = r1.filter((id) => id !== me).sort((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0) || obs.allPlayerIds.indexOf(a) - obs.allPlayerIds.indexOf(b));
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

/** `earlyWhite49`：第 2 局的尾家外白門檻（0 = 照 `loyalTailWhite`）。 */
export function earlyWhiteTuning49(tuning: Readonly<AgentTuning>, obs: PlayerObservation): Readonly<AgentTuning> {
  const tau = tuning.earlyWhite49 ?? 0;
  if (tau <= 0 || (obs.currentRound ?? 1) !== 2) return tuning;
  return { ...tuning, loyalTailWhite: tau };
}
