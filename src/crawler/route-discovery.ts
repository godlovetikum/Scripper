import { Page } from "playwright";
import { CrawlerConfig } from "../config";
import { isSkippableUrl, isInternalUrl } from "../rewriter/url-utils";
import { extractLinksFromHtml } from "../rewriter/html-rewriter";
import { stripQueryParams, isActionUrl } from "../utils/url-filters";
import { getLogger } from "../utils/logger";

/**
 * Discovers internal routes from a fully-rendered page using multiple strategies:
 *   1. Anchor tag href attributes (static HTML snapshot via cheerio)
 *   2. Live DOM anchor extraction after JS execution
 *   3. Data attributes (data-href, data-route, etc.)
 *   4. Scroll-to-reveal lazy-loaded navigation
 *   5. SPA router patterns (Next.js __BUILD_MANIFEST, Angular, Vue, Nuxt)
 *
 * Every discovered URL passes through normalizeUrl() which applies the
 * two-layer universal filter before the URL enters the visited set:
 *
 *   BLOCK — isActionUrl() detects one-time-use action endpoints via:
 *     · Param value is a 32+ char lowercase hex string (hash/nonce token)
 *     · Param key contains nonce/csrf/token keywords (framework-agnostic)
 *     · Param key is in the explicit block list (config.blockParams)
 *
 *   STRIP — stripQueryParams() removes known tracking / shortcut params
 *     (utm_*, ad click IDs, add-to-cart, etc.) so URL variants that only
 *     differ by these params collapse to the same canonical URL.
 *
 * Anything that passes both layers is crawled.  Content-hash deduplication
 * in PageProcessor is the final backstop for any identical-content pages
 * that survive URL normalization.
 */
export class RouteDiscovery {
  private config: CrawlerConfig;

  constructor(config: CrawlerConfig) {
    this.config = config;
  }

  async discoverRoutes(
    page: Page,
    pageUrl: string,
    html: string
  ): Promise<string[]> {
    const logger = getLogger();
    const discovered = new Set<string>();

    // ── 1. Static HTML links ────────────────────────────────────────────────
    const htmlLinks = extractLinksFromHtml(html, pageUrl);
    for (const link of htmlLinks) {
      if (isInternalUrl(link, this.config.allowedDomains)) {
        const clean = this.normalizeUrl(link);
        if (clean) discovered.add(clean);
      }
    }

    // ── 2. Live DOM links (after JS execution) ─────────────────────────────
    let domLinksBeforeScroll: string[] = [];
    try {
      domLinksBeforeScroll = await this.extractDomLinks(page, pageUrl);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "DOM link extraction failed"
      );
    }
    for (const link of domLinksBeforeScroll) {
      const clean = this.normalizeUrl(link);
      if (clean && isInternalUrl(clean, this.config.allowedDomains)) {
        discovered.add(clean);
      }
    }

    // ── 3. Scroll to reveal lazy-loaded navigation ─────────────────────────
    if (this.config.scroll) {
      try {
        const scrollLinks = await this.scrollAndDiscoverNew(
          page,
          pageUrl,
          domLinksBeforeScroll
        );
        for (const link of scrollLinks) {
          const clean = this.normalizeUrl(link);
          if (clean && isInternalUrl(clean, this.config.allowedDomains)) {
            discovered.add(clean);
          }
        }
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          "Scroll discovery failed"
        );
      }
    }

    // ── 4. SPA router patterns ─────────────────────────────────────────────
    try {
      const spaRoutes = await this.extractSpaRoutes(page, pageUrl);
      for (const route of spaRoutes) {
        const clean = this.normalizeUrl(route);
        if (clean && isInternalUrl(clean, this.config.allowedDomains)) {
          discovered.add(clean);
        }
      }
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "SPA route extraction failed"
      );
    }

    const results = Array.from(discovered);

    logger.debug(
      { pageUrl, discovered: results.length },
      "Route discovery complete"
    );

    return results;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Canonical URL normalisation pipeline:
   *
   *   1. Reject skippable schemes (mailto:, tel:, javascript:, data:, #)
   *   2. BLOCK: isActionUrl() — rejects one-time-use action endpoints using
   *      universal heuristics (hash-value pattern + nonce-keyword pattern
   *      + explicit block list).  See url-filters.ts for full rationale.
   *   3. STRIP: remove tracking / cart-shortcut params from the URL so
   *      variants collapse to their canonical form.
   *   4. Strip fragment (#...) and sort remaining query params.
   *   5. Strip trailing slash (except root "/").
   *
   * Returns null if the URL should be discarded entirely.
   */
  private normalizeUrl(url: string): string | null {
    if (isSkippableUrl(url)) return null;

    try {
      // Block check on the RAW url (before any stripping) — action params
      // must be detected before they are removed.
      if (isActionUrl(url, this.config.blockParams)) return null;

      // Strip tracking / shortcut params.
      const stripped = stripQueryParams(url, this.config.stripParams);

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

  private async extractDomLinks(page: Page, pageUrl: string): Promise<string[]> {
    return page.evaluate((baseUrl: string) => {
      const links: string[] = [];

      const anchors = document.querySelectorAll<HTMLAnchorElement>("a[href]");
      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href) continue;
        try {
          links.push(new URL(href, baseUrl).toString());
        } catch {
          // ignore invalid URLs
        }
      }

      const dataAttrs = [
        "data-href",
        "data-route",
        "data-page",
        "data-url",
        "data-link",
      ];
      for (const el of document.querySelectorAll("*")) {
        for (const attr of dataAttrs) {
          const val = el.getAttribute(attr);
          if (val) {
            try {
              links.push(new URL(val, baseUrl).toString());
            } catch {
              // ignore
            }
          }
        }
      }

      return links;
    }, pageUrl);
  }

  /**
   * Scroll the page to reveal lazy-loaded content, then return only the URLs
   * that were not visible before scrolling.
   */
  private async scrollAndDiscoverNew(
    page: Page,
    pageUrl: string,
    alreadyKnown: string[]
  ): Promise<string[]> {
    const knownSet = new Set(alreadyKnown);

    await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const scrollHeight = document.body.scrollHeight;
      let position = 0;
      const step = Math.min(window.innerHeight, 800);
      while (position < scrollHeight) {
        window.scrollBy(0, step);
        position += step;
        await delay(150);
      }
      window.scrollTo(0, 0);
    });

    await page.waitForTimeout(500);

    const allAfterScroll = await this.extractDomLinks(page, pageUrl);
    return allAfterScroll.filter((u) => !knownSet.has(u));
  }

  private async extractSpaRoutes(page: Page, pageUrl: string): Promise<string[]> {
    return page.evaluate((baseUrl: string) => {
      const routes: string[] = [];

      const routerOutlet =
        document.querySelector("[data-reactroot]") ||
        document.querySelector("#app") ||
        document.querySelector("#root") ||
        document.querySelector("router-view") ||
        document.querySelector("nuxt") ||
        document.querySelector("ng-component");

      if (routerOutlet) {
        const allLinks = routerOutlet.querySelectorAll(
          "[href], [routerLink], [router-link]"
        );
        for (const el of allLinks) {
          const href =
            el.getAttribute("href") ||
            el.getAttribute("routerLink") ||
            el.getAttribute("router-link");
          if (href) {
            try {
              routes.push(new URL(href, baseUrl).toString());
            } catch {
              // ignore
            }
          }
        }
      }

      const nextLinks = document.querySelectorAll("[data-nextjs-page]");
      for (const el of nextLinks) {
        const href = el.getAttribute("href");
        if (href) {
          try {
            routes.push(new URL(href, baseUrl).toString());
          } catch {
            // ignore
          }
        }
      }

      try {
        const buildManifest = (
          window as unknown as Record<string, unknown>
        ).__BUILD_MANIFEST as Record<string, unknown[]> | undefined;
        if (buildManifest) {
          for (const route of Object.keys(buildManifest)) {
            if (route.startsWith("/")) {
              try {
                routes.push(new URL(route, baseUrl).toString());
              } catch {
                // ignore
              }
            }
          }
        }
      } catch {
        // ignore
      }

      return routes;
    }, pageUrl);
  }
}
