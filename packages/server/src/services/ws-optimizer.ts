/**
 * WebSocket Message Optimizer
 * Implements message batching, compression, and debouncing
 */

export interface MessageBatch {
  id: string;
  messages: Record<string, unknown>[];
  timestamp: Date;
  size: number;
}

interface PendingMessage {
  data: Record<string, unknown>;
  timestamp: number;
  priority: 'high' | 'normal' | 'low';
}

class WebSocketOptimizer {
  private messageQueues: Map<string, PendingMessage[]> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private batchSize: number = 10;
  private batchInterval: number = 100; // milliseconds
  private compressionEnabled: boolean = true;
  private stats = {
    messagesSent: 0,
    messagesBatched: 0,
    bytesCompressed: 0,
    averageBatchSize: 0,
  };

  constructor(batchSize: number = 10, batchInterval: number = 100) {
    this.batchSize = batchSize;
    this.batchInterval = batchInterval;
  }

  /**
   * Add message to queue for batching
   */
  queueMessage(clientId: string, data: Record<string, unknown>, priority: 'high' | 'normal' | 'low' = 'normal'): void {
    if (!this.messageQueues.has(clientId)) {
      this.messageQueues.set(clientId, []);
    }

    const queue = this.messageQueues.get(clientId)!;
    queue.push({
      data,
      timestamp: Date.now(),
      priority,
    });

    // Sort by priority (high first)
    queue.sort((a, b) => {
      const priorityMap = { high: 0, normal: 1, low: 2 };
      return priorityMap[a.priority] - priorityMap[b.priority];
    });

    // Check if batch should be sent immediately
    if (queue.length >= this.batchSize) {
      this.flushBatch(clientId);
    } else {
      // Schedule batch flush
      this.scheduleBatchFlush(clientId);
    }
  }

  /**
   * Schedule batch flush with debouncing
   */
  private scheduleBatchFlush(clientId: string): void {
    // Clear existing timer
    if (this.batchTimers.has(clientId)) {
      clearTimeout(this.batchTimers.get(clientId)!);
    }

    // Schedule new flush
    const timer = setTimeout(() => {
      this.flushBatch(clientId);
    }, this.batchInterval);

    this.batchTimers.set(clientId, timer);
  }

  /**
   * Flush pending messages for client
   */
  flushBatch(clientId: string): MessageBatch | null {
    const queue = this.messageQueues.get(clientId);
    if (!queue || queue.length === 0) return null;

    // Clear timer
    if (this.batchTimers.has(clientId)) {
      clearTimeout(this.batchTimers.get(clientId)!);
      this.batchTimers.delete(clientId);
    }

    // Extract messages
    const messages = queue.map((m) => m.data);

    // Create batch
    const batch: MessageBatch = {
      id: `${clientId}-${Date.now()}`,
      messages,
      timestamp: new Date(),
      size: JSON.stringify(messages).length,
    };

    // Clear queue
    this.messageQueues.set(clientId, []);

    // Update stats
    this.updateStats(messages.length, batch.size);

    return batch;
  }

  /**
   * Compress message batch
   */
  compressBatch(batch: MessageBatch): string {
    if (!this.compressionEnabled) {
      return JSON.stringify(batch);
    }

    const json = JSON.stringify(batch);
    // Note: Real compression would use gzip or similar
    // This is a simplified version
    return this.minifyJson(json);
  }

  /**
   * Minify JSON to reduce size
   */
  private minifyJson(json: string): string {
    return json
      .replace(/\s+/g, ' ') // Remove extra whitespace
      .replace(/:\s+/g, ':') // Remove space after colons
      .replace(/,\s+/g, ','); // Remove space after commas
  }

  /**
   * Update statistics
   */
  private updateStats(messageCount: number, batchSize: number): void {
    this.stats.messagesSent += messageCount;
    this.stats.messagesBatched++;
    this.stats.bytesCompressed += batchSize;
    this.stats.averageBatchSize = this.stats.messagesSent / this.stats.messagesBatched;
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Clear queue for client
   */
  clearQueue(clientId: string): void {
    if (this.batchTimers.has(clientId)) {
      clearTimeout(this.batchTimers.get(clientId)!);
      this.batchTimers.delete(clientId);
    }
    this.messageQueues.delete(clientId);
  }

  /**
   * Enable/disable compression
   */
  setCompressionEnabled(enabled: boolean): void {
    this.compressionEnabled = enabled;
  }

  /**
   * Set batch size
   */
  setBatchSize(size: number): void {
    this.batchSize = Math.max(1, size);
  }

  /**
   * Set batch interval
   */
  setBatchInterval(interval: number): void {
    this.batchInterval = Math.max(10, interval);
  }

  /**
   * Get pending messages count
   */
  getPendingMessageCount(clientId: string): number {
    return this.messageQueues.get(clientId)?.length ?? 0;
  }

  /**
   * Get all pending messages count
   */
  getTotalPendingMessages(): number {
    let total = 0;
    this.messageQueues.forEach((queue) => {
      total += queue.length;
    });
    return total;
  }
}

// Singleton instance
const wsOptimizer = new WebSocketOptimizer(10, 100);
export default wsOptimizer;
