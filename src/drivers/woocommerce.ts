import { spawn } from 'node:child_process';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, ShopConfig, StatusPayload } from './driver.js';
import type { State } from '../cases/catalogue.js';

export interface WooCommerceOptions {
  /** The folder with the WordPress docker-compose.yml — the one that has a WP-CLI service. */
  composeDir: string;
  /** Compose files to pass with -f, in order; the folder's default file when empty. */
  composeFiles?: string[];
  /** The running compose service that has WordPress and WP-CLI (default: wp). `exec`, not `run`: a fresh container per call costs seconds, and PS-08 measures a 5-second window. */
  service?: string;
  /** How the shop is reached over HTTP from this machine, e.g. http://localhost:8082 */
  baseUrl: string;
  /** SKU of the cheap test article the driver creates on first use. */
  testProductSku?: string;
}

const SETTINGS_OPTION = 'woocommerce_ledger-direct_settings';
const GATEWAY_ID = 'ledger-direct';
const HOOK = 'ledger_direct_settle_pending_orders';
const PAYMENT_TYPES: Record<string, string> = { XRP: 'xrp', RLUSD: 'rlusd', USDC: 'usdc' };

/**
 * In WooCommerce the order key is the identifier: the payment page and the
 * status endpoint take nothing else. A probe for "an unknown order" is
 * therefore a probe with an unknown key; this sentinel id tells the driver to
 * build one. The key stays well-formed (wc_order_ + 13 characters), so the
 * refusal comes from the plugin's guard, not from the route pattern.
 */
const UNKNOWN_ORDER_ID = '999999999';
const UNKNOWN_KEY = 'wc_order_0000000000000';

/**
 * WooCommerce (WordPress). Orders are placed through WP-CLI inside the compose
 * stack — WooCommerce's checkout over HTTP needs a session, a nonce and the
 * cart fragments, none of which the catalogue tests. Everything a customer
 * does is HTTP: the payment page, the status endpoint, the refresh. The
 * merchant's side (configuration, order state, cancelling) and the safety net
 * (the Action Scheduler hook) go through WP-CLI as well.
 *
 * Assumes pretty permalinks (the payment page is /ledger-direct-payment/<key>/).
 */
export class WooCommerceDriver implements Driver {
  readonly name = 'woocommerce' as const;

  private account?: string;
  private testProductId?: string;
  private readonly assetOf = new Map<string, string>();

  constructor(private readonly options: WooCommerceOptions) {}

  async configure(config: ShopConfig): Promise<void> {
    // The plugin keeps the quote expiry in minutes, one minute at least.
    const minutes = Math.max(1, Math.round(config.quoteExpirySeconds / 60));
    await this.wp(`<?php
[$account, $assets, $minutes] = [$args[0], explode(',', $args[1]), (int) $args[2]];
$settings = get_option('${SETTINGS_OPTION}', []);
$settings = array_merge(is_array($settings) ? $settings : [], [
  'enabled' => 'yes',
  'xrpl_network' => 'testnet',
  'xrpl_testnet_destination_account' => $account,
  'xrpl_is_rlusd_enabled' => in_array('RLUSD', $assets, true) ? 'yes' : 'no',
  'xrpl_is_usdc_enabled' => in_array('USDC', $assets, true) ? 'yes' : 'no',
  'xrpl_quote_expiry' => $minutes,
]);
update_option('${SETTINGS_OPTION}', $settings);
echo json_encode(['ok' => true]), "\\n";`, config.destinationAccount, config.assets.join(','), String(minutes));
    this.account = config.destinationAccount;
    await this.ensureTestProduct();
  }

  async findProducts(query: string): Promise<Product[]> {
    const r = (await this.wp(`<?php
$products = wc_get_products(['s' => $args[0], 'limit' => 10, 'status' => 'publish']);
echo json_encode(['currency' => get_woocommerce_currency(), 'products' => array_values(array_map(fn($p) => [
  'id' => $p->get_id(), 'sku' => $p->get_sku(), 'name' => $p->get_name(), 'price' => (string) $p->get_price(),
], $products))]), "\\n";`, query)) as { currency: string; products: Array<{ id: number; sku: string; name: string; price: string }> };
    return r.products.map((p) => ({ id: String(p.id), number: p.sku || String(p.id), name: p.name, price: p.price, currency: r.currency }));
  }

  async placeOrder(asset: string, options: OrderOptions = {}): Promise<PlacedOrder> {
    const paymentType = PAYMENT_TYPES[asset];
    if (!paymentType) throw new Error(`WooCommerce: no payment type for ${asset}`);
    const productId = options.productId ?? this.testProductId ?? (await this.ensureTestProduct());
    // A guest, every time: the catalogue's PS-06 is the rule, not the exception.
    const r = (await this.wp(`<?php
[$paymentType, $productId, $quantity] = [$args[0], (int) $args[1], (int) $args[2]];
$order = wc_create_order(['status' => 'pending', 'customer_id' => 0, 'created_via' => 'ld-e2e']);
$order->add_product(wc_get_product($productId), $quantity);
$address = ['first_name' => 'E2E', 'last_name' => 'Run ' . time(), 'address_1' => 'Testweg 1', 'city' => 'Berlin', 'postcode' => '10115', 'country' => 'DE', 'email' => 'e2e-' . time() . '@example.invalid'];
$order->set_address($address, 'billing');
$order->set_address($address, 'shipping');
$order->set_payment_method(\\Hardcastle\\LedgerDirect\\Woocommerce\\LedgerDirectPaymentGateway::instance());
$order->calculate_totals();
$order->save();
// What process_payment() does once WooCommerce has validated the checkout: quote the order in the chosen asset.
\\Hardcastle\\LedgerDirect\\Service\\ServiceFactory::getInstance()->getOrderTransactionService()->prepareOrderForXrpl($order, $paymentType);
echo json_encode(['id' => $order->get_id(), 'number' => $order->get_order_number(), 'key' => $order->get_order_key()]), "\\n";`, paymentType, productId, String(options.quantity ?? 1))) as { id: number; number: string; key: string };
    const id = String(r.id);
    this.assetOf.set(id, asset);
    return { id, reference: r.number, secret: r.key };
  }

  async paymentPage(order: PlacedOrder): Promise<PaymentPageView> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    if (response.status !== 200) throw new Error(`WooCommerce: payment page answered ${response.status}`);
    const html = await response.text();
    const state = attr(html, 'data-ld-state');
    const amount = html.match(/id="(?:xrp|token)-amount"[^>]*value="([^"]+)"/);
    const account = html.match(/id="destination-account"[^>]*data-value="([^"]+)"/);
    const tag = html.match(/id="destination-tag"[^>]*data-value="(\d+)"/);
    if (!state || !amount || !account || !tag) throw new Error(`WooCommerce: payment page for order ${order.id} did not render the expected fields`);
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
    if (!response.ok) throw new Error(`WooCommerce: status endpoint answered ${response.status}`);
    return (await response.json()) as StatusPayload;
  }

  async statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }> {
    const response = await fetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    return { status: response.status, body: await response.text() };
  }

  unknownOrderId(): string {
    return UNKNOWN_ORDER_ID;
  }

  /** A key of the right shape that is not the order's: the route accepts it, the guard refuses it. */
  wrongSecret(): string {
    return 'wc_order_NotTheKey000';
  }

  async pageResponse(order: PlacedOrder): Promise<{ status: number }> {
    const response = await fetch(this.pageUrl(order), { redirect: 'manual' });
    return { status: response.status };
  }

  /** The "get an updated amount" form of the expired block: a POST with the nonce the page rendered. */
  async refresh(order: PlacedOrder): Promise<void> {
    const html = await (await fetch(this.pageUrl(order), { redirect: 'manual' })).text();
    const nonce = html.match(/name="_wpnonce" value="([^"]+)"/)?.[1];
    if (!nonce) throw new Error(`WooCommerce: the payment page for order ${order.id} shows no refresh form (quote not expired?)`);
    await fetch(this.pageUrl(order), {
      method: 'POST',
      body: new URLSearchParams({ 'ledger-direct-payment': this.keyOf(order), ledger_direct_refresh: '1', _wpnonce: nonce }),
      redirect: 'manual',
    });
  }

  async close(order: PlacedOrder): Promise<void> {
    await this.wp(`<?php
$order = wc_get_order((int) $args[0]);
$order->update_status('cancelled', 'ld-e2e: closed by the merchant');
echo json_encode(['status' => $order->get_status()]), "\\n";`, order.id);
  }

  /**
   * The Action Scheduler hook the plugin registers, fired now — what the scheduler
   * does every few minutes. Counted by pending LedgerDirect orders before and after.
   */
  async safetyNet(): Promise<unknown> {
    const r = (await this.wp(`<?php
$pending = fn() => count(wc_get_orders(['status' => 'pending', 'payment_method' => '${GATEWAY_ID}', 'limit' => -1, 'return' => 'ids']));
$before = $pending();
do_action('${HOOK}');
$after = $pending();
echo json_encode(['ran' => '${HOOK}', 'synced' => $before > 0, 'checked' => $before, 'settled' => $before - $after]), "\\n";`)) as Record<string, unknown>;
    return r;
  }

  /**
   * The core's throttle mark, a transient holding the time of the last sync of the
   * receiving account: it changes exactly when a sync ran. Null before configure().
   */
  async nodeRequests(): Promise<number | null> {
    if (!this.account) return null;
    const r = (await this.wp(`<?php
$value = get_transient('ledger_direct_ledger-direct.sync.v1.testnet.' . $args[0]);
echo json_encode(['value' => $value === false ? null : $value]), "\\n";`, this.account)) as { value: number | string | null };
    return r.value === null ? 0 : Number.parseInt(String(r.value), 10);
  }

  /** Evidence for the report and the platform-state checks of the cases. */
  async orderState(order: PlacedOrder): Promise<Record<string, unknown>> {
    return (await this.wp(`<?php
$order = wc_get_order((int) $args[0]);
$raw = $order->get_meta('_ledger_direct');
$intent = is_string($raw) ? json_decode($raw, true) : $raw;
$status = $order->get_status();
$paid = $order->is_paid();
$hash = $order->get_transaction_id();
echo json_encode([
  'id_order' => $order->get_id(),
  'reference' => $order->get_order_number(),
  'state' => ['name' => $status, 'is_paid' => $paid, 'is_incomplete' => $status === 'pending' && !empty($intent['amount_paid']), 'is_awaiting' => $status === 'pending'],
  'payments' => $hash ? [['transaction_id' => $hash]] : [],
  'total_paid_real' => $paid ? $order->get_total() : '0',
  'intent' => $intent,
]), "\\n";`, order.id)) as Record<string, unknown>;
  }

  // --- helpers ---------------------------------------------------------

  private keyOf(order: PlacedOrder): string {
    return order.id === UNKNOWN_ORDER_ID ? UNKNOWN_KEY : order.secret;
  }

  private pageUrl(order: PlacedOrder): string {
    return `${this.options.baseUrl}/ledger-direct-payment/${this.keyOf(order)}/`;
  }

  private statusUrl(order: PlacedOrder): string {
    return `${this.options.baseUrl}/wp-json/ledger-direct/v1/payment-status/${this.keyOf(order)}`;
  }

  /** A 1.00 article, created once: the catalogue wants small orders, where rounding bites hardest. */
  private async ensureTestProduct(): Promise<string> {
    if (this.testProductId) return this.testProductId;
    const sku = this.options.testProductSku ?? 'LD-E2E-001';
    const r = (await this.wp(`<?php
$id = wc_get_product_id_by_sku($args[0]);
if (!$id) {
  $product = new WC_Product_Simple();
  $product->set_name('LedgerDirect E2E test article');
  $product->set_sku($args[0]);
  $product->set_regular_price('1');
  $product->set_status('publish');
  $product->set_virtual(true);
  $id = $product->save();
}
echo json_encode(['id' => $id]), "\\n";`, sku)) as { id: number };
    return (this.testProductId = String(r.id));
  }

  /** Runs a PHP script inside WordPress through WP-CLI in the running container; the script prints one JSON line. */
  private async wp(script: string, ...args: string[]): Promise<unknown> {
    const argv = [
      'compose',
      ...(this.options.composeFiles ?? []).flatMap((f) => ['-f', f]),
      'exec', '-T', this.options.service ?? 'wp',
      'wp', 'eval-file', '-', ...args, '--allow-root',
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', argv, { cwd: this.options.composeDir });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`WooCommerce: wp-cli exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
      });
      child.stdin.end(script);
    });
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (!line) throw new Error(`WooCommerce: wp-cli printed no JSON: ${stdout.trim().slice(-300)}`);
    return JSON.parse(line) as unknown;
  }
}

function attr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`${name}="([^"]*)"`));
  return m?.[1];
}
