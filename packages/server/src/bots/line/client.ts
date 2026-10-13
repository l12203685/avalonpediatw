import { Client, WebhookEvent, MessageEvent, Message, EventMessage } from '@line/bot-sdk';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { PLAY_PLATFORM_URL } from '@avalon/shared';
import { LINE_CONFIG } from './config';
import { LINE_REPLY_MAX_PER_DRAIN } from './replyQueue';
import type { RequestWithRawBody } from '../../middleware/rawBody';
import {
  createHelpMessage,
  createRulesMessage,
  createRolesMessage,
  createGameStatusMessage,
  createQuickReplyButtons,
} from './messages';
import { getSharedRoomManager } from '../../game/roomManagerSingleton';
import {
  ChatMirror,
  getChatMirror,
  imageCountMarker,
  lineImageLabel,
  LineImageFetch,
  LineImageRelayOutcome,
  MIRROR_MEDIA_TEXT,
} from '../ChatMirror';
import type { LobbyChatMessage } from '../../socket/LobbyChatBuffer';
import { describeError, raceTimeout, readStreamCapped } from '../media/bytes';
import { answerStatsTextCommand } from '../stats/textCommands';
import { answerFeedbackTextCommand, getFeedbackService } from '../feedback/service';

/**
 * Map LINE user IDs to the room they're currently in.
 * Enables vote and status commands without requiring a room-id argument.
 */
const userRoomMap = new Map<string, string>();

/**
 * How many handled message-event ids are remembered for redelivery dedupe
 * (see isDuplicateDelivery). Only events this process acts on are recorded
 * (the mirror group, 1:1 texts), ids only — a few hundred KB at most.
 */
const LINE_SEEN_EVENT_IDS_MAX = 2000;

/** LINE → Discord pictures waiting for download/upload; more are skipped (counted). */
export const LINE_MEDIA_MAX_PENDING = 20;
/**
 * LINE → Discord picture timeouts (review fix 2026-10-13). The bot-sdk sets
 * no request timeout, and the picture jobs run one at a time, so without
 * these one hung download would hold every later picture until a restart.
 *   download — the LINE content API call plus reading its stream;
 *   job      — download + Discord upload (or note), a backstop;
 *   textWait — how long a LINE text / short note waits for the pictures
 *              posted before it, so Discord keeps the LINE order.
 */
export const LINE_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
export const LINE_MEDIA_JOB_TIMEOUT_MS = 60_000;
export const LINE_TEXT_WAIT_FOR_PICTURES_MS = 20_000;
/** How long an image set's admit decision is remembered (its images arrive within seconds). */
const LINE_IMAGE_SET_TTL_MS = 10 * 60 * 1000;
const LINE_IMAGE_SETS_MAX = 200;

/** Discord-bound text for LINE message types that are not relayed as content (2026-10-13). */
const LINE_MEDIA_NOTE: Partial<Record<EventMessage['type'], string>> = {
  sticker: MIRROR_MEDIA_TEXT.sticker,
  video: MIRROR_MEDIA_TEXT.lineVideo,
  audio: MIRROR_MEDIA_TEXT.lineAudio,
  file: MIRROR_MEDIA_TEXT.lineFile,
  location: MIRROR_MEDIA_TEXT.lineLocation,
};

/**
 * True when a failed reply was LINE refusing an image URL of ours (400 whose
 * details name originalContentUrl / previewImageUrl). Reads only the
 * property names LINE reports, never the request.
 */
export function lineErrorMentionsImage(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    statusCode?: unknown;
    status?: unknown;
    body?: unknown;
    originalError?: { response?: { data?: unknown } };
  };
  const status = typeof e.statusCode === 'number' ? e.statusCode : e.status;
  if (status !== 400) return false;
  let data: unknown = e.originalError?.response?.data ?? e.body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return false;
    }
  }
  const details = (data as { details?: unknown } | null)?.details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (d) => typeof (d as { property?: unknown })?.property === 'string' &&
      /originalContentUrl|previewImageUrl/.test((d as { property: string }).property),
  );
}

/**
 * Line Bot Client Setup
 */

export interface LineBotClientOptions {
  channelAccessToken?: string;
  channelSecret?: string;
  /** Inject a pre-built SDK client (tests). */
  client?: Client;
  /** Override the LINE → Discord picture timeouts (tests). */
  mediaTimeouts?: { downloadMs?: number; jobMs?: number; textWaitMs?: number };
}

/** Counters surfaced on /api/bots/status — the "對帳單" for the LINE leg. */
export interface LineWebhookStats {
  requests: number;
  signatureFailures: number;
  events: number;
  mirrorGroupEvents: number;
  repliesDrained: number;
  replyFailures: number;
  /** Stats command answers sent (/戰績 /排行 /默契 /指令). */
  statsReplies: number;
  /** /意見 acknowledgements sent (2026-10-12, bots/feedback). */
  feedbackReplies: number;
  /** 2026-10-13 media sync — counts only. LINE pictures uploaded to Discord. */
  imagesToDiscord: number;
  /** LINE pictures sent to Discord as a text note (too large, download or upload failed, too many waiting, or CHAT_MIRROR_IMAGES=false). */
  imageNotesToDiscord: number;
  /** LINE pictures not relayed (rate limit or too many waiting). */
  imagesSkipped: number;
  /** LINE pictures that reached Discord neither as a file nor as a note (no channel, post failed, timed out). */
  imageFailures: number;
  /** Stickers / video / audio / file / location relayed as a short text. */
  mediaNotesToDiscord: number;
  /** Discord pictures delivered to LINE as image messages. */
  imagesToLine: number;
  /** Discord pictures delivered to LINE as a text note (relay copy gone). */
  imageNotesToLine: number;
  lastEventAt: number | null;
}

/**
 * A bot answer that takes the first slot of a reply_token (stats card or
 * /意見 acknowledgement); `kind` picks the counter it is booked under.
 */
interface LeadReply {
  kind: 'stats' | 'feedback';
  text: string;
}

export class LineBotClient {
  private client: Client;
  private channelSecret: string;
  private stats: LineWebhookStats = {
    requests: 0,
    signatureFailures: 0,
    events: 0,
    mirrorGroupEvents: 0,
    repliesDrained: 0,
    replyFailures: 0,
    statsReplies: 0,
    feedbackReplies: 0,
    imagesToDiscord: 0,
    imageNotesToDiscord: 0,
    imagesSkipped: 0,
    imageFailures: 0,
    mediaNotesToDiscord: 0,
    imagesToLine: 0,
    imageNotesToLine: 0,
    lastEventAt: null,
  };
  /** Non-mirror group ids already logged (each is logged once per process). */
  private seenOtherGroups = new Set<string>();
  /** Ids of message events this process handled, newest last (LINE redelivery dedupe). */
  private seenEventIds = new Set<string>();
  /** LINE → Discord picture jobs run one at a time (memory, order). */
  private mediaChain: Promise<void> = Promise.resolve();
  private mediaPending = 0;
  /** Latest LINE text / note that waits for earlier pictures (settleMediaRelays). */
  private textAfterPictures: Promise<void> = Promise.resolve();
  /** LINE texts / notes between their arrival and their hand-off to Discord (pictures arriving later wait for them). */
  private textsInFlight: Promise<void> = Promise.resolve();
  private readonly mediaTimeouts: { downloadMs: number; jobMs: number; textWaitMs: number };
  /** Image-set id → whether the set was admitted (one lobby marker + rate-limit hit per set). */
  private imageSets = new Map<string, { admitted: boolean; at: number }>();

  constructor(opts: LineBotClientOptions = {}) {
    const channelAccessToken = opts.channelAccessToken ?? LINE_CONFIG.channelAccessToken;
    this.channelSecret = opts.channelSecret ?? LINE_CONFIG.channelSecret;
    this.mediaTimeouts = {
      downloadMs: opts.mediaTimeouts?.downloadMs ?? LINE_MEDIA_DOWNLOAD_TIMEOUT_MS,
      jobMs: opts.mediaTimeouts?.jobMs ?? LINE_MEDIA_JOB_TIMEOUT_MS,
      textWaitMs: opts.mediaTimeouts?.textWaitMs ?? LINE_TEXT_WAIT_FOR_PICTURES_MS,
    };

    this.client =
      opts.client ??
      new Client({
        channelAccessToken,
        channelSecret: this.channelSecret,
      });
  }

  /**
   * Verify webhook signature over the exact bytes LINE sent (constant-time).
   */
  verifySignature(body: string | Buffer, signature: string): boolean {
    const expected = crypto
      .createHmac('sha256', this.channelSecret)
      .update(body)
      .digest();
    const given = Buffer.from(signature, 'base64');
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  /**
   * Handle webhook events
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    this.stats.requests += 1;

    // Prefer the raw bytes kept by middleware/rawBody.ts; re-serialising the
    // parsed body is only a fallback for callers that did not keep them.
    const signature = req.get('X-Line-Signature');
    const raw = (req as RequestWithRawBody).rawBody;
    const signedBody: string | Buffer = raw ?? JSON.stringify(req.body ?? {});
    if (!signature || !this.verifySignature(signedBody, signature)) {
      this.stats.signatureFailures += 1;
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const events: WebhookEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];

      for (const event of events) {
        this.stats.events += 1;
        this.stats.lastEventAt = Date.now();

        const source = event.source;
        const rawReplyToken = (event as { replyToken?: unknown }).replyToken;
        const replyToken = typeof rawReplyToken === 'string' ? rawReplyToken : undefined;
        // LINE re-sends an event when our answer was not a prompt 200 (webhook
        // redelivery is ON, docs/LINE_DISCORD_SYNC.md). When THIS process
        // already handled it, nothing is counted, mirrored or forwarded a
        // second time; the bot still answers because the first reply may
        // never have gone out. An event first seen as a redelivery (the
        // original timed out before reaching us, e.g. a Render cold start)
        // is handled normally.
        // Only events this process acts on are remembered (the mirror group, 1:1
        // texts): other groups' pictures and stickers must not push them out.
        const tracked =
          (source.type === 'group' && this.isMirrorGroup(source.groupId)) ||
          (source.type === 'user' && event.type === 'message' && event.message.type === 'text');
        const duplicate = tracked && this.isDuplicateDelivery(event);

        // #82 three-way sync: anything from the configured lobby-mirror group
        // is bridge traffic. Text lands in the lobby ring buffer (→ web
        // clients) and is cross-pushed to Discord; and EVERY event from that
        // group that carries a reply_token is a free chance to flush the
        // outbound LINE queue (reply does not count against push quota).
        if (source.type === 'group' && this.isMirrorGroup(source.groupId)) {
          this.stats.mirrorGroupEvents += 1;
          let lead: LeadReply | null = null;
          if (event.type === 'message' && event.message.type === 'text') {
            const textMessage = event.message as { id: string; text: string };
            // A stats / 意見 command is still mirrored like any other text;
            // its answer goes back to LINE only, sharing this reply_token.
            if (!duplicate) {
              await this.handleGroupMessage(source.groupId, source.userId, textMessage.text, textMessage.id);
            }
            lead = await this.leadReplyFor(textMessage.text, duplicate);
          } else if (event.type === 'message' && !duplicate) {
            // 2026-10-13: pictures → Discord as files; stickers / video /
            // audio / file / location → a short text. Never text content.
            await this.handleGroupMedia(source.groupId, source.userId, event.message);
          }
          if (replyToken) {
            await this.drainQueuedReplies(replyToken, lead);
          }
          continue;
        }

        if (source.type === 'group') {
          this.noteNonMirrorGroup(source.groupId);
        }

        if (event.type !== 'message' || event.message.type !== 'text') {
          continue;
        }

        // Commands only make sense in 1:1 DMs (source.type === 'user').
        const messageEvent = event as MessageEvent;
        const textMessage = messageEvent.message as { id: string; text: string };

        // Stats and /意見 commands answer in 1:1 chats regardless of the
        // legacy LINE_BOT_COMMANDS_ENABLED gate. Matched on the raw text:
        // player names are case-sensitive (Sin / SIN / sin are different people).
        if (source.type === 'user') {
          const lead = await this.leadReplyFor(textMessage.text, duplicate);
          if (lead !== null) {
            await this.replyLead(messageEvent.replyToken, lead);
            continue;
          }
        }

        const userMessage = textMessage.text.toLowerCase().trim();
        await this.handleMessage(
          messageEvent.replyToken,
          source.userId,
          userMessage
        );
      }

      res.status(200).json({ success: true });
    } catch (error) {
      // Code only: an SDK error can embed the request body (chat text).
      console.error(`Line Bot Webhook Error (${describeError(error)})`);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /** The LINE group that mirrors the lobby, or '' when the mirror is disabled. */
  private mirrorGroupId(): string {
    return (process.env.LOBBY_MIRROR_LINE_GROUP_ID || '').trim();
  }

  private isMirrorGroup(groupId: string | undefined): boolean {
    const target = this.mirrorGroupId();
    return !!target && !!groupId && target === groupId;
  }

  /**
   * True when `event` is a LINE redelivery (`deliveryContext.isRedelivery`)
   * of a message (text, picture, sticker…) this process already handled. Keyed on
   * `webhookEventId` (same across redeliveries — LINE's documented dedupe
   * key), falling back to the message id. Bounded: the oldest ids are
   * forgotten past LINE_SEEN_EVENT_IDS_MAX. Only ids are kept — no text.
   */
  private isDuplicateDelivery(event: WebhookEvent): boolean {
    if (event.type !== 'message') return false;
    const meta = event as { webhookEventId?: unknown; deliveryContext?: { isRedelivery?: unknown } };
    const id =
      typeof meta.webhookEventId === 'string' && meta.webhookEventId
        ? `e:${meta.webhookEventId}`
        : `m:${event.message.id}`;
    const redelivery = meta.deliveryContext?.isRedelivery === true;
    const seen = this.seenEventIds.has(id);
    if (!seen) {
      this.seenEventIds.add(id);
      if (this.seenEventIds.size > LINE_SEEN_EVENT_IDS_MAX) {
        const oldest = this.seenEventIds.values().next().value;
        if (oldest !== undefined) this.seenEventIds.delete(oldest);
      }
    }
    return redelivery && seen;
  }

  getWebhookStats(): LineWebhookStats {
    return { ...this.stats };
  }

  /**
   * Log each group id the bot hears from that is NOT the mirror group, once.
   * The only practical way to learn a LINE group id is from a webhook event,
   * so this is how the operator finds the value for LOBBY_MIRROR_LINE_GROUP_ID
   * (Render → Logs). Server logs only — never on the public status endpoint.
   */
  private noteNonMirrorGroup(groupId: string | undefined): void {
    if (!groupId || this.seenOtherGroups.has(groupId) || this.seenOtherGroups.size >= 50) return;
    this.seenOtherGroups.add(groupId);
    console.log(
      `[LINE] event from group ${groupId} (not the lobby mirror group). ` +
        `To mirror this group set LOBBY_MIRROR_LINE_GROUP_ID=${groupId}`,
    );
  }

  /**
   * Flush up to 5 queued outbound texts using this event's reply_token
   * (free — not push quota). A failed reply puts the exact batch back at the
   * head of the queue so the next reply_token re-sends it; nothing is lost
   * (2026-09-07 listen-bot post-mortem §3-1: the old drain dropped the batch).
   *
   * One reply_token = ONE replyMessage call with at most 5 message objects.
   * When the event was a stats command (2026-10-10) or /意見 (2026-10-12),
   * its answer takes the first slot and only the remaining slots drain the
   * mirror queue; the answer itself is never queued (on failure only the
   * drained mirror messages are put back).
   */
  private async drainQueuedReplies(replyToken: string, leadReply: LeadReply | null = null): Promise<void> {
    const mirror = getChatMirror();
    const queue = mirror && mirror.isLineReplyQueueEnabled() ? mirror : null;
    const lead: Message[] = leadReply ? [{ type: 'text', text: leadReply.text }] : [];
    const batch = queue ? queue.drainLineReplies(LINE_REPLY_MAX_PER_DRAIN - lead.length) : [];
    if (lead.length === 0 && batch.length === 0) return;
    // Queued Discord pictures become image messages while their relay copy
    // is live, else their text note (ChatMirror.lineMessagesFor).
    const out = queue ? queue.lineMessagesFor(batch) : { messages: [], images: 0, fallbacks: 0 };
    try {
      await this.client.replyMessage(replyToken, [...lead, ...(out.messages as Message[])]);
      this.stats.repliesDrained += batch.length;
      this.stats.imagesToLine += out.images;
      this.stats.imageNotesToLine += out.fallbacks;
      if (leadReply) this.countLead(leadReply.kind);
    } catch (error) {
      this.stats.replyFailures += 1;
      const imageRejected = out.images > 0 && lineErrorMentionsImage(error);
      if (queue) queue.requeueLineReplies(batch, { imageRejected });
      // The SDK error embeds the request body (chat text, image URLs): code only.
      console.error(
        `[LINE reply-drain] replyMessage failed (${describeError(error)}), re-queued ${batch.length}` +
          (imageRejected ? ' (image URL rejected — those go as a text note)' : ''),
      );
    }
  }

  /** Stats answer for a typed command, or null (not a command / flag off). Never throws. */
  private async statsAnswerFor(text: string): Promise<string | null> {
    if (!LINE_CONFIG.statsCommandsEnabled) return null;
    try {
      return await answerStatsTextCommand(text, 'line');
    } catch (error) {
      console.error(`[LINE stats] building answer failed (${describeError(error)})`);
      return null;
    }
  }

  /**
   * /意見 acknowledgement (or usage hint), or null (not the command / flag
   * off). Never throws. On a redelivery the text is answered but not counted
   * or forwarded again.
   */
  private async feedbackAnswerFor(text: string, redelivery: boolean): Promise<string | null> {
    try {
      return await answerFeedbackTextCommand(text, 'line', { redelivery });
    } catch (error) {
      console.error(`[LINE feedback] handling /意見 failed (${describeError(error)})`);
      return null;
    }
  }

  /** The bot answer a text earns, if any: stats commands first, then /意見. */
  private async leadReplyFor(text: string, redelivery = false): Promise<LeadReply | null> {
    const stats = await this.statsAnswerFor(text);
    if (stats !== null) return { kind: 'stats', text: stats };
    const feedback = await this.feedbackAnswerFor(text, redelivery);
    if (feedback !== null) return { kind: 'feedback', text: feedback };
    return null;
  }

  private countLead(kind: LeadReply['kind']): void {
    if (kind === 'stats') this.stats.statsReplies += 1;
    else this.stats.feedbackReplies += 1;
  }

  /** 1:1 chat reply (no mirror queue there). Failures are logged, never thrown. */
  private async replyLead(replyToken: string, lead: LeadReply): Promise<void> {
    try {
      await this.client.replyMessage(replyToken, [{ type: 'text', text: lead.text }]);
      this.countLead(lead.kind);
    } catch (error) {
      this.stats.replyFailures += 1;
      console.error(`[LINE ${lead.kind}] replyMessage failed (${describeError(error)})`);
    }
  }

  /**
   * #82 — Forward a LINE group message into ChatMirror so it lands in the
   * Avalon lobby chat and gets cross-posted to the Discord channel.
   *
   * Skipped silently when:
   *   - The group id doesn't match `LOBBY_MIRROR_LINE_GROUP_ID` (another
   *     group the bot happens to live in).
   *   - The mirror singleton hasn't been initialised yet (startup race).
   *   - ChatMirror returns null (rate limited / invalid body).
   *
   * Failures are logged but never propagated — LINE webhook must always
   * ack 200 so the LINE platform does not disable our endpoint.
   */
  private async handleGroupMessage(
    groupId: string,
    userId: string | undefined,
    text: string,
    messageId: string
  ): Promise<void> {
    const targetGroup = process.env.LOBBY_MIRROR_LINE_GROUP_ID?.trim();
    if (!targetGroup || targetGroup !== groupId) {
      return;
    }
    // The pictures posted before this text, as of its arrival (before the name lookup).
    const after = this.picturesSoFar();
    const end = this.textInFlight();
    let handedOff = false;
    try {
      // 2026-10-12 community feedback: reduce the text to topic counts
      // (numbers only, see bots/feedback) before anything else can drop it.
      getFeedbackService().observe('line', text);

      const mirror = getChatMirror();
      if (!mirror) {
        console.warn('[LINE→lobby] ChatMirror not initialised yet, dropping message');
        return;
      }

      const displayName = await this.displayNameFor(groupId, userId);

      const ingested = mirror.ingestInbound({
        source: 'line',
        platformUserId: userId ?? 'unknown',
        displayName,
        text,
        messageId: `line:${messageId}`,
      });

      if (ingested) {
        // Cross-push to Discord (lobby-ingest callback handles web clients),
        // after any picture posted before it.
        this.fanoutAfterPictures(mirror, ingested, after, end);
        handedOff = true;
      }
    } finally {
      if (!handedOff) end();
    }
  }

  /**
   * Mark a LINE text / note as on its way to Discord, from its arrival until
   * it is handed to Discord (or dropped): a picture that arrives meanwhile
   * waits for it (at most textWaitMs), so Discord keeps the LINE order in
   * both directions even when this text's name lookup is the slow one.
   * Returns the function that ends the mark; it must always be called.
   */
  private textInFlight(): () => void {
    let end: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.textsInFlight = Promise.all([this.textsInFlight, done]).then(() => undefined);
    return end;
  }

  /**
   * The picture jobs queued so far, or null when none is pending. Taken when
   * an event ARRIVES (before its display-name lookup), so a text waits for
   * exactly the pictures posted before it — not for one posted after it whose
   * lookup happened to return first (review fix 2026-10-13).
   */
  private picturesSoFar(): Promise<void> | null {
    return this.mediaPending > 0 ? this.mediaChain : null;
  }

  /**
   * crossFanout a LINE text / short note to Discord. When pictures posted
   * before it (`after`, taken at its arrival) are still being relayed, it
   * waits for them (at most textWaitMs) so Discord shows them in the LINE
   * order; otherwise it goes at once, exactly as before. Never throws.
   */
  private fanoutAfterPictures(
    mirror: ChatMirror,
    msg: LobbyChatMessage,
    after: Promise<void> | null,
    end: () => void = () => undefined,
  ): void {
    const send = (): Promise<void> =>
      mirror
        .crossFanout(msg)
        .catch((err) => {
          console.warn(`[LINE→Discord] crossFanout rejected (${describeError(err)})`);
        })
        .finally(end);
    if (!after) {
      void send();
      return;
    }
    const sent = raceTimeout(after, this.mediaTimeouts.textWaitMs, () => undefined).then(send, send);
    this.textAfterPictures = Promise.all([this.textAfterPictures, sent]).then(() => undefined);
  }

  /**
   * The speaker's LINE display name so the lobby / Discord show a real name.
   * Falls back to '' on failure — a profile error must not drop the message.
   */
  private async displayNameFor(groupId: string, userId: string | undefined): Promise<string> {
    if (!userId) return '';
    try {
      const profile = await this.client.getGroupMemberProfile(groupId, userId);
      return profile?.displayName ?? '';
    } catch (err) {
      console.warn(`[LINE→lobby] getGroupMemberProfile failed (${describeError(err)})`);
      return '';
    }
  }

  /**
   * 2026-10-13 — a non-text message in the mirror group.
   *
   *   image    → the lobby gets 「（圖片）」 (one 「（圖片 ×N）」 per image set);
   *              the picture itself is downloaded from LINE's content API
   *              (free, channel access token) and uploaded to the Discord
   *              sync channel with the usual prefix + 「（圖片）」/「（圖片 2/3）」.
   *              Too large for Discord / not downloadable → a text note.
   *   sticker / video / audio / file / location
   *            → a short text (「（貼圖）」, 「（影片，請到 LINE 看）」…) to the
   *              lobby and Discord, exactly like a text message.
   *
   * Rate limit: marker-only lines have their own per-user limit (ChatMirror
   * kind 'media'), so stickers and pictures never use up the text limit; an
   * image set counts once. Downloads run one at a time in the background so
   * the webhook still answers LINE promptly; a picture takes its place in that
   * line when its event arrives (before the name lookup), so Discord keeps
   * the LINE order. Too many waiting, or CHAT_MIRROR_IMAGES=false → a text
   * note instead of the file (once per image set). Never throws.
   */
  private async handleGroupMedia(
    groupId: string,
    userId: string | undefined,
    message: EventMessage
  ): Promise<void> {
    if (message.type === 'text') return;
    const mirror = getChatMirror();
    if (!mirror) return;

    const platformUserId = userId ?? 'unknown';
    const messageId = `line:${message.id}`;

    if (message.type !== 'image') {
      const note = LINE_MEDIA_NOTE[message.type];
      if (!note) return;
      const after = this.picturesSoFar();
      const end = this.textInFlight();
      let handedOff = false;
      try {
        const displayName = await this.displayNameFor(groupId, userId);
        const ingested = mirror.ingestInbound({ source: 'line', platformUserId, displayName, text: note, messageId, kind: 'media' });
        if (!ingested) return;
        this.stats.mediaNotesToDiscord += 1;
        this.fanoutAfterPictures(mirror, ingested, after, end);
        handedOff = true;
      } finally {
        if (!handedOff) end();
      }
      return;
    }

    const set = message.imageSet ?? null;
    const copy = mirror.lineImagesToDiscordEnabled();
    // Place in the picture line taken now, before the (slow) name lookup.
    const after = this.picturesSoFar();
    const slot = copy ? this.reserveMediaSlot() : null;
    // Not copied → a note instead, kept in order like a text.
    const end = slot ? null : this.textInFlight();
    let used = false;
    try {
      const displayName = await this.displayNameFor(groupId, userId);
      const admit = this.admitImage(mirror, { platformUserId, displayName, messageId, set });
      if (!admit.admitted) {
        this.stats.imagesSkipped += 1;
        return;
      }
      const relayed: LobbyChatMessage = {
        id: messageId,
        playerId: `line:${platformUserId}`,
        playerName: displayName.trim() || 'line-user',
        message: lineImageLabel(set),
        timestamp: Date.now(),
        source: 'line',
      };
      if (!slot) {
        // Not copied (turned off, or too many waiting): Discord still learns there was a picture.
        if (copy) this.stats.imagesSkipped += 1;
        if (admit.firstOfSet) {
          const note = copy ? MIRROR_MEDIA_TEXT.lineImageFailed : MIRROR_MEDIA_TEXT.lineImageOff;
          this.stats.imageNotesToDiscord += 1;
          this.fanoutAfterPictures(mirror, { ...relayed, message: note }, after, end ?? undefined);
          used = true;
        }
        return;
      }
      const fromLine = message.contentProvider?.type !== 'external';
      const fetchImage = (maxBytes: number): Promise<LineImageFetch> =>
        fromLine ? this.downloadContent(message.id, maxBytes) : Promise.resolve({ ok: false, reason: 'failed' });
      slot.run(() => mirror.postLineImageToDiscord(relayed, fetchImage));
      used = true;
    } finally {
      if (slot && !used) slot.cancel();
      if (end && !used) end();
    }
  }

  /**
   * Lobby marker + rate limit for a picture. A picture of an image set
   * reuses the decision of the first one seen, so a set of 6 is one lobby
   * line 「（圖片 ×6）」 and one rate-limit hit. `firstOfSet`: a single
   * picture, or the first one seen of its set.
   */
  private admitImage(
    mirror: ChatMirror,
    p: {
      platformUserId: string;
      displayName: string;
      messageId: string;
      set: { id: string; index?: number; total?: number } | null;
    }
  ): { admitted: boolean; firstOfSet: boolean } {
    const setId = p.set?.id;
    const now = Date.now();
    if (setId) {
      for (const [id, v] of this.imageSets) {
        if (now - v.at > LINE_IMAGE_SET_TTL_MS || this.imageSets.size > LINE_IMAGE_SETS_MAX) this.imageSets.delete(id);
        else break;
      }
      const known = this.imageSets.get(setId);
      if (known) return { admitted: known.admitted, firstOfSet: false };
    }
    const marker = setId && p.set?.total ? imageCountMarker(p.set.total) : MIRROR_MEDIA_TEXT.image;
    const ingested = mirror.ingestInbound({
      source: 'line',
      platformUserId: p.platformUserId,
      displayName: p.displayName,
      text: marker,
      messageId: p.messageId,
      kind: 'media',
    });
    if (setId) this.imageSets.set(setId, { admitted: !!ingested, at: now });
    return { admitted: !!ingested, firstOfSet: true };
  }

  /**
   * LINE content API → bytes, stopping past `maxBytes`. Gives up after
   * downloadMs (the SDK has no timeout; a hung stream is destroyed). Never throws.
   */
  private async downloadContent(lineMessageId: string, maxBytes: number): Promise<LineImageFetch> {
    let timedOut = false;
    let stream: { destroy?: (err?: Error) => void } | null = null;
    const work = (async (): Promise<LineImageFetch> => {
      const s = await this.client.getMessageContent(lineMessageId);
      stream = s;
      if (timedOut) {
        s.destroy();
        return { ok: false, reason: 'failed' };
      }
      const read = await readStreamCapped(s, maxBytes);
      return read.ok ? read : { ok: false, reason: 'too-large' };
    })().catch((err: unknown): LineImageFetch => {
      if (!timedOut) console.warn(`[LINE→Discord] picture download failed (${describeError(err)})`);
      return { ok: false, reason: 'failed' };
    });
    return raceTimeout(work, this.mediaTimeouts.downloadMs, (): LineImageFetch => {
      timedOut = true;
      try {
        (stream as { destroy?: (err?: Error) => void } | null)?.destroy?.();
      } catch {
        /* already closed */
      }
      console.warn('[LINE→Discord] picture download timed out');
      return { ok: false, reason: 'failed' };
    });
  }

  /**
   * Take the next place in the picture line (jobs run one at a time); null
   * when too many are waiting. The caller then either `run`s its job there or
   * `cancel`s the place (not admitted). Each place is bounded by jobMs from
   * the moment it is reached — waiting for its job included — so neither a
   * hung upload nor a hung name lookup can hold the chain; the outcome is
   * then 'timeout' and a job handed in later never starts.
   */
  private reserveMediaSlot(): { run: (job: () => Promise<LineImageRelayOutcome>) => void; cancel: () => void } | null {
    if (this.mediaPending >= LINE_MEDIA_MAX_PENDING) return null;
    this.mediaPending += 1;
    // Texts that arrived before this picture and are not on Discord yet go first.
    const textsBefore = this.textsInFlight;
    let hand: (job: (() => Promise<LineImageRelayOutcome>) | null) => void = () => undefined;
    const handed = new Promise<(() => Promise<LineImageRelayOutcome>) | null>((resolve) => {
      hand = resolve;
    });
    let expired = false;
    const place = async (): Promise<LineImageRelayOutcome | null> => {
      await raceTimeout(textsBefore, this.mediaTimeouts.textWaitMs, () => undefined);
      const job = await handed;
      if (!job || expired) return null;
      return job().catch((err: unknown): LineImageRelayOutcome => {
        console.warn(`[LINE→Discord] picture relay failed (${describeError(err)})`);
        return 'failed';
      });
    };
    this.mediaChain = this.mediaChain
      .then(() =>
        raceTimeout(place(), this.mediaTimeouts.jobMs, (): LineImageRelayOutcome => {
          expired = true;
          return 'timeout';
        }),
      )
      .then((outcome) => {
        if (outcome) this.countImageOutcome(outcome);
      })
      .catch(() => undefined) // the chain itself must never reject (later jobs / texts wait on it)
      .finally(() => {
        this.mediaPending -= 1;
      });
    return { run: (job) => hand(job), cancel: () => hand(null) };
  }

  private countImageOutcome(outcome: LineImageRelayOutcome): void {
    if (outcome === 'uploaded') this.stats.imagesToDiscord += 1;
    else if (outcome === 'too-large' || outcome === 'download-failed' || outcome === 'upload-failed') {
      this.stats.imageNotesToDiscord += 1;
    } else {
      this.stats.imageFailures += 1; // no-channel / disabled / failed / timeout
    }
    if (outcome !== 'uploaded') console.log(`[LINE→Discord] picture outcome=${outcome}`);
  }

  /** Resolves when every picture job and waiting text scheduled so far has finished (tests, shutdown). */
  async settleMediaRelays(): Promise<void> {
    await this.mediaChain;
    await this.textAfterPictures;
  }

  /**
   * Process and respond to messages
   *
   * Only messages starting with the command prefix `/` are handled; all other
   * chatter (normal group conversation) is silently ignored so the bot does
   * not interrupt the group with "Unknown command" replies.
   *
   * When LINE_CONFIG.commandsEnabled is false (the default as of 2026-04-23),
   * /command messages are logged but NOT replied to. The webhook continues to
   * ack 200 so the LINE console still marks the endpoint as active, and the
   * command-handling code below is intentionally left intact behind the flag
   * so it can be flipped back on once the features are production-ready.
   */
  private async handleMessage(
    replyToken: string,
    userId: string | undefined,
    message: string
  ): Promise<void> {
    // Silent for non-command chatter (never logged: it is private chat text).
    if (!message.startsWith('/')) {
      return; // 1:1 chatter is not answered (and its text is never logged)
    }

    // Feature-flag gate: /command handling disabled by default. Log and exit
    // without replying so LINE users do not see half-finished responses.
    if (!LINE_CONFIG.commandsEnabled) {
      console.log('[LINE] /command received but LINE_BOT_COMMANDS_ENABLED is off');
      return;
    }

    let response;

    // Strip leading '/' then parse command
    const [command, ...args] = message.slice(1).split(/\s+/);

    switch (command) {
      case 'help':
        response = createHelpMessage();
        break;

      // 2026-10-09: games are played on signage-cloud — no rooms are
      // created or joined on this server any more.
      case 'create':
      case 'join':
        response = this.playPlatformResponse();
        break;

      case 'status':
        response = this.statusResponse(userId);
        break;

      case 'vote':
        response = this.createVoteResponse(userId, args[0]);
        break;

      case 'rules':
        response = createRulesMessage();
        break;

      case 'roles':
        response = createRolesMessage();
        break;

      default:
        response = {
          type: 'text',
          text: `未知指令:「/${command}」。輸入「/help」查看可用指令。`,
          quickReply: {
            items: [
              {
                type: 'action',
                action: {
                  type: 'message',
                  label: '說明',
                  text: '/help',
                },
              },
            ],
          },
        };
    }

    try {
      // LINE's Message union uses narrow literal types (`type: "flex"` etc),
      // but `response` is built from object literals with `type: string`.
      // Cast via Message[] so the SDK receives a correctly-shaped payload.
      await this.client.replyMessage(replyToken, [response as Message]);
    } catch (error) {
      console.error(`Failed to reply to LINE message (${describeError(error)})`);
      await this.client.replyMessage(replyToken, [
        {
          type: 'text',
          text: '發生錯誤,請稍後再試。',
        },
      ]);
    }
  }

  /**
   * create / join reply (2026-10-09 owner decision): games are played on
   * signage-cloud, so point there instead of creating / joining a room on
   * this server.
   */
  private playPlatformResponse() {
    return {
      type: 'text',
      text: `對局已改到 signage-cloud 進行，本站不再開房。\n前往 signage-cloud 開局：${PLAY_PLATFORM_URL}`,
    };
  }

  /**
   * Return current game status for the user's room.
   */
  private statusResponse(userId: string | undefined) {
    const roomId = userId ? userRoomMap.get(userId) : undefined;

    if (!roomId) {
      return {
        type: 'text',
        text: '你還沒加入任何遊戲。請先使用「create」或「join <房間代碼>」。',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      if (userId) userRoomMap.delete(userId);
      return {
        type: 'text',
        text: '你的遊戲房間已不存在。',
      };
    }

    const playerCount = Object.keys(room.players).length;
    const goodWins = room.questResults.filter((r) => r === 'success').length;
    const evilWins = room.questResults.filter((r) => r === 'fail').length;

    return createGameStatusMessage({
      round: room.currentRound,
      maxRounds: room.maxRounds,
      state: room.state,
      players: playerCount,
      goodWins,
      evilWins,
    });
  }

  /**
   * Submit a vote via RoomManager.
   */
  private createVoteResponse(userId: string | undefined, vote: string | undefined) {
    if (!vote || !['approve', 'reject', 'yes', 'no'].includes(vote.toLowerCase())) {
      return {
        type: 'text',
        text: '投票無效。請用:vote approve 或 vote reject',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'message',
                label: '贊成',
                text: 'vote approve',
              },
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: '反對',
                text: 'vote reject',
              },
            },
          ],
        },
      };
    }

    const roomId = userId ? userRoomMap.get(userId) : undefined;

    if (!roomId) {
      return {
        type: 'text',
        text: '你還沒加入任何遊戲。請先使用「join <房間代碼>」。',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      if (userId) userRoomMap.delete(userId);
      return {
        type: 'text',
        text: '你的遊戲房間已不存在。',
      };
    }

    if (room.state !== 'voting') {
      return {
        type: 'text',
        text: `現在無法投票。目前遊戲階段:${room.state}`,
      };
    }

    const playerId = `line:${userId ?? 'unknown'}`;

    if (!room.players[playerId]) {
      return {
        type: 'text',
        text: '你不是這場遊戲的玩家。',
      };
    }

    const isApprove = ['approve', 'yes'].includes(vote.toLowerCase());
    room.votes[playerId] = isApprove;
    room.updatedAt = Date.now();

    const votedCount = Object.keys(room.votes).length;
    const totalPlayers = Object.keys(room.players).length;

    return {
      type: 'flex',
      altText: '投票已送出',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `${isApprove ? '已贊成' : '已反對'} - 投票已送出`,
              weight: 'bold',
              size: 'lg',
              color: isApprove ? '#00b300' : '#ff0000',
            },
            {
              type: 'text',
              text: `你投了${isApprove ? '贊成' : '反對'}票。`,
              size: 'sm',
              wrap: true,
              margin: 'md',
            },
            {
              type: 'text',
              text: `投票進度:${votedCount} / ${totalPlayers}`,
              size: 'xs',
              color: '#999999',
              margin: 'md',
            },
          ],
        },
      },
    };
  }

  getClient(): Client {
    return this.client;
  }
}

// Singleton instance
let lineBotInstance: LineBotClient | null = null;

export function initializeLineBot(): LineBotClient {
  if (lineBotInstance) {
    return lineBotInstance;
  }

  if (!LINE_CONFIG.channelAccessToken || !LINE_CONFIG.channelSecret) {
    throw new Error(
      'LINE_BOT_CHANNEL_ACCESS_TOKEN / LINE_BOT_CHANNEL_SECRET (or legacy LINE_CHANNEL_*) not set in environment variables'
    );
  }

  lineBotInstance = new LineBotClient();
  return lineBotInstance;
}

export function getLineBot(): LineBotClient | null {
  return lineBotInstance;
}
