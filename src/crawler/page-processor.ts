import { BrowserContext } from "playwright";
import { CrawlerConfig } from "../config";
import { StorageLayer } from "../storage/storage";
import { Deduplicator } from "../queue/deduplicator";
import { BrowserManager } from "./browser";
import { RouteDiscovery } from "./route-discovery";
import { rewriteHtml } from "../rewriter/html-rewriter";
import { QueueItem } from "../queue/crawl-queue";
import { getLogger } from "../utils/logger";
import { Throttle } from "../utils/throttle";
import { stripQueryParams } from "../utils/url-filters";

export interface ProcessResult {
  url: string;
  success: boolean;
  discoveredRoutes: string[];
  htmlPath: string | null;
  errorMessage: string | null;
}

/**
 * Processes a single page: navigates, waits for hydration, captures the DOM,
 * saves the HTML once, rewrites URLs in-place, then extracts new routes.
 *
 * TWO UNIVERSAL DEDUPLICATION MECHANISMS
 * ───────────────────────────────────────
 *
 * 1. REDIRECT DETECTION (universal — requires no URL pattern knowledge)
 *    After page.goto(), page.url() is the final URL after all server-side
 *    redirects.  If it differs from the URL we navigated to, we followed a
 *    redirect.  We normalise the final URL and check whether it has already
 *    been crawled.  If it has, we skip saving and return immediately.
 *    If it has not, we save the content under the canonical final URL and
 *    mark it as visited, so the redirect target is not crawled a second time
 *    when discovered via a link elsewhere.
 *
 *    This catches every redirect pattern without knowing the param names:
 *    add-to-cart links that redirect to the product page, lang-prefix
 *    redirects, trailing-slash canonicalisation, etc.
 *
 * 2. CONTENT-HASH DEDUPLICATION (universal backstop)
 *    After capturing the HTML, we compute a SHA-256 hash and check whether
 *    that exact content has already been saved under another URL.  If it has,
 *    we skip writing a duplicate file but still discover outgoing routes so
 *    no links are lost.
 *
 *    This is the final safety net for any case where two URLs serve identical
 *    content without sending a redirect header (e.g. pagination pages that
 *    happen to be empty, or CMS variants that produce the same output).
 */
export class PageProcessor {
  private config: CrawlerConfig;
  private storage: StorageLayer;
  private dedup: Deduplicator;
  private browserManager: BrowserManager;
  private routeDiscovery: RouteDiscovery;
  private throttle: Throttle;

  constructor(
    config: CrawlerConfig,
    storage: StorageLayer,
    dedup: Deduplicator,
    browserManager: BrowserManager,
    throttle: Throttle
  ) {
    this.config = config;
    this.storage = storage;
    this.dedup = dedup;
    this.browserManager = browserManager;
    this.routeDiscovery = new RouteDiscovery(config);
    this.throttle = throttle;
  }

  async process(item: QueueItem, context: BrowserContext): Promise<ProcessResult> {
    const logger = getLogger();
    const { url } = item;

    await this.throttle.wait();

    logger.info({ url, depth: item.depth, parent: item.parentUrl }, "Processing page");

    const page = await this.browserManager.createInterceptingPage(context);

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.pageTimeoutMs,
      });

      try {
        await page.waitForLoadState("networkidle", {
          timeout: this.config.networkIdleMs,
        });
      } catch {
        logger.debug({ url }, "Network idle timeout — proceeding with current state");
      }

      await this.runPostHydrationWaits(page);

      // ── Redirect detection ─────────────────────────────────────────────
      // page.url() is the final URL after Playwright followed all HTTP
      // redirects.  Normalise it the same way RouteDiscovery normalises
      // discovered links so the visited-set lookup is consistent.
      const finalUrl = page.url();
      const canonicalFinalUrl = this.canonicalizeUrl(finalUrl);
      const wasRedirected = canonicalFinalUrl !== null && canonicalFinalUrl !== url;

      if (wasRedirected && canonicalFinalUrl !== null) {
        logger.debug(
          { requestedUrl: url, canonicalUrl: canonicalFinalUrl },
          "Redirect detected"
        );

        if (this.dedup.hasVisitedPage(canonicalFinalUrl)) {
          // The redirect destination was already crawled — this URL is a
          // pure duplicate.  Skip saving; still return success so the engine
          // does not count it as a failure.
          logger.info(
            { url, redirectedTo: canonicalFinalUrl },
            "URL redirected to already-crawled page — skipping duplicate"
          );
          return {
            url,
            success: true,
            discoveredRoutes: [],
            htmlPath: null,
            errorMessage: null,
          };
        }

        // Mark the canonical destination as visited now so that if another
        // worker discovers it via a link, it won't queue a second crawl.
        this.dedup.markPageVisited(canonicalFinalUrl);
      }

      // The URL under which we will save this page's content.  If a redirect
      // occurred we use the canonical destination so the output file goes
      // at the right path.
      const saveUrl =
        wasRedirected && canonicalFinalUrl !== null ? canonicalFinalUrl : url;

      const html = await page.content();

      // ── Content-hash deduplication ─────────────────────────────────────
      // Universal backstop: if this page's HTML is byte-for-byte identical
      // to a page we already saved (e.g. a CMS variant or empty pagination
      // page), skip writing the file but still walk its links.
      const htmlBuffer = Buffer.from(html, "utf8");
      if (this.dedup.hasContentHash(htmlBuffer)) {
        logger.info(
          { url, saveUrl },
          "Identical content already saved under another URL — skipping duplicate"
        );
        const discoveredRoutes = await this.routeDiscovery.discoverRoutes(
          page,
          saveUrl,
          html
        );
        return {
          url,
          success: true,
          discoveredRoutes,
          htmlPath: null,
          errorMessage: null,
        };
      }

      // ── Save initial HTML ──────────────────────────────────────────────
      const savedPage = await this.storage.savePage(saveUrl, html);

      // ── Rewrite asset URLs to relative paths, then overwrite ───────────
      if (savedPage) {
        const rewrittenHtml = rewriteHtml(
          html,
          saveUrl,
          savedPage.relativePath,
          this.storage
        );
        await this.storage.rewritePage(saveUrl, rewrittenHtml);

        // Discover routes using the canonical URL as the base so relative
        // links in the HTML resolve correctly.
        const discoveredRoutes = await this.routeDiscovery.discoverRoutes(
          page,
          saveUrl,
          html
        );

        logger.info(
          {
            url,
            saveUrl,
            htmlSaved: true,
            discovered: discoveredRoutes.length,
          },
          "Page processed successfully"
        );

        return {
          url,
          success: true,
          discoveredRoutes,
          htmlPath: savedPage.localPath,
          errorMessage: null,
        };
      }

      // savePage returned null — file write failed; try route discovery anyway
      const discoveredRoutes = await this.routeDiscovery.discoverRoutes(
        page,
        saveUrl,
        html
      );

      return {
        url,
        success: false,
        discoveredRoutes,
        htmlPath: null,
        errorMessage: "Page HTML could not be saved to disk",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: message }, "Page processing failed");

      if (this.config.debugScreenshots) {
        try {
          const screenshotBuffer = await page.screenshot({ fullPage: false });
          const name = `error_${Date.now()}_${encodeURIComponent(url).slice(0, 60)}`;
          const screenshotPath = await this.storage.saveScreenshot(name, screenshotBuffer);
          logger.debug({ screenshotPath }, "Error screenshot saved");
        } catch (ssErr) {
          logger.debug(
            { err: ssErr instanceof Error ? ssErr.message : String(ssErr) },
            "Failed to take error screenshot"
          );
        }
      }

      this.storage.recordFailure(url, message);

      return {
        url,
        success: false,
        discoveredRoutes: [],
        htmlPath: null,
        errorMessage: message,
      };
    } finally {
      try {
        await page.close();
      } catch {
        // page may already be closed
      }
    }
  }

  /**
   * Normalise a URL the same way RouteDiscovery.normalizeUrl() does:
   * strip tracking params, remove fragment, sort query params, strip
   * trailing slash.  Does NOT apply the block check — by the time a URL
   * is being navigated to it has already passed the block filter.
   *
   * Returns null if the URL cannot be parsed.
   */
  private canonicalizeUrl(rawUrl: string): string | null {
    try {
      const stripped = stripQueryParams(rawUrl, this.config.stripParams);
      const parsed = new URL(stripped);
      parsed.hash = "";
      parsed.searchParams.sort();
      let result = parsed.toString();
      if (result.endsWith("/") && parsed.pathname !== "/") {
        result = result.slice(0, -1);
      }
      return result;
    } catch {
      return null;
    }
  }

  private async runPostHydrationWaits(page: import("playwright").Page): Promise<void> {
    try {
      await page.waitForFunction(
        () =>
          document.readyState === "complete" &&
          !document.querySelector(
            ".loading, .spinner, [data-loading='true'], [aria-busy='true']"
          ),
        { timeout: 3000 }
      );
    } catch {
      // Not all pages have loading indicators — ignore timeout
    }

    await page.waitForTimeout(300);
  }
}
