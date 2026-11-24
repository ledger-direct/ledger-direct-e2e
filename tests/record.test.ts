import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chromePath } from '../src/record/browser.js';
import { buildManifest, relative, type RecordFacts } from '../src/record/manifest.js';
import { defaultOutDir, orderedBy, parseAsset, parseColorScheme, parseSize, parseStart, recordChain, stamp } from '../src/record/options.js';
import { findWalkModule, walkPath } from '../src/record/walk.js';
import { HARNESS_VERSION } from '../src/version.js';

/**
 * What `ld-e2e record` decides without a browser: its arguments, where it writes, who places the
 * order, and what recording.json says. The film itself needs Chrome, ffmpeg and a shop.
 */
describe('record arguments', () => {
  it('reads a size as WIDTHxHEIGHT with even sides', () => {
    expect(parseSize('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseSize(' 1080x1080 ')).toEqual({ width: 1080, height: 1080 });
    expect(() => parseSize('1280*720')).toThrow(/WIDTHxHEIGHT/);
    expect(() => parseSize('1281x720')).toThrow(/odd side/);
    expect(() => parseSize('100x100')).toThrow(/320…3840/);
  });

  it('takes the four assets of the try shops and the three of Open Payments wallets, in any case', () => {
    expect(parseAsset('rlusd')).toBe('RLUSD');
    expect(parseAsset('XAH')).toBe('XAH');
    expect(parseAsset('eur')).toBe('EUR');
    expect(parseAsset('DSUSD')).toBe('DSUSD');
    expect(() => parseAsset('XLM')).toThrow(/XRP, RLUSD, USDC, XAH, EUR, USD, DSUSD/);
  });

  it('pays XAH on Xahau and everything else on the chain asked for', () => {
    expect(recordChain('XAH', 'XRPL')).toBe('XAHAU');
    expect(recordChain('RLUSD', 'XRPL')).toBe('XRPL');
  });

  it('pays over Interledger in an asset the plugins have an Interledger payment method for', () => {
    for (const asset of ['XRP', 'EUR', 'USD', 'DSUSD'] as const) expect(recordChain(asset, 'INTERLEDGER')).toBe('INTERLEDGER');
    expect(() => recordChain('RLUSD', 'INTERLEDGER')).toThrow(/RLUSD has no Interledger payment method; one of XRP, EUR, USD, DSUSD/);
    expect(() => recordChain('USDC', 'INTERLEDGER')).toThrow(/no Interledger payment method/);
  });

  it('refuses EUR, USD and DSUSD on a ledger: only an Open Payments wallet holds them', () => {
    for (const chain of ['XRPL', 'STELLAR'] as const) {
      for (const asset of ['EUR', 'USD', 'DSUSD'] as const) expect(() => recordChain(asset, chain)).toThrow(/paid over Interledger only/);
    }
  });

  it('names the colour scheme the pages see, light or dark', () => {
    expect(parseColorScheme('Light')).toBe('light');
    expect(parseColorScheme('dark')).toBe('dark');
    expect(() => parseColorScheme('system')).toThrow(/light, dark/);
  });

  it('starts on the payment page or in the shop', () => {
    expect(parseStart('Payment')).toBe('payment');
    expect(parseStart('shop')).toBe('shop');
    expect(() => parseStart('checkout')).toThrow(/payment, shop/);
  });
});

describe('record output folder', () => {
  const at = new Date('2026-11-18T09:05:03.123Z');

  it('stamps in UTC, sortable and without colons', () => {
    expect(stamp(at)).toBe('20261118-090503');
  });

  it('names target, asset, start, size, colour scheme and time', () => {
    expect(defaultOutDir('shopware', 'RLUSD', 'payment', { width: 1280, height: 720 }, at)).toBe('out/recordings/shopware-rlusd-payment-1280x720-light-20261118-090503');
    expect(defaultOutDir('magento', 'XRP', 'shop', { width: 1080, height: 1080 }, at, '/tmp/rec', 'dark')).toBe('/tmp/rec/magento-xrp-shop-1080x1080-dark-20261118-090503');
  });
});

describe('who places the order', () => {
  it('the browser for the whole purchase', () => {
    expect(orderedBy('shop', '/x/browser/walk.mjs')).toBe('browser');
  });

  it('the browser off camera when the plugin has a walk, so the confirmation belongs to the session that ordered', () => {
    expect(orderedBy('payment', '/x/browser/walk.mjs')).toBe('browser');
  });

  it('the driver, as in the catalogue, when there is no walk', () => {
    expect(orderedBy('payment', undefined)).toBe('driver');
  });
});

describe('the walk module', () => {
  it('lives in browser/walk.mjs of the compose folder', () => {
    expect(walkPath('/repo/dev/try')).toBe('/repo/dev/try/browser/walk.mjs');
  });

  it('is found in the folder given', async () => {
    await expect(findWalkModule('shopware', { composeDir: '/repo/dev/try' }, (p) => p === '/repo/dev/try/browser/walk.mjs')).resolves.toBe('/repo/dev/try/browser/walk.mjs');
  });

  it('names the path it looked for when the plugin has none yet', async () => {
    await expect(findWalkModule('magento', { composeDir: '/repo/dev/try' }, () => false)).rejects.toThrow(/magento has no browser walk yet \(looked for \/repo\/dev\/try\/browser\/walk\.mjs\)/);
  });

  it('asks for --compose-dir without a folder or container', async () => {
    await expect(findWalkModule('prestashop', {}, () => true)).rejects.toThrow(/--compose-dir/);
  });
});

describe('Chrome', () => {
  it('is CHROME when set, and that must exist', () => {
    expect(chromePath({ CHROME: '/opt/chrome' }, (p) => p === '/opt/chrome')).toBe('/opt/chrome');
    expect(() => chromePath({ CHROME: '/opt/none' }, () => false)).toThrow(/CHROME=\/opt\/none does not exist/);
  });

  it('says how to set it when none is found', () => {
    expect(() => chromePath({}, () => false)).toThrow(/set CHROME/);
  });
});

describe('recording.json', () => {
  const t0 = Date.parse('2026-11-18T10:00:00.000Z');
  const facts: RecordFacts = {
    target: 'shopware',
    baseUrl: 'http://localhost:8091',
    try: true,
    chain: 'XRPL',
    pluginVersion: '1.11.0',
    harnessVersion: '0.2.0',
    asset: 'RLUSD',
    start: 'payment',
    orderedBy: 'browser',
    colorScheme: 'light',
    size: { width: 1280, height: 720 },
    startedAt: new Date(t0 - 20_000),
    payment: {
      amount: '2.19',
      asset: 'RLUSD',
      destinationAccount: 'rnRuA7RNi6CsFbkh5FDDiTSSvJwHG8J7if',
      destinationTag: '4036930003',
      hash: 'A'.repeat(64),
      result: 'tesSUCCESS',
      ledgerIndex: 22422810,
      explorer: `https://testnet.xrpl.org/transactions/${'A'.repeat(64)}`,
    },
    moments: {
      videoStart: t0,
      paymentPageReached: t0,
      paymentSent: t0 + 3_049,
      transactionValidated: t0 + 10_160,
      pageShowsSettled: t0 + 18_300,
      redirect: t0 + 23_840,
      end: t0 + 27_900,
    },
    error: null,
  };

  it('puts every moment in seconds from the first frame', () => {
    expect(buildManifest(facts).timeline).toEqual({
      paymentPageReached: 0,
      paymentSent: 3,
      transactionValidated: 10.2,
      pageShowsSettled: 18.3,
      redirect: 23.8,
      end: 27.9,
    });
  });

  it('leaves a moment the recording never reached null', () => {
    const stopped = buildManifest({ ...facts, moments: { videoStart: t0, paymentPageReached: t0 }, error: 'timed out' });
    expect(stopped.timeline).toMatchObject({ paymentPageReached: 0, paymentSent: null, redirect: null });
    expect(stopped.error).toBe('timed out');
    expect(relative(null, t0)).toBeNull();
  });

  it('carries the evidence for the post: hash, ledger, explorer, receiving account and tag', () => {
    const manifest = buildManifest(facts);
    expect(manifest.payment).toMatchObject({ transactionHash: 'A'.repeat(64), ledgerIndex: 22422810, destinationTag: '4036930003', amount: '2.19', asset: 'RLUSD' });
    expect(manifest.shop).toEqual({ target: 'shopware', baseUrl: 'http://localhost:8091', try: true, pluginVersion: '1.11.0' });
    expect(manifest.video).toEqual({ file: 'recording.mp4', width: 1280, height: 720, fps: 25, codec: 'h264', pixelFormat: 'yuv420p' });
    expect(manifest.orderedBy).toBe('browser');
    expect(manifest.colorScheme).toBe('light');
  });

  it('holds no secret: no seed, no page URL with the order key', () => {
    const json = JSON.stringify(buildManifest(facts));
    expect(json).not.toMatch(/seed|secret|deepLinkCode|returnUrl|password/i);
  });
});

describe('version', () => {
  it('is the same in package.json and the code', () => {
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBe(HARNESS_VERSION);
  });
});
