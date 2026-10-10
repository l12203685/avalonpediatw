/**
 * LINE bot /create and /join (2026-10-09 owner decision: games are played on
 * signage-cloud, not on this server).
 *
 * LINE /commands are off by default (LINE_BOT_COMMANDS_ENABLED=false). These
 * tests flip the flag on to prove that, even when enabled, /create and /join
 * only reply with the play URL and never create or join a room here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@line/bot-sdk';
import { PLAY_PLATFORM_URL } from '@avalon/shared';

import { LineBotClient } from '../bots/line/client';
import { LINE_CONFIG } from '../bots/line/config';
import { RoomManager } from '../game/RoomManager';
import { setSharedRoomManager } from '../game/roomManagerSingleton';

type HandleMessage = (replyToken: string, userId: string | undefined, message: string) => Promise<void>;

describe('LINE bot /create /join → signage-cloud (commands enabled)', () => {
  const originalEnabled = LINE_CONFIG.commandsEnabled;
  let rm: RoomManager;
  let replyMessage: ReturnType<typeof vi.fn>;
  let handleMessage: HandleMessage;

  beforeEach(() => {
    LINE_CONFIG.commandsEnabled = true;
    rm = new RoomManager();
    setSharedRoomManager(rm);
    replyMessage = vi.fn(async () => ({}));
    const bot = new LineBotClient({
      channelAccessToken: 'test-token',
      channelSecret: 'test-secret',
      client: { replyMessage } as unknown as Client,
    });
    // handleMessage is the private /command dispatcher behind the webhook.
    const dispatcher = (bot as unknown as { handleMessage: HandleMessage }).handleMessage;
    handleMessage = dispatcher.bind(bot);
  });

  afterEach(() => {
    LINE_CONFIG.commandsEnabled = originalEnabled;
    rm.destroy();
  });

  it.each(['/create', '/join', '/join 1234'])(
    '%s replies with the play URL and creates no room',
    async (text) => {
      await handleMessage('reply-token', 'U-line-1', text);

      expect(replyMessage).toHaveBeenCalledTimes(1);
      const [token, messages] = replyMessage.mock.calls[0];
      expect(token).toBe('reply-token');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining(PLAY_PLATFORM_URL),
      });
      expect(rm.getRoomCount()).toBe(0);
    },
  );

  it('/join <code> does not add the LINE user to an existing room', async () => {
    rm.createRoom('1234', 'Host', 'web-host');

    await handleMessage('reply-token', 'U-line-1', '/join 1234');

    const room = rm.getRoom('1234');
    expect(room).toBeDefined();
    expect(Object.keys(room!.players)).toEqual(['web-host']);
    expect(replyMessage.mock.calls[0][1][0].text).toContain(PLAY_PLATFORM_URL);
  });
});
