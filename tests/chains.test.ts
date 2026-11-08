import { describe, expect, it } from 'vitest';
import { chainForAsset, orderChain } from '../src/drivers/chains.js';

const ASSETS = { XRPL: ['XRP', 'RLUSD', 'USDC'], STELLAR: ['XLM', 'USDC', 'EURC'], XAHAU: ['XAH'] };

describe('the chain an asset is ordered on', () => {
  it('is the configured chain when it has the asset', () => {
    expect(chainForAsset('STELLAR', 'USDC', ASSETS)).toBe('STELLAR');
    expect(chainForAsset('XRPL', 'USDC', ASSETS)).toBe('XRPL');
  });

  it('is the chain that has the asset when the configured one does not, as before configure()', () => {
    expect(chainForAsset('XRPL', 'XAH', ASSETS)).toBe('XAHAU');
    expect(chainForAsset('XAHAU', 'XRP', ASSETS)).toBe('XRPL');
  });

  it('refuses an asset no chain has', () => {
    expect(() => chainForAsset('XRPL', 'DOGE', ASSETS)).toThrow(/no payment method for DOGE/);
  });
});

describe('the chain one order is placed on', () => {
  it('is the requested chain when it has the asset', () => {
    expect(orderChain('XAHAU', 'XRPL', 'XAH', ASSETS)).toBe('XAHAU');
    expect(orderChain('stellar', 'XRPL', 'USDC', ASSETS)).toBe('STELLAR');
  });

  it('refuses a requested chain without the asset instead of guessing', () => {
    expect(() => orderChain('XRPL', 'XRPL', 'XAH', ASSETS)).toThrow(/no payment method for XAH on XRPL/);
  });

  it('falls back to the asset without a requested chain', () => {
    expect(orderChain(undefined, 'XRPL', 'XAH', ASSETS)).toBe('XAHAU');
    expect(orderChain(undefined, 'STELLAR', 'USDC', ASSETS)).toBe('STELLAR');
  });
});
