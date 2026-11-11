/**
 * 優化迴圈第 41 回合・藍方（2026-11-11／12）。
 *
 * 藍方持湖的規則（`goodLake41`），照「湖中女神：該湖誰」的報告第 (3) 節，加上專案負責人之後的更正：
 *   湖中分數 = 資訊量 ＋ 權重 × 對方是好人的機率。資訊量 = h(P(紅))（湖完之後持湖者對這個人少了多少不確定；一半一半時是 1），
 *   P(紅) 是持湖者自己的後驗（派西含拇指的限制；梅林用忠臣看得到的公開視角排序，見下）。
 *   權重：紅方未兩勝、後面還有湖 = 2；紅方已兩勝（含最後一湖）= 0，只看資訊（11/12 更正：紅方聽牌時第三局過了就有四個確定的好人，
 *   湖的價值在資訊，不在把湖留在藍方）。紅方已兩勝時「只看資訊」有兩種做法（`goodLake41` 的低兩位）：1 = 最不確定的人（h 最大）、
 *   2 = 最可能是紅的人（推演在第 1 湖 FF 偏向這一種）、3 = 第 1 湖最可能是紅、第 2、3 湖最不確定（推演在第 2 湖偏向最不確定）。
 *
 * 第 0 步（先拿掉不該湖的人）：持湖者自己出過的失敗任務已經確定是紅的人；派西讀法信心 ≥ 0.7 的莫甘娜（11/11 晚裁定 (4)）；
 * 第 1、2 湖上過出兩張以上失敗的隊的人（LH-01）——每一條都是「還有別人可以湖時」。梅林看得到的紅由呼叫端的避開名單拿掉。
 * 第 1 步（照比分順序的人選範圍，前面的範圍有人就只在那裡挑）：
 *   第 1 湖 FS：兩局都上過的人（百科 wiki-208 §2，裁定 (3)），沒有就只上第 2 局的人；
 *   第 1 湖 SS：第 2 局的隊員（LH-05；同分時先挑自己派的隊出過任務的人）；
 *   第 1 湖 SF：兩局都上過的人，其次沒上過任務的人（LH-04；位元 4 = 不分範圍，只量）；
 *   第 1 湖 FF：上過失敗任務、但不是兩張失敗那一隊的人（LH-02），其次沒上過任務的人；
 *   第 2 湖 SFS、FSS：第 3 局的隊員（LH-07）；第 2 湖 SSF、SFF、FSF、FFS：不限（兩張失敗的隊已拿掉；LH-08／LH-09 的偏好已經在分數裡）；
 *   第 3 湖（最後一湖）：第 4 局成功、比分 SFFS／FSFS 時湖第 4 局的隊員（LH-10），其他不限。
 * 同分（分數差 < 1e-9）：照強者的排序，不用亂數、不用座位號碼（裁定 (1)）——第 1 湖 SS 先挑自己派的隊出過任務的人，再挑比較藍的（只在權重大於 0 時；
 * 紅方已兩勝與最後一湖只看資訊，不用顏色排），
 * 再挑被別人的提議選進隊伍比較多次的人（被越多人選的人越可能是好人），再挑在提議紀錄裡比較早出現的人；都一樣才照座位序（並計數，應該幾乎不會發生）。
 * 梅林（11/11 晚、lp39 LH-12）：先用忠臣看得到的公開範圍（他看得到的紅已被拿掉，除非只剩他們），範圍內用忠臣的公開視角排序，
 * 不讓刺客從湖法看出梅林；位元 16 = 改用梅林自己的後驗排序（只量）。
 * 診斷用的位元（只量）：32 = 第 1 湖 FS 照原本的規則；64 = 只用在第 1 湖；128 = 只用在第 2、3 湖。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { percivalRead39 } from './BlueRound39Percival';
import { certainReds, lake39Candidates, lake39State, type Lake39Candidate, type LakeClass } from './BlueRound39';
import { anotherLakeFollows } from './GoodLakeInfo';

/** 這個持湖者適用 `goodLake41`：開關開、藍方座位。 */
export function goodLake41On(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  return ((tuning.goodLake41 ?? 0) & 3) !== 0 && (obs.seatTeam ?? obs.myTeam) === 'good';
}

/**
 * 紅方已兩勝時的資訊做法：1 = 最不確定（h 最大）、2 = 最可能是紅、3 = 第 1 湖（FF）最可能是紅、第 2、3 湖最不確定
 * （第 41 回合的推演：第 1 湖 FF 130–160 個決策點湖最可能是紅的人勝率較高，第 2 湖紅方已兩勝 160 個決策點湖最不確定的人較高）。
 */
export function goodLake41RedTwoMode(tuning: Readonly<AgentTuning>, obs?: PlayerObservation): 1 | 2 {
  const m = (tuning.goodLake41 ?? 0) & 3;
  if (m === 3) return (obs?.lakeHistory ?? []).length === 0 ? 2 : 1;
  return m === 2 ? 2 : 1;
}

function h2(p: number): number {
  if (p <= 1e-12 || p >= 1 - 1e-12) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/** 湖中分數的權重：紅方未兩勝而且後面還有湖 = 2；紅方已兩勝或最後一湖 = 0。 */
export function lake41Weight(obs: PlayerObservation): number {
  const st = lake39State(obs);
  return !st.redHasTwo && anotherLakeFollows(obs) ? 2 : 0;
}

/** 一個候選人的湖中分數（紅方已兩勝時照 `mode`）。 */
export function lake41Score(pRed: number, weight: number, redTwoInfo: boolean, mode: 1 | 2): number {
  if (redTwoInfo && mode === 2) return pRed;
  return h2(pRed) + weight * (1 - pRed);
}

/** 第 1 步的人選範圍（依序；'L' = 上過最近一次任務）。 */
export function lake41Prefs(obs: PlayerObservation, bits: number): Array<LakeClass | 'L'> {
  const st = lake39State(obs);
  if (st.lake === 0) {
    switch (st.score) {
      case 'FS': return ['FS', 'S'];
      case 'SS': return ['L'];
      case 'SF': return (bits & 4) ? [] : ['FS', 'N'];
      case 'FF': return ['F', 'N'];
      default: return [];
    }
  }
  if (st.lake === 1) return st.score === 'SFS' || st.score === 'FSS' ? ['L'] : [];
  if (st.lake === 2) {
    const last = st.score[st.score.length - 1];
    return last === 'S' && (st.score === 'SFFS' || st.score === 'FSFS') ? ['L'] : [];
  }
  return [];
}

/** 診斷用：同分一路比到座位序的次數（裁定 (1) 不用座位；應該幾乎是 0）；紅方已兩勝時同分但 P(紅) 不同、沒有用顏色排的次數。 */
export const lake41Diag = { seatTie: 0, picks: 0, colourTieSkipped: 0 };

/** 候選人被別人的提議選進隊伍的次數，和第一次出現在提議紀錄裡的位置（沒出現過 = 很大）。 */
function historyKeys(obs: PlayerObservation, id: string): { picked: number; first: number } {
  let picked = 0;
  let first = Number.MAX_SAFE_INTEGER;
  obs.voteHistory.forEach((v, k) => {
    if (!v.team.includes(id)) return;
    if (v.leader !== id) picked++;
    if (k < first) first = k;
  });
  return { picked, first };
}

export interface Lake41Explain {
  pool: string[];
  scores: Array<{ id: string; pRed: number; score: number }>;
  weight: number;
  redTwoInfo: boolean;
  pick: string;
}

/**
 * `goodLake41` 的湖目標。`candidates` 已經去掉持湖者的避開名單（梅林看得到的紅；沒有別人時呼叫端照原本處理）。不適用時回傳 null。
 */
export function goodLake41Pick(
  tuning: Readonly<AgentTuning>,
  obs: PlayerObservation,
  candidates: readonly string[],
  explain?: (e: Lake41Explain) => void,
): string | null {
  if (!goodLake41On(tuning, obs) || candidates.length === 0) return null;
  const bits = tuning.goodLake41 ?? 0;
  const st = lake39State(obs);
  // 診斷用的位元（只量）：32 = 第 1 湖 FS 照原本；64 = 只用在第 1 湖；128 = 只用在第 2、3 湖。
  if ((bits & 32) && st.lake === 0 && st.score === 'FS') return null;
  if ((bits & 64) && st.lake > 0) return null;
  if ((bits & 128) && st.lake === 0) return null;
  const keep = (xs: Lake39Candidate[], f: (c: Lake39Candidate) => boolean): Lake39Candidate[] => {
    const k = xs.filter(f);
    return k.length > 0 ? k : xs;
  };
  // 第 0 步
  const cert = certainReds(obs);
  let ids = candidates.filter((id) => !cert.has(id));
  if (ids.length === 0) ids = [...candidates];
  if (obs.myRole === 'percival') {
    const rd = percivalRead39(obs);
    if (rd?.unfav && rd.conf >= 0.7 && ids.some((id) => id !== rd.unfav)) ids = ids.filter((id) => id !== rd.unfav);
  }
  // 梅林：公開視角（範圍與排序）；位元 16 = 用自己的後驗排序。
  const merlinPublic = obs.myRole === 'merlin' && (bits & 16) === 0;
  const view: PlayerObservation = merlinPublic
    ? { ...obs, myRole: 'loyal', knownEvils: [], knownWizards: undefined, allEvilIds: undefined, publicLoyalView: true }
    : obs;
  // 自己之前湖的結果留著（忠臣坐在這個座位也知道；照規則湖過的人不能再拿湖，所以持湖時這一項其實一定是空的）。
  let cs = lake39Candidates(view, ids, tuning);
  if (st.lake <= 1) cs = keep(cs, (c) => c.cls !== 'F2');
  // 第 1 步
  for (const k of lake41Prefs(obs, bits)) {
    const sel = cs.filter((c) => (k === 'L' ? c.onLast : c.cls === k));
    if (sel.length > 0) { cs = sel; break; }
  }
  const weight = lake41Weight(obs);
  const redTwoInfo = weight === 0;
  const mode = goodLake41RedTwoMode(tuning, obs);
  // c.pRed 是 `view` 的後驗（梅林照公開視角時就是忠臣的公開視角）。
  const scored = cs.map((c) => ({ c, pRed: c.pRed, score: lake41Score(c.pRed, weight, redTwoInfo, mode), ...historyKeys(obs, c.id) }));
  const best = Math.max(...scored.map((x) => x.score));
  let tied = scored.filter((x) => best - x.score <= 1e-9);
  const narrow = <T>(xs: T[], key: (x: T) => number): T[] => {
    const m = Math.min(...xs.map(key));
    return xs.filter((x) => key(x) - m <= 1e-9);
  };
  if (tied.length > 1 && st.lake === 0 && st.score === 'SS') tied = narrow(tied, (x) => (x.c.ledWent ? 0 : 1));
  // 比較藍的優先只用在權重大於 0 的局面；紅方已兩勝與最後一湖（權重 0、只看資訊）不用顏色當同分的排序
  // （最不確定的做法下 h(p) = h(1−p)，派西兩根拇指常常剛好互補，用 P(紅) 排會把「把湖留在藍方」帶回來）。
  if (tied.length > 1 && redTwoInfo) {
    const ps = tied.map((x) => x.pRed);
    if (Math.max(...ps) - Math.min(...ps) > 1e-9) lake41Diag.colourTieSkipped++;
  }
  if (tied.length > 1 && !redTwoInfo) tied = narrow(tied, (x) => x.pRed);
  if (tied.length > 1) tied = narrow(tied, (x) => -x.picked);
  if (tied.length > 1) tied = narrow(tied, (x) => x.first);
  lake41Diag.picks++;
  if (tied.length > 1) {
    lake41Diag.seatTie++;
    tied = [...tied].sort((a, b) => obs.allPlayerIds.indexOf(a.c.id) - obs.allPlayerIds.indexOf(b.c.id));
  }
  const pick = tied[0].c.id;
  explain?.({ pool: cs.map((c) => c.id), scores: scored.map((x) => ({ id: x.c.id, pRed: x.pRed, score: x.score })), weight, redTwoInfo, pick });
  return pick;
}

// ── 梅林在紅方已兩勝、自己在隊上、隊上有他看得到的紅時（`merlinKeyApprove41`，只量；牽涉 10/30 裁定，專案負責人待裁定）─────────
/**
 * 真人梅林在這一格（第 3–4 局、紅方已兩勝、在隊上、隊上的紅夠讓任務失敗；非強制、不是自己當隊長）贊成 40%（770 票；強者 40%，83 票），
 * 忠臣同一格 65%；機器人梅林幾乎都反對（自我對打約 85% 反對），忠臣照真人變寬時兩者的差被凍結的刺客讀到（第 40 回合）。
 * 這裡讓梅林在「他這個座位的忠臣公開視角會贊成」時，以比例 q 贊成（每一票用座位、局、第幾次提議、提議的隊、提議次數與任務結果算出固定的雜湊，
 * 不用 Math.random，重播與自我對打都一樣，而且不同的局會不一樣）；公開邏輯證明一定會失敗的隊照舊反對（呼叫端的投票關卡）。0 = 關。
 */
export function merlinKeyApprove41Now(tuning: Readonly<AgentTuning>, obs: PlayerObservation): boolean {
  const q = tuning.merlinKeyApprove41 ?? 0;
  if (q <= 0 || obs.gamePhase !== 'team_vote' || obs.myRole !== 'merlin' || (obs.seatTeam ?? obs.myTeam) !== 'good') return false;
  const round = obs.currentRound ?? 1;
  if (round < 3 || round > 4 || (obs.failCount ?? 0) >= 4) return false;
  if ((obs.questResults ?? []).filter((r) => r === 'fail').length < 2) return false;
  if (!(obs.proposedTeam ?? []).includes(obs.myPlayerId) || obs.currentLeader === obs.myPlayerId) return false;
  // 雜湊鍵放進每一局都不一樣的公開狀態（提議的隊、到目前的提議次數、任務結果），不然同一個座位、同一局、同一次提議在每一局都是同一個答案。
  const team = [...(obs.proposedTeam ?? [])].sort().join(',');
  const key = `${obs.myPlayerId}|${round}|${obs.failCount ?? 0}|${team}|${(obs.voteHistory ?? []).length}|${(obs.questResults ?? []).join('')}|key41`;
  let h = 0x811c9dc5;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return (h % 10000) / 10000 < q;
}
