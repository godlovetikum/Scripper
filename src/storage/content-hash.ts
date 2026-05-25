import crypto from "crypto";

export function sha256(content: Buffer | string): string {
  return crypto
    .createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

export function shortHash(content: Buffer | string): string {
  return sha256(content).slice(0, 12);
}
