import { BrowserContext } from "playwright";
import { CrawlerConfig } from "../config";
import { StorageLayer } from "../storage/storage";
import { Deduplicator } from "../queue/deduplicator";
import { CrawlQueue, QueueItem } from "../queue/crawl-queue";
import { BrowserManager } from "./browser";
import { PageProcessor } from "./page-processor";
import { Throttle } from "../utils/throttle";
import { getLogger } from "../utils/logger";
import { isInternalUrl } from "../rewriter/url-utils";
import { CrawlState, saveState, loadState, deleteState } from "../storage/state";

export interface EngineStats {
  pagesProcessed: number;
  pagesSucceeded: number;
  pagesFailed: number;
  assetsDownloaded: number;
  startedAt: Date;
  finishedAt: Date | null;
  durationSeconds: number | null;
  resumed: boolean;
}

const STATE_SAVE_INTERVAL_MS = 30_000;
const STATE_SAVE_EVERY_N_PAGES = 10;

/**
 * Core crawl engine — orchestrates the queue, browser, and page processor.
 *
 * Dedup contract:
 *   A URL is marked visited SYNCHRONOUSLY before the first await in the
 *   processor callback.  Because JavaScript is single-threaded and p-queue
 *   only interleaves tasks at await points, this is effectively atomic:
 *   no two concurrent workers can both pass the hasVisitedPage() check for
 *   the same URL.
 *
 * State persistence:
 *   The pending-URL set stored in .crawl-state.json only contains URLs that
 *   have been enqueued but NOT yet visited, so a resumed run never re-crawls
 *   already-processed pages.
 */
export class CrawlerEngine {
  private config: CrawlerConfig;
  private storage: StorageLayer;
  private dedup: Deduplicator;
  private queue: CrawlQueue;
  private browserManager: BrowserManager;
  private processor: PageProcessor;
  private throttle: Throttle;
  private context: BrowserContext | null = null;

  private pagesProcessed = 0;
  private pagesSucceeded = 0;
  private pagesFailed = 0;
  private startedAt: Date = new Date();
  private isShuttingDown = false;
  private resumed = false;

  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private stateSaveInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * URLs that have been enqueued but not yet visited.
   * Used exclusively for state persistence so resume runs can re-queue them.
   * Items are removed when they are marked as visited.
   */
  private pendingUrlSet = new Map<string, QueueItem>();

  constructor(config: CrawlerConfig) {
    this.config = config;
    this.dedup = new Deduplicator();
    this.storage = new StorageLayer(config.outputDir, config.url, this.dedup);
    this.throttle = new Throttle(config.delayMs);
    this.queue = new CrawlQueue(config.concurrency, config.depth, config.maxPages);
    this.browserManager = new BrowserManager(config, this.storage, this.dedup);
    this.processor = new PageProcessor(
      config,
      this.storage,
      this.dedup,
      this.browserManager,
      this.throttle
    );
  }

  async run(): Promise<EngineStats> {
    const logger = getLogger();
    this.startedAt = new Date();

    logger.info(
      {
        url: this.config.url,
        depth: this.config.depth,
        concurrency: this.config.concurrency,
        outputDir: this.config.outputDir,
        resume: this.config.resume,
        scroll: this.config.scroll,
        maxPages: this.config.maxPages || "unlimited",
        delayMs: this.config.delayMs,
      },
      "Crawler engine starting"
    );

    // ── Resume: load saved state ──────────────────────────────────────────
    let seedUrls: QueueItem[] = [];

    if (this.config.resume) {
      const savedState = loadState(this.config.outputDir);

      if (savedState && savedState.targetUrl === this.config.url) {
        this.dedup.loadFromSnapshot({
          visitedPages: savedState.visitedPages,
          downloadedAssets: savedState.downloadedAssets,
        });
        this.pagesProcessed = savedState.stats.pagesProcessed;
        this.pagesSucceeded = savedState.stats.pagesSucceeded;
        this.pagesFailed = savedState.stats.pagesFailed;
        seedUrls = savedState.pendingUrls;
        this.resumed = true;

        logger.info(
          {
            visitedPages: savedState.visitedPages.length,
            downloadedAssets: savedState.downloadedAssets.length,
            pendingUrls: seedUrls.length,
          },
          "Resume state loaded successfully"
        );
      } else if (savedState) {
        logger.warn(
          { savedUrl: savedState.targetUrl, requestedUrl: this.config.url },
          "State file URL mismatch — starting fresh"
        );
      }
    }

    // ── Browser setup ─────────────────────────────────────────────────────
    this.registerShutdownHandlers();
    await this.browserManager.launch();
    this.context = await this.browserManager.createContext();

    // ── Queue processor ───────────────────────────────────────────────────
    this.queue.setProcessor(async (item: QueueItem) => {
      if (this.isShuttingDown) return;

      // Synchronous check+mark before first await — effectively atomic.
      if (this.dedup.hasVisitedPage(item.url)) {
        logger.debug({ url: item.url }, "Page already visited, skipping");
        return;
      }
      this.dedup.markPageVisited(item.url);

      // Remove from pending set now that it's being processed.
      this.pendingUrlSet.delete(item.url);

      const result = await this.processor.process(item, this.context!);

      this.pagesProcessed++;
      if (result.success) {
        this.pagesSucceeded++;
      } else {
        this.pagesFailed++;
      }

      // Periodic state save based on page count.
      if (this.pagesProcessed % STATE_SAVE_EVERY_N_PAGES === 0) {
        this.persistState();
      }

      // Enqueue newly discovered routes.
      // RouteDiscovery already normalises URLs (sorted query params, stripped
      // trailing slash/fragment), so we only need one visited check here.
      for (const routeUrl of result.discoveredRoutes) {
        if (this.isShuttingDown) break;
        if (!isInternalUrl(routeUrl, this.config.allowedDomains)) continue;
        if (this.dedup.hasVisitedPage(routeUrl)) continue;

        const newItem: QueueItem = {
          url: routeUrl,
          depth: item.depth + 1,
          parentUrl: item.url,
        };

        const enqueued = this.queue.enqueue(newItem);
        if (enqueued) {
          this.pendingUrlSet.set(routeUrl, newItem);
        }
      }
    });

    // ── Seed the queue ────────────────────────────────────────────────────
    if (seedUrls.length > 0) {
      for (const item of seedUrls) {
        if (!this.dedup.hasVisitedPage(item.url)) {
          this.queue.enqueue(item);
          this.pendingUrlSet.set(item.url, item);
        }
      }
    } else {
      const rootUrl =
        this.dedup.normalizePageUrl(this.config.url, this.config.url) ??
        this.config.url;
      const rootItem: QueueItem = { url: rootUrl, depth: 0, parentUrl: null };
      this.queue.enqueue(rootItem);
      this.pendingUrlSet.set(rootUrl, rootItem);
    }

    // ── Start background tasks ────────────────────────────────────────────
    this.startProgressReporting();
    this.startStateSaving();

    // ── Run until complete ────────────────────────────────────────────────
    await this.queue.drain();

    this.stopProgressReporting();
    this.stopStateSaving();

    await this.shutdown();

    // ── Final state cleanup (successful completion) ───────────────────────
    deleteState(this.config.outputDir);

    const finishedAt = new Date();
    const durationSeconds =
      (finishedAt.getTime() - this.startedAt.getTime()) / 1000;

    const stats: EngineStats = {
      pagesProcessed: this.pagesProcessed,
      pagesSucceeded: this.pagesSucceeded,
      pagesFailed: this.pagesFailed,
      assetsDownloaded: this.dedup.downloadedCount,
      startedAt: this.startedAt,
      finishedAt,
      durationSeconds,
      resumed: this.resumed,
    };

    logger.info(stats, "Crawl complete");
    return stats;
  }

  // ── State persistence ───────────────────────────────────────────────────

  private persistState(): void {
    const snap = this.dedup.snapshot();
    const state: CrawlState = {
      version: "1",
      targetUrl: this.config.url,
      savedAt: new Date().toISOString(),
      visitedPages: snap.visitedPages,
      downloadedAssets: snap.downloadedAssets,
      // Only include URLs that are genuinely still pending (not yet visited).
      pendingUrls: Array.from(this.pendingUrlSet.values()),
      stats: {
        pagesProcessed: this.pagesProcessed,
        pagesSucceeded: this.pagesSucceeded,
        pagesFailed: this.pagesFailed,
      },
    };
    saveState(this.config.outputDir, state);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.stopProgressReporting();
    this.stopStateSaving();

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore
      }
      this.context = null;
    }

    await this.browserManager.close();
  }

  private registerShutdownHandlers(): void {
    const handler = async (signal: string) => {
      const logger = getLogger();
      logger.warn(
        { signal },
        "Shutdown signal received — saving state and draining queue"
      );
      this.isShuttingDown = true;
      this.queue.pause();
      this.persistState();
      await this.shutdown();
      logger.info("Graceful shutdown complete — run with --resume to continue");
      process.exit(0);
    };

    process.once("SIGTERM", () => void handler("SIGTERM"));
    process.once("SIGINT", () => void handler("SIGINT"));
  }

  private startProgressReporting(): void {
    const logger = getLogger();
    this.progressInterval = setInterval(() => {
      const qStats = this.queue.stats;
      logger.info(
        {
          pagesProcessed: this.pagesProcessed,
          pagesSucceeded: this.pagesSucceeded,
          pagesFailed: this.pagesFailed,
          assetsDownloaded: this.dedup.downloadedCount,
          queueSize: qStats.queueSize,
          queuePending: qStats.queuePending,
          pendingUrls: this.pendingUrlSet.size,
          elapsedSeconds: Math.round(
            (Date.now() - this.startedAt.getTime()) / 1000
          ),
        },
        "Crawl progress"
      );
    }, 10_000);
  }

  private stopProgressReporting(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private startStateSaving(): void {
    this.stateSaveInterval = setInterval(() => {
      this.persistState();
    }, STATE_SAVE_INTERVAL_MS);
  }

  private stopStateSaving(): void {
    if (this.stateSaveInterval) {
      clearInterval(this.stateSaveInterval);
      this.stateSaveInterval = null;
    }
  }

  get storageLayer(): StorageLayer {
    return this.storage;
  }

  get deduplicate(): Deduplicator {
    return this.dedup;
  }
}
