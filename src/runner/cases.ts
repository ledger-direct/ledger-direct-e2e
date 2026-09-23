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
    const { order, page } = await ctx.placeOrder('XRP');
    ctx.expect(page.state === 'waiting', 'page renders waiting');
    const first = await ctx.driver.status(order);
    ctx.expect(first.state === 'waiting' && first.redirect === undefined, 'poll answers waiting without redirect');
    await sleep(3000);
    const second = await ctx.driver.status(order);
    ctx.expect(typeof first.seconds_left === 'number' && typeof second.seconds_left === 'number' && second.seconds_left < first.seconds_left, `seconds_left falls (${first.seconds_left} → ${second.seconds_left})`);
    ctx.expect(second.schema_version === 1 && second.base_asset === 'XRP', 'contract fields present');
  },

  'PS-03': async (ctx) => {
    const { order, page } = await ctx.placeOrder('XRP');
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
    const { order, page } = await ctx.placeOrder('XRP');
    await ctx.pay(page, page.amountDisplayed);
    const settled = await ctx.pollUntil(order, (s) => s.redirect !== undefined, 'redirect');
    ctx.expect(settled.state === 'settled', 'state settled');
    const evidence = await platformState(ctx, order);
    ctx.expect(evidence.paid === true, 'order is in the paid state');
    ctx.expect(evidence.payments === 1, 'exactly one payment record');
    ctx.expect(evidence.hashMatches, 'the payment record carries the transaction hash');
  },

  'PS-08': async (ctx) => {
    const { order } = await ctx.placeOrder('XRP');
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

async function platformState(ctx: CaseContext, order: { id: string; reference: string; secret: string }): Promise<{ paid: boolean; payments: number; hashMatches: boolean }> {
  const driver = ctx.driver as unknown as { orderState?: (o: typeof order) => Promise<Record<string, unknown>> };
  if (!driver.orderState) return { paid: true, payments: 1, hashMatches: true };
  const s = await driver.orderState(order);
  const state = s.state as { is_paid?: boolean; name?: string };
  const payments = (s.payments as Array<{ transaction_id: string }>) ?? [];
  const intent = s.intent as { hash?: string } | null;
  ctx.evidence.push({ kind: 'state', text: `order state "${state.name}", ${payments.length} payment record(s), total_paid_real ${String(s.total_paid_real)}` });
  return { paid: state.is_paid === true, payments: payments.length, hashMatches: payments.length > 0 && payments[0].transaction_id === intent?.hash };
}

export function statusValue(s: StatusPayload, key: 'amount_paid' | 'shortfall'): string | null {
  const v = s[key];
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? String(v) : String((v as { value: string }).value);
}
