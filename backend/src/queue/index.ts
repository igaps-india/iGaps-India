import { config } from '../config';
import { InMemoryQueue } from './InMemoryQueue';
import { ValkeyQueue } from './ValkeyQueue.stub';
import { JobQueue } from './types';

export * from './types';

let _queue: JobQueue | null = null;

export function getQueue(): JobQueue {
  if (!_queue) {
    if (config.queue.provider === 'valkey') {
      _queue = new ValkeyQueue();
    } else {
      _queue = new InMemoryQueue(5);
    }
    console.info(`[Queue] Using provider: ${config.queue.provider}`);
  }
  return _queue;
}
