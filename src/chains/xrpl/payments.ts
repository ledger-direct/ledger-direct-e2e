import { Client, Payment, PaymentFlags, xrpToDrops, dropsToXrp } from 'xrpl';
import { XRPL, type XrplProfile } from './profile.js';
import { submitWithRetry } from './submit.js';
import { walletFromSeed } from './wallets.js';

export interface PaymentRequest {
  seed: string;
  to: string;
  destinationTag?: number;
  amount: string; // decimal string as displayed by the shop — never recomputed here
  /** The chain's native asset or one of its issued ones, by code. */
  asset: string;
  /** Send `amount` as the upper bound and let the ledger deliver what a path allows (PS-03 tooling). */
  partial?: boolean;
  deliverMin?: string;
}

export interface PaymentResult {
  hash: string;
  result: string;
  validated: boolean;
  delivered: string | null;
  explorer: string;
  from: string;
}

/**
 * One payment, the way a customer's wallet would send it: the exact decimal
 * the shop displayed, the destination tag the page showed, in the quoted asset
 * (or deliberately in another one — that is how PS-04 is produced).
 */
export async function pay(client: Client, request: PaymentRequest, profile: XrplProfile = XRPL): Promise<PaymentResult> {
  const wallet = walletFromSeed(request.seed);
  const ledgerAmount = (value: string): string | { currency: string; issuer: string; value: string } => {
    if (request.asset === profile.nativeAsset) return xrpToDrops(value);
    const issued = profile.issued[request.asset];
    if (!issued) throw new Error(`${profile.chain}: unknown asset ${request.asset}`);
    return { ...issued, value };
  };
  const amount = ledgerAmount(request.amount);

  const tx: Payment = {
    TransactionType: 'Payment',
    Account: wallet.classicAddress,
    Destination: request.to,
    Amount: amount,
  };
  if (request.destinationTag !== undefined) tx.DestinationTag = request.destinationTag;
  if (request.partial) {
    tx.Flags = PaymentFlags.tfPartialPayment;
    if (request.deliverMin !== undefined) tx.DeliverMin = ledgerAmount(request.deliverMin);
  }

  const response = await submitWithRetry(client, wallet, tx);
  const meta = response.result.meta;
  const metaObject = typeof meta === 'object' && meta !== null ? (meta as { TransactionResult?: string; delivered_amount?: unknown }) : {};

  const result = String(metaObject.TransactionResult ?? 'unknown');

  return {
    hash: response.result.hash,
    result,
    // A tec* result is validated *and* failed (fee charged, nothing delivered); only tesSUCCESS counts.
    validated: Boolean(response.result.validated) && result === 'tesSUCCESS',
    delivered: describeDelivered(metaObject.delivered_amount, profile.nativeAsset),
    explorer: profile.explorerTx + response.result.hash,
    from: wallet.classicAddress,
  };
}

function describeDelivered(delivered: unknown, nativeAsset: string): string | null {
  if (delivered === undefined || delivered === null) return null;
  if (typeof delivered === 'string') return delivered === 'unavailable' ? 'unavailable' : `${dropsToXrp(delivered)} ${nativeAsset}`;
  if (typeof delivered === 'object' && 'value' in delivered) {
    const d = delivered as { value: string; currency: string };
    return `${d.value} ${d.currency}`;
  }
  return String(delivered);
}
