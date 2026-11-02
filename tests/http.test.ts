import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HTTP_TIMEOUT_MS, httpFetch, httpTimeoutMs } from '../src/http.js';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A shop that takes the request and never answers (the hang seen in PS-12). */
async function silentServer(): Promise<string> {
  server = createServer(() => {});
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('httpFetch', () => {
  it('gives up on a request that gets no answer, without the query in the error', async () => {
    const base = await silentServer();
    await expect(httpFetch(`${base}/store-api/checkout/order?deepLinkCode=secret-key`, { method: 'POST' }, 200))
      .rejects.toThrow(new RegExp(`^POST ${base}/store-api/checkout/order got no answer within 200 ms$`));
  });

  it('passes an answer through', async () => {
    server = createServer((_req, res) => res.end('{"state":"waiting"}'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const response = await httpFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {}, 1000);
    expect(await response.json()).toEqual({ state: 'waiting' });
  });
});

describe('httpTimeoutMs', () => {
  it('defaults to 30 s and reads LD_E2E_HTTP_TIMEOUT_MS', () => {
    expect(httpTimeoutMs({})).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(httpTimeoutMs({ LD_E2E_HTTP_TIMEOUT_MS: '5000' })).toBe(5000);
  });

  it('refuses a value that is not a positive whole number', () => {
    expect(() => httpTimeoutMs({ LD_E2E_HTTP_TIMEOUT_MS: 'soon' })).toThrow(/LD_E2E_HTTP_TIMEOUT_MS/);
    expect(() => httpTimeoutMs({ LD_E2E_HTTP_TIMEOUT_MS: '0' })).toThrow(/LD_E2E_HTTP_TIMEOUT_MS/);
  });
});
