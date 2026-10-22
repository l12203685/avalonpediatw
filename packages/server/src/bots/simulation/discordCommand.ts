/**
 * 模擬瓦（2026-10-14）— Discord slash 指令：/模擬 /派 /區間 /下一步 /公布 /結束。
 *
 * 跟 LINE 同一個引擎、同一套文字（/模擬 說明 有 Discord 版）。session key = discord:頻道:使用者。
 * 每個指令先 defer，再 editReply（allowedMentions 全關；回覆不回顯使用者打的字）。
 * 公開或只有本人看得到：SIM_DISCORD_PUBLIC_CHANNEL_IDS 空 = 到處公開（跟 /戰績 一樣），
 * 有設 = 只有那些頻道公開。代答（2026-10-22）只在回覆公開的頻道（request 的 `shared`）。
 * slash 指令不會產生使用者訊息、機器人回覆是 bot 發的，
 * 所以同步（mirrorInbound 不收 bot）和聊天匯出都碰不到 Discord 的模擬。
 * 只有固定文字和錯誤代碼會進 log。
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { COMMANDS, SIM_OPTIONS } from '../discord/config';
import { describeError } from '../media/bytes';
import { normalizeExerciseId, parseInterval, parseRoleChoice, parseTeam, type SimCommand } from './commands';
import { SIM_CONFIG, simDiscordPublicChannelIds } from './config';
import { getSimEngine } from './index';

export const SIM_DISABLED_TEXT = '模擬瓦目前停用。';

/** slash 指令的選項 → 模擬指令（跟 LINE 打字的解析同一套）。 */
export function simCommandFromInteraction(interaction: Pick<ChatInputCommandInteraction, 'commandName' | 'options'>): SimCommand | null {
  const opts = interaction.options as Pick<ChatInputCommandInteraction['options'], 'getString' | 'getInteger'> & {
    getBoolean?: ChatInputCommandInteraction['options']['getBoolean'];
  };
  switch (interaction.commandName) {
    case COMMANDS.SIM: {
      // /模擬 說明:True → 指令說明（Discord 版：照 slash 的選項名寫，見 replies.ts simHelpText）。
      if (opts.getBoolean?.(SIM_OPTIONS.HELP, false)) return { kind: 'help' };
      const roleRaw = opts.getString(SIM_OPTIONS.ROLE, false);
      const seat = opts.getInteger(SIM_OPTIONS.SEAT, false);
      const idRaw = opts.getString(SIM_OPTIONS.ID, false);
      if (idRaw) {
        const id = normalizeExerciseId(idRaw);
        return id ? { kind: 'start', exerciseId: id } : { kind: 'usage', command: 'start', problem: '題號長得像 K7Q2M-4' };
      }
      const role = roleRaw ? parseRoleChoice(roleRaw) : null;
      if (roleRaw && !role) return { kind: 'usage', command: 'start' };
      if (seat !== null && seat !== undefined && (seat < 1 || seat > 10)) return { kind: 'usage', command: 'start' };
      return { kind: 'start', ...(role ? { role } : {}), ...(seat ? { seat } : {}) };
    }
    case COMMANDS.SIM_PROPOSE: {
      const r = parseTeam(opts.getString(SIM_OPTIONS.TEAM, true) ?? '');
      return 'team' in r ? { kind: 'propose', team: r.team } : { kind: 'usage', command: 'propose', problem: r.problem };
    }
    case COMMANDS.SIM_INTERVAL: {
      const r = parseInterval(opts.getString(SIM_OPTIONS.CONTENT, true) ?? '');
      return 'groups' in r ? { kind: 'interval', groups: r.groups } : { kind: 'usage', command: 'interval', problem: r.problem };
    }
    case COMMANDS.SIM_NEXT:
      return { kind: 'next' };
    case COMMANDS.SIM_REVEAL:
      return { kind: 'reveal' };
    case COMMANDS.SIM_END:
      return { kind: 'end' };
    default:
      return null;
  }
}

/** 這個頻道的模擬回覆要不要公開。 */
export function simReplyIsPublic(channelId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const ids = simDiscordPublicChannelIds(env);
  return ids.size === 0 || (!!channelId && ids.has(channelId));
}

/**
 * 不往外丟錯：discord.js 的錯誤物件帶著送出的內容（回覆可能回顯使用者打的字），
 * client.ts 的通用 catch 會把整個錯誤印出來，所以這裡自己接住、只記錯誤代碼。
 */
export async function handleSimCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await runSimCommand(interaction);
  } catch (err) {
    console.error(`[sim] Discord command failed (${describeError(err)})`);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: SIM_ERROR_TEXT, allowedMentions: { parse: [] } });
      }
    } catch (err2) {
      console.error(`[sim] Discord error reply failed (${describeError(err2)})`);
    }
  }
}

export const SIM_ERROR_TEXT = '模擬瓦出了點問題，請稍後再試。';

async function runSimCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const ephemeral = !simReplyIsPublic(interaction.channelId);
  if (ephemeral) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferReply();

  if (!SIM_CONFIG.commandsEnabled) {
    await interaction.editReply({ content: SIM_DISABLED_TEXT, allowedMentions: { parse: [] } });
    return;
  }
  const cmd = simCommandFromInteraction(interaction);
  if (!cmd) {
    await interaction.deleteReply();
    return;
  }
  const engine = getSimEngine();
  // explicit：看不懂的 /派、/區間 沒有題目時也給用法（slash 是明確的指令），一樣受限流管。
  // shared：回覆公開時頻道裡的人都看得到，才可以代答（2026-10-22 審查修正：只有本人看得到回覆的頻道裡，
  // 沒看過題目的人不能推進、公布或結束別人的題目，題主也看不到代答的回覆）。
  const req = {
    platform: 'discord' as const,
    chatId: interaction.channelId ?? 'dm',
    userId: interaction.user.id,
    explicit: true,
    // 私訊沒有別人看得到：不代答、也不加「頻道裡…」那一行（全域註冊的指令在私訊也能用）。
    shared: !ephemeral && !!interaction.guildId,
  };
  // 同一個頻道的模擬指令排隊：「算回覆 → 送出 → commit」一次一個（Edward 2026-10-14 審查修正；
  // 2026-10-22 起整個頻道一條隊，代答要動哪一題輪到它時才決定）。
  await engine.withLock(req, async () => {
    const reply = await engine.handle(cmd, req);
    if (!reply) {
      // 被限流（提醒過之後）：什麼都不留。
      await interaction.deleteReply();
      return;
    }
    await interaction.editReply({ content: reply.text, allowedMentions: { parse: [] } });
    // 回覆已經送出：commit 出錯也不能把已經貼出去的答案改成錯誤訊息。
    try {
      reply.commit();
    } catch (err) {
      console.error(`[sim] Discord commit failed (${describeError(err)})`);
    }
  });
}
