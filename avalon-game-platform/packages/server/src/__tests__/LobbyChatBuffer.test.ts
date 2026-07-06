import { describe, it, expect, beforeEach } from 'vitest';
import {
  LobbyChatBuffer,
  LOBBY_CHAT_MAX,
  LOBBY_CHAT_MAX_LEN,
  LobbyChatMessage,
} from '../socket/LobbyChatBuffer';

function makeMsg(id: string, overrides: Partial<LobbyChatMessage> = {}): LobbyChatMessage {
  return {
    id,
    playerId: 'user-1',
    playerName: 'Alice',
    message: `hello ${id}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('LobbyChatBuffer', () => {
  let buf: LobbyChatBuffer;

  beforeEach(() => {
    buf = new LobbyChatBuffer(3); // tiny ring for tests
  });

  describe('append', () => {
    it('stores a single message', () => {
      buf.append(makeMsg('m1'));
      expect(buf.size()).toBe(1);
      expect(buf.snapshot()[0].id).toBe('m1');
    });

    it('drops the oldest message once capacity is exceeded', () => {
      buf.append(makeMsg('m1'));
      buf.append(makeMsg('m2'));
      buf.append(makeMsg('m3'));
      buf.append(makeMsg('m4'));
      const ids = buf.snapshot().map(m => m.id);
      expect(ids).toEqual(['m2', 'm3', 'm4']);
      expect(buf.size()).toBe(3);
    });

    it('preserves insertion order', () => {
      const ids = ['a', 'b', 'c'];
      ids.forEach(id => buf.append(makeMsg(id)));
      expect(buf.snapshot().map(m => m.id)).toEqual(ids);
    });
  });

  describe('snapshot', () => {
    it('returns a copy (caller cannot mutate internal ring)', () => {
      buf.append(makeMsg('m1'));
      const snap = buf.snapshot();
      snap.push(makeMsg('rogue'));
      expect(buf.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('empties the buffer', () => {
      buf.append(makeMsg('m1'));
      buf.append(makeMsg('m2'));
      buf.clear();
      expect(buf.size()).toBe(0);
      expect(buf.snapshot()).toEqual([]);
    });
  });

  describe('constructor', () => {
    it('rejects non-positive capacities', () => {
      expect(() => new LobbyChatBuffer(0)).toThrow();
      expect(() => new LobbyChatBuffer(-1)).toThrow();
    });

    it('defaults to LOBBY_CHAT_MAX', () => {
      const b = new LobbyChatBuffer();
      for (let i = 0; i < LOBBY_CHAT_MAX + 5; i++) {
        b.append(makeMsg(`m${i}`));
      }
      expect(b.size()).toBe(LOBBY_CHAT_MAX);
      // Oldest 5 were dropped.
      expect(b.snapshot()[0].id).toBe(`m5`);
    });
  });

  describe('validateBody', () => {
    it('trims and accepts normal messages', () => {
      expect(LobbyChatBuffer.validateBody('  hello  ')).toBe('hello');
    });

    it('rejects empty / whitespace-only', () => {
      expect(LobbyChatBuffer.validateBody('')).toBeNull();
      expect(LobbyChatBuffer.validateBody('   ')).toBeNull();
    });

    it('rejects non-string input', () => {
      expect(LobbyChatBuffer.validateBody(null)).toBeNull();
      expect(LobbyChatBuffer.validateBody(undefined)).toBeNull();
      expect(LobbyChatBuffer.validateBody(42)).toBeNull();
      expect(LobbyChatBuffer.validateBody({})).toBeNull();
    });

    it('rejects messages over the max length', () => {
      const ok = 'x'.repeat(LOBBY_CHAT_MAX_LEN);
      const tooBig = 'x'.repeat(LOBBY_CHAT_MAX_LEN + 1);
      expect(LobbyChatBuffer.validateBody(ok)).toBe(ok);
      expect(LobbyChatBuffer.validateBody(tooBig)).toBeNull();
    });
  });
});
