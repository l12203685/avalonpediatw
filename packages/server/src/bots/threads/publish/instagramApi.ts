/**
 * Instagram API（用 Instagram 登入的版本，graph.instagram.com）的最小客戶端：同步發 Threads 那篇的圖文到 IG。
 *
 * - 要 IG 專業帳號（商業或創作者）＋權限 instagram_business_basic、instagram_business_content_publish。
 * - 流程：建容器（/{ig-user-id}/media，image_url＋caption）→ 等 status_code = FINISHED → 發佈（/media_publish）。
 *   兩張以上的圖：每張先建 is_carousel_item 容器，再建 CAROUSEL 容器（children），一樣等好再發。
 * - IG 只收 JPEG、長寬比 4:5 到 1.91:1：圖由 CI 先轉成 1080×1350 的 JPEG（見 threads-publish.yml）。
 * - 權杖只從呼叫端傳進來，錯誤訊息遮掉；暫時性錯誤（網路、429、5xx）照 2／4／8／16 秒重試。
 * - 例外：發佈（media_publish）不盲目重試。回應不明時先問呼叫端的 `find`（IG 最近的貼文裡有沒有今天的題號）
 *   和容器狀態：已經發出去就沿用，容器已經 PUBLISHED 卻找不到就停下來，確定還沒發才再發一次。建容器照舊可以重試。
 */

import { ThreadsApiError, redact, type FetchLike } from './threadsApi';

export const INSTAGRAM_GRAPH = 'https://graph.instagram.com';
export const INSTAGRAM_API_VERSION = 'v21.0';
/** IG 貼文說明的上限（字元）。 */
export const INSTAGRAM_CAPTION_MAX = 2200;

export interface InstagramApiOptions {
  token: string;
  userId: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  backoff?: readonly number[];
  pollTries?: number;
  pollMs?: number;
}

export interface RecentMedia {
  id: string;
  caption?: string;
  timestamp?: string;
  permalink?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class InstagramApi {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: readonly number[];

  constructor(private readonly opts: InstagramApiOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? defaultSleep;
    this.backoff = opts.backoff ?? [2000, 4000, 8000, 16000];
  }

  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | undefined> = {}, opts: { retry?: boolean } = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
    q.set('access_token', this.opts.token);
    const url = `${INSTAGRAM_GRAPH}${path}?${q.toString()}`;
    let last: ThreadsApiError | null = null;
    const tries = opts.retry === false ? 0 : this.backoff.length;
    for (let attempt = 0; attempt <= tries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoff[attempt - 1]);
      try {
        const res = await this.fetchImpl(url, { method });
        const body = await res.text();
        if (res.ok) return (body ? JSON.parse(body) : {}) as T;
        const transient = res.status === 429 || res.status >= 500;
        last = new ThreadsApiError(`IG ${method} ${path} → HTTP ${res.status}: ${redact(body, this.opts.token).slice(0, 300)}`, res.status, transient);
        if (!transient) throw last;
      } catch (err) {
        if (err instanceof ThreadsApiError && !err.transient) throw err;
        last = err instanceof ThreadsApiError ? err : new ThreadsApiError(`IG ${method} ${path}: ${redact(String((err as Error).message ?? err), this.opts.token)}`, 0, true);
      }
    }
    throw last ?? new ThreadsApiError(`IG ${method} ${path} failed`, 0, true);
  }

  private v(path: string): string {
    return `/${INSTAGRAM_API_VERSION}${path}`;
  }

  /** 權杖是哪個 IG 帳號（發文的網址要用 user_id）。 */
  async me(): Promise<{ id: string; username?: string }> {
    const r = await this.call<{ id?: string; user_id?: string; username?: string }>('GET', this.v('/me'), { fields: 'id,user_id,username' });
    return { id: String(r.user_id ?? r.id ?? ''), username: r.username };
  }

  /**
   * 正式同步前確認權杖能發文：查得到帳號、查得到發文額度（content_publishing_limit 要 instagram_business_content_publish）、
   * 額度還沒用完。回傳問題（null＝可以發）；確認不了也算問題（呼叫端跳過 IG，不擋 Threads）。
   */
  async publishingProblem(): Promise<string | null> {
    try {
      const me = await this.me();
      if (!me.id) return '查不到 IG 帳號：權杖要有 instagram_business_basic、帳號要是專業帳號';
    } catch (err) {
      return `查不到 IG 帳號（權杖失效或權限不夠）：${(err as Error).message}`;
    }
    try {
      const r = await this.call<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>('GET', this.v(`/${this.opts.userId}/content_publishing_limit`), {
        fields: 'quota_usage,config',
      });
      const d = r.data?.[0];
      if (!d) return '查不到 IG 的發文額度：確認不了發文權限';
      if (d.config?.quota_total !== undefined && (d.quota_usage ?? 0) >= d.config.quota_total) return 'IG 今天的發文額度用完了';
      return null;
    } catch (err) {
      return `確認不了 IG 的發文權限（instagram_business_content_publish）：${(err as Error).message}`;
    }
  }

  /** 長效權杖續期（要至少用了 24 小時、還沒過期）。 */
  async refresh(): Promise<{ token: string; expiresIn: number }> {
    const r = await this.call<{ access_token: string; expires_in?: number }>('GET', '/refresh_access_token', { grant_type: 'ig_refresh_token' });
    return { token: r.access_token, expiresIn: r.expires_in ?? 0 };
  }

  async recentMedia(limit = 25): Promise<RecentMedia[]> {
    const r = await this.call<{ data?: RecentMedia[] }>('GET', this.v(`/${this.opts.userId}/media`), { fields: 'id,caption,timestamp,permalink', limit: String(limit) });
    return r.data ?? [];
  }

  private async waitContainer(id: string): Promise<void> {
    const tries = this.opts.pollTries ?? 12;
    for (let i = 0; i < tries; i++) {
      const r = await this.call<{ status_code?: string; status?: string }>('GET', this.v(`/${id}`), { fields: 'status_code,status' });
      if (r.status_code === 'FINISHED' || r.status_code === 'PUBLISHED' || r.status_code === undefined) return;
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new ThreadsApiError(`IG 容器 ${r.status_code}：${r.status ?? ''}`, 0, false);
      await this.sleep(this.opts.pollMs ?? 5000);
    }
    throw new ThreadsApiError('IG 容器一直沒有處理好（超過等待時間）', 0, true);
  }

  /**
   * 發佈容器：回應不明時不盲目重發，先問 find（已經發出去的那一篇）、再看容器狀態；確定還沒發才再發一次。
   */
  private async publishContainer(creationId: string, find?: () => Promise<string | null>): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.call<{ id: string }>('POST', this.v(`/${this.opts.userId}/media_publish`), { creation_id: creationId }, { retry: false })).id;
      } catch (err) {
        if (!(err instanceof ThreadsApiError) || !err.transient || attempt >= this.backoff.length) throw err;
        await this.sleep(this.backoff[attempt]);
        const found = find ? await find() : null;
        if (found) return found;
        const st = await this.call<{ status_code?: string }>('GET', this.v(`/${creationId}`), { fields: 'status_code,status' });
        if (st.status_code === 'PUBLISHED') throw new ThreadsApiError('IG 容器已經發佈了，但找不到發出去的那一篇：不再重發（避免重複）', 0, false);
      }
    }
  }

  /** 發一篇：一張圖＝單張；兩張以上＝輪播。回 IG 的貼文 id。find：回應不明時找已經發出去的那一篇。 */
  async publish(input: { imageUrls: readonly string[]; caption: string; find?: () => Promise<string | null> }): Promise<string> {
    if (input.imageUrls.length === 0) throw new ThreadsApiError('IG 一定要有圖', 0, false);
    const user = this.opts.userId;
    let creationId: string;
    if (input.imageUrls.length === 1) {
      creationId = (await this.call<{ id: string }>('POST', this.v(`/${user}/media`), { image_url: input.imageUrls[0], caption: input.caption })).id;
    } else {
      const children: string[] = [];
      for (const url of input.imageUrls.slice(0, 10)) {
        const c = await this.call<{ id: string }>('POST', this.v(`/${user}/media`), { image_url: url, is_carousel_item: 'true' });
        await this.waitContainer(c.id);
        children.push(c.id);
      }
      creationId = (await this.call<{ id: string }>('POST', this.v(`/${user}/media`), { media_type: 'CAROUSEL', children: children.join(','), caption: input.caption })).id;
    }
    await this.waitContainer(creationId);
    return this.publishContainer(creationId, input.find);
  }

  async permalink(id: string): Promise<string | undefined> {
    try {
      return (await this.call<{ permalink?: string }>('GET', this.v(`/${id}`), { fields: 'permalink' })).permalink;
    } catch {
      return undefined;
    }
  }
}
