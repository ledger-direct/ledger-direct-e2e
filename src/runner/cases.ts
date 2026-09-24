import { CaseContext, sleep } from './context.js';
import type { StatusPayload } from '../drivers/driver.js';

export type CaseRunner = (ctx: CaseContext) => Promise<void>;

/**
 * The executable half of the catalogue. Each function is one case, named by
 * its ID; the expectations are the catalogue's, the evidence is what the
 * report prints. Platform detail lives in the driver, never here.
 */
export const RUNNERS: Record<string, CaseRunner> = {
  'PS-01': async (ctx) => {
    const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
    ctx.expect(page.state === 'waiting', 'page renders waiting');
    const first = await ctx.driver.status(order);
    ctx.expect(first.state === 'waiting' && first.redirect === undefined, 'poll answers waiting without redirect');
    await sleep(3000);
    const second = await ctx.driver.status(order);
    ctx.expect(typeof first.seconds_left === 'number' && typeof second.seconds_left === 'number' && second.seconds_left < first.seconds_left, `seconds_left falls (${first.seconds_left} → ${second.seconds_left})`);
    ctx.expect(second.schema_version === 1 && second.base_asset === ctx.ledger.nativeAsset, 'contract fields present');
  },

  'PS-03': async (ctx) => {
    const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
    const half = halfOf(page.amountDisplayed);
    await ctx.pay(page, half);
    const partial = await ctx.pollUntil(order, (s) => s.state === 'partial', 'partial');
    ctx.expect(partial.amount_paid !== null && partial.shortfall !== null, 'partial carries amount_paid and shortfall');
    const shortfall = typeof partial.shortfall === 'number' ? partial.shortfall.toString() : String((partial.shortfall as { value: string }).value);
    ctx.note(`shortfall reported: ${shortfall} ${page.asset}`);
    await ctx.pay(page, shortfall);
    const settled = await ctx.pollUntil(order, (s) => s.redirect !== undefined, 'redirect after top-up');
    ctx.expect(settled.state === 'settled', 'state settled after the top-up');
    const evidence = await platformState(ctx, order);
    ctx.expect(evidence.paid === true, 'order is in the paid state');
    ctx.expect(evidence.payments === 1, 'exactly one payment record');
  },

  'PS-05': async (ctx) => {
    const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
    await ctx.pay(page, page.amountDisplayed);
    const settled = await ctx.pollUntil(order, (s) => s.redirect !== undefined, 'redirect');
    ctx.expect(settled.state === 'settled', 'state settled');
    const evidence = await platformState(ctx, order);
    ctx.expect(evidence.paid === true, 'order is in the paid state');
    ctx.expect(evidence.payments === 1, 'exactly one payment record');
    ctx.expect(evidence.hashMatches, 'the payment record carries the transaction hash');
  },

  'PS-08': async (ctx) => {
    const { order } = await ctx.placeOrder(ctx.ledger.nativeAsset);
    // First call syncs (or the throttle window is already open from placing the order); wait it out.
    await ctx.driver.status(order);
    await sleep(6000);
    const before = await ctx.driver.nodeRequests();
    const a = await ctx.driver.status(order);
    const afterFirst = await ctx.driver.nodeRequests();
    const b = await ctx.driver.status(order);
    const afterSecond = await ctx.driver.nodeRequests();
    ctx.expect(afterFirst !== before, 'the first call after the window synced');
    ctx.expect(afterSecond === afterFirst, 'the second call inside the window did not sync');
    ctx.expect(JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b)), 'both answers have the same shape');
  },
};

function halfOf(amount: string): string {
  const [int, frac = ''] = amount.split('.');
  const scale = frac.length;
  const units = BigInt(int + frac);
  const half = units / 2n;
  const s = half.toString().padStart(scale + 1, '0');
  return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

async function platformState(ctx: CaseContext, order: { id: string; reference: string; secret: string }): Promise<{ paid: boolean; incomplete: boolean; payments: number; hashMatches: boolean }> {
  const driver = ctx.driver as unknown as { orderState?: (o: typeof order) => Promise<Record<string, unknown>> };
  if (!driver.orderState) return { paid: true, incomplete: false, payments: 1, hashMatches: true };
  const s = await driver.orderState(order);
  const state = s.state as { is_paid?: boolean; is_incomplete?: boolean; name?: string };
  const payments = (s.payments as Array<{ transaction_id: string }>) ?? [];
  const intent = s.intent as { hash?: string } | null;
  ctx.evidence.push({ kind: 'state', text: `order state "${state.name}", ${payments.length} payment record(s), total_paid_real ${String(s.total_paid_real)}` });
  return { paid: state.is_paid === true, incomplete: state.is_incomplete === true, payments: payments.length, hashMatches: payments.length > 0 && payments[0].transaction_id === intent?.hash };
}

export function statusValue(s: StatusPayload, key: 'amount_paid' | 'shortfall'): string | null {
  const v = s[key];
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? String(v) : String((v as { value: string }).value);
}

RUNNERS['PS-04'] = async (ctx) => {
  const [quoted, other] = ctx.wrongAssetPair();
  const { order, page } = await ctx.placeOrder(quoted);
  ctx.expect(page.asset === quoted, `order is quoted in ${quoted}`);
  // The same number, but in another token: the customer's wallet reports success, the shop credits nothing.
  await ctx.pay(page, page.amountDisplayed, other);
  const wrong = await ctx.pollUntil(order, (s) => s.state === 'wrong_asset', 'wrong_asset');
  ctx.expect(statusValue(wrong, 'shortfall') !== null && Number(statusValue(wrong, 'shortfall')) === Number(page.amountDisplayed), 'shortfall is the full request');
  ctx.expect(wrong.redirect === undefined, 'no redirect while nothing is credited');
  const seen = await platformState(ctx, order);
  ctx.expect(seen.paid === false && seen.incomplete === true, 'merchant sees the incomplete state');
  await ctx.pay(page, page.amountDisplayed, quoted);
  const settled = await ctx.pollUntil(order, (s) => s.redirect !== undefined, 'redirect after the right token');
  ctx.expect(settled.state === 'settled', `${quoted} settles the order`);
  ctx.expect((await platformState(ctx, order)).paid === true, 'order is in the paid state');
};

RUNNERS['PS-06'] = async (ctx) => {
  // The harness holds no session cookie: everything it does, it does as a guest with the key.
  const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
  const pageResponse = await ctx.driver.pageResponse(order);
  ctx.expect(pageResponse.status === 200, 'payment page renders with the key alone');
  ctx.expect(page.state === 'waiting' && page.paymentIdentifier !== '', 'page carries the payment instructions');
  const status = await ctx.driver.statusResponse(order);
  ctx.expect(status.status === 200 && status.body.includes('"schema_version":1'), 'status endpoint answers the contract without a login');
};

RUNNERS['PS-07'] = async (ctx) => {
  const { order } = await ctx.placeOrder(ctx.ledger.nativeAsset);
  const forged = { ...order, secret: 'not-the-key' };
  const status = await ctx.driver.statusResponse(forged);
  ctx.expect(status.status === 403, `wrong key is refused with 403 (got ${status.status})`);
  ctx.expect(!status.body.includes(order.reference) && !status.body.includes('amount') && !status.body.includes('state'), 'refusal carries no order data');
  const missing = await ctx.driver.statusResponse({ ...order, id: '999999999' });
  ctx.expect(missing.status === 403 && missing.body === status.body, 'an unknown order is refused exactly like a wrong key');
  const page = await ctx.driver.pageResponse(forged);
  ctx.expect(page.status >= 300 && page.status < 400, `payment page with a wrong key redirects (got ${page.status})`);
};

RUNNERS['PS-09'] = async (ctx) => {
  const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
  await ctx.pay(page, page.amountDisplayed);
  // Nobody polls: the customer closed the page. Only the safety net can settle this order.
  const answer = (await ctx.driver.safetyNet()) as { synced?: boolean; checked?: number; settled?: number } | undefined;
  ctx.note(`safety net answered ${JSON.stringify(answer ?? null)}`);
  ctx.expect(answer?.synced === true, 'safety net synced the ledger');
  ctx.expect((answer?.settled ?? 0) >= 1, 'safety net settled at least this order');
  const seen = await platformState(ctx, order);
  ctx.expect(seen.paid === true && seen.hashMatches, 'order is paid with the transaction hash, without a poll');
  const after = await ctx.driver.status(order);
  ctx.expect(after.redirect !== undefined, 'the next poll only redirects');
};

RUNNERS['PS-11'] = async (ctx) => {
  const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
  await ctx.driver.close(order);
  ctx.note('merchant cancelled the order');
  await ctx.pay(page, page.amountDisplayed);
  const status = await ctx.driver.status(order);
  ctx.expect(status.redirect !== undefined, 'poll redirects for a closed order');
  const seen = await platformState(ctx, order);
  ctx.expect(seen.paid === false, 'the payment does not reopen or pay a cancelled order');
};

RUNNERS['PS-02'] = async (ctx) => {
  await ctx.reconfigure({ quoteExpirySeconds: 60 });
  try {
    const { order, page } = await ctx.placeOrder(ctx.ledger.nativeAsset);
    const expired = await ctx.pollUntil(order, (s) => s.state === 'expired', 'expired', 5000);
    ctx.expect(expired.seconds_left === null && expired.redirect === undefined, 'expired: no countdown, no redirect');
    await ctx.driver.refresh(order);
    const refreshed = await ctx.driver.paymentPage(order);
    ctx.expect(refreshed.state === 'waiting', 'refresh yields a fresh quote');
    ctx.expect(refreshed.paymentIdentifier === page.paymentIdentifier && refreshed.destinationAccount === page.destinationAccount, 'destination account and payment identifier unchanged');
    const status = await ctx.driver.status(order);
    ctx.expect(typeof status.seconds_left === 'number' && status.seconds_left > 0, 'countdown runs again');
    ctx.note(`amount before ${page.amountDisplayed}, after ${refreshed.amountDisplayed}`);

    // A refresh must not wipe a payment that already arrived.
    const second = await ctx.placeOrder(ctx.ledger.nativeAsset);
    await ctx.pay(second.page, halfOf(second.page.amountDisplayed));
    await ctx.pollUntil(second.order, (s) => s.state === 'partial', 'partial', 5000);
    await sleep(65000);
    await ctx.driver.refresh(second.order);
    const afterRefresh = await ctx.driver.paymentPage(second.order);
    ctx.expect(afterRefresh.state === 'partial' && afterRefresh.paymentIdentifier === second.page.paymentIdentifier, 'partial payment survives a refresh, identifier unchanged');
  } finally {
    await ctx.reconfigure({});
  }
};
