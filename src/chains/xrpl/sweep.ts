import { Client, Payment, PaymentFlags, Wallet, dropsToXrp } from 'xrpl';
import type { SweepResult } from '../chain.js';
import { TESTNET_ISSUED, assetFromCurrency } from './assets.js';
import { submitWithRetry } from './submit.js';

/** Left on the account for the fees of the sweep's own transactions, in drops. */
export const FEE_MARGIN_DROPS = 1000n;

type Submit = typeof submitWithRetry;

/**
 * Sends what a run's throwaway receiving account holds back to the treasury.
 *
 * Every run opens a fresh account at the faucet (100 XRP) and the shop is paid into
 * it; afterwards its seed is gone. Without this the treasury only ever pays out,
 * while each run leaves about 104 XRP and the paid stablecoins behind.
 *
 * - Issued assets first, the whole balance of every line to a known testnet issuer,
 *   as a partial payment with SendMax = balance: an issuer's transfer fee then lowers
 *   what arrives instead of failing the payment.
 * - Then XRP: everything above the account's reserve (base plus one increment per
 *   owned object, read from the ledger) minus a small fee margin.
 *
 * A return that fails (a dry path for one token, say) is recorded in `failed` and the
 * others still go out: above all the XRP, which is most of what the account holds.
 *
 * What a token return reports is what arrived (`delivered_amount`), not the balance sent.
 * Afterwards the lines are read again: whatever is still on a line that was returned did
 * not go out (the treasury's line had less room than the balance, say) and is recorded in
 * `failed`, because the account's seed is gone after the run. A transfer fee lowers what
 * arrives but leaves nothing behind, so it is no residual.
 *
 * The account itself stays, with its trust lines and its reserve (about 1.4 XRP):
 * deleting it needs 256 ledgers after its creation, longer than a run.
 */
export async function sweep(client: Client, seed: string, to: string, submit: Submit = submitWithRetry): Promise<SweepResult> {
  const wallet = Wallet.fromSeed(seed);
  const from = wallet.classicAddress;
  const result: SweepResult = { native: '0', tokens: {}, hashes: [], failed: [] };

  const lines = await client.request({ command: 'account_lines', account: from, ledger_index: 'validated' });
  const returned: AssetKey[] = [];
  for (const line of lines.result.lines) {
    const asset = assetFromCurrency(line.currency);
    if (asset === null || asset === 'XRP') continue;
    const issued = TESTNET_ISSUED[asset];
    if (issued.issuer !== line.account || !(Number(line.balance) > 0)) continue;
    const amount = { currency: issued.currency, issuer: issued.issuer, value: line.balance };
    const tx: Payment = { TransactionType: 'Payment', Account: from, Destination: to, Amount: amount, SendMax: amount, Flags: PaymentFlags.tfPartialPayment };
    try {
      const response = await submit(client, wallet, tx);
      requireSuccess(response, `${line.balance} ${asset}`);
      result.tokens[asset] = deliveredValue(response) ?? line.balance;
      result.hashes.push(response.result.hash);
      returned.push({ asset, currency: line.currency, issuer: line.account });
    } catch (error) {
      result.failed.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (returned.length > 0) {
    try {
      const after = await client.request({ command: 'account_lines', account: from, ledger_index: 'validated' });
      for (const { asset, currency, issuer } of returned) {
        const left = after.result.lines.find((l) => l.currency === currency && l.account === issuer)?.balance;
        if (left !== undefined && Number(left) > 0) result.failed.push(`${left} ${asset} left on the run account: the treasury's line took less than the balance`);
      }
    } catch (error) {
      result.failed.push(`could not check the lines after the token returns: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const [info, server] = await Promise.all([
    client.request({ command: 'account_info', account: from, ledger_index: 'validated' }),
    client.request({ command: 'server_info' }),
  ]);
  const validated = server.result.info.validated_ledger;
  if (!validated) throw new Error('server_info carries no validated ledger; reserves unknown, XRP left on the account');
  const reserve = xrpToDropsBig(validated.reserve_base_xrp) + xrpToDropsBig(validated.reserve_inc_xrp) * BigInt(info.result.account_data.OwnerCount);
  const spendable = BigInt(info.result.account_data.Balance) - reserve - FEE_MARGIN_DROPS;
  if (spendable > 0n) {
    const tx: Payment = { TransactionType: 'Payment', Account: from, Destination: to, Amount: spendable.toString() };
    try {
      const response = await submit(client, wallet, tx);
      requireSuccess(response, `${dropsToXrp(spendable.toString())} XRP`);
      result.native = String(dropsToXrp(spendable.toString()));
      result.hashes.push(response.result.hash);
    } catch (error) {
      result.failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

interface AssetKey {
  asset: string;
  currency: string;
  issuer: string;
}

/** The value that arrived, from the validated metadata; undefined when the ledger does not say. */
function deliveredValue(response: Awaited<ReturnType<Submit>>): string | undefined {
  const meta = response.result.meta;
  const delivered = typeof meta === 'object' && meta !== null && 'delivered_amount' in meta ? meta.delivered_amount : undefined;
  return typeof delivered === 'object' && delivered !== null && 'value' in delivered ? String(delivered.value) : undefined;
}

function requireSuccess(response: Awaited<ReturnType<Submit>>, what: string): void {
  const meta = response.result.meta;
  const code = typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown';
  if (code !== 'tesSUCCESS') throw new Error(`returning ${what} failed: ${code} (${response.result.hash})`);
}

/** server_info gives reserves in XRP as numbers (e.g. 0.2); converted exactly, never through floats. */
function xrpToDropsBig(xrp: number): bigint {
  const [whole, fraction = ''] = String(xrp).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}
