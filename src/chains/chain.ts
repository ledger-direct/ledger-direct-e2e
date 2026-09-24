/**
 * What a chain has to offer the harness — the operations the case catalogue
 * needs, and nothing chain-specific in their names.
 *
 * The catalogue talks about a receiving account, a payment identifier that
 * ties a payment to an order, a native asset and issued assets, and a
 * transaction hash. On XRPL those are an r-address, the destination tag,
 * XRP and IssuedCurrencyAmounts; on Stellar a G-address, the MEMO_ID (or a
 * muxed address), XLM and classic assets. The cases never know which.
 */
export type ChainId = 'XRPL' | 'STELLAR';

export interface ChainAsset {
  /** As the shop names it: XRP, RLUSD, USDC, XLM, EURC … */
  code: string;
  native: boolean;
  /** Issuer account for an issued asset; absent for the native one. */
  issuer?: string;
}

export interface Balances {
  address: string;
  native: string;
  tokens: Record<string, string>;
  trustlines: string[];
}

export interface PaymentRequest {
  seed: string;
  to: string;
  /** Destination tag (XRPL) or memo id (Stellar), as the payment page shows it. */
  identifier?: string;
  amount: string;
  asset: string;
  partial?: boolean;
}

export interface PaymentResult {
  hash: string;
  result: string;
  validated: boolean;
  delivered: string | null;
  explorer: string;
  from: string;
}

export interface FreshAccount {
  address: string;
  seed: string;
  trustlines: Record<string, string>;
}

export interface Ledger {
  readonly chain: ChainId;
  readonly nativeAsset: string;
  /** The assets this chain's testnet setup knows, native first. */
  assets(): ChainAsset[];
  /** A brand-new funded testnet account, optionally able to receive the issued assets. */
  createFresh(options?: { trustlines?: boolean }): Promise<FreshAccount>;
  /** Faucet top-up of an existing account. */
  fund(address: string): Promise<{ address: string; amount: string }>;
  balances(address: string): Promise<Balances>;
  pay(request: PaymentRequest): Promise<PaymentResult>;
  explorerUrl(hash: string): string;
  /** Returns the seed's public address without touching the network. */
  addressOf(seed: string): string;
  close(): Promise<void>;
}
