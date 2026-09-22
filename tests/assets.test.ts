import { describe, expect, it } from 'vitest';
import { ASSETS, TESTNET_ISSUED, assetFromCurrency, isAsset } from '../src/assets.js';
import { redact } from '../src/config.js';
import { CASES, findCase } from '../src/cases/catalogue.js';

describe('assets', () => {
  it('encodes the token codes the way the ledger does', () => {
    expect(TESTNET_ISSUED.RLUSD.currency).toBe(Buffer.from('RLUSD').toString('hex').toUpperCase().padEnd(40, '0'));
    expect(TESTNET_ISSUED.USDC.currency).toBe(Buffer.from('USDC').toString('hex').toUpperCase().padEnd(40, '0'));
  });

  it('maps a currency code back to the asset name', () => {
    expect(assetFromCurrency(TESTNET_ISSUED.RLUSD.currency)).toBe('RLUSD');
    expect(assetFromCurrency('XRP')).toBe('XRP');
    expect(assetFromCurrency('5553440000000000000000000000000000000000')).toBeNull();
  });

  it('knows exactly the three assets', () => {
    expect(ASSETS).toEqual(['XRP', 'RLUSD', 'USDC']);
    expect(isAsset('BTC')).toBe(false);
  });
});

describe('redact', () => {
  it('removes anything that looks like a family seed', () => {
    expect(redact('seed sEdTestSeedNotRealSeedNotRealAAA leaked')).toBe('seed [seed redacted] leaked');
    expect(redact('address rGT9kXUuutRVGrUyRciupE8VbRWqL4fUPo stays')).toContain('rGT9kXUuutRVGrUyRciupE8VbRWqL4fUPo');
  });
});

describe('catalogue', () => {
  it('carries the eleven case IDs of the core catalogue', () => {
    expect(CASES.map((c) => c.id)).toEqual(Array.from({ length: 11 }, (_, i) => `PS-${String(i + 1).padStart(2, '0')}`));
  });

  it('marks the wrong-asset case as testnet-only', () => {
    expect(findCase('ps-04')?.nightlyOnly).toBe(true);
    expect(findCase('PS-05')?.nightlyOnly).toBeUndefined();
  });
});
