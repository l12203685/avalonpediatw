import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  CommandInteraction,
  ActivityType,
} from 'discord.js';
import { DISCORD_CONFIG, COMMANDS } from './config';
import {
  handleHelpCommand,
  handleCreateCommand,
  handleJoinCommand,
  handleStatusCommand,
  handleVoteCommand,
  handleRulesCommand,
  handleRolesCommand,
  handleStartCommand,
  handleQuestCommand,
  handleAssassinateCommand,
} from './commands';

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
      if (!interaction.isCommand()) return;
      this.handleCommand(interaction as CommandInteraction);
    });

    // Error handling
    this.client.on('error', (error) => {
      console.error('❌ Discord Bot Error:', error);
    });

    this.client.on('warn', (warn) => {
      console.warn('⚠️ Discord Bot Warning:', warn);
    });
  }

  private async handleCommand(interaction: CommandInteraction): Promise<void> {
    const commandName = interaction.commandName;

    try {
      switch (commandName) {
        case COMMANDS.HELP:
          await handleHelpCommand(interaction);
          break;

        case COMMANDS.CREATE:
          await handleCreateCommand(interaction);
          break;

        case COMMANDS.JOIN: {
          const roomId = interaction.options.getString('room-id') || '';
          await handleJoinCommand(interaction, roomId);
          break;
        }

        case COMMANDS.START:
          await handleStartCommand(interaction);
          break;

        case COMMANDS.STATUS:
          await handleStatusCommand(interaction);
          break;

        case COMMANDS.VOTE: {
          const vote = interaction.options.getString('vote') as 'approve' | 'reject';
          await handleVoteCommand(interaction, vote);
          break;
        }

        case COMMANDS.QUEST: {
          const vote = interaction.options.getString('result') as 'success' | 'fail';
          await handleQuestCommand(interaction, vote);
          break;
        }

        case COMMANDS.ASSASSINATE:
          await handleAssassinateCommand(interaction);
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

    this.client.user?.setActivity(randomStatus.name, {
      type: randomStatus.type as ActivityType,
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

      new SlashCommandBuilder()
        .setName(COMMANDS.CREATE)
        .setDescription('Create a new Avalon game'),

      new SlashCommandBuilder()
        .setName(COMMANDS.JOIN)
        .setDescription('Join an existing Avalon game')
        .addStringOption((option) =>
          option
            .setName('room-id')
            .setDescription('The room ID to join')
            .setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName(COMMANDS.START)
        .setDescription('Get the web link so the host can start the game'),

      new SlashCommandBuilder()
        .setName(COMMANDS.STATUS)
        .setDescription('Check the current game status'),

      new SlashCommandBuilder()
        .setName(COMMANDS.VOTE)
        .setDescription('Vote on the team proposal')
        .addStringOption((option) =>
          option
            .setName('vote')
            .setDescription('Your vote: approve or reject')
            .setRequired(true)
            .addChoices({ name: 'Approve', value: 'approve' }, { name: 'Reject', value: 'reject' })
        ),

      new SlashCommandBuilder()
        .setName(COMMANDS.QUEST)
        .setDescription('Open the web to submit your quest vote (quest team only)')
        .addStringOption((option) =>
          option
            .setName('result')
            .setDescription('Your intended quest vote (actual submission is on the web)')
            .setRequired(true)
            .addChoices({ name: 'Success', value: 'success' }, { name: 'Fail', value: 'fail' })
        ),

      new SlashCommandBuilder()
        .setName(COMMANDS.ASSASSINATE)
        .setDescription('Open the web to pick the assassination target (assassin only)'),

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
