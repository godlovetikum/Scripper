import fs from "fs";
import path from "path";
import { getLogger } from "../utils/logger";
import { PathResolver } from "./path-resolver";
import { Deduplicator } from "../queue/deduplicator";

export interface SavedAsset {
  url: string;
  localPath: string;
  relativePath: string;
  size: number;
  contentType: string;
}

export interface SavedPage {
  url: string;
  localPath: string;
  relativePath: string;
  size: number;
}

/**
 * HTML body guard: the first bytes that unambiguously identify an HTML document.
 * Used to detect when a server lies about content-type and sends an HTML error
 * page with a binary content-type header (e.g. image/jpeg with an HTML body).
 */
const HTML_BODY_MARKERS = [
  "<!DOCTYPE",
  "<!doctype",
  "<html",
  "<HTML",
  "<!-- wp:",  // WordPress block comment at top of some error pages
];

function bodyLooksLikeHtml(body: Buffer): boolean {
  // Check only the first 128 bytes — binary files start with magic bytes,
  // not text, so this check is very fast and has no false positives for real
  // binary assets.
  const head = body.slice(0, 128).toString("utf8");
  const trimmed = head.trimStart();
  return HTML_BODY_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export class StorageLayer {
  private resolver: PathResolver;
  private dedup: Deduplicator;
  private outputDir: string;

  private savedAssets: SavedAsset[] = [];
  private savedPages: SavedPage[] = [];
  private failedUrls: Array<{ url: string; reason: string }> = [];

  // Dedup sets — prevent double-recording the same URL
  private savedPageUrls = new Set<string>();
  private failedUrlSet = new Set<string>();

  constructor(outputDir: string, baseUrl: string, dedup: Deduplicator) {
    this.outputDir = outputDir;
    this.resolver = new PathResolver(outputDir, baseUrl);
    this.dedup = dedup;
    this.ensureOutputDirs();
  }

  private ensureOutputDirs(): void {
    const dirs = [
      this.outputDir,
      path.join(this.outputDir, "pages"),
      path.join(this.outputDir, "assets", "js"),
      path.join(this.outputDir, "assets", "css"),
      path.join(this.outputDir, "assets", "images"),
      path.join(this.outputDir, "assets", "fonts"),
      path.join(this.outputDir, "assets", "media"),
      path.join(this.outputDir, "assets", "other"),
      path.join(this.outputDir, "api"),
      path.join(this.outputDir, "screenshots"),
    ];

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Save a page's HTML to disk and record it in the pages manifest.
   * Only records the first call per URL — subsequent calls (e.g. the
   * rewrite pass) should use rewritePage() so the manifest stays clean.
   */
  async savePage(url: string, html: string): Promise<SavedPage | null> {
    const logger = getLogger();
    const resolved = this.resolver.resolvePage(url);
    const dir = path.dirname(resolved.absolutePath);

    fs.mkdirSync(dir, { recursive: true });

    try {
      const content = Buffer.from(html, "utf8");
      fs.writeFileSync(resolved.absolutePath, content);

      const saved: SavedPage = {
        url,
        localPath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        size: content.byteLength,
      };

      // Only add to the manifest on the first save for this URL.
      if (!this.savedPageUrls.has(url)) {
        this.savedPageUrls.add(url);
        this.savedPages.push(saved);
      } else {
        // Update size of the existing manifest entry so it reflects
        // the final (rewritten) file size.
        const existing = this.savedPages.find((p) => p.url === url);
        if (existing) existing.size = content.byteLength;
      }

      logger.debug(
        { url, path: resolved.relativePath, bytes: content.byteLength },
        "Page saved"
      );
      return saved;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: reason }, "Failed to save page");
      this.recordFailure(url, reason);
      return null;
    }
  }

  /**
   * Overwrite a page's HTML file with the rewritten content.
   * Does NOT push a new entry to savedPages — use this for the rewrite
   * pass after the initial savePage() call.
   */
  async rewritePage(url: string, html: string): Promise<void> {
    const logger = getLogger();
    const resolved = this.resolver.resolvePage(url);
    const dir = path.dirname(resolved.absolutePath);

    fs.mkdirSync(dir, { recursive: true });

    try {
      const content = Buffer.from(html, "utf8");
      fs.writeFileSync(resolved.absolutePath, content);

      // Update the size in the existing manifest entry.
      const existing = this.savedPages.find((p) => p.url === url);
      if (existing) existing.size = content.byteLength;

      logger.debug(
        { url, path: resolved.relativePath, bytes: content.byteLength },
        "Page rewritten"
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: reason }, "Failed to rewrite page");
    }
  }

  async saveAsset(
    url: string,
    body: Buffer,
    contentType: string
  ): Promise<SavedAsset | null> {
    const logger = getLogger();

    if (this.dedup.hasDownloadedAsset(url)) {
      logger.debug({ url }, "Asset already downloaded, skipping");
      return null;
    }

    // Guard: detect HTML body masquerading as a binary asset.
    //
    // This is a second line of defence (the first is in BrowserManager where
    // we check the response content-type header).  Some servers misconfigure
    // their error responses and send HTML with a binary content-type such as
    // image/jpeg or font/woff2 — the header check alone does not catch this.
    //
    // We inspect only the first 128 bytes, so this check is O(1) and has
    // effectively zero false-positive risk: any real binary asset (JPEG, PNG,
    // WOFF2, JS bundle, CSS) begins with non-HTML bytes (magic bytes, a BOM,
    // a copyright comment, or a declaration).
    const normContentType = contentType.split(";")[0].trim().toLowerCase();
    const isExpectedBinary =
      !normContentType.startsWith("text/") &&
      !normContentType.startsWith("application/json") &&
      !normContentType.startsWith("application/ld+json") &&
      normContentType !== "application/xml";

    if (isExpectedBinary && bodyLooksLikeHtml(body)) {
      logger.warn(
        { url, contentType, size: body.byteLength },
        "Asset body is an HTML document (error page served as binary asset) — skipping save"
      );
      return null;
    }

    // Mark before any async work so concurrent intercepts for the same
    // URL are blocked immediately, not after the file write completes.
    this.dedup.markAssetDownloaded(url);

    const resolved = this.resolver.resolveAsset(url, contentType);
    const dir = path.dirname(resolved.absolutePath);

    fs.mkdirSync(dir, { recursive: true });

    try {
      if (!fs.existsSync(resolved.absolutePath)) {
        fs.writeFileSync(resolved.absolutePath, body);
      }

      const saved: SavedAsset = {
        url,
        localPath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        size: body.byteLength,
        contentType,
      };

      this.savedAssets.push(saved);
      logger.debug(
        { url, path: resolved.relativePath, bytes: body.byteLength, contentType },
        "Asset saved"
      );
      return saved;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ url, err: reason }, "Failed to save asset");
      this.recordFailure(url, reason);
      return null;
    }
  }

  async saveScreenshot(name: string, buffer: Buffer): Promise<string> {
    const filePath = path.join(this.outputDir, "screenshots", `${name}.png`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * Record a URL as failed. Deduplicated — the same URL is only recorded once
   * regardless of how many internal paths call recordFailure for it.
   */
  recordFailure(url: string, reason: string): void {
    if (this.failedUrlSet.has(url)) return;
    this.failedUrlSet.add(url);
    this.failedUrls.push({ url, reason });
  }

  getLocalPath(url: string): string | null {
    const assigned = this.resolver.getAssigned();
    const rel = assigned.get(url);
    if (!rel) return null;
    return path.join(this.outputDir, rel);
  }

  getRelativePath(url: string): string | null {
    const assigned = this.resolver.getAssigned();
    return assigned.get(url) ?? null;
  }

  getResolver(): PathResolver {
    return this.resolver;
  }

  get allSavedAssets(): SavedAsset[] {
    return this.savedAssets;
  }

  get allSavedPages(): SavedPage[] {
    return this.savedPages;
  }

  get allFailedUrls(): Array<{ url: string; reason: string }> {
    return this.failedUrls;
  }

  get outputDirectory(): string {
    return this.outputDir;
  }
}
