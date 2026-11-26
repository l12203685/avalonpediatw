/**
 * 第 90 回合 第 2 號模型（三藍之後的刺殺估值器 P(梅林 = 這個座位 | 公開紀錄, 紅方開牌)）的特徵：每個候選人（非紅、非刺客自己）一列。
 *
 * 刺殺時四個紅方開牌相認（`allEvilRoles`），所以每個候選人「如果他是梅林，他看得到哪三個紅」是確定的：V = 紅方 − 莫德雷德。
 * 特徵只用公開紀錄（提議、票、任務結果、湖的持有者／目標／宣告）＋紅方的角色；絕不讀藍方的真實角色。
 * - 現行世界線刺客（第 75 回合，`worldLines75`，正式的表）的梅林／派西維爾邊際與九個分量裡梅林、派西假設的平均（`wl*`）；
 * - 現行刺客的分層（`front`：沒有在非強制的提議放過看得到的紅；由呼叫的人給）；
 * - 跨回合的計數：當隊長時隊上有沒有 V／莫德雷德／莫甘娜、乾淨的隊、自己在不在隊上；票（在不在隊上 × 隊上有沒有 V）；
 *   任務成敗；湖（湖了誰、被誰湖）；座位（以 1-1 隊長為 1 家）。
 * 訓練（`scripts/ml/exportAssassin90.ts` → `scripts/ml/train90.py assassin`）與執行期（`Round90.ts`）用同一支函式。
 */
import type { PlayerObservation } from '../types';
import { worldLines75, type WorldLineTables } from '../assassin/WorldLines75';

export const ASSASSIN_FEATURES_90 = [
  'wlMerlin', 'wlPercival', 'wlMk', 'wlMv', 'wlMl', 'wlPk', 'wlPv', 'wlPl', 'front',
  'nLead', 'nLeadForced', 'leadV', 'leadVR3', 'leadVForced', 'leadD', 'leadMorgana', 'leadClean', 'leadSelfOff',
  'nVotes', 'offApprV', 'offRejV', 'onApprV', 'offApprClean', 'rejClean', 'rejVRate', 'apprCleanRate', 'apprDOnly',
  'onFail', 'onSucc', 'lakeHeld', 'lakeTargetV', 'lakeTargetBlue', 'laked', 'lakedEvil',
  'inclByBlue', 'inclByRed', 'seat', 'seat0', 'seat5', 'fails', 'rounds',
] as const;

const NF = ASSASSIN_FEATURES_90.length;

export interface AssassinRows90 {
  ids: string[];
  rows: Float64Array[];
}

const failedQuest = (q: { round: number; failCount?: number; result?: string }, n: number): boolean =>
  q.result === 'fail' || (q.failCount ?? 0) >= (q.round === 4 && n >= 7 ? 2 : 1);

/**
 * `candidates` = 要排序的座位；`front` = 現行分層的第一層（沒有給 = 全部當第一層）。不適用（沒有紅方開牌、不是十人局）時 null。
 */
export function assassinFeatures90(obs: PlayerObservation, candidates: readonly string[], front?: ReadonlySet<string>, tables?: WorldLineTables): AssassinRows90 | null {
  const roles = obs.allEvilRoles;
  if (!roles) return null;
  const reds = new Map(Object.entries(roles));
  if (reds.size !== 4) return null;
  const mordred = [...reds].find(([, r]) => r === 'mordred')?.[0];
  const morgana = [...reds].find(([, r]) => r === 'morgana')?.[0];
  if (!mordred || !morgana) return null;
  const wl = tables ? worldLines75(obs, tables) : worldLines75(obs);
  if (!wl) return null;
  const ids = obs.allPlayerIds;
  const n = ids.length;
  const V = new Set([...reds.keys()].filter((id) => id !== mordred));
  const isRed = (id: string): boolean => reds.has(id);
  const idx = new Map(ids.map((id, i) => [id, i] as const));
  const first = obs.voteHistory.length > 0 ? obs.voteHistory[0].leader : obs.currentLeader;
  const i1 = idx.get(first) ?? 0;
  const quests = obs.questHistory.map((q) => ({ round: q.round, team: new Set(q.team), failed: failedQuest(q, n) }));
  const fails = quests.filter((q) => q.failed).length;
  // World-line component means per candidate: Merlin hypothesis (comps 3..5) and Percival hypothesis (comps 0..2).
  const mSum = new Map<string, number[]>();
  const pSum = new Map<string, number[]>();
  for (const w of wl.worlds) {
    const m = mSum.get(w.merlin) ?? [0, 0, 0, 0];
    m[0] += w.comps[3]; m[1] += w.comps[4]; m[2] += w.comps[5]; m[3]++;
    mSum.set(w.merlin, m);
    const p = pSum.get(w.percival) ?? [0, 0, 0, 0];
    p[0] += w.comps[0]; p[1] += w.comps[1]; p[2] += w.comps[2]; p[3]++;
    pSum.set(w.percival, p);
  }
  const rows: Float64Array[] = [];
  const outIds: string[] = [];
  for (const s of candidates) {
    if (isRed(s)) continue;
    const x = new Float64Array(NF);
    x[0] = wl.merlin.get(s) ?? -10;
    x[1] = wl.percival.get(s) ?? -10;
    const m = mSum.get(s) ?? [0, 0, 0, 1];
    const p = pSum.get(s) ?? [0, 0, 0, 1];
    x[2] = m[0] / m[3]; x[3] = m[1] / m[3]; x[4] = m[2] / m[3];
    x[5] = p[0] / p[3]; x[6] = p[1] / p[3]; x[7] = p[2] / p[3];
    x[8] = front ? (front.has(s) ? 1 : 0) : 1;
    let nLead = 0; let nLeadF = 0; let leadV = 0; let leadVR3 = 0; let leadVF = 0; let leadD = 0; let leadMg = 0; let leadClean = 0; let leadSelfOff = 0;
    let nv = 0; let offApprV = 0; let offRejV = 0; let onApprV = 0; let offApprClean = 0; let rejClean = 0; let vN = 0; let vRej = 0; let cN = 0; let cAppr = 0; let apprD = 0;
    let inclBlue = 0; let inclRed = 0;
    for (const v of obs.voteHistory) {
      const forced = v.attempt >= 5;
      const team = v.team;
      const on = team.includes(s);
      const hasV = team.some((t) => V.has(t));
      const hasD = team.includes(mordred);
      const anyRed = team.some(isRed);
      if (v.leader === s) {
        if (forced) nLeadF++; else nLead++;
        if (hasV) { if (forced) leadVF++; else { leadV++; if (v.round >= 3) leadVR3++; } }
        if (hasD) leadD++;
        if (team.includes(morgana)) leadMg++;
        if (!anyRed) leadClean++;
        if (!on) leadSelfOff++;
        continue;
      }
      if (on) { if (isRed(v.leader)) inclRed++; else inclBlue++; }
      if (forced) continue;
      const vote = v.votes[s];
      if (vote === undefined) continue;
      nv++;
      if (hasV) {
        vN++;
        if (!vote) vRej++;
        if (!on) { if (vote) offApprV++; else offRejV++; } else if (vote) onApprV++;
      } else if (!anyRed) {
        cN++;
        if (vote) cAppr++;
        if (vote && !on) offApprClean++;
        if (!vote) rejClean++;
      } else if (hasD && vote) {
        apprD++;
      }
    }
    x[9] = nLead; x[10] = nLeadF; x[11] = leadV; x[12] = leadVR3; x[13] = leadVF; x[14] = leadD; x[15] = leadMg; x[16] = leadClean; x[17] = leadSelfOff;
    x[18] = nv; x[19] = offApprV; x[20] = offRejV; x[21] = onApprV; x[22] = offApprClean; x[23] = rejClean;
    x[24] = (vRej + 1) / (vN + 2); x[25] = (cAppr + 1) / (cN + 2); x[26] = apprD;
    let onFail = 0; let onSucc = 0;
    for (const q of quests) if (q.team.has(s)) { if (q.failed) onFail++; else onSucc++; }
    x[27] = onFail; x[28] = onSucc;
    let held = 0; let tV = 0; let tB = 0; let laked = 0; let lakedEvil = 0;
    for (const l of obs.lakeHistory ?? []) {
      if (l.holderId === s) { held++; if (V.has(l.targetId)) tV++; else if (!isRed(l.targetId)) tB++; }
      if (l.targetId === s) { laked++; if (l.declaredClaim === 'evil') lakedEvil++; }
    }
    x[29] = held; x[30] = tV; x[31] = tB; x[32] = laked; x[33] = lakedEvil;
    x[34] = inclBlue; x[35] = inclRed;
    const seat = (((idx.get(s) ?? 0) - i1 + n) % n) + 1;
    x[36] = seat; x[37] = seat === n ? 1 : 0; x[38] = seat === 5 ? 1 : 0;
    x[39] = fails; x[40] = quests.length;
    rows.push(x);
    outIds.push(s);
  }
  return { ids: outIds, rows };
}
