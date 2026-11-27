import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/styleKnights';

describe('styleKnights --include（站長點名替場數不夠的玩家建 AI騎士）', () => {
  it('ID 和 ID=名字 都認得，可重複', () => {
    const a = parseArgs(['--include', '玩家甲', '--include', '玩家乙=小名']);
    expect(a.include).toEqual([{ player: '玩家甲' }, { player: '玩家乙', as: '小名' }]);
  });
  it('預設沒有點名', () => {
    expect(parseArgs([]).include).toEqual([]);
  });
});
