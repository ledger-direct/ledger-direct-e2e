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
  .description('run catalogue cases against a plugin (drivers not implemented yet)')
  .requiredOption('--target <plugin>', 'prestashop | shopware | woocommerce | magento | all')
  .option('--cases <ids>', 'comma-separated case IDs, or all', 'all')
  .action((opts: { target: string; cases: string }) => {
    throw new Error(`no driver for ${opts.target} yet — see src/drivers/driver.ts and Handover-E2E-Teststrategie.md §6`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(redact(message) + '\n');
  process.exit(1);
});
