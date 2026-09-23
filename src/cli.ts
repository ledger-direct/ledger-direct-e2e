#!/usr/bin/env node
import { Command } from 'commander';
import { Wallet } from 'xrpl';
import { isAsset } from './assets.js';
import { CASES, findCase } from './cases/catalogue.js';
import { ENV_TREASURY_SEED, optionalAddress, redact, requireSeed } from './config.js';
import { withClient } from './ledger/client.js';
import { bookOffers, buy } from './ledger/dex.js';
import { pay } from './ledger/payments.js';
import { assetsWithoutXrp, balances, createFresh, faucet } from './ledger/wallets.js';
import { PrestaShopDriver } from './drivers/prestashop.js';
import { markdown, writeReport } from './report/report.js';
import { mergeIntoBody, readPrBody, writePrBody } from './report/pr.js';
import { resolveCaseIds, runCases } from './runner/run.js';
import { readFile } from 'node:fs/promises';

const program = new Command();
program
  .name('ld-e2e')
  .description('LedgerDirect end-to-end harness — XRPL testnet wallets, payments, and the PS-01…PS-11 catalogue')
  .option('--json', 'machine-readable output')
  .version('0.1.0');

function out(data: unknown, human: () => string): void {
  const json = program.opts().json as boolean | undefined;
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human()) + '\n');
}

const wallet = program.command('wallet').description('testnet wallets: treasury, fresh receiving accounts, top-ups');

wallet
  .command('status [address]')
  .description('XRP and token balances; defaults to the treasury address from the environment')
  .action(async (address?: string) => {
    const target = address ?? optionalAddress() ?? Wallet.fromSeed(requireSeed()).classicAddress;
    const b = await withClient((c) => balances(c, target));
    out(b, () => [
      `account   ${b.address}`,
      `XRP       ${b.xrp}`,
      ...assetsWithoutXrp().map((a) => `${a.padEnd(9)} ${b.tokens[a] ?? (b.trustlines.includes(a) ? '0' : '— (no trust line)')}`),
    ].join('\n'));
  });

wallet
  .command('fresh')
  .description('a brand-new faucet account, e.g. the receiving account for one run — prints the seed once, store it in the environment')
  .option('--trustlines', 'set trust lines to RLUSD and USDC', false)
  .action(async (opts: { trustlines: boolean }) => {
    const created = await withClient((c) => createFresh(c, { trustlines: opts.trustlines }));
    const data = { address: created.wallet.classicAddress, seed: created.wallet.seed, trustlines: created.trustlines };
    out(data, () => [
      `address    ${data.address}`,
      `seed       ${data.seed}   (shown once — put it in the environment, never in a repo)`,
      ...Object.entries(data.trustlines).map(([a, r]) => `trustline  ${a} ${r}`),
    ].join('\n'));
  });

wallet
  .command('fund <address>')
  .description('ask the faucet to top up an existing account with XRP')
  .action(async (address: string) => {
    const r = await faucet(address);
    out(r, () => `faucet sent ${r.amount} XRP to ${r.address}`);
  });

wallet
  .command('top-up')
  .description('buy stablecoins for the treasury on the testnet DEX (immediate-or-cancel)')
  .option('--rlusd <value>', 'RLUSD to buy')
  .option('--usdc <value>', 'USDC to buy')
  .option('--max-xrp <value>', 'XRP to spend per purchase at most', '50')
  .option('--seed-env <variable>', 'environment variable holding the seed', ENV_TREASURY_SEED)
  .action(async (opts: { rlusd?: string; usdc?: string; maxXrp: string; seedEnv: string }) => {
    const w = Wallet.fromSeed(requireSeed(opts.seedEnv));
    const results = await withClient(async (c) => {
      const r: Record<string, unknown> = {};
      if (opts.rlusd) r.RLUSD = await buy(c, w, 'RLUSD', opts.rlusd, opts.maxXrp);
      if (opts.usdc) r.USDC = await buy(c, w, 'USDC', opts.usdc, opts.maxXrp);
      r.balances = await balances(c, w.classicAddress);
      return r;
    });
    out(results, () => redact(JSON.stringify(results, null, 2)));
  });

wallet
  .command('book <asset>')
  .description('the best DEX offers selling RLUSD or USDC for XRP')
  .action(async (asset: string) => {
    if (!isAsset(asset) || asset === 'XRP') throw new Error('asset must be RLUSD or USDC');
    const offers = await withClient((c) => bookOffers(c, asset));
    out(offers, () => (offers.length === 0 ? 'no offers' : offers.map((o) => `${o.gives}  for  ${o.wants}`).join('\n')));
  });

program
  .command('pay')
  .description('send one payment the way a customer wallet would: exact displayed amount, destination tag, chosen asset')
  .requiredOption('--to <address>', 'receiving account shown on the payment page')
  .requiredOption('--amount <decimal>', 'the amount exactly as the page displays it')
  .option('--tag <number>', 'destination tag shown on the payment page')
  .option('--asset <XRP|RLUSD|USDC>', 'asset to send (send another one than quoted to produce PS-04)', 'XRP')
  .option('--partial', 'tfPartialPayment', false)
  .option('--deliver-min <decimal>', 'DeliverMin for a partial payment')
  .option('--seed-env <variable>', 'environment variable holding the payer seed', ENV_TREASURY_SEED)
  .action(async (opts: { to: string; amount: string; tag?: string; asset: string; partial: boolean; deliverMin?: string; seedEnv: string }) => {
    const asset = opts.asset;
    if (!isAsset(asset)) throw new Error(`unknown asset ${asset}`);
    const result = await withClient((c) => pay(c, {
      seed: requireSeed(opts.seedEnv),
      to: opts.to,
      destinationTag: opts.tag === undefined ? undefined : Number.parseInt(opts.tag, 10),
      amount: opts.amount,
      asset,
      partial: opts.partial,
      deliverMin: opts.deliverMin,
    }));
    out(result, () => [
      `result     ${result.result}${result.validated ? ' (validated)' : ''}`,
      `hash       ${result.hash}`,
      `delivered  ${result.delivered ?? '—'}`,
      `from       ${result.from}`,
      `explorer   ${result.explorer}`,
    ].join('\n'));
  });

const cases = program.command('cases').description('the PS-01…PS-11 catalogue');
cases
  .command('list')
  .action(() => out(CASES, () => CASES.map((c) => `${c.id}  ${c.title}${c.nightlyOnly ? '  (nightly only)' : ''}`).join('\n')));
cases
  .command('show <id>')
  .action((id: string) => {
    const c = findCase(id);
    if (!c) throw new Error(`no such case ${id}`);
    out(c, () => [`${c.id} — ${c.title}`, `asset: ${c.asset}`, c.summary, ...c.expects.map((e) => `  - ${e}`)].join('\n'));
  });

program
  .command('run')
  .description('run catalogue cases against a plugin and write the report')
  .requiredOption('--target <plugin>', 'prestashop (shopware, woocommerce, magento: drivers pending)')
  .option('--base-url <url>', 'how the shop is reached from here', 'http://localhost:8080')
  .option('--compose-dir <dir>', 'folder with the shop\'s docker-compose.yml (PrestaShop driver)', process.env.LD_E2E_PRESTASHOP_COMPOSE_DIR ?? '.')
  .option('--cases <ids>', 'comma-separated case IDs, "automated", or "all"', 'automated')
  .option('--receiving-account <address>', 'reuse an account instead of creating a fresh one (debugging)')
  .option('--timeout <seconds>', 'per-case wait for a state', '180')
  .option('--report <file>', 'JSON report path', 'out/report.json')
  .action(async (opts: { target: string; baseUrl: string; composeDir: string; cases: string; receivingAccount?: string; timeout: string; report: string }) => {
    if (opts.target !== 'prestashop') throw new Error(`no driver for ${opts.target} yet — see src/drivers/driver.ts`);
    const driver = new PrestaShopDriver({ composeDir: opts.composeDir, baseUrl: opts.baseUrl });
    const report = await runCases({
      driver,
      baseUrl: opts.baseUrl,
      caseIds: resolveCaseIds(opts.cases),
      receivingAccount: opts.receivingAccount,
      timeoutMs: Number.parseInt(opts.timeout, 10) * 1000,
      version: program.version() ?? '0.0.0',
      log: (line) => process.stderr.write(redact(line) + '\n'),
    });
    await writeReport(report, opts.report);
    const failed = report.results.filter((r) => r.outcome === 'fail').length;
    out(report, () => markdown(report) + `\nreport: ${opts.report}`);
    if (failed > 0) process.exitCode = 1;
  });

const reportCmd = program.command('report').description('turn a report into evidence where it belongs');
reportCmd
  .command('markdown')
  .option('--from <file>', 'JSON report', 'out/report.json')
  .action(async (opts: { from: string }) => {
    const report = JSON.parse(await readFile(opts.from, 'utf8'));
    process.stdout.write(markdown(report));
  });
reportCmd
  .command('pr')
  .description('tick the cases in a pull request\'s "Manual end-to-end tests" section, with hashes')
  .requiredOption('--repo <owner/name>')
  .requiredOption('--pr <number>')
  .option('--from <file>', 'JSON report', 'out/report.json')
  .option('--dry-run', 'print the new body instead of writing it', false)
  .action(async (opts: { repo: string; pr: string; from: string; dryRun: boolean }) => {
    const report = JSON.parse(await readFile(opts.from, 'utf8'));
    const body = await readPrBody(opts.repo, Number.parseInt(opts.pr, 10));
    const merged = mergeIntoBody(body, report);
    if (opts.dryRun) {
      process.stdout.write(merged.body + '\n');
      process.stderr.write(`would replace ${merged.replaced.join(', ') || 'nothing'}; would add ${merged.missing.join(', ') || 'nothing'}\n`);
      return;
    }
    await writePrBody(opts.repo, Number.parseInt(opts.pr, 10), merged.body);
    out({ replaced: merged.replaced, added: merged.missing }, () => `updated ${opts.repo}#${opts.pr}: replaced ${merged.replaced.join(', ') || 'nothing'}, added ${merged.missing.join(', ') || 'nothing'}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(redact(message) + '\n');
  process.exit(1);
});
