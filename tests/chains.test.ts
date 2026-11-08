import { describe, expect, it } from 'vitest';
import { chainForAsset } from '../src/drivers/chains.js';

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
