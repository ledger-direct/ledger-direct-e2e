import type { State } from '../cases/catalogue.js';

/**
 * Reads a payment page through the markup contract of `@ledger-direct/payment-ui`
 * (its `src/README.md`): `data-ld-state`, `data-ld-amount-requested` and
 * `data-ld-asset` on the root, `[data-ld-account]` and `[data-ld-tag]` by their
 * `data-value`, `data-ld-poll-url` for the status endpoint. No driver parses
 * platform ids or labels; a platform that renders the contract is readable.
 * Since 2026-09-28 all four plugins do (Shopware 1.4.2, PrestaShop 0.5.0,
 * Magento 1.1.0, WooCommerce 1.3.0); the reader for their earlier pages is gone.
 */
export interface PaymentPageFields {
  state: State;
  /** Exactly as the page states it — never recomputed. */
  amountDisplayed: string;
  /** From `data-ld-asset`; the pre-contract pages do not name it. */
  asset?: string;
  destinationAccount: string;
  paymentIdentifier: string;
  /** `data-ld-poll-url`, entity-decoded; absent when the page does not poll. */
  pollUrl?: string;
}

const STATES: readonly State[] = ['waiting', 'partial', 'wrong_asset', 'settled', 'expired'];

export function readPaymentPage(html: string): PaymentPageFields | undefined {
  const state = attr(html, 'data-ld-state');
  if (!state || !isState(state)) return undefined;
  return readContractPage(html, state);
}

function readContractPage(html: string, state: State): PaymentPageFields | undefined {
  const amount = attr(html, 'data-ld-amount-requested') ?? textOf(element(html, 'data-ld-amount'));
  const account = valueOf(element(html, 'data-ld-account'));
  const tag = valueOf(element(html, 'data-ld-tag'));
  if (!amount || !account || !tag || !/^\d+$/.test(tag)) return undefined;
  const pollUrl = attr(html, 'data-ld-poll-url');
  return {
    state,
    amountDisplayed: amount,
    asset: attr(html, 'data-ld-asset') || undefined,
    destinationAccount: account,
    paymentIdentifier: tag,
    ...(pollUrl ? { pollUrl } : {}),
  };
}

/** The value of a root attribute, entity-decoded; undefined when absent. */
function attr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]).trim() : undefined;
}

/** The first start tag carrying the boolean attribute `name`, with its text up to the next tag. */
function element(html: string, name: string): { tag: string; text: string } | undefined {
  const m = html.match(new RegExp(`<[a-zA-Z][^>]*\\s${name}(?=[\\s>=])[^>]*>([^<]*)`));
  return m ? { tag: m[0], text: m[1] } : undefined;
}

/** `data-value` if the element has one, otherwise its text. */
function valueOf(el: { tag: string; text: string } | undefined): string | undefined {
  if (!el) return undefined;
  const value = el.tag.match(/\sdata-value="([^"]*)"/);
  const out = decode(value ? value[1] : el.text).trim();
  return out || undefined;
}

function textOf(el: { tag: string; text: string } | undefined): string | undefined {
  const out = el ? decode(el.text).trim() : '';
  return out || undefined;
}

function isState(value: string): value is State {
  return (STATES as readonly string[]).includes(value);
}

function decode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
