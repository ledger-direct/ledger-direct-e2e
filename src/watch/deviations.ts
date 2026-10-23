import { amountValue, sameDecimal, sumDecimals } from '../amounts.js';
import type { IncomingPayment } from '../chains/chain.js';
import type { Observation } from './observe.js';

/**
 * The deviation rules: where the three sides of an order disagree. The error class they look
 * for is silent feedback — money on the ledger the page does not show, a shop that says paid
 * while the status endpoint does not, an amount on the page that is not the quote. Those cost
 * the most time so far, because every side on its own looked fine.
 *
 * Pure: a series of observations in, the deviations out. Most rules hold for a grace period
 * before they count (a sync is throttled to 5 s, a page polls every 8 s); a rule that is
 * wrong the moment it is true (the displayed amount is not the quote) counts at once.
 */
export type DeviationId =
  | 'ledger-paid-page-waiting'
  | 'ledger-foreign-not-shown'
  | 'status-settled-shop-open'
  | 'shop-paid-status-open'
  | 'page-status-differ'
  | 'page-amount-differs'
  | 'amount-paid-differs'
  | 'tx-not-recorded'
  | 'settled-no-redirect'
  | 'page-not-testnet'
  | 'customer-unreachable'
  | 'shop-unreachable'
  | 'ledger-unreachable';

export type DeviationLevel = 'alarm' | 'warning';

export interface Deviation {
  id: DeviationId;
  level: DeviationLevel;
  /** When the condition first held in the unbroken run that ends with the latest observation. */
  since: string;
  /** What the rule saw in the latest observation; the lab fills its sentences from these. */
  params: Record<string, string>;
  /** The same in an English sentence, for logs and the CLI. */
  message: string;
}

/** What the order was quoted in. */
export interface WatchQuote {
  asset: string;
  /** Issued assets: the issuer the quote names. */
  issuer?: string;
  native: boolean;
}

export interface DeviationOptions {
  /** How long a condition must hold before it counts; 20 s by default. */
  graceSeconds?: number;
  /** The clock; the latest observation's time by default. */
  now?: string;
}

interface Rule {
  id: DeviationId;
  level: DeviationLevel;
  grace: boolean;
  check(o: Observation, q: WatchQuote): Record<string, string> | null;
  message(p: Record<string, string>): string;
}

/** Validated payments, split into those in the quoted asset and those in another token. */
export function classify(incoming: IncomingPayment[] | undefined, q: WatchQuote): { matching: IncomingPayment[]; foreign: IncomingPayment[] } {
  const validated = (incoming ?? []).filter((p) => p.validated);
  const isMatching = (p: IncomingPayment) => p.asset === q.asset && (q.native ? !p.issuer : !q.issuer || p.issuer === q.issuer);
  const matching = validated.filter(isMatching);
  // The core skips the other asset class: a native payment on a token quote is not "wrong asset", nor a token on an XRP quote.
  const foreign = q.native ? [] : validated.filter((p) => !isMatching(p) && p.issuer !== undefined);
  return { matching, foreign };
}

const OPEN = ['waiting', 'expired'];

const RULES: Rule[] = [
  {
    id: 'ledger-paid-page-waiting', level: 'alarm', grace: true,
    check(o, q) {
      const state = o.customer.status?.state;
      const { matching } = classify(o.ledger.incoming, q);
      if (!state || !OPEN.includes(state) || matching.length === 0) return null;
      return { state, count: String(matching.length), hash: matching[0].hash, amount: `${matching[0].amount} ${matching[0].asset}` };
    },
    message: (p) => `the ledger holds ${p.count} payment(s) in the quoted asset (newest ${p.hash}, ${p.amount}), the status endpoint still says ${p.state}`,
  },
  {
    id: 'ledger-foreign-not-shown', level: 'alarm', grace: true,
    check(o, q) {
      const state = o.customer.status?.state;
      const { matching, foreign } = classify(o.ledger.incoming, q);
      if (!state || !OPEN.includes(state) || matching.length > 0 || foreign.length === 0) return null;
      return { state, asset: foreign[0].asset, issuer: foreign[0].issuer ?? '', hash: foreign[0].hash, quoted: q.asset };
    },
    message: (p) => `a payment in ${p.asset} (issuer ${p.issuer}) arrived on an order quoted in ${p.quoted}; the status endpoint says ${p.state} instead of wrong_asset`,
  },
  {
    id: 'status-settled-shop-open', level: 'alarm', grace: true,
    check(o) {
      const platform = o.shop.platform;
      if (o.customer.status?.state !== 'settled' || !platform || platform.paid) return null;
      return { shopState: platform.name ?? '?' };
    },
    message: (p) => `the status endpoint says settled, the shop still has the order as "${p.shopState}"`,
  },
  {
    id: 'shop-paid-status-open', level: 'alarm', grace: true,
    check(o) {
      const status = o.customer.status;
      if (!o.shop.platform?.paid || !status || status.state === 'settled' || status.redirect !== undefined) return null;
      return { state: status.state, shopState: o.shop.platform.name ?? 'paid' };
    },
    message: (p) => `the shop has the order as "${p.shopState}", the status endpoint says ${p.state} and gives no redirect`,
  },
  {
    id: 'page-status-differ', level: 'warning', grace: true,
    check(o) {
      const page = o.customer.page, status = o.customer.status;
      if (!page || !status || page.state === status.state) return null;
      return { page: page.state, status: status.state };
    },
    message: (p) => `the page shows ${p.page}, the status endpoint says ${p.status}`,
  },
  {
    id: 'page-amount-differs', level: 'alarm', grace: false,
    check(o) {
      const page = o.customer.page, requested = amountValue(o.customer.status?.amount_requested);
      if (!page || requested === null || sameDecimal(page.amountDisplayed, requested)) return null;
      return { page: page.amountDisplayed, quote: requested, asset: page.asset };
    },
    message: (p) => `the page asks for ${p.page} ${p.asset}, the quote is ${p.quote} — whoever sends what the page shows pays the wrong amount`,
  },
  {
    id: 'amount-paid-differs', level: 'warning', grace: true,
    check(o, q) {
      const status = o.customer.status;
      const { matching } = classify(o.ledger.incoming, q);
      if (!status || matching.length === 0 || OPEN.includes(status.state)) return null;
      const ledger = sumDecimals(matching.map((p) => p.amount));
      const paid = amountValue(status.amount_paid);
      if (ledger === null || (paid !== null && sameDecimal(ledger, paid))) return null;
      return { ledger, status: paid ?? 'null', asset: q.asset };
    },
    message: (p) => `${p.ledger} ${p.asset} arrived on the ledger, the status endpoint counts ${p.status}`,
  },
  {
    id: 'tx-not-recorded', level: 'warning', grace: true,
    check(o) {
      const recorded = o.shop.recorded;
      if (!recorded) return null;
      const missing = (o.ledger.incoming ?? []).filter((p) => p.validated && !recorded.includes(p.hash)).map((p) => p.hash);
      return missing.length ? { missing: missing.join(', '), count: String(missing.length) } : null;
    },
    message: (p) => `${p.count} transaction(s) on the ledger the shop has not recorded: ${p.missing}`,
  },
  {
    id: 'settled-no-redirect', level: 'warning', grace: true,
    check(o) {
      const status = o.customer.status;
      return status?.state === 'settled' && status.redirect === undefined ? {} : null;
    },
    message: () => 'the status endpoint says settled but gives the page no redirect',
  },
  {
    id: 'page-not-testnet', level: 'alarm', grace: false,
    check(o) {
      const network = o.customer.page?.network;
      return network && network !== 'testnet' ? { network } : null;
    },
    message: (p) => `the page says ${p.network}; the harness only ever pays on the testnet`,
  },
  ...(['customer', 'shop', 'ledger'] as const).map((side): Rule => ({
    id: `${side}-unreachable`, level: 'warning', grace: true,
    check: (o) => (o[side].error ? { error: o[side].error! } : null),
    message: (p) => `the ${side} side cannot be read: ${p.error}`,
  })),
];

/** Every rule's id and level, in the order the rules run — for a UI that explains them. */
export const DEVIATION_RULES: ReadonlyArray<{ id: DeviationId; level: DeviationLevel; grace: boolean }> = RULES.map(({ id, level, grace }) => ({ id, level, grace }));

/** The deviations in force at the latest observation; empty when the sides agree. */
export function deviations(history: Observation[], quote: WatchQuote, options: DeviationOptions = {}): Deviation[] {
  if (history.length === 0) return [];
  const graceMs = (options.graceSeconds ?? 20) * 1000;
  const now = Date.parse(options.now ?? history[history.length - 1].at);
  const out: Deviation[] = [];
  for (const rule of RULES) {
    const params = rule.check(history[history.length - 1], quote);
    if (!params) continue;
    let since = history[history.length - 1].at;
    for (let i = history.length - 2; i >= 0 && rule.check(history[i], quote); i--) since = history[i].at;
    if (rule.grace && now - Date.parse(since) < graceMs) continue;
    out.push({ id: rule.id, level: rule.level, since, params, message: rule.message(params) });
  }
  return out;
}

/** The worst level in force, or `ok`. */
export function verdict(found: Deviation[]): 'ok' | DeviationLevel {
  return found.some((d) => d.level === 'alarm') ? 'alarm' : found.length ? 'warning' : 'ok';
}
