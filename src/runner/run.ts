import { Wallet } from 'xrpl';
import { CASES, findCase } from '../cases/catalogue.js';
import { requireSeed } from '../config.js';
import type { Driver } from '../drivers/driver.js';
import { withClient } from '../ledger/client.js';
import { createFresh } from '../ledger/wallets.js';
import { RUNNERS } from './cases.js';
import { CaseContext } from './context.js';
import type { CaseResult, Report } from '../report/report.js';

export interface RunOptions {
  driver: Driver;
  baseUrl: string;
  caseIds: string[];
  /** Reuse this receiving account instead of creating a fresh one (manual debugging only). */
  receivingAccount?: string;
  timeoutMs: number;
  version: string;
  log: (line: string) => void;
}

export async function runCases(options: RunOptions): Promise<Report> {
  const payerSeed = requireSeed();
  const startedAt = new Date().toISOString();

  return withClient(async (client) => {
    let receivingAccount = options.receivingAccount;
    if (!receivingAccount) {
      // A fresh receiving account per run: two runs must never share a tag space.
      // With trust lines to RLUSD and USDC, so the stablecoin cases can receive.
      const fresh = await createFresh(client, { trustlines: true });
      receivingAccount = fresh.wallet.classicAddress;
      options.log(`receiving account for this run: ${receivingAccount}`);
    }
    const shop = { destinationAccount: receivingAccount, network: 'testnet' as const, assets: ['XRP', 'RLUSD', 'USDC'] as Array<'XRP' | 'RLUSD' | 'USDC'>, quoteExpirySeconds: 300 };
    await options.driver.configure(shop);

    const results: CaseResult[] = [];
    for (const id of options.caseIds) {
      const spec = findCase(id);
      const runner = RUNNERS[id.toUpperCase()];
      const caseStart = Date.now();
      const ctx = new CaseContext(options.driver, client, payerSeed, options.timeoutMs, (line) => options.log(`  ${id}: ${line}`), shop);
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

    return { tool: 'ld-e2e', version: options.version, target: options.driver.name, baseUrl: options.baseUrl, receivingAccount, network: 'testnet', startedAt, results };
  });
}

export function resolveCaseIds(spec: string): string[] {
  if (spec === 'all') return CASES.map((c) => c.id);
  if (spec === 'automated') return Object.keys(RUNNERS);
  return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export function payerAddress(): string {
  return Wallet.fromSeed(requireSeed()).classicAddress;
}
