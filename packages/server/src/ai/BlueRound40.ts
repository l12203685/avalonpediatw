/**
 * 優化迴圈第 40 回合・藍方（2026-11-11）。
 *
 * 投票門檻分局面、分角色（`vote40*`，預設全部 0 = 用原本的門檻）：第 39 回合把「表決中的提議讀進後驗」（`beliefPendingProposal`）和四個門檻
 * 一起動，對局多約 0.64pp，但在真人決策點，三個藍方角色在「紅方未兩勝的第 3–4 局、自己在隊上」和強者的一致度都下降（內黑變多）。
 * 這裡把門檻拆成局面（紅方未兩勝的第 3–4 局在隊上／不在隊上、紅方已兩勝的第 3–4 局在隊上／不在隊上、第 5 局在隊上／不在隊上、尾家外白）
 * 乘上角色（忠臣、派西、梅林照忠臣投票時的公開視角），每一格在同一批真人決策點分開擬合（先過第 1 關：三個角色、十個座位和強者的一致度
 * 上升或持平），再上對局。紅方座位不受影響（紅方照忠臣投票的視角 `redLoyalView` 在呼叫端就被排除；座位陣營 `seatTeam` 是紅方時不算）。
 */
import type { PlayerObservation } from './types';
import type { AgentTuning } from './AgentTuning';
import { percivalRead39 } from './BlueRound39Percival';
import { missionFailed } from './missionFacts';

export type VoteRole40 = 'L' | 'P' | 'M';

/** 做投票決定的藍方角色：忠臣 L、派西 P、梅林照忠臣投票時的公開視角 M；紅方座位（含紅方推想別人的視角）null。 */
export function voteRole40(obs: PlayerObservation): VoteRole40 | null {
  if (obs.seatTeam === 'evil' || obs.redLoyalView === true) return null;
  if (obs.publicLoyalView === true) return obs.seatTeam === 'good' ? 'M' : null;
  if (obs.myTeam !== 'good') return null;
  if (obs.myRole === 'percival') return 'P';
  if (obs.myRole === 'merlin') return 'M';
  return obs.myRole === 'loyal' ? 'L' : null;
}

export type VoteCell40 = 'On' | 'Off' | 'KeyOn' | 'KeyOff' | 'R5On' | 'R5Off';

/** 這一票所在的格子（第 3 局起）：第 5 局、紅方已兩勝的第 3–4 局、紅方未兩勝的第 3–4 局，各分在隊上／不在隊上。 */
export function voteCell40(obs: PlayerObservation, onTeam: boolean): VoteCell40 {
  const round = obs.currentRound ?? 1;
  const key = (obs.questResults ?? []).filter((r) => r === 'fail').length >= 2;
  const base = round >= 5 ? 'R5' : key ? 'Key' : '';
  return `${base}${onTeam ? 'On' : 'Off'}` as VoteCell40;
}

/** 這一格、這個角色的門檻（開關值）；0 = 沒有設，用原本的門檻。 */
export function vote40Bar(tuning: Readonly<AgentTuning>, obs: PlayerObservation, onTeam: boolean): number {
  const role = voteRole40(obs);
  if (role === null) return 0;
  const k = `vote40${voteCell40(obs, onTeam)}${role}` as keyof AgentTuning;
  const v = tuning[k];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** 尾家外白（第 3–5 局）這個角色的門檻；0 = 沒有設。`role` 由呼叫端給（梅林、派西的尾家外白在 `mpTailWhiteNow` 裡用公開視角算）。 */
export function vote40TailBar(tuning: Readonly<AgentTuning>, obs: PlayerObservation, role: VoteRole40): number {
  if ((obs.currentRound ?? 1) < 3) return 0;
  const v = tuning[`vote40Tail${role}` as keyof AgentTuning];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * 派西在隊上、隊上只有一根拇指（第 3–5 局，位元 1 只在第 3–4 局；`percivalThumbVote40`，lp39 PV-V2／PV-V3）。呼叫端已經處理「公開邏輯證明一定會失敗」（內黑）。
 * 真人：只有比較像梅林的那一根在隊上時內黑 23%（比較不像梅林的那一根當隊長時 37%、比較像梅林的那一根當隊長時 13%），機器人 35%；
 * 只有比較不像梅林的那一根在隊上時內黑 37%，機器人 68%。
 * 回傳 true＝贊成、false＝內黑、null＝照原本的準則。
 */
export function percivalThumbVote40(tuning: Readonly<AgentTuning>, obs: PlayerObservation, team: readonly string[]): boolean | null {
  const mode = tuning.percivalThumbVote40 ?? 0;
  if (mode <= 0 || obs.myRole !== 'percival' || (obs.currentRound ?? 1) < 3 || !team.includes(obs.myPlayerId)) return null;
  const read = percivalRead39(obs);
  if (!read || !read.fav || !read.unfav) return null;
  const favOn = team.includes(read.fav);
  const unfavOn = team.includes(read.unfav);
  if (favOn === unfavOn) return null;
  if (favOn) {
    // 第 5 局照原本的準則（真人在第 5 局內黑 45%；只開位元 1 時第 1 關在第 5 局變差）。
    if ((mode & 1) === 0 || obs.currentLeader === read.unfav || (obs.currentRound ?? 1) >= 5) return null;
    return true;
  }
  if ((mode & 2) === 0) return null;
  const lastS = [...(obs.questHistory ?? [])].filter((q) => !missionFailed(q)).sort((x, y) => y.round - x.round)[0];
  const reuse = !!lastS && lastS.team.length === team.length && lastS.team.every((id) => team.includes(id));
  return !(read.conf >= 0.9 && !reuse);
}
