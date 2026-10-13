/**
 * Texts of the weekly community digest: the Discord post (marker line + a
 * facts line + the summary), its split into ≤ 2000-character messages, and
 * the status-only reply of /社群週報. Pure functions.
 */

import type { SummaryOutcome } from './summarizer';
import { digestMarker, formatPeriod, type DigestWindow } from './window';

export const DISCORD_MESSAGE_MAX_CHARS = 2000;

export interface DigestPostFacts {
  included: number;
  channels: number;
  omitted: number;
  channelsRead: number;
  truncatedChannels: number;
  /** Source channels that could not be read at all. */
  failedChannels?: number;
  /** No channel visible to @everyone was found (only the sync channel was read). */
  noPublicChannels?: boolean;
  model: string | null;
}

/** Second line of the post: period and the counts the reader needs to trust the summary. */
export function factsLine(w: DigestWindow, f: DigestPostFacts): string {
  const parts = [
    `期間 ${formatPeriod(w)}（台灣時間）`,
    `收錄 ${f.included} 則訊息、${f.channels} 個頻道`,
    `因篇幅省略 ${f.omitted} 則`,
  ];
  if (f.model) parts.push(f.model);
  let line = parts.join('｜');
  if (f.omitted > 0) line += `\n本週訊息超過長度上限，最早的 ${f.omitted} 則沒有讀入摘要。`;
  if (f.truncatedChannels > 0) line += `\n另有 ${f.truncatedChannels} 個頻道訊息太多，最早的一部分沒有讀取。`;
  if ((f.failedChannels ?? 0) > 0) line += `\n另有 ${f.failedChannels} 個頻道讀取失敗，那些頻道的訊息不在這份週報裡。`;
  if (f.noPublicChannels) line += `\n${NO_PUBLIC_CHANNELS_TEXT}`;
  return line;
}

export const NO_PUBLIC_CHANNELS_TEXT =
  '沒有找到所有人（@everyone）都看得到的頻道，只讀了 LINE 同步頻道；要讀其他頻道請設 COMMUNITY_DIGEST_SOURCE_CHANNEL_IDS。';

export const DIGEST_FOOTNOTE =
  '由 AI 整理公開頻道與 LINE 同步頻道的聊天，發言者已匿名；聊天原文只交給 AI 整理，不會存到 GitHub、log 或試算表。';

export function buildDiscordPost(w: DigestWindow, f: DigestPostFacts, summary: string): string {
  return [digestMarker(w), factsLine(w, f), DIGEST_FOOTNOTE, '', summary.trim()].join('\n');
}

export function noMessagesSummary(channelsRead: number, failedChannels = 0): string {
  const failed = failedChannels > 0 ? `，另有 ${failedChannels} 個頻道讀取失敗` : '';
  return (
    `這段期間沒有讀到可以彙整的聊天訊息（讀取了 ${channelsRead} 個頻道${failed}）。` +
    '如果這不正常，請確認機器人在各頻道有「檢視頻道」與「讀取訊息歷史」權限。'
  );
}

const OUTCOME_TEXT: Record<SummaryOutcome, string> = {
  ok: '完成',
  truncated: '完成，但摘要達到長度上限，結尾可能不完整',
  refused: '模型拒絕處理這段內容（安全機制），這週沒有摘要',
  empty: '模型沒有回傳內容',
  'no-api-key': '沒有設定 ANTHROPIC_API_KEY',
  'auth-error': 'Anthropic API 金鑰無效',
  'permission-error': 'Anthropic API 金鑰沒有權限',
  'rate-limited': 'Anthropic API 暫時限流',
  'bad-request': 'Anthropic API 拒絕這個請求（可能是內容太長）',
  'api-error': 'Anthropic API 暫時出錯',
  'connection-error': '連不上 Anthropic API',
  error: '未預期的錯誤',
};

export function summaryOutcomeText(outcome: SummaryOutcome): string {
  return OUTCOME_TEXT[outcome];
}

/** Posted instead of a summary when a scheduled week gives up (so the owner knows it ran). */
export function failureNotice(w: DigestWindow, outcome: SummaryOutcome): string {
  return [digestMarker(w), `這週沒有產生摘要：${summaryOutcomeText(outcome)}。可以用 /社群週報 手動再試一次。`].join('\n');
}

/** Hard-split one over-long line by code points so no piece exceeds `max` UTF-16 units. */
function splitLongLine(line: string, max: number): string[] {
  const pieces: string[] = [];
  let cur = '';
  for (const ch of Array.from(line)) {
    if (cur.length + ch.length > max) {
      pieces.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * Split into Discord messages of at most `max` characters, breaking at line
 * boundaries (a single longer line is cut by characters). Blank chunks are dropped.
 */
export function chunkForDiscord(text: string, max: number = DISCORD_MESSAGE_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur.trim()) chunks.push(cur.replace(/\n+$/, ''));
    cur = '';
  };
  for (const raw of text.split('\n')) {
    const lines = raw.length > max ? splitLongLine(raw, max) : [raw];
    for (const line of lines) {
      const next = cur ? `${cur}\n${line}` : line;
      if (next.length > max) {
        flush();
        cur = line;
      } else {
        cur = next;
      }
    }
  }
  flush();
  return chunks;
}
