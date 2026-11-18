/**
 * 每日小觀念的回饋（站長 11/18：「其他人也可以針對這些觀念做回覆 認為不合理或是不清楚的 你再收下做調整」）。
 *
 * 怎麼算一則回饋（只在開了小觀念的群組／頻道）：
 *   - 引用（回覆）bot 發的那一則小觀念：Discord 的 message reference、LINE 的 quotedMessageId 對得上
 *     bot 發出去那一則的訊息 id（store.ts 的 messages）；
 *   - 或打「觀念回饋 內容」「/觀念 內容」（LINE 的引用萬一認不出來時用；算到這個群組最近一次發的那張卡）。
 * 存哪裡：跟 /意見 一樣，由 bot 貼到管理員頻道（FEEDBACK_DISCORD_CHANNEL_ID，預設「大劍管理員」），不進 repo、不進 log。
 *   【觀念卡回饋】<卡片 id>
 *   日期 <那張卡發的日期>｜<LINE/DC>｜群 <雜湊>｜人 <雜湊>｜時間 <ISO>
 *   <內容>
 * 例行作業用 scripts/conceptFeedback.ts list --since … 讀（services/conceptFeedbackList.ts），處理完 mark <訊息 id>，
 * 那一則會被改成第一行結尾加「（已處理）」。
 * 限流：每人 10 分鐘 3 則、一天 10 則；全部每小時 60 則。超過的不回、不存（只算次數）。
 */

import { escapeDiscordMarkdown } from '../../services/communityReports';
import type { ConceptPlatform } from './config';

export const CONCEPT_FEEDBACK_PREFIX = '【觀念卡回饋】';
export const CONCEPT_FEEDBACK_ACK = '收到，會轉給百科整理，謝謝。';
export const CONCEPT_FEEDBACK_USAGE = '請在「觀念回饋」後面寫下哪裡不合理或不清楚，例如：觀念回饋 應用那句看不懂。';
export const CONCEPT_FEEDBACK_MAX_CHARS = 500;
export const CONCEPT_FEEDBACK_DONE_MARK = '（已處理）';

/** 「觀念回饋 …」「/觀念 …」（全形斜線、冒號也收）→ 後面的內容（可能是空字串）；不是就 null。 */
export function parseFeedbackKeyword(text: string): string | null {
  const m = /^\s*(?:[/／]觀念(?:回饋)?|觀念回饋)(?=$|[\s:：,，])[\s:：,，]*([\s\S]*)$/u.exec(text ?? '');
  return m ? m[1].trim() : null;
}

export const PLATFORM_LABEL: Record<ConceptPlatform, string> = { line: 'LINE', discord: 'DC' };

export interface FeedbackRecord {
  cardId: string;
  /** 那張卡發的日期（台北）。 */
  date: string;
  platform: ConceptPlatform;
  /** 雜湊過的群組／頻道 id。 */
  groupHash: string;
  /** 雜湊過的使用者 id。 */
  userHash: string;
  text: string;
  createdAt: string;
}

/** 貼到管理員頻道的那一則（不 @ 任何人；內容的 Markdown 跳脫，例行作業讀回時還原）。 */
export function formatFeedbackForAdmin(r: FeedbackRecord): string {
  const text = Array.from(r.text.replace(/\r\n?/g, '\n').trim()).slice(0, CONCEPT_FEEDBACK_MAX_CHARS).join('');
  return [
    `${CONCEPT_FEEDBACK_PREFIX}${r.cardId}`,
    `日期 ${r.date}｜${PLATFORM_LABEL[r.platform]}｜群 ${r.groupHash}｜人 ${r.userHash}｜時間 ${r.createdAt}`,
    escapeDiscordMarkdown(text),
  ].join('\n');
}

/** 每人、全部的限流（記憶體；重啟歸零）。 */
export class FeedbackRateLimiter {
  private perUser = new Map<string, number[]>();
  private all: number[] = [];
  constructor(
    private readonly limits = { userWindowMs: 10 * 60_000, userMax: 3, userDayMax: 10, globalHourMax: 60 },
  ) {}

  /** 這一則可以收嗎；可以就記下來。 */
  allow(userHash: string, now: number): boolean {
    const day = 24 * 60 * 60_000;
    const hits = (this.perUser.get(userHash) ?? []).filter((t) => now - t < day);
    this.all = this.all.filter((t) => now - t < 60 * 60_000);
    const recent = hits.filter((t) => now - t < this.limits.userWindowMs).length;
    if (recent >= this.limits.userMax || hits.length >= this.limits.userDayMax || this.all.length >= this.limits.globalHourMax) {
      this.perUser.set(userHash, hits);
      return false;
    }
    hits.push(now);
    this.perUser.set(userHash, hits);
    this.all.push(now);
    if (this.perUser.size > 5000) this.perUser.clear();
    return true;
  }
}
