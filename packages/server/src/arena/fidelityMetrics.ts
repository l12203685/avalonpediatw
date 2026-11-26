/**
 * AI騎士 精準度：抽出來的決策點格式與各動作的一致度（純函式；`scripts/knightFidelity.ts`、`scripts/knightFidelityFit.ts` 用）。
 *
 * 座位一律用 1..n（幾家）；`S`／`X` 的欄位照 `residual.ts` 的特徵清單。
 */

/** 一個座位（一位玩家坐過的一局的一個位置）。 */
export interface FidJob {
  /** 局號 */
  g: string;
  /** 座位 1..n */
  s: number;
  /** 玩家編號（入選清單裡的位置） */
  p: number;
  /** 隨機一半：0 擬合、1 測試（同 v1 `halfOf`）。 */
  half: 0 | 1;
  /** 時間切分：0 = 這位玩家較舊的 70%（擬合）、1 = 較新的 30%（測試）。 */
  time: 0 | 1;
  date: string;
}

/** 座位資訊（每個座位一筆）。 */
export interface FidMeta {
  t: 'M';
  j: number;
  role: string;
  /** 派西維爾看到的兩根拇指（其他角色空）。 */
  thumbs: number[];
  merlin: number;
  morgana: number;
  /** 刺客刺的座位（0 = 沒刺）。 */
  killed: number;
  winner: string;
}

interface Base { j: number; r: number; rf: number }

/** 派隊：h／d／k = 真人／百科AI／v1 的隊；S = 每個座位的特徵（`eng` 欄 = v1 的隊）。 */
export interface TeamRec extends Base { t: 'T'; p: number; a: number; h: number[]; d: number[]; k: number[]; S: number[][]; sz: number; pp: number[]; lm: number[] }
/** 投票：1 = 贊成。on = 在隊上；ld = 隊長；tr = 隊上有紅（真相）；to = 隊上有自己以外的紅（真相）。 */
export interface VoteRec extends Base { t: 'V'; p: number; a: number; h: 0 | 1; d: 0 | 1; k: 0 | 1; x: number[]; on: 0 | 1; ld: 0 | 1; tr: 0 | 1; to: 0 | 1; team: number[] }
/** 紅方任務牌：1 = 失敗。seen = 隊上看得到的隊友數。 */
export interface QuestRec extends Base { t: 'Q'; h: 0 | 1; d: 0 | 1; k: 0 | 1; x: number[]; seen: number; sz: number }
/** 湖中對象：c = 合法對象；X = 每個對象的座位特徵；hc = 真人的對象是紅（真相）。 */
export interface LakeRec extends Base { t: 'L'; h: number; d: number; k: number; c: number[]; X: number[][]; hc: 0 | 1 }
/** 湖中宣告：1 = 宣告紅；d／k 為 −1 = 引擎不宣告。te = 對象真的是紅；ally = 對象是看得到的隊友。 */
export interface ClaimRec extends Base { t: 'C'; h: 0 | 1; d: number; k: number; x: number[]; te: 0 | 1; ally: 0 | 1; tg: number }
/** 刺殺：c = 候選；m = 梅林的座位。 */
export interface AssassinRec extends Base { t: 'A'; h: number; d: number; k: number; c: number[]; X: number[][]; m: number }

export type FidRecord = TeamRec | VoteRec | QuestRec | LakeRec | ClaimRec | AssassinRec;
