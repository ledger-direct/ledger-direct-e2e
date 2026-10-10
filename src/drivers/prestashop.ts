import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, ShopConfig, StatusPayload } from './driver.js';
import { readPaymentPage } from './page.js';

const run = promisify(execFile);

export interface PrestaShopOptions {
  /** The harness folder holding docker-compose.yml (the module is mounted into that container). */
  composeDir: string;
  /** How the shop is reached over HTTP from this machine. */
  baseUrl: string;
  service?: string;
}

/**
 * PrestaShop 9 dev shop. Orders are placed through `dev/bin/e2e.php` inside
 * the container — PrestaShop's checkout over HTTP is the most involved part of
 * the platform and not what the catalogue tests. Everything a customer does is
 * HTTP: the payment page, the poll, the cron.
 */
export class PrestaShopDriver implements Driver {
  readonly name = 'prestashop' as const;

  private cronUrl?: string;

  constructor(private readonly options: PrestaShopOptions) {}

  async configure(config: ShopConfig): Promise<void> {
    const r = (await this.helper('configure', {
      account: config.destinationAccount,
      network: config.network,
      assets: config.assets.join(','),
      'quote-expiry': String(config.quoteExpirySeconds),
    })) as { cron_url: string };
    this.cronUrl = this.rebase(r.cron_url);
  }

  async findProducts(query: string): Promise<Product[]> {
    const r = (await this.helper('find-products', { query })) as { products: Array<{ id_product: number; reference: string; name: string; price: string; currency: string }> };
    return r.products.map((p) => ({ id: String(p.id_product), number: p.reference, name: p.name, price: p.price, currency: p.currency }));
  }

  async placeOrder(asset: string, options: OrderOptions = {}): Promise<PlacedOrder & { pollUrl: string; pageUrl: string; cronUrl: string }> {
    const args: Record<string, string> = { asset };
    if (options.productId) args.product = options.productId;
    if (options.quantity) args.quantity = String(options.quantity);
    const r = (await this.helper('create-order', args)) as { id_order: number; reference: string; key: string; page: string; poll: string; cron: string };
    this.cronUrl = this.rebase(r.cron);
    return { id: String(r.id_order), reference: r.reference, secret: r.key, pollUrl: this.rebase(r.poll), pageUrl: this.rebase(r.page), cronUrl: this.cronUrl };
  }

  async paymentPage(order: PlacedOrder): Promise<PaymentPageView> {
    const url = `${this.options.baseUrl}/module/ledgerdirect/payment?id_order=${order.id}&key=${order.secret}`;
    const html = await (await fetch(url, { redirect: 'manual' })).text();
    const page = readPaymentPage(html);
    if (!page) throw new Error(`PrestaShop: payment page for order ${order.id} did not render the markup contract`);
    return { ...page, asset: page.asset ?? 'XRP', statusUrl: page.pollUrl ?? `${this.options.baseUrl}/module/ledgerdirect/poll?id_order=${order.id}&key=${order.secret}` };
  }

  async status(order: PlacedOrder): Promise<StatusPayload> {
    const url = `${this.options.baseUrl}/module/ledgerdirect/poll?id_order=${order.id}&key=${order.secret}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`poll answered ${response.status}`);
    return (await response.json()) as StatusPayload;
  }

  async statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }> {
    const url = `${this.options.baseUrl}/module/ledgerdirect/poll?id_order=${order.id}&key=${order.secret}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }

  unknownOrderId(): string {
    return '999999999';
  }

  async pageResponse(order: PlacedOrder): Promise<{ status: number }> {
    const url = `${this.options.baseUrl}/module/ledgerdirect/payment?id_order=${order.id}&key=${order.secret}`;
    const response = await fetch(url, { redirect: 'manual' });
    return { status: response.status };
  }

  async refresh(order: PlacedOrder): Promise<void> {
    const url = `${this.options.baseUrl}/module/ledgerdirect/payment?id_order=${order.id}&key=${order.secret}`;
    await fetch(url, { method: 'POST', body: new URLSearchParams({ ld_refresh: '1' }), redirect: 'manual' });
  }

  async close(order: PlacedOrder): Promise<void> {
    await this.helper('close-order', { order: order.id });
  }

  async safetyNet(): Promise<unknown> {
    if (!this.cronUrl) throw new Error('cron url unknown — configure() or placeOrder() first');
    const response = await fetch(this.cronUrl);
    if (!response.ok) throw new Error(`cron answered ${response.status}`);
    return response.json();
  }

  /** The throttle mark's stored value: it changes exactly when a sync ran. */
  async nodeRequests(): Promise<number | null> {
    const r = (await this.helper('sync-marker', {})) as { value: string | null };
    return r.value === null ? 0 : Number.parseInt(r.value, 10);
  }

  async recordedHashes(destinationAccount: string, paymentIdentifier: string): Promise<string[]> {
    const answer = (await this.helper('transactions', { account: destinationAccount, tag: paymentIdentifier })) as { hashes?: string[] };
    return answer.hashes ?? [];
  }

  /** Platform-specific evidence for the report. */
  async orderState(order: PlacedOrder): Promise<Record<string, unknown>> {
    return (await this.helper('order-state', { order: order.id })) as Record<string, unknown>;
  }

  private async helper(command: string, args: Record<string, string>): Promise<unknown> {
    const argv = ['compose', 'exec', '-T', '-u', 'www-data', this.options.service ?? 'prestashop', 'php', '/var/www/html/modules/ledgerdirect/dev/bin/e2e.php', command, ...Object.entries(args).map(([k, v]) => `--${k}=${v}`)];
    const { stdout } = await run('docker', argv, { cwd: this.options.composeDir, maxBuffer: 4 * 1024 * 1024 });
    const json = stdout.slice(stdout.indexOf('{'));
    return JSON.parse(json) as unknown;
  }

  /** URLs the shop generates carry its own host; the harness reaches it via baseUrl. */
  private rebase(url: string): string {
    const u = new URL(url);
    const base = new URL(this.options.baseUrl);
    u.protocol = base.protocol;
    u.host = base.host;
    return u.toString();
  }
}

