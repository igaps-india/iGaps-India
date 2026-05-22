export type JobName =
  | 'scrape:linkedin'
  | 'scrape:github'
  | 'scrape:zauba'
  | 'scrape:press'
  | 'scrape:patents'
  | 'evaluate:application'
  | 'plan:open-questions';

export interface Job<T = unknown> {
  id: string;
  name: JobName;
  data: T;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface JobQueue {
  /** Register a handler for a job name. Must be called before enqueue. */
  register<T>(name: JobName, handler: JobHandler<T>): void;
  /** Add a job to the queue. Returns the job id. */
  enqueue<T>(name: JobName, data: T, opts?: { maxAttempts?: number }): Promise<string>;
  /** Graceful shutdown — drain in-flight jobs then close. */
  close(): Promise<void>;
}
