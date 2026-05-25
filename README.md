# Website Recovery Crawler

A production-grade website recovery crawler using Node.js, Playwright, and TypeScript. Recovers fully rendered JavaScript-heavy websites for offline archival and static hosting deployment.

## What It Recovers

- Fully rendered HTML after JavaScript execution and hydration
- CSS, JavaScript bundles, source maps
- Fonts, images, SVGs, favicons
- JSON API responses used by frontend rendering
- Lazy-loaded and dynamically inserted assets
- Assets from SPA client-side route navigation (React, Next.js, Vue, Nuxt, Angular, Svelte)

## What It Does NOT Do

This tool is strictly for recovering publicly accessible frontend resources. It does not:

- Attempt authentication bypass or privilege escalation
- Extract databases, server code, or environment variables
- Access admin panels or hidden endpoints
- Perform any server-side exploitation

---

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)

## Setup

```bash
pnpm install
pnpm exec playwright install chromium --with-deps

# Optional: copy and customise environment
cp .env.example .env
```

---

## Usage

### Basic crawl

```bash
pnpm crawl --url https://example.com
```

### All options

```bash
pnpm crawl \
  --url https://example.com \
  --depth 8 \
  --concurrency 4 \
  --delay 300 \
  --network-idle-ms 4000 \
  --page-timeout 20000 \
  --max-retries 5 \
  --max-pages 200 \
  --allowed-domains cdn.example.com,fonts.googleapis.com \
  --user-agent "Mozilla/5.0 (compatible; MyCrawler/1.0)" \
  --viewport-width 1440 \
  --viewport-height 900 \
  --output ./output \
  --log-level debug \
  --no-scroll \
  --no-screenshots \
  --no-zip
```

### Resume an interrupted run

If a crawl is interrupted (Ctrl-C, runner timeout, etc.) a `.crawl-state.json` file is saved automatically in the output directory. Re-run with `--resume` to continue from where it stopped:

```bash
pnpm crawl --url https://example.com --resume
```

The state file records:
- All pages already visited (won't be re-crawled)
- All assets already downloaded (won't be re-fetched)
- All pending URLs that were discovered but not yet processed

### Via environment variables

Every option can be set in a `.env` file (see `.env.example`). CLI flags take precedence.

---

## CLI Reference

| Flag | Env variable | Default | Description |
|------|-------------|---------|-------------|
| `--url <url>` | `CRAWL_URL` | — | **Required.** Target URL |
| `--depth <n>` | `CRAWL_DEPTH` | `10` | Max crawl depth from root |
| `--concurrency <n>` | `CRAWL_CONCURRENCY` | `3` | Concurrent page workers |
| `--delay <ms>` | `CRAWL_DELAY_MS` | `500` | Delay between requests |
| `--network-idle-ms <ms>` | `CRAWL_NETWORK_IDLE_MS` | `5000` | Wait for network idle after navigation |
| `--page-timeout <ms>` | `PAGE_TIMEOUT_MS` | `30000` | Hard page load timeout |
| `--max-retries <n>` | `CRAWL_MAX_RETRIES` | `3` | Retries for failed requests |
| `--max-pages <n>` | `MAX_PAGES` | `0` | Max pages — `0` = unlimited |
| `--allowed-domains <list>` | `CRAWL_ALLOWED_DOMAINS` | — | Comma-separated extra domains |
| `--user-agent <string>` | `USER_AGENT` | — | Custom User-Agent |
| `--viewport-width <px>` | `VIEWPORT_WIDTH` | `1280` | Browser viewport width |
| `--viewport-height <px>` | `VIEWPORT_HEIGHT` | `900` | Browser viewport height |
| `--output <dir>` | `OUTPUT_DIR` | `./output` | Output directory |
| `--log-level <level>` | `LOG_LEVEL` | `info` | trace/debug/info/warn/error |
| `--no-scroll` | `CRAWL_SCROLL=false` | — | Disable lazy-load scroll |
| `--no-screenshots` | `CRAWL_DEBUG_SCREENSHOTS=false` | — | Disable error screenshots |
| `--no-zip` | — | — | Skip ZIP export |
| `--resume` | `CRAWL_RESUME=true` | — | Resume from saved state |
| `--no-pretty` | `LOG_PRETTY=false` | — | JSON log output |

---

## GitHub Actions

### Triggering a run

Go to **Actions → Website Recovery Crawler → Run workflow** and fill in the inputs. Every option is exposed as a workflow input with a default value — only the target URL is required.

| Input | Default | Description |
|-------|---------|-------------|
| `url` | — | **Required.** Target URL to crawl |
| `depth` | `10` | Max crawl depth |
| `concurrency` | `3` | Concurrent workers |
| `delay_ms` | `500` | Request delay (ms) |
| `network_idle_ms` | `5000` | Network idle wait (ms) |
| `page_timeout_ms` | `30000` | Page load timeout (ms) |
| `max_retries` | `3` | Retry limit |
| `max_pages` | `0` | Page limit (0 = unlimited) |
| `scroll` | `true` | Scroll to trigger lazy loading |
| `debug_screenshots` | `true` | Screenshots on error |
| `allowed_domains` | — | Extra domains (CSV) |
| `user_agent` | — | Custom User-Agent |
| `viewport_width` | `1280` | Viewport width (px) |
| `viewport_height` | `900` | Viewport height (px) |
| `log_level` | `info` | Log verbosity |
| `resume` | `false` | Resume from previous run |
| `create_release` | `true` | Create GitHub Release with ZIP |

### Resume in GitHub Actions

1. Run the workflow — if it times out or is cancelled, the output directory is saved as a cache entry.
2. Trigger again with `resume: true` and the **same URL** — the cache is restored and the crawl continues from where it stopped.
3. The state file (`.crawl-state.json`) is automatically deleted on successful completion.

### Artifacts and releases

Every run uploads:
- **`crawl-reports-<run-id>`** — `crawl-report.json`, `crawl-stats.json`, `missing-assets.json`
- **`crawl-screenshots-<run-id>`** — PNG screenshots from any page errors
- **`crawl-output-<run-id>`** — the complete output as a ZIP

When `create_release: true` (default), a GitHub Release is also created with the ZIP attached and a summary table in the release notes.

The job summary tab on every run shows a quick stats table: pages processed, assets downloaded, duration.

---

## Output Structure

```
output/
├── index.html                       ← root redirect for static hosting
├── pages/
│   ├── index.html
│   ├── about/index.html
│   └── products/item/index.html
├── assets/
│   ├── js/                          ← JavaScript bundles
│   ├── css/                         ← Stylesheets
│   ├── images/                      ← Images and SVGs
│   ├── fonts/                       ← Web fonts
│   └── media/                       ← Video and audio
├── api/                             ← JSON API responses
├── screenshots/                     ← Error debug screenshots
├── crawl-report.json                ← Full page + asset manifest
├── crawl-stats.json                 ← Timing and counters
└── missing-assets.json              ← Failed downloads
```

After crawling completes, a `crawl-output.zip` is written one level above `output/`.

---

## Deploying the Output

### Local preview

```bash
npx serve output/
# or
python3 -m http.server 8080 --directory output/
```

### Netlify

```bash
npx netlify-cli deploy --dir output/
```

### Vercel

```bash
npx vercel output/
```

### GitHub Pages / Cloudflare Pages / S3

Upload the contents of `output/` directly. The root `index.html` redirects to `pages/index.html`.

---

## Architecture

```
src/
├── config/          ← Environment + CLI config loading and validation
├── crawler/
│   ├── engine.ts          ← Orchestration, queue management, state persistence, shutdown
│   ├── browser.ts         ← Playwright lifecycle and network interception
│   ├── page-processor.ts  ← Per-page: navigate, wait for hydration, capture DOM, rewrite
│   └── route-discovery.ts ← Link extraction: DOM, SPA routes, scroll, data attributes
├── queue/
│   ├── crawl-queue.ts     ← p-queue backed BFS with concurrency control
│   └── deduplicator.ts    ← URL normalisation, visited tracking, state snapshots
├── storage/
│   ├── storage.ts         ← File write abstraction with dedup
│   ├── path-resolver.ts   ← URL → deterministic local file path mapping
│   ├── content-hash.ts    ← SHA-256 hashing for deduplication
│   └── state.ts           ← Crawl state persistence (save/load/delete for resume)
├── rewriter/
│   ├── html-rewriter.ts   ← cheerio-based URL rewriter (absolute → relative)
│   └── url-utils.ts       ← URL helpers, srcset parsing, CSS URL extraction
├── export/
│   ├── exporter.ts        ← ZIP generation via archiver
│   └── reporter.ts        ← JSON report and console summary
└── index.ts               ← CLI entry point (commander)
```

## Technical Details

### Asset Interception

Every network request is intercepted via Playwright's `page.route()`. The actual network response is fulfilled to the page (so rendering is unaffected) while the response body is simultaneously saved to disk. This captures:

- Assets loaded on initial render
- Assets loaded after JavaScript hydration
- Assets loaded by SPA route transitions
- Fetch/XHR API responses used for rendering data

### SPA Route Discovery

Routes are discovered from multiple sources in priority order:

1. `<a href>` attributes in the static HTML snapshot
2. All anchor elements in the live DOM after JS execution
3. Data attributes (`data-href`, `data-route`, `data-page`, etc.)
4. Scroll-triggered lazy content (disable with `--no-scroll`)
5. Framework-specific patterns: Next.js `__BUILD_MANIFEST`, Angular `ng-component`, Vue `router-view`, Nuxt

### HTML Rewriting

After each page is captured, all asset URLs are rewritten from absolute to relative paths. This covers:

- `<script src>`, `<link href>`, `<img src>`, `<source src>`, `<video src>`, `<audio src>`
- `srcset` attributes (all descriptors, including width and density)
- `<link rel="preload">` and `<link rel="modulepreload">`
- `<meta property="og:image">`, `twitter:image`, and similar meta tags
- `data-href` and `data-src` attributes

### Resume / State Persistence

The crawl engine saves a `.crawl-state.json` file to the output directory:

- **Every 30 seconds** via a background interval
- **Every 10 pages** processed
- **Immediately on SIGTERM / SIGINT** (Ctrl-C, runner cancellation)

On startup with `--resume`, the state file is loaded and the deduplicator is seeded with previously-visited pages and downloaded assets. Pending URLs (discovered but not yet crawled) are re-enqueued to continue where the previous run stopped.

The state file is automatically deleted on successful completion.

### Reliability

- **Retries**: Failed network requests use exponential backoff with jitter
- **Rate limiting**: Configurable per-request delay protects against throttling
- **Graceful shutdown**: SIGTERM/SIGINT saves state and closes the browser cleanly
- **Deduplication**: URLs are normalised (sorted query params, stripped fragments) before queuing; content is deduplicated by SHA-256 hash to avoid duplicate files
- **Error screenshots**: On page failure, a PNG is saved to `output/screenshots/` for post-run debugging
