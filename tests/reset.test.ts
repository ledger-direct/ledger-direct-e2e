import { afterEach, describe, expect, it } from 'vitest';
import type { Ledger, WithdrawnAsset } from '../src/chains/chain.js';
import { XrplLedger } from '../src/chains/xrpl/ledger.js';
import { daysSinceReset, judgeIssuers, RESET_WINDOW_LEDGERS, warn } from '../src/chains/xrpl/reset.js';
import type { Driver } from '../src/drivers/driver.js';
import { runCases } from '../src/runner/run.js';

const RLUSD = { code: 'RLUSD', issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' };
const USDC = { code: 'USDC', issuer: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt' };

/**
 * After a testnet reset the stablecoin issuers are gone until Ripple and Circle create them
 * again. Within seven days of ledgers a missing issuer withdraws its asset with a warning;
 * later it stays in, so the run fails and somebody checks for a new address.
 */
describe('a missing issuer after a testnet reset', () => {
  it('is withdrawn while the network is younger than the window, with the reason', () => {
    const { withdrawn, stillMissing } = judgeIssuers({ ledgerIndex: 22_326, missing: [RLUSD, USDC] });
    expect(withdrawn.map((a) => a.code)).toEqual(['RLUSD', 'USDC']);
    expect(stillMissing).toEqual([]);
    expect(withdrawn[0].reason).toMatch(/RLUSD withdrawn: its issuer rQhWct2f\w+ is not on the testnet, which started again about 0\.8 days ago \(ledger 22326\)/);
  });

  it('stays in from the window on: no reset explains it any more', () => {
    for (const ledgerIndex of [RESET_WINDOW_LEDGERS, RESET_WINDOW_LEDGERS + 1, 2_000_000]) {
      const { withdrawn, stillMissing } = judgeIssuers({ ledgerIndex, missing: [RLUSD] });
      expect(withdrawn, String(ledgerIndex)).toEqual([]);
      expect(stillMissing[0].reason).toMatch(/longer than a reset explains; has it come back under another address\?/);
    }
    expect(judgeIssuers({ ledgerIndex: RESET_WINDOW_LEDGERS - 1, missing: [RLUSD] }).withdrawn).toHaveLength(1);
  });

  it('withdraws nothing when every issuer is there, however young the network', () => {
    expect(judgeIssuers({ ledgerIndex: 10, missing: [] })).toEqual({ withdrawn: [], stillMissing: [] });
  });

  it('reads the window as about seven days of testnet ledgers', () => {
    expect(daysSinceReset(RESET_WINDOW_LEDGERS)).toBe(7);
    expect(daysSinceReset(26_667)).toBe(1);
  });
});

describe('the XRPL ledger', () => {
  /** A client that answers the ledger index and knows only the issuers in `existing`. */
  const ledgerWith = (ledgerIndex: number, existing: string[]): XrplLedger => {
    const client = {
      request: async (request: { command: string; account?: string }) => {
        if (request.command === 'ledger') return { result: { ledger_index: ledgerIndex } };
        if (existing.includes(request.account ?? '')) return { result: { account_data: {} } };
        throw Object.assign(new Error('Account not found.'), { data: { error: 'actNotFound' } });
      },
    };
    const ledger = new XrplLedger();
    Object.assign(ledger, { connect: async () => client });
    return ledger;
  };

  it('offers only the assets whose issuer is back, shortly after a reset', async () => {
    const ledger = ledgerWith(22_326, [USDC.issuer]);
    const withdrawn = await ledger.withdrawMissingIssuers();
    expect(withdrawn.map((a) => a.code)).toEqual(['RLUSD']);
    expect(ledger.assets().map((a) => a.code)).toEqual(['XRP', 'USDC']);
  });

  it('keeps every asset when the reset is older than the window: the run fails on the missing one', async () => {
    const ledger = ledgerWith(RESET_WINDOW_LEDGERS + 10, []);
    expect(await ledger.withdrawMissingIssuers()).toEqual([]);
    expect(ledger.assets().map((a) => a.code)).toEqual(['XRP', 'RLUSD', 'USDC']);
  });
});

describe('a run shortly after a reset', () => {
  const withdrawn: WithdrawnAsset[] = [
    { ...RLUSD, reason: 'RLUSD withdrawn: its issuer is not on the testnet' },
    { ...USDC, reason: 'USDC withdrawn: its issuer is not on the testnet' },
  ];
  let closed = 0;
  const ledger = {
    chain: 'XRPL',
    nativeAsset: 'XRP',
    assets: () => [{ code: 'XRP', native: true }],
    withdrawMissingIssuers: async () => withdrawn,
    createFresh: async () => { throw new Error('not for a skipped case'); },
    close: async () => { closed++; },
  } as unknown as Ledger;
  const driver = { name: 'shopware', configure: async () => { throw new Error('not for a skipped case'); } } as unknown as Driver;

  it('skips the cases that need the withdrawn assets, names the reset, and keeps it in the report', async () => {
    const lines: string[] = [];
    const report = await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-04'], timeoutMs: 1000, version: 'test', log: (line) => lines.push(line) });

    expect(report.results[0]).toMatchObject({ id: 'PS-04', outcome: 'skip' });
    expect(report.results[0].reason).toBe('needs 2 issued assets on XRPL, which has 0 (withdrawn after a testnet reset: RLUSD, USDC)');
    expect(report.withdrawn).toEqual(withdrawn);
    expect(lines).toContain('warning: RLUSD withdrawn: its issuer is not on the testnet');
    expect(closed).toBe(1);
  });
});

describe('the warning', () => {
  const original = process.env.GITHUB_ACTIONS;
  afterEach(() => {
    if (original === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = original;
  });

  it('is a log line, and in GitHub Actions also an annotation, so a green run still shows it', () => {
    const out: string[] = [];
    delete process.env.GITHUB_ACTIONS;
    warn('RLUSD withdrawn', (text) => out.push(text));
    expect(out).toEqual(['warning: RLUSD withdrawn\n']);

    out.length = 0;
    process.env.GITHUB_ACTIONS = 'true';
    warn('RLUSD withdrawn', (text) => out.push(text));
    expect(out).toEqual(['warning: RLUSD withdrawn\n', '::warning title=Testnet reset::RLUSD withdrawn\n']);
  });
});

describe('the reset check and the ledger connection', () => {
  const driver = { name: 'prestashop', configure: async () => { throw new Error('not for a skipped case'); } } as unknown as Driver;

  it('is not asked when no case is this platform\'s: those skips need no network', async () => {
    let asked = 0;
    const ledger = {
      chain: 'XRPL',
      nativeAsset: 'XRP',
      assets: () => [{ code: 'XRP', native: true }],
      withdrawMissingIssuers: async () => { asked++; throw new Error('the testnet does not answer'); },
      close: async () => {},
    } as unknown as Ledger;

    const report = await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-12'], timeoutMs: 1000, version: 'test', log: () => {} });
    expect(report.results[0]).toMatchObject({ id: 'PS-12', outcome: 'skip' });
    expect(asked).toBe(0);
  });

  it('closes the ledger when the check itself fails', async () => {
    let closed = 0;
    const ledger = {
      chain: 'XRPL',
      nativeAsset: 'XRP',
      assets: () => [{ code: 'XRP', native: true }],
      withdrawMissingIssuers: async () => { throw new Error('the testnet does not answer'); },
      close: async () => { closed++; },
    } as unknown as Ledger;

    await expect(runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-01'], timeoutMs: 1000, version: 'test', log: () => {} })).rejects.toThrow('the testnet does not answer');
    expect(closed).toBe(1);
  });
});
