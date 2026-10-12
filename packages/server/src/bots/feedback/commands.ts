/**
 * /意見 command — pure parsing and formatting (no I/O), shared by the LINE
 * text handler and the Discord slash command.
 *
 *   /意見 排行榜希望加上場次     → { content: '排行榜希望加上場次' }
 *   ／意見 ...（full-width slash） → same
 *   /意見                          → { content: '' }  (caller shows the usage hint)
 *   anything else                  → null
 */

import type { FeedbackPlatform } from './config';
import { FEEDBACK_CONTENT_MAX_CHARS } from './config';

export interface FeedbackTextCommand {
  content: string;
}

const COMMAND_RE = /^[/／]\s*意見(.*)$/su;

export function parseFeedbackCommand(text: string): FeedbackTextCommand | null {
  const m = COMMAND_RE.exec((text ?? '').trim());
  if (!m) return null;
  return { content: m[1].trim() };
}

/**
 * Collapse whitespace runs that are not newlines, trim, and cut to
 * FEEDBACK_CONTENT_MAX_CHARS code points ("…" replaces the last kept one).
 */
export function truncateFeedbackContent(raw: string, max: number = FEEDBACK_CONTENT_MAX_CHARS): string {
  const cleaned = (raw ?? '').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

const PLATFORM_LABEL: Record<FeedbackPlatform, string> = { line: 'LINE', discord: 'Discord' };

/** The line posted to the feedback Discord channel. Carries no name or id on purpose. */
export function formatFeedbackForward(platform: FeedbackPlatform, content: string): string {
  return `📮 意見（${PLATFORM_LABEL[platform]}）：${truncateFeedbackContent(content)}`;
}
