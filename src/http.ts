/** Default time one HTTP request (headers and body) may take; `LD_E2E_HTTP_TIMEOUT_MS` overrides it. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export function httpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LD_E2E_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HTTP_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`LD_E2E_HTTP_TIMEOUT_MS must be a positive whole number of milliseconds, got "${raw}"`);
  return ms;
}

/**
 * `fetch` with a deadline. Without one, a request on a stale keep-alive
 * connection can hang for as long as the run lasts (seen in PS-12: 35 minutes
 * after `placeOrder()`, no request reached the shop). The signal also covers
 * reading the body. The error names method, host and path, never the query,
 * which carries order keys.
 */
export async function httpFetch(input: string | URL, init: RequestInit = {}, timeoutMs = httpTimeoutMs()): Promise<Response> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error(`${init.method ?? 'GET'} ${describe(input)} got no answer within ${timeoutMs} ms`);
    }
    throw error;
  }
}

function describe(input: string | URL): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unparsable URL)';
  }
}
