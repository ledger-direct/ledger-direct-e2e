import { describe, expect, it } from 'vitest';
import { parseXrplIncoming, decodeCurrency } from '../src/chains/xrpl/incoming.js';
import { parseStellarIncoming } from '../src/chains/stellar/incoming.js';

const SHOP = 'rsRbTicxbBsS83JqmAizH9vggETCGA627f';
const PAYER = 'rJdfC6X2L6tTURK7h214Q3MW3a4RrbzCa8';
const RLUSD = '524C555344000000000000000000000000000000';

// account_tx, API v2: tx_json + meta + close_time_iso, newest first.
const accountTx = [
  { hash: 'A1', validated: true, close_time_iso: '2026-10-23T10:00:05Z', meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '856350' },
    tx_json: { TransactionType: 'Payment', Account: PAYER, Destination: SHOP, DestinationTag: 4264383458, DeliverMax: '856350' } },
  { hash: 'A2', validated: true, close_time_iso: '2026-10-23T10:00:04Z', meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { currency: RLUSD, issuer: 'rOtherIssuerXXXXXXXXXXXXXXXXXXXXX', value: '1.01' } },
    tx_json: { TransactionType: 'Payment', Account: PAYER, Destination: SHOP, DestinationTag: 7, DeliverMax: { currency: RLUSD, issuer: 'rOtherIssuerXXXXXXXXXXXXXXXXXXXXX', value: '1.01' } } },
  { hash: 'A3', validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '400000' },
    tx_json: { TransactionType: 'Payment', Account: PAYER, Destination: SHOP, DestinationTag: 7, DeliverMax: '1000000', Flags: 131072, date: 814615205 } },
  { hash: 'A4', validated: true, meta: { TransactionResult: 'tecPATH_PARTIAL' },
    tx_json: { TransactionType: 'Payment', Account: PAYER, Destination: SHOP, DestinationTag: 7, DeliverMax: '1000000' } },
  { hash: 'A5', validated: true, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '5' },
    tx_json: { TransactionType: 'Payment', Account: SHOP, Destination: PAYER, DeliverMax: '5' } },
  { hash: 'A6', validated: true, meta: { TransactionResult: 'tesSUCCESS' }, tx_json: { TransactionType: 'TrustSet', Account: SHOP } },
  { hash: 'A7', validated: false, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '1' },
    tx: { TransactionType: 'Payment', Account: PAYER, Destination: SHOP, Amount: '1' } },
];

describe('parseXrplIncoming', () => {
  const parsed = parseXrplIncoming(accountTx, SHOP, 'https://testnet.xrpl.org/transactions/');

  it('keeps only payments to the account, newest first', () => {
    expect(parsed.map((p) => p.hash)).toEqual(['A1', 'A2', 'A3', 'A4', 'A7']);
  });

  it('reads XRP in XRP, the tag as a decimal string, the close time and the explorer link', () => {
    expect(parsed[0]).toEqual({
      hash: 'A1', asset: 'XRP', amount: '0.85635', identifier: '4264383458', identifierKind: 'tag', from: PAYER,
      result: 'tesSUCCESS', validated: true, at: '2026-10-23T10:00:05Z', explorer: 'https://testnet.xrpl.org/transactions/A1',
    });
  });

  it('names a token by its code and keeps the issuer it came from, even a foreign one', () => {
    expect(parsed[1]).toMatchObject({ asset: 'RLUSD', issuer: 'rOtherIssuerXXXXXXXXXXXXXXXXXXXXX', amount: '1.01' });
  });

  it('takes what was delivered, not what was sent (partial payment)', () => {
    expect(parsed[2]).toMatchObject({ amount: '0.4', validated: true });
    expect(parsed[2].at).toMatch(/^2025|^2026/);
  });

  it('counts a failed payment with nothing delivered and not validated', () => {
    expect(parsed[3]).toMatchObject({ result: 'tecPATH_PARTIAL', amount: '0', validated: false });
  });

  it('is not validated while the ledger is open (API v1 shape too)', () => {
    expect(parsed[4]).toMatchObject({ hash: 'A7', validated: false, amount: '0.000001' });
  });

  it('decodes a non-standard currency code', () => {
    expect(decodeCurrency('5553440000000000000000000000000000000000')).toBe('USD');
    expect(decodeCurrency('EUR')).toBe('EUR');
  });
});

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const P = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const horizon = [
  { type: 'payment', to: G, from: P, asset_type: 'native', amount: '1.5000000', transaction_hash: 'S1', transaction_successful: true, created_at: '2026-10-23T10:00:00Z',
    transaction_attr: { memo_type: 'id', memo: '1050508800', successful: true } },
  { type: 'payment', to: G, from: P, asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: P, amount: '1.2300000', transaction_hash: 'S2', transaction_successful: true,
    to_muxed: 'MA7Q…', to_muxed_id: '1050508800', transaction_attr: { memo_type: 'none' } },
  { type: 'payment', to: G, from: P, asset_type: 'native', amount: '1.5000000', transaction_hash: 'S3', transaction_successful: true,
    _embedded: { transaction: { memo_type: 'text', memo: '1050508800' } } },
  { type: 'payment', to: P, from: G, asset_type: 'native', amount: '9', transaction_hash: 'S4', transaction_successful: true },
  { type: 'create_account', account: G, funder: P, starting_balance: '10000.0000000', transaction_hash: 'S5', transaction_successful: true },
  { type: 'payment', to: G, from: P, asset_type: 'native', amount: '2', transaction_hash: 'S6', transaction_successful: false },
  { type: 'change_trust', transaction_hash: 'S7' },
];

describe('parseStellarIncoming', () => {
  const parsed = parseStellarIncoming(horizon, G, 'https://stellar.expert/explorer/testnet/tx/');

  it('keeps payments and account creation to the account', () => {
    expect(parsed.map((p) => p.hash)).toEqual(['S1', 'S2', 'S3', 'S5', 'S6']);
  });

  it('reads the memo id, the muxed id and a text memo as the identifier, saying which it was', () => {
    expect(parsed[0]).toMatchObject({ asset: 'XLM', amount: '1.5000000', identifier: '1050508800', identifierKind: 'memo_id', validated: true });
    expect(parsed[1]).toMatchObject({ asset: 'USDC', issuer: P, identifier: '1050508800', identifierKind: 'muxed' });
    expect(parsed[2]).toMatchObject({ identifier: '1050508800', identifierKind: 'memo_text' });
  });

  it('a failed transaction delivered nothing', () => {
    expect(parsed[4]).toMatchObject({ result: 'failed', amount: '0', validated: false });
  });
});
