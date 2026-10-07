import { describe, expect, it } from 'vitest';
import { readPaymentPage } from '../src/drivers/page.js';

// The contract as @ledger-direct/payment-ui renders it in test/fixture/index.html.
const contract = `
<div class="ld-page" data-ld-page
     data-ld-state="waiting"
     data-ld-poll-url="/status?state=waiting&amp;then=settled"
     data-ld-asset="XRP"
     data-ld-network="testnet"
     data-ld-amount-requested="0.74791"
     data-ld-amount-drops="747910">
  <p class="ld-eyebrow" data-ld-amount-label><span data-ld-label="due">Amount due</span></p>
  <span class="ld-amount-value" data-ld-amount>0.74791</span>
  <span class="ld-field-value" data-ld-account data-value="rMW6jyfsGyB5kPoYWVV4z1h9DA5KmEGPYq">rMW6jy…GPYq</span>
  <span class="ld-field-value" data-ld-tag data-value="795186163">795186163</span>
</div>`;

// Shopware 1.4.0: the contract without data-ld-amount-requested, the legacy ids still alongside.
const shopware140 = `
<div class="ld-page" data-ld-page
     data-ld-state="waiting"
     data-ld-poll-url="http://localhost/ledger-direct/payment/check/0123?deepLinkCode=abc"
     data-ld-asset="RLUSD"
     data-ld-currency="524C555344000000000000000000000000000000" data-ld-issuer="rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV">
  <input id="token-amount" type="hidden" value="9.99">
  <span class="ld-amount-value" data-ld-amount>1.01</span>
  <span class="ld-field-value" id="destination-account" data-ld-account data-value="rsRbTicxbBsS83JqmAizH9vggETCGA627f">rsRbTicxbBsS83JqmAizH9vggETCGA627f</span>
  <span class="ld-field-value" id="destination-tag" data-ld-tag data-value="4264383458">4264383458</span>
</div>`;

describe('readPaymentPage', () => {
  it('reads the contract: root attributes, data-value on account and tag', () => {
    expect(readPaymentPage(contract)).toEqual({
      state: 'waiting',
      amountDisplayed: '0.74791',
      asset: 'XRP',
      destinationAccount: 'rMW6jyfsGyB5kPoYWVV4z1h9DA5KmEGPYq',
      paymentIdentifier: '795186163',
      pollUrl: '/status?state=waiting&then=settled',
    });
  });

  it('falls back to [data-ld-amount] when the root has no data-ld-amount-requested, never to a platform id', () => {
    const page = readPaymentPage(shopware140);
    expect(page?.amountDisplayed).toBe('1.01');
    expect(page?.asset).toBe('RLUSD');
    expect(page?.destinationAccount).toBe('rsRbTicxbBsS83JqmAizH9vggETCGA627f');
    expect(page?.paymentIdentifier).toBe('4264383458');
    expect(page?.pollUrl).toBe('http://localhost/ledger-direct/payment/check/0123?deepLinkCode=abc');
  });

  it('does not mistake data-ld-amount-label or data-ld-amount-drops for the amount element', () => {
    const noAmountValue = contract.replace('data-ld-amount-requested="0.74791"', '').replace('<span class="ld-amount-value" data-ld-amount>0.74791</span>', '');
    expect(readPaymentPage(noAmountValue)).toBeUndefined();
  });

  it('does not fall back to platform ids any more', () => {
    const legacyOnly = `<div data-ld-state="waiting"><input id="xrp-amount" type="hidden" value="1"><div id="destination-account" data-value="rX"></div><div id="destination-tag" data-value="7"></div></div>`;
    expect(readPaymentPage(legacyOnly)).toBeUndefined();
  });

  it('refuses a page without a known state or without the fields', () => {
    expect(readPaymentPage('<div data-ld-state="paid"></div>')).toBeUndefined();
    expect(readPaymentPage('<div>no page here</div>')).toBeUndefined();
    expect(readPaymentPage('<div data-ld-state="waiting"><span data-ld-amount>1</span></div>')).toBeUndefined();
  });
});
