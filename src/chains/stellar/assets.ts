/**
 * Stellar testnet: endpoints and the assets the harness can handle today.
 *
 * Issued assets are deliberately not listed yet. The core's
 * `Stellar\StablecoinRegistry` (USDC, EURC; USDT0 mainnet only) is the single
 * source for issuer addresses, and copying values before it exists would be
 * exactly the hand-transcription INVARIANTS.md forbids. Until then the
 * harness issues its own test asset for the wrong-asset case — see
 * `issueTestAsset()` in ledger.ts.
 */
export const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
export const TESTNET_FRIENDBOT = 'https://friendbot.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const TESTNET_EXPLORER_TX = 'https://stellar.expert/explorer/testnet/tx/';

/** Classic assets known on the testnet: filled from the core registry once it ships. */
export const TESTNET_ISSUED: Readonly<Record<string, { code: string; issuer: string }>> = {};

export const NATIVE = 'XLM';
