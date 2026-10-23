import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ledger, PaymentRequest, PaymentResult } from '../src/chains/chain.js';
import { ledgerFor } from '../src/chains/index.js';
import { resetSpendGuard, SpendGuard, SpendLimitError, parseBudget } from '../src/chains/spend.js';
import type { Driver, PaymentPageView } from '../src/drivers/driver.js';
import { createServer } from '../src/mcp.js';
import { CaseContext } from '../src/runner/context.js';

// No testnet here: the XRPL ledger behind ledgerFor() is a stand-in that records what it was asked to sign.
const signed: PaymentRequest[] = [];
vi.mock('../src/chains/xrpl/ledger.js', () => ({
  XrplLedger: class implements Ledger {
    readonly chain = 'XRPL' as const;
    readonly nativeAsset = 'XRP';
    assets() { return [{ code: 'XRP', native: true }]; }
    async createFresh() { return { address: 'rFresh', seed: 'unused', trustlines: {} }; }
    async fund(address: string) { return { address, amount: '0' }; }
    async balances(address: string) { return { address, native: '0', tokens: {}, trustlines: [] }; }
    async pay(request: PaymentRequest): Promise<PaymentResult> {
      signed.push(request);
      return { hash: `H${signed.length}`, result: 'tesSUCCESS', validated: true, delivered: request.amount, explorer: 'https://example.invalid', from: 'rTreasury' };
    }
    explorerUrl(hash: string) { return hash; }
    addressOf() { return 'rTreasury'; }
    async close() {}
  },
}));

const VARS = ['LD_E2E_MAX_PAYMENT', 'LD_E2E_RUN_BUDGET', 'LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED'];

beforeEach(() => {
  signed.length = 0;
  resetSpendGuard();
});

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  resetSpendGuard();
});

describe('SpendGuard', () => {
  it('caps a single payment, in the asset\'s units', () => {
    const guard = new SpendGuard('5');
    guard.charge('XRP', '5');
    expect(() => guard.charge('XRP', '5.000001')).toThrow(SpendLimitError);
  });

  it('has no budget when none is set, as before', () => {
    const guard = new SpendGuard('50');
    for (let i = 0; i < 10; i++) guard.charge('RLUSD', '49');
    expect(guard.summary().spent).toEqual({ RLUSD: '490' });
  });

  it('refuses the payment that would cross the budget, and books nothing for it', () => {
    const guard = new SpendGuard('50', parseBudget('XRP=2'));
    guard.charge('XRP', '0.9');
    guard.charge('XRP', '0.9');
    expect(() => guard.charge('XRP', '0.9')).toThrow(/spent 1.8 of its 2 XRP/);
    guard.charge('XRP', '0.2');
    expect(guard.summary()).toEqual({ spent: { XRP: '2' }, maxPayment: '50', budget: { XRP: '2' } });
  });

  it('sums decimals exactly', () => {
    const guard = new SpendGuard('50', parseBudget('USDC=0.3'));
    guard.charge('USDC', '0.1');
    guard.charge('USDC', '0.2');
    expect(() => guard.charge('USDC', '0.000001')).toThrow(SpendLimitError);
  });

  it('gives an asset the budget does not name nothing to spend', () => {
    const guard = new SpendGuard('50', parseBudget('XRP=15, rlusd=5'));
    guard.charge('RLUSD', '1');
    expect(() => guard.charge('USDC', '0.01')).toThrow(/names no budget for USDC/);
  });

  it('rejects a budget it cannot read rather than running without one', () => {
    expect(() => parseBudget('XRP')).toThrow(SpendLimitError);
    expect(() => parseBudget('XRP=lots')).toThrow(SpendLimitError);
    expect(() => SpendGuard.fromEnv({ LD_E2E_MAX_PAYMENT: '-1' })).toThrow(SpendLimitError);
  });
});

describe('the budget holds on every way to pay', () => {
  const page: PaymentPageView = {
    state: 'waiting', amountDisplayed: '0.9', asset: 'XRP', destinationAccount: 'rShop', paymentIdentifier: '7',
  } as PaymentPageView;

  beforeEach(() => {
    process.env.LD_E2E_RUN_BUDGET = 'XRP=2';
    process.env.LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED = 'test-seed-placeholder';
  });

  it('ld-e2e pay: the ledger from ledgerFor()', async () => {
    const ledger = ledgerFor('XRPL');
    await ledger.pay({ seed: 'x', to: 'rShop', amount: '0.9', asset: 'XRP' });
    await ledger.pay({ seed: 'x', to: 'rShop', amount: '0.9', asset: 'XRP' });
    await expect(ledger.pay({ seed: 'x', to: 'rShop', amount: '0.9', asset: 'XRP' })).rejects.toThrow(SpendLimitError);
    expect(signed).toHaveLength(2);
  });

  it('the catalogue and the nightly: CaseContext.pay()', async () => {
    const ctx = new CaseContext({} as Driver, ledgerFor('XRPL'), 'x', 1000, () => {}, { destinationAccount: 'rShop', network: 'testnet', assets: ['XRP'], quoteExpirySeconds: 300 });
    await ctx.pay(page, '0.9');
    await ctx.pay(page, '0.9');
    await expect(ctx.pay(page, '0.9')).rejects.toThrow(/LD_E2E_RUN_BUDGET/);
    expect(signed).toHaveLength(2);
  });

  it('the MCP tool pay, budgeted per server start', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const pay = () => client.callTool({ name: 'pay', arguments: { chain: 'XRPL', to: 'rShop', amount: '0.9', identifier: '7' } });

    expect((await pay()).isError).toBeFalsy();
    expect((await pay()).isError).toBeFalsy();
    const third = await pay();
    expect(third.isError).toBe(true);
    expect(JSON.stringify(third.content)).toMatch(/LD_E2E_RUN_BUDGET/);
    expect(signed).toHaveLength(2);
    await client.close();
  });
});
