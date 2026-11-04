import { describe, expect, it } from 'vitest';
import { Wallet, type Client, type Payment } from 'xrpl';
import { submitWithRetry, SubmitError } from '../src/chains/xrpl/submit.js';

// Fresh random wallets only — never anything derived from a real seed.
const wallet = Wallet.generate();
const tx: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: Wallet.generate().classicAddress, Amount: '1000' };

interface Script {
  /** Preliminary results, one per submit. */
  submits: string[];
  /** Per `tx` lookup: validated or not yet; missing entries mean txnNotFound. */
  lookups?: (boolean | 'missing')[];
  /** Validated ledger index per getLedgerIndex() call. */
  ledgers?: number[];
}

/** A stand-in for the parts of xrpl.Client the submit path uses, scripted per test. */
function fakeClient(script: Script) {
  let sequence = 10;
  const calls = { autofill: 0, submit: 0, lookups: 0, sequences: [] as number[] };
  const lookups = [...(script.lookups ?? [])];
  const ledgers = [...(script.ledgers ?? [])];
  const client = {
    async autofill(t: Payment) {
      calls.autofill += 1;
      const prepared = { ...t, Sequence: sequence++, Fee: '12', LastLedgerSequence: 100 };
      calls.sequences.push(prepared.Sequence);
      return prepared;
    },
    async request(req: { command: string; transaction?: string }) {
      if (req.command === 'submit') {
        const engine = script.submits[calls.submit++];
        return { result: { engine_result: engine, engine_result_message: `message for ${engine}` } };
      }
      if (req.command === 'tx') {
        calls.lookups += 1;
        const next = lookups.shift() ?? 'missing';
        if (next === 'missing') throw Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound' } });
        return { result: { hash: req.transaction, validated: next, meta: { TransactionResult: 'tesSUCCESS' } } };
      }
      throw new Error(`unexpected ${req.command}`);
    },
    async getLedgerIndex() {
      return ledgers.shift() ?? 99;
    },
  };
  return { client: client as unknown as Client, calls };
}

const fast = { pollMs: 0 };

describe('submitWithRetry', () => {
  it('returns the validated transaction', async () => {
    const { client, calls } = fakeClient({ submits: ['tesSUCCESS'], lookups: ['missing', true] });
    const response = await submitWithRetry(client, wallet, tx, fast);
    expect(response.result.validated).toBe(true);
    expect(calls.submit).toBe(1);
  });

  it('resubmits with a fresh sequence when another sender took it (tefPAST_SEQ)', async () => {
    const log: string[] = [];
    const { client, calls } = fakeClient({ submits: ['tefPAST_SEQ', 'tesSUCCESS'], lookups: [true] });
    await submitWithRetry(client, wallet, tx, { ...fast, log: (l) => log.push(l) });
    expect(calls.submit).toBe(2);
    expect(calls.autofill).toBe(2);
    expect(calls.sequences).toEqual([10, 11]);
    expect(log.join('\n')).toContain('sequence 10 was taken');
  });

  it('gives up after the last attempt and names the result', async () => {
    const { client, calls } = fakeClient({ submits: ['tefPAST_SEQ', 'tefPAST_SEQ', 'tefPAST_SEQ'] });
    const error = await submitWithRetry(client, wallet, tx, fast).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubmitError);
    expect((error as SubmitError).preliminary).toBe('tefPAST_SEQ');
    expect(calls.submit).toBe(3);
  });

  it('never resubmits terPRE_SEQ: rippled may still apply it, a second one could pay twice', async () => {
    const { client, calls } = fakeClient({ submits: ['terPRE_SEQ'], lookups: ['missing', true] });
    const response = await submitWithRetry(client, wallet, tx, fast);
    expect(response.result.validated).toBe(true);
    expect(calls.submit).toBe(1);
  });

  it.each(['temBAD_AMOUNT', 'tefMAX_LEDGER'])('fails at once on %s, without waiting', async (engine) => {
    const { client, calls } = fakeClient({ submits: [engine] });
    await expect(submitWithRetry(client, wallet, tx, fast)).rejects.toThrow(engine);
    expect(calls.submit).toBe(1);
    expect(calls.lookups).toBe(0);
  });

  it('fails once LastLedgerSequence has passed without validation', async () => {
    const { client } = fakeClient({ submits: ['tesSUCCESS'], lookups: ['missing', 'missing'], ledgers: [101] });
    await expect(submitWithRetry(client, wallet, tx, fast)).rejects.toThrow('was not validated by ledger 100');
  });

  it('still finds a transaction validated in exactly LastLedgerSequence', async () => {
    // First lookup misses, the ledger then reads past the bound, the final lookup finds it.
    const { client } = fakeClient({ submits: ['tesSUCCESS'], lookups: ['missing', true], ledgers: [101] });
    const response = await submitWithRetry(client, wallet, tx, fast);
    expect(response.result.validated).toBe(true);
  });
});
