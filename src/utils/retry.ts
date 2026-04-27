export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 1500,
  earlyAbortController?: AbortController,
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (earlyAbortController?.signal.aborted) throw err;
      if (attempt === retries) throw err;
      await new Promise((res) => setTimeout(res, delayMs * attempt));
    }
  }
  throw new Error("unreachable");
}
