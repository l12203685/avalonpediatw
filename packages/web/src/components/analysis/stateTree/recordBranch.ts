/**
 * 局勢樹的分支 → 牌譜紀錄的篩選（Edward 2026-10-31 局勢樹）：任務順序的開頭 + 路徑上每一次湖的分支鍵。
 * 牌譜紀錄（Discord 牌譜頻道的局）照同樣的規則判斷：第 4 輪兩張失敗才算紅；湖的鍵用 lakeKeys 的 lakeKey，
 * 持湖／被湖陣營從六碼配置查（前四個角色是紅方）。只相依 lakeKeys 與牌譜的型別，牌譜紀錄的程式不會被統計引擎拖大。
 */
import type { RecordGame } from '../../../utils/records';
import { lakeKey, lakeKeyLabel, type LakeMode, type LakeObs } from './lakeKeys';
import type { StateNode } from './stateTree';

export interface RecordBranch {
  /** 任務順序開頭（藍／紅，1–5 字）。 */
  seq: string;
  /** 第 after 輪任務後的湖（2–4）與分支鍵（o、x、-、o+、x!、Bo、Rx…）。 */
  lakes: Array<{ after: number; key: string }>;
}

const KEY_RE = /^(?:[ox-]|[ox][+!]|[BR][ox])$/;

/** 分支鍵是哪種分支方式的鍵。 */
function modeOfKey(key: string): LakeMode {
  if (key.length === 1) return 'claim';
  return key[0] === 'B' || key[0] === 'R' ? 'holder' : 'truth';
}

/** 牌譜的任務順序（一方拿到 3 個任務就停）。 */
export function recordSequence(game: Pick<RecordGame, 'rounds'>): string {
  let seq = '';
  let red = 0;
  for (let i = 0; i < game.rounds.length && i < 5; i += 1) {
    if (red >= 3 || seq.length - red >= 3) break;
    const m = game.rounds[i].mission;
    if (!m) break;
    const isRed = [...m].filter((c) => c === 'x').length >= (i === 3 ? 2 : 1);
    seq += isRed ? '紅' : '藍';
    if (isRed) red += 1;
  }
  return seq;
}

function sideOfSeat(config: string, seat: string): 'B' | 'R' | '' {
  if (!/^[0-9]$/.test(seat)) return '';
  const i = config.indexOf(seat);
  return i >= 0 && i < 4 ? 'R' : 'B';
}

/** 牌譜第 after 輪後的湖 → LakeObs（沒有那一次湖 = null）。 */
export function recordLakeObs(game: Pick<RecordGame, 'config' | 'lakes'>, after: number): LakeObs | null {
  const lake = game.lakes.find((l) => l.after === after);
  if (!lake) return null;
  const claim = lake.claim === 'o' || lake.claim === 'x' ? lake.claim : '';
  return { claim, holder: sideOfSeat(game.config, lake.holder), target: sideOfSeat(game.config, lake.target) };
}

/** 這局牌譜在不在分支裡（讀不出牌譜的貼文不在）。 */
export function recordMatchesBranch(game: RecordGame | null | undefined, branch: RecordBranch): boolean {
  if (!game) return false;
  if (!recordSequence(game).startsWith(branch.seq)) return false;
  return branch.lakes.every(({ after, key }) => lakeKey(recordLakeObs(game, after), modeOfKey(key)) === key);
}

/** 儲存的分支 → 分支（格式不對 = null）。 */
export function sanitizeBranch(raw: unknown): RecordBranch | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== 'string' || !/^[藍紅]{0,5}$/.test(r.seq) || !Array.isArray(r.lakes) || r.lakes.length > 3) return null;
  const lakes: RecordBranch['lakes'] = [];
  for (const l of r.lakes as unknown[]) {
    const x = l as Record<string, unknown>;
    if (!x || typeof x.after !== 'number' || ![2, 3, 4].includes(x.after) || typeof x.key !== 'string' || !KEY_RE.test(x.key)) return null;
    lakes.push({ after: x.after, key: x.key });
  }
  if (!r.seq && !lakes.length) return null;
  return { seq: r.seq, lakes };
}

/** 分支的文字：紅藍 → 湖1 說好 → 紅藍藍。 */
export function branchLabel(branch: RecordBranch): string {
  const parts: string[] = [];
  let shown = 0;
  for (const { after, key } of [...branch.lakes].sort((a, b) => a.after - b.after)) {
    if (branch.seq.length < after) break;
    if (after > shown) parts.push(branch.seq.slice(0, after));
    parts.push(`湖${after - 1} ${lakeKeyLabel(key)}`);
    shown = after;
  }
  if (branch.seq.length > shown || !parts.length) parts.push(branch.seq);
  return parts.join(' → ');
}

/** 局勢樹的節點 → 牌譜紀錄的分支（根、「其他」、陣營不明的湖 = null）。 */
export function branchOfNode(node: Pick<StateNode, 'kind' | 'seq' | 'path'>): RecordBranch | null {
  if (node.kind === 'root' || node.kind === 'other') return null;
  const lakes: RecordBranch['lakes'] = [];
  for (const step of node.path) {
    if (step.kind !== 'lake' || !step.index) continue;
    if (step.key === '?') return null;
    lakes.push({ after: step.index + 1, key: step.key });
  }
  return { seq: node.seq, lakes };
}
