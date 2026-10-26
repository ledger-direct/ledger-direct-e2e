import { dropsToXrp, rippleTimeToISOTime } from 'xrpl';
import type { IncomingPayment } from '../chain.js';
import { assetFromCurrency } from './assets.js';

/**
 * Incoming payments from an `account_tx` answer (API v2 `tx_json`, v1 `tx`), newest first as
 * the node returned them. Pure, so the shapes are tested without a node.
 *
 * The amount is `delivered_amount` from the metadata — what arrived, which is what a partial
 * payment or an exchange fee changes. A failed payment counts with nothing delivered.
 */
export function parseXrplIncoming(entries: unknown[], address: string, explorerBase: string): IncomingPayment[] {
  const out: IncomingPayment[] = [];
  for (const raw of entries) {
    const e = raw as { hash?: string; validated?: boolean; close_time_iso?: string; meta?: unknown; tx_json?: Record<string, unknown>; tx?: Record<string, unknown> };
    const tx = e.tx_json ?? e.tx;
    if (!tx || tx.TransactionType !== 'Payment' || tx.Destination !== address) continue;
    const meta = (typeof e.meta === 'object' && e.meta !== null ? e.meta : {}) as { TransactionResult?: string; delivered_amount?: unknown; DeliveredAmount?: unknown };
    const result = String(meta.TransactionResult ?? 'unknown');
    const success = result === 'tesSUCCESS';
    const delivered = success ? meta.delivered_amount ?? meta.DeliveredAmount : undefined;
    const sent = tx.DeliverMax ?? tx.Amount;
    const { asset, issuer, amount } = amountOf(delivered !== undefined && delivered !== 'unavailable' ? delivered : sent);
    const hash = String(e.hash ?? tx.hash ?? '');
    const date = typeof tx.date === 'number' ? rippleTimeToISOTime(tx.date) : undefined;
    out.push({
      hash,
      asset,
      ...(issuer ? { issuer } : {}),
      amount: success ? amount : '0',
      ...(tx.DestinationTag !== undefined ? { identifier: String(tx.DestinationTag), identifierKind: 'tag' as const } : {}),
      from: String(tx.Account ?? ''),
      result,
      validated: e.validated === true && success,
      ...((e.close_time_iso ?? date) ? { at: e.close_time_iso ?? date } : {}),
      explorer: explorerBase + hash,
    });
  }
  return out;
}

function amountOf(value: unknown): { asset: string; issuer?: string; amount: string } {
  if (typeof value === 'string') return { asset: 'XRP', amount: String(dropsToXrp(value)) };
  if (typeof value === 'object' && value !== null && 'currency' in value) {
    const v = value as { currency: string; issuer?: string; value: string; mpt_issuance_id?: string };
    return { asset: assetFromCurrency(v.currency) ?? decodeCurrency(v.currency), issuer: v.issuer, amount: v.value };
  }
  return { asset: '?', amount: '0' };
}

/** A 40-hex currency code as text (`5553440000…` → `USD`); three-letter codes stay as they are. */
export function decodeCurrency(code: string): string {
  if (!/^[0-9A-F]{40}$/i.test(code)) return code;
  const text = Buffer.from(code, 'hex').toString('latin1').replace(/\0+$/, '');
  return /^[\x20-\x7e]+$/.test(text) ? text : code;
}
