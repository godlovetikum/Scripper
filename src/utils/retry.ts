import { getLogger } from "./logger";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
  if (!jitter) return exponential;
  return exponential * (0.5 + Math.random() * 0.5);
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
    onRetry,
  } = options;

  const logger = getLogger();
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) break;

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);

      if (onRetry) {
        onRetry(attempt, lastError);
      } else {
        logger.warn(
          { label, attempt, maxAttempts, delayMs: Math.round(delay), err: lastError.message },
          "Retrying after error"
        );
      }

      await sleep(delay);
    }
  }

  throw new Error(
    `"${label}" failed after ${maxAttempts} attempts: ${lastError.message}`
  );
}
