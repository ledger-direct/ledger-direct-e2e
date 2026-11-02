/** Default time one HTTP request (headers and body) may take; `LD_E2E_HTTP_TIMEOUT_MS` overrides it. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export function httpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LD_E2E_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_HTTP_TIMEOUT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`LD_E2E_HTTP_TIMEOUT_MS must be a positive whole number of milliseconds, got "${raw}"`);
  return ms;
}

const BODY_READERS = ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes'] as const;

/**
 * `fetch` with a deadline. Without one, a request on a stale keep-alive
 * connection can hang for as long as the run lasts (seen in PS-12: 35 minutes
 * after `placeOrder()`, no request reached the shop). The deadline covers
 * reading the body too, and a timeout there gets the same message. The message
 * names method, host and a masked path: no query, and no segment that looks
 * like an identifier — WooCommerce carries the order key in the path, and the
 * message ends up in the report.
 */
export async function httpFetch(input: string | URL, init: RequestInit = {}, timeoutMs = httpTimeoutMs()): Promise<Response> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const translate = (error: unknown): unknown =>
    isTimeout(error) ? new Error(`${init.method ?? 'GET'} ${describeUrl(input)} got no answer within ${timeoutMs} ms`) : error;
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal });
  } catch (error) {
    throw translate(error);
  }
  for (const name of BODY_READERS) {
    const read = response[name]?.bind(response) as (() => Promise<unknown>) | undefined;
    if (!read) continue;
    Object.defineProperty(response, name, {
      value: () => read().catch((error: unknown) => { throw translate(error); }),
    });
  }
  return response;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/** Origin and path, with the query dropped and every segment of eight or more characters that contains a digit masked. */
export function describeUrl(input: string | URL): string {
  try {
    const url = new URL(input);
    const path = url.pathname
      .split('/')
      .map((segment) => (segment.length >= 8 && /\d/.test(segment) ? '…' : segment))
      .join('/');
    return `${url.origin}${path}`;
  } catch {
    return '(unparsable URL)';
  }
}
