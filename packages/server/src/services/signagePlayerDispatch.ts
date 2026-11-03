/**
 * 補位機器人（signage-cloud seat filler, 2026-11-03）— dispatch service.
 *
 * Players ask the bot (Discord /機器人補位, LINE /補位) to put our signage-cloud
 * seat-filler bot into a game room for testing. The bot itself runs in a GitHub
 * Actions workflow (`.github/workflows/signage-player.yml`, workflow_dispatch
 * inputs `room`, `games` 1–3, `hours` 1–3); this module only validates the
 * request, applies the abuse limits and POSTs the workflow_dispatch:
 *
 *   POST https://api.github.com/repos/{repo}/actions/workflows/{file}/dispatches
 *   { ref: 'main', inputs: { room: 'Room-1460', games: '1' } }
 *
 * Env (read on every call, so a Render env change + restart is all it takes):
 *   GITHUB_DISPATCH_TOKEN    fine-grained PAT, this repo only, Actions: Read and write.
 *                            Unset → the commands answer "not configured yet". Never logged.
 *   SIGNAGE_PLAYER_WORKFLOW  workflow file name (default signage-player.yml)
 *   GITHUB_DISPATCH_REPO     owner/repo (default l12203685/avalonpediatw)
 *   GITHUB_API_BASE          API base (default https://api.github.com; shared with GitHubGameArchive)
 *
 * Limits (in memory, per process — Render runs one instance):
 *   - global cooldown: one dispatch per 3 minutes;
 *   - at most 10 dispatches per Taipei (+08) calendar day;
 *   - the same room again within 15 minutes is rejected.
 * A slot is reserved before the request (two commands can arrive together) and
 * given back when GitHub answers with an error status, so a misconfiguration
 * never eats the day's quota. A network error / timeout keeps the slot: GitHub
 * may have accepted the dispatch, and a second bot in the same room is worse
 * than a short wait.
 *
 * Logs carry status codes and fixed words only — no user names, no message
 * text, no token (same rule as bots/feedback/service.ts describeError).
 *
 * docs/BOT_SETUP.md「補位機器人」.
 */

export const SEAT_FILLER_DEFAULTS = {
  workflow: 'signage-player.yml',
  repo: 'l12203685/avalonpediatw',
  apiBase: 'https://api.github.com',
  ref: 'main',
} as const;

export interface SeatFillerLimits {
  /** Minimum gap between two dispatches, any room (ms). */
  cooldownMs: number;
  /** Dispatches per Taipei calendar day. */
  dailyMax: number;
  /** The same room cannot be dispatched again within this window (ms). */
  sameRoomMs: number;
}

export const SEAT_FILLER_LIMITS: SeatFillerLimits = {
  cooldownMs: 3 * 60 * 1000,
  dailyMax: 10,
  sameRoomMs: 15 * 60 * 1000,
};

export const SEAT_FILLER_GAMES = { min: 1, max: 3, default: 1 } as const;

/** GitHub request timeout: LINE answers after this call, and its webhook must return promptly. */
export const SEAT_FILLER_DISPATCH_TIMEOUT_MS = 8000;

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

// ─── Parsing ─────────────────────────────────────────────────────────────

export interface SeatFillerRequest {
  /** Canonical room name, e.g. "Room-1460". */
  room: string;
  games: number;
}

export type SeatFillerParseError = 'usage' | 'room' | 'games';

export type SeatFillerParse =
  | { ok: true; request: SeatFillerRequest }
  | { ok: false; error: SeatFillerParseError };

/**
 * "Room-1460" / "room-1460" / "ROOM-1460" / "1460" → "Room-1460"; anything
 * else → null. Full-width characters are folded first (ＲＯＯＭ－１４６０ from a
 * phone IME). Digits are kept as typed (1–6 of them).
 */
export function normalizeRoom(raw: string | null | undefined): string | null {
  const t = (raw ?? '').normalize('NFKC').trim();
  const m = /^(?:room-)?(\d{1,6})$/i.exec(t);
  return m ? `Room-${m[1]}` : null;
}

/**
 * Number of games: empty → 1; an integer 1–3 (a trailing 局 is fine: "2局")
 * → that number; anything else → null.
 */
export function parseGames(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return SEAT_FILLER_GAMES.default;
  const t = typeof raw === 'number' ? String(raw) : raw.normalize('NFKC').trim().replace(/局$/u, '').trim();
  if (t === '') return SEAT_FILLER_GAMES.default;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= SEAT_FILLER_GAMES.min && n <= SEAT_FILLER_GAMES.max ? n : null;
}

/** Validate a room + games pair (Discord options, or the LINE text's arguments). */
export function parseSeatFillerArgs(roomRaw: string | null | undefined, gamesRaw?: string | number | null): SeatFillerParse {
  if (!(roomRaw ?? '').trim()) return { ok: false, error: 'usage' };
  const room = normalizeRoom(roomRaw);
  if (!room) return { ok: false, error: 'room' };
  const games = parseGames(gamesRaw);
  if (games === null) return { ok: false, error: 'games' };
  return { ok: true, request: { room, games } };
}

// ─── Dispatch ────────────────────────────────────────────────────────────

export type SeatFillerOutcome =
  | { kind: 'dispatched'; room: string; games: number }
  | { kind: 'not_configured' }
  | { kind: 'cooldown'; retryAfterMs: number }
  | { kind: 'daily_cap'; max: number }
  | { kind: 'duplicate_room'; room: string; retryAfterMs: number }
  /** status null = no HTTP answer (network error / timeout). */
  | { kind: 'github_error'; status: number | null };

export type SeatFillerRejection = Exclude<SeatFillerOutcome, { kind: 'dispatched' } | { kind: 'github_error' }>;

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; ok: boolean }>;

export interface SeatFillerDispatcherOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** Env source, read per call (tests pass a plain object). */
  env?: () => NodeJS.ProcessEnv;
  limits?: Partial<SeatFillerLimits>;
  timeoutMs?: number;
  /** Receives fixed words and status codes only. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

interface DispatchTarget {
  url: string;
  token: string;
}

/** Taipei calendar day of an epoch-ms instant, e.g. "2026-11-03". */
export function taipeiDayKey(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export class SignagePlayerDispatcher {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly limits: SeatFillerLimits;
  private readonly timeoutMs: number;
  private readonly logger: NonNullable<SeatFillerDispatcherOptions['logger']>;

  /** Epoch ms of the latest dispatch (reserved or sent). */
  private lastAt: number | null = null;
  private day = '';
  private dayCount = 0;
  /** Room → epoch ms of its latest dispatch. */
  private readonly roomAt = new Map<string, number>();

  constructor(opts: SeatFillerDispatcherOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? (() => process.env);
    this.limits = { ...SEAT_FILLER_LIMITS, ...opts.limits };
    this.timeoutMs = opts.timeoutMs ?? SEAT_FILLER_DISPATCH_TIMEOUT_MS;
    this.logger = opts.logger ?? {
      info: (m): void => console.log(`[seat-filler] ${m}`),
      warn: (m): void => console.warn(`[seat-filler] ${m}`),
    };
  }

  /** True when a token is set (repo / workflow fall back to their defaults). */
  isConfigured(): boolean {
    return this.target() !== null;
  }

  /**
   * Why `req` would be refused right now, or null when it would be sent.
   * Order: not configured → daily cap → same room → global cooldown.
   */
  check(req: SeatFillerRequest): SeatFillerRejection | null {
    if (!this.target()) return { kind: 'not_configured' };
    const now = this.now();
    if (this.countToday(now) >= this.limits.dailyMax) return { kind: 'daily_cap', max: this.limits.dailyMax };
    const roomLast = this.roomAt.get(req.room);
    if (roomLast !== undefined && now - roomLast < this.limits.sameRoomMs) {
      return { kind: 'duplicate_room', room: req.room, retryAfterMs: this.limits.sameRoomMs - (now - roomLast) };
    }
    if (this.lastAt !== null && now - this.lastAt < this.limits.cooldownMs) {
      return { kind: 'cooldown', retryAfterMs: this.limits.cooldownMs - (now - this.lastAt) };
    }
    return null;
  }

  /** Validate limits, reserve a slot, POST the workflow_dispatch. Never throws. */
  async dispatch(req: SeatFillerRequest): Promise<SeatFillerOutcome> {
    const rejected = this.check(req);
    if (rejected) {
      if (rejected.kind !== 'not_configured') this.logger.info(`refused (${rejected.kind})`);
      else this.logger.warn('refused (GITHUB_DISPATCH_TOKEN not set)');
      return rejected;
    }
    const target = this.target() as DispatchTarget;
    const at = this.now();
    const undo = this.reserve(req.room, at);

    let status: number;
    let ok: boolean;
    try {
      const res = await this.fetchFn(target.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'avalonpediatw-seat-filler',
        },
        body: JSON.stringify({ ref: SEAT_FILLER_DEFAULTS.ref, inputs: { room: req.room, games: String(req.games) } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      ok = res.ok;
    } catch (err) {
      // Name only: the error never needs more, and nothing user-typed or secret can leak.
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.warn(`dispatch got no answer (${name}); slot kept`);
      return { kind: 'github_error', status: null };
    }
    if (!ok) {
      undo();
      this.logger.warn(`dispatch failed (status=${status})`);
      return { kind: 'github_error', status };
    }
    this.logger.info(`dispatched (status=${status}, games=${req.games})`);
    return { kind: 'dispatched', room: req.room, games: req.games };
  }

  /** Dispatches counted for the Taipei day of `now`. */
  private countToday(now: number): number {
    const key = taipeiDayKey(now);
    if (key !== this.day) {
      this.day = key;
      this.dayCount = 0;
    }
    return this.dayCount;
  }

  /** Take the slot; the returned function gives it back (only if nothing newer replaced it). */
  private reserve(room: string, at: number): () => void {
    const prev = { lastAt: this.lastAt, roomAt: this.roomAt.get(room), day: taipeiDayKey(at) };
    this.countToday(at);
    this.dayCount += 1;
    this.lastAt = at;
    this.roomAt.set(room, at);
    this.pruneRooms(at);
    return () => {
      if (this.day === prev.day && this.dayCount > 0) this.dayCount -= 1;
      if (this.lastAt === at) this.lastAt = prev.lastAt;
      if (this.roomAt.get(room) === at) {
        if (prev.roomAt === undefined) this.roomAt.delete(room);
        else this.roomAt.set(room, prev.roomAt);
      }
    };
  }

  private pruneRooms(now: number): void {
    for (const [room, t] of this.roomAt) {
      if (now - t >= this.limits.sameRoomMs) this.roomAt.delete(room);
    }
  }

  /** The dispatch URL + token, or null when the token is unset or a setting is malformed. */
  private target(): DispatchTarget | null {
    const env = this.env();
    const token = (env.GITHUB_DISPATCH_TOKEN ?? '').trim();
    if (!token) return null;
    const repo = (env.GITHUB_DISPATCH_REPO ?? '').trim() || SEAT_FILLER_DEFAULTS.repo;
    const workflow = (env.SIGNAGE_PLAYER_WORKFLOW ?? '').trim() || SEAT_FILLER_DEFAULTS.workflow;
    const apiBase = ((env.GITHUB_API_BASE ?? '').trim() || SEAT_FILLER_DEFAULTS.apiBase).replace(/\/+$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    if (!/^(?:[\w.-]+\.ya?ml|\d+)$/.test(workflow)) return null;
    return {
      url: `${apiBase}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      token,
    };
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────

let instance: SignagePlayerDispatcher | null = null;

/** Process-wide dispatcher (one set of limits shared by Discord and LINE). */
export function getSignagePlayerDispatcher(): SignagePlayerDispatcher {
  if (!instance) instance = new SignagePlayerDispatcher();
  return instance;
}

/** Test-only: replace (or drop, with no argument) the singleton. */
export function __setSignagePlayerDispatcherForTests(d?: SignagePlayerDispatcher): void {
  instance = d ?? null;
}
