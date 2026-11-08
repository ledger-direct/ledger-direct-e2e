import { describe, expect, it } from 'vitest';
import { throttleKeys } from '../src/drivers/throttle.js';

describe('throttle keys', () => {
  it('names the core 0.11 key first and the old XRPL key after it', () => {
    const keys = throttleKeys('XRPL', 'testnet', 'rMerchant');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^ledger-direct\.sync\.v2\.xrpl\.testnet\.[0-9a-f]{16}$/);
    expect(keys[1]).toBe('ledger-direct.sync.v1.testnet.rMerchant');
    expect(keys[0].length).toBeLessThanOrEqual(64);
  });

  it('has no old key on Xahau, which the old core never knew', () => {
    expect(throttleKeys('XAHAU', 'testnet', 'rMerchant')).toEqual([`ledger-direct.sync.v2.xahau.testnet.${throttleKeys('XRPL', 'testnet', 'rMerchant')[0].slice(-16)}`]);
  });
});
