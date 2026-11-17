/**
 * Threads API（graph.threads.net v1.0）的最小客戶端：發圖文、發留言、查自己最近的貼文、權杖檢查與續期。
 *
 * - 權杖只從呼叫端傳進來（CI 的 secrets），這裡不印、不存；錯誤訊息裡的網址會把 access_token 換成 ***。
 * - 暫時性的錯誤（網路、HTTP 429、5xx）照 2／4／8／16 秒重試；其他錯誤直接丟出。
 * - `fetch` 與 `sleep` 可以換掉（測試用假的 HTTP）。
 *
 * 官方流程：先建一個「容器」（/{user-id}/threads），等容器處理好（status = FINISHED），
 * 再發佈（/{user-id}/threads_publish）。引用別人的貼文用 quote_post_id；回覆（第一則留言）用 reply_to_id。
 */

export const THREADS_GRAPH = 'https://graph.threads.net';
export const THREADS_API_VERSION = 'v1.0';
/** 發文需要的權限。threads_manage_replies：用 reply_to_id 回覆自己的貼文。 */
/** 輪播最多幾張（Threads 的上限是 20；我們一天最多 3 張）。 */
export const THREADS_CAROUSEL_MAX = 20;
export const REQUIRED_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies'] as const;

export type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface ThreadsApiOptions {
  token: string;
  userId: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** 重試的等待（毫秒），預設 2／4／8／16 秒。 */
  backoff?: readonly number[];
  /** 等容器處理好：最多問幾次、每次隔多久（毫秒）。 */
  pollTries?: number;
  pollMs?: number;
}

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'ThreadsApiError';
  }
}

export interface RecentPost {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
}

export interface TokenInfo {
  valid: boolean;
  scopes: string[];
  /** 到期的 Unix 秒數；0 或沒有＝查不到。 */
  expiresAt: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 錯誤訊息裡不能出現權杖（CI 的紀錄是公開的）。 */
export function redact(text: string, token: string): string {
  let out = text.replace(/access_token=[^&\s"]+/g, 'access_token=***');
  if (token) out = out.split(token).join('***');
  return out;
}

export class ThreadsApi {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: readonly number[];

  constructor(private readonly opts: ThreadsApiOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? defaultSleep;
    this.backoff = opts.backoff ?? [2000, 4000, 8000, 16000];
  }

  private url(path: string, params: Record<string, string | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
    q.set('access_token', this.opts.token);
    return `${THREADS_GRAPH}${path}?${q.toString()}`;
  }

  /** 一次 HTTP 呼叫＋重試；回 JSON。 */
  private async call<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    let last: ThreadsApiError | null = null;
    for (let attempt = 0; attempt <= this.backoff.length; attempt++) {
      if (attempt > 0) await this.sleep(this.backoff[attempt - 1]);
      try {
        const res = await this.fetchImpl(this.url(path, params), { method });
        const body = await res.text();
        if (res.ok) return (body ? JSON.parse(body) : {}) as T;
        const transient = res.status === 429 || res.status >= 500;
        last = new ThreadsApiError(`${method} ${path} → HTTP ${res.status}: ${redact(body, this.opts.token).slice(0, 300)}`, res.status, transient);
        if (!transient) throw last;
      } catch (err) {
        if (err instanceof ThreadsApiError && !err.transient) throw err;
        last = err instanceof ThreadsApiError ? err : new ThreadsApiError(`${method} ${path}: ${redact(String((err as Error).message ?? err), this.opts.token)}`, 0, true);
      }
    }
    throw last ?? new ThreadsApiError(`${method} ${path} failed`, 0, true);
  }

  private v(path: string): string {
    return `/${THREADS_API_VERSION}${path}`;
  }

  /** 權杖是誰的。 */
  async me(): Promise<{ id: string; username?: string }> {
    return this.call('GET', this.v('/me'), { fields: 'id,username' });
  }

  /** 權杖的權限與到期日（查不到時 valid=true、scopes 空：由呼叫端決定要不要擋）。 */
  async tokenInfo(): Promise<TokenInfo | null> {
    try {
      const r = await this.call<{ data?: { is_valid?: boolean; scopes?: string[]; expires_at?: number } }>('GET', this.v('/debug_token'), {
        input_token: this.opts.token,
      });
      const d = r.data ?? {};
      return { valid: d.is_valid !== false, scopes: d.scopes ?? [], expiresAt: d.expires_at ?? 0 };
    } catch {
      return null;
    }
  }

  /** 長效權杖續期（要至少用了 24 小時、還沒過期）；回新的權杖與幾秒後到期。 */
  async refresh(): Promise<{ token: string; expiresIn: number }> {
    const r = await this.call<{ access_token: string; expires_in?: number }>('GET', '/refresh_access_token', { grant_type: 'th_refresh_token' });
    return { token: r.access_token, expiresIn: r.expires_in ?? 0 };
  }

  /** 自己最近的貼文（找手動發過的、或上次發了卻沒記下來的）。 */
  async recentPosts(limit = 25): Promise<RecentPost[]> {
    const r = await this.call<{ data?: RecentPost[] }>('GET', this.v(`/${this.opts.userId}/threads`), { fields: 'id,text,timestamp,permalink', limit: String(limit) });
    return r.data ?? [];
  }

  private async waitContainer(id: string): Promise<void> {
    const tries = this.opts.pollTries ?? 12;
    for (let i = 0; i < tries; i++) {
      const r = await this.call<{ status?: string; error_message?: string }>('GET', this.v(`/${id}`), { fields: 'status,error_message' });
      if (r.status === 'FINISHED' || r.status === 'PUBLISHED' || r.status === undefined) return;
      if (r.status === 'ERROR' || r.status === 'EXPIRED') throw new ThreadsApiError(`容器 ${r.status}：${r.error_message ?? ''}`, 0, false);
      await this.sleep(this.opts.pollMs ?? 5000);
    }
    throw new ThreadsApiError('容器一直沒有處理好（超過等待時間）', 0, true);
  }

  /** 建容器 → 等 → 發佈；回貼文 id。 */
  private async createAndPublish(params: Record<string, string | undefined>): Promise<string> {
    const c = await this.call<{ id: string }>('POST', this.v(`/${this.opts.userId}/threads`), params);
    await this.waitContainer(c.id);
    const p = await this.call<{ id: string }>('POST', this.v(`/${this.opts.userId}/threads_publish`), { creation_id: c.id });
    return p.id;
  }

  /**
   * 新貼文：沒有圖＝純文字；一張＝圖文；兩張以上＝輪播（每張先建 is_carousel_item 容器，
   * 再建 CAROUSEL 容器帶文字與引用）。quotePostId＝引用昨天的貼文。
   */
  async publishPost(input: { text: string; imageUrl?: string; imageUrls?: readonly string[]; quotePostId?: string }): Promise<string> {
    const urls = (input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : []).slice(0, THREADS_CAROUSEL_MAX);
    if (urls.length <= 1) {
      return this.createAndPublish({
        media_type: urls.length === 1 ? 'IMAGE' : 'TEXT',
        text: input.text,
        image_url: urls[0],
        quote_post_id: input.quotePostId,
      });
    }
    const children: string[] = [];
    for (const url of urls) {
      const c = await this.call<{ id: string }>('POST', this.v(`/${this.opts.userId}/threads`), { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true' });
      await this.waitContainer(c.id);
      children.push(c.id);
    }
    return this.createAndPublish({ media_type: 'CAROUSEL', children: children.join(','), text: input.text, quote_post_id: input.quotePostId });
  }

  /** 回覆（第一則留言）。 */
  async publishReply(input: { text: string; replyToId: string }): Promise<string> {
    return this.createAndPublish({ media_type: 'TEXT', text: input.text, reply_to_id: input.replyToId });
  }

  async permalink(id: string): Promise<string | undefined> {
    try {
      const r = await this.call<{ permalink?: string }>('GET', this.v(`/${id}`), { fields: 'permalink' });
      return r.permalink;
    } catch {
      return undefined;
    }
  }
}
