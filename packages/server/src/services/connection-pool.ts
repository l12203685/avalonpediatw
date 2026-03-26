/**
 * Connection Pool Manager
 * Manages and optimizes database and external service connections
 */

export interface PoolConfig {
  minConnections: number;
  maxConnections: number;
  idleTimeout: number; // milliseconds
  acquireTimeout: number; // milliseconds
  connectionTimeout: number; // milliseconds
}

export interface PoolStats {
  active: number;
  idle: number;
  waiting: number;
  totalAcquired: number;
  totalReleased: number;
  averageAcquireTime: number;
  averageIdleTime: number;
}

interface Connection {
  id: string;
  createdAt: Date;
  acquiredAt: Date | null;
  isActive: boolean;
  lastUsedAt: Date;
}

class ConnectionPool {
  private config: PoolConfig;
  private connections: Map<string, Connection> = new Map();
  private availableConnections: Set<string> = new Set();
  private waitingRequests: Array<{
    resolve: (connId: string) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }> = [];

  private stats = {
    active: 0,
    idle: 0,
    waiting: 0,
    totalAcquired: 0,
    totalReleased: 0,
    acquireTimes: [] as number[],
    idleTimes: [] as number[],
  };

  private maintenanceInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = {
      minConnections: config.minConnections ?? 5,
      maxConnections: config.maxConnections ?? 20,
      idleTimeout: config.idleTimeout ?? 600000, // 10 minutes
      acquireTimeout: config.acquireTimeout ?? 30000, // 30 seconds
      connectionTimeout: config.connectionTimeout ?? 5000, // 5 seconds
    };

    this.initialize();
  }

  /**
   * Initialize connection pool
   */
  private initialize(): void {
    // Create minimum connections
    for (let i = 0; i < this.config.minConnections; i++) {
      this.createConnection();
    }

    // Start maintenance task
    this.startMaintenance();
  }

  /**
   * Create a new connection
   */
  private createConnection(): void {
    if (this.connections.size >= this.config.maxConnections) {
      return;
    }

    const id = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const connection: Connection = {
      id,
      createdAt: new Date(),
      acquiredAt: null,
      isActive: false,
      lastUsedAt: new Date(),
    };

    this.connections.set(id, connection);
    this.availableConnections.add(id);
    this.updateStats();
  }

  /**
   * Acquire a connection from the pool
   */
  async acquireConnection(): Promise<string> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Check for available connection
      if (this.availableConnections.size > 0) {
        const connId = Array.from(this.availableConnections)[0];
        this.availableConnections.delete(connId);

        const connection = this.connections.get(connId)!;
        connection.acquiredAt = new Date();
        connection.isActive = true;

        const acquireTime = Date.now() - startTime;
        this.stats.acquireTimes.push(acquireTime);
        this.stats.totalAcquired++;
        this.updateStats();

        resolve(connId);
        return;
      }

      // Create new connection if below max
      if (this.connections.size < this.config.maxConnections) {
        this.createConnection();
        this.acquireConnection().then(resolve).catch(reject);
        return;
      }

      // Queue waiting request
      const request = { resolve, reject, timestamp: Date.now() };
      this.waitingRequests.push(request);

      // Set timeout for acquire
      const timeoutId = setTimeout(() => {
        const index = this.waitingRequests.indexOf(request);
        if (index !== -1) {
          this.waitingRequests.splice(index, 1);
          reject(new Error(`Acquire timeout after ${this.config.acquireTimeout}ms`));
        }
      }, this.config.acquireTimeout);

      // Clean up timeout when resolved
      const originalResolve = request.resolve;
      request.resolve = (value: string | PromiseLike<string>) => {
        clearTimeout(timeoutId);
        originalResolve(value);
      };
    });
  }

  /**
   * Release a connection back to the pool
   */
  releaseConnection(connId: string): void {
    const connection = this.connections.get(connId);
    if (!connection) {
      console.warn(`Connection ${connId} not found in pool`);
      return;
    }

    connection.isActive = false;
    connection.lastUsedAt = new Date();

    // Track idle time
    if (connection.acquiredAt) {
      const idleTime = connection.lastUsedAt.getTime() - connection.acquiredAt.getTime();
      this.stats.idleTimes.push(idleTime);
    }

    this.stats.totalReleased++;

    // Check if there are waiting requests
    if (this.waitingRequests.length > 0) {
      const request = this.waitingRequests.shift()!;
      request.resolve(connId);
      connection.acquiredAt = new Date();
      connection.isActive = true;
    } else {
      this.availableConnections.add(connId);
    }

    this.updateStats();
  }

  /**
   * Start maintenance tasks
   */
  private startMaintenance(): void {
    this.maintenanceInterval = setInterval(() => {
      this.performMaintenance();
    }, 60000); // Every minute
  }

  /**
   * Perform maintenance on the pool
   */
  private performMaintenance(): void {
    const now = Date.now();

    // Remove idle connections if above minimum
    const connectionsToRemove: string[] = [];
    this.availableConnections.forEach((connId) => {
      const connection = this.connections.get(connId)!;
      const idleTime = now - connection.lastUsedAt.getTime();

      if (
        idleTime > this.config.idleTimeout &&
        this.availableConnections.size - connectionsToRemove.length > this.config.minConnections
      ) {
        connectionsToRemove.push(connId);
      }
    });

    connectionsToRemove.forEach((connId) => {
      this.connections.delete(connId);
      this.availableConnections.delete(connId);
    });

    this.updateStats();
  }

  /**
   * Update pool statistics
   */
  private updateStats(): void {
    this.stats.active = Array.from(this.connections.values()).filter((c) => c.isActive).length;
    this.stats.idle = this.availableConnections.size;
    this.stats.waiting = this.waitingRequests.length;
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const avgAcquireTime =
      this.stats.acquireTimes.length > 0
        ? this.stats.acquireTimes.reduce((a, b) => a + b) / this.stats.acquireTimes.length
        : 0;

    const avgIdleTime =
      this.stats.idleTimes.length > 0
        ? this.stats.idleTimes.reduce((a, b) => a + b) / this.stats.idleTimes.length
        : 0;

    return {
      active: this.stats.active,
      idle: this.stats.idle,
      waiting: this.stats.waiting,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
      averageAcquireTime: avgAcquireTime,
      averageIdleTime: avgIdleTime,
    };
  }

  /**
   * Get pool size
   */
  getPoolSize(): { current: number; min: number; max: number } {
    return {
      current: this.connections.size,
      min: this.config.minConnections,
      max: this.config.maxConnections,
    };
  }

  /**
   * Drain the pool and close all connections
   */
  async drain(): Promise<void> {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
    }

    // Wait for active connections to finish
    while (this.stats.active > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.connections.clear();
    this.availableConnections.clear();
    this.waitingRequests = [];
  }
}

// Singleton instance with default config
const connectionPool = new ConnectionPool({
  minConnections: 5,
  maxConnections: 20,
  idleTimeout: 600000,
  acquireTimeout: 30000,
  connectionTimeout: 5000,
});

export default connectionPool;
