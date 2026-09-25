import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CASES, findCase } from './cases/catalogue.js';
import { CHAINS, isChain, ledgerFor, treasurySeedVariable } from './chains/index.js';
import type { ChainId, Ledger } from './chains/chain.js';
import { redact, requireSeed } from './config.js';
import type { Driver, PlacedOrder } from './drivers/driver.js';
import { createDriver, TARGETS } from './drivers/factory.js';
import { mergeIntoBody, readPrBody, writePrBody } from './report/pr.js';
import { markdown, writeReport } from './report/report.js';
import { resolveCaseIds, runCases } from './runner/run.js';

/**
 * The MCP server: the same functions as the CLI, as tools for a coding
 * session or an agent. Three groups — shopping and paying, wallets, the
 * case catalogue — over one kernel.
 *
 * Rules that hold for every tool:
 * - Testnet only. There is no mainnet URL in this program; a mainnet mode
 *   is a separate decision, to follow once the canary token exists.
 * - No seed ever leaves the process. A fresh account's seed stays in
 *   memory; tools return addresses, hashes and states.
 * - A payment above LD_E2E_MAX_PAYMENT (in the asset's units) is refused,
 *   not questioned: the agent reads the amount off the page, the server
 *   caps what it will sign.
 * - Every payment answers with the hash and an explorer link, so the agent
 *   can show evidence instead of claiming success.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'ledger-direct-e2e', version: '0.1.0' });
  const orders = new Map<string, { order: PlacedOrder; target: string; asset: string }>();
  const freshSeeds = new Map<string, string>();
  const jobs = new Map<string, { status: 'running' | 'done' | 'failed'; startedAt: string; log: string[]; result?: unknown; error?: string }>();
  const maxPayment = Number.parseFloat(process.env.LD_E2E_MAX_PAYMENT ?? '50');

  const targetSchema = z.enum(TARGETS).describe('the shop under test');
  const chainSchema = z.enum(['XRPL', 'STELLAR']).default('XRPL').describe('the chain; XRPL by default');

  function text(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
    return { content: [{ type: 'text', text: redact(typeof data === 'string' ? data : JSON.stringify(data, null, 2)) }] };
  }

  // Drivers keep per-order secrets in memory (Shopware's deepLinkCode and return URL); one instance per target.
  const drivers = new Map<string, { driver: Driver; baseUrl: string }>();
  const shop = (target: string): { driver: Driver; baseUrl: string } => {
    let d = drivers.get(target);
    if (!d) drivers.set(target, (d = createDriver(target)));
    return d;
  };
  const driver = (target: string): Driver => shop(target).driver;

  async function withLedger<T>(chain: ChainId, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
    const ledger = ledgerFor(chain);
    try {
      return await fn(ledger);
    } finally {
      await ledger.close();
    }
  }

  const knownOrder = (orderId: string): { order: PlacedOrder; target: string; asset: string } => {
    const entry = orders.get(orderId);
    if (!entry) throw new Error(`order ${orderId} was not placed in this session; place it with shop_place_order first`);
    return entry;
  };

  // --- shopping and paying ------------------------------------------------

  server.registerTool('shop_search_products', {
    title: 'Search products',
    description: 'Products matching a free-text query in the shop, as a customer would search. Returns id, number, name and gross price; pick one for shop_place_order.',
    inputSchema: { target: targetSchema, query: z.string().min(1) },
  }, async ({ target, query }) => text(await driver(target).findProducts(query)));

  server.registerTool('shop_place_order', {
    title: 'Place an order',
    description: 'Places an order for a product paid with a LedgerDirect asset and reads the payment page: what to send, where, with which identifier. Nothing is paid yet.',
    inputSchema: {
      target: targetSchema,
      asset: z.enum(['XRP', 'RLUSD', 'USDC']).describe('the asset the order is quoted in'),
      productId: z.string().optional().describe('from shop_search_products; the shop\'s cheap test article when absent'),
      quantity: z.number().int().min(1).max(100).default(1),
    },
  }, async ({ target, asset, productId, quantity }) => {
    const d = driver(target);
    const order = await d.placeOrder(asset, { productId, quantity });
    const page = await d.paymentPage(order);
    orders.set(order.id, { order, target, asset });
    return text({ orderId: order.id, reference: order.reference, paymentPage: page });
  });

  server.registerTool('shop_pay_order', {
    title: 'Pay an order',
    description: `Reads the amount, account and identifier off the order's payment page and pays exactly that from the chain treasury (testnet). Refuses amounts above ${maxPayment}. Returns the transaction hash and explorer link.`,
    inputSchema: {
      orderId: z.string(),
      asset: z.enum(['XRP', 'RLUSD', 'USDC']).optional().describe('send another asset than quoted to provoke the wrong-asset case'),
      chain: chainSchema,
    },
  }, async ({ orderId, asset, chain }) => {
    const { order, target } = knownOrder(orderId);
    const page = await driver(target).paymentPage(order);
    if (Number.parseFloat(page.amountDisplayed) > maxPayment) throw new Error(`refusing to pay ${page.amountDisplayed} ${page.asset}: above LD_E2E_MAX_PAYMENT (${maxPayment})`);
    const result = await withLedger(chain, (ledger) => ledger.pay({
      seed: requireSeed(treasurySeedVariable(ledger.chain)),
      to: page.destinationAccount,
      identifier: page.paymentIdentifier,
      amount: page.amountDisplayed,
      asset: asset ?? page.asset,
    }));
    if (!result.validated) throw new Error(`payment failed on the ledger: ${result.result} (tx ${result.hash}, ${result.explorer}). Check the treasury balance with wallet_status.`);
    return text({ paid: `${page.amountDisplayed} ${asset ?? page.asset}`, to: page.destinationAccount, identifier: page.paymentIdentifier, ...result });
  });

  server.registerTool('shop_order_status', {
    title: 'Order status',
    description: 'The payment-status payload of the shop for an order placed in this session: state, amounts, seconds left, redirect once closed.',
    inputSchema: { orderId: z.string() },
  }, async ({ orderId }) => {
    const { order, target } = knownOrder(orderId);
    return text(await driver(target).status(order));
  });

  server.registerTool('shop_wait_for', {
    title: 'Wait for a state',
    description: 'Polls the status endpoint every 8 s until the order reaches the state (or a redirect appears). Bounded to 50 s so it fits a client timeout; call again if it reports no state yet.',
    inputSchema: {
      orderId: z.string(),
      state: z.enum(['waiting', 'partial', 'wrong_asset', 'settled', 'expired', 'redirect']),
      timeoutSeconds: z.number().int().min(8).max(50).default(50),
    },
  }, async ({ orderId, state, timeoutSeconds }) => {
    const { order, target } = knownOrder(orderId);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const status = await driver(target).status(order);
      if (seen[seen.length - 1] !== status.state) seen.push(status.state);
      if (status.state === state || (state === 'redirect' && status.redirect !== undefined) || status.redirect !== undefined) {
        return text({ reached: status.state, redirect: status.redirect ?? null, seen, status });
      }
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }
    return text({ reached: null, seen, note: `timed out after ${timeoutSeconds} s` });
  });

  server.registerTool('shop_order_evidence', {
    title: 'Order evidence',
    description: 'What the platform recorded for an order: state name, payment records, stored payment intent (hash, amount paid).',
    inputSchema: { orderId: z.string() },
  }, async ({ orderId }) => {
    const { order, target } = knownOrder(orderId);
    const d = driver(target) as Driver & { orderState?: (o: PlacedOrder) => Promise<Record<string, unknown>> };
    if (!d.orderState) return text({ note: `${target} exposes no platform state` });
    return text(await d.orderState(order));
  });

  // --- wallets ------------------------------------------------------------

  server.registerTool('wallet_status', {
    title: 'Wallet status',
    description: 'Native and token balances of the chain treasury, or of any address.',
    inputSchema: { chain: chainSchema, address: z.string().optional() },
  }, async ({ chain, address }) => withLedger(chain, async (ledger) => {
    const target = address ?? ledger.addressOf(requireSeed(treasurySeedVariable(ledger.chain)));
    return text(await ledger.balances(target));
  }));

  server.registerTool('wallet_fresh', {
    title: 'Fresh account',
    description: 'A new funded testnet account, e.g. a receiving account for a shop. Returns the address only; the seed stays inside the server.',
    inputSchema: { chain: chainSchema, trustlines: z.boolean().default(true) },
  }, async ({ chain, trustlines }) => withLedger(chain, async (ledger) => {
    const created = await ledger.createFresh({ trustlines });
    freshSeeds.set(created.address, created.seed);
    return text({ chain, address: created.address, trustlines: created.trustlines });
  }));

  server.registerTool('wallet_fund', {
    title: 'Faucet top-up',
    description: 'Asks the chain faucet (XRPL faucet, Stellar Friendbot) to fund an account.',
    inputSchema: { chain: chainSchema, address: z.string() },
  }, async ({ chain, address }) => withLedger(chain, async (ledger) => text(await ledger.fund(address))));

  server.registerTool('pay', {
    title: 'Send a payment',
    description: `One payment from the chain treasury: exact amount, receiving account, identifier (destination tag or memo id), asset. For the catalogue's deliberate wrong payments; shop_pay_order is the safe path. Refuses amounts above ${maxPayment}.`,
    inputSchema: {
      chain: chainSchema,
      to: z.string(),
      amount: z.string().describe('decimal string, exactly as displayed'),
      identifier: z.string().optional(),
      asset: z.string().optional().describe('the chain\'s native asset when absent'),
    },
  }, async ({ chain, to, amount, identifier, asset }) => {
    if (Number.parseFloat(amount) > maxPayment) throw new Error(`refusing to pay ${amount}: above LD_E2E_MAX_PAYMENT (${maxPayment})`);
    return withLedger(chain, async (ledger) => {
      const result = await ledger.pay({ seed: requireSeed(treasurySeedVariable(ledger.chain)), to, identifier, amount, asset: asset ?? ledger.nativeAsset });
      if (!result.validated) throw new Error(`payment failed on the ledger: ${result.result} (tx ${result.hash}, ${result.explorer})`);
      return text(result);
    });
  });

  // --- the catalogue --------------------------------------------------------

  server.registerTool('list_cases', {
    title: 'List cases',
    description: 'The payment-status case catalogue PS-01…PS-11 with what each case proves.',
    inputSchema: {},
  }, async () => text(CASES));

  server.registerTool('run_cases', {
    title: 'Run cases',
    description: 'Starts catalogue cases against a shop on the testnet (fresh receiving account, JSON report) as a background job and returns its id at once — a run takes minutes. Poll it with job_status.',
    inputSchema: {
      target: targetSchema,
      cases: z.string().default('automated').describe('comma-separated IDs, "automated" or "all"'),
      chain: chainSchema,
      report: z.string().default('out/report.json'),
    },
  }, async ({ target, cases, chain, report }) => {
    const ids = resolveCaseIds(cases);
    for (const id of ids) if (!findCase(id)) throw new Error(`no such case ${id}`);
    const jobId = `run-${Date.now().toString(36)}`;
    const job: { status: 'running' | 'done' | 'failed'; startedAt: string; log: string[]; result?: unknown; error?: string } = { status: 'running', startedAt: new Date().toISOString(), log: [] };
    jobs.set(jobId, job);
    void runCases({
      driver: driver(target),
      ledger: ledgerFor(chain),
      baseUrl: shop(target).baseUrl,
      caseIds: ids,
      timeoutMs: 240_000,
      version: '0.1.0',
      log: (line) => job.log.push(redact(line)),
    }).then(async (result) => {
      await writeReport(result, report);
      job.result = { report, checklist: markdown(result) };
      job.status = 'done';
    }).catch((error: unknown) => {
      job.error = redact(error instanceof Error ? error.message : String(error));
      job.status = 'failed';
    });
    return text({ jobId, cases: ids, note: 'running in the background; poll job_status' });
  });

  server.registerTool('job_status', {
    title: 'Job status',
    description: 'Progress of a background run: status, the log so far, and the checklist once done.',
    inputSchema: { jobId: z.string() },
  }, async ({ jobId }) => {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    return text(job);
  });

  server.registerTool('report_pr', {
    title: 'Write results into a pull request',
    description: 'Ticks the cases in the PR\'s "Manual end-to-end tests" section from a JSON report, with hashes; runs as the gh user.',
    inputSchema: { repo: z.string(), pr: z.number().int(), report: z.string().default('out/report.json'), dryRun: z.boolean().default(false) },
  }, async ({ repo, pr, report, dryRun }) => {
    const data = JSON.parse(await readFile(report, 'utf8'));
    const merged = mergeIntoBody(await readPrBody(repo, pr), data);
    if (!dryRun) await writePrBody(repo, pr, merged.body);
    return text({ dryRun, replaced: merged.replaced, added: merged.missing, body: dryRun ? merged.body : undefined });
  });

  void isChain;
  void CHAINS;
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
