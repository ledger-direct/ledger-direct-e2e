import { describe, expect, it } from 'vitest';
import { defaultShopAccount } from '../src/runner/defaults.js';
import { isolateEnv } from './env.js';

describe('defaultShopAccount', () => {
  isolateEnv(['LD_E2E_WOOCOMMERCE_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_WOOCOMMERCE_SHOP_ADDRESS', 'LD_E2E_MAGENTO_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_MAGENTO_SHOP_ADDRESS']);

  it('is undefined when nothing names the shop account, as in CI', () => {
    expect(defaultShopAccount('magento')).toBeUndefined();
  });

  it('reads the wallet file variable', () => {
    process.env.LEDGERDIRECT_TESTNET_WOOCOMMERCE_SHOP_ADDRESS = 'rShopWallet';
    expect(defaultShopAccount('woocommerce')).toBe('rShopWallet');
  });

  it('prefers the harness variable over the wallet file', () => {
    process.env.LEDGERDIRECT_TESTNET_WOOCOMMERCE_SHOP_ADDRESS = 'rShopWallet';
    process.env.LD_E2E_WOOCOMMERCE_SHOP_ACCOUNT = 'rOverride';
    expect(defaultShopAccount('woocommerce')).toBe('rOverride');
  });

  it('treats an empty value as unset', () => {
    process.env.LEDGERDIRECT_TESTNET_MAGENTO_SHOP_ADDRESS = '  ';
    expect(defaultShopAccount('magento')).toBeUndefined();
  });
});
