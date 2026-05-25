import fs from "fs";
import path from "path";
import { getLogger } from "../utils/logger";

export interface PendingUrl {
  url: string;
  depth: number;
  parentUrl: string | null;
}

export interface CrawlState {
  version: "1";
  targetUrl: string;
  savedAt: string;
  visitedPages: string[];
  downloadedAssets: string[];
  pendingUrls: PendingUrl[];
  stats: {
    pagesProcessed: number;
    pagesSucceeded: number;
    pagesFailed: number;
  };
}

const STATE_FILE_NAME = ".crawl-state.json";

export function getStatePath(outputDir: string): string {
  return path.join(outputDir, STATE_FILE_NAME);
}

export function saveState(outputDir: string, state: CrawlState): void {
  const statePath = getStatePath(outputDir);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    getLogger().debug({ statePath }, "Crawl state saved");
  } catch (err) {
    getLogger().warn(
      { statePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to save crawl state"
    );
  }
}

export function loadState(outputDir: string): CrawlState | null {
  const statePath = getStatePath(outputDir);
  if (!fs.existsSync(statePath)) {
    getLogger().debug({ statePath }, "No existing crawl state found");
    return null;
  }

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(raw) as CrawlState;

    if (state.version !== "1") {
      getLogger().warn(
        { version: state.version },
        "Unknown state file version — ignoring"
      );
      return null;
    }

    getLogger().info(
      {
        targetUrl: state.targetUrl,
        savedAt: state.savedAt,
        visitedPages: state.visitedPages.length,
        downloadedAssets: state.downloadedAssets.length,
        pendingUrls: state.pendingUrls.length,
      },
      "Loaded previous crawl state — resuming"
    );

    return state;
  } catch (err) {
    getLogger().warn(
      { statePath, err: err instanceof Error ? err.message : String(err) },
      "Failed to parse crawl state file — starting fresh"
    );
    return null;
  }
}

export function deleteState(outputDir: string): void {
  const statePath = getStatePath(outputDir);
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
      getLogger().debug({ statePath }, "Crawl state file deleted");
    }
  } catch {
    // non-fatal
  }
}
