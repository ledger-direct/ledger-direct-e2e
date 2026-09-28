import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, ShopConfig, StatusPayload } from './driver.js';
import { readPaymentPage } from './page.js';

const run = promisify(execFile);

export interface ShopwareOptions {
  /** Storefront and API base, e.g. http://localhost */
  baseUrl: string;
  /** Sales channel access key (sw-access-key); read from the administration or the database. */
  accessKey: string;
  adminUser?: string;
  adminPassword?: string;
  /** Docker container name for the one thing that has no HTTP face: running the scheduled task. */
  container?: string;
  /** Product number of the cheap test article the driver creates on first use. */
  testProductNumber?: string;
}

const PAYMENT_METHOD_IDS: Record<string, string> = {
  XRP: '7ca60321a9d2dac0fe3622a5110f55bb',
  RLUSD: '7ca60321a9d2dac0fe3622a5110f55bd',
  USDC: '7ca60321a9d2dac0fe3622a5110f55be',
};

const CONFIG_PREFIX = 'LedgerDirect.config.';
const SCHEDULED_TASK = 'ledger_direct.settle_open_transactions';

/**
 * Shopware 6.7. Orders go through the Store API the way a headless client
 * places them — guest registration, cart, order, handle-payment — so the
 * checkout is real and no browser is involved. Configuration, order state
 * and cancelling use the Admin API. The only step without an HTTP face is
 * the scheduled task (PS-09), which runs through the container's console.
 */
export class ShopwareDriver implements Driver {
  readonly name = 'shopware' as const;

  private adminToken?: string;
  private readonly secretOf = new Map<string, { deepLinkCode: string; returnUrl: string; asset: string }>();
  private storefrontUrl?: string;
  private testProductId?: string;

  constructor(private readonly options: ShopwareOptions) {}

  async configure(config: ShopConfig): Promise<void> {
    await this.admin('POST', '/api/_action/system-config/batch', {
      null: {
        [CONFIG_PREFIX + 'useXrplTestnet']: true,
        [CONFIG_PREFIX + 'xrplTestnetDestinationAccount']: config.destinationAccount,
        [CONFIG_PREFIX + 'xrplIsRlusdEnabled']: config.assets.includes('RLUSD'),
        [CONFIG_PREFIX + 'xrplIsUsdcEnabled']: config.assets.includes('USDC'),
        [CONFIG_PREFIX + 'xrplQuoteExpiry']: config.quoteExpirySeconds,
      },
    });
    await this.ensureTestProduct();
  }

  async findProducts(query: string): Promise<Product[]> {
    const r = (await this.store('POST', '/store-api/search', { search: query, limit: 10 })).body as { elements?: Array<{ id: string; productNumber: string; translated?: { name?: string }; name?: string; calculatedPrice?: { totalPrice: number } }> };
    const currency = 'EUR';
    return (r.elements ?? []).map((p) => ({ id: p.id, number: p.productNumber, name: p.translated?.name ?? p.name ?? p.productNumber, price: String(p.calculatedPrice?.totalPrice ?? ''), currency }));
  }

  async placeOrder(asset: string, options: OrderOptions = {}): Promise<PlacedOrder> {
    const paymentMethodId = PAYMENT_METHOD_IDS[asset];
    if (!paymentMethodId) throw new Error(`Shopware: no payment method for ${asset}`);
    const productId = options.productId ?? this.testProductId ?? (await this.ensureTestProduct());
    const storefrontUrl = await this.salesChannelUrl();

    // A guest, every time: the catalogue's PS-06 is the rule, not the exception.
    const [salutationId, countryId] = await Promise.all([this.firstId('/store-api/salutation'), this.firstId('/store-api/country')]);
    const stamp = Date.now();
    const register = await this.store('POST', '/store-api/account/register', {
      guest: true,
      storefrontUrl,
      salutationId,
      firstName: 'E2E',
      lastName: `Run ${stamp}`,
      email: `e2e-${stamp}@example.invalid`,
      acceptedDataProtection: true,
      billingAddress: { street: 'Testweg 1', zipcode: '10115', city: 'Berlin', countryId },
    });
    const contextToken = register.headers.get('sw-context-token');
    if (!contextToken) throw new Error('Shopware: registration returned no context token');

    await this.store('POST', '/store-api/checkout/cart/line-item', { items: [{ type: 'product', referencedId: productId, quantity: options.quantity ?? 1 }] }, contextToken);
    await this.store('PATCH', '/store-api/context', { paymentMethodId }, contextToken);
    const order = (await this.store('POST', '/store-api/checkout/order', {}, contextToken)).body as { id: string; orderNumber: string; deepLinkCode: string };
    const payment = (await this.store('POST', '/store-api/handle-payment', {
      orderId: order.id,
      finishUrl: `${storefrontUrl}/checkout/finish?orderId=${order.id}`,
      errorUrl: `${storefrontUrl}/account/order/edit/${order.id}`,
    }, contextToken)).body as { redirectUrl?: string };

    // handle-payment answers a relative URL; the returnUrl inside it carries Shopware's payment token.
    const returnUrl = payment.redirectUrl ? new URL(payment.redirectUrl, this.options.baseUrl).searchParams.get('returnUrl') ?? '' : '';
    this.secretOf.set(order.id, { deepLinkCode: order.deepLinkCode, returnUrl, asset });
    return { id: order.id, reference: order.orderNumber, secret: order.deepLinkCode };
  }

  async paymentPage(order: PlacedOrder): Promise<PaymentPageView> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    if (response.status !== 200) throw new Error(`Shopware: payment page answered ${response.status}`);
    const html = await response.text();
    const page = readPaymentPage(html);
    if (!page) throw new Error(`Shopware: payment page for order ${order.id} did not render the markup contract`);
    return { ...page, asset: page.asset ?? this.secretOf.get(order.id)?.asset ?? 'XRP', statusUrl: this.statusUrl(order) };
  }

  async status(order: PlacedOrder): Promise<StatusPayload> {
    const response = await fetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Shopware: status endpoint answered ${response.status}`);
    return (await response.json()) as StatusPayload;
  }

  async statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }> {
    const response = await fetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }

  unknownOrderId(): string {
    return '0123456789abcdef0123456789abcdef';
  }

  async pageResponse(order: PlacedOrder): Promise<{ status: number }> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    return { status: response.status };
  }

  async refresh(order: PlacedOrder): Promise<void> {
    const url = new URL(`${this.options.baseUrl}/ledger-direct/payment/refresh/${order.id}`);
    url.searchParams.set('deepLinkCode', order.secret);
    await fetch(url, { method: 'POST', redirect: 'manual' });
  }

  async close(order: PlacedOrder): Promise<void> {
    const transactionId = await this.transactionId(order.id);
    await this.admin('POST', `/api/_action/order_transaction/${transactionId}/state/cancel`, {});
  }

  /** The scheduled task, run once regardless of its schedule — Shopware's cron. */
  async safetyNet(): Promise<unknown> {
    const container = this.options.container ?? 'shopware6_672-shopware-1';
    await run('docker', ['exec', '-u', 'www-data', container, 'bash', '-lc', 'cd /var/www/html && bin/console scheduled-task:register >/dev/null 2>&1; true']);
    const { stdout, stderr } = await run('docker', ['exec', '-u', 'www-data', container, 'bash', '-lc', `cd /var/www/html && bin/console scheduled-task:run-single ${SCHEDULED_TASK} 2>&1`], { maxBuffer: 4 * 1024 * 1024 });
    return { ran: SCHEDULED_TASK, output: (stdout + stderr).trim().split('\n').slice(-3) };
  }

  /**
   * The plugin logs one debug line per actual ledger sync ("LedgerDirect: ledger synced"),
   * in dev.log when APP_ENV=dev. Counting those lines is the observable PS-08 needs; the
   * throttle mark itself lives in the app cache, out of reach. Null when the log is not there.
   */
  async nodeRequests(): Promise<number | null> {
    const container = this.options.container ?? 'shopware6_672-shopware-1';
    try {
      const { stdout } = await run('docker', ['exec', container, 'bash', '-lc', 'grep -c "LedgerDirect: ledger synced" /var/www/html/var/log/dev.log 2>/dev/null || echo 0']);
      const n = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(n) ? null : n;
    } catch {
      return null;
    }
  }

  /** Evidence for the report and the platform-state checks of the cases. */
  async orderState(order: PlacedOrder): Promise<Record<string, unknown>> {
    const found = (await this.admin('POST', '/api/search/order', {
      ids: [order.id],
      associations: { transactions: { associations: { stateMachineState: {} } } },
    })) as { data: Array<{ orderNumber: string; transactions: Array<{ id: string; stateMachineState: { technicalName: string }; customFields?: Record<string, unknown> }> }> };
    const o = found.data[0];
    const tx = o.transactions[0];
    const state = tx.stateMachineState.technicalName;
    const intent = (tx.customFields?.ledger_direct ?? null) as { hash?: string; amount_paid?: unknown } | null;
    return {
      id_order: order.id,
      reference: o.orderNumber,
      state: { name: state, is_paid: state === 'paid', is_incomplete: state === 'paid_partially', is_awaiting: ['open', 'unconfirmed', 'in_progress'].includes(state) },
      // One transaction per order; its custom field is the payment record.
      payments: intent?.hash ? [{ transaction_id: intent.hash }] : [],
      total_paid_real: state === 'paid' ? 'paid' : 'open',
      intent,
    };
  }

  // --- helpers ---------------------------------------------------------

  private pageUrl(order: PlacedOrder): string {
    const url = new URL(`${this.options.baseUrl}/ledger-direct/payment/${order.id}`);
    url.searchParams.set('deepLinkCode', order.secret);
    const returnUrl = this.secretOf.get(order.id)?.returnUrl;
    if (returnUrl) url.searchParams.set('returnUrl', returnUrl);
    return url.toString();
  }

  private statusUrl(order: PlacedOrder): string {
    const url = new URL(`${this.options.baseUrl}/ledger-direct/payment/check/${order.id}`);
    url.searchParams.set('deepLinkCode', order.secret);
    const returnUrl = this.secretOf.get(order.id)?.returnUrl;
    if (returnUrl) url.searchParams.set('returnUrl', returnUrl);
    return url.toString();
  }

  private async transactionId(orderId: string): Promise<string> {
    const found = (await this.admin('POST', '/api/search/order-transaction', { filter: [{ type: 'equals', field: 'orderId', value: orderId }] })) as { data: Array<{ id: string }> };
    if (!found.data[0]) throw new Error(`Shopware: order ${orderId} has no transaction`);
    return found.data[0].id;
  }

  private async salesChannelUrl(): Promise<string> {
    if (this.storefrontUrl) return this.storefrontUrl;
    const found = (await this.admin('POST', '/api/search/sales-channel-domain', { limit: 50 })) as { data: Array<{ url: string; salesChannelId: string }> };
    const base = new URL(this.options.baseUrl);
    const match = found.data.find((d) => d.url.startsWith(`${base.protocol}//${base.host}`)) ?? found.data[0];
    if (!match) throw new Error('Shopware: no sales channel domain found');
    this.storefrontUrl = match.url;
    return match.url;
  }

  /** A 1.00 EUR article, created once: the catalogue wants small orders, where rounding bites hardest. */
  private async ensureTestProduct(): Promise<string> {
    if (this.testProductId) return this.testProductId;
    const number = this.options.testProductNumber ?? 'LD-E2E-001';
    const existing = (await this.admin('POST', '/api/search/product', { filter: [{ type: 'equals', field: 'productNumber', value: number }] })) as { data: Array<{ id: string }> };
    if (existing.data[0]) return (this.testProductId = existing.data[0].id);

    const [tax, currency, salesChannel] = await Promise.all([
      this.admin('POST', '/api/search/tax', { filter: [{ type: 'equals', field: 'taxRate', value: 19 }] }) as Promise<{ data: Array<{ id: string }> }>,
      this.admin('POST', '/api/search/currency', { filter: [{ type: 'equals', field: 'isoCode', value: 'EUR' }] }) as Promise<{ data: Array<{ id: string }> }>,
      this.admin('POST', '/api/search/sales-channel', { filter: [{ type: 'equals', field: 'accessKey', value: this.options.accessKey }] }) as Promise<{ data: Array<{ id: string }> }>,
    ]);
    const id = 'e2e00000000000000000000000000001';
    await this.admin('POST', '/api/product', {
      id,
      name: 'LedgerDirect E2E test article',
      productNumber: number,
      stock: 100000,
      active: true,
      taxId: tax.data[0].id,
      price: [{ currencyId: currency.data[0].id, gross: 1.0, net: 0.84, linked: true }],
      visibilities: [{ salesChannelId: salesChannel.data[0].id, visibility: 30 }],
    });
    return (this.testProductId = id);
  }

  private async firstId(path: string): Promise<string> {
    const r = (await this.store('GET', path)).body as { elements?: Array<{ id: string }> } | Array<{ id: string }>;
    const list = Array.isArray(r) ? r : r.elements ?? [];
    if (!list[0]) throw new Error(`Shopware: ${path} returned nothing`);
    return list[0].id;
  }

  private async store(method: string, path: string, body?: unknown, contextToken?: string): Promise<{ body: unknown; headers: Headers }> {
    const headers: Record<string, string> = { 'sw-access-key': this.options.accessKey, Accept: 'application/json', 'Content-Type': 'application/json' };
    if (contextToken) headers['sw-context-token'] = contextToken;
    const response = await fetch(`${this.options.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Shopware store-api ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return { body: text ? JSON.parse(text) : null, headers: response.headers };
  }

  private async admin(method: string, path: string, body?: unknown, retry = true): Promise<unknown> {
    const token = await this.token();
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 401 && retry) {
      // The access token lives ten minutes; a case that waits longer (PS-10) outlives it.
      this.adminToken = undefined;
      return this.admin(method, path, body, false);
    }
    if (!response.ok) throw new Error(`Shopware admin-api ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  private async token(): Promise<string> {
    if (this.adminToken) return this.adminToken;
    const response = await fetch(`${this.options.baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', client_id: 'administration', scopes: 'write', username: this.options.adminUser ?? 'admin', password: this.options.adminPassword ?? 'shopware' }),
    });
    if (!response.ok) throw new Error(`Shopware admin-api login failed: ${response.status}`);
    const data = (await response.json()) as { access_token: string };
    return (this.adminToken = data.access_token);
  }
}

