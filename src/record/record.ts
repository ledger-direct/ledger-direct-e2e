import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChainId } from '../chains/chain.js';
import { ledgerFor, treasurySeedVariable } from '../chains/index.js';
import { redact, requireSeed } from '../config.js';
import type { Driver } from '../drivers/driver.js';
import { readPaymentPage } from '../drivers/page.js';
import { ShopSession } from '../session.js';
import { chromePath, launchBrowser, requireFfmpeg, ScreenRecorder, type Browser, type BrowserPage } from './browser.js';
import { buildManifest, type RecordFacts } from './manifest.js';
import { orderedBy, RECORD_FILES, type RecordAsset, type RecordColorScheme, type RecordStart, type VideoSize } from './options.js';
import { findWalkModule, type WalkToPaymentPage } from './walk.js';

/**
 * `ld-e2e record`: a real purchase on the testnet, filmed in a headless browser.
 *
 * --start payment: the driver places the order (as in the catalogue), the browser opens its
 * payment page; filming starts once the page waits with fonts and QR code loaded. After about
 * three seconds the harness pays the displayed amount with the catalogue's payOrder(), nothing is
 * clicked in the browser. Filming goes on until the page shows the payment, follows the redirect
 * to the order confirmation and stops about three seconds later.
 *
 * --start shop: filming starts on the home page; the plugin's walk.mjs goes to the payment page
 * the way a visitor does. The harness pays what that page shows (account, tag, amount), through
 * the spend guard like `ld-e2e pay`, and finishes as above.
 *
 * Nothing on the page is changed for the film; the page polls on its own schedule.
 */
export interface RecordRequest {
  target: string;
  driver: Driver;
  baseUrl: string;
  try: boolean;
  chain: ChainId;
  asset: RecordAsset;
  start: RecordStart;
  /** What the page is told about the viewer's colour preference; the system's is never used. */
  colorScheme: RecordColorScheme;
  size: VideoSize;
  outDir: string;
  harnessVersion: string;
  /** Where walk.mjs is looked for with --start shop: the compose folder, else the container's. */
  composeDir?: string;
  container?: string;
  /** Another sink for the log (stderr, an MCP job); record.log is always written. */
  log?: (line: string) => void;
}

export interface RecordResult {
  outDir: string;
  manifest: Record<string, unknown>;
}

const PAUSE_BEFORE_PAYMENT_MS = 3000;
const PAUSE_ON_CONFIRMATION_MS = 3000;
const SETTLED_TIMEOUT_MS = 180_000;
const SETTLED_STILL_DELAY_MS = 1200;
/** Cookie notices a customer has dismissed long before the payment page (Shopware's). */
const CONSENT_BUTTONS = ['.js-cookie-permission-button'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recordPurchase(request: RecordRequest): Promise<RecordResult> {
  const { outDir, size } = request;
  // Everything that can be checked without spending: the walk, the browser, ffmpeg, the treasury seed.
  // --start shop needs the plugin's walk; --start payment uses it when there is one (see orderedBy).
  const walkModule = request.start === 'shop'
    ? await findWalkModule(request.target, { composeDir: request.composeDir, container: request.container })
    : await findWalkModule(request.target, { composeDir: request.composeDir, container: request.container }).catch(() => undefined);
  chromePath();
  await requireFfmpeg();
  const seed = requireSeed(treasurySeedVariable(request.chain));

  mkdirSync(outDir, { recursive: true });
  const logFile = join(outDir, RECORD_FILES.log);
  writeFileSync(logFile, '');
  const log = (line: string) => {
    const clean = redact(line);
    appendFileSync(logFile, `${new Date().toISOString()} ${clean}\n`);
    request.log?.(clean);
  };

  const facts: RecordFacts = {
    target: request.target,
    baseUrl: request.baseUrl,
    try: request.try,
    chain: request.chain,
    pluginVersion: (await request.driver.pluginVersion?.().catch(() => null)) ?? null,
    harnessVersion: request.harnessVersion,
    asset: request.asset,
    start: request.start,
    colorScheme: request.colorScheme,
    orderedBy: orderedBy(request.start, walkModule),
    size,
    startedAt: new Date(),
    moments: { videoStart: null },
    error: null,
  };
  log(`record ${request.target}${request.try ? ' (try)' : ''}, ${request.asset} on ${request.chain}, start ${request.start}, ${size.width}x${size.height}, ${request.colorScheme} → ${outDir}`);
  if (facts.pluginVersion) log(`plugin ${facts.pluginVersion}`);

  let browser: Browser | undefined;
  let filming: ScreenRecorder | undefined;
  let failureStill: (() => Promise<unknown>) | undefined;
  const stopFilming = async (): Promise<number> => {
    const recorder = filming;
    filming = undefined;
    return recorder ? recorder.stop() : Date.now();
  };
  try {
    browser = await launchBrowser(size);
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: request.colorScheme }]);
    let pageUrl = '';
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && pageUrl && page.url() !== pageUrl && facts.moments.redirect === undefined && facts.moments.pageShowsSettled) {
        facts.moments.redirect = Date.now();
      }
    });
    const still = (name: string) => page.screenshot({ path: join(outDir, name), type: 'png' });
    failureStill = () => still(RECORD_FILES.failure);
    const base = request.baseUrl.replace(/\/$/, '');
    const film = async () => {
      filming = new ScreenRecorder(page, size, join(outDir, RECORD_FILES.video));
      facts.moments.videoStart = await filming.start();
      await still(RECORD_FILES.first);
    };
    const walkToPaymentPage = async () => {
      const walk = (await import(pathToFileURL(walkModule as string).href)) as { walkToPaymentPage?: WalkToPaymentPage };
      if (typeof walk.walkToPaymentPage !== 'function') throw new Error(`${walkModule} exports no walkToPaymentPage(page, { asset, base })`);
      log(`walking to the payment page with ${walkModule}`);
      await walk.walkToPaymentPage(page, { asset: request.asset.toLowerCase(), base, log });
      await paymentPageReady(page);
      pageUrl = page.url();
    };

    if (facts.orderedBy === 'driver') {
      // The catalogue's way: the driver places the order, the harness pays it with payOrder().
      const session = new ShopSession({ driver: () => ({ driver: request.driver, baseUrl: request.baseUrl }) });
      const { entry, page: view } = await session.placeOrder(request.target, request.asset, { chain: request.chain });
      facts.order = { id: entry.order.id, reference: entry.order.reference };
      log(`order ${entry.order.reference}: ${view.amountDisplayed} ${view.asset} to ${view.destinationAccount}, tag ${view.paymentIdentifier}`);
      if (!view.pageUrl) throw new Error(`${request.target}: the driver gave no payment page URL`);
      pageUrl = view.pageUrl;
      // Off camera: the cookie notice a customer dismissed on the way to the checkout, then the page.
      await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
      await dismissConsent(page);
      await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 60_000 });
      await paymentPageReady(page);
      await film();
      facts.moments.paymentPageReached = facts.moments.videoStart;
      log('filming: payment page waiting');
      await sleep(PAUSE_BEFORE_PAYMENT_MS);
      facts.moments.paymentSent = Date.now();
      const paid = await session.payOrder(entry.key);
      facts.moments.transactionValidated = Date.now();
      facts.payment = { amount: view.amountDisplayed, asset: paid.asset, destinationAccount: paid.to, destinationTag: paid.identifier, hash: paid.hash, result: paid.result, ledgerIndex: paid.ledgerIndex, explorer: paid.explorer };
      log(`paid ${paid.paid}: ${paid.result} ${paid.hash}${paid.ledgerIndex ? ` in ledger ${paid.ledgerIndex}` : ''}`);
      if (!paid.validated) throw new Error(`payment failed: ${paid.result}`);
    } else {
      if (request.start === 'payment') {
        // Off camera: the browser orders, so the confirmation at the end is the one this browser may see.
        await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
        await walkToPaymentPage();
        await film();
        facts.moments.paymentPageReached = facts.moments.videoStart;
        log('filming: payment page waiting');
      } else {
        await page.goto(`${base}/`, { waitUntil: 'networkidle0', timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready.then(() => true));
        await film();
        log('filming: home page');
        await walkToPaymentPage();
        facts.moments.paymentPageReached = Date.now();
      }
      const view = readPaymentPage(await page.content());
      if (!view) throw new Error(`the walk ended on ${new URL(pageUrl).pathname}, which is not a readable payment page`);
      if (view.asset && view.asset !== request.asset) throw new Error(`the payment page quotes ${view.asset}, not ${request.asset}`);
      const asset = view.asset ?? request.asset;
      log(`payment page: ${view.amountDisplayed} ${asset} to ${view.destinationAccount}, tag ${view.paymentIdentifier}`);
      await sleep(PAUSE_BEFORE_PAYMENT_MS);
      // What the page shows, through the spend guard, as `ld-e2e pay` sends it.
      const ledger = ledgerFor(request.chain);
      try {
        facts.moments.paymentSent = Date.now();
        const paid = await ledger.pay({ seed, to: view.destinationAccount, identifier: view.paymentIdentifier, amount: view.amountDisplayed, asset });
        facts.moments.transactionValidated = Date.now();
        facts.payment = { amount: view.amountDisplayed, asset, destinationAccount: view.destinationAccount, destinationTag: view.paymentIdentifier, hash: paid.hash, result: paid.result, ledgerIndex: paid.ledgerIndex, explorer: paid.explorer };
        log(`paid ${view.amountDisplayed} ${asset}: ${paid.result} ${paid.hash}${paid.ledgerIndex ? ` in ledger ${paid.ledgerIndex}` : ''}`);
        if (!paid.validated) throw new Error(`payment failed: ${paid.result}`);
      } finally {
        await ledger.close();
      }
    }

    await page.waitForFunction(() => document.querySelector('[data-ld-page]')?.getAttribute('data-ld-state') === 'settled', { timeout: SETTLED_TIMEOUT_MS, polling: 100 });
    facts.moments.pageShowsSettled = Date.now();
    // The still once the page has faded its success panel in, not halfway.
    await sleep(SETTLED_STILL_DELAY_MS);
    await still(RECORD_FILES.settled);
    log('the page shows the payment');
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60_000 });
    facts.moments.redirect ??= Date.now();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    log(`redirected to ${new URL(page.url()).pathname}`);
    await sleep(PAUSE_ON_CONFIRMATION_MS);
    await still(RECORD_FILES.confirmation);
    facts.moments.end = await stopFilming();
  } catch (error) {
    facts.error = redact(error instanceof Error ? error.message : String(error));
    log(`failed: ${facts.error}`);
    // What the browser showed when it went wrong; the page shows testnet data only.
    await failureStill?.().catch(() => undefined);
    throw error;
  } finally {
    const recorder = filming;
    if (recorder) facts.moments.end = await recorder.stop().catch(() => Date.now());
    await browser?.close().catch(() => undefined);
    const manifest = buildManifest(facts);
    writeFileSync(join(outDir, RECORD_FILES.manifest), JSON.stringify(manifest, null, 2) + '\n');
    log(`wrote ${RECORD_FILES.manifest}`);
  }
  return { outDir, manifest: buildManifest(facts) };
}

async function dismissConsent(page: BrowserPage): Promise<void> {
  for (const selector of CONSENT_BUTTONS) {
    const visible = await page.$eval(selector, ((e: HTMLElement) => !!e.offsetParent) as (e: never) => boolean).catch(() => false);
    if (visible) {
      await page.click(selector);
      await sleep(500);
    }
  }
}

/** The page waits, its fonts are loaded, and its QR code (where it has one) is drawn. */
async function paymentPageReady(page: BrowserPage): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-ld-page]');
    if (root?.getAttribute('data-ld-state') !== 'waiting') return false;
    const qr = document.querySelector('[data-ld-qr]');
    if (qr && qr.childElementCount === 0) return false;
    return [...document.images].every((img) => img.complete);
  }, { timeout: 60_000, polling: 100 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
}
