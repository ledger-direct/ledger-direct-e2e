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
  assets: Array<'XRP' | 'RLUSD' | 'USDC'>;
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
  asset: 'XRP' | 'RLUSD' | 'USDC';
  destinationAccount: string;
  destinationTag: number;
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
  placeOrder(asset: PaymentPageView['asset'], amountInShopCurrency: string): Promise<PlacedOrder>;
  paymentPage(order: PlacedOrder): Promise<PaymentPageView>;
  status(order: PlacedOrder): Promise<StatusPayload>;
  refresh(order: PlacedOrder): Promise<void>;
  close(order: PlacedOrder): Promise<void>;
  safetyNet(): Promise<void>;
  /** Node requests observed since the last call — how PS-08 is proven. */
  nodeRequests(): Promise<number>;
}
