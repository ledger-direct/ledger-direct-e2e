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
  /** Chain-specific result code (tesSUCCESS, tecPATH_PARTIAL, success, failed …). */
  result: string;
  /** True only when the payment succeeded on the ledger — a recorded failure is not validated here. */
  validated: boolean;
  delivered: string | null;
  explorer: string;
  from: string;
}

/**
 * A payment that arrived at an account, as the ledger recorded it — what a merchant
 * would see in an explorer. The lab's ledger column and the deviation rules read it.
 */
export interface IncomingPayment {
  hash: string;
  /** As the harness names the asset (XRP, RLUSD, USDC, XLM, EURC …); the decoded code when it does not know it. */
  asset: string;
  /** Issued assets only. */
  issuer?: string;
  /** What arrived, as a decimal string in the asset's units: the delivered amount, not the sent maximum. */
  amount: string;
  /** Destination tag (XRPL), memo or muxed id (Stellar), as a decimal string or the memo text. */
  identifier?: string;
  /** How the identifier travelled: `tag` (XRPL), `memo_id`, `memo_text` or `muxed` (Stellar). */
  identifierKind?: 'tag' | 'memo_id' | 'memo_text' | 'muxed';
  from: string;
  /** Chain result code (tesSUCCESS, tecPATH_PARTIAL, success, failed …). */
  result: string;
  /** True only for a successful payment in a closed ledger. */
  validated: boolean;
  /** When the ledger closed it, ISO 8601. */
  at?: string;
  explorer: string;
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
  /** Payments that arrived at `address`, newest first; with `identifier`, only those carrying it. */
  incoming(address: string, options?: { identifier?: string; limit?: number }): Promise<IncomingPayment[]>;
  explorerUrl(hash: string): string;
  /** Returns the seed's public address without touching the network. */
  addressOf(seed: string): string;
  close(): Promise<void>;
}
