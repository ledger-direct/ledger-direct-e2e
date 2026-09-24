import { Client, Payment, PaymentFlags, Wallet, xrpToDrops, dropsToXrp } from 'xrpl';
import { Asset, TESTNET_EXPLORER_TX, TESTNET_ISSUED } from './assets.js';

export interface PaymentRequest {
  seed: string;
  to: string;
  destinationTag?: number;
  amount: string; // decimal string as displayed by the shop — never recomputed here
  asset: Asset;
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
export async function pay(client: Client, request: PaymentRequest): Promise<PaymentResult> {
  const wallet = Wallet.fromSeed(request.seed);
  const amount = request.asset === 'XRP'
    ? xrpToDrops(request.amount)
    : { ...TESTNET_ISSUED[request.asset], value: request.amount };

  const tx: Payment = {
    TransactionType: 'Payment',
    Account: wallet.classicAddress,
    Destination: request.to,
    Amount: amount,
  };
  if (request.destinationTag !== undefined) tx.DestinationTag = request.destinationTag;
  if (request.partial) {
    tx.Flags = PaymentFlags.tfPartialPayment;
    if (request.deliverMin !== undefined) {
      tx.DeliverMin = request.asset === 'XRP'
        ? xrpToDrops(request.deliverMin)
        : { ...TESTNET_ISSUED[request.asset], value: request.deliverMin };
    }
  }

  const prepared = await client.autofill(tx);
  const response = await client.submitAndWait(wallet.sign(prepared).tx_blob);
  const meta = response.result.meta;
  const metaObject = typeof meta === 'object' && meta !== null ? (meta as { TransactionResult?: string; delivered_amount?: unknown }) : {};

  return {
    hash: response.result.hash,
    result: String(metaObject.TransactionResult ?? 'unknown'),
    validated: Boolean(response.result.validated),
    delivered: describeDelivered(metaObject.delivered_amount),
    explorer: TESTNET_EXPLORER_TX + response.result.hash,
    from: wallet.classicAddress,
  };
}

function describeDelivered(delivered: unknown): string | null {
  if (delivered === undefined || delivered === null) return null;
  if (typeof delivered === 'string') return delivered === 'unavailable' ? 'unavailable' : `${dropsToXrp(delivered)} XRP`;
  if (typeof delivered === 'object' && 'value' in delivered) {
    const d = delivered as { value: string; currency: string };
    return `${d.value} ${d.currency}`;
  }
  return String(delivered);
}
