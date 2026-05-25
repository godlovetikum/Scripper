import path from "path";
import { getMimeInfo, AssetCategory } from "../utils/mime";

const CATEGORY_DIRS: Record<AssetCategory, string> = {
  js: path.join("assets", "js"),
  css: path.join("assets", "css"),
  images: path.join("assets", "images"),
  fonts: path.join("assets", "fonts"),
  media: path.join("assets", "media"),
  api: "api",
  other: path.join("assets", "other"),
};

export interface ResolvedPath {
  relativePath: string;
  absolutePath: string;
  isPage: boolean;
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[<>:"|?*\\]/g, "_").slice(0, 255);
}

function urlToPagePath(url: URL): string {
  let pathname = url.pathname;
  if (pathname === "/" || pathname === "") return path.join("pages", "index.html");
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.endsWith("/")) {
    pathname = pathname + "index.html";
  } else {
    const ext = path.extname(pathname);
    if (!ext || ext === ".htm" || ext === ".html") {
      if (!ext) pathname = pathname + "/index.html";
    }
  }
  const segments = pathname.split("/").filter(Boolean).map(sanitizePathSegment);
  return path.join("pages", ...segments);
}

function urlToAssetPath(url: URL, contentType: string | undefined): string {
  const { extension, category } = getMimeInfo(contentType, url.href);
  const pathname = url.pathname;
  const dir = CATEGORY_DIRS[category];

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return path.join(dir, `asset.${extension}`);
  }

  const sanitized = segments.map(sanitizePathSegment);
  const lastSegment = sanitized[sanitized.length - 1] ?? "asset";
  const hasExt = path.extname(lastSegment) !== "";

  if (!hasExt) {
    sanitized[sanitized.length - 1] = lastSegment + "." + extension;
  }

  return path.join(dir, ...sanitized);
}

export class PathResolver {
  private outputDir: string;
  private baseHostname: string;
  private assigned = new Map<string, string>();

  constructor(outputDir: string, baseUrl: string) {
    this.outputDir = outputDir;
    this.baseHostname = new URL(baseUrl).hostname;
  }

  resolvePage(pageUrl: string): ResolvedPath {
    const cached = this.assigned.get(pageUrl);
    if (cached) {
      return {
        relativePath: cached,
        absolutePath: path.join(this.outputDir, cached),
        isPage: true,
      };
    }

    const url = new URL(pageUrl);
    const relative = urlToPagePath(url);
    const final = this.ensureUniquePath(pageUrl, relative);

    return {
      relativePath: final,
      absolutePath: path.join(this.outputDir, final),
      isPage: true,
    };
  }

  resolveAsset(assetUrl: string, contentType?: string): ResolvedPath {
    const cached = this.assigned.get(assetUrl);
    if (cached) {
      return {
        relativePath: cached,
        absolutePath: path.join(this.outputDir, cached),
        isPage: false,
      };
    }

    const url = new URL(assetUrl);
    const relative = urlToAssetPath(url, contentType);
    const final = this.ensureUniquePath(assetUrl, relative);

    return {
      relativePath: final,
      absolutePath: path.join(this.outputDir, final),
      isPage: false,
    };
  }

  private ensureUniquePath(originalUrl: string, desiredPath: string): string {
    const existing = this.assigned.get(originalUrl);
    if (existing) return existing;

    const reverseMap = new Map<string, string>();
    for (const [url, p] of this.assigned.entries()) {
      reverseMap.set(p, url);
    }

    let candidate = desiredPath;
    let counter = 1;

    while (reverseMap.has(candidate) && reverseMap.get(candidate) !== originalUrl) {
      const ext = path.extname(desiredPath);
      const base = desiredPath.slice(0, desiredPath.length - ext.length);
      candidate = `${base}_${counter}${ext}`;
      counter++;
    }

    this.assigned.set(originalUrl, candidate);
    return candidate;
  }

  getAssigned(): Map<string, string> {
    return new Map(this.assigned);
  }
}
