/**
 * The assets LedgerDirect accepts, and how they appear on the XRP Ledger.
 *
 * Testnet only. The issuer addresses are the testnet entries of the core's
 * StablecoinRegistry (hardcastle/ledger-direct-core, Xrpl/StablecoinRegistry.php);
 * they are copied here because this harness signs payments *to* shops that
 * quote in these tokens, and a payment from another issuer is exactly the
 * wrong-asset case (PS-04) the catalogue wants to provoke on purpose.
 *
 * Mainnet is deliberately absent: this tool moves test money only.
 */
export type Asset = 'XRP' | 'RLUSD' | 'USDC';

export const ASSETS: readonly Asset[] = ['XRP', 'RLUSD', 'USDC'];

export interface IssuedAsset {
  readonly currency: string; // 40-hex currency code as the ledger encodes it
  readonly issuer: string;
}

export const TESTNET_ISSUED: Readonly<Record<Exclude<Asset, 'XRP'>, IssuedAsset>> = {
  RLUSD: { currency: '524C555344000000000000000000000000000000', issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' },
  USDC: { currency: '5553444300000000000000000000000000000000', issuer: 'rHuGNhqTG32mfmAvWA8hUyWRLV3tCSwKQt' },
};

export const TESTNET_WS = 'wss://s.altnet.rippletest.net:51233';
export const TESTNET_FAUCET = 'https://faucet.altnet.rippletest.net/accounts';
export const TESTNET_EXPLORER_TX = 'https://testnet.xrpl.org/transactions/';

export function isAsset(value: string): value is Asset {
  return (ASSETS as readonly string[]).includes(value);
}

export function assetFromCurrency(currency: string): Asset | null {
  if (currency === 'XRP') return 'XRP';
  for (const [name, issued] of Object.entries(TESTNET_ISSUED)) {
    if (issued.currency === currency) return name as Asset;
  }
  return null;
}
