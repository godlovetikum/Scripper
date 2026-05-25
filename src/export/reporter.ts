import fs from "fs";
import path from "path";
import { StorageLayer } from "../storage/storage";
import { Deduplicator } from "../queue/deduplicator";
import { EngineStats } from "../crawler/engine";
import { getLogger } from "../utils/logger";

export interface CrawlReport {
  meta: {
    generatedAt: string;
    targetUrl: string;
    crawlDurationSeconds: number | null;
  };
  statistics: {
    pagesProcessed: number;
    pagesSucceeded: number;
    pagesFailed: number;
    assetsDownloaded: number;
    totalFilesWritten: number;
    totalBytesWritten: number;
  };
  pages: Array<{
    url: string;
    localPath: string;
    sizeBytes: number;
  }>;
  assets: Array<{
    url: string;
    localPath: string;
    contentType: string;
    sizeBytes: number;
  }>;
  failures: Array<{
    url: string;
    reason: string;
  }>;
}

export interface MissingAssetReport {
  generatedAt: string;
  totalMissing: number;
  missingAssets: Array<{
    url: string;
    reason: string;
  }>;
}

export class Reporter {
  private storage: StorageLayer;
  private dedup: Deduplicator;
  private targetUrl: string;

  constructor(storage: StorageLayer, dedup: Deduplicator, targetUrl: string) {
    this.storage = storage;
    this.dedup = dedup;
    this.targetUrl = targetUrl;
  }

  generateReport(stats: EngineStats): CrawlReport {
    const pages = this.storage.allSavedPages;
    const assets = this.storage.allSavedAssets;
    const failures = this.storage.allFailedUrls;

    const totalBytesWritten =
      pages.reduce((sum, p) => sum + p.size, 0) +
      assets.reduce((sum, a) => sum + a.size, 0);

    return {
      meta: {
        generatedAt: new Date().toISOString(),
        targetUrl: this.targetUrl,
        crawlDurationSeconds: stats.durationSeconds,
      },
      statistics: {
        pagesProcessed: stats.pagesProcessed,
        pagesSucceeded: stats.pagesSucceeded,
        pagesFailed: stats.pagesFailed,
        assetsDownloaded: stats.assetsDownloaded,
        totalFilesWritten: pages.length + assets.length,
        totalBytesWritten,
      },
      pages: pages.map((p) => ({
        url: p.url,
        localPath: p.relativePath,
        sizeBytes: p.size,
      })),
      assets: assets.map((a) => ({
        url: a.url,
        localPath: a.relativePath,
        contentType: a.contentType,
        sizeBytes: a.size,
      })),
      failures: failures,
    };
  }

  generateMissingAssetReport(): MissingAssetReport {
    const failures = this.storage.allFailedUrls;
    return {
      generatedAt: new Date().toISOString(),
      totalMissing: failures.length,
      missingAssets: failures,
    };
  }

  saveReports(outputDir: string, stats: EngineStats): void {
    const logger = getLogger();

    const report = this.generateReport(stats);
    const missingReport = this.generateMissingAssetReport();

    const reportPath = path.join(outputDir, "crawl-report.json");
    const missingPath = path.join(outputDir, "missing-assets.json");
    const statsPath = path.join(outputDir, "crawl-stats.json");

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    fs.writeFileSync(missingPath, JSON.stringify(missingReport, null, 2), "utf8");
    fs.writeFileSync(
      statsPath,
      JSON.stringify(
        {
          ...stats,
          startedAt: stats.startedAt.toISOString(),
          finishedAt: stats.finishedAt?.toISOString() ?? null,
        },
        null,
        2
      ),
      "utf8"
    );

    logger.info(
      { reportPath, missingPath, statsPath },
      "Reports saved"
    );

    this.printSummary(report);
  }

  private printSummary(report: CrawlReport): void {
    const logger = getLogger();
    const s = report.statistics;
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

    logger.info("════════════════════════════════════════");
    logger.info("            CRAWL SUMMARY");
    logger.info("════════════════════════════════════════");
    logger.info(`  Target URL   : ${report.meta.targetUrl}`);
    logger.info(`  Duration     : ${report.meta.crawlDurationSeconds?.toFixed(1)}s`);
    logger.info(`  Pages        : ${s.pagesSucceeded} ok / ${s.pagesFailed} failed`);
    logger.info(`  Assets       : ${s.assetsDownloaded} downloaded`);
    logger.info(`  Files        : ${s.totalFilesWritten} written`);
    logger.info(`  Total size   : ${mb(s.totalBytesWritten)} MB`);
    logger.info("════════════════════════════════════════");

    if (s.pagesFailed > 0) {
      logger.warn(`  ${s.pagesFailed} pages failed — check missing-assets.json`);
    }
  }
}
