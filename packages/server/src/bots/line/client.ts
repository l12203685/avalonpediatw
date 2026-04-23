import { Client, WebhookEvent, MessageEvent, Message } from '@line/bot-sdk';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { LINE_CONFIG } from './config';
import {
  createHelpMessage,
  createRulesMessage,
  createRolesMessage,
  createGameStatusMessage,
  createQuickReplyButtons,
} from './messages';
import { getSharedRoomManager } from '../../game/roomManagerSingleton';
import { getChatMirror } from '../ChatMirror';

/**
 * Map LINE user IDs to the room they're currently in.
 * Enables vote and status commands without requiring a room-id argument.
 */
const userRoomMap = new Map<string, string>();

/**
 * Line Bot Client Setup
 */

export class LineBotClient {
  private client: Client;
  private channelSecret: string;

  constructor() {
    this.channelSecret = LINE_CONFIG.channelSecret;

    this.client = new Client({
      channelAccessToken: LINE_CONFIG.channelAccessToken,
      channelSecret: LINE_CONFIG.channelSecret,
    });
  }

  /**
   * Verify webhook signature
   */
  verifySignature(body: string, signature: string): boolean {
    const hash = crypto
      .createHmac('sha256', this.channelSecret)
      .update(body)
      .digest('base64');

    return hash === signature;
  }

  /**
   * Handle webhook events
   */
  async handleWebhook(req: Request, res: Response): Promise<void> {
    // Verify signature
    const signature = req.get('X-Line-Signature');
    if (!signature || !this.verifySignature(JSON.stringify(req.body), signature)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    try {
      const events: WebhookEvent[] = req.body.events;

      for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') {
          continue;
        }

        const messageEvent = event as MessageEvent;
        const textMessage = messageEvent.message as { id: string; text: string };
        const rawText = textMessage.text;

        // #82 three-way sync: group messages from the configured lobby-mirror
        // group are bridged into the lobby ring buffer (→ web clients) and
        // cross-pushed to Discord. Process bridge first so even `/command`
        // looking text still lands in the mirror. We then fall through to the
        // command handler only for 1:1 DMs (messageEvent.source.type==='user'),
        // which is where commands actually make sense.
        const source = messageEvent.source;
        if (source.type === 'group') {
          await this.handleGroupMessage(source.groupId, source.userId, rawText, textMessage.id);
          continue;
        }

        const userMessage = rawText.toLowerCase().trim();
        await this.handleMessage(
          messageEvent.replyToken,
          source.userId,
          userMessage
        );
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Line Bot Webhook Error:', error);
      res.status(500).json({ error: 'Internal server error' });
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

    const mirror = getChatMirror();
    if (!mirror) {
      console.warn('[LINE→lobby] ChatMirror not initialised yet, dropping message');
      return;
    }

    // Fetch the speaker's LINE display name so the lobby shows a real name.
    // Falls back to a generic label on failure — do not let profile fetch
    // errors drop the message on the floor.
    let displayName = '';
    if (userId) {
      try {
        const profile = await this.client.getGroupMemberProfile(groupId, userId);
        displayName = profile?.displayName ?? '';
      } catch (err) {
        console.warn(
          `[LINE→lobby] getGroupMemberProfile failed for ${userId?.slice(-6)}:`,
          err
        );
      }
    }

    const ingested = mirror.ingestInbound({
      source: 'line',
      platformUserId: userId ?? 'unknown',
      displayName,
      text,
      messageId: `line:${messageId}`,
    });

    if (ingested) {
      // Cross-push to Discord (lobby-ingest callback handles web clients).
      mirror.crossFanout(ingested).catch((err) => {
        console.warn('[LINE→Discord] crossFanout rejected:', err);
      });
    }
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
    // Silent for non-command chatter. Log for debugging but do not reply.
    if (!message.startsWith('/')) {
      console.log('[LINE DEBUG] ignored non-command message:', message);
      return;
    }

    // Feature-flag gate: /command handling disabled by default. Log and exit
    // without replying so LINE users do not see half-finished responses.
    if (!LINE_CONFIG.commandsEnabled) {
      console.log('[LINE] command received but disabled:', message);
      return;
    }

    let response;

    // Strip leading '/' then parse command
    const [command, ...args] = message.slice(1).split(/\s+/);

    switch (command) {
      case 'help':
        response = createHelpMessage();
        break;

      case 'create':
        response = this.createGameResponse(userId);
        break;

      case 'join':
        response = this.joinGameResponse(userId, args[0]);
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
      console.error('Failed to reply to LINE message:', error);
      await this.client.replyMessage(replyToken, [
        {
          type: 'text',
          text: '發生錯誤,請稍後再試。',
        },
      ]);
    }
  }

  /**
   * Create a new game room via RoomManager.
   */
  private createGameResponse(userId: string | undefined) {
    const roomManager = getSharedRoomManager();

    const roomId = uuidv4();
    const hostId = `line:${userId ?? 'unknown'}`;
    const hostName = 'LINE Player';

    const room = roomManager.createRoom(roomId, hostName, hostId);

    if (userId) {
      userRoomMap.set(userId, roomId);
    }

    const baseUrl = process.env.WEB_BASE_URL || 'http://localhost:3000';
    const joinUrl = `${baseUrl}/game/${roomId}`;

    return {
      type: 'flex',
      altText: '遊戲已建立',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '遊戲已建立!',
              weight: 'bold',
              size: 'lg',
            },
            {
              type: 'text',
              text: `房間代碼:${roomId}`,
              size: 'sm',
              color: '#999999',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: '把房間代碼分享給朋友,或用下方連結從網頁加入。',
              size: 'sm',
              wrap: true,
              margin: 'md',
            },
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: {
                type: 'uri',
                label: '開啟遊戲',
                uri: joinUrl,
              },
            },
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'message',
                label: '狀態',
                text: 'status',
              },
            },
          ],
          flex: 0,
        },
      },
    };
  }

  /**
   * Join an existing room via RoomManager.
   */
  private joinGameResponse(userId: string | undefined, roomId: string | undefined) {
    if (!roomId) {
      return {
        type: 'text',
        text: '請提供房間代碼。用法:join <房間代碼>',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      return {
        type: 'text',
        text: `找不到房間「${roomId}」。請確認代碼後再試。`,
      };
    }

    if (room.state !== 'lobby') {
      return {
        type: 'text',
        text: '這場遊戲已經開始。只能加入仍在大廳的房間。',
      };
    }

    const playerId = `line:${userId ?? 'unknown'}`;

    if (room.players[playerId]) {
      return {
        type: 'text',
        text: '你已經在這個房間裡了。',
      };
    }

    if (Object.keys(room.players).length >= room.maxPlayers) {
      return {
        type: 'text',
        text: '這個房間已滿。',
      };
    }

    // Add player
    room.players[playerId] = {
      id: playerId,
      name: 'LINE Player',
      role: null,
      team: null,
      status: 'active',
      createdAt: Date.now(),
    };
    room.updatedAt = Date.now();

    if (userId) {
      userRoomMap.set(userId, roomId);
    }

    const playerCount = Object.keys(room.players).length;

    return {
      type: 'flex',
      altText: '已加入遊戲',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '已加入!',
              weight: 'bold',
              size: 'lg',
              color: '#00b300',
            },
            {
              type: 'text',
              text: `房間代碼:${roomId}`,
              size: 'sm',
              color: '#999999',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: `玩家:${playerCount} / ${room.maxPlayers}`,
              size: 'sm',
              margin: 'md',
            },
            {
              type: 'text',
              text: '等待房主開始遊戲...',
              size: 'sm',
              wrap: true,
              margin: 'md',
            },
          ],
        },
      },
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
      'LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET is not set in environment variables'
    );
  }

  lineBotInstance = new LineBotClient();
  return lineBotInstance;
}

export function getLineBot(): LineBotClient | null {
  return lineBotInstance;
}
