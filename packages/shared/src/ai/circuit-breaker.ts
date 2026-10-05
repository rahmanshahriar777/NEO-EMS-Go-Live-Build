/**
 * Pure circuit breaker for AI provider failover.
 *
 * Ported from the API's orchestrator (`apps/api/.../orchestrator/circuit-breaker.ts`)
 * with the NestJS `Logger` dependency removed so both the API orchestrator and
 * the BullMQ worker can share one implementation. Behaviour is identical:
 * CLOSED -> OPEN after `failureThreshold` consecutive failures, half-open
 * probing after `recoveryWindowMs`, close on first successful probe.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening the circuit. */
  failureThreshold: number;
  /** Delay before an OPEN circuit allows a probe (HALF_OPEN). */
  recoveryWindowMs: number;
  /** Maximum concurrent probe requests while HALF_OPEN. */
  halfOpenLimit: number;
}

export interface CircuitBreakerEvents {
  onTransition?: (name: string, from: CircuitState, to: CircuitState) => void;
  onProbeResult?: (name: string, succeeded: boolean) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private lastFailureTime = 0;
  private lastStateChange: Date = new Date();

  constructor(
    public readonly name: string,
    private readonly config: CircuitBreakerConfig,
    private readonly events: CircuitBreakerEvents = {},
  ) {}

  getState(): CircuitState {
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.config.recoveryWindowMs) {
      this.transitionTo('HALF_OPEN');
      this.halfOpenAttempts = 0;
    }
    return this.state;
  }

  canExecute(): boolean {
    const current = this.getState();
    if (current === 'CLOSED') return true;
    if (current === 'HALF_OPEN') return this.halfOpenAttempts < this.config.halfOpenLimit;
    return false;
  }

  registerAttempt(): void {
    if (this.state === 'HALF_OPEN') this.halfOpenAttempts++;
  }

  recordSuccess(): void {
    if (this.getState() === 'HALF_OPEN') {
      this.events.onProbeResult?.(this.name, true);
      this.transitionTo('CLOSED');
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();
    this.failureCount++;

    if (this.getState() === 'HALF_OPEN') {
      this.events.onProbeResult?.(this.name, false);
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
      this.transitionTo('OPEN');
    }
  }

  getSnapshot() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      failureThreshold: this.config.failureThreshold,
      recoveryWindowMs: this.config.recoveryWindowMs,
      lastStateChange: this.lastStateChange.toISOString(),
    };
  }

  private transitionTo(next: CircuitState): void {
    const from = this.state;
    this.state = next;
    this.lastStateChange = new Date();
    this.events.onTransition?.(this.name, from, next);
  }
}
