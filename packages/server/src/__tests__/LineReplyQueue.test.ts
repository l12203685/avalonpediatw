import { describe, it, expect } from 'vitest';
import {
  LineReplyQueue,
  LINE_REPLY_QUEUE_CAP,
  LINE_REPLY_MAX_PER_DRAIN,
} from '../bots/line/replyQueue';

function fill(q: LineReplyQueue, n: number, prefix = 'm'): void {
  for (let i = 0; i < n; i++) q.enqueue(`${prefix}${i}`, 1000 + i);
}

describe('LineReplyQueue', () => {
  it('drain pops the oldest first, in order, at most 5', () => {
    const q = new LineReplyQueue();
    fill(q, 8);
    const batch = q.drain();
    expect(batch.map((b) => b.text)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(batch).toHaveLength(LINE_REPLY_MAX_PER_DRAIN);
    expect(q.size()).toBe(3);
  });

  it('drain leaves the rest in the queue and the next drain continues', () => {
    const q = new LineReplyQueue();
    fill(q, 7);
    q.drain();
    expect(q.drain().map((b) => b.text)).toEqual(['m5', 'm6']);
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it('never returns more than 5 even when asked', () => {
    const q = new LineReplyQueue();
    fill(q, 10);
    expect(q.drain(50)).toHaveLength(5);
  });

  it('requeueFront restores the exact pre-drain queue (nothing lost on reply failure)', () => {
    const q = new LineReplyQueue();
    fill(q, 7);
    const before = Array.from({ length: 7 }, (_, i) => `m${i}`);
    const batch = q.drain();
    q.requeueFront(batch);
    const all = [...q.drain(), ...q.drain()].map((b) => b.text);
    expect(all).toEqual(before);
  });

  it('the next drain after a requeue re-sends the same batch', () => {
    const q = new LineReplyQueue();
    fill(q, 6);
    const first = q.drain();
    q.requeueFront(first);
    const second = q.drain();
    expect(second.map((b) => b.text)).toEqual(first.map((b) => b.text));
  });

  it('requeueFront([]) is a no-op', () => {
    const q = new LineReplyQueue();
    fill(q, 2);
    expect(q.requeueFront([])).toEqual({ dropped: 0 });
    expect(q.size()).toBe(2);
  });

  it('enqueue beyond cap drops the OLDEST', () => {
    const q = new LineReplyQueue(3);
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    expect(q.enqueue('d')).toEqual({ dropped: 1 });
    expect(q.drain().map((b) => b.text)).toEqual(['b', 'c', 'd']);
  });

  it('requeueFront beyond cap keeps the rescued batch at the head and trims the NEWEST tail', () => {
    const q = new LineReplyQueue(4);
    fill(q, 4); // m0..m3
    const batch = q.drain(2); // m0, m1 out; m2, m3 remain
    q.enqueue('x'); // m2, m3, x
    q.enqueue('y'); // m2, m3, x, y (full)
    expect(q.requeueFront(batch)).toEqual({ dropped: 2 }); // m0 m1 m2 m3 | x y trimmed
    expect(q.size()).toBe(4);
    expect([...q.drain(), ...q.drain()].map((b) => b.text)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('default cap is 50', () => {
    const q = new LineReplyQueue();
    fill(q, LINE_REPLY_QUEUE_CAP + 5);
    expect(q.size()).toBe(LINE_REPLY_QUEUE_CAP);
  });

  it('oldestAgeMs reports age of the head item and null when empty', () => {
    const q = new LineReplyQueue();
    expect(q.oldestAgeMs(5000)).toBeNull();
    q.enqueue('a', 1000);
    q.enqueue('b', 4000);
    expect(q.oldestAgeMs(5000)).toBe(4000);
  });

  it('rejects a non-positive cap', () => {
    expect(() => new LineReplyQueue(0)).toThrow();
  });
});
