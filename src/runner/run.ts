import { CASES, findCase } from '../cases/catalogue.js';
import type { Ledger } from '../chains/chain.js';
import { treasurySeedVariable } from '../chains/index.js';
import { requireSeed } from '../config.js';
import type { Driver, ShopConfig } from '../drivers/driver.js';
import type { CaseResult, Report } from '../report/report.js';
import { RUNNERS } from './cases.js';
import { CaseContext } from './context.js';

export interface RunOptions {
  driver: Driver;
  ledger: Ledger;
  baseUrl: string;
  caseIds: string[];
  /** Reuse this receiving account instead of creating a fresh one (manual debugging only). */
  receivingAccount?: string;
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
    const shop: ShopConfig = { destinationAccount: receivingAccount, network: 'testnet', assets: ledger.assets().map((a) => a.code), quoteExpirySeconds: 300 };
    await options.driver.configure(shop);

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

    return { tool: 'ld-e2e', version: options.version, target: options.driver.name, chain: ledger.chain, baseUrl: options.baseUrl, receivingAccount, network: 'testnet', startedAt, results };
  } finally {
    await ledger.close();
  }
}

export function resolveCaseIds(spec: string): string[] {
  if (spec === 'all') return CASES.map((c) => c.id);
  if (spec === 'automated') return Object.keys(RUNNERS);
  return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
