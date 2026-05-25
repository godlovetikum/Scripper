import crypto from "crypto";

export interface DeduplicatorSnapshot {
  visitedPages: string[];
  downloadedAssets: string[];
}

/**
 * Tracks visited URLs and downloaded assets to prevent duplicate work.
 * URL normalization ensures that equivalent URLs are not crawled twice.
 * Supports seeding from a saved state snapshot for resume runs.
 */
export class Deduplicator {
  private visitedPages = new Set<string>();
  private downloadedAssets = new Set<string>();
  private contentHashes = new Set<string>();

  normalizePageUrl(rawUrl: string, baseUrl: string): string | null {
    try {
      const url = new URL(rawUrl, baseUrl);
      url.hash = "";
      url.searchParams.sort();
      let normalized = url.toString();
      if (normalized.endsWith("/") && url.pathname !== "/") {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    } catch {
      return null;
    }
  }

  normalizeAssetUrl(rawUrl: string, baseUrl?: string): string | null {
    try {
      const url = new URL(rawUrl, baseUrl);
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * Seed the deduplicator from a saved state snapshot so a resume run
   * does not re-visit or re-download already-processed URLs.
   */
  loadFromSnapshot(snapshot: DeduplicatorSnapshot): void {
    for (const url of snapshot.visitedPages) {
      this.visitedPages.add(url);
    }
    for (const url of snapshot.downloadedAssets) {
      this.downloadedAssets.add(url);
    }
  }

  /**
   * Return a point-in-time snapshot of all visited and downloaded URLs
   * for persisting to disk.
   */
  snapshot(): DeduplicatorSnapshot {
    return {
      visitedPages: Array.from(this.visitedPages),
      downloadedAssets: Array.from(this.downloadedAssets),
    };
  }

  hasVisitedPage(url: string): boolean {
    return this.visitedPages.has(url);
  }

  markPageVisited(url: string): void {
    this.visitedPages.add(url);
  }

  hasDownloadedAsset(url: string): boolean {
    return this.downloadedAssets.has(url);
  }

  markAssetDownloaded(url: string): void {
    this.downloadedAssets.add(url);
  }

  hasContentHash(content: Buffer): boolean {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (this.contentHashes.has(hash)) return true;
    this.contentHashes.add(hash);
    return false;
  }

  get visitedCount(): number {
    return this.visitedPages.size;
  }

  get downloadedCount(): number {
    return this.downloadedAssets.size;
  }

  getVisitedPages(): string[] {
    return Array.from(this.visitedPages);
  }

  getDownloadedAssets(): string[] {
    return Array.from(this.downloadedAssets);
  }
}
