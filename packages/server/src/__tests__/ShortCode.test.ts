import { describe, it, expect } from 'vitest';
import {
  generateShortCode,
  generateUniqueShortCode,
  normalizeShortCode,
  isValidShortCode,
  SHORT_CODE_LENGTH,
  SHORT_CODE_ALPHABET,
} from '../services/shortCode';

// ---------------------------------------------------------------------------
// shortCode 工具：格式/隨機性/唯一性重試
// ---------------------------------------------------------------------------

describe('shortCode.generateShortCode', () => {
  it('預設 8 字元、僅含合法 alphabet 字符', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShortCode();
      expect(code).toHaveLength(SHORT_CODE_LENGTH);
      for (const ch of code) {
        expect(SHORT_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('不含易混淆字元 0/O/1/I/L', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShortCode();
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('可自訂長度', () => {
    expect(generateShortCode({ length: 4 })).toHaveLength(4);
    expect(generateShortCode({ length: 12 })).toHaveLength(12);
  });

  it('length <= 0 拋錯', () => {
    expect(() => generateShortCode({ length: 0 })).toThrow();
    expect(() => generateShortCode({ length: -1 })).toThrow();
  });

  it('alphabet 空字串拋錯', () => {
    expect(() => generateShortCode({ alphabet: '' })).toThrow();
  });

  it('連續生成結果會有差異（隨機性 smoke test）', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generateShortCode());
    // 100 次生成，重複機率 ≈ 100² / (2 * 32^8) → 預期 100 個都不同
    expect(codes.size).toBeGreaterThan(95);
  });
});

describe('shortCode.normalizeShortCode', () => {
  it('大小寫正規化', () => {
    expect(normalizeShortCode('abcdefgh')).toBe('ABCDEFGH');
    expect(normalizeShortCode('AbCdEfGh')).toBe('ABCDEFGH');
  });

  it('去前後空白與中間空白', () => {
    expect(normalizeShortCode('  7K3M 9P2Q  ')).toBe('7K3M9P2Q');
    expect(normalizeShortCode('7K3M\t9P2Q')).toBe('7K3M9P2Q');
  });

  it('null/undefined 安全處理', () => {
    expect(normalizeShortCode(undefined as unknown as string)).toBe('');
    expect(normalizeShortCode(null as unknown as string)).toBe('');
  });
});

describe('shortCode.isValidShortCode', () => {
  it('合法短碼通過', () => {
    expect(isValidShortCode('7K3M9P2Q')).toBe(true);
    expect(isValidShortCode(generateShortCode())).toBe(true);
  });

  it('長度錯誤不通過', () => {
    expect(isValidShortCode('7K3M9P2')).toBe(false);
    expect(isValidShortCode('7K3M9P2QA')).toBe(false);
    expect(isValidShortCode('')).toBe(false);
  });

  it('含禁用字元不通過', () => {
    expect(isValidShortCode('0K3M9P2Q')).toBe(false);  // 有 0
    expect(isValidShortCode('OK3M9P2Q')).toBe(false);  // 有 O
    expect(isValidShortCode('1K3M9P2Q')).toBe(false);  // 有 1
    expect(isValidShortCode('IK3M9P2Q')).toBe(false);  // 有 I
    expect(isValidShortCode('LK3M9P2Q')).toBe(false);  // 有 L
    expect(isValidShortCode('7k3m9p2q')).toBe(false);  // 小寫
    expect(isValidShortCode('7K3M9P2!')).toBe(false);  // 符號
  });

  it('非字串型別拒絕', () => {
    expect(isValidShortCode(null as unknown as string)).toBe(false);
    expect(isValidShortCode(undefined as unknown as string)).toBe(false);
    expect(isValidShortCode(12345678 as unknown as string)).toBe(false);
  });
});

describe('shortCode.generateUniqueShortCode', () => {
  it('isTaken 永遠回 false → 第一次就成功', async () => {
    let calls = 0;
    const code = await generateUniqueShortCode(async () => {
      calls++;
      return false;
    });
    expect(calls).toBe(1);
    expect(isValidShortCode(code)).toBe(true);
  });

  it('前兩次撞碼 → 第三次回來未撞，成功', async () => {
    let calls = 0;
    const code = await generateUniqueShortCode(async () => {
      calls++;
      return calls <= 2;
    });
    expect(calls).toBe(3);
    expect(isValidShortCode(code)).toBe(true);
  });

  it('超過 maxTries 次均撞碼 → 拋錯', async () => {
    await expect(
      generateUniqueShortCode(async () => true, 3),
    ).rejects.toThrow(/exhausted 3 tries/);
  });

  it('預設 maxTries = 5', async () => {
    let calls = 0;
    await expect(
      generateUniqueShortCode(async () => {
        calls++;
        return true;
      }),
    ).rejects.toThrow();
    expect(calls).toBe(5);
  });
});
