import { spawn } from 'node:child_process';
import type { Driver, OrderOptions, PaymentPageView, PlacedOrder, Product, ShopConfig, StatusPayload } from './driver.js';
import { httpFetch } from '../http.js';
import { readPaymentPage } from './page.js';
import { chainForAsset } from './chains.js';
import { throttleKeys } from './throttle.js';

export interface WooCommerceOptions {
  /** The folder with the WordPress docker-compose.yml — the one that has a WP-CLI service. */
  composeDir: string;
  /** Compose files to pass with -f, in order; the folder's default file when empty. */
  composeFiles?: string[];
  /** A running compose project to address by name (`docker compose -p`) instead of the folder. */
  composeProject?: string;
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
/** The gateway's payment type (`ledger_direct_payment_type`) per chain and asset (plugin 1.5.0 for Xahau). */
const PAYMENT_TYPES: Record<string, Record<string, string>> = {
  XRPL: { XRP: 'xrp', RLUSD: 'rlusd', USDC: 'usdc' },
  XAHAU: { XAH: 'xah' },
};
const ASSETS_BY_CHAIN = Object.fromEntries(Object.entries(PAYMENT_TYPES).map(([c, m]) => [c, Object.keys(m)]));

/**
 * The gateway settings a ShopConfig means: the chain's own keys (`xrpl_*` for the XRP Ledger,
 * `xahau_*` for Xahau, which also has a switch of its own), the quote expiry in minutes, one
 * minute at least. The other chain's keys are not touched.
 */
export function woocommerceSettings(config: ShopConfig): { chain: string; settings: Record<string, string | number> } {
  const chain = (config.chain || 'XRPL').toUpperCase();
  if (!PAYMENT_TYPES[chain]) throw new Error(`WooCommerce: no payment types on ${chain}`);
  const minutes = Math.max(1, Math.round(config.quoteExpirySeconds / 60));
  const settings: Record<string, string | number> = { enabled: 'yes', xrpl_quote_expiry: minutes };
  if (chain === 'XRPL') {
    settings.xrpl_network = 'testnet';
    settings.xrpl_testnet_destination_account = config.destinationAccount;
    settings.xrpl_is_rlusd_enabled = config.assets.includes('RLUSD') ? 'yes' : 'no';
    settings.xrpl_is_usdc_enabled = config.assets.includes('USDC') ? 'yes' : 'no';
  } else {
    const prefix = chain.toLowerCase();
    settings[`${prefix}_enabled`] = 'yes';
    settings[`${prefix}_network`] = 'testnet';
    settings[`${prefix}_testnet_destination_account`] = config.destinationAccount;
  }
  return { chain, settings };
}

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
  /** The chain configure() last pointed the shop at; XRPL until then. */
  private chain = 'XRPL';
  private testProductId?: string;
  private readonly assetOf = new Map<string, string>();

  constructor(private readonly options: WooCommerceOptions) {}

  async configure(config: ShopConfig): Promise<void> {
    const { chain, settings } = woocommerceSettings(config);
    await this.wp(`<?php
$settings = get_option('${SETTINGS_OPTION}', []);
$settings = array_merge(is_array($settings) ? $settings : [], json_decode($args[0], true, 512, JSON_THROW_ON_ERROR));
update_option('${SETTINGS_OPTION}', $settings);
echo json_encode(['ok' => true]), "\\n";`, JSON.stringify(settings));
    this.chain = chain;
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
    const paymentType = PAYMENT_TYPES[chainForAsset(this.chain, asset, ASSETS_BY_CHAIN)][asset];
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
    const response = await httpFetch(this.pageUrl(order), { redirect: 'manual' });
    if (response.status !== 200) throw new Error(`WooCommerce: payment page answered ${response.status}`);
    const html = await response.text();
    const page = readPaymentPage(html);
    if (!page) throw new Error(`WooCommerce: payment page for order ${order.id} did not render the markup contract`);
    return { ...page, asset: page.asset ?? this.assetOf.get(order.id) ?? 'XRP', statusUrl: this.statusUrl(order), pageUrl: this.pageUrl(order) };
  }

  async status(order: PlacedOrder): Promise<StatusPayload> {
    const response = await httpFetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`WooCommerce: status endpoint answered ${response.status}`);
    return (await response.json()) as StatusPayload;
  }

  async statusResponse(order: PlacedOrder): Promise<{ status: number; body: string }> {
    const response = await httpFetch(this.statusUrl(order), { headers: { Accept: 'application/json' } });
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
    const response = await httpFetch(this.pageUrl(order), { redirect: 'manual' });
    return { status: response.status };
  }

  /** The "get an updated amount" form of the expired block: a POST with the nonce the page rendered. */
  async refresh(order: PlacedOrder): Promise<void> {
    const html = await (await httpFetch(this.pageUrl(order), { redirect: 'manual' })).text();
    const nonce = html.match(/name="_wpnonce" value="([^"]+)"/)?.[1];
    if (!nonce) throw new Error(`WooCommerce: the payment page for order ${order.id} shows no refresh form (quote not expired?)`);
    await httpFetch(this.pageUrl(order), {
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
$value = false;
foreach (json_decode($args[0], true, 512, JSON_THROW_ON_ERROR) as $key) {
  if ($value === false) { $value = get_transient('ledger_direct_' . $key); }
}
echo json_encode(['value' => $value === false ? null : $value]), "\\n";`, JSON.stringify(throttleKeys(this.chain, 'testnet', this.account)))) as { value: number | string | null };
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
  // Since plugin 1.4.0 a payment that does not settle moves the order to its own status, ld-incomplete
  // ("XRPL payment incomplete"); before, it stayed pending and only the intent told.
  'state' => ['name' => $status, 'is_paid' => $paid, 'is_incomplete' => $status === 'ld-incomplete' || ($status === 'pending' && !empty($intent['amount_paid'])), 'is_awaiting' => in_array($status, ['pending', 'ld-incomplete'], true)],
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

  async recordedHashes(destinationAccount: string, paymentIdentifier: string): Promise<string[]> {
    const answer = (await this.wp(`<?php
// The chain's sync service (plugin 1.5.0 takes the chain; an older plugin ignores the argument and answers for the XRP Ledger).
$transactions = \\Hardcastle\\LedgerDirect\\Service\\ServiceFactory::getInstance()->getSyncService($args[2])->findTransactions($args[0], (int) $args[1]);
echo json_encode(['hashes' => array_map(static fn ($t) => $t->hash, $transactions)]), "\\n";`, destinationAccount, paymentIdentifier, this.chain)) as { hashes?: string[] };
    return answer.hashes ?? [];
  }

  /** Runs a PHP script inside WordPress through WP-CLI in the running container; the script prints one JSON line. */
  private async wp(script: string, ...args: string[]): Promise<unknown> {
    const argv = [
      'compose',
      ...(this.options.composeFiles ?? []).flatMap((f) => ['-f', f]),
      ...(this.options.composeProject ? ['-p', this.options.composeProject] : []),
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

