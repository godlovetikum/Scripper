import "dotenv/config";
import path from "path";
import {
  DEFAULT_STRIP_PARAMS,
  DEFAULT_EXPLICIT_BLOCK_PARAMS,
  mergeParamSet,
} from "../utils/url-filters";

export interface CrawlerConfig {
  url: string;
  depth: number;
  concurrency: number;
  delayMs: number;
  networkIdleMs: number;
  maxRetries: number;
  allowedDomains: string[];
  outputDir: string;
  scroll: boolean;
  debugScreenshots: boolean;
  logLevel: string;
  logPretty: boolean;
  viewportWidth: number;
  viewportHeight: number;
  userAgent: string | undefined;
  pageTimeoutMs: number;
  maxPages: number;
  resume: boolean;
  /**
   * Query params stripped from page URLs before normalization.
   * Variants that differ only by these params collapse to the same page.
   * Default: built-in list (UTM, add-to-cart, etc.) + user-provided extras.
   */
  stripParams: Set<string>;
  /**
   * Query params whose presence makes a URL an action URL to be skipped.
   * Default: built-in list (_wpnonce, remove_item, etc.) + user extras.
   */
  blockParams: Set<string>;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function parseDomains(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

function parseParamList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<CrawlerConfig> = {}): CrawlerConfig {
  const url = overrides.url ?? process.env["CRAWL_URL"] ?? "";
  if (!url) {
    throw new Error(
      "No target URL specified. Set CRAWL_URL in .env or pass --url <url>"
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const extraDomains = [
    ...parseDomains(process.env["CRAWL_ALLOWED_DOMAINS"]),
    ...(overrides.allowedDomains ?? []),
  ];
  const allowedDomains = [parsedUrl.hostname, ...extraDomains];

  const outputDir = path.resolve(
    overrides.outputDir ?? process.env["OUTPUT_DIR"] ?? "./output"
  );

  // Strip params: built-in defaults + env-var extras + CLI/override extras
  const envStripExtras = parseParamList(process.env["CRAWL_STRIP_PARAMS"]);
  const overrideStrip = overrides.stripParams
    ? Array.from(overrides.stripParams)
    : [];
  const stripParams = mergeParamSet(DEFAULT_STRIP_PARAMS, [
    ...envStripExtras,
    ...overrideStrip,
  ]);

  // Block params: built-in defaults + env-var extras + CLI/override extras
  const envBlockExtras = parseParamList(process.env["CRAWL_BLOCK_PARAMS"]);
  const overrideBlock = overrides.blockParams
    ? Array.from(overrides.blockParams)
    : [];
  const blockParams = mergeParamSet(DEFAULT_EXPLICIT_BLOCK_PARAMS, [
    ...envBlockExtras,
    ...overrideBlock,
  ]);

  return {
    url: parsedUrl.toString(),
    depth: overrides.depth ?? parseInteger(process.env["CRAWL_DEPTH"], 10),
    concurrency:
      overrides.concurrency ??
      parseInteger(process.env["CRAWL_CONCURRENCY"], 3),
    delayMs:
      overrides.delayMs ?? parseInteger(process.env["CRAWL_DELAY_MS"], 500),
    networkIdleMs:
      overrides.networkIdleMs ??
      parseInteger(process.env["CRAWL_NETWORK_IDLE_MS"], 5000),
    maxRetries:
      overrides.maxRetries ??
      parseInteger(process.env["CRAWL_MAX_RETRIES"], 3),
    allowedDomains,
    outputDir,
    scroll:
      overrides.scroll ?? parseBoolean(process.env["CRAWL_SCROLL"], true),
    debugScreenshots:
      overrides.debugScreenshots ??
      parseBoolean(process.env["CRAWL_DEBUG_SCREENSHOTS"], true),
    logLevel: overrides.logLevel ?? process.env["LOG_LEVEL"] ?? "info",
    logPretty:
      overrides.logPretty ?? parseBoolean(process.env["LOG_PRETTY"], true),
    viewportWidth:
      overrides.viewportWidth ??
      parseInteger(process.env["VIEWPORT_WIDTH"], 1280),
    viewportHeight:
      overrides.viewportHeight ??
      parseInteger(process.env["VIEWPORT_HEIGHT"], 900),
    userAgent: overrides.userAgent ?? process.env["USER_AGENT"] ?? undefined,
    pageTimeoutMs:
      overrides.pageTimeoutMs ??
      parseInteger(process.env["PAGE_TIMEOUT_MS"], 30000),
    maxPages:
      overrides.maxPages ?? parseInteger(process.env["MAX_PAGES"], 0),
    resume:
      overrides.resume ?? parseBoolean(process.env["CRAWL_RESUME"], false),
    stripParams,
    blockParams,
  };
}
