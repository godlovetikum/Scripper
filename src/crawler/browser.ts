import { chromium, Browser, BrowserContext, Page } from "playwright";
import { CrawlerConfig } from "../config";
import { getLogger } from "../utils/logger";
import { StorageLayer } from "../storage/storage";
import { Deduplicator } from "../queue/deduplicator";
import { isInternalUrl, isSkippableUrl } from "../rewriter/url-utils";
import { withRetry } from "../utils/retry";

const INTERCEPTED_RESOURCE_TYPES = new Set([
  "stylesheet",
  "script",
  "image",
  "font",
  "media",
  "fetch",
  "xhr",
  "other",
]);

const SKIP_RESOURCE_TYPES = new Set(["websocket", "eventsource"]);

export interface InterceptedAsset {
  url: string;
  body: Buffer;
  contentType: string;
}

/**
 * Manages the Playwright browser lifecycle and network interception.
 *
 * Asset deduplication is performed SYNCHRONOUSLY before any I/O:
 * hasDownloadedAsset() is checked and markAssetDownloaded() is called in the
 * same tick, so concurrent intercept callbacks for the same URL cannot both
 * pass the guard — even before the file write completes.
 *
 * HTML response guard: if the server returns a text/html response for a
 * resource that is expected to be a binary asset (image, font, stylesheet,
 * script), the response is an error page (404, 403, login redirect) served
 * in place of the real asset.  We fulfil the request so the page renders
 * correctly, but we do NOT save the body to disk.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private config: CrawlerConfig;
  private storage: StorageLayer;
  private dedup: Deduplicator;
  private interceptedCount = 0;

  constructor(config: CrawlerConfig, storage: StorageLayer, dedup: Deduplicator) {
    this.config = config;
    this.storage = storage;
    this.dedup = dedup;
  }

  async launch(): Promise<void> {
    const logger = getLogger();
    logger.info("Launching Chromium browser");
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
      ],
    });
    logger.info("Browser launched");
  }

  async createContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error("Browser not launched");

    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport: {
        width: this.config.viewportWidth,
        height: this.config.viewportHeight,
      },
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      acceptDownloads: false,
    };

    if (this.config.userAgent) {
      contextOptions.userAgent = this.config.userAgent;
    }

    return this.browser.newContext(contextOptions);
  }

  async createInterceptingPage(context: BrowserContext): Promise<Page> {
    const logger = getLogger();
    const page = await context.newPage();

    page.setDefaultTimeout(this.config.pageTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.pageTimeoutMs);

    await page.route("**/*", async (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();

      if (SKIP_RESOURCE_TYPES.has(resourceType)) {
        await route.continue();
        return;
      }

      if (isSkippableUrl(url)) {
        await route.abort();
        return;
      }

      try {
        const response = await withRetry(
          `fetch:${url}`,
          () => route.fetch({ timeout: this.config.pageTimeoutMs }),
          { maxAttempts: this.config.maxRetries, baseDelayMs: 500 }
        );

        const contentType = response.headers()["content-type"] ?? "";
        const body = await response.body();

        // Guard: skip saving if the server returned an HTML response for a
        // resource expected to be a binary asset.  This happens when a server
        // returns a 404 page, a login redirect, or a maintenance page with
        // content-type text/html in response to an image, font, or script
        // request.  We still fulfil the route (so the page can render) but
        // we do not save the HTML body as if it were the binary asset.
        const normContentType = contentType.split(";")[0].trim().toLowerCase();
        const isHtmlResponse =
          normContentType === "text/html" ||
          normContentType === "application/xhtml+xml";

        const isInternal = isInternalUrl(url, this.config.allowedDomains);
        const shouldSave =
          INTERCEPTED_RESOURCE_TYPES.has(resourceType) &&
          body.length > 0 &&
          !isHtmlResponse && // exclude HTML error pages served as assets
          (isInternal || resourceType === "font" || resourceType === "stylesheet");

        if (shouldSave) {
          // Optimistic check: skip scheduling I/O if the asset is already
          // marked.  This is NOT the dedup gate — saveAsset() does the real
          // atomic check+mark.  This only avoids queuing a redundant
          // setImmediate when we already know the answer.
          if (!this.dedup.hasDownloadedAsset(url)) {
            if (isHtmlResponse) {
              logger.debug(
                { url, resourceType, contentType },
                "Skipping HTML response for non-document resource (error page)"
              );
            } else {
              // Defer the file write so route.fulfill() is not blocked.
              setImmediate(() => {
                this.storage
                  .saveAsset(url, body, contentType)
                  .then((saved) => {
                    if (saved) this.interceptedCount++;
                  })
                  .catch((err) => {
                    logger.warn(
                      {
                        url,
                        err: err instanceof Error ? err.message : String(err),
                      },
                      "Failed to save intercepted asset"
                    );
                  });
              });
            }
          }
        }

        await route.fulfill({ response });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes("Target closed") &&
          !msg.includes("Request context disposed")
        ) {
          logger.debug(
            { url, resourceType, err: msg },
            "Route interception failed, aborting"
          );
        }
        try {
          await route.abort();
        } catch {
          // already handled
        }
      }
    });

    return page;
  }

  async close(): Promise<void> {
    if (this.browser) {
      getLogger().info(
        { interceptedCount: this.interceptedCount },
        "Closing browser"
      );
      await this.browser.close();
      this.browser = null;
    }
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }
}
