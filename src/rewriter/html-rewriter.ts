import * as cheerio from "cheerio";
import { toRelativePath, resolveUrl, isSkippableUrl } from "./url-utils";
import { StorageLayer } from "../storage/storage";
import { getLogger } from "../utils/logger";

interface RewriteTarget {
  selector: string;
  attr: string;
}

const REWRITE_TARGETS: RewriteTarget[] = [
  { selector: "script[src]", attr: "src" },
  { selector: "link[href]", attr: "href" },
  { selector: "img[src]", attr: "src" },
  { selector: "img[data-src]", attr: "data-src" },
  { selector: "source[src]", attr: "src" },
  { selector: "video[src]", attr: "src" },
  { selector: "audio[src]", attr: "src" },
  { selector: "iframe[src]", attr: "src" },
  { selector: "use[href]", attr: "href" },
  { selector: "use[xlink\\:href]", attr: "xlink:href" },
];

/**
 * Rewrite a srcset attribute to use local relative paths.
 */
function rewriteSrcset(
  srcset: string,
  pageUrl: string,
  pageRelPath: string,
  storage: StorageLayer
): string {
  const parts = srcset.split(",").map((s) => s.trim());
  const rewritten = parts.map((part) => {
    const tokens = part.split(/\s+/);
    const url = tokens[0];
    if (!url || isSkippableUrl(url)) return part;

    const abs = resolveUrl(url, pageUrl);
    if (!abs) return part;

    const localRel = storage.getRelativePath(abs);
    if (!localRel) return part;

    const rel = toRelativePath(localRel, pageRelPath);
    tokens[0] = rel;
    return tokens.join(" ");
  });
  return rewritten.join(", ");
}

/**
 * Rewrite all asset URLs in an HTML string to relative paths.
 * Must be called after all assets for the page have been saved.
 */
export function rewriteHtml(
  html: string,
  pageUrl: string,
  pageRelPath: string,
  storage: StorageLayer
): string {
  const logger = getLogger();
  const $ = cheerio.load(html);
  let rewriteCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function rewriteAttr($el: cheerio.Cheerio<any>, attr: string): void {
    const original = $el.attr(attr);
    if (!original || isSkippableUrl(original)) return;

    const abs = resolveUrl(original, pageUrl);
    if (!abs) return;

    const localRel = storage.getRelativePath(abs);
    if (!localRel) return;

    const relative = toRelativePath(localRel, pageRelPath);
    $el.attr(attr, relative);
    rewriteCount++;
  }

  for (const { selector, attr } of REWRITE_TARGETS) {
    $(selector).each((_, el) => {
      rewriteAttr($(el), attr);
    });
  }

  $("[srcset]").each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr("srcset");
    if (srcset) {
      const rewritten = rewriteSrcset(srcset, pageUrl, pageRelPath, storage);
      $el.attr("srcset", rewritten);
      rewriteCount++;
    }
  });

  $("link[rel='preload'][href], link[rel='modulepreload'][href]").each((_, el) => {
    rewriteAttr($(el), "href");
  });

  $("[data-href]").each((_, el) => {
    rewriteAttr($(el), "data-href");
  });

  $("meta[content]").each((_, el) => {
    const $el = $(el);
    const name = ($el.attr("name") ?? $el.attr("property") ?? "").toLowerCase();
    if (
      name === "og:image" ||
      name === "twitter:image" ||
      name === "og:url" ||
      name === "canonical"
    ) {
      const content = $el.attr("content");
      if (content && !isSkippableUrl(content)) {
        const abs = resolveUrl(content, pageUrl);
        if (abs) {
          const localRel = storage.getRelativePath(abs);
          if (localRel) {
            const relative = toRelativePath(localRel, pageRelPath);
            $el.attr("content", relative);
            rewriteCount++;
          }
        }
      }
    }
  });

  logger.debug(
    { pageUrl, pageRelPath, rewriteCount },
    "HTML rewrite complete"
  );

  return $.html();
}

/**
 * Extract all href/src values from an HTML string for a given page URL.
 * Returns absolute URLs.
 */
export function extractLinksFromHtml(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const links = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || isSkippableUrl(href)) return;
    const abs = resolveUrl(href, pageUrl);
    if (abs) links.add(abs);
  });

  $("[data-page], [data-route], [data-href]").each((_, el) => {
    const $el = $(el);
    const val = $el.attr("data-page") ?? $el.attr("data-route") ?? $el.attr("data-href");
    if (!val || isSkippableUrl(val)) return;
    const abs = resolveUrl(val, pageUrl);
    if (abs) links.add(abs);
  });

  return Array.from(links);
}
