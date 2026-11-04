import { appliesTo, CASES, findCase } from '../cases/catalogue.js';
import type { Ledger } from '../chains/chain.js';
import { isAccountOf, treasurySeedVariable } from '../chains/index.js';
import { spendGuard } from '../chains/spend.js';
import { requireSeed } from '../config.js';
import type { Driver, ShopConfig } from '../drivers/driver.js';
import type { CaseResult, Report } from '../report/report.js';
import { RUNNERS } from './cases.js';
import { CaseContext } from './context.js';
import { DEFAULT_QUOTE_EXPIRY_SECONDS, defaultShopAccount, shopAccountVariables } from './defaults.js';

export interface RunOptions {
  driver: Driver;
  ledger: Ledger;
  baseUrl: string;
  caseIds: string[];
  /** Reuse this receiving account instead of creating a fresh one (manual debugging only). */
  receivingAccount?: string;
  /**
   * Leave the run's throwaway account configured in the shop afterwards. By default the
   * shop is put back on its own account (defaultShopAccount) when one is known, so a dev
   * shop is ready for a manual test the moment the run ends.
   */
  keepAccount?: boolean;
  /** The account to put back after the run instead of the dev shop's own (a try shop's, read from its log). */
  restoreAccount?: string;
  timeoutMs: number;
  version: string;
  log: (line: string) => void;
}

export async function runCases(options: RunOptions): Promise<Report> {
  const ledger = options.ledger;
  const startedAt = new Date().toISOString();

  /** The skip result for a case that is not this platform's, null for one that is (or an unknown id). */
  const notApplicable = (id: string): CaseResult | null => {
    const spec = findCase(id);
    if (!spec || appliesTo(spec, options.driver.name)) return null;
    const only = spec.targets?.join(', ') ?? '';
    return { id, title: spec.title, target: options.driver.name, outcome: 'skip', reason: `not a case for ${options.driver.name} (${only} only)`, startedAt: new Date().toISOString(), durationMs: 0, states: [], evidence: [] };
  };

  // Nothing of the selection is this platform's: no seed, no account, no configure — the shop
  // is left exactly as it is, and the report says why each case did not run. An empty
  // selection still goes through the setup below (a run that only puts the shop back).
  const skippedAll = options.caseIds.length > 0 ? options.caseIds.map(notApplicable) : [];
  if (skippedAll.length > 0 && skippedAll.every((r) => r !== null)) {
    for (const r of skippedAll as CaseResult[]) options.log(`${r.id} ${r.title}: skipped, ${r.reason}`);
    return { tool: 'ld-e2e', version: options.version, target: options.driver.name, chain: ledger.chain, baseUrl: options.baseUrl, receivingAccount: options.receivingAccount ?? '', network: 'testnet', startedAt, results: skippedAll as CaseResult[], spending: spendGuard().summary() };
  }

  const payerSeed = requireSeed(treasurySeedVariable(ledger.chain));

  // The run's own throwaway account, once created: swept back to the treasury at the end.
  let runSeed: string | undefined;
  let swept = false;
  /**
   * Everything the throwaway account holds goes back to the treasury: the faucet's
   * 100 XRP and every payment the shop received. Not when the account stays configured
   * in the shop (--keep-account), and never at the cost of the run: a failed sweep is
   * logged, the report stands.
   */
  const sweepBack = async (report?: Report): Promise<void> => {
    swept = true;
    if (!runSeed || options.keepAccount || !ledger.sweep) return;
    try {
      const back = await ledger.sweep(runSeed, ledger.addressOf(payerSeed));
      const tokens = Object.entries(back.tokens).map(([code, amount]) => `, ${amount} ${code}`).join('');
      options.log(`returned to the treasury: ${back.native} ${ledger.nativeAsset}${tokens}`);
      for (const failure of back.failed) options.log(`returning the run account's funds to the treasury, in part failed: ${failure}`);
      if (report) report.returned = { native: back.native, tokens: back.tokens };
    } catch (error) {
      options.log(`returning the run account's funds to the treasury failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  try {
    let receivingAccount = options.receivingAccount;
    if (!receivingAccount) {
      // A fresh receiving account per run — two runs must never share an identifier space —
      // with trust lines to the issued assets, so the stablecoin cases can receive.
      const fresh = await ledger.createFresh({ trustlines: true });
      runSeed = fresh.seed;
      receivingAccount = fresh.address;
      options.log(`receiving account for this run (${ledger.chain}): ${receivingAccount}`);
    }
    const shop: ShopConfig = { chain: ledger.chain, destinationAccount: receivingAccount, network: 'testnet', assets: ledger.assets().map((a) => a.code), quoteExpirySeconds: DEFAULT_QUOTE_EXPIRY_SECONDS };
    await options.driver.configure(shop);
    const restoreTo = options.keepAccount ? undefined : (options.restoreAccount ?? defaultShopAccount(options.driver.name, ledger.chain));

    const results: CaseResult[] = [];
    for (const id of options.caseIds) {
      const spec = findCase(id);
      const runner = RUNNERS[id.toUpperCase()];
      const caseStart = Date.now();
      const ctx = new CaseContext(options.driver, ledger, payerSeed, options.timeoutMs, (line) => options.log(`  ${id}: ${line}`), shop);
      if (!spec || !runner) {
        results.push({ id, title: spec?.title ?? '?', target: options.driver.name, outcome: 'skip', reason: 'not automated yet', startedAt: new Date().toISOString(), durationMs: 0, states: [], evidence: [] });
        continue;
      }
      const skip = notApplicable(id);
      if (skip) {
        results.push(skip);
        options.log(`${id} ${spec.title}: skipped, ${skip.reason}`);
        continue;
      }
      options.log(`${id} ${spec.title}`);
      try {
        await runner(ctx);
        results.push({ id, title: spec.title, target: options.driver.name, outcome: 'pass', startedAt: new Date(caseStart).toISOString(), durationMs: Date.now() - caseStart, states: ctx.states, evidence: ctx.evidence });
        options.log(`  ${id}: pass`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({ id, title: spec.title, target: options.driver.name, outcome: 'fail', reason, startedAt: new Date(caseStart).toISOString(), durationMs: Date.now() - caseStart, states: ctx.states, evidence: ctx.evidence });
        options.log(`  ${id}: FAIL ${reason}`);
      }
    }

    const report: Report = { tool: 'ld-e2e', version: options.version, target: options.driver.name, chain: ledger.chain, baseUrl: options.baseUrl, receivingAccount, network: 'testnet', startedAt, results, spending: spendGuard().summary() };

    // The evidence is complete at this point; putting the shop back is housekeeping and
    // must not lose it. An account of the wrong form is not written at all; a refused or
    // half-done restore (the account may already be written when a later step fails) is
    // reported without claiming which account the shop ended up with.
    if (restoreTo && restoreTo !== receivingAccount) {
      if (!isAccountOf(ledger.chain, restoreTo)) {
        options.log(`receiving account NOT restored: ${restoreTo} is not a ${ledger.chain} account (check ${shopAccountVariables(options.driver.name, ledger.chain).join(' / ')}); the run's account ${receivingAccount} stays configured`);
      } else {
        try {
          await options.driver.configure({ ...shop, destinationAccount: restoreTo });
          options.log(`receiving account restored to the shop's own: ${restoreTo}`);
        } catch (error) {
          options.log(`receiving account restore to ${restoreTo} failed: ${error instanceof Error ? error.message : String(error)}; the shop may be on either account now — check it, or run \`ld-e2e shop reset --target ${options.driver.name}${ledger.chain === 'XRPL' ? '' : ` --chain ${ledger.chain}`}\``);
        }
      }
    }

    // After the restore: the shop no longer points at the throwaway account.
    await sweepBack(report);
    return report;
  } finally {
    // A run that broke off before its report (configure failed, say) still gives the money back.
    if (!swept) await sweepBack();
    await ledger.close();
  }
}

/**
 * The four named sets, besides a comma-separated list of ids:
 * - `automated`: every case with a runner that is not nightly-only — what a
 *   developer runs against a dev shop, in minutes;
 * - `testnet`: every case with a runner but the long waits — `automated` plus
 *   PS-04, for runs on the public testnet that should stay short (a version tag);
 * - `nightly`: every case with a runner, the nightly-only ones included (PS-04
 *   needs the public testnet's issuers, PS-10 waits 35 minutes);
 * - `all`: the whole catalogue, cases without a runner recorded as skipped.
 */
export function resolveCaseIds(spec: string): string[] {
  if (spec === 'all') return CASES.map((c) => c.id);
  if (spec === 'nightly') return Object.keys(RUNNERS);
  if (spec === 'automated') return Object.keys(RUNNERS).filter((id) => !findCase(id)?.nightlyOnly);
  if (spec === 'testnet') return Object.keys(RUNNERS).filter((id) => !findCase(id)?.longWait);
  return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
