/**
 * Typed stats commands for chat platforms without slash commands (LINE).
 *
 *   /戰績 名字      → player card
 *   /排行（/排行榜） → leaderboard
 *   /默契 A B       → pair chemistry
 *   /指令           → help
 *
 * A full-width slash (／) works too, and the space after the command word is
 * optional (/戰績HAO). Anything else — including the legacy English game
 * commands — returns null so the caller keeps its existing behaviour.
 * The raw text is used as typed: names are case-sensitive in the sheet
 * (Sin / SIN / sin are different players), so never lower-case it first.
 */

import { formatStatsHelp, StatsPlatform } from './statsReplies';
import { chemistryReply, leaderboardReply, playerCardReply } from './statsQueries';

export type StatsTextCommand =
  | { kind: 'player'; query: string }
  | { kind: 'leaderboard' }
  | { kind: 'chemistry'; args: string[] }
  | { kind: 'help' };

const COMMAND_RE = /^[/／]\s*(戰績|战绩|排行榜|排行|默契|指令)(.*)$/su;

export function parseStatsCommand(text: string): StatsTextCommand | null {
  const m = COMMAND_RE.exec((text ?? '').trim());
  if (!m) return null;
  const rest = m[2].trim();
  switch (m[1]) {
    case '戰績':
    case '战绩':
      return { kind: 'player', query: rest };
    case '排行':
    case '排行榜':
      return { kind: 'leaderboard' };
    case '默契':
      return { kind: 'chemistry', args: rest ? rest.split(/\s+/) : [] };
    case '指令':
      return { kind: 'help' };
    default:
      return null;
  }
}

/** Answer text for a stats command, or null when `text` is not one. */
export async function answerStatsTextCommand(
  text: string,
  platform: StatsPlatform = 'line',
): Promise<string | null> {
  const cmd = parseStatsCommand(text);
  if (!cmd) return null;
  switch (cmd.kind) {
    case 'player':
      return playerCardReply(cmd.query);
    case 'leaderboard':
      return leaderboardReply();
    case 'chemistry':
      return chemistryReply(cmd.args[0] ?? '', cmd.args[1] ?? '');
    case 'help':
      return formatStatsHelp(platform);
  }
}
