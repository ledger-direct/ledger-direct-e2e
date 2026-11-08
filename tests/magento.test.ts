import { describe, expect, it } from 'vitest';
import { magentoSettings } from '../src/drivers/magento.js';

describe('Magento configuration per chain', () => {
  it('writes the XRP Ledger into the shared group and switches its three methods', () => {
    const { chain, settings } = magentoSettings({ chain: 'XRPL', destinationAccount: 'rMerchant', network: 'testnet', assets: ['XRP', 'USDC'], quoteExpirySeconds: 120 });
    expect(chain).toBe('XRPL');
    expect(settings).toEqual({
      'payment/ledger_direct/use_testnet': 1,
      'payment/ledger_direct/xrpl_testnet_account': 'rMerchant',
      'payment/ledger_direct/quote_expiry': 120,
      'payment/xrp_payment/active': 1,
      'payment/xrpl_rlusd_payment/active': 0,
      'payment/xrpl_usdc_payment/active': 1,
    });
  });

  it('writes Xahau into its own group and leaves the XRP Ledger methods alone', () => {
    const { chain, settings } = magentoSettings({ chain: 'XAHAU', destinationAccount: 'rXahau', network: 'testnet', assets: ['XAH'], quoteExpirySeconds: 300 });
    expect(chain).toBe('XAHAU');
    expect(settings).toEqual({
      'payment/ledger_direct_xahau/use_testnet': 1,
      'payment/ledger_direct_xahau/xahau_testnet_account': 'rXahau',
      'payment/ledger_direct/quote_expiry': 300,
      'payment/xahau_xah_payment/active': 1,
    });
  });

  it('refuses a chain the module has no methods for', () => {
    expect(() => magentoSettings({ chain: 'STELLAR', destinationAccount: 'G', network: 'testnet', assets: ['XLM'], quoteExpirySeconds: 300 })).toThrow(/no payment methods on STELLAR/);
  });
});
