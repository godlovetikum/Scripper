import PQueue from "p-queue";
import { getLogger } from "../utils/logger";

export interface QueueItem {
  url: string;
  depth: number;
  parentUrl: string | null;
}

export type PageProcessor = (item: QueueItem) => Promise<void>;

/**
 * BFS crawl queue backed by p-queue for concurrency control.
 * Tracks pending items and provides progress visibility.
 */
export class CrawlQueue {
  private queue: PQueue;
  private pending = new Map<string, QueueItem>();
  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalFailed = 0;
  private processor: PageProcessor | null = null;
  private maxDepth: number;
  private maxPages: number;

  constructor(concurrency: number, maxDepth: number, maxPages: number) {
    this.queue = new PQueue({ concurrency });
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
  }

  setProcessor(processor: PageProcessor): void {
    this.processor = processor;
  }

  enqueue(item: QueueItem): boolean {
    if (item.depth > this.maxDepth) {
      getLogger().debug({ url: item.url, depth: item.depth }, "Skipping — max depth reached");
      return false;
    }

    if (this.maxPages > 0 && this.totalEnqueued >= this.maxPages) {
      getLogger().debug({ url: item.url }, "Skipping — max pages reached");
      return false;
    }

    if (this.pending.has(item.url)) return false;

    this.pending.set(item.url, item);
    this.totalEnqueued++;

    this.queue.add(async () => {
      if (!this.processor) throw new Error("No processor registered");
      try {
        await this.processor(item);
        this.totalProcessed++;
      } catch (err) {
        this.totalFailed++;
        getLogger().error(
          { url: item.url, err: err instanceof Error ? err.message : String(err) },
          "Queue item processing failed"
        );
      } finally {
        this.pending.delete(item.url);
      }
    });

    return true;
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.start();
  }

  get size(): number {
    return this.queue.size;
  }

  get pending_count(): number {
    return this.queue.pending;
  }

  get stats(): {
    totalEnqueued: number;
    totalProcessed: number;
    totalFailed: number;
    queueSize: number;
    queuePending: number;
  } {
    return {
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      queueSize: this.queue.size,
      queuePending: this.queue.pending,
    };
  }
}
