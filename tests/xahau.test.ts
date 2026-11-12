import { describe, expect, it } from 'vitest';
import { ECDSA, Wallet, type Client, type Payment } from 'xrpl';
import type { Ledger } from '../src/chains/chain.js';
import { CHAINS, isAccountOf, ledgerFor } from '../src/chains/index.js';
import { DEFAULT_MAX_PAYMENT_BY_ASSET, SpendGuard } from '../src/chains/spend.js';
import { parseXrplIncoming } from '../src/chains/xrpl/incoming.js';
import { XrplLedger } from '../src/chains/xrpl/ledger.js';
import { pay } from '../src/chains/xrpl/payments.js';
import { XAHAU, XRPL, assetFromCurrencyOn } from '../src/chains/xrpl/profile.js';
import { sweep } from '../src/chains/xrpl/sweep.js';
import { createFresh, walletFromSeed } from '../src/chains/xrpl/wallets.js';
import type { Driver } from '../src/drivers/driver.js';
import { runCases } from '../src/runner/run.js';

// Fresh random wallets only — never anything derived from a real seed.
const MERCHANT = 'r4ERx8577eKBSAT1pLefizNPYCYfhk1op2';

/**
 * Xahau is the XRP Ledger's code against another network. What is pinned here is
 * everything the profile has to carry so that the shared code does the right
 * thing on Xahau — and keeps doing what it did on the XRP Ledger.
 */
describe('Xahau behind the chain contract', () => {
  it('is a chain of its own, with XAH and nothing issued, on its own nodes', () => {
    expect(CHAINS).toContain('XAHAU');
    const ledger = ledgerFor('xahau');
    expect(ledger.chain).toBe('XAHAU');
    expect(ledger.nativeAsset).toBe('XAH');
    expect(ledger.assets()).toEqual([{ code: 'XAH', native: true }]);
    expect(ledger.explorerUrl('ABC')).toBe('https://explorer.xahau-test.net/tx/ABC');
    expect(XAHAU.ws).toBe('wss://xahau-test.net');
    expect(XAHAU.faucet).toBe('https://xahau-test.net/accounts');
  });

  it('leaves the XRP Ledger as it was', () => {
    const ledger = new XrplLedger();
    expect(ledger.chain).toBe('XRPL');
    expect(ledger.assets().map((a) => a.code)).toEqual(['XRP', 'RLUSD', 'USDC']);
    expect(assetFromCurrencyOn(XRPL, '524C555344000000000000000000000000000000')).toBe('RLUSD');
    expect(assetFromCurrencyOn(XAHAU, '524C555344000000000000000000000000000000')).toBeNull();
    expect(assetFromCurrencyOn(XAHAU, 'XRP')).toBe('XAH');
  });

  it('accepts an r-address for both chains: the form does not say which network', () => {
    expect(isAccountOf('XAHAU', MERCHANT)).toBe(true);
    expect(isAccountOf('XRPL', MERCHANT)).toBe(true);
    expect(isAccountOf('XAHAU', 'GCGEFYLIJXTISHBB3LENEJNGDBU7XHEI4F2PTLY4OSZ5Q5YF7ZWVNQIA')).toBe(false);
  });
});

describe('walletFromSeed', () => {
  it('reads the algorithm off the seed: sEd… is ed25519, every other s… is secp256k1 (the faucets hand those out)', () => {
    const ed = Wallet.generate(ECDSA.ed25519);
    const secp = Wallet.generate(ECDSA.secp256k1);
    expect(ed.seed!.startsWith('sEd')).toBe(true);
    expect(secp.seed!.startsWith('sEd')).toBe(false);
    expect(walletFromSeed(ed.seed!).classicAddress).toBe(ed.classicAddress);
    expect(walletFromSeed(secp.seed!).classicAddress).toBe(secp.classicAddress);
    // xrpl.js 4 derived another account from a secp256k1 seed without an explicit algorithm;
    // since 5.0 it reads the prefix too, and both agree.
    expect(Wallet.fromSeed(secp.seed!).classicAddress).toBe(secp.classicAddress);
    expect(new XrplLedger(XAHAU).addressOf(secp.seed!)).toBe(secp.classicAddress);
  });
});

describe('paying and sweeping on Xahau', () => {
  const payer = Wallet.generate(ECDSA.secp256k1);

  function clientRecording(sent: Payment[], balanceDrops = '1000000000'): Client {
    return {
      async request(req: { command: string }) {
        if (req.command === 'account_lines') return { result: { lines: [] } };
        if (req.command === 'account_info') return { result: { account_data: { Balance: balanceDrops, OwnerCount: 0 } } };
        if (req.command === 'server_info') return { result: { info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } };
        throw new Error(`unexpected ${req.command}`);
      },
    } as unknown as Client;
  }
  const submit = (sent: Payment[]) => async (_c: Client, _w: Wallet, tx: Payment) => {
    sent.push(tx);
    return { result: { hash: 'H' + sent.length, validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx.Amount } } } as never;
  };

  it('pays XAH in drops with the tag, from the secp256k1 wallet, and names the Xahau explorer', async () => {
    const sent: Payment[] = [];
    const result = await payVia(sent, { seed: payer.seed!, to: MERCHANT, destinationTag: 1050508800, amount: '1.5', asset: 'XAH' });
    expect(result.hash).toBe('H1');
    expect(sent[0]).toMatchObject({ TransactionType: 'Payment', Account: payer.classicAddress, Destination: MERCHANT, DestinationTag: 1050508800, Amount: '1500000' });
    expect(result.explorer).toBe('https://explorer.xahau-test.net/tx/H1');
    expect(result.delivered).toBe('1.5 XAH');
    expect(result.from).toBe(payer.classicAddress);
  });

  it('refuses an XRPL token on Xahau, where nothing is issued', async () => {
    await expect(payVia([], { seed: payer.seed!, to: MERCHANT, amount: '1', asset: 'RLUSD' })).rejects.toThrow('XAHAU: unknown asset RLUSD');
    await expect(ledgerFor('XAHAU').pay({ seed: payer.seed!, to: MERCHANT, amount: '1', asset: 'USDC' })).rejects.toThrow('XAHAU: unknown asset USDC');
  });

  it('sweeps the XAH above the reserve back to the treasury, with no token lines to look at', async () => {
    const sent: Payment[] = [];
    const result = await sweep(clientRecording(sent, '1000000000'), payer.seed!, MERCHANT, submit(sent), XAHAU);
    expect(sent).toHaveLength(1);
    // 1000 XAH minus the 1 XAH reserve minus the fee margin of 1000 drops.
    expect(sent[0]).toMatchObject({ Account: payer.classicAddress, Destination: MERCHANT, Amount: '998999000' });
    expect(result.native).toBe('998.999');
    expect(result.tokens).toEqual({});
    expect(result.failed).toEqual([]);
  });

  /** pay() signs through submitWithRetry, so the client stands in for the node: autofill records the request, submit and tx answer success. */
  async function payVia(sent: Payment[], request: { seed: string; to: string; destinationTag?: number; amount: string; asset: string }) {
    const node = {
      async autofill(tx: Payment) { sent.push(tx); return { ...tx, Sequence: 1, Fee: '10', LastLedgerSequence: 10 }; },
      async request(req: { command: string }) {
        if (req.command === 'submit') return { result: { engine_result: 'tesSUCCESS', engine_result_message: '' } };
        if (req.command === 'tx') return { result: { hash: 'H1', validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: sent[0]?.Amount } } };
        throw new Error(`unexpected ${req.command}`);
      },
      async getLedgerIndex() { return 1; },
    } as unknown as Client;
    return pay(node, request, XAHAU);
  }
});

describe('a fresh Xahau account', () => {
  it('is opened by the treasury with 20 XAH, not by the faucet', async () => {
    const treasury = Wallet.generate(ECDSA.secp256k1);
    const sent: Payment[] = [];
    const node = {
      async autofill(tx: Payment) { sent.push(tx); return { ...tx, Sequence: 1, Fee: '10', LastLedgerSequence: 10 }; },
      async request(req: { command: string }) {
        if (req.command === 'submit') return { result: { engine_result: 'tesSUCCESS', engine_result_message: '' } };
        if (req.command === 'tx') return { result: { hash: 'H1', validated: true, meta: { TransactionResult: 'tesSUCCESS' } } };
        if (req.command === 'account_info') return { result: {} };
        throw new Error(`unexpected ${req.command}`);
      },
      async getLedgerIndex() { return 1; },
    } as unknown as Client;

    const fresh = await createFresh(node, { funderSeed: treasury.seed! }, XAHAU);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ TransactionType: 'Payment', Account: treasury.classicAddress, Destination: fresh.wallet.classicAddress, Amount: '20000000' });
    expect(fresh.wallet.seed).toBeDefined();
    expect(fresh.trustlines).toEqual({});
    expect(XAHAU.freshAccounts).toBe('treasury');
    expect(XRPL.freshAccounts).toBe('faucet');
  });

  it('needs the treasury seed and says which variable', async () => {
    await expect(createFresh({} as unknown as Client, {}, XAHAU)).rejects.toThrow('LEDGERDIRECT_TESTNET_XAHAU_TREASURY_SEED');
  });
});

describe('what the spend guard and the runner make of Xahau', () => {
  it('caps a XAH payment at 5 000 by default, a few euros like 50 XRP, and still at 50 for everything else', () => {
    const guard = new SpendGuard(undefined);
    expect(DEFAULT_MAX_PAYMENT_BY_ASSET.XAH).toBe('5000');
    expect(() => guard.charge('XAH', '4999.5')).not.toThrow();
    expect(() => guard.charge('XAH', '5000.1')).toThrow(/above LD_E2E_MAX_PAYMENT \(5000\)/);
    expect(() => guard.charge('XRP', '50.5')).toThrow(/above LD_E2E_MAX_PAYMENT \(50\)/);
    expect(guard.summary().maxPayment).toBe('5000');
    expect(guard.describeCap()).toBe('50 (XAH: 5000)');
    expect(new SpendGuard('10').describeCap()).toBe('10');
    // A configured cap applies to every asset, as before.
    expect(() => new SpendGuard('10').charge('XAH', '11')).toThrow(/\(10\)/);
  });

  it('skips PS-04 on a chain with fewer than two issued assets, without touching the shop', async () => {
    const touched: string[] = [];
    const ledger = {
      chain: 'XAHAU',
      nativeAsset: 'XAH',
      assets: () => [{ code: 'XAH', native: true }],
      createFresh: async () => { touched.push('createFresh'); return { address: 'rFresh' }; },
      close: async () => {},
    } as unknown as Ledger;
    const driver = { name: 'shopware', configure: async () => { touched.push('configure'); } } as unknown as Driver;

    const report = await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-04'], timeoutMs: 1000, version: 'test', log: () => {} });

    expect(report.results[0]).toMatchObject({ id: 'PS-04', outcome: 'skip' });
    expect(report.results[0].reason).toBe('needs 2 issued assets on XAHAU, which has 0');
    expect(touched).toEqual([]);
  });
});
