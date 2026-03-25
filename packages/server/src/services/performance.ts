/**
 * Performance Monitoring Service
 * Tracks and analyzes application performance metrics
 */

export interface PerformanceMetrics {
  timestamp: Date;
  wsLatency: number; // milliseconds
  wsMessagesPerSecond: number;
  cpuUsage: number; // percentage
  memoryUsage: number; // bytes
  activeConnections: number;
  gameRoomsActive: number;
  averageResponseTime: number; // milliseconds
}

export interface PerformanceReport {
  period: string;
  startTime: Date;
  endTime: Date;
  metrics: PerformanceMetrics[];
  summary: {
    avgWsLatency: number;
    maxWsLatency: number;
    minWsLatency: number;
    avgMessagesPerSecond: number;
    peakMessagesPerSecond: number;
    avgMemoryUsage: number;
    peakMemoryUsage: number;
    avgCpuUsage: number;
    peakCpuUsage: number;
    totalConnections: number;
  };
}

class PerformanceMonitor {
  private metrics: PerformanceMetrics[] = [];
  private wsLatencies: number[] = [];
  private messageCountWindow: number[] = [];
  private responseTimes: number[] = [];
  private windowSize: number = 60; // 60 seconds
  private maxMetricsHistory: number = 1440; // 24 hours * 60 minutes

  constructor() {
    this.startMonitoring();
  }

  /**
   * Start periodic monitoring
   */
  private startMonitoring(): void {
    setInterval(() => {
      this.recordMetrics();
    }, 1000); // Every second
  }

  /**
   * Record current metrics
   */
  private recordMetrics(): void {
    const metrics: PerformanceMetrics = {
      timestamp: new Date(),
      wsLatency: this.calculateAverageLatency(),
      wsMessagesPerSecond: this.calculateMessagesPerSecond(),
      cpuUsage: this.getCpuUsage(),
      memoryUsage: process.memoryUsage().heapUsed,
      activeConnections: 0, // Would be set by server
      gameRoomsActive: 0, // Would be set by server
      averageResponseTime: this.calculateAverageResponseTime(),
    };

    this.metrics.push(metrics);

    // Keep only recent metrics
    if (this.metrics.length > this.maxMetricsHistory) {
      this.metrics.shift();
    }
  }

  /**
   * Record WebSocket latency
   */
  recordWsLatency(latency: number): void {
    this.wsLatencies.push(latency);
    if (this.wsLatencies.length > this.windowSize * 10) {
      this.wsLatencies.shift();
    }
  }

  /**
   * Record message count
   */
  recordMessage(): void {
    const now = Date.now();
    this.messageCountWindow.push(now);

    // Remove old messages (older than window size)
    this.messageCountWindow = this.messageCountWindow.filter(
      (time) => now - time < this.windowSize * 1000
    );
  }

  /**
   * Record response time
   */
  recordResponseTime(duration: number): void {
    this.responseTimes.push(duration);
    if (this.responseTimes.length > this.windowSize * 10) {
      this.responseTimes.shift();
    }
  }

  /**
   * Calculate average WebSocket latency
   */
  private calculateAverageLatency(): number {
    if (this.wsLatencies.length === 0) return 0;
    const sum = this.wsLatencies.reduce((a, b) => a + b, 0);
    return sum / this.wsLatencies.length;
  }

  /**
   * Calculate messages per second
   */
  private calculateMessagesPerSecond(): number {
    return this.messageCountWindow.length / this.windowSize;
  }

  /**
   * Calculate average response time
   */
  private calculateAverageResponseTime(): number {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return sum / this.responseTimes.length;
  }

  /**
   * Get CPU usage percentage
   */
  private getCpuUsage(): number {
    // Simplified CPU usage - would need more sophisticated tracking
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000000; // Convert to percentage
  }

  /**
   * Update active connections count
   */
  updateActiveConnections(count: number): void {
    if (this.metrics.length > 0) {
      this.metrics[this.metrics.length - 1].activeConnections = count;
    }
  }

  /**
   * Update active game rooms count
   */
  updateGameRooms(count: number): void {
    if (this.metrics.length > 0) {
      this.metrics[this.metrics.length - 1].gameRoomsActive = count;
    }
  }

  /**
   * Get current metrics
   */
  getCurrentMetrics(): PerformanceMetrics | null {
    return this.metrics.length > 0 ? this.metrics[this.metrics.length - 1] : null;
  }

  /**
   * Get performance report for period
   */
  getReport(minutes: number = 60): PerformanceReport {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - minutes * 60 * 1000);

    const relevantMetrics = this.metrics.filter(
      (m) => m.timestamp >= startTime && m.timestamp <= endTime
    );

    const wsLatencies = relevantMetrics.map((m) => m.wsLatency);
    const memoryUsages = relevantMetrics.map((m) => m.memoryUsage);
    const cpuUsages = relevantMetrics.map((m) => m.cpuUsage);
    const messagesPerSecond = relevantMetrics.map((m) => m.wsMessagesPerSecond);

    return {
      period: `${minutes} minutes`,
      startTime,
      endTime,
      metrics: relevantMetrics,
      summary: {
        avgWsLatency: this.average(wsLatencies),
        maxWsLatency: Math.max(...wsLatencies, 0),
        minWsLatency: Math.min(...wsLatencies, 0),
        avgMessagesPerSecond: this.average(messagesPerSecond),
        peakMessagesPerSecond: Math.max(...messagesPerSecond, 0),
        avgMemoryUsage: this.average(memoryUsages),
        peakMemoryUsage: Math.max(...memoryUsages, 0),
        avgCpuUsage: this.average(cpuUsages),
        peakCpuUsage: Math.max(...cpuUsages, 0),
        totalConnections: relevantMetrics.length,
      },
    };
  }

  /**
   * Calculate average of array
   */
  private average(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Get performance summary
   */
  getSummary(): Record<string, unknown> {
    const current = this.getCurrentMetrics();
    const report = this.getReport(60);

    return {
      current,
      last60minutes: report.summary,
      health: this.getHealthStatus(),
    };
  }

  /**
   * Determine health status
   */
  private getHealthStatus(): 'good' | 'warning' | 'critical' {
    const current = this.getCurrentMetrics();
    if (!current) return 'good';

    const memoryGbUsed = current.memoryUsage / (1024 * 1024 * 1024);
    const cpuTooHigh = current.cpuUsage > 80;
    const memoryTooHigh = memoryGbUsed > 1;
    const latencyTooHigh = current.wsLatency > 500;

    if (cpuTooHigh || memoryTooHigh || latencyTooHigh) {
      return 'critical';
    } else if (current.cpuUsage > 60 || memoryGbUsed > 0.8 || current.wsLatency > 300) {
      return 'warning';
    }
    return 'good';
  }
}

// Singleton instance
const performanceMonitor = new PerformanceMonitor();
export default performanceMonitor;
