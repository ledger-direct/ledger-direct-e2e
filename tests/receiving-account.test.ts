import { beforeEach, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import type { Ledger, SweepResult } from '../src/chains/chain.js';
import type { AccountFinding, Driver, ShopConfig } from '../src/drivers/driver.js';
import { runCases } from '../src/runner/run.js';
import { isolateEnv } from './env.js';

// Fresh random wallets only — never anything derived from a real seed.
const runWallet = Wallet.generate();
const caseWallet = Wallet.generate();
const treasury = Wallet.generate().classicAddress;

isolateEnv(['LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED', 'LD_E2E_SHOPWARE_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_SHOP_ADDRESS']);

/**
 * PS-13…15 point the shop at an account of their own and put the run's account back. If
 * that fails, the shop may still point at the case's account: the run stops, and the case's
 * account is not swept from under it.
 */
describe('the receiving-account cases put the run account back, or stop the run', () => {
  let configured: string[];
  let sweeps: string[];
  let failRestore: boolean;
  let created: number;

  const ledger = {
    chain: 'XRPL',
    nativeAsset: 'XRP',
    assets: () => [{ code: 'XRP', native: true }, { code: 'RLUSD', native: false }],
    // The first account is the run's, every later one a case's.
    createFresh: async () => (created++ === 0
      ? { address: runWallet.classicAddress, seed: runWallet.seed!, trustlines: {} }
      : { address: caseWallet.classicAddress, seed: caseWallet.seed!, trustlines: {} }),
    unfundedAddress: () => Wallet.generate().classicAddress,
    addressOf: () => treasury,
    sweep: async (seed: string): Promise<SweepResult> => {
      sweeps.push(seed === caseWallet.seed ? 'case' : 'run');
      return { native: '99', tokens: {}, hashes: [], failed: [] };
    },
    close: async () => {},
  } as unknown as Ledger;

  const driver = {
    name: 'shopware',
    async configure(config: ShopConfig) {
      const which = config.destinationAccount === caseWallet.classicAddress ? 'case' : config.destinationAccount === runWallet.classicAddress ? 'run' : 'other';
      configured.push(which);
      if (failRestore && which === 'run' && configured.includes('case')) throw new Error('shop answered 500');
    },
    offeredAssets: async () => ['XRP'],
    accountFindings: async (): Promise<AccountFinding[]> => [{ code: 'trustline_missing', asset: 'RLUSD', blocksOffer: true }],
  } as unknown as Driver;

  const run = () => runCases({ driver, ledger, baseUrl: 'http://shop.invalid', caseIds: ['PS-13', 'PS-14', 'PS-15'], timeoutMs: 1000, version: 'test', log: () => {}, keepAccount: true });

  beforeEach(() => {
    configured = [];
    sweeps = [];
    failRestore = false;
    created = 0;
    process.env.LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED = 'test-seed-placeholder';
  });

  it('puts the run account back after the case and returns the case account', async () => {
    const report = await run();

    expect(report.results[0]).toMatchObject({ id: 'PS-13', outcome: 'pass' });
    expect(configured.slice(0, 3)).toEqual(['run', 'case', 'run']);
    expect(sweeps).toContain('case');
  });

  it('stops the run and leaves the case account alone when the run account cannot be put back', async () => {
    failRestore = true;
    const report = await run();

    expect(report.results.map((r) => [r.id, r.outcome])).toEqual([['PS-13', 'fail'], ['PS-14', 'skip'], ['PS-15', 'skip']]);
    expect(report.results[0].reason).toMatch(/could not be put back/);
    expect(report.results[1].reason).toMatch(/^not run: /);
    expect(sweeps).not.toContain('case');
  });
});
