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
  /** Cases that wait for a timeout to pass (PS-10: 35 minutes); left out of the `testnet` set. */
  longWait?: boolean;
  /**
   * Issued assets the case needs on the chain (PS-04 pays a token order in another
   * token). On a chain with fewer the case is recorded as skipped, not failed: Xahau's
   * catalogue entry is XAH alone.
   */
  needsIssuedAssets?: number;
  /**
   * The platforms a case exists for; absent means every one. The catalogue is
   * platform-neutral by design, so this stays rare: PS-12 is Shopware's Store API.
   * A run against another platform records the case as skipped, not failed.
   */
  targets?: readonly PlatformName[];
  /**
   * Driver methods the case reads (PS-13…15: what the checkout offers, what the
   * configuration says). A driver without them records the case as skipped: the
   * platform does not check the receiving account yet.
   */
  needsDriver?: readonly ('offeredAssets' | 'accountFindings')[];
  /** Ledger methods the case needs to put the receiving account in its state; skipped without them. */
  needsLedger?: readonly ('unfundedAddress' | 'requireDepositAuth')[];
  /**
   * The case sends a payment. A run with such a case lets the payer get what it needs before
   * the first order (Ledger.authorize: on Interledger the owner's grant), so no quote runs out
   * while somebody decides. A case that pays without the mark still pays; it only asks late.
   */
  pays?: boolean;
}

export type PlatformName = 'prestashop' | 'shopware' | 'woocommerce' | 'magento';

/** Whether a case is for this platform. */
export function appliesTo(spec: CaseSpec, platform: string): boolean {
  return spec.targets === undefined || (spec.targets as readonly string[]).includes(platform);
}

export const CASES: readonly CaseSpec[] = [
  { id: 'PS-01', title: 'Waiting', asset: 'XRP', summary: 'Place an order, send nothing.',
    expects: ['state waiting', 'seconds_left falls between polls', 'no redirect', 'order open'] },
  { id: 'PS-02', pays: true, title: 'Expired, then refreshed', asset: 'XRP', summary: 'Quote validity 60 s, wait, refresh.',
    expects: ['state expired, seconds_left null', 'refresh yields a new amount', 'destination tag unchanged', 'refresh refused once something arrived'] },
  { id: 'PS-03', pays: true, title: 'Partial, then topped up', asset: 'XRP', summary: 'Send half of the displayed amount, then the shortfall.',
    expects: ['state partial with amount_paid and shortfall', 'merchant sees the partial state', 'top-up settles: redirect, hash of the second transaction, amount_paid is the sum'] },
  { id: 'PS-04', pays: true, title: 'Wrong asset, then the right one', asset: 'USDC', needsIssuedAssets: 2, summary: 'Pay a USDC order in RLUSD, then in USDC; then an XRP order in RLUSD, then in XRP.',
    expects: ['state wrong_asset, shortfall is the full request, amount_paid the delivered asset', 'merchant sees the incomplete state', 'the quoted asset settles', 'the same across the asset class (core 0.8.1)'], nightlyOnly: true },
  { id: 'PS-05', pays: true, title: 'Settled', asset: 'XRP', summary: 'Send exactly the displayed amount on a small order.',
    expects: ['state settled with redirect', 'exactly one transition to paid', 'one payment record with the hash'] },
  { id: 'PS-06', title: 'Guest, key knowledge instead of login', asset: 'XRP', summary: 'Open page and status endpoint without a session.',
    expects: ['payment page loads', 'status endpoint answers 200'] },
  { id: 'PS-07', title: 'Wrong key is refused without a hint', asset: 'XRP', summary: 'Call the status endpoint with a wrong secret.',
    expects: ['403 or redirect', 'no indication whether the order exists'] },
  { id: 'PS-08', title: 'Throttling', asset: 'XRP', summary: 'Two status calls inside 5 s.',
    expects: ['one node request', 'both payloads of the same shape'] },
  { id: 'PS-09', pays: true, title: 'Safety net without a browser', asset: 'XRP', summary: 'Pay with the page closed, trigger cron / scheduled task.',
    expects: ['order settles without a poll'] },
  { id: 'PS-10', pays: true, title: 'Late return after the checkout session is gone', asset: 'XRP', summary: 'Pay 35 minutes after checkout.',
    expects: ['status endpoint settles', 'redirect goes to an order page, not an expired return URL'], nightlyOnly: true, longWait: true },
  { id: 'PS-11', pays: true, title: 'Closed by the merchant', asset: 'XRP', summary: 'Merchant cancels, customer pays anyway, the safety net runs.',
    expects: ['redirect present', 'no state change back to open', 'after the safety net the payment is on record for the merchant'] },
  { id: 'PS-12', pays: true, title: 'Headless: quote and status over the Store API', asset: 'XRP', summary: 'Order placed, then as a guest without a session: quote with the deepLinkCode, status over the Store API with the access key, pay, redirect; a wrong code refused like an unknown order.',
    expects: ['quote answers 200 with page.schema_version 1 and the values the payment page shows: account, identifier, amount, payment request', 'status over the Store API answers the contract', 'a wrong code and an unknown order are refused alike, on quote and status', 'paid: status redirects to an absolute URL and names the transaction hash', 'quote refuses an order that no longer waits (410)'], targets: ['shopware'] },
  { id: 'PS-13', title: 'Receiving account without trust lines', asset: 'USDC', needsIssuedAssets: 1, needsDriver: ['offeredAssets', 'accountFindings'],
    summary: 'Point the shop at an activated account without trust lines; read the checkout and the configuration.',
    expects: ['the checkout offers the native asset and no issued asset', 'the configuration names the missing trust line for each issued asset, as blocking'] },
  { id: 'PS-14', title: 'Receiving account not activated', asset: 'XRP', needsDriver: ['offeredAssets', 'accountFindings'], needsLedger: ['unfundedAddress'],
    summary: 'Point the shop at an address nobody funded; read the checkout and the configuration.',
    expects: ['XRPL/Xahau: the checkout offers the native asset only (a payment from the base reserve up activates the account)', 'Stellar: the checkout offers nothing (a payment never creates its destination)', 'the configuration says the account is missing'] },
  { id: 'PS-15', title: 'Deposit authorization on the receiving account', asset: 'XRP', needsDriver: ['offeredAssets', 'accountFindings'], needsLedger: ['requireDepositAuth'],
    summary: 'Point the shop at an account with trust lines and deposit authorization set; read the checkout and the configuration.',
    expects: ['the checkout offers every asset (pre-authorized senders may pay)', 'the configuration warns about deposit authorization, not blocking'] },
];

export function findCase(id: string): CaseSpec | undefined {
  return CASES.find((c) => c.id.toLowerCase() === id.toLowerCase());
}
