import { TESTNET_EXPLORER_TX, TESTNET_FAUCET, TESTNET_ISSUED, TESTNET_WS, type IssuedAsset } from './assets.js';

/**
 * What tells one XRPL-protocol chain from another: its nodes, its faucet, its
 * explorer, its native asset and the issued assets the shops accept on it. The
 * XRP Ledger is the default everywhere; Xahau is the same code against its own
 * network — the same shape the core takes (`LedgerDirect::create(…, chain)`).
 */
export interface XrplProfile {
  readonly chain: 'XRPL' | 'XAHAU';
  readonly nativeAsset: string;
  readonly ws: string;
  readonly faucet: string;
  readonly explorerTx: string;
  /** The issued assets a shop may quote in on this chain, by code. */
  readonly issued: Readonly<Record<string, IssuedAsset>>;
  /**
   * Where a run's fresh receiving account gets its first balance: the faucet, or a
   * payment from the treasury for a faucet that refuses a second request for minutes.
   */
  readonly freshAccounts: 'faucet' | 'treasury';
  /** With `treasury`: what the treasury sends a fresh account, in drops. Reserve, fees and room. */
  readonly freshAccountDrops: string;
}

export const XRPL: XrplProfile = {
  chain: 'XRPL',
  nativeAsset: 'XRP',
  ws: TESTNET_WS,
  faucet: TESTNET_FAUCET,
  explorerTx: TESTNET_EXPLORER_TX,
  issued: TESTNET_ISSUED,
  freshAccounts: 'faucet',
  freshAccountDrops: '0',
};

/**
 * Xahau's testnet (network id 21338). No issued assets: the core's catalogue
 * lists XAH alone, so PS-04 has nothing to pay in and is skipped. The faucet
 * hands out 1 000 XAH, and every further request from the same address waits
 * longer (a minute, then four): good for the treasury, not for the fresh
 * account of every run — the treasury opens that one itself, with 20 XAH
 * (reserve 1 XAH, fees, room; the sweep brings all but the reserve back).
 * The faucet's seeds are secp256k1 (see `walletFromSeed`).
 */
export const XAHAU: XrplProfile = {
  chain: 'XAHAU',
  nativeAsset: 'XAH',
  ws: 'wss://xahau-test.net',
  faucet: 'https://xahau-test.net/accounts',
  explorerTx: 'https://explorer.xahau-test.net/tx/',
  issued: {},
  freshAccounts: 'treasury',
  freshAccountDrops: '20000000',
};

/** The asset code a ledger currency stands for on this chain, or null for one the shops do not know. */
export function assetFromCurrencyOn(profile: XrplProfile, currency: string): string | null {
  if (currency === 'XRP') return profile.nativeAsset;
  for (const [code, issued] of Object.entries(profile.issued)) {
    if (issued.currency === currency) return code;
  }
  return null;
}
