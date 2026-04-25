/**
 * Discord DM Role Reveal
 *
 * Sends a private direct-message to each Discord player when the game starts,
 * showing:
 *   - their own role and team
 *   - role-specific knowledge (Merlin sees evil-minus-Mordred-minus-Oberon;
 *     Percival sees Merlin+Morgana scrambled; evil — minus Oberon — sees
 *     other evil players)
 *
 * Canonical 7-role scope (memory project_avalon_scope_canonical_7.md):
 *   Good : merlin, percival, loyal
 *   Evil : assassin, morgana, mordred, oberon
 *
 * Role-knowledge rules mirror GameServer.buildBotObservation so bots and
 * real players see the same view.
 */
import { EmbedBuilder } from 'discord.js';
import { Room, Player, Role, CANONICAL_ROLES, isCanonicalRole } from '@avalon/shared';
import { getDiscordBot } from './client';
import { DISCORD_CONFIG } from './config';

const DISCORD_ID_PREFIX = 'discord:';

const ROLE_LABELS: Record<string, string> = {
  merlin: '梅林 (Merlin)',
  percival: '派西維爾 (Percival)',
  loyal: '亞瑟的忠臣 (Loyal Servant of Arthur)',
  assassin: '刺客 (Assassin)',
  morgana: '莫甘娜 (Morgana)',
  mordred: '莫德雷德 (Mordred)',
  oberon: '奧伯倫 (Oberon)',
  minion: '爪牙 (Minion, legacy)',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  merlin:
    '你知道所有邪惡方的身分（莫德雷德與奧伯倫除外）。務必隱藏自己，若被刺客認出身分則壞人獲勝。',
  percival:
    '你看得到兩位玩家是梅林或莫甘娜，但無法分辨誰是誰。你的任務是保護梅林。',
  loyal:
    '你沒有任何特殊資訊。透過投票與任務推理壞人身分。',
  assassin:
    '你是邪惡陣營。若好人贏下 3 次任務，你可以指認一位玩家為梅林 — 猜中則邪惡獲勝。',
  morgana:
    '你是邪惡陣營。你會出現在派西維爾的視野中，冒充梅林以混淆他。',
  mordred:
    '你是邪惡陣營。梅林看不到你 — 這是你最大的優勢。',
  oberon:
    '你是邪惡陣營，但其他壞人不知道你的身分，你也看不到他們。獨立作戰。',
  minion:
    '你是邪惡陣營。（注意：minion 是 legacy 替代角色，不應出現在正式局中）',
};

/**
 * Extract the raw Discord user ID from an internal player ID of the form
 * `discord:<snowflake>`. Returns null for non-Discord player IDs.
 */
export function extractDiscordUserId(playerId: string): string | null {
  if (!playerId.startsWith(DISCORD_ID_PREFIX)) return null;
  const raw = playerId.slice(DISCORD_ID_PREFIX.length);
  if (!raw) return null;
  return raw;
}

/**
 * Compute the set of player IDs that a given role is entitled to see as
 * evil. Mirrors GameServer.buildBotObservation so bots and humans share
 * the same knowledge model.
 */
export function computeKnownEvils(viewer: Player, room: Room): string[] {
  const viewerId = viewer.id;
  const role = viewer.role;
  const team = viewer.team;
  if (!role) return [];

  if (role === 'merlin') {
    // Merlin sees all evil EXCEPT Mordred and Oberon.
    return Object.entries(room.players)
      .filter(
        ([id, p]) =>
          id !== viewerId &&
          p.team === 'evil' &&
          p.role !== 'mordred' &&
          p.role !== 'oberon'
      )
      .map(([id]) => id);
  }

  if (team === 'evil' && role !== 'oberon') {
    // Evil (except Oberon) sees other evil — except Oberon.
    return Object.entries(room.players)
      .filter(
        ([id, p]) =>
          id !== viewerId && p.team === 'evil' && p.role !== 'oberon'
      )
      .map(([id]) => id);
  }

  return [];
}

/**
 * For Percival: list of player IDs that look like "possible Merlin" — i.e.
 * the real Merlin plus Morgana (who impersonates Merlin in Percival's view).
 * Returned in name-sorted order so Percival cannot infer identity from
 * Object.keys ordering.
 */
export function computePercivalWizards(viewer: Player, room: Room): string[] {
  if (viewer.role !== 'percival') return [];
  return Object.entries(room.players)
    .filter(([id, p]) => id !== viewer.id && (p.role === 'merlin' || p.role === 'morgana'))
    .map(([id, p]) => ({ id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .map((e) => e.id);
}

/**
 * Internal helper: build the private embed shown to a single player.
 * Exported for unit testing.
 */
export function buildRoleRevealEmbed(viewer: Player, room: Room): EmbedBuilder {
  const role = viewer.role;
  if (!role || !isCanonicalRole(role)) {
    // Defensive: role is not part of the canonical scope. This should never
    // happen because GameEngine.assignRoles throws CanonicalRoleLockError on
    // non-canonical roles — we still produce a minimal embed so the DM does
    // not silently fail.
    return new EmbedBuilder()
      .setColor(DISCORD_CONFIG.colors.error)
      .setTitle('⚠️ Role reveal error')
      .setDescription(
        `Your role could not be identified (received "${String(role)}"). ` +
          `Allowed: ${CANONICAL_ROLES.join(', ')}.`
      );
  }

  const team = viewer.team ?? (role === 'merlin' || role === 'percival' || role === 'loyal' ? 'good' : 'evil');
  const teamColor =
    team === 'good' ? DISCORD_CONFIG.colors.good : DISCORD_CONFIG.colors.evil;
  const teamLabel = team === 'good' ? '🔵 好人陣營' : '🔴 邪惡陣營';
  const roleLabel = ROLE_LABELS[role] ?? role;
  const roleDescription = ROLE_DESCRIPTIONS[role] ?? '';

  const embed = new EmbedBuilder()
    .setColor(teamColor)
    .setTitle('🎭 你的身分')
    .setDescription(
      `**${roleLabel}** — ${teamLabel}\n\n${roleDescription}`
    )
    .setFooter({ text: `Room ID: ${room.id}` });

  // Known-evils field
  const knownEvilIds = computeKnownEvils(viewer, room);
  if (knownEvilIds.length > 0) {
    const names = knownEvilIds
      .map((id) => room.players[id]?.name ?? id)
      .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const label =
      role === 'merlin'
        ? '你看得到的邪惡玩家（梅林視野，不含莫德雷德/奧伯倫）'
        : '你的邪惡隊友（不含奧伯倫）';
    embed.addFields({ name: label, value: names.join('\n'), inline: false });
  } else if (role === 'oberon') {
    embed.addFields({
      name: '隊友',
      value: '其他壞人不知道你；你也看不到他們。獨立行動。',
      inline: false,
    });
  } else if (team === 'evil') {
    // Defensive — evil but no knownEvils (should only happen for oberon,
    // handled above).
    embed.addFields({
      name: '隊友',
      value: '（無法識別 — 可能為單人邪惡局）',
      inline: false,
    });
  } else if (role === 'loyal') {
    embed.addFields({
      name: '特殊資訊',
      value: '你沒有任何特殊資訊，用投票與任務推理邪惡身分。',
      inline: false,
    });
  }

  // Percival field
  if (role === 'percival') {
    const wizardIds = computePercivalWizards(viewer, room);
    if (wizardIds.length > 0) {
      const names = wizardIds
        .map((id) => room.players[id]?.name ?? id);
      embed.addFields({
        name: '可能的梅林（兩位其中之一是莫甘娜混淆）',
        value: names.join('\n'),
        inline: false,
      });
    }
  }

  return embed;
}

/**
 * Send a DM with role reveal to a single player.
 * Returns true on success, false on failure (e.g. bot not ready, DM closed).
 *
 * Fire-and-forget: the caller should not block game start on the DM result.
 */
export async function sendRoleRevealDM(player: Player, room: Room): Promise<boolean> {
  const discordUserId = extractDiscordUserId(player.id);
  if (!discordUserId) {
    // Not a Discord player — web/socket clients get role via game:started
    return false;
  }

  const bot = getDiscordBot();
  if (!bot || !bot.isClientReady()) {
    console.warn(
      `[roleReveal] bot not ready; skipping DM for player ${player.id}`
    );
    return false;
  }

  try {
    const user = await bot.getClient().users.fetch(discordUserId);
    const embed = buildRoleRevealEmbed(player, room);
    await user.send({ embeds: [embed] });
    console.log(
      `[roleReveal] DM sent to ${player.name} (${player.id}) in room ${room.id}`
    );
    return true;
  } catch (error) {
    // Common reasons: user disabled DMs, user not in any shared guild, etc.
    // We log but do not throw — game should continue.
    console.error(
      `[roleReveal] failed to DM ${player.id} in room ${room.id}:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * Send role reveal DMs to every Discord player in the room.
 * Web/socket players are skipped (they receive role via game:started event).
 *
 * Returns a summary: { sent, skipped, failed } counts.
 *
 * Fire-and-forget from the caller's perspective — GameServer should not
 * block start on DM delivery.
 */
export async function sendRoleRevealToRoom(
  room: Room
): Promise<{ sent: number; skipped: number; failed: number }> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const players = Object.values(room.players);
  await Promise.all(
    players.map(async (player: Player) => {
      const discordUserId = extractDiscordUserId(player.id);
      if (!discordUserId) {
        skipped++;
        return;
      }
      const ok = await sendRoleRevealDM(player, room);
      if (ok) sent++;
      else failed++;
    })
  );

  console.log(
    `[roleReveal] room ${room.id}: ${sent} sent, ${skipped} non-discord, ${failed} failed`
  );
  return { sent, skipped, failed };
}
