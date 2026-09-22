import { HostSpanError } from "../mcp/errors.js";

interface ConcurrencyWaiter {
  resolve: () => void;
  reject: (error: HostSpanError) => void;
  timer: NodeJS.Timeout;
}

export interface ConcurrencySnapshot {
  active: number;
  queued: number;
  max_concurrent: number;
  max_queued: number;
}

export interface BoundedConcurrencyOptions {
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
  resource: string;
  label: string;
}

export class BoundedConcurrencyLimiter {
  private active = 0;
  private readonly queue: ConcurrencyWaiter[] = [];

  constructor(private readonly options: BoundedConcurrencyOptions) {}

  snapshot(): ConcurrencySnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.options.maxConcurrent,
      max_queued: this.options.maxQueued,
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.queue.length >= this.options.maxQueued) throw this.busyError();

    await new Promise<void>((resolve, reject) => {
      const waiter: ConcurrencyWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.active += 1;
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(this.busyError());
        }, this.options.queueTimeoutMs),
      };
      waiter.timer.unref();
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.resolve();
  }

  private busyError(): HostSpanError {
    return new HostSpanError("SERVER_BUSY", `${this.options.label} capacity is saturated; retry after a short delay.`, true, {
      resource: this.options.resource,
      active: this.active,
      queued: this.queue.length,
      max_concurrent: this.options.maxConcurrent,
      max_queued: this.options.maxQueued,
      queue_timeout_ms: this.options.queueTimeoutMs,
    });
  }
}
