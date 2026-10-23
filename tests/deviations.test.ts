import { describe, expect, it } from 'vitest';
import type { IncomingPayment } from '../src/chains/chain.js';
import type { PaymentPageView, StatusPayload } from '../src/drivers/driver.js';
import type { PlatformState } from '../src/drivers/platform.js';
import { deviations, verdict, type WatchQuote } from '../src/watch/deviations.js';
import type { Observation } from '../src/watch/observe.js';

const USDC: WatchQuote = { asset: 'USDC', issuer: 'rUSDC', native: false };
const XRP: WatchQuote = { asset: 'XRP', native: true };

const page = (state: PaymentPageView['state'], extra: Partial<PaymentPageView> = {}): PaymentPageView => ({
  state, amountDisplayed: '1.23', asset: 'USDC', destinationAccount: 'rShop', paymentIdentifier: '7', statusUrl: 'x', network: 'testnet', ...extra,
});
const status = (state: StatusPayload['state'], extra: Partial<StatusPayload> = {}): StatusPayload => ({
  schema_version: 1, state, base_asset: 'USDC', amount_requested: { currency: 'USDC', value: '1.23', issuer: 'rUSDC' }, amount_paid: null, shortfall: null, seconds_left: 300, ...extra,
});
const tx = (hash: string, amount: string, extra: Partial<IncomingPayment> = {}): IncomingPayment => ({
  hash, asset: 'USDC', issuer: 'rUSDC', amount, identifier: '7', identifierKind: 'tag', from: 'rPayer', result: 'tesSUCCESS', validated: true, explorer: 'e/' + hash, ...extra,
});
const platform = (paid: boolean, name = paid ? 'paid' : 'open'): PlatformState => ({ name, paid, incomplete: false, payments: [], raw: {} });

/** An observation `t` seconds after 10:00:00. */
function at(t: number, o: { page?: PaymentPageView; status?: StatusPayload; incoming?: IncomingPayment[]; platform?: PlatformState | null; recorded?: string[]; ledgerError?: string }): Observation {
  return {
    at: new Date(Date.UTC(2026, 9, 23, 10, 0, t)).toISOString(),
    customer: { pageStatus: o.page ? 200 : 302, ...(o.page ? { page: o.page } : {}), ...(o.status ? { status: o.status } : {}) },
    shop: { platform: o.platform ?? null, ...(o.recorded ? { recorded: o.recorded } : {}) },
    ledger: { ...(o.incoming ? { incoming: o.incoming } : {}), ...(o.ledgerError ? { error: o.ledgerError } : {}) },
  };
}
const ids = (h: Observation[], q = USDC) => deviations(h, q).map((d) => d.id);

describe('deviations', () => {
  it('a payment that settles within the grace period raises nothing', () => {
    const h = [
      at(0, { page: page('waiting'), status: status('waiting'), incoming: [], recorded: [] }),
      at(5, { page: page('waiting'), status: status('waiting'), incoming: [tx('H1', '1.23')], recorded: [] }),
      at(10, { status: status('settled', { amount_paid: { currency: 'USDC', value: '1.23', issuer: 'rUSDC' }, redirect: '/done' }), incoming: [tx('H1', '1.23')], recorded: ['H1'], platform: platform(true) }),
    ];
    expect(deviations(h, USDC)).toEqual([]);
    expect(verdict(deviations(h, USDC))).toBe('ok');
  });

  it('silent feedback: money on the ledger, the status endpoint keeps saying waiting', () => {
    const h = [0, 5, 10, 15, 20, 25].map((t) => at(t, { page: page('waiting'), status: status('waiting'), incoming: t >= 5 ? [tx('H1', '1.23')] : [], recorded: ['H1'] }));
    const found = deviations(h, USDC);
    expect(found.map((d) => d.id)).toEqual(['ledger-paid-page-waiting']);
    expect(found[0]).toMatchObject({ level: 'alarm', since: '2026-10-23T10:00:05.000Z', params: { state: 'waiting', hash: 'H1', count: '1' } });
    expect(verdict(found)).toBe('alarm');
  });

  it('waits out the grace period before it counts', () => {
    const h = [0, 5, 10].map((t) => at(t, { status: status('waiting'), incoming: t >= 5 ? [tx('H1', '1.23')] : [] }));
    expect(ids(h)).toEqual([]);
  });

  it('a token from another issuer must show as wrong_asset', () => {
    const foreign = tx('H2', '1.23', { issuer: 'rOther' });
    const waiting = [0, 30].map((t) => at(t, { status: status('waiting'), incoming: [foreign], recorded: ['H2'] }));
    expect(ids(waiting)).toEqual(['ledger-foreign-not-shown']);
    const shown = [0, 30].map((t) => at(t, { status: status('wrong_asset'), incoming: [foreign], recorded: ['H2'] }));
    expect(ids(shown)).toEqual([]);
  });

  it('on an XRP quote a token payment is the other asset class and expected to be ignored', () => {
    const h = [0, 30].map((t) => at(t, { status: status('waiting', { amount_requested: 0.85635 }), incoming: [tx('H3', '1', { asset: 'USDC' })], recorded: ['H3'] }));
    expect(ids(h, XRP)).toEqual([]);
  });

  it('the displayed amount must be the quote, at once — the 0.83 for 0.83211 bug', () => {
    const h = [at(0, { page: page('waiting', { amountDisplayed: '0.83', asset: 'XRP' }), status: status('waiting', { amount_requested: 0.83211 }) })];
    const found = deviations(h, XRP);
    expect(found.map((d) => d.id)).toEqual(['page-amount-differs']);
    expect(found[0].params).toEqual({ page: '0.83', quote: '0.83211', asset: 'XRP' });
    expect(ids([at(0, { page: page('waiting', { amountDisplayed: '0.832110', asset: 'XRP' }), status: status('waiting', { amount_requested: 0.83211 }) })], XRP)).toEqual([]);
  });

  it('settled at the endpoint but still open in the shop, and the other way round', () => {
    const settledOpen = [0, 25].map((t) => at(t, { status: status('settled', { redirect: '/r', amount_paid: { value: '1.23' } }), incoming: [tx('H1', '1.23')], recorded: ['H1'], platform: platform(false, 'open') }));
    expect(ids(settledOpen)).toEqual(['status-settled-shop-open']);
    const paidWaiting = [0, 25].map((t) => at(t, { status: status('partial', { amount_paid: { value: '1.23' } }), incoming: [tx('H1', '1.23')], recorded: ['H1'], platform: platform(true) }));
    expect(ids(paidWaiting)).toEqual(['shop-paid-status-open']);
  });

  it('what the endpoint counts must be what arrived, and every transaction must be on record', () => {
    const h = [0, 25].map((t) => at(t, { status: status('partial', { amount_paid: { value: '0.5' } }), incoming: [tx('H1', '0.6'), tx('H0', '0.01', { validated: false, result: 'tecPATH_PARTIAL', amount: '0' })], recorded: [] }));
    const found = deviations(h, USDC);
    expect(found.map((d) => d.id)).toEqual(['amount-paid-differs', 'tx-not-recorded']);
    expect(found[0].params).toEqual({ ledger: '0.6', status: '0.5', asset: 'USDC' });
    expect(found[1].params.missing).toBe('H1');
  });

  it('partial payments add up exactly', () => {
    const h = [0, 25].map((t) => at(t, { status: status('partial', { amount_paid: { value: '0.9' } }), incoming: [tx('H2', '0.3'), tx('H1', '0.6')], recorded: ['H1', 'H2'] }));
    expect(ids(h)).toEqual([]);
  });

  it('page and endpoint disagree, a settled order without redirect, a page on mainnet', () => {
    expect(ids([0, 25].map((t) => at(t, { page: page('waiting'), status: status('partial', { amount_paid: { value: '0.6' } }), incoming: [tx('H1', '0.6')], recorded: ['H1'] })))).toEqual(['page-status-differ']);
    expect(ids([0, 25].map((t) => at(t, { status: status('settled', { amount_paid: { value: '1.23' } }), incoming: [tx('H1', '1.23')], recorded: ['H1'], platform: platform(true) })))).toEqual(['settled-no-redirect']);
    expect(ids([at(0, { page: page('waiting', { network: 'mainnet' }), status: status('waiting') })])).toEqual(['page-not-testnet']);
  });

  it('a side that cannot be read is reported once the grace period is over', () => {
    expect(ids([0, 10].map((t) => at(t, { status: status('waiting'), ledgerError: 'timeout' })))).toEqual([]);
    const found = deviations([0, 30].map((t) => at(t, { status: status('waiting'), ledgerError: 'timeout' })), USDC);
    expect(found.map((d) => d.id)).toEqual(['ledger-unreachable']);
    expect(verdict(found)).toBe('warning');
  });

  it('since is the start of the unbroken run, not the first time ever', () => {
    const h = [
      at(0, { status: status('waiting'), ledgerError: 'x' }),
      at(5, { status: status('waiting') }),
      at(10, { status: status('waiting'), ledgerError: 'x' }),
      at(40, { status: status('waiting'), ledgerError: 'x' }),
    ];
    expect(deviations(h, USDC)[0].since).toBe('2026-10-23T10:00:10.000Z');
  });
});
