import { beforeEach, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import { findCase } from '../src/cases/catalogue.js';
import type { Ledger, SweepResult } from '../src/chains/chain.js';
import type { Driver, ShopConfig } from '../src/drivers/driver.js';
import { resolveCaseIds, runCases } from '../src/runner/run.js';
import { isolateEnv } from './env.js';

// Fresh random wallets only — never anything derived from a real seed.
const runWallet = Wallet.generate();
const treasuryAddress = Wallet.generate().classicAddress;
const shopOwn = Wallet.generate().classicAddress;

isolateEnv(['LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED', 'LD_E2E_SHOPWARE_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_SHOP_ADDRESS']);

describe('a run returns its throwaway account to the treasury', () => {
  let events: string[];
  let sweeps: { seed: string; to: string }[];
  let sweepFails: boolean;
  let configureFails: boolean;
  let log: string[];

  const ledger = (withSweep = true): Ledger => ({
    chain: 'XRPL',
    nativeAsset: 'XRP',
    assets: () => [{ code: 'XRP', native: true }],
    createFresh: async () => ({ address: runWallet.classicAddress, seed: runWallet.seed!, trustlines: {} }),
    addressOf: () => treasuryAddress,
    close: async () => void events.push('close'),
    ...(withSweep
      ? {
          sweep: async (seed: string, to: string): Promise<SweepResult> => {
            events.push('sweep');
            sweeps.push({ seed, to });
            if (sweepFails) throw new Error('tecPATH_DRY');
            return { native: '102.6', tokens: { RLUSD: '1.5' }, hashes: ['H'], failed: [] };
          },
        }
      : {}),
  }) as unknown as Ledger;

  const driver = {
    name: 'shopware',
    async configure(config: ShopConfig) {
      events.push(`configure ${config.destinationAccount === shopOwn ? 'own' : 'run'}`);
      if (configureFails) throw new Error('shop answered 500');
    },
  } as unknown as Driver;

  const run = (extra: { keepAccount?: boolean; receivingAccount?: string; withSweep?: boolean } = {}) =>
    runCases({ driver, ledger: ledger(extra.withSweep ?? true), baseUrl: 'http://shop.invalid', caseIds: [], timeoutMs: 1000, version: 'test', log: (l) => log.push(l), keepAccount: extra.keepAccount, receivingAccount: extra.receivingAccount });

  beforeEach(() => {
    events = [];
    sweeps = [];
    sweepFails = false;
    configureFails = false;
    log = [];
    process.env.LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED = 'test-seed-placeholder';
    process.env.LD_E2E_SHOPWARE_SHOP_ACCOUNT = shopOwn;
  });

  it('sweeps to the treasury after the shop is back on its own account, and reports it', async () => {
    const report = await run();
    expect(events).toEqual(['configure run', 'configure own', 'sweep', 'close']);
    expect(sweeps).toEqual([{ seed: runWallet.seed, to: treasuryAddress }]);
    expect(report.returned).toEqual({ native: '102.6', tokens: { RLUSD: '1.5' } });
    expect(log).toContain('returned to the treasury: 102.6 XRP, 1.5 RLUSD');
  });

  it('keeps the account when it stays configured in the shop (--keep-account)', async () => {
    await run({ keepAccount: true });
    expect(sweeps).toEqual([]);
  });

  it('has nothing to sweep with a given receiving account (no seed of its own)', async () => {
    await run({ receivingAccount: Wallet.generate().classicAddress });
    expect(sweeps).toEqual([]);
  });

  it('still returns the money when the run breaks off before its report', async () => {
    configureFails = true;
    await expect(run()).rejects.toThrow('shop answered 500');
    expect(events).toEqual(['configure run', 'sweep', 'close']);
  });

  it('keeps the report when the sweep fails, and says so', async () => {
    sweepFails = true;
    const report = await run();
    expect(report.returned).toBeUndefined();
    expect(log.join('\n')).toContain("returning the run account's funds to the treasury failed: tecPATH_DRY");
  });

  it('leaves the account on a chain without sweep', async () => {
    await expect(run({ withSweep: false })).resolves.toBeDefined();
    expect(sweeps).toEqual([]);
  });
});

describe('the testnet case set', () => {
  it('is every runner but the long waits: PS-04 in, PS-10 out', () => {
    const ids = resolveCaseIds('testnet');
    expect(ids).toContain('PS-04');
    expect(ids).not.toContain('PS-10');
    expect(ids.every((id) => !findCase(id)?.longWait)).toBe(true);
    expect(ids).toEqual(expect.arrayContaining(resolveCaseIds('automated')));
    expect(ids.length).toBe(resolveCaseIds('nightly').length - 1);
  });
});
