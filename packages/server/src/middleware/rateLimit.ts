import { Socket } from 'socket.io';

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
): (socket: Socket, next: Function) => void {
  return (socket: Socket, next: Function) => {
    const identifier = `${socket.id}:${eventName}`;
    if (!limiter.isAllowed(identifier)) {
      const remaining = limiter.getRemaining(identifier);
      return next(new Error(`Rate limit exceeded for ${eventName}. Remaining: ${remaining}`));
    }
    next();
  };
}
