import mimeTypes from "mime-types";

export type AssetCategory =
  | "js"
  | "css"
  | "images"
  | "fonts"
  | "media"
  | "api"
  | "other";

export interface MimeInfo {
  extension: string;
  category: AssetCategory;
}

const CATEGORY_MAP: Record<string, AssetCategory> = {
  "application/javascript": "js",
  "text/javascript": "js",
  "application/x-javascript": "js",
  "module/javascript": "js",
  "text/css": "css",
  "image/png": "images",
  "image/jpeg": "images",
  "image/gif": "images",
  "image/webp": "images",
  "image/svg+xml": "images",
  "image/avif": "images",
  "image/ico": "images",
  "image/x-icon": "images",
  "image/vnd.microsoft.icon": "images",
  "image/bmp": "images",
  "image/tiff": "images",
  "font/woff": "fonts",
  "font/woff2": "fonts",
  "font/ttf": "fonts",
  "font/otf": "fonts",
  "application/font-woff": "fonts",
  "application/font-woff2": "fonts",
  "application/x-font-ttf": "fonts",
  "application/x-font-otf": "fonts",
  "video/mp4": "media",
  "video/webm": "media",
  "video/ogg": "media",
  "audio/mpeg": "media",
  "audio/ogg": "media",
  "audio/wav": "media",
  "application/json": "api",
  "text/json": "api",
};

const EXTENSION_CATEGORY_MAP: Record<string, AssetCategory> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "js",
  ".ts": "js",
  ".tsx": "js",
  ".css": "css",
  ".png": "images",
  ".jpg": "images",
  ".jpeg": "images",
  ".gif": "images",
  ".webp": "images",
  ".svg": "images",
  ".avif": "images",
  ".ico": "images",
  ".bmp": "images",
  ".tiff": "images",
  ".woff": "fonts",
  ".woff2": "fonts",
  ".ttf": "fonts",
  ".otf": "fonts",
  ".eot": "fonts",
  ".mp4": "media",
  ".webm": "media",
  ".ogv": "media",
  ".mp3": "media",
  ".ogg": "media",
  ".wav": "media",
  ".json": "api",
};

export function getMimeInfo(
  contentType: string | undefined,
  urlOrPath: string
): MimeInfo {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";

  let category = CATEGORY_MAP[mimeType];
  let extension = mimeTypes.extension(mimeType) || "";

  if (!category || !extension) {
    try {
      const parsed = new URL(urlOrPath.startsWith("http") ? urlOrPath : `http://x${urlOrPath}`);
      const pathname = parsed.pathname;
      const ext = pathname.slice(pathname.lastIndexOf(".")).split("?")[0]?.toLowerCase() ?? "";

      if (ext && !category) {
        category = EXTENSION_CATEGORY_MAP[ext] ?? "other";
      }
      if (ext && !extension) {
        extension = ext.replace(/^\./, "");
      }
    } catch {
      // ignore parse errors
    }
  }

  if (!extension) extension = "bin";
  if (!category) category = "other";

  return { extension, category };
}

export function isTextContent(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("javascript") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("svg")
  );
}
