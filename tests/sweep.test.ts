import { describe, expect, it } from 'vitest';
import { Wallet, type Client, type Payment, type TxResponse } from 'xrpl';
import { TESTNET_ISSUED } from '../src/chains/xrpl/assets.js';
import { FEE_MARGIN_DROPS, sweep } from '../src/chains/xrpl/sweep.js';

// Fresh random wallets only — never anything derived from a real seed.
const run = Wallet.generate();
const treasury = Wallet.generate().classicAddress;

interface Account {
  lines: { account: string; currency: string; balance: string }[];
  balanceDrops: string;
  ownerCount: number;
  /** Per currency: what the ledger reports as delivered (absent: no delivered_amount in the metadata). */
  delivered?: Record<string, string>;
  /** Per currency: what stays on the line after a successful return (default 0). */
  residual?: Record<string, string>;
  /** The second account_lines read fails. */
  rereadFails?: boolean;
}

function setup(account: Account, outcomes: string | string[] = 'tesSUCCESS') {
  const sent: Payment[] = [];
  const lines = account.lines.map((l) => ({ ...l }));
  let linesReads = 0;
  const client = {
    async request(req: { command: string }) {
      if (req.command === 'account_lines') {
        linesReads += 1;
        if (linesReads > 1 && account.rereadFails) throw new Error('timeout');
        return { result: { lines: lines.map((l) => ({ ...l })) } };
      }
      if (req.command === 'account_info') return { result: { account_data: { Balance: account.balanceDrops, OwnerCount: account.ownerCount } } };
      if (req.command === 'server_info') return { result: { info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2 } } } };
      throw new Error(`unexpected ${req.command}`);
    },
  } as unknown as Client;
  const submit = async (_c: Client, _w: Wallet, tx: Payment) => {
    sent.push(tx);
    const outcome = Array.isArray(outcomes) ? (outcomes[sent.length - 1] ?? 'tesSUCCESS') : outcomes;
    const meta: Record<string, unknown> = { TransactionResult: outcome };
    if (typeof tx.Amount === 'object' && outcome === 'tesSUCCESS') {
      const { currency, issuer } = tx.Amount as { currency: string; issuer: string };
      const line = lines.find((l) => l.currency === currency && l.account === issuer)!;
      line.balance = account.residual?.[currency] ?? '0';
      const value = account.delivered?.[currency];
      if (value !== undefined) meta.delivered_amount = { currency, issuer, value };
    }
    return { result: { hash: `H${sent.length}`, validated: true, meta } } as unknown as TxResponse;
  };
  return { client, sent, submit: submit as unknown as Parameters<typeof sweep>[3] };
}

const rlusd = TESTNET_ISSUED.RLUSD;
const usdc = TESTNET_ISSUED.USDC;

describe('sweep: a run account back to the treasury', () => {
  it('sends every stablecoin balance, then the XRP above the reserve', async () => {
    const { client, sent, submit } = setup({
      lines: [
        { account: rlusd.issuer, currency: rlusd.currency, balance: '1.5' },
        { account: usdc.issuer, currency: usdc.currency, balance: '0.9' },
      ],
      balanceDrops: '104000000',
      ownerCount: 2,
    });
    const result = await sweep(client, run.seed!, treasury, submit);

    expect(sent).toHaveLength(3);
    expect(sent.every((p) => p.Destination === treasury && p.Account === run.classicAddress)).toBe(true);
    // Whole balances as partial payments, so a transfer fee lowers what arrives instead of failing.
    expect(sent[0].Amount).toEqual({ ...rlusd, value: '1.5' });
    expect(sent[0].SendMax).toEqual({ ...rlusd, value: '1.5' });
    expect(sent[0].Flags).toBeTruthy();
    expect(sent[1].Amount).toEqual({ ...usdc, value: '0.9' });
    // 104 XRP − reserve (1 + 2 × 0.2) − fee margin.
    const expected = 104_000_000n - 1_400_000n - FEE_MARGIN_DROPS;
    expect(sent[2].Amount).toBe(expected.toString());
    expect(result).toEqual({ native: '102.599', tokens: { RLUSD: '1.5', USDC: '0.9' }, hashes: ['H1', 'H2', 'H3'], failed: [] });
  });

  it('skips empty lines and lines to other issuers', async () => {
    const { client, sent, submit } = setup({
      lines: [
        { account: rlusd.issuer, currency: rlusd.currency, balance: '0' },
        { account: Wallet.generate().classicAddress, currency: usdc.currency, balance: '5' },
        { account: Wallet.generate().classicAddress, currency: 'FOO', balance: '7' },
      ],
      balanceDrops: '50000000',
      ownerCount: 3,
    });
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(sent).toHaveLength(1);
    expect(typeof sent[0].Amount).toBe('string');
    expect(result.tokens).toEqual({});
  });

  it('sends no XRP when nothing is above the reserve and the margin', async () => {
    const { client, sent, submit } = setup({ lines: [], balanceDrops: (1_400_000n + FEE_MARGIN_DROPS).toString(), ownerCount: 2 });
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(sent).toHaveLength(0);
    expect(result.native).toBe('0');
  });

  it('records a failed token return and still returns the XRP', async () => {
    const { client, sent, submit } = setup({ lines: [{ account: rlusd.issuer, currency: rlusd.currency, balance: '2' }], balanceDrops: '101000000', ownerCount: 1 }, ['tecPATH_DRY', 'tesSUCCESS']);
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(sent).toHaveLength(2);
    expect(typeof sent[1].Amount).toBe('string');
    expect(result.tokens).toEqual({});
    expect(result.native).toBe('99.799');
    expect(result.failed).toEqual([expect.stringContaining('returning 2 RLUSD failed: tecPATH_DRY')]);
  });

  it('records a failed XRP return', async () => {
    const { client, submit } = setup({ lines: [], balanceDrops: '101000000', ownerCount: 0 }, ['tecNO_DST_INSUF_XRP']);
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(result.native).toBe('0');
    expect(result.failed).toEqual([expect.stringContaining('tecNO_DST_INSUF_XRP')]);
  });

  it('reports what arrived, and a transfer fee that leaves nothing behind is no residual', async () => {
    const { client, submit } = setup({
      lines: [{ account: rlusd.issuer, currency: rlusd.currency, balance: '1.5' }],
      balanceDrops: '101000000',
      ownerCount: 1,
      delivered: { [rlusd.currency]: '1.4925' },
    });
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(result.tokens).toEqual({ RLUSD: '1.4925' });
    expect(result.failed).toEqual([]);
  });

  it('records what a partial return left on the run account', async () => {
    const { client, submit } = setup({
      lines: [
        { account: rlusd.issuer, currency: rlusd.currency, balance: '1.5' },
        { account: usdc.issuer, currency: usdc.currency, balance: '0.9' },
      ],
      balanceDrops: '101000000',
      ownerCount: 2,
      delivered: { [rlusd.currency]: '1', [usdc.currency]: '0.9' },
      residual: { [rlusd.currency]: '0.5' },
    });
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(result.tokens).toEqual({ RLUSD: '1', USDC: '0.9' });
    expect(result.failed).toEqual(['0.5 RLUSD left on the run account: the treasury\'s line took less than the balance']);
    expect(result.native).not.toBe('0');
  });

  it('does not report a failed return twice', async () => {
    const { client, submit } = setup({ lines: [{ account: rlusd.issuer, currency: rlusd.currency, balance: '2' }], balanceDrops: '101000000', ownerCount: 1 }, ['tecPATH_DRY', 'tesSUCCESS']);
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(result.failed).toHaveLength(1);
  });

  it('says so when the lines cannot be read again, and still returns the XRP', async () => {
    const { client, sent, submit } = setup({ lines: [{ account: rlusd.issuer, currency: rlusd.currency, balance: '2' }], balanceDrops: '101000000', ownerCount: 1, rereadFails: true });
    const result = await sweep(client, run.seed!, treasury, submit);
    expect(result.failed).toEqual(['could not check the lines after the token returns: timeout']);
    expect(sent).toHaveLength(2);
    expect(result.native).toBe('99.799');
  });
});
