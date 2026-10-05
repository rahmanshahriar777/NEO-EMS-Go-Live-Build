/**
 * Minimal Prometheus-format metrics registry (Phase 1 observability).
 *
 * Zero dependencies, framework-free: any service (API, worker) can register
 * counters/gauges/histograms and expose `renderPrometheus()` behind a
 * GUARDED `/metrics` endpoint (guard = same auth chain as the API's admin
 * routes; never public — metric labels can leak operational detail).
 *
 * This is intentionally not prom-client: the API image stays lean and the
 * worker (plain Node, no Nest) can use the same registry. If richer
 * instrumentation is ever needed, replace the internals — the
 * `renderPrometheus()` output format is the stable contract.
 */

export type MetricLabels = Record<string, string>;

interface Sample {
  labels: MetricLabels;
  value: number;
}

function formatLabels(labels: MetricLabels): string {
  const parts = Object.entries(labels).map(
    ([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  );
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

class Counter {
  private samples = new Map<string, Sample>();
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  inc(labels: MetricLabels = {}, by = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.samples.get(key);
    const value = (existing?.value ?? 0) + by;
    this.samples.set(key, { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private samples = new Map<string, Sample>();
  constructor(
    private readonly name: string,
    private readonly help: string,
  ) {}

  set(value: number, labels: MetricLabels = {}): void {
    this.samples.set(JSON.stringify(labels), { labels, value });
  }

  inc(labels: MetricLabels = {}, by = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.samples.get(key);
    this.samples.set(key, { labels, value: (existing?.value ?? 0) + by });
  }

  dec(labels: MetricLabels = {}, by = 1): void {
    this.inc(labels, -by);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const s of this.samples.values()) {
      lines.push(`${this.name}${formatLabels(s.labels)} ${s.value}`);
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Histogram {
  private buckets: number[];
  private counts = new Map<string, { labels: MetricLabels; counts: number[]; sum: number; total: number }>();
  constructor(
    private readonly name: string,
    private readonly help: string,
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: MetricLabels = {}): void {
    const key = JSON.stringify(labels);
    let entry = this.counts.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length + 1).fill(0), sum: 0, total: 0 };
      this.counts.set(key, entry);
    }
    const idx = this.buckets.findIndex((b) => value <= b);
    const bucketIdx = idx === -1 ? this.buckets.length : idx;
    entry.counts[bucketIdx] += 1;
    entry.sum += value;
    entry.total += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const entry of this.counts.values()) {
      let cumulative = 0;
      this.buckets.forEach((b, i) => {
        cumulative += entry.counts[i];
        lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: String(b) })} ${cumulative}`);
      });
      cumulative += entry.counts[this.buckets.length];
      lines.push(`${this.name}_bucket${formatLabels({ ...entry.labels, le: '+Inf' })} ${cumulative}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.total}`);
    }
    return lines.join('\n');
  }
}

/**
 * Process-global registry. Services register their metrics once at startup
 * and render on each guarded /metrics scrape.
 */
class MetricsRegistry {
  private metrics: Array<Counter | Gauge | Histogram> = [];

  counter(name: string, help: string): Counter {
    const m = new Counter(name, help);
    this.metrics.push(m);
    return m;
  }

  gauge(name: string, help: string): Gauge {
    const m = new Gauge(name, help);
    this.metrics.push(m);
    return m;
  }

  histogram(name: string, help: string, buckets?: number[]): Histogram {
    const m = new Histogram(name, help, buckets);
    this.metrics.push(m);
    return m;
  }

  renderPrometheus(): string {
    return this.metrics.map((m) => m.render()).join('\n') + '\n';
  }

  reset(): void {
    this.metrics = [];
  }
}

export const metrics = new MetricsRegistry();
