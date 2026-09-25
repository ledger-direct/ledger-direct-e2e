import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, ShopConfig, StatusPayload } from './driver.js';
import type { State } from '../cases/catalogue.js';

export interface MagentoOptions {
  /** How the shop is reached over HTTP from this machine, e.g. https://localhost:8444 */
  baseUrl: string;
  /** The compose folder of the shop (markshust layout: bin/docker-compose wrapper, phpfpm service). */
  composeDir: string;
  /** The compose service with PHP and the Magento install (default: phpfpm). */
  service?: string;
  adminUser?: string;
  adminPassword?: string;
  /** SKU of the cheap test article the driver creates on first use. */
  testProductSku?: string;
  /**
   * Accept the dev shop's self-signed certificate. Node has no per-request switch for
   * that, so this is process-wide; default when the host is localhost.
   */
  allowSelfSigned?: boolean;
}

const PAYMENT_METHODS: Record<string, string> = {
  XRP: 'xrp_payment',
  RLUSD: 'xrpl_rlusd_payment',
  USDC: 'xrpl_usdc_payment',
};
const CRON_JOB = 'ledger_direct_settle_pending_orders';
const SYSTEM_LOG = '/var/www/html/var/log/system.log';
const SETTLEMENT_LOG_LINE = 'LedgerDirect: scheduled settlement run';

/** Bootstraps Magento in a PHP script fed to the container; $argv[1..] are the arguments. */
const BOOTSTRAP = `<?php
require '/var/www/html/app/bootstrap.php';
$om = \\Magento\\Framework\\App\\Bootstrap::create(BP, $_SERVER)->getObjectManager();
`;

/**
 * Magento 2. Orders go through the REST API the way a headless storefront
 * places them — guest cart, item, addresses and shipping, payment method —
 * so the checkout is real and no browser is involved. Configuration, the
 * cron job and the throttle mark have no REST face and run as PHP inside the
 * container; order state and cancelling use the admin REST API.
 */
export class MagentoDriver implements Driver {
  readonly name = 'magento' as const;

  private adminToken?: string;
  private account?: string;
  private currency?: string;
  private testProductSku?: string;
  private readonly assetOf = new Map<string, string>();

  constructor(private readonly options: MagentoOptions) {
    const url = new URL(options.baseUrl);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol === 'https:' && (options.allowSelfSigned ?? local)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  }

  async configure(config: ShopConfig): Promise<void> {
    await this.php(`${BOOTSTRAP}
$om->get(\\Magento\\Framework\\App\\State::class)->setAreaCode('adminhtml');
[$script, $account, $assets, $expiry] = $argv;
$assets = explode(',', $assets);
$writer = $om->get(\\Magento\\Framework\\App\\Config\\Storage\\WriterInterface::class);
foreach ([
  'payment/ledger_direct/use_testnet' => 1,
  'payment/ledger_direct/xrpl_testnet_account' => $account,
  'payment/ledger_direct/quote_expiry' => (int) $expiry,
  'payment/xrp_payment/active' => 1,
  'payment/xrpl_rlusd_payment/active' => in_array('RLUSD', $assets, true) ? 1 : 0,
  'payment/xrpl_usdc_payment/active' => in_array('USDC', $assets, true) ? 1 : 0,
] as $path => $value) {
  $writer->save($path, $value);
}
$om->get(\\Magento\\Framework\\App\\Cache\\TypeListInterface::class)->cleanType('config');
echo json_encode(['ok' => true]), "\\n";`, config.destinationAccount, config.assets.join(','), String(config.quoteExpirySeconds));
    this.account = config.destinationAccount;
    await this.ensureTestProduct();
  }

  async findProducts(query: string): Promise<Product[]> {
    const url = new URL(`${this.options.baseUrl}/rest/V1/products`);
    url.searchParams.set('searchCriteria[filterGroups][0][filters][0][field]', 'name');
    url.searchParams.set('searchCriteria[filterGroups][0][filters][0][value]', `%${query}%`);
    url.searchParams.set('searchCriteria[filterGroups][0][filters][0][conditionType]', 'like');
    url.searchParams.set('searchCriteria[filterGroups][1][filters][0][field]', 'type_id');
    url.searchParams.set('searchCriteria[filterGroups][1][filters][0][value]', 'simple');
    url.searchParams.set('searchCriteria[pageSize]', '10');
    url.searchParams.set('fields', 'items[sku,name,price]');
    const r = (await this.admin('GET', url.pathname + url.search)) as { items: Array<{ sku: string; name: string; price: number }> | null };
    const currency = await this.storeCurrency();
    // The SKU is what the cart takes, so it is the id here.
    return (r.items ?? []).map((p) => ({ id: p.sku, number: p.sku, name: p.name, price: String(p.price), currency }));
  }

  async placeOrder(asset: string, options: OrderOptions = {}): Promise<PlacedOrder> {
    const method = PAYMENT_METHODS[asset];
    if (!method) throw new Error(`Magento: no payment method for ${asset}`);
    const sku = options.productId ?? this.testProductSku ?? (await this.ensureTestProduct());

    // A guest, every time: the catalogue's PS-06 is the rule, not the exception.
    const cartId = (await this.rest('POST', '/rest/V1/guest-carts')) as string;
    await this.rest('POST', `/rest/V1/guest-carts/${cartId}/items`, { cartItem: { sku, qty: options.quantity ?? 1, quote_id: cartId } });
    const stamp = Date.now();
    const address = { firstname: 'E2E', lastname: `Run ${stamp}`, street: ['Testweg 1'], city: 'Berlin', postcode: '10115', country_id: 'DE', telephone: '000', email: `e2e-${stamp}@example.invalid` };
    const methods = (await this.rest('POST', `/rest/V1/guest-carts/${cartId}/estimate-shipping-methods`, { address: { country_id: address.country_id, postcode: address.postcode } })) as Array<{ carrier_code: string; method_code: string; amount: number; available: boolean }>;
    const shipping = methods.filter((m) => m.available).sort((a, b) => a.amount - b.amount)[0];
    if (!shipping) throw new Error('Magento: no shipping method available for the test address');
    await this.rest('POST', `/rest/V1/guest-carts/${cartId}/shipping-information`, {
      addressInformation: { shipping_address: address, billing_address: address, shipping_carrier_code: shipping.carrier_code, shipping_method_code: shipping.method_code },
    });
    const orderId = String(await this.rest('POST', `/rest/V1/guest-carts/${cartId}/payment-information`, { email: address.email, paymentMethod: { method } }));

    // The per-order key Magento generates for guest access to an order.
    const order = (await this.admin('GET', `/rest/V1/orders/${orderId}?fields=increment_id,protect_code`)) as { increment_id: string; protect_code: string };
    this.assetOf.set(orderId, asset);
    return { id: orderId, reference: order.increment_id, secret: order.protect_code };
  }

  async paymentPage(order: PlacedOrder): Promise<PaymentPageView> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    if (response.status !== 200) throw new Error(`Magento: payment page answered ${response.status}`);
    const html = await response.text();
    const state = attr(html, 'data-ld-state');
    const amount = html.match(/id="(?:xrp|token)-amount"[^>]*value="([^"]+)"/);
    const account = html.match(/id="destination-account"[^>]*data-value="([^"]+)"/);
    const tag = html.match(/id="destination-tag"[^>]*data-value="(\d+)"/);
    if (!state || !amount || !account || !tag) throw new Error(`Magento: payment page for order ${order.id} did not render the expected fields`);
    return {
      state: state as State,
      amountDisplayed: amount[1].trim(),
      asset: this.assetOf.get(order.id) ?? 'XRP',
      destinationAccount: account[1].trim(),
      paymentIdentifier: tag[1],
      statusUrl: this.statusUrl(order),
    };
  }

  async status(order: PlacedOrder): Promise<StatusPayload> {
    const response = await fetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Magento: status endpoint answered ${response.status}`);
    return (await response.json()) as StatusPayload;
  }

  async statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }> {
    const response = await fetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }

  unknownOrderId(): string {
    return '999999999';
  }

  async pageResponse(order: PlacedOrder): Promise<{ status: number }> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    return { status: response.status };
  }

  /**
   * The "get an updated amount" form of the expired block: a POST with the form key
   * Magento rendered, from the session that rendered it — so the page's cookies travel along.
   */
  async refresh(order: PlacedOrder): Promise<void> {
    const page = await fetch(this.pageUrl(order), { redirect: 'manual' });
    const html = await page.text();
    const formKey = html.match(/name="form_key" value="([^"]+)"/)?.[1];
    if (!formKey) throw new Error(`Magento: the payment page for order ${order.id} shows no form key`);
    const cookies = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const response = await fetch(`${this.options.baseUrl}/ledger-direct/payment/refresh`, {
      method: 'POST',
      headers: cookies ? { Cookie: cookies } : {},
      body: new URLSearchParams({ form_key: formKey, id: order.id, key: order.secret }),
      redirect: 'manual',
    });
    // Magento answers the form with a redirect back to the payment page; anything else is a refusal.
    if (response.status < 300 || response.status >= 400) {
      throw new Error(`Magento: refresh answered ${response.status}: ${(await response.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }

  async close(order: PlacedOrder): Promise<void> {
    const ok = await this.admin('POST', `/rest/V1/orders/${order.id}/cancel`);
    if (ok !== true) throw new Error(`Magento: cancel of order ${order.id} answered ${JSON.stringify(ok)}`);
  }

  /**
   * The cron job, run once regardless of its schedule. What it did is read back from the
   * line it logs (accounts synced, orders checked and settled); absent when the log has none.
   */
  async safetyNet(): Promise<unknown> {
    const before = await this.settlementLogLines();
    await this.php(`${BOOTSTRAP}
$om->get(\\Magento\\Framework\\App\\State::class)->setAreaCode('crontab');
$om->get(\\Hardcastle\\LedgerDirect\\Cron\\SettlePendingOrders::class)->execute();
echo json_encode(['ran' => '${CRON_JOB}']), "\\n";`);
    const after = await this.settlementLogLines();
    const summary: Record<string, unknown> = { ran: CRON_JOB };
    if (after.count > before.count && after.last) {
      const json = after.last.match(/\{.*\}/)?.[0];
      const logged = json ? (JSON.parse(json) as { accounts_synced?: number; checked?: number; settled?: number }) : {};
      summary.synced = (logged.accounts_synced ?? 0) > 0;
      summary.checked = logged.checked;
      summary.settled = logged.settled;
    }
    return summary;
  }

  /**
   * The core's throttle mark in Magento's cache, holding the time of the last sync of
   * the receiving account: it changes exactly when a sync ran. Null before configure().
   */
  async nodeRequests(): Promise<number | null> {
    if (!this.account) return null;
    const r = (await this.php(`${BOOTSTRAP}
$om->get(\\Magento\\Framework\\App\\State::class)->setAreaCode('frontend');
$value = $om->get(\\Hardcastle\\LedgerDirect\\Model\\Cache\\RateCache::class)->get('ledger-direct.sync.v1.testnet.' . $argv[1]);
echo json_encode(['value' => $value]), "\\n";`, this.account)) as { value: number | string | null };
    return r.value === null ? 0 : Number.parseInt(String(r.value), 10);
  }

  /** Evidence for the report and the platform-state checks of the cases. */
  async orderState(order: PlacedOrder): Promise<Record<string, unknown>> {
    return (await this.php(`${BOOTSTRAP}
$om->get(\\Magento\\Framework\\App\\State::class)->setAreaCode('frontend');
$order = $om->get(\\Magento\\Sales\\Api\\OrderRepositoryInterface::class)->get((int) $argv[1]);
$payment = $order->getPayment();
$raw = $payment->getAdditionalData();
$intent = $raw ? (json_decode($raw, true)['xrpl'] ?? null) : null;
// The settling hash is the invoice's transaction id; a partial or wrong-asset hit is noted on the payment.
$payments = [];
foreach ($order->getInvoiceCollection() as $invoice) {
  if ($invoice->getTransactionId()) { $payments[] = ['transaction_id' => $invoice->getTransactionId(), 'invoice' => $invoice->getIncrementId()]; }
}
echo json_encode([
  'id_order' => (int) $order->getEntityId(),
  'reference' => $order->getIncrementId(),
  'state' => ['name' => $order->getStatus(), 'is_paid' => $order->getState() === 'processing', 'is_incomplete' => $order->getStatus() === 'ledger_direct_payment_incomplete', 'is_awaiting' => $order->getState() === 'pending_payment'],
  'payments' => $payments,
  'last_trans_id' => $payment->getLastTransId(),
  'total_paid_real' => (float) $order->getTotalPaid(),
  'intent' => $intent,
]), "\\n";`, order.id)) as Record<string, unknown>;
  }

  // --- helpers ---------------------------------------------------------

  private pageUrl(order: PlacedOrder): string {
    return `${this.options.baseUrl}/ledger-direct/payment/index?id=${order.id}&key=${encodeURIComponent(order.secret)}`;
  }

  private statusUrl(order: PlacedOrder): string {
    return `${this.options.baseUrl}/ledger-direct/payment/status?id=${order.id}&key=${encodeURIComponent(order.secret)}`;
  }

  private async storeCurrency(): Promise<string> {
    if (this.currency) return this.currency;
    const configs = (await this.admin('GET', '/rest/V1/store/storeConfigs')) as Array<{ default_display_currency_code: string }>;
    return (this.currency = configs[0]?.default_display_currency_code ?? 'USD');
  }

  /** A 1.00 article, created once: the catalogue wants small orders, where rounding bites hardest. */
  private async ensureTestProduct(): Promise<string> {
    if (this.testProductSku) return this.testProductSku;
    const sku = this.options.testProductSku ?? 'LD-E2E-001';
    const existing = await fetch(`${this.options.baseUrl}/rest/V1/products/${encodeURIComponent(sku)}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (existing.status !== 200) {
      await this.admin('POST', '/rest/V1/products', {
        product: {
          sku,
          name: 'LedgerDirect E2E test article',
          price: 1,
          type_id: 'simple',
          attribute_set_id: 4,
          status: 1,
          visibility: 4,
          weight: 0.1,
          extension_attributes: { website_ids: [1], stock_item: { qty: 100000, is_in_stock: true, manage_stock: true } },
        },
      });
      // Dev stacks index "by schedule" with no cron running: without this the article is "not available".
      await this.exec(['bin/magento', 'indexer:reindex', 'inventory', 'cataloginventory_stock', 'catalog_product_price', 'catalogsearch_fulltext']);
    }
    return (this.testProductSku = sku);
  }

  private async settlementLogLines(): Promise<{ count: number; last?: string }> {
    const out = await this.exec(['sh', '-c', `grep -F "${SETTLEMENT_LOG_LINE}" ${SYSTEM_LOG} 2>/dev/null | wc -l; grep -F "${SETTLEMENT_LOG_LINE}" ${SYSTEM_LOG} 2>/dev/null | tail -1`]);
    const [count, ...rest] = out.trim().split('\n');
    return { count: Number.parseInt(count ?? '0', 10) || 0, last: rest.join('\n') || undefined };
  }

  /** Runs a PHP script inside the shop container; the script prints one JSON line. */
  private async php(script: string, ...args: string[]): Promise<unknown> {
    const stdout = await this.exec(['php', '--', ...args], script);
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (!line) throw new Error(`Magento: the container printed no JSON: ${stdout.trim().slice(-300)}`);
    return JSON.parse(line) as unknown;
  }

  private exec(command: string[], stdin?: string): Promise<string> {
    // The markshust template wraps compose files in bin/docker-compose; a plain stack has docker compose.
    const wrapper = join(this.options.composeDir, 'bin', 'docker-compose');
    const [bin, prefix] = existsSync(wrapper) ? [wrapper, []] : ['docker', ['compose']];
    const argv = [...prefix, 'exec', '-T', this.options.service ?? 'phpfpm', ...command];
    return new Promise<string>((resolve, reject) => {
      const child = spawn(bin, argv, { cwd: this.options.composeDir });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`Magento: container command exited ${code}: ${(err || out).trim().split('\n').slice(-3).join(' | ')}`));
      });
      child.stdin.end(stdin ?? '');
    });
  }

  private async rest(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body);
  }

  private async admin(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.request(method, path, body, await this.token());
  }

  private async request(method: string, path: string, body?: unknown, token?: string): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${this.options.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Magento REST ${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  private async token(): Promise<string> {
    if (this.adminToken) return this.adminToken;
    const response = await fetch(`${this.options.baseUrl}/rest/V1/integration/admin/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.options.adminUser ?? 'john.smith', password: this.options.adminPassword ?? 'password123' }),
    });
    if (!response.ok) throw new Error(`Magento admin login failed: ${response.status}`);
    return (this.adminToken = (await response.json()) as string);
  }
}

function attr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`${name}="([^"]*)"`));
  return m?.[1];
}
