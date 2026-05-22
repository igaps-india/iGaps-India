/**
 * ValkeyQueue — stub for future use.
 *
 * When traffic justifies it:
 *  1. Set QUEUE_PROVIDER=valkey and VALKEY_URL=redis://...
 *  2. npm install ioredis bullmq
 *  3. Replace this stub with a real BullMQ/Valkey implementation
 *     that satisfies the JobQueue interface.
 *
 * All application code depends only on the JobQueue interface,
 * so no other files need to change.
 */
import { Job, JobHandler, JobName, JobQueue } from './types';

export class ValkeyQueue implements JobQueue {
  register<T>(_name: JobName, _handler: JobHandler<T>): void {
    throw new Error('ValkeyQueue not yet implemented. Set QUEUE_PROVIDER=inmemory for MVP.');
  }

  async enqueue<T>(_name: JobName, _data: T): Promise<string> {
    throw new Error('ValkeyQueue not yet implemented.');
  }

  async close(): Promise<void> {
    // no-op
  }
}

// Suppress unused-type warning
export type { Job };
