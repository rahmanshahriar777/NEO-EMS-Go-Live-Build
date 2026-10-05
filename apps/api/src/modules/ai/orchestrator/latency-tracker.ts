export class LatencyTracker {
  private readonly windowSize = 50;
  private readonly latencies: number[] = [];
  private readonly outcomes: boolean[] = []; // true = success, false = error
  private lastSuccessTime: Date | null = null;
  private lastErrorTime: Date | null = null;
  private lastErrorMessage: string | null = null;

  recordLatency(ms: number, success: boolean, errorMessage?: string): void {
    this.latencies.push(ms);
    if (this.latencies.length > this.windowSize) {
      this.latencies.shift();
    }

    this.outcomes.push(success);
    if (this.outcomes.length > this.windowSize) {
      this.outcomes.shift();
    }

    if (success) {
      this.lastSuccessTime = new Date();
    } else {
      this.lastErrorTime = new Date();
      this.lastErrorMessage = errorMessage || 'Unknown error';
    }
  }

  getPercentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(
      Math.floor((p / 100) * sorted.length),
      sorted.length - 1,
    );
    return Math.round(sorted[index]);
  }

  getP50(): number {
    return this.getPercentile(50);
  }

  getP95(): number {
    return this.getPercentile(95);
  }

  getErrorRate(): number {
    if (this.outcomes.length === 0) return 0;
    const errors = this.outcomes.filter((s) => !s).length;
    return parseFloat((errors / this.outcomes.length).toFixed(3));
  }

  getLastSuccess(): string | null {
    return this.lastSuccessTime?.toISOString() || null;
  }

  getLastError(): string | null {
    return this.lastErrorMessage || null;
  }
}
