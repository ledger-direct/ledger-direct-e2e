import { halfOf } from './amounts.js';
import type { ChainId, IncomingPayment, Ledger, PaymentResult } from './chains/chain.js';
import { ledgerFor, treasurySeedVariable } from './chains/index.js';
import { requireSeed } from './config.js';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, StatusPayload } from './drivers/driver.js';
import { createDriver } from './drivers/factory.js';
import { readPlatformState, type PlatformState } from './drivers/platform.js';
import { statusValue } from './runner/cases.js';

/**
 * Orders a person or an agent places in one process, and paying them — the kernel behind the
 * MCP shop tools and the lab. One driver per target (drivers keep per-order secrets in memory),
 * the orders of this process, and payments of exactly what a page shows, from the chain
 * treasury, through the process's spend guard (every ledger from ledgerFor() is guarded).
 */
export interface SessionOrder {
  /** The key this session knows the order by: the platform's order id, prefixed with the target if two shops share an id. */
  key: string;
  order: PlacedOrder;
  target: string;
  /** The asset the order was quoted in. */
  asset: string;
  chain: ChainId;
  placedAt: string;
}

/** What to send: the displayed amount, half of it, what is still due, or an exact decimal. */
export type PayAmount = 'displayed' | 'half' | 'shortfall' | { exact: string };

export interface PayOptions {
  amount?: PayAmount;
  /** Another asset than quoted — how the wrong-asset case is produced on purpose. */
  asset?: string;
  /** Overrides the chain the order was placed for. */
  chain?: ChainId;
}

export interface SessionPayment extends PaymentResult {
  paid: string;
  asset: string;
  to: string;
  identifier: string;
}

export interface SessionDeps {
  /** Builds a driver for a target; createDriver() reading LD_E2E_<TARGET>_* by default. */
  driver?: (target: string) => { driver: Driver; baseUrl: string };
  /** Hands out a (guarded) ledger; ledgerFor() by default. */
  ledger?: (chain: ChainId) => Ledger;
  /** The payer seed for a chain; the treasury from the environment by default. */
  payerSeed?: (chain: ChainId) => string;
}

export class ShopSession {
  private readonly shops = new Map<string, { driver: Driver; baseUrl: string }>();
  private readonly orders = new Map<string, SessionOrder>();
  private readonly makeDriver: (target: string) => { driver: Driver; baseUrl: string };
  private readonly makeLedger: (chain: ChainId) => Ledger;
  private readonly payerSeed: (chain: ChainId) => string;

  constructor(deps: SessionDeps = {}) {
    this.makeDriver = deps.driver ?? ((target) => createDriver(target));
    this.makeLedger = deps.ledger ?? ((chain) => ledgerFor(chain));
    this.payerSeed = deps.payerSeed ?? ((chain) => requireSeed(treasurySeedVariable(chain)));
  }

  shop(target: string): { driver: Driver; baseUrl: string } {
    let s = this.shops.get(target);
    if (!s) this.shops.set(target, (s = this.makeDriver(target)));
    return s;
  }

  driver(target: string): Driver {
    return this.shop(target).driver;
  }

  findProducts(target: string, query: string): Promise<Product[]> {
    return this.driver(target).findProducts(query);
  }

  async placeOrder(target: string, asset: string, options: OrderOptions & { chain?: ChainId } = {}): Promise<{ entry: SessionOrder; page: PaymentPageView }> {
    const d = this.driver(target);
    const order = await d.placeOrder(asset, { productId: options.productId, quantity: options.quantity });
    const page = await d.paymentPage(order);
    const clash = this.orders.get(order.id);
    const key = clash && clash.target !== target ? `${target}:${order.id}` : order.id;
    const entry: SessionOrder = { key, order, target, asset, chain: options.chain ?? 'XRPL', placedAt: new Date().toISOString() };
    this.orders.set(key, entry);
    return { entry, page };
  }

  get(key: string): SessionOrder {
    const entry = this.orders.get(key);
    if (!entry) throw new Error(`order ${key} was not placed in this session; place it first`);
    return entry;
  }

  list(): SessionOrder[] {
    return [...this.orders.values()];
  }

  page(key: string): Promise<PaymentPageView> {
    const e = this.get(key);
    return this.driver(e.target).paymentPage(e.order);
  }

  /** The page's HTTP status: 200 while it waits, a redirect once the order is closed. */
  pageResponse(key: string): Promise<{ status: number }> {
    const e = this.get(key);
    return this.driver(e.target).pageResponse(e.order);
  }

  status(key: string): Promise<StatusPayload> {
    const e = this.get(key);
    return this.driver(e.target).status(e.order);
  }

  platformState(key: string): Promise<PlatformState | null> {
    const e = this.get(key);
    return readPlatformState(this.driver(e.target), e.order);
  }

  recordedHashes(key: string, page: Pick<PaymentPageView, 'destinationAccount' | 'paymentIdentifier'>): Promise<string[]> {
    return this.driver(this.get(key).target).recordedHashes(page.destinationAccount, page.paymentIdentifier);
  }

  /** Reads the page and pays what it asks for (or half, or the shortfall, or another asset) from the chain treasury. */
  async payOrder(key: string, options: PayOptions = {}): Promise<SessionPayment> {
    const e = this.get(key);
    const page = await this.driver(e.target).paymentPage(e.order);
    const amount = await this.amountFor(key, page, options.amount ?? 'displayed');
    const asset = options.asset ?? page.asset;
    const result = await this.withLedger(options.chain ?? e.chain, (ledger) => ledger.pay({
      seed: this.payerSeed(ledger.chain),
      to: page.destinationAccount,
      identifier: page.paymentIdentifier,
      amount,
      asset,
    }));
    return { ...result, paid: `${amount} ${asset}`, asset, to: page.destinationAccount, identifier: page.paymentIdentifier };
  }

  /** What arrived on the ledger for this order: the page's account, filtered by its identifier. */
  incoming(key: string, page: Pick<PaymentPageView, 'destinationAccount' | 'paymentIdentifier'>, chain?: ChainId): Promise<IncomingPayment[]> {
    return this.withLedger(chain ?? this.get(key).chain, (ledger) => ledger.incoming(page.destinationAccount, { identifier: page.paymentIdentifier }));
  }

  async withLedger<T>(chain: ChainId, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    const ledger = this.makeLedger(chain);
    try {
      return await fn(ledger);
    } finally {
      await ledger.close();
    }
  }

  private async amountFor(key: string, page: PaymentPageView, amount: PayAmount): Promise<string> {
    if (amount === 'displayed') return page.amountDisplayed;
    if (amount === 'half') return halfOf(page.amountDisplayed);
    if (amount === 'shortfall') {
      const due = statusValue(await this.status(key), 'shortfall');
      if (!due || due === '0') throw new Error(`order ${key} has no shortfall to pay`);
      return due;
    }
    return amount.exact;
  }
}
