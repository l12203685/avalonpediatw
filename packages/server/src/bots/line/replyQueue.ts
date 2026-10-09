/**
 * LineReplyQueue — bounded FIFO of outbound LINE texts that are delivered on
 * the *next inbound reply_token* instead of via the push API.
 *
 * Why (2026-04-24 Edward 指令 / 2026-10-08 修回):
 *   LINE Official Account 免費方案每月只有固定額度的 push 訊息；大廳與 Discord
 *   的每一句話都 push 的話，額度幾天就燒完，之後 LINE 端就「無聲地壞掉」。
 *   reply_token 回覆不算 push 額度，所以把要送去 LINE 群的訊息先排隊，等群裡
 *   任何人講話（webhook 送來 reply_token）時一次最多帶 5 則回覆出去。
 *   這是原本 edward-listen-bot 的 drain 設計搬進 server 內部，Render 上沒有
 *   listen-bot 也能免配額同步。
 *
 * Invariants (from the 2026-09-07 listen-bot post-mortem):
 *   - drain() pops the OLDEST first and preserves order.
 *   - A failed reply MUST call requeueFront() with the exact drained batch so
 *     nothing is lost; the next reply_token re-drains the same messages.
 *   - Capacity is bounded; overflow trims from the OLDEST end on enqueue, but
 *     requeueFront() keeps the rescued batch at the head and trims the newest
 *     tail instead (rescued messages are older and must go out first).
 */

export const LINE_REPLY_QUEUE_CAP = 50;
/** LINE replyMessage accepts at most 5 message objects per reply_token. */
export const LINE_REPLY_MAX_PER_DRAIN = 5;

export interface QueuedLineText {
  text: string;
  enqueuedAt: number;
}

export class LineReplyQueue {
  private items: QueuedLineText[] = [];
  private readonly cap: number;

  constructor(cap: number = LINE_REPLY_QUEUE_CAP) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error('LineReplyQueue cap must be a positive integer');
    }
    this.cap = cap;
  }

  /** Append one text. Returns how many OLDEST items were dropped to stay in cap. */
  public enqueue(text: string, now: number = Date.now()): { dropped: number } {
    this.items.push({ text, enqueuedAt: now });
    let dropped = 0;
    if (this.items.length > this.cap) {
      dropped = this.items.length - this.cap;
      this.items = this.items.slice(dropped);
    }
    return { dropped };
  }

  /** Pop up to `max` oldest items, in order. Empty array when nothing queued. */
  public drain(max: number = LINE_REPLY_MAX_PER_DRAIN): QueuedLineText[] {
    const n = Math.max(0, Math.min(max, LINE_REPLY_MAX_PER_DRAIN, this.items.length));
    if (n === 0) return [];
    const batch = this.items.slice(0, n);
    this.items = this.items.slice(n);
    return batch;
  }

  /**
   * Put a previously drained batch back at the HEAD (send failed). Order is
   * preserved exactly; if that overflows the cap, the NEWEST tail is trimmed.
   */
  public requeueFront(batch: QueuedLineText[]): { dropped: number } {
    if (batch.length === 0) return { dropped: 0 };
    this.items = [...batch, ...this.items];
    let dropped = 0;
    if (this.items.length > this.cap) {
      dropped = this.items.length - this.cap;
      this.items = this.items.slice(0, this.cap);
    }
    return { dropped };
  }

  public size(): number {
    return this.items.length;
  }

  /** Age in ms of the oldest queued item, or null when empty. */
  public oldestAgeMs(now: number = Date.now()): number | null {
    if (this.items.length === 0) return null;
    return now - this.items[0].enqueuedAt;
  }

  public clear(): void {
    this.items = [];
  }
}
