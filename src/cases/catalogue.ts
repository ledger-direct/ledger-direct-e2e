/**
 * The case catalogue — `docs/manual-tests/payment-status.md` in the core,
 * instantiated per plugin. Same IDs, same expectations; this file is the
 * machine-readable form the runner and the MCP server hand out.
 */
export type State = 'waiting' | 'partial' | 'wrong_asset' | 'settled' | 'expired';

export interface CaseSpec {
  id: string;
  title: string;
  asset: 'XRP' | 'USDC';
  /** Human summary; the executable steps live in the runner once a driver exists. */
  summary: string;
  expects: string[];
  /** Cases that need the public testnet even once a local node exists (PS-04) or a long wait (PS-10). */
  nightlyOnly?: boolean;
}

export const CASES: readonly CaseSpec[] = [
  { id: 'PS-01', title: 'Waiting', asset: 'XRP', summary: 'Place an order, send nothing.',
    expects: ['state waiting', 'seconds_left falls between polls', 'no redirect', 'order open'] },
  { id: 'PS-02', title: 'Expired, then refreshed', asset: 'XRP', summary: 'Quote validity 60 s, wait, refresh.',
    expects: ['state expired, seconds_left null', 'refresh yields a new amount', 'destination tag unchanged', 'refresh refused once something arrived'] },
  { id: 'PS-03', title: 'Partial, then topped up', asset: 'XRP', summary: 'Send half of the displayed amount, then the shortfall.',
    expects: ['state partial with amount_paid and shortfall', 'merchant sees the partial state', 'top-up settles: redirect, hash of the second transaction, amount_paid is the sum'] },
  { id: 'PS-04', title: 'Wrong asset, then the right one', asset: 'USDC', summary: 'Pay a USDC order in RLUSD, then in USDC.',
    expects: ['state wrong_asset, shortfall is the full request', 'merchant sees the incomplete state', 'USDC settles'], nightlyOnly: true },
  { id: 'PS-05', title: 'Settled', asset: 'XRP', summary: 'Send exactly the displayed amount on a small order.',
    expects: ['state settled with redirect', 'exactly one transition to paid', 'one payment record with the hash'] },
  { id: 'PS-06', title: 'Guest, key knowledge instead of login', asset: 'XRP', summary: 'Open page and status endpoint without a session.',
    expects: ['payment page loads', 'status endpoint answers 200'] },
  { id: 'PS-07', title: 'Wrong key is refused without a hint', asset: 'XRP', summary: 'Call the status endpoint with a wrong secret.',
    expects: ['403 or redirect', 'no indication whether the order exists'] },
  { id: 'PS-08', title: 'Throttling', asset: 'XRP', summary: 'Two status calls inside 5 s.',
    expects: ['one node request', 'both payloads of the same shape'] },
  { id: 'PS-09', title: 'Safety net without a browser', asset: 'XRP', summary: 'Pay with the page closed, trigger cron / scheduled task.',
    expects: ['order settles without a poll'] },
  { id: 'PS-10', title: 'Late return after the checkout session is gone', asset: 'XRP', summary: 'Pay 35 minutes after checkout.',
    expects: ['status endpoint settles', 'redirect goes to an order page, not an expired return URL'], nightlyOnly: true },
  { id: 'PS-11', title: 'Closed by the merchant', asset: 'XRP', summary: 'Merchant cancels, customer pays anyway.',
    expects: ['redirect present', 'no state change back to open'] },
];

export function findCase(id: string): CaseSpec | undefined {
  return CASES.find((c) => c.id.toLowerCase() === id.toLowerCase());
}
