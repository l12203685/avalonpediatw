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
 *
 * Images (2026-10-13, Discord → LINE): an item may carry `image` — the two
 * HTTPS URLs of a LINE image message served from bots/media/relayMedia.ts.
 * Its `text` is then the fallback note sent instead when the copy is gone
 * by drain time. Same queue, same order, same 5-per-reply budget: one image
 * is one message object.
 *
 * Groups (review fix 2026-10-13): the items of one Discord message (its text
 * line, its pictures, the note) are enqueued together (enqueueGroup); when
 * the queue overflows, the oldest message leaves WHOLE, so a picture never
 * stays behind without its speaker line. Every overflow / trim returns the
 * relay ids of the pictures it dropped, so their copies are freed.
 *
 * Long texts (2026-10-13): a relayed text over LINE's 5000 characters is
 * queued as parts (ChatMirror / bots/mirrorSplit.ts) in one group, ahead of
 * that message's pictures. A part is one message object like any other, so
 * a long message may span two replies; order is kept, and a failed reply
 * re-queues its exact batch as before. When requeueFront() has to trim the
 * newest tail, a message cut in two by the trim leaves whole (not a speaker
 * line without its 「（續）」 parts or pictures) — but never an item of the
 * rescued batch.
 */

export const LINE_REPLY_QUEUE_CAP = 50;
/** LINE replyMessage accepts at most 5 message objects per reply_token. */
export const LINE_REPLY_MAX_PER_DRAIN = 5;

/** A queued LINE image message (Discord → LINE). */
export interface QueuedLineImage {
  /** https URL of the full image (JPEG/PNG ≤ 10 MB). */
  originalUrl: string;
  /** https URL of the preview (JPEG/PNG ≤ 1 MB); may equal originalUrl. */
  previewUrl: string;
  /** Relay-store ids behind the two URLs (checked and kept alive at drain time). */
  mediaIds: string[];
  /** Failed replies that carried this image (see degradeAfterFailedReply). */
  failedAttempts?: number;
}

/**
 * One queued LINE message object. Plain text when `image` is absent; with
 * `image`, an image message whose `text` is the fallback note.
 */
export interface QueuedLineText {
  text: string;
  enqueuedAt: number;
  image?: QueuedLineImage;
  /** Items of one message share a group (set by enqueueGroup); dropped together on overflow. */
  group?: number;
}

/** What an enqueue / requeue dropped to stay within the cap. */
export interface QueueTrim {
  dropped: number;
  /** Relay ids of the dropped pictures (to free their copies). */
  releasedMediaIds: string[];
}

/** Alias that reads better where images are involved. */
export type QueuedLineItem = QueuedLineText;

/** After this many failed replies an image goes out as its text note instead. */
export const LINE_IMAGE_MAX_FAILED_REPLIES = 2;

/**
 * Prepare a drained batch for requeueFront() after a failed reply. Text
 * items are returned untouched (the exact-batch invariant). An image item
 * is degraded to its text note when LINE rejected an image URL in this
 * reply, or when it has now failed LINE_IMAGE_MAX_FAILED_REPLIES times — so
 * one unusable image can never block the queue forever. Order is kept.
 */
export function degradeAfterFailedReply(
  batch: QueuedLineItem[],
  opts: { imageRejected?: boolean } = {},
): { retry: QueuedLineItem[]; degraded: number; releasedMediaIds: string[] } {
  let degraded = 0;
  const releasedMediaIds: string[] = [];
  const retry = batch.map((item): QueuedLineItem => {
    if (!item.image) return item;
    const failedAttempts = (item.image.failedAttempts ?? 0) + 1;
    if (opts.imageRejected || failedAttempts >= LINE_IMAGE_MAX_FAILED_REPLIES) {
      degraded += 1;
      releasedMediaIds.push(...item.image.mediaIds);
      return { text: item.text, enqueuedAt: item.enqueuedAt, ...(item.group !== undefined ? { group: item.group } : {}) };
    }
    return { ...item, image: { ...item.image, failedAttempts } };
  });
  return { retry, degraded, releasedMediaIds };
}

export class LineReplyQueue {
  private items: QueuedLineItem[] = [];
  private readonly cap: number;
  private nextGroup = 1;

  constructor(cap: number = LINE_REPLY_QUEUE_CAP) {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new Error('LineReplyQueue cap must be a positive integer');
    }
    this.cap = cap;
  }

  /** Append one text. Returns how many OLDEST items were dropped to stay in cap. */
  public enqueue(text: string, now: number = Date.now()): QueueTrim {
    return this.enqueueItem({ text, enqueuedAt: now });
  }

  /**
   * Append one item (text or image). Returns how many OLDEST items were
   * dropped to stay in cap — a dropped item's whole group goes with it — and
   * the relay ids of the dropped pictures.
   */
  public enqueueItem(item: QueuedLineItem): QueueTrim {
    this.items.push(item);
    return this.trimOldest();
  }

  /**
   * Append the items of ONE message (text line, pictures, note) as a group:
   * on overflow they leave the queue together, never a picture without its
   * text line. Same return as enqueueItem.
   */
  public enqueueGroup(items: QueuedLineItem[]): QueueTrim {
    if (items.length === 0) return { dropped: 0, releasedMediaIds: [] };
    const group = this.nextGroup;
    this.nextGroup += 1;
    for (const item of items) this.items.push({ ...item, group });
    return this.trimOldest();
  }

  /** Drop from the oldest end until within cap; a dropped item takes the rest of its group along. */
  private trimOldest(): QueueTrim {
    let dropped = 0;
    const releasedMediaIds: string[] = [];
    const drop = (item: QueuedLineItem): void => {
      dropped += 1;
      if (item.image) releasedMediaIds.push(...item.image.mediaIds);
    };
    while (this.items.length > this.cap) {
      const head = this.items.shift() as QueuedLineItem;
      drop(head);
      if (head.group === undefined) continue;
      while (this.items.length > 0 && this.items[0].group === head.group) drop(this.items.shift() as QueuedLineItem);
    }
    return { dropped, releasedMediaIds };
  }

  /** Pop up to `max` oldest items, in order. Empty array when nothing queued. */
  public drain(max: number = LINE_REPLY_MAX_PER_DRAIN): QueuedLineItem[] {
    const n = Math.max(0, Math.min(max, LINE_REPLY_MAX_PER_DRAIN, this.items.length));
    if (n === 0) return [];
    const batch = this.items.slice(0, n);
    this.items = this.items.slice(n);
    return batch;
  }

  /**
   * Put a previously drained batch back at the HEAD (send failed). Order is
   * preserved exactly; if that overflows the cap, the NEWEST tail is trimmed
   * — together with the kept front of a message the trim cuts in two, as
   * long as that front is not part of the rescued batch.
   */
  public requeueFront(batch: QueuedLineItem[]): QueueTrim {
    if (batch.length === 0) return { dropped: 0, releasedMediaIds: [] };
    this.items = [...batch, ...this.items];
    let dropped = 0;
    const releasedMediaIds: string[] = [];
    if (this.items.length > this.cap) {
      let keep = this.cap;
      const cutGroup = this.items[keep].group;
      if (cutGroup !== undefined) {
        while (keep > batch.length && this.items[keep - 1].group === cutGroup) keep -= 1;
      }
      const tail = this.items.slice(keep);
      dropped = tail.length;
      for (const item of tail) if (item.image) releasedMediaIds.push(...item.image.mediaIds);
      this.items = this.items.slice(0, keep);
    }
    return { dropped, releasedMediaIds };
  }

  /** How many queued items are images. */
  public imageCount(): number {
    return this.items.filter((i) => !!i.image).length;
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
