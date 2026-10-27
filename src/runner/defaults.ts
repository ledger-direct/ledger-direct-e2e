import type { Target } from '../drivers/factory.js';

/**
 * The variables naming the dev shop's own receiving account on a chain, as opposed to
 * the throwaway account a run configures: the XRPL one under the names it always had
 * (`LD_E2E_<TARGET>_SHOP_ACCOUNT`, then the wallet file's
 * `LEDGERDIRECT_TESTNET_<TARGET>_SHOP_ADDRESS`), any other chain with the chain in the
 * name (`LD_E2E_<TARGET>_STELLAR_SHOP_ACCOUNT`, `LEDGERDIRECT_TESTNET_<TARGET>_STELLAR_SHOP_ADDRESS`).
 * Addresses only; a seed is never read here.
 */
export function shopAccountVariables(target: string, chain = 'XRPL'): [string, string] {
  const upper = target.toUpperCase();
  const infix = chain.toUpperCase() === 'XRPL' ? '' : `_${chain.toUpperCase()}`;
  return [`LD_E2E_${upper}${infix}_SHOP_ACCOUNT`, `LEDGERDIRECT_TESTNET_${upper}${infix}_SHOP_ADDRESS`];
}

/**
 * The shop's own receiving account on a chain, from the variables above. Undefined when
 * neither is set, as in CI, where the shop is fresh every time. An XRPL address must
 * never be written into a Stellar card — the plugin refuses it, and rightly so; callers
 * check the form with `isAccountOf()` before they configure.
 */
export function defaultShopAccount(target: Target, chain = 'XRPL'): string | undefined {
  const [harness, walletFile] = shopAccountVariables(target, chain);
  const value = process.env[harness] ?? process.env[walletFile];
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export const DEFAULT_QUOTE_EXPIRY_SECONDS = 300;
