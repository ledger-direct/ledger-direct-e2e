/**
 * What a chain has to offer the harness — the operations the case catalogue
 * needs, and nothing chain-specific in their names.
 *
 * The catalogue talks about a receiving account, a payment identifier that
 * ties a payment to an order, a native asset and issued assets, and a
 * transaction hash. On XRPL those are an r-address, the destination tag,
 * XRP and IssuedCurrencyAmounts; on Stellar a G-address, the MEMO_ID (or a
 * muxed address), XLM and classic assets. The cases never know which.
 *
 * Interledger is the odd one: there is no ledger, only two wallets that speak Open
 * Payments. The receiving account is the merchant's wallet address, a payment goes to
 * an incoming payment's URL, and the payer is an agent with a grant of the wallet's
 * owner (chains/interledger/ledger.ts).
 */
export type ChainId = 'XRPL' | 'STELLAR' | 'XAHAU' | 'INTERLEDGER';

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
  /** The ledger that holds the transaction, when the chain says (XRPL, Xahau: ledger index; Stellar: ledger sequence). */
  ledgerIndex?: number;
  /**
   * The payer's side took the payment and nobody could confirm that it arrived: neither a
   * success nor a failure on record. It may still arrive, so sending it again may pay twice.
   */
  unconfirmed?: boolean;
}

/** Why a payment is not validated: it failed, or it was taken and never confirmed. The two call for different next steps. */
export function describeUnvalidated(result: PaymentResult): string {
  return result.unconfirmed
    ? `payment not confirmed: ${result.result}. It may still arrive: look at what the order received before paying again`
    : `payment failed: ${result.result}`;
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

/** What a sweep sent back to the treasury: the native asset and each issued asset, as decimal strings. */
export interface SweepResult {
  native: string;
  tokens: Record<string, string>;
  hashes: string[];
  /** Returns that failed; the others still went through. */
  failed: string[];
}

export interface FreshAccount {
  address: string;
  seed: string;
  trustlines: Record<string, string>;
}

export interface AccountSetResult {
  hash: string;
  /** tesSUCCESS when the flag is set. */
  result: string;
  explorer: string;
}

/** Where the payer's permission stands on a chain that needs one (Interledger: the owner's grant). */
export interface Authorization {
  approved: boolean;
  /** Where the owner decides while it waits; empty once approved. For the owner's eyes, not for a report. */
  approveAt: string[];
  /** What was asked for, in words: "up to 10 XRP from https://…". */
  asks: string;
}

/** An issued asset a run does without, with the sentence that says why (Ledger.withdrawMissingIssuers). */
export interface WithdrawnAsset {
  code: string;
  issuer: string;
  reason: string;
}

export interface Ledger {
  readonly chain: ChainId;
  readonly nativeAsset: string;
  /** The assets this chain's testnet setup knows, native first. */
  assets(): ChainAsset[];
  /**
   * False on a chain where the harness cannot make a receiving account: the merchant's
   * wallet gives it out (Interledger). A run then uses the shop's own account. Absent: true.
   */
  readonly makesAccounts?: boolean;
  /**
   * True where the account a payment page shows is made for the quote and lapses with it
   * (Interledger: an incoming payment's URL). A refreshed quote then has a new account under
   * the same identifier, and what the old one received is not carried over. Absent: false.
   */
  readonly accountPerQuote?: boolean;
  /**
   * Whatever the payer needs before its first payment, asked for once: on Interledger the
   * grant of the paying wallet's owner, who decides in their wallet while this waits.
   * `announce` gets the line that tells them where. Absent on a chain where the seed is enough.
   */
  authorize?(seed: string, announce: (line: string) => void): Promise<void>;
  /**
   * The same without waiting: asks if nobody has yet, and says at once whether the owner has
   * approved and where they decide. For a caller that cannot hold a request open for minutes
   * (an MCP tool); pay() itself waits.
   */
  authorization?(seed: string): Promise<Authorization>;
  /**
   * Takes the issued assets whose issuer does not exist out of this ledger for the rest of
   * the process, but only within a few days after a testnet reset (chains/xrpl/reset.ts):
   * assets(), createFresh() and the cases that need issued assets then do without them.
   * Returns what was withdrawn and why. Optional: a chain without issuers has nothing to check.
   */
  withdrawMissingIssuers?(): Promise<WithdrawnAsset[]>;
  /** A brand-new funded testnet account, optionally able to receive the issued assets. */
  createFresh(options?: { trustlines?: boolean }): Promise<FreshAccount>;
  /** Faucet top-up of an existing account. */
  fund(address: string): Promise<{ address: string; amount: string }>;
  balances(address: string): Promise<Balances>;
  pay(request: PaymentRequest): Promise<PaymentResult>;
  /**
   * Sends everything above the reserve from a run's throwaway account (its seed) back to
   * `to`, the treasury. Optional: a chain without it leaves the account as it is.
   */
  sweep?(seed: string, to: string): Promise<SweepResult>;
  /**
   * A valid address nobody has funded: an account that does not exist on the ledger yet
   * (PS-14). Its key is generated and thrown away. Optional.
   */
  unfundedAddress?(): string;
  /**
   * Sets deposit authorization on the account of `seed` (PS-15): from then on only
   * pre-authorized senders can pay it. XRPL protocol only; not a payment, not charged.
   */
  requireDepositAuth?(seed: string): Promise<AccountSetResult>;
  /** Payments that arrived at `address`, newest first; with `identifier`, only those carrying it. */
  incoming(address: string, options?: { identifier?: string; limit?: number }): Promise<IncomingPayment[]>;
  explorerUrl(hash: string): string;
  /** Returns the seed's public address without touching the network. */
  addressOf(seed: string): string;
  close(): Promise<void>;
}
