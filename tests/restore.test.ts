import { Keypair } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import type { Ledger } from '../src/chains/chain.js';
import { isAccountOf } from '../src/chains/index.js';
import type { Driver, ShopConfig } from '../src/drivers/driver.js';
import { defaultShopAccount, shopAccountVariables } from '../src/runner/defaults.js';
import { runCases } from '../src/runner/run.js';
import { isolateEnv } from './env.js';

// Fresh random addresses only — never anything derived from a real seed.
const xrplAddress = () => Wallet.generate().classicAddress;
const stellarAddress = () => Keypair.random().publicKey();

isolateEnv([
  'LD_E2E_SHOPWARE_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_SHOP_ADDRESS',
  'LD_E2E_SHOPWARE_STELLAR_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_STELLAR_SHOP_ADDRESS',
  'LEDGERDIRECT_TESTNET_STELLAR_TREASURY_SEED',
]);

describe('the shop account per chain', () => {
  it('names the variables of the chain, without an infix for XRPL', () => {
    expect(shopAccountVariables('shopware')).toEqual(['LD_E2E_SHOPWARE_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_SHOP_ADDRESS']);
    expect(shopAccountVariables('shopware', 'stellar')).toEqual(['LD_E2E_SHOPWARE_STELLAR_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_STELLAR_SHOP_ADDRESS']);
  });

  it('never hands a Stellar run the XRPL account', () => {
    process.env.LD_E2E_SHOPWARE_SHOP_ACCOUNT = xrplAddress();
    expect(defaultShopAccount('shopware', 'STELLAR')).toBeUndefined();
    const own = stellarAddress();
    process.env.LEDGERDIRECT_TESTNET_SHOPWARE_STELLAR_SHOP_ADDRESS = own;
    expect(defaultShopAccount('shopware', 'STELLAR')).toBe(own);
  });

  it('tells the address forms of the chains apart', () => {
    const r = xrplAddress();
    const g = stellarAddress();
    expect(isAccountOf('XRPL', r)).toBe(true);
    expect(isAccountOf('XRPL', g)).toBe(false);
    expect(isAccountOf('STELLAR', g)).toBe(true);
    expect(isAccountOf('stellar', r)).toBe(false);
    expect(isAccountOf('XAHAU', r)).toBe(false);
  });
});

describe('putting the shop back after a run', () => {
  const runAccount = stellarAddress();
  let configured: ShopConfig[];
  let failOnRestore: boolean;
  let log: string[];

  const ledger = {
    chain: 'STELLAR',
    nativeAsset: 'XLM',
    assets: () => [{ code: 'XLM', native: true }],
    close: async () => {},
  } as unknown as Ledger;

  const driver = {
    name: 'shopware',
    async configure(config: ShopConfig) {
      configured.push(config);
      // As the Shopware driver can: the account is written, then a later request fails.
      if (failOnRestore && configured.length > 1) throw new Error('payment methods: 500');
    },
  } as unknown as Driver;

  const run = () => runCases({ driver, ledger, baseUrl: 'http://shop.invalid', caseIds: [], receivingAccount: runAccount, timeoutMs: 1000, version: 'test', log: (line) => log.push(line) });

  beforeEach(() => {
    configured = [];
    failOnRestore = false;
    log = [];
    process.env.LEDGERDIRECT_TESTNET_STELLAR_TREASURY_SEED = 'test-seed-placeholder';
  });

  it('restores the account of the chain', async () => {
    const own = stellarAddress();
    process.env.LD_E2E_SHOPWARE_STELLAR_SHOP_ACCOUNT = own;
    await run();
    expect(configured.map((c) => c.destinationAccount)).toEqual([runAccount, own]);
    expect(log.at(-1)).toContain(`restored to the shop's own: ${own}`);
  });

  it('writes no account of the wrong chain, and still returns the report', async () => {
    const wrong = xrplAddress();
    process.env.LD_E2E_SHOPWARE_STELLAR_SHOP_ACCOUNT = wrong;
    const report = await run();
    expect(report.receivingAccount).toBe(runAccount);
    expect(configured.map((c) => c.destinationAccount)).toEqual([runAccount]);
    expect(log.at(-1)).toContain(`${wrong} is not a STELLAR account`);
  });

  it('does not claim which account a half-done restore left behind', async () => {
    process.env.LD_E2E_SHOPWARE_STELLAR_SHOP_ACCOUNT = stellarAddress();
    failOnRestore = true;
    const report = await run();
    expect(report.receivingAccount).toBe(runAccount);
    const line = log.at(-1) ?? '';
    expect(line).toContain('failed: payment methods: 500');
    expect(line).toContain('may be on either account');
    expect(line).not.toContain('stays configured');
    expect(line).toContain('ld-e2e shop reset --target shopware --chain STELLAR');
  });
});
