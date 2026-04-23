import { Socket } from 'socket.io';
import { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
}

/**
 * In-memory rate limiter for Socket.IO events
 */
export class SocketRateLimiter {
  private requests: Map<string, { timestamp: number; count: number }> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: RateLimitConfig) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;

    // Cleanup old entries every 5 minutes
    setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  /**
   * Check if request is allowed
   */
  public isAllowed(identifier: string): boolean {
    const now = Date.now();
    const entry = this.requests.get(identifier);

    if (!entry || now - entry.timestamp > this.windowMs) {
      // New time window
      this.requests.set(identifier, { timestamp: now, count: 1 });
      return true;
    }

    if (entry.count < this.maxRequests) {
      entry.count++;
      return true;
    }

    return false;
  }

  /**
   * Get remaining requests for identifier
   */
  public getRemaining(identifier: string): number {
    const entry = this.requests.get(identifier);
    if (!entry) return this.maxRequests;

    const now = Date.now();
    if (now - entry.timestamp > this.windowMs) {
      return this.maxRequests;
    }

    return Math.max(0, this.maxRequests - entry.count);
  }

  /**
   * Reset identifier
   */
  public reset(identifier: string): void {
    this.requests.delete(identifier);
  }

  /**
   * Cleanup old entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    this.requests.forEach((entry, key) => {
      if (now - entry.timestamp > this.windowMs) {
        this.requests.delete(key);
        cleanedCount++;
      }
    });

    if (cleanedCount > 0) {
      console.log(`Rate limiter cleanup: removed ${cleanedCount} entries`);
    }
  }

  /**
   * Get stats
   */
  public getStats(): { entries: number } {
    return { entries: this.requests.size };
  }
}

/**
 * Create Socket.IO middleware for rate limiting
 */
export function createRateLimitMiddleware(
  limiter: SocketRateLimiter,
  eventName: string
): (socket: Socket, next: (err?: Error) => void) => void {
  return (socket: Socket, next: (err?: Error) => void) => {
    const identifier = `${socket.id}:${eventName}`;
    if (!limiter.isAllowed(identifier)) {
      const remaining = limiter.getRemaining(identifier);
      return next(new Error(`Rate limit exceeded for ${eventName}. Remaining: ${remaining}`));
    }
    next();
  };
}

/**
 * Create Express middleware for rate limiting HTTP routes.
 * Uses client IP as the identifier.
 */
export function createHttpRateLimit(
  windowMs: number,
  maxRequests: number,
): (req: Request, res: Response, next: NextFunction) => void {
  const limiter = new SocketRateLimiter({ windowMs, maxRequests });
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';
    if (!limiter.isAllowed(ip)) {
      res.status(429).json({ error: 'Too many requests, please try again later.' });
      return;
    }
    next();
  };
}

/**
 * Key-based rate limiter for Phase A new-login: login throttled by account
 * name (5/15min), forgot-password throttled by email (3/hr). Key is derived
 * per-request from req.body so these limiters kick in BEFORE the expensive
 * password-hash verify / email send, raising the cost of credential stuffing
 * and mail-bombing.
 *
 * Falls back to IP when the expected body field is missing (still protects
 * against unauth'd flood).
 */
export function createKeyedRateLimit(params: {
  windowMs:    number;
  maxRequests: number;
  /** Extract the key from the request body (or fall back to IP). */
  keyFrom:     (req: Request) => string | undefined;
  /** Error message surfaced to the client on 429. */
  message?:    string;
  /** Machine code surfaced to the client on 429. */
  code?:       string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const limiter = new SocketRateLimiter({ windowMs: params.windowMs, maxRequests: params.maxRequests });
  const message = params.message ?? 'Too many requests, please try again later.';
  const code    = params.code    ?? 'rate_limited';
  return (req: Request, res: Response, next: NextFunction) => {
    const extracted = params.keyFrom(req);
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';
    const key = (typeof extracted === 'string' && extracted.length > 0)
      ? extracted.toLowerCase()
      : ip;
    if (!limiter.isAllowed(key)) {
      res.status(429).json({ error: message, code });
      return;
    }
    next();
  };
}
