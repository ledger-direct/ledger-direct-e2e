#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { Wallet } from 'xrpl';
import { CASES, findCase } from './cases/catalogue.js';
import { CHAINS, isChain, ledgerFor, treasurySeedVariable } from './chains/index.js';
import { isAsset } from './chains/xrpl/assets.js';
import { withClient } from './chains/xrpl/client.js';
import { bookOffers, buy } from './chains/xrpl/dex.js';
import { balances as xrplBalances } from './chains/xrpl/wallets.js';
import { optionalAddress, redact, requireSeed } from './config.js';
import { PrestaShopDriver } from './drivers/prestashop.js';
import { mergeIntoBody, readPrBody, writePrBody } from './report/pr.js';
import { markdown, writeReport } from './report/report.js';
import { resolveCaseIds, runCases } from './runner/run.js';

const program = new Command();
program
  .name('ld-e2e')
  .description('LedgerDirect end-to-end harness — testnet wallets, payments, and the PS-01…PS-11 catalogue, on XRPL and Stellar')
  .option('--json', 'machine-readable output')
  .option('--chain <chain>', `chain to operate on: ${CHAINS.join(' | ')}`, 'XRPL')
  .version('0.1.0');

function out(data: unknown, human: () => string): void {
  const json = program.opts().json as boolean | undefined;
  process.stdout.write((json ? JSON.stringify(data, null, 2) : human()) + '\n');
}

function chain(): 'XRPL' | 'STELLAR' {
  const value = String(program.opts().chain);
  if (!isChain(value)) throw new Error(`unknown chain ${value}; known: ${CHAINS.join(', ')}`);
  return value.toUpperCase() as 'XRPL' | 'STELLAR';
}

const wallet = program.command('wallet').description('testnet wallets: treasury, fresh receiving accounts, top-ups');

wallet
  .command('status [address]')
  .description('native and token balances; defaults to the treasury of the chain')
  .action(async (address?: string) => {
    const ledger = ledgerFor(chain());
    try {
      const target = address ?? optionalAddress(treasurySeedVariable(ledger.chain).replace('_SEED', '_ADDRESS')) ?? ledger.addressOf(requireSeed(treasurySeedVariable(ledger.chain)));
      const b = await ledger.balances(target);
      out(b, () => [
        `chain     ${ledger.chain}`,
        `account   ${b.address}`,
        `${ledger.nativeAsset.padEnd(9)} ${b.native}`,
        ...ledger.assets().filter((a) => !a.native).map((a) => `${a.code.padEnd(9)} ${b.tokens[a.code] ?? (b.trustlines.includes(a.code) ? '0' : '— (no trust line)')}`),
      ].join('\n'));
    } finally {
      await ledger.close();
    }
  });

wallet
  .command('fresh')
  .description('a brand-new faucet account, e.g. the receiving account for one run — prints the seed once, store it in the environment')
  .option('--trustlines', 'set trust lines to the issued assets', false)
  .action(async (opts: { trustlines: boolean }) => {
    const ledger = ledgerFor(chain());
    try {
      const created = await ledger.createFresh({ trustlines: opts.trustlines });
      out(created, () => [
        `chain      ${ledger.chain}`,
        `address    ${created.address}`,
        `seed       ${created.seed}   (shown once — put it in the environment, never in a repo)`,
        ...Object.entries(created.trustlines).map(([a, r]) => `trustline  ${a} ${r}`),
      ].join('\n'));
    } finally {
      await ledger.close();
    }
  });

wallet
  .command('fund <address>')
  .description('ask the faucet (XRPL) or Friendbot (Stellar) to top up an account')
  .action(async (address: string) => {
    const ledger = ledgerFor(chain());
    try {
      const r = await ledger.fund(address);
      out(r, () => `faucet sent ${r.amount} ${ledger.nativeAsset} to ${r.address}`);
    } finally {
      await ledger.close();
    }
  });

wallet
  .command('top-up')
  .description('XRPL: buy stablecoins for the treasury on the testnet DEX (immediate-or-cancel)')
  .option('--rlusd <value>', 'RLUSD to buy')
  .option('--usdc <value>', 'USDC to buy')
  .option('--max-xrp <value>', 'XRP to spend per purchase at most', '50')
  .option('--seed-env <variable>', 'environment variable holding the seed', 'LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED')
  .action(async (opts: { rlusd?: string; usdc?: string; maxXrp: string; seedEnv: string }) => {
    if (chain() !== 'XRPL') throw new Error('top-up via DEX exists for XRPL only; on Stellar issue a test asset or use a faucet');
    const w = Wallet.fromSeed(requireSeed(opts.seedEnv));
    const results = await withClient(async (c) => {
      const r: Record<string, unknown> = {};
      if (opts.rlusd) r.RLUSD = await buy(c, w, 'RLUSD', opts.rlusd, opts.maxXrp);
      if (opts.usdc) r.USDC = await buy(c, w, 'USDC', opts.usdc, opts.maxXrp);
      r.balances = await xrplBalances(c, w.classicAddress);
      return r;
    });
    out(results, () => redact(JSON.stringify(results, null, 2)));
  });

wallet
  .command('book <asset>')
  .description('XRPL: the best DEX offers selling RLUSD or USDC for XRP')
  .action(async (asset: string) => {
    if (!isAsset(asset) || asset === 'XRP') throw new Error('asset must be RLUSD or USDC');
    const offers = await withClient((c) => bookOffers(c, asset));
    out(offers, () => (offers.length === 0 ? 'no offers' : offers.map((o) => `${o.gives}  for  ${o.wants}`).join('\n')));
  });

program
  .command('pay')
  .description('send one payment the way a customer wallet would: exact displayed amount, payment identifier, chosen asset')
  .requiredOption('--to <address>', 'receiving account shown on the payment page')
  .requiredOption('--amount <decimal>', 'the amount exactly as the page displays it')
  .option('--id <identifier>', 'destination tag (XRPL) or memo id (Stellar) shown on the payment page')
  .option('--tag <number>', 'alias of --id')
  .option('--asset <code>', 'asset to send; the native one by default (send another one than quoted to produce PS-04)')
  .option('--partial', 'XRPL: tfPartialPayment', false)
  .option('--seed-env <variable>', 'environment variable holding the payer seed (defaults to the chain treasury)')
  .action(async (opts: { to: string; amount: string; id?: string; tag?: string; asset?: string; partial: boolean; seedEnv?: string }) => {
    const ledger = ledgerFor(chain());
    try {
      const result = await ledger.pay({
        seed: requireSeed(opts.seedEnv ?? treasurySeedVariable(ledger.chain)),
        to: opts.to,
        identifier: opts.id ?? opts.tag,
        amount: opts.amount,
        asset: opts.asset ?? ledger.nativeAsset,
        partial: opts.partial,
      });
      out(result, () => [
        `result     ${result.result}${result.validated ? ' (validated)' : ''}`,
        `hash       ${result.hash}`,
        `delivered  ${result.delivered ?? '—'}`,
        `from       ${result.from}`,
        `explorer   ${result.explorer}`,
      ].join('\n'));
    } finally {
      await ledger.close();
    }
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
  .option('--compose-dir <dir>', "folder with the shop's docker-compose.yml (PrestaShop driver)", process.env.LD_E2E_PRESTASHOP_COMPOSE_DIR ?? '.')
  .option('--cases <ids>', 'comma-separated case IDs, "automated", or "all"', 'automated')
  .option('--receiving-account <address>', 'reuse an account instead of creating a fresh one (debugging)')
  .option('--timeout <seconds>', 'per-case wait for a state', '240')
  .option('--report <file>', 'JSON report path', 'out/report.json')
  .action(async (opts: { target: string; baseUrl: string; composeDir: string; cases: string; receivingAccount?: string; timeout: string; report: string }) => {
    if (opts.target !== 'prestashop') throw new Error(`no driver for ${opts.target} yet — see src/drivers/driver.ts`);
    const driver = new PrestaShopDriver({ composeDir: opts.composeDir, baseUrl: opts.baseUrl });
    const report = await runCases({
      driver,
      ledger: ledgerFor(chain()),
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
