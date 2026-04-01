import { Client, WebhookEvent, MessageEvent } from '@line/bot-sdk';
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
        const userMessage = (messageEvent.message as { text: string }).text.toLowerCase().trim();

        await this.handleMessage(
          messageEvent.replyToken,
          messageEvent.source.userId,
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
   * Process and respond to messages
   */
  private async handleMessage(
    replyToken: string,
    userId: string | undefined,
    message: string
  ): Promise<void> {
    let response;

    // Parse command
    const [command, ...args] = message.split(/\s+/);

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
          text: `Unknown command: "${command}". Type "help" to see available commands.`,
          quickReply: {
            items: [
              {
                type: 'action',
                action: {
                  type: 'message',
                  label: 'Help',
                  text: 'help',
                },
              },
            ],
          },
        };
    }

    try {
      await this.client.replyMessage(replyToken, [response]);
    } catch (error) {
      console.error('Failed to reply to LINE message:', error);
      await this.client.replyMessage(replyToken, [
        {
          type: 'text',
          text: 'An error occurred. Please try again later.',
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
      altText: 'Game Created',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: 'Game Created!',
              weight: 'bold',
              size: 'lg',
            },
            {
              type: 'text',
              text: `Room ID: ${roomId}`,
              size: 'sm',
              color: '#999999',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: 'Share the Room ID with friends, or use the link below to join via web.',
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
                label: 'Open Game',
                uri: joinUrl,
              },
            },
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'message',
                label: 'Status',
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
        text: 'Please provide a room ID. Usage: join <room-id>',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      return {
        type: 'text',
        text: `Room "${roomId}" not found. Check the ID and try again.`,
      };
    }

    if (room.state !== 'lobby') {
      return {
        type: 'text',
        text: 'This game is already in progress. You can only join rooms in the lobby.',
      };
    }

    const playerId = `line:${userId ?? 'unknown'}`;

    if (room.players[playerId]) {
      return {
        type: 'text',
        text: 'You are already in this room.',
      };
    }

    if (Object.keys(room.players).length >= room.maxPlayers) {
      return {
        type: 'text',
        text: 'This room is full.',
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
      altText: 'Game Joined',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: 'Joined!',
              weight: 'bold',
              size: 'lg',
              color: '#00b300',
            },
            {
              type: 'text',
              text: `Room ID: ${roomId}`,
              size: 'sm',
              color: '#999999',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: `Players: ${playerCount} / ${room.maxPlayers}`,
              size: 'sm',
              margin: 'md',
            },
            {
              type: 'text',
              text: 'Waiting for the host to start the game...',
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
        text: 'You are not in any game. Use "create" or "join <room-id>" first.',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      if (userId) userRoomMap.delete(userId);
      return {
        type: 'text',
        text: 'Your game room no longer exists.',
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
        text: 'Invalid vote. Use: vote approve OR vote reject',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'message',
                label: 'Approve',
                text: 'vote approve',
              },
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: 'Reject',
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
        text: 'You are not in any game. Use "join <room-id>" first.',
      };
    }

    const roomManager = getSharedRoomManager();
    const room = roomManager.getRoom(roomId);

    if (!room) {
      if (userId) userRoomMap.delete(userId);
      return {
        type: 'text',
        text: 'Your game room no longer exists.',
      };
    }

    if (room.state !== 'voting') {
      return {
        type: 'text',
        text: `Cannot vote right now. Current game state: ${room.state}`,
      };
    }

    const playerId = `line:${userId ?? 'unknown'}`;

    if (!room.players[playerId]) {
      return {
        type: 'text',
        text: 'You are not a player in this game.',
      };
    }

    const isApprove = ['approve', 'yes'].includes(vote.toLowerCase());
    room.votes[playerId] = isApprove;
    room.updatedAt = Date.now();

    const votedCount = Object.keys(room.votes).length;
    const totalPlayers = Object.keys(room.players).length;

    return {
      type: 'flex',
      altText: 'Vote Recorded',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `${isApprove ? 'Approved' : 'Rejected'} - Vote Recorded`,
              weight: 'bold',
              size: 'lg',
              color: isApprove ? '#00b300' : '#ff0000',
            },
            {
              type: 'text',
              text: `You voted to ${isApprove ? 'APPROVE' : 'REJECT'} the team.`,
              size: 'sm',
              wrap: true,
              margin: 'md',
            },
            {
              type: 'text',
              text: `Votes: ${votedCount} / ${totalPlayers}`,
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
