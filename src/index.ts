import { Command } from "commander";
import { loadConfig, CrawlerConfig } from "./config";
import { initLogger, getLogger } from "./utils/logger";
import { CrawlerEngine } from "./crawler/engine";
import { Reporter } from "./export/reporter";
import { exportToZip, generateRootRedirect } from "./export/exporter";

const program = new Command();

program
  .name("crawler")
  .description("Production-grade website recovery crawler")
  .version("1.0.0")
  .option("-u, --url <url>", "Target URL to crawl")
  .option("-d, --depth <number>", "Maximum crawl depth", parseInt)
  .option("-c, --concurrency <number>", "Number of concurrent page workers", parseInt)
  .option("-o, --output <dir>", "Output directory")
  .option("--delay <ms>", "Delay between page requests in ms", parseInt)
  .option("--network-idle-ms <ms>", "Network idle wait timeout in ms", parseInt)
  .option("--page-timeout <ms>", "Page load timeout in ms", parseInt)
  .option("--max-retries <number>", "Max retries for failed requests", parseInt)
  .option("--max-pages <number>", "Max pages to crawl — 0 = unlimited", parseInt)
  .option("--allowed-domains <domains>", "Comma-separated extra allowed domains")
  .option("--user-agent <string>", "Custom User-Agent string")
  .option("--viewport-width <px>", "Viewport width in pixels", parseInt)
  .option("--viewport-height <px>", "Viewport height in pixels", parseInt)
  .option("--no-scroll", "Disable scroll-to-trigger lazy loading")
  .option("--no-screenshots", "Disable debug screenshots on page errors")
  .option("--no-zip", "Skip ZIP export after crawl completes")
  .option("--resume", "Resume from a previous interrupted run")
  .option("--log-level <level>", "Log level: trace | debug | info | warn | error")
  .option("--no-pretty", "Output newline-delimited JSON logs instead of pretty-printed")
  .option(
    "--strip-params <params>",
    "Comma-separated query param names to strip from URLs before normalization " +
      "(extends built-in list: add-to-cart, utm_source, fbclid, etc.)"
  )
  .option(
    "--block-params <params>",
    "Comma-separated query param names that mark a URL as an action endpoint " +
      "to skip entirely (extends built-in list: _wpnonce, remove_item, etc.)"
  );

program.parse(process.argv);

const opts = program.opts<{
  url?: string;
  depth?: number;
  concurrency?: number;
  output?: string;
  delay?: number;
  networkIdleMs?: number;
  pageTimeout?: number;
  maxRetries?: number;
  maxPages?: number;
  allowedDomains?: string;
  userAgent?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  scroll: boolean;
  screenshots: boolean;
  zip: boolean;
  resume: boolean;
  logLevel?: string;
  pretty: boolean;
  stripParams?: string;
  blockParams?: string;
}>();

function parseParamList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const overrides: Partial<CrawlerConfig> = {};

  if (opts.url) overrides.url = opts.url;
  if (opts.depth !== undefined) overrides.depth = opts.depth;
  if (opts.concurrency !== undefined) overrides.concurrency = opts.concurrency;
  if (opts.output) overrides.outputDir = opts.output;
  if (opts.delay !== undefined) overrides.delayMs = opts.delay;
  if (opts.networkIdleMs !== undefined) overrides.networkIdleMs = opts.networkIdleMs;
  if (opts.pageTimeout !== undefined) overrides.pageTimeoutMs = opts.pageTimeout;
  if (opts.maxRetries !== undefined) overrides.maxRetries = opts.maxRetries;
  if (opts.maxPages !== undefined) overrides.maxPages = opts.maxPages;
  if (opts.userAgent) overrides.userAgent = opts.userAgent;
  if (opts.viewportWidth !== undefined) overrides.viewportWidth = opts.viewportWidth;
  if (opts.viewportHeight !== undefined) overrides.viewportHeight = opts.viewportHeight;
  if (!opts.scroll) overrides.scroll = false;
  if (!opts.screenshots) overrides.debugScreenshots = false;
  if (opts.logLevel) overrides.logLevel = opts.logLevel;
  if (!opts.pretty) overrides.logPretty = false;
  if (opts.resume) overrides.resume = true;

  if (opts.allowedDomains) {
    overrides.allowedDomains = opts.allowedDomains
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
  }

  // Strip / block param extensions — merged with built-in defaults in loadConfig()
  const extraStrip = parseParamList(opts.stripParams);
  const extraBlock = parseParamList(opts.blockParams);
  if (extraStrip.length > 0) overrides.stripParams = new Set(extraStrip);
  if (extraBlock.length > 0) overrides.blockParams = new Set(extraBlock);

  let config: CrawlerConfig;
  try {
    config = loadConfig(overrides);
  } catch (err) {
    console.error(
      "Configuration error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  }

  const logger = initLogger({ level: config.logLevel, pretty: config.logPretty });

  logger.info(
    {
      url: config.url,
      depth: config.depth,
      concurrency: config.concurrency,
      outputDir: config.outputDir,
      delayMs: config.delayMs,
      networkIdleMs: config.networkIdleMs,
      pageTimeoutMs: config.pageTimeoutMs,
      maxRetries: config.maxRetries,
      maxPages: config.maxPages || "unlimited",
      allowedDomains: config.allowedDomains,
      scroll: config.scroll,
      debugScreenshots: config.debugScreenshots,
      resume: config.resume,
      stripParams: [...config.stripParams],
      blockParams: [...config.blockParams],
    },
    "Starting website recovery crawler"
  );

  const engine = new CrawlerEngine(config);

  let exitCode = 0;

  try {
    const stats = await engine.run();

    generateRootRedirect(config.outputDir);

    const reporter = new Reporter(
      engine.storageLayer,
      engine.deduplicate,
      config.url
    );
    reporter.saveReports(config.outputDir, stats);

    if (opts.zip) {
      try {
        const result = await exportToZip(config.outputDir);
        logger.info(
          {
            zipPath: result.zipPath,
            sizeMb: (result.sizeBytes / 1024 / 1024).toFixed(2),
          },
          "Export ZIP created"
        );
      } catch (zipErr) {
        logger.error(
          { err: zipErr instanceof Error ? zipErr.message : String(zipErr) },
          "ZIP export failed"
        );
        exitCode = 1;
      }
    }

    if (stats.pagesFailed > 0) {
      logger.warn({ pagesFailed: stats.pagesFailed }, "Crawl completed with failures");
      exitCode = exitCode === 0 ? 1 : exitCode;
    } else {
      logger.info("Crawl completed successfully");
    }
  } catch (err) {
    getLogger().fatal(
      { err: err instanceof Error ? err.message : String(err) },
      "Fatal crawler error"
    );
    exitCode = 2;
  }

  process.exit(exitCode);
}

void main();
