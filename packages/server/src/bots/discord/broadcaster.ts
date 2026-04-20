/**
 * Discord Game Result Broadcaster
 *
 * Posts game completion summaries to the Avalon Discord server.
 * Target channel: #同步閒聊 (1132901301802504242)
 */

import { EmbedBuilder, TextChannel } from 'discord.js';
import { Room, Player, Role } from '@avalon/shared';
import { getDiscordBot } from './client';

const SYNC_CHANNEL_ID = '1132901301802504242'; // #同步閒聊

const ROLE_LABELS: Record<Role, string> = {
  merlin: '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal: '亞瑟的忠臣',
  assassin: '刺客 (Assassin)',
  morgana: '莫甘娜 (Morgana)',
  oberon: '奧伯倫 (Oberon)',
};

const ROLE_TEAM_EMOJI: Record<Role, string> = {
  merlin: '🔵',
  percival: '🔵',
  loyal: '🔵',
  assassin: '🔴',
  morgana: '🔴',
  oberon: '🔴',
};

const WIN_REASON_LABELS: Record<string, string> = {
  failed_quests_limit: '壞人完成 3 次任務失敗',
  vote_rejections_limit: '5 次連續投票否決，壞人獲勝',
  merlin_assassinated: '刺客成功刺殺梅林',
  assassination_failed: '刺客未能找出梅林，好人獲勝',
  assassination_timeout: '刺殺超時，好人獲勝',
  unknown: '遊戲結束',
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function buildQuestResultString(questResults: string[]): string {
  return questResults
    .map((r) => (r === 'success' ? '🟦' : r === 'fail' ? '🟥' : '⬜'))
    .join(' ');
}

function groupPlayersByTeam(players: Record<string, Player>): {
  good: Player[];
  evil: Player[];
} {
  const good: Player[] = [];
  const evil: Player[] = [];
  for (const player of Object.values(players)) {
    if (player.team === 'good') good.push(player);
    else if (player.team === 'evil') evil.push(player);
  }
  return { good, evil };
}

/**
 * Post a game result embed to #同步閒聊.
 * Fire-and-forget: errors are logged, not thrown.
 */
export async function broadcastGameResult(room: Room, winReason: string): Promise<void> {
  const bot = getDiscordBot();
  if (!bot || !bot.isClientReady()) {
    console.warn('Discord broadcaster: bot not ready, skipping broadcast');
    return;
  }

  try {
    const channel = await bot.getClient().channels.fetch(SYNC_CHANNEL_ID);
    if (!channel || !(channel instanceof TextChannel)) {
      console.warn(`Discord broadcaster: channel ${SYNC_CHANNEL_ID} not found or not a text channel`);
      return;
    }

    const winner = room.evilWins ? 'evil' : 'good';
    const duration = room.updatedAt - room.createdAt;
    const { good, evil } = groupPlayersByTeam(room.players);
    const playerCount = Object.keys(room.players).length;

    const winnerLabel = winner === 'good' ? '好人陣營獲勝' : '壞人陣營獲勝';
    const winnerEmoji = winner === 'good' ? '🔵' : '🔴';
    const embedColor = winner === 'good' ? 0x3b82f6 : 0xef4444;

    const goodPlayerLines = good
      .map((p) => {
        const roleLabel = p.role ? ROLE_LABELS[p.role] : '未知';
        const emoji = p.role ? ROLE_TEAM_EMOJI[p.role] : '⚪';
        return `${emoji} **${p.name}** — ${roleLabel}`;
      })
      .join('\n');

    const evilPlayerLines = evil
      .map((p) => {
        const roleLabel = p.role ? ROLE_LABELS[p.role] : '未知';
        return `🔴 **${p.name}** — ${roleLabel}`;
      })
      .join('\n');

    const questString = buildQuestResultString(room.questResults);
    const reasonLabel = WIN_REASON_LABELS[winReason] ?? winReason;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`${winnerEmoji} 遊戲結束 — ${winnerLabel}`)
      .setDescription(`**${room.name}** | ${playerCount} 人局`)
      .addFields(
        {
          name: '勝負原因',
          value: reasonLabel,
          inline: false,
        },
        {
          name: '任務結果',
          value: questString || '(無)',
          inline: false,
        },
        {
          name: `🔵 好人陣營 (${good.length})`,
          value: goodPlayerLines || '(無)',
          inline: true,
        },
        {
          name: `🔴 壞人陣營 (${evil.length})`,
          value: evilPlayerLines || '(無)',
          inline: true,
        },
        {
          name: '遊戲時長',
          value: formatDuration(duration),
          inline: true,
        }
      )
      .setFooter({ text: `Room ID: ${room.id}` })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    console.log(`Discord broadcaster: game result posted for room ${room.id}`);
  } catch (error) {
    console.error('Discord broadcaster: failed to post game result:', error);
  }
}
