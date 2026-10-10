import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  CommandInteraction,
  ChatInputCommandInteraction,
  ActivityType,
  Message,
} from 'discord.js';
import { DISCORD_CONFIG, COMMANDS, PLAY_PLATFORM_COMMANDS } from './config';
import {
  handleHelpCommand,
  handleRulesCommand,
  handleRolesCommand,
  handlePlayPlatformCommand,
} from './commands';
import { getChatMirror } from '../ChatMirror';

/**
 * Discord Bot Client Setup
 */

export class DiscordBotClient {
  private client: Client;
  private isReady: boolean = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Ready event
    this.client.on('ready', () => {
      console.log('✅ Discord Bot is ready!');
      this.isReady = true;
      this.rotateStatus();
      setInterval(() => this.rotateStatus(), 60000); // Rotate every 60s
    });

    // Command interaction
    this.client.on('interactionCreate', (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.handleCommand(interaction);
    });

    // #82 three-way sync: channel messages in the configured mirror channel
    // are bridged into the Avalon lobby (→ web clients) and cross-posted to
    // LINE. Loops are prevented by skipping our own bot messages, any other
    // bot, and the text prefix that identifies messages we just sent out.
    this.client.on('messageCreate', async (message) => {
      try {
        await this.handleIncomingMirrorMessage(message);
      } catch (err) {
        console.warn('[Discord→lobby] messageCreate handler threw:', err);
      }
    });

    // Error handling
    this.client.on('error', (error) => {
      console.error('❌ Discord Bot Error:', error);
    });

    this.client.on('warn', (warn) => {
      console.warn('⚠️ Discord Bot Warning:', warn);
    });
  }

  /**
   * #82 — Forward a Discord channel message into ChatMirror so it lands in
   * the Avalon lobby chat and gets cross-posted to the LINE group.
   *
   * Early returns (silent):
   *   - `LOBBY_MIRROR_DISCORD_CHANNEL_ID` unset or mismatched.
   *   - Author is a bot (ourselves, the role-reveal DM, another bot).
   *   - Message content is empty (attachment-only / embed-only — future work).
   *   - Message text starts with the outbound `[Avalon]` tag — guards against
   *     Discord re-delivering our own fanout payload in pathological cases
   *     (edits / pinned messages) even though bot-author check should cover it.
   */
  private async handleIncomingMirrorMessage(message: Message): Promise<void> {
    const targetChannel = process.env.LOBBY_MIRROR_DISCORD_CHANNEL_ID?.trim();
    if (!targetChannel || message.channelId !== targetChannel) {
      return;
    }

    if (message.author.bot) return;
    const content = message.content?.trim();
    if (!content) return;
    if (content.startsWith('[Avalon]')) return;

    const mirror = getChatMirror();
    if (!mirror) {
      console.warn('[Discord→lobby] ChatMirror not initialised yet, dropping message');
      return;
    }

    // Prefer guild nickname for recognisability; fall back to global username.
    const displayName =
      (message.member?.displayName ?? '').trim() ||
      message.author.globalName ||
      message.author.username ||
      '';

    const ingested = mirror.ingestInbound({
      source: 'discord',
      platformUserId: message.author.id,
      displayName,
      text: content,
      messageId: `discord:${message.id}`,
    });

    if (ingested) {
      // Cross-push to LINE (lobby-ingest callback handles web clients).
      mirror.crossFanout(ingested).catch((err) => {
        console.warn('[Discord→LINE] crossFanout rejected:', err);
      });
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const commandName = interaction.commandName;

    try {
      switch (commandName) {
        case COMMANDS.HELP:
          await handleHelpCommand(interaction);
          break;

        // 2026-10-09: games are played on signage-cloud — the game-flow
        // commands only reply with the play URL (see PLAY_PLATFORM_COMMANDS).
        case COMMANDS.CREATE:
        case COMMANDS.JOIN:
        case COMMANDS.START:
        case COMMANDS.END:
        case COMMANDS.STATUS:
        case COMMANDS.VOTE:
        case COMMANDS.QUEST:
        case COMMANDS.ASSASSINATE:
          await handlePlayPlatformCommand(interaction);
          break;

        case COMMANDS.RULES:
          await handleRulesCommand(interaction);
          break;

        case COMMANDS.ROLES:
          await handleRolesCommand(interaction);
          break;

        default: {
          const msg = '❌ Unknown command!';
          if (interaction.deferred) {
            await interaction.editReply(msg);
          } else if (!interaction.replied) {
            await interaction.reply(msg);
          }
        }
      }
    } catch (error) {
      console.error(`Error handling command ${commandName}:`, error);
      // Safe fallback that works whether the handler deferred, replied, or neither
      const errMsg = '❌ An error occurred while executing the command.';
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply(errMsg);
        } else if (!interaction.replied) {
          await interaction.reply({ content: errMsg, ephemeral: true });
        } else {
          await interaction.followUp({ content: errMsg, ephemeral: true });
        }
      } catch (followErr) {
        console.error(`Error sending failure message for ${commandName}:`, followErr);
      }
    }
  }

  private rotateStatus(): void {
    if (!this.isReady) return;

    const statuses = DISCORD_CONFIG.statuses;
    const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];

    // discord.js v14 uses a numeric enum for ActivityType; config stores the
    // string form. Map name → enum at rotation time, defaulting to Playing.
    const typeMap: Record<string, ActivityType> = {
      PLAYING: ActivityType.Playing,
      WATCHING: ActivityType.Watching,
      LISTENING: ActivityType.Listening,
      COMPETING: ActivityType.Competing,
    };
    this.client.user?.setActivity(randomStatus.name, {
      type: typeMap[randomStatus.type] ?? ActivityType.Playing,
    });
  }

  async login(): Promise<void> {
    if (!DISCORD_CONFIG.token) {
      throw new Error('DISCORD_BOT_TOKEN is not set in environment variables');
    }

    try {
      await this.client.login(DISCORD_CONFIG.token);
    } catch (error) {
      console.error('❌ Failed to login to Discord:', error);
      throw error;
    }
  }

  async registerCommands(): Promise<void> {
    if (!DISCORD_CONFIG.token || !DISCORD_CONFIG.clientId) {
      throw new Error('DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID is not set');
    }

    const commands = [
      new SlashCommandBuilder()
        .setName(COMMANDS.HELP)
        .setDescription('Show help for all Avalon Bot commands'),

      // 2026-10-09: kept registered (no options) so users get a pointer to
      // signage-cloud instead of "unknown command".
      ...PLAY_PLATFORM_COMMANDS.map((name) =>
        new SlashCommandBuilder()
          .setName(name)
          .setDescription('Games are played on signage-cloud now — replies with the link (前往 signage-cloud 開局)')
      ),

      new SlashCommandBuilder()
        .setName(COMMANDS.RULES)
        .setDescription('Display Avalon game rules'),

      new SlashCommandBuilder()
        .setName(COMMANDS.ROLES)
        .setDescription('Display information about all roles'),
    ];

    const rest = new REST({ version: '10' }).setToken(DISCORD_CONFIG.token);

    try {
      console.log('🔄 Registering Discord slash commands...');

      if (DISCORD_CONFIG.guildId) {
        // Guild-specific commands (faster for testing)
        await rest.put(
          Routes.applicationGuildCommands(DISCORD_CONFIG.clientId, DISCORD_CONFIG.guildId),
          {
            body: commands,
          }
        );
        console.log('✅ Guild commands registered');
      } else {
        // Global commands
        await rest.put(Routes.applicationCommands(DISCORD_CONFIG.clientId), {
          body: commands,
        });
        console.log('✅ Global commands registered');
      }
    } catch (error) {
      console.error('❌ Failed to register Discord commands:', error);
      throw error;
    }
  }

  getClient(): Client {
    return this.client;
  }

  isClientReady(): boolean {
    return this.isReady;
  }

  async logout(): Promise<void> {
    await this.client.destroy();
    this.isReady = false;
  }
}

// Singleton instance
let discordBotInstance: DiscordBotClient | null = null;

export async function initializeDiscordBot(): Promise<DiscordBotClient> {
  if (discordBotInstance) {
    return discordBotInstance;
  }

  discordBotInstance = new DiscordBotClient();

  try {
    await discordBotInstance.registerCommands();
    await discordBotInstance.login();
    return discordBotInstance;
  } catch (error) {
    console.error('❌ Failed to initialize Discord Bot:', error);
    throw error;
  }
}

export function getDiscordBot(): DiscordBotClient | null {
  return discordBotInstance;
}
