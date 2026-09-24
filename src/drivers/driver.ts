import type { State } from '../cases/catalogue.js';

/**
 * What a plugin has to offer the harness — small on purpose, so a fifth
 * platform is an afternoon. Everything ledger-side is shared; only placing an
 * order and reading what the shop shows differ per platform.
 *
 * Implementations: prestashop.ts, shopware.ts, woocommerce.ts, magento.ts —
 * none written yet. See Handover-E2E-Teststrategie.md §3 for the mapping.
 */
export interface ShopConfig {
  destinationAccount: string;
  network: 'testnet';
  assets: string[];
  quoteExpirySeconds: number;
}

export interface PlacedOrder {
  id: string;
  reference: string;
  /** The per-order secret the platform uses instead of a login (secure_key, deepLinkCode, …). */
  secret: string;
}

export interface PaymentPageView {
  state: State;
  /** Exactly as displayed — the harness never recomputes an amount. */
  amountDisplayed: string;
  asset: string;
  destinationAccount: string;
  /** Destination tag (XRPL) or memo id (Stellar) as shown, as a decimal string. */
  paymentIdentifier: string;
  statusUrl: string;
}

export interface StatusPayload {
  schema_version: number;
  state: State;
  base_asset: string;
  amount_requested: unknown;
  amount_paid: unknown;
  shortfall: unknown;
  seconds_left: number | null;
  redirect?: string;
}

export interface Driver {
  readonly name: 'prestashop' | 'shopware' | 'woocommerce' | 'magento';
  configure(config: ShopConfig): Promise<void>;
  placeOrder(asset: string, amountInShopCurrency: string): Promise<PlacedOrder>;
  paymentPage(order: PlacedOrder): Promise<PaymentPageView>;
  status(order: PlacedOrder): Promise<StatusPayload>;
  /** The raw answer of the status endpoint — for the cases that expect a refusal (PS-07). */
  statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }>;
  /** A well-formed order id that does not exist on this platform — for PS-07. */
  unknownOrderId(): string;
  /** The raw answer of the payment page — 200 for the owner, a redirect for anyone else. */
  pageResponse(order: PlacedOrder): Promise<{ status: number }>;
  refresh(order: PlacedOrder): Promise<void>;
  close(order: PlacedOrder): Promise<void>;
  /** Whatever settles orders without a browser: cron URL, scheduled task, WP-cron. Returns what it answered. */
  safetyNet(): Promise<unknown>;
  /**
   * A value that changes exactly when the platform synced with the node — how PS-08 is
   * proven. Null when the platform cannot expose it; the case then falls back to timing.
   */
  nodeRequests(): Promise<number | null>;
}
