/**
 * Universal URL filtering for the recovery crawler.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DESIGN PHILOSOPHY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The goal is to classify every discovered URL into one of three buckets
 * WITHOUT requiring site-specific knowledge:
 *
 *   BLOCK   – URL is a one-time-use action endpoint (causes a server-side
 *             mutation, or encodes session-specific state that cannot be
 *             archived).  Skip it entirely.
 *
 *   STRIP   – URL has decorators that don't affect page content.  Remove
 *             them so variants collapse to the same canonical URL.
 *
 *   CRAWL   – Everything else.  Content-hash deduplication (see
 *             Deduplicator.hasContentHash) catches any remaining duplicates
 *             after the page is actually fetched.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HOW EACH RULE IS UNIVERSAL, NOT SITE-SPECIFIC
 * ══════════════════════════════════════════════════════════════════════════
 *
 * BLOCK — two heuristics, both platform-agnostic:
 *
 *   1. HASH-VALUE PATTERN
 *      Any query-param value that is a long lowercase hex string (32+ chars)
 *      is a cryptographic hash token.  No application uses a 32-char hex
 *      string as a human-readable identifier; they are always security nonces,
 *      session tokens, or item-level hashes generated per-request.
 *      Examples: WooCommerce cart-item hash, CSRF tokens, HMAC signatures.
 *      This heuristic catches action URLs from ANY platform.
 *
 *   2. NONCE-KEYWORD IN PARAM NAME
 *      Every major web framework uses a recognisable word in the param name
 *      when embedding a security nonce or CSRF token in a URL:
 *        WordPress  → _wpnonce
 *        Rails      → authenticity_token
 *        Laravel    → _token
 *        Django     → csrfmiddlewaretoken
 *        ASP.NET    → __RequestVerificationToken
 *        Generic    → nonce, csrf, token (in various casing/prefixes)
 *      Detecting these keywords covers all current and future frameworks
 *      without maintaining a list of specific param names.
 *
 * STRIP — two categories, both internet-wide standards:
 *
 *   1. TRACKING PARAMETERS (utm_*, ad-platform click IDs)
 *      UTM parameters are a Google Analytics standard adopted universally.
 *      Click IDs (fbclid, gclid, msclkid, ttclid, etc.) are published
 *      specifications from Facebook, Google, Microsoft, and TikTok.
 *      They are present on ANY website that runs analytics or paid ads and
 *      never affect the rendered page content.
 *
 *   2. E-COMMERCE NAVIGATION SHORTCUTS
 *      ?add-to-cart=ID, ?variation_id=ID, and ?added-to-cart are
 *      cross-platform conventions used by WooCommerce, Shopify, Magento,
 *      BigCommerce, and OpenCart.  They are "shortcut" links that trigger
 *      a cart action server-side and then redirect or serve the same page
 *      that exists at the URL without those params.  Stripping them means
 *      the underlying product or category page is still crawled once — the
 *      shortcut param is simply not followed as if it were a distinct page.
 */

// ── STRIP: well-known tracking parameters ────────────────────────────────────

/**
 * Query parameters that are stripped from URLs before normalization.
 * A URL differing from a known URL only by these params is treated as the
 * same page.
 *
 * Extend at runtime via `--strip-params` on the CLI.
 */
export const DEFAULT_STRIP_PARAMS: ReadonlySet<string> = new Set([
  // UTM — Google Analytics standard, universally adopted
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  // Ad-platform click IDs — published specs from each platform
  "fbclid",   // Facebook / Meta
  "gclid",    // Google Ads
  "msclkid",  // Microsoft Advertising
  "ttclid",   // TikTok
  "twclid",   // Twitter / X
  "igshid",   // Instagram
  "li_fat_id", // LinkedIn
  "dclid",    // Google Display & Video 360
  "wbraid",   // Google (web-to-app)
  "gbraid",   // Google (app-to-web)
  // E-commerce navigation shortcuts (cross-platform convention)
  "add-to-cart",    // WooCommerce / Shopify / Magento shortcut link
  "added-to-cart",  // WooCommerce post-add confirmation
  "variation_id",   // WooCommerce / Magento variable-product selector
  // PHP session (does not affect page content, changes per visitor)
  "PHPSESSID",
  "phpsessid",
]);

// ── BLOCK: nonce / hash pattern detection ────────────────────────────────────

/**
 * Regex that matches the VALUE of a param that encodes a cryptographic hash.
 *   32 chars = MD5  (WooCommerce cart-item hash, many CMS tokens)
 *   40 chars = SHA-1
 *   64 chars = SHA-256
 * Values shorter than 32 hex chars are too likely to be genuine IDs.
 */
const HASH_VALUE_RE = /^[0-9a-f]{32,}$/;

/**
 * Keywords in a param KEY that universally signal a security nonce or
 * CSRF token across all web frameworks.  Matched case-insensitively.
 */
const NONCE_KEY_KEYWORDS = ["nonce", "csrf", "_token", "authenticity_token"];

/**
 * Additional explicit block param names for edge cases the heuristics miss.
 * Users can extend this via `--block-params`.
 */
export const DEFAULT_EXPLICIT_BLOCK_PARAMS: ReadonlySet<string> = new Set([
  // WooCommerce cart mutation actions (remove_item and undo_item values are
  // 32-char hex hashes so the hash heuristic catches them; these explicit
  // names are a belt-and-braces defence in case the value format changes).
  "remove_item",
  "undo_item",
]);

/**
 * Returns true if the URL represents an action endpoint that should NOT be
 * crawled.  Uses three universal, platform-agnostic heuristics:
 *
 *   1. Param value is a 32+ char lowercase hex string (hash/nonce token)
 *   2. Param key contains a well-known nonce/CSRF keyword
 *   3. Param key is in the explicit block list
 *
 * Returns false for unparseable URLs (fail-open: don't block what we can't
 * read).
 */
export function isActionUrl(
  url: string,
  explicitBlockParams: ReadonlySet<string> = DEFAULT_EXPLICIT_BLOCK_PARAMS
): boolean {
  try {
    const parsed = new URL(url);
    for (const [key, value] of parsed.searchParams.entries()) {
      // 1. Hash-value heuristic (platform-agnostic)
      if (HASH_VALUE_RE.test(value)) return true;

      // 2. Nonce-keyword heuristic (framework-agnostic)
      const lowerKey = key.toLowerCase();
      if (NONCE_KEY_KEYWORDS.some((kw) => lowerKey.includes(kw))) return true;

      // 3. Explicit block list (extension point)
      if (explicitBlockParams.has(key)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Remove all params listed in `stripSet` from `url`.
 * Returns the modified URL string, or the original on parse failure.
 */
export function stripQueryParams(
  url: string,
  stripSet: ReadonlySet<string>
): string {
  try {
    const parsed = new URL(url);
    const toDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (stripSet.has(key)) toDelete.push(key);
    }
    if (toDelete.length === 0) return url;
    for (const key of toDelete) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Merge a built-in default set with a user-supplied list of extra names.
 */
export function mergeParamSet(
  defaults: ReadonlySet<string>,
  extras: string[]
): Set<string> {
  return new Set([...defaults, ...extras]);
}
