/**
 * TopicCounter — counts how often community chatter touches a topic.
 *
 * Privacy contract (docs/COMMUNITY_FEEDBACK.md): the counter only ever holds
 * integers. No message text, no user id, no display name is stored or
 * logged; `observe()` reads the text once and forgets it. The snapshot is
 * safe to publish on the public /api/bots/status endpoint.
 *
 *   - One message counts at most once per topic, however many keywords hit.
 *   - Buckets are ISO weeks in +08 (`YYYY-Www`), newest 8 kept.
 *   - Counts are per platform (line / discord).
 *   - Everything is in memory: a redeploy / restart starts from zero.
 */

import type { FeedbackPlatform } from './config';
import { FEEDBACK_RETAIN_WEEKS } from './config';

export interface TopicDef {
  /** Topic id as shown on /api/bots/status (繁中). */
  id: string;
  /** Substrings that count for this topic. Latin keywords match case-insensitively. */
  keywords: readonly string[];
  /**
   * Substrings removed from the text before this topic's keywords are
   * matched — for keywords that are themselves part of a harmless phrase
   * (問題's 錯 inside the praise 不錯, or 沒錯 "that's right").
   */
  exclude?: readonly string[];
}

/** Topic id bumped by the /意見 command itself (no keywords — command only). */
export const OPINION_TOPIC_ID = '意見';

export const DEFAULT_TOPICS: readonly TopicDef[] = [
  { id: '排行', keywords: ['排行', '排名'] },
  { id: '戰績', keywords: ['戰績', '战绩'] },
  { id: '默契', keywords: ['默契'] },
  { id: '機器人', keywords: ['機器人', 'bot'] },
  { id: '網站', keywords: ['網站', '網頁'] },
  { id: '牌譜', keywords: ['牌譜', '記錄', '紀錄'] },
  { id: '格式', keywords: ['格式'] },
  { id: '問題', keywords: ['錯', '壞', 'bug', '怪'], exclude: ['不錯', '沒錯'] },
  { id: '建議', keywords: ['建議', '希望', '可以加'] },
  { id: '稱讚', keywords: ['讚', '好用', '不錯'] },
  { id: '湖', keywords: ['湖', '湖中'] },
  { id: '刺殺', keywords: ['刺殺'] },
  { id: OPINION_TOPIC_ID, keywords: [] },
];

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO-8601 week of the +08 calendar date, as `YYYY-Www` (e.g. 2026-W42).
 * Pure arithmetic on epoch ms + fixed offset so the host TZ never matters
 * (Render runs UTC). Keys sort chronologically as plain strings.
 */
export function isoWeekKey(epochMs: number): string {
  const local = new Date(epochMs + TAIPEI_OFFSET_MS);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const mondayBased = (new Date(day).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const thursday = day + (3 - mondayBased) * DAY_MS; // ISO: the week belongs to its Thursday's year
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1;
  return `${isoYear}-W${week < 10 ? '0' : ''}${week}`;
}

/**
 * Topic ids whose keywords appear in `text` (each at most once, in topic
 * order), after that topic's `exclude` phrases are cut out. Pure.
 */
export function matchTopics(text: string, topics: readonly TopicDef[] = DEFAULT_TOPICS): string[] {
  const raw = text ?? '';
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const hits: string[] = [];
  for (const topic of topics) {
    let hay = lower;
    for (const ex of topic.exclude ?? []) if (ex) hay = hay.split(ex.toLowerCase()).join('');
    if (topic.keywords.some((kw) => kw && hay.includes(kw.toLowerCase()))) hits.push(topic.id);
  }
  return hits;
}

export type TopicCounts = Record<string, number>;

export interface TopicWeekSnapshot {
  week: string;
  line: TopicCounts;
  discord: TopicCounts;
}

interface WeekBucket {
  line: Map<string, number>;
  discord: Map<string, number>;
}

export interface TopicCounterOptions {
  topics?: readonly TopicDef[];
  retainWeeks?: number;
  now?: () => number;
}

export class TopicCounter {
  private readonly topics: readonly TopicDef[];
  private readonly retainWeeks: number;
  private readonly now: () => number;
  private readonly weeks = new Map<string, WeekBucket>();

  constructor(opts: TopicCounterOptions = {}) {
    this.topics = opts.topics ?? DEFAULT_TOPICS;
    this.retainWeeks = Math.max(1, opts.retainWeeks ?? FEEDBACK_RETAIN_WEEKS);
    this.now = opts.now ?? Date.now;
  }

  /** Count the topics a message touches (≤1 per topic). Returns the ids hit. The text is not kept. */
  observe(platform: FeedbackPlatform, text: string, at: number = this.now()): string[] {
    const hits = matchTopics(text, this.topics);
    for (const id of hits) this.bump(platform, id, at);
    return hits;
  }

  /** Increment one topic explicitly (used for the /意見 command). Unknown ids are ignored. */
  bump(platform: FeedbackPlatform, topicId: string, at: number = this.now()): void {
    if (!this.topics.some((t) => t.id === topicId)) return;
    const bucket = this.bucketFor(isoWeekKey(at));
    const counts = bucket[platform];
    counts.set(topicId, (counts.get(topicId) ?? 0) + 1);
  }

  /** Weeks oldest → newest; every topic listed (0 when untouched). Numbers only. */
  snapshot(): TopicWeekSnapshot[] {
    const keys = [...this.weeks.keys()].sort();
    return keys.map((week) => {
      const bucket = this.weeks.get(week)!;
      return {
        week,
        line: this.countsOf(bucket.line),
        discord: this.countsOf(bucket.discord),
      };
    });
  }

  private countsOf(map: Map<string, number>): TopicCounts {
    const out: TopicCounts = {};
    for (const t of this.topics) out[t.id] = map.get(t.id) ?? 0;
    return out;
  }

  private bucketFor(week: string): WeekBucket {
    let bucket = this.weeks.get(week);
    if (!bucket) {
      bucket = { line: new Map(), discord: new Map() };
      this.weeks.set(week, bucket);
      this.prune();
    }
    return bucket;
  }

  /** Keep only the newest `retainWeeks` buckets (string order == chronological order). */
  private prune(): void {
    if (this.weeks.size <= this.retainWeeks) return;
    const keys = [...this.weeks.keys()].sort();
    for (const key of keys.slice(0, keys.length - this.retainWeeks)) this.weeks.delete(key);
  }
}
