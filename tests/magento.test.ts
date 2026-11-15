import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MagentoDriver, magentoSettings, shopDispatcher } from '../src/drivers/magento.js';
import { httpFetch } from '../src/http.js';

describe('Magento configuration per chain', () => {
  it('writes the XRP Ledger into the shared group and switches its three methods', () => {
    const { chain, settings } = magentoSettings({ chain: 'XRPL', destinationAccount: 'rMerchant', network: 'testnet', assets: ['XRP', 'USDC'], quoteExpirySeconds: 120 });
    expect(chain).toBe('XRPL');
    expect(settings).toEqual({
      'payment/ledger_direct/use_testnet': 1,
      'payment/ledger_direct/xrpl_testnet_account': 'rMerchant',
      'payment/ledger_direct/quote_expiry': 120,
      'payment/xrp_payment/active': 1,
      'payment/xrpl_rlusd_payment/active': 0,
      'payment/xrpl_usdc_payment/active': 1,
    });
  });

  it('writes Xahau into its own group and leaves the XRP Ledger methods alone', () => {
    const { chain, settings } = magentoSettings({ chain: 'XAHAU', destinationAccount: 'rXahau', network: 'testnet', assets: ['XAH'], quoteExpirySeconds: 300 });
    expect(chain).toBe('XAHAU');
    expect(settings).toEqual({
      'payment/ledger_direct_xahau/use_testnet': 1,
      'payment/ledger_direct_xahau/xahau_testnet_account': 'rXahau',
      'payment/ledger_direct/quote_expiry': 300,
      'payment/xahau_xah_payment/active': 1,
    });
  });

  it('refuses a chain the module has no methods for', () => {
    expect(() => magentoSettings({ chain: 'STELLAR', destinationAccount: 'G', network: 'testnet', assets: ['XLM'], quoteExpirySeconds: 300 })).toThrow(/no payment methods on STELLAR/);
  });
});

describe('Magento dev shop certificate', () => {
  it('accepts a self-signed certificate for an HTTPS shop on localhost, or when allowed, and nowhere else', () => {
    expect(shopDispatcher('https://localhost:8444')).toBeDefined();
    expect(shopDispatcher('https://127.0.0.1:8444')).toBeDefined();
    expect(shopDispatcher('https://shop.example', true)).toBeDefined();
    expect(shopDispatcher('https://localhost:8444', false)).toBeUndefined();
    expect(shopDispatcher('https://shop.example')).toBeUndefined();
    expect(shopDispatcher('http://localhost:8088')).toBeUndefined();
  });

  it('leaves certificate checks of the rest of the process on', () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      new MagentoDriver({ baseUrl: 'https://localhost:8444', composeDir: '.' });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
  });

  // A real HTTPS server with a throwaway self-signed certificate, made with openssl when it is installed.
  const openssl = (() => {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  describe.skipIf(!openssl)('against a server with a self-signed certificate', () => {
    let dir: string;
    let server: Server;
    let elsewhere: Server;
    let base: string;
    let other: string;

    // Two servers with the same self-signed certificate: the shop, and another origin it can redirect to.
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'ld-e2e-tls-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
      const tls = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
      elsewhere = createServer(tls, (_req, res) => res.end('elsewhere'));
      await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
      other = `https://localhost:${(elsewhere.address() as AddressInfo).port}`;
      server = createServer(tls, (req, res) => {
        if (req.url === '/away') res.writeHead(302, { Location: `${other}/` }).end();
        else res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `https://localhost:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => elsewhere.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    });

    it('reaches the shop over the driver', async () => {
      const driver = new MagentoDriver({ baseUrl: base, composeDir: '.' });
      const response = await driver.shopFetch(`${base}/`);
      expect(await response.text()).toBe('ok');
    });

    it('still refuses the certificate on any other request of the process', async () => {
      await expect(httpFetch(`${base}/`)).rejects.toThrow();
    });

    it('refuses it on another origin, asked directly or reached by a redirect from the shop', async () => {
      const driver = new MagentoDriver({ baseUrl: base, composeDir: '.' });
      await expect(driver.shopFetch(`${other}/`)).rejects.toThrow();
      await expect(driver.shopFetch(`${base}/away`)).rejects.toThrow();
      // The redirect itself is fine: with the other origin as the shop, the same request arrives.
      const reached = await new MagentoDriver({ baseUrl: other, composeDir: '.' }).shopFetch(`${other}/`);
      expect(await reached.text()).toBe('elsewhere');
    });
  });
});
