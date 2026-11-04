import type { Client, SubmittableTransaction, TxResponse, Wallet } from 'xrpl';

/**
 * Signs, submits and waits for one transaction, the way `client.submitAndWait()` does,
 * with one difference: a sequence number another sender took first is retried at once.
 *
 * Every plugin repository's e2e run pays from the same CI treasury. Two runs that
 * autofill at the same moment get the same `Sequence`; the second submit then answers
 * `tefPAST_SEQ`. A tef result is final: that transaction can never be applied, so a
 * fresh autofill (the next free sequence, a new LastLedgerSequence) and a new signature
 * are safe. `submitAndWait()` instead waits for the transaction's LastLedgerSequence to
 * pass and only then throws, so the run lost a minute and the payment.
 *
 * Only `tefPAST_SEQ` is retried. `terPRE_SEQ` (a sequence ahead of the account) is held
 * by rippled and can still apply once the gap closes; resubmitting it could pay twice.
 * It is waited for, as every other non-tem, non-tef preliminary result.
 */
export const RETRYABLE_RESULT = 'tefPAST_SEQ';
const ATTEMPTS = 3;
const POLL_MS = 1000;

export class SubmitError extends Error {
  constructor(message: string, readonly preliminary?: string) {
    super(message);
    this.name = 'SubmitError';
  }
}

export interface SubmitOptions {
  /** Submissions at most, the first one included. */
  attempts?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export async function submitWithRetry(client: Client, wallet: Wallet, tx: SubmittableTransaction, options: SubmitOptions = {}): Promise<TxResponse> {
  const attempts = options.attempts ?? ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    // A copy per attempt: autofill writes Sequence, Fee and LastLedgerSequence into the object.
    const prepared = await client.autofill({ ...tx });
    const signed = wallet.sign(prepared);
    const submitted = await client.request({ command: 'submit', tx_blob: signed.tx_blob });
    const preliminary = submitted.result.engine_result;
    if (preliminary === RETRYABLE_RESULT && attempt < attempts) {
      options.log?.(`sequence ${prepared.Sequence} was taken (${preliminary}); resubmitting with a fresh one (attempt ${attempt + 1} of ${attempts})`);
      continue;
    }
    if (preliminary.startsWith('tem') || preliminary.startsWith('tef')) {
      throw new SubmitError(`Transaction failed, ${preliminary}: ${submitted.result.engine_result_message}`, preliminary);
    }
    if (prepared.LastLedgerSequence === undefined) throw new SubmitError('autofill set no LastLedgerSequence; refusing to wait without a bound', preliminary);
    return waitForValidation(client, signed.hash, prepared.LastLedgerSequence, preliminary, options.pollMs ?? POLL_MS);
  }
}

/**
 * Polls until the transaction is in a validated ledger, or its LastLedgerSequence has
 * passed. The last lookup comes after the ledger check, so a transaction validated in
 * exactly LastLedgerSequence is not reported as lost.
 */
async function waitForValidation(client: Client, hash: string, lastLedger: number, preliminary: string, pollMs: number): Promise<TxResponse> {
  for (;;) {
    await sleep(pollMs);
    const found = await lookup(client, hash);
    if (found?.result.validated) return found;
    if ((await client.getLedgerIndex()) > lastLedger) {
      const last = await lookup(client, hash);
      if (last?.result.validated) return last;
      throw new SubmitError(`${hash} was not validated by ledger ${lastLedger} (preliminary result ${preliminary})`, preliminary);
    }
  }
}

async function lookup(client: Client, hash: string): Promise<TxResponse | undefined> {
  try {
    return await client.request({ command: 'tx', transaction: hash });
  } catch (error) {
    const code = (error as { data?: { error?: string } }).data?.error;
    if (code === 'txnNotFound') return undefined;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
