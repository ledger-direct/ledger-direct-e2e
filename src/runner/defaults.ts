import type { Target } from '../drivers/factory.js';

/**
 * The dev shop's own receiving account, as opposed to the throwaway account a run
 * configures. Read from `LD_E2E_<TARGET>_SHOP_ACCOUNT`, or from the local wallet file's
 * `LEDGERDIRECT_TESTNET_<TARGET>_SHOP_ADDRESS` (the address only; the seed is never read
 * here). Undefined when neither is set, as in CI, where the shop is fresh every time.
 */
/**
 * The shop's own receiving account on a chain, from the environment: the XRPL
 * one under the names it always had (`LD_E2E_<TARGET>_SHOP_ACCOUNT`,
 * `LEDGERDIRECT_TESTNET_<TARGET>_SHOP_ADDRESS`), any other chain with the chain
 * in the name (`LD_E2E_<TARGET>_STELLAR_SHOP_ACCOUNT`,
 * `LEDGERDIRECT_TESTNET_<TARGET>_STELLAR_SHOP_ADDRESS`). An XRPL address must
 * never be written into a Stellar card — the plugin refuses it, and rightly so.
 */
export function defaultShopAccount(target: Target, chain = 'XRPL'): string | undefined {
  const upper = target.toUpperCase();
  const infix = chain.toUpperCase() === 'XRPL' ? '' : `_${chain.toUpperCase()}`;
  const value = process.env[`LD_E2E_${upper}${infix}_SHOP_ACCOUNT`] ?? process.env[`LEDGERDIRECT_TESTNET_${upper}${infix}_SHOP_ADDRESS`];
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export const DEFAULT_QUOTE_EXPIRY_SECONDS = 300;
