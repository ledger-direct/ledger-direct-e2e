import type { Target } from '../drivers/factory.js';

/**
 * The dev shop's own receiving account, as opposed to the throwaway account a run
 * configures. Read from `LD_E2E_<TARGET>_SHOP_ACCOUNT`, or from the local wallet file's
 * `LEDGERDIRECT_TESTNET_<TARGET>_SHOP_ADDRESS` (the address only; the seed is never read
 * here). Undefined when neither is set, as in CI, where the shop is fresh every time.
 */
export function defaultShopAccount(target: Target): string | undefined {
  const upper = target.toUpperCase();
  const value = process.env[`LD_E2E_${upper}_SHOP_ACCOUNT`] ?? process.env[`LEDGERDIRECT_TESTNET_${upper}_SHOP_ADDRESS`];
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export const DEFAULT_QUOTE_EXPIRY_SECONDS = 300;
