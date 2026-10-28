import { describe, expect, it } from 'vitest';
import type { Ledger } from '../src/chains/chain.js';
import type { Driver } from '../src/drivers/driver.js';
import { runCases } from '../src/runner/run.js';

/**
 * A platform-scoped case against another platform: recorded as skipped, and
 * the shop is left alone — no seed read, no receiving account created, no
 * configure(). With one applicable case in the selection the normal setup runs.
 */
describe("a selection that is not this platform's", () => {
  const touched: string[] = [];
  const ledger = {
    chain: 'XRPL',
    nativeAsset: 'XRP',
    assets: () => [{ code: 'XRP', native: true }],
    createFresh: async () => { touched.push('createFresh'); return { address: 'rFresh' }; },
    close: async () => {},
  } as unknown as Ledger;
  const driver = {
    name: 'prestashop',
    configure: async () => { touched.push('configure'); },
  } as unknown as Driver;

  it('records the case as skipped without touching the shop', async () => {
    const report = await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-12'], timeoutMs: 1000, version: 'test', log: () => {} });

    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ id: 'PS-12', outcome: 'skip', target: 'prestashop' });
    expect(report.results[0].reason).toMatch(/shopware only/);
    expect(touched).toEqual([]);
    expect(report.receivingAccount).toBe('');
  });
});
