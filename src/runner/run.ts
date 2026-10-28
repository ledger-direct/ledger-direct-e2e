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
  timeoutMs: number;
  version: string;
  log: (line: string) => void;
}

export async function runCases(options: RunOptions): Promise<Report> {
  const ledger = options.ledger;
  const payerSeed = requireSeed(treasurySeedVariable(ledger.chain));
  const startedAt = new Date().toISOString();

  try {
    let receivingAccount = options.receivingAccount;
    if (!receivingAccount) {
      // A fresh receiving account per run — two runs must never share an identifier space —
      // with trust lines to the issued assets, so the stablecoin cases can receive.
      const fresh = await ledger.createFresh({ trustlines: true });
      receivingAccount = fresh.address;
      options.log(`receiving account for this run (${ledger.chain}): ${receivingAccount}`);
    }
    const shop: ShopConfig = { chain: ledger.chain, destinationAccount: receivingAccount, network: 'testnet', assets: ledger.assets().map((a) => a.code), quoteExpirySeconds: DEFAULT_QUOTE_EXPIRY_SECONDS };
    await options.driver.configure(shop);
    const restoreTo = options.keepAccount ? undefined : defaultShopAccount(options.driver.name, ledger.chain);

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
      if (!appliesTo(spec, options.driver.name)) {
        results.push({ id, title: spec.title, target: options.driver.name, outcome: 'skip', reason: `not a case for ${options.driver.name} (${spec.targets?.join(', ')} only)`, startedAt: new Date().toISOString(), durationMs: 0, states: [], evidence: [] });
        options.log(`${id} ${spec.title}: skipped, ${spec.targets?.join(', ')} only`);
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

    return report;
  } finally {
    await ledger.close();
  }
}

export function resolveCaseIds(spec: string): string[] {
  if (spec === 'all') return CASES.map((c) => c.id);
  if (spec === 'automated') return Object.keys(RUNNERS);
  return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
