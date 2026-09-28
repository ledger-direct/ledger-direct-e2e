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

// WooCommerce and Magento before their payment-page rewrite.
const hiddenInputs = `
<div class="ledger-direct" data-ld-state="expired">
  <input id="xrp-amount"
         type="hidden"
         name="xrp-amount"
         value="0.85635">
  <input id="token-amount" type="hidden" name="token-amount" value="">
  <div id="destination-account" class="" data-value="rJdfC6X2L6tTURK7h214Q3MW3a4RrbzCa8">rJdf…</div>
  <div id="destination-tag" class="" data-value="3050405045">3050405045</div>
</div>`;

// PrestaShop before its payment-page rewrite.
const definitionList = `
<section data-ld-state="partial" data-ld-poll-url="http://localhost:8080/module/ledgerdirect/poll?id_order=12&amp;key=k">
  <dl>
    <dt>Amount</dt>
    <dd>
      <code>2.5</code> USDC
    </dd>
    <dt>Destination account</dt>
    <dd><code>rGT9kXUuutRVGrUyRciupE8VbRWqL4fUPo</code></dd>
    <dt>Destination tag</dt>
    <dd><code>77</code></dd>
  </dl>
</section>`;

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

  it('still reads the hidden-input pages of WooCommerce and Magento', () => {
    expect(readPaymentPage(hiddenInputs)).toEqual({
      state: 'expired',
      amountDisplayed: '0.85635',
      destinationAccount: 'rJdfC6X2L6tTURK7h214Q3MW3a4RrbzCa8',
      paymentIdentifier: '3050405045',
    });
  });

  it("still reads PrestaShop's definition list, asset included", () => {
    expect(readPaymentPage(definitionList)).toEqual({
      state: 'partial',
      amountDisplayed: '2.5',
      asset: 'USDC',
      destinationAccount: 'rGT9kXUuutRVGrUyRciupE8VbRWqL4fUPo',
      paymentIdentifier: '77',
      pollUrl: 'http://localhost:8080/module/ledgerdirect/poll?id_order=12&key=k',
    });
  });

  it('refuses a page without a known state or without the fields', () => {
    expect(readPaymentPage('<div data-ld-state="paid"></div>')).toBeUndefined();
    expect(readPaymentPage('<div>no page here</div>')).toBeUndefined();
    expect(readPaymentPage('<div data-ld-state="waiting"><span data-ld-amount>1</span></div>')).toBeUndefined();
  });
});
