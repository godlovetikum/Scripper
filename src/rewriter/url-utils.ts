import path from "path";

/**
 * Normalize a URL relative to a base, returning null on failure.
 */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Returns true if the URL belongs to one of the allowed domains.
 */
export function isInternalUrl(url: string, allowedDomains: string[]): boolean {
  try {
    const parsed = new URL(url);
    return allowedDomains.some(
      (domain) =>
        parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Convert an absolute or root-relative URL to a relative path
 * suitable for embedding in a rewritten HTML file at `fromPagePath`.
 *
 * @param assetLocalRelPath - e.g. "assets/js/main.abc123.js"
 * @param fromPageLocalRelPath - e.g. "pages/blog/post/index.html"
 */
export function toRelativePath(
  assetLocalRelPath: string,
  fromPageLocalRelPath: string
): string {
  const fromDir = path.dirname(fromPageLocalRelPath);
  let rel = path.relative(fromDir, assetLocalRelPath);

  rel = rel.replace(/\\/g, "/");

  if (!rel.startsWith(".")) {
    rel = "./" + rel;
  }

  return rel;
}

/**
 * Strip query string and fragment from a URL, returning just the path.
 */
export function urlPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Check if a URL should be skipped (mailto, tel, data URIs, javascript:, etc.)
 */
export function isSkippableUrl(href: string): boolean {
  const lower = href.trim().toLowerCase();
  return (
    lower.startsWith("data:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("#") ||
    lower === ""
  );
}

/**
 * Extract all URLs from a CSS string (url(...) expressions).
 */
export function extractCssUrls(css: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const url = match[2];
    if (url && !isSkippableUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}
