import PQueue from 'p-queue';
import { randomUUID } from 'crypto';
import { Job, JobHandler, JobName, JobQueue } from './types';

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]; // 5s, 30s, 2m

export class InMemoryQueue implements JobQueue {
  private pq: PQueue;
  private handlers = new Map<JobName, JobHandler<unknown>>();

  constructor(concurrency = 5) {
    this.pq = new PQueue({ concurrency });
  }

  register<T>(name: JobName, handler: JobHandler<T>): void {
    this.handlers.set(name, handler as JobHandler<unknown>);
  }

  async enqueue<T>(name: JobName, data: T, opts: { maxAttempts?: number } = {}): Promise<string> {
    const id = randomUUID();
    const maxAttempts = opts.maxAttempts ?? 3;

    const job: Job<T> = {
      id,
      name,
      data,
      attempts: 0,
      maxAttempts,
      createdAt: new Date(),
    };

    this.pq.add(() => this.run(job)).catch(() => {
      // Errors are logged inside run(); suppress unhandled rejection here
    });

    return id;
  }

  private async run<T>(job: Job<T>): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      console.error(`[Queue] No handler registered for job "${job.name}"`);
      return;
    }

    job.attempts += 1;

    try {
      await handler(job as Job<unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[Queue] Job ${job.name}#${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`,
      );

      if (job.attempts < job.maxAttempts) {
        const delayMs = RETRY_DELAYS_MS[job.attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
        console.info(`[Queue] Retrying job ${job.name}#${job.id} in ${delayMs}ms`);
        await sleep(delayMs);
        this.pq.add(() => this.run(job)).catch(() => {});
      } else {
        console.error(
          `[Queue] Job ${job.name}#${job.id} exhausted all ${job.maxAttempts} attempts. Marking failed.`,
        );
        // Callers handle the 'unavailable' state by checking scrapedData fields
      }
    }
  }

  async close(): Promise<void> {
    await this.pq.onIdle();
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
