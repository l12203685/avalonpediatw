/**
 * 局勢樹湖分支的鍵與文字（沒有任何相依：牌譜紀錄的篩選也用，不把統計引擎拉進牌譜紀錄的程式）。
 */
/** 湖的分支方式：不分、只看宣告、宣告 × 是否屬實、持湖陣營 × 宣告。 */
export type LakeMode = 'none' | 'claim' | 'truth' | 'holder';

/** 一次湖：宣告（o = 說好、x = 說壞、'' = 沒記錄）、持湖與被湖的陣營（'' = 查不到）。 */
export interface LakeObs {
  claim: 'o' | 'x' | '';
  holder: 'B' | 'R' | '';
  target: 'B' | 'R' | '';
}

/** 湖分支的鍵：宣告 o / x、屬實 + / 不實 !、持湖 B / R；'-' = 沒記錄；'?' = 有宣告但查不到陣營。 */
export type LakeKey = string;

/** 一次湖在某種分支方式下的鍵。 */
export function lakeKey(obs: LakeObs | null, mode: LakeMode): LakeKey {
  if (!obs || !obs.claim) return '-';
  if (mode === 'claim') return obs.claim;
  if (mode === 'truth') {
    if (!obs.target) return '?';
    const truthful = (obs.claim === 'o') === (obs.target === 'B');
    return `${obs.claim}${truthful ? '+' : '!'}`;
  }
  if (mode === 'holder') return obs.holder ? `${obs.holder}${obs.claim}` : '?';
  return '-';
}

const CLAIM_TEXT: Record<string, string> = { o: '說好', x: '說壞' };

/** 湖分支的文字。 */
export function lakeKeyLabel(key: LakeKey): string {
  if (key === '-') return '未記錄';
  if (key === '?') return '陣營不明';
  if (key.length === 1) return CLAIM_TEXT[key] ?? key;
  if (key[0] === 'B' || key[0] === 'R') return `${key[0] === 'B' ? '藍' : '紅'}持湖${CLAIM_TEXT[key[1]] ?? key[1]}`;
  return `${CLAIM_TEXT[key[0]] ?? key[0]}・${key[1] === '+' ? '屬實' : '不實'}`;
}
