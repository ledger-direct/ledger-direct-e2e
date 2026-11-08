import { describe, expect, it } from 'vitest';
import { woocommerceSettings } from '../src/drivers/woocommerce.js';

describe('WooCommerce settings per chain', () => {
  it('writes the XRP Ledger keys and its two stablecoin switches, the expiry in minutes', () => {
    const { chain, settings } = woocommerceSettings({ chain: 'XRPL', destinationAccount: 'rMerchant', network: 'testnet', assets: ['XRP', 'USDC'], quoteExpirySeconds: 90 });
    expect(chain).toBe('XRPL');
    expect(settings).toEqual({
      enabled: 'yes',
      xrpl_quote_expiry: 2,
      xrpl_network: 'testnet',
      xrpl_testnet_destination_account: 'rMerchant',
      xrpl_is_rlusd_enabled: 'no',
      xrpl_is_usdc_enabled: 'yes',
    });
  });

  it('writes the Xahau keys with its switch and leaves the XRP Ledger keys alone', () => {
    const { chain, settings } = woocommerceSettings({ chain: 'XAHAU', destinationAccount: 'rXahau', network: 'testnet', assets: ['XAH'], quoteExpirySeconds: 300 });
    expect(chain).toBe('XAHAU');
    expect(settings).toEqual({
      enabled: 'yes',
      xrpl_quote_expiry: 5,
      xahau_enabled: 'yes',
      xahau_network: 'testnet',
      xahau_testnet_destination_account: 'rXahau',
    });
  });

  it('refuses a chain the plugin has no payment types for', () => {
    expect(() => woocommerceSettings({ chain: 'STELLAR', destinationAccount: 'G', network: 'testnet', assets: ['XLM'], quoteExpirySeconds: 300 })).toThrow(/no payment types on STELLAR/);
  });
});

describe('Xahau without its asset', () => {
  it('switches the chain off instead of enabling an unrequested asset', () => {
    const { settings } = woocommerceSettings({ chain: 'XAHAU', destinationAccount: 'rXahau', network: 'testnet', assets: [], quoteExpirySeconds: 300 });
    expect(settings.xahau_enabled).toBe('no');
  });
});
