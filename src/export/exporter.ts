import fs from "fs";
import path from "path";
import archiver from "archiver";
import { getLogger } from "../utils/logger";

export interface ExportResult {
  zipPath: string;
  sizeBytes: number;
}

/**
 * Packages the crawl output directory into a ZIP archive suitable for
 * static hosting deployment.
 */
export async function exportToZip(
  outputDir: string,
  zipPath?: string
): Promise<ExportResult> {
  const logger = getLogger();
  const resolvedZipPath = zipPath ?? path.join(path.dirname(outputDir), "crawl-output.zip");

  logger.info({ outputDir, zipPath: resolvedZipPath }, "Creating ZIP export");

  if (!fs.existsSync(outputDir)) {
    throw new Error(`Output directory does not exist: ${outputDir}`);
  }

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(resolvedZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      const sizeBytes = archive.pointer();
      const mb = (sizeBytes / 1024 / 1024).toFixed(2);
      logger.info({ zipPath: resolvedZipPath, sizeBytes, sizeMb: mb }, "ZIP export complete");
      resolve({ zipPath: resolvedZipPath, sizeBytes });
    });

    output.on("error", (err) => {
      logger.error({ err: err.message }, "ZIP output stream error");
      reject(err);
    });

    archive.on("error", (err) => {
      logger.error({ err: err.message }, "Archiver error");
      reject(err);
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        logger.warn({ err: err.message }, "Archiver warning: missing file");
      } else {
        reject(err);
      }
    });

    archive.pipe(output);

    archive.directory(outputDir, false);

    archive.finalize();
  });
}

/**
 * Generate a minimal static index.html redirect at the output root
 * to ensure the bundle is directly hostable.
 */
export function generateRootRedirect(outputDir: string): void {
  const pagesDir = path.join(outputDir, "pages");
  const rootIndex = path.join(outputDir, "index.html");

  if (fs.existsSync(rootIndex)) return;

  const pagesIndex = path.join(pagesDir, "index.html");
  const redirectTarget = fs.existsSync(pagesIndex) ? "./pages/index.html" : "./pages/";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=${redirectTarget}" />
  <title>Redirecting...</title>
</head>
<body>
  <p>Redirecting to <a href="${redirectTarget}">${redirectTarget}</a>…</p>
  <script>window.location.replace("${redirectTarget}");</script>
</body>
</html>
`;

  fs.writeFileSync(rootIndex, html, "utf8");
  getLogger().debug({ rootIndex, redirectTarget }, "Root redirect index.html written");
}
