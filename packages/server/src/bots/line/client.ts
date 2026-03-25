import { middleware, Client, WebhookEvent, MessageEvent } from '@line/bot-sdk';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { LINE_CONFIG } from './config';
import {
  createHelpMessage,
  createRulesMessage,
  createRolesMessage,
  createGameStatusMessage,
  createQuickReplyButtons,
} from './messages';

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
        const userMessage = (messageEvent.message as any).text.toLowerCase().trim();

        await this.handleMessage(
          messageEvent.replyToken,
          messageEvent.source.userId,
          userMessage
        );
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('❌ Line Bot Webhook Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Process and respond to messages
   */
  private async handleMessage(
    replyToken: string,
    userId: string,
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
        response = this.createGameResponse();
        break;

      case 'join':
        response = this.joinGameResponse(args[0]);
        break;

      case 'status':
        response = createGameStatusMessage({
          round: 1,
          maxRounds: 5,
          state: 'Voting',
          players: 5,
          goodWins: 0,
          evilWins: 0,
        });
        break;

      case 'vote':
        response = this.createVoteResponse(args[0]);
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
      console.error('❌ Failed to reply to message:', error);
      await this.client.replyMessage(replyToken, [
        {
          type: 'text',
          text: '❌ An error occurred. Please try again later.',
        },
      ]);
    }
  }

  private createGameResponse() {
    const gameId = `line-${Date.now()}`;
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
              text: '🎭 Game Created!',
              weight: 'bold',
              size: 'lg',
            },
            {
              type: 'text',
              text: `Game ID: ${gameId}`,
              size: 'sm',
              color: '#999999',
              margin: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: 'Share this ID with friends to join!',
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

  private joinGameResponse(roomId: string | undefined) {
    if (!roomId) {
      return {
        type: 'text',
        text: '❌ Please provide a room ID. Usage: join <room-id>',
      };
    }

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
              text: '✅ Joined!',
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

  private createVoteResponse(vote: string | undefined) {
    if (!vote || !['approve', 'reject', 'yes', 'no'].includes(vote.toLowerCase())) {
      return {
        type: 'text',
        text: '❌ Invalid vote. Use: vote approve OR vote reject',
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

    const isApprove = ['approve', 'yes'].includes(vote.toLowerCase());
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
              text: `${isApprove ? '✅' : '❌'} Vote Recorded`,
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
              text: 'Waiting for other players to vote...',
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
