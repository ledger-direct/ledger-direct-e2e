import type { IncomingPayment } from '../chain.js';
import { NATIVE } from './assets.js';

/**
 * Incoming payments from Horizon's `/accounts/{id}/payments?join=transactions`, newest first.
 * Pure, so the record shapes are tested without Horizon.
 *
 * The identifier is the muxed id when the payment went to an M-address, otherwise the
 * transaction memo — MEMO_ID as the decimal string, MEMO_TEXT as its text (E3: a text memo
 * with the digits of the id is how some wallets send it).
 */
export function parseStellarIncoming(records: unknown[], address: string, explorerBase: string): IncomingPayment[] {
  const out: IncomingPayment[] = [];
  for (const raw of records) {
    const r = raw as Record<string, unknown> & { transaction_attr?: Record<string, unknown>; _embedded?: { transaction?: Record<string, unknown> } };
    const type = String(r.type ?? '');
    let to: string; let amount: string; let asset: string; let issuer: string | undefined;
    if (type === 'create_account') {
      to = String(r.account ?? ''); amount = String(r.starting_balance ?? '0'); asset = NATIVE;
    } else if (type === 'payment' || type === 'path_payment_strict_receive' || type === 'path_payment_strict_send') {
      to = String(r.to ?? '');
      amount = String(r.amount ?? '0');
      asset = r.asset_type === 'native' ? NATIVE : String(r.asset_code ?? '?');
      issuer = r.asset_type === 'native' ? undefined : String(r.asset_issuer ?? '') || undefined;
    } else continue;
    if (to !== address) continue;
    const tx = r.transaction_attr ?? r._embedded?.transaction ?? {};
    const success = r.transaction_successful !== false && tx.successful !== false;
    let identifier: string | undefined; let identifierKind: IncomingPayment['identifierKind'];
    if (r.to_muxed_id !== undefined && r.to_muxed_id !== null && r.to_muxed_id !== '') {
      identifier = String(r.to_muxed_id); identifierKind = 'muxed';
    } else if (tx.memo_type === 'id' && tx.memo !== undefined) {
      identifier = String(tx.memo); identifierKind = 'memo_id';
    } else if (tx.memo_type === 'text' && tx.memo !== undefined) {
      identifier = String(tx.memo); identifierKind = 'memo_text';
    }
    const hash = String(r.transaction_hash ?? tx.hash ?? '');
    out.push({
      hash,
      asset,
      ...(issuer ? { issuer } : {}),
      amount: success ? amount : '0',
      ...(identifier !== undefined ? { identifier, identifierKind } : {}),
      from: String(r.from ?? r.funder ?? r.source_account ?? ''),
      result: success ? 'success' : 'failed',
      validated: success,
      ...(r.created_at ? { at: String(r.created_at) } : {}),
      explorer: explorerBase + hash,
    });
  }
  return out;
}
