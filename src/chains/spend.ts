import type { Balances, ChainAsset, ChainId, FreshAccount, IncomingPayment, Ledger, PaymentRequest, PaymentResult } from './chain.js';

/**
 * The one place every payment passes before it is signed — `ld-e2e pay`, the
 * catalogue (`RunContext.pay()`, so the nightly) and the MCP tools alike.
 *
 * Two limits, both in the asset's own units:
 * - LD_E2E_MAX_PAYMENT caps a single payment (default 50).
 * - LD_E2E_RUN_BUDGET caps the sum per process and asset, e.g.
 *   `XRP=15,RLUSD=5,USDC=5`. Once it is set, an asset it does not name has a
 *   budget of zero: a run that pays in something nobody budgeted fails loudly.
 *   Unset, there is no budget (local use as before). For the MCP server the
 *   process is the server start.
 *
 * A payment counts when it is about to be signed, whatever the ledger makes of
 * it: a rejected payment still left the wallet's intent, and the deliberate
 * wrong ones of the catalogue (PS-04, the partial payments) count like any other.
 * Exceeding a limit is an error, never a question.
 */
export class SpendLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendLimitError';
  }
}

/** Decimals as integers with 18 places, so sums of 0.81466 never drift. */
const SCALE = 18;

function toUnits(amount: string, label: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(amount);
  if (!m) throw new SpendLimitError(`${label}: "${amount}" is not a non-negative decimal`);
  const fraction = (m[2] ?? '').slice(0, SCALE).padEnd(SCALE, '0');
  return BigInt(m[1]) * 10n ** BigInt(SCALE) + BigInt(fraction);
}

function fromUnits(units: bigint): string {
  const whole = units / 10n ** BigInt(SCALE);
  const fraction = (units % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

export function parseBudget(spec: string): Map<string, bigint> {
  const budget = new Map<string, bigint>();
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [asset, amount] = part.split('=').map((s) => s?.trim());
    if (!asset || amount === undefined) throw new SpendLimitError(`LD_E2E_RUN_BUDGET: "${part}" is not ASSET=amount`);
    budget.set(asset.toUpperCase(), toUnits(amount, `LD_E2E_RUN_BUDGET ${asset}`));
  }
  return budget;
}

export class SpendGuard {
  private readonly spentUnits = new Map<string, bigint>();
  private readonly maxUnits: bigint;

  constructor(
    readonly maxPayment: string,
    private readonly budget?: Map<string, bigint>,
  ) {
    this.maxUnits = toUnits(maxPayment, 'LD_E2E_MAX_PAYMENT');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SpendGuard {
    const budget = env.LD_E2E_RUN_BUDGET?.trim();
    return new SpendGuard(env.LD_E2E_MAX_PAYMENT?.trim() || '50', budget ? parseBudget(budget) : undefined);
  }

  /** Books a payment or refuses it; nothing is booked when it is refused. */
  charge(asset: string, amount: string): void {
    const code = asset.toUpperCase();
    const units = toUnits(amount, `payment of ${asset}`);
    if (units > this.maxUnits) throw new SpendLimitError(`refusing to pay ${amount} ${code}: above LD_E2E_MAX_PAYMENT (${this.maxPayment})`);
    const spent = this.spentUnits.get(code) ?? 0n;
    if (this.budget) {
      const limit = this.budget.get(code);
      if (limit === undefined) throw new SpendLimitError(`refusing to pay ${amount} ${code}: LD_E2E_RUN_BUDGET names no budget for ${code}`);
      if (spent + units > limit) {
        throw new SpendLimitError(`refusing to pay ${amount} ${code}: the run has spent ${fromUnits(spent)} of its ${fromUnits(limit)} ${code} (LD_E2E_RUN_BUDGET)`);
      }
    }
    this.spentUnits.set(code, spent + units);
  }

  /** What this process has paid so far, per asset, and the limits it ran under. */
  summary(): { spent: Record<string, string>; maxPayment: string; budget?: Record<string, string> } {
    const spent = Object.fromEntries([...this.spentUnits].map(([code, units]) => [code, fromUnits(units)]));
    const budget = this.budget ? Object.fromEntries([...this.budget].map(([code, units]) => [code, fromUnits(units)])) : undefined;
    return { spent, maxPayment: this.maxPayment, ...(budget ? { budget } : {}) };
  }
}

let processGuard: SpendGuard | undefined;

/** The guard of this process, read from the environment on first use. */
export function spendGuard(): SpendGuard {
  return (processGuard ??= SpendGuard.fromEnv());
}

/** Tests only: forget the process guard, so the next use reads the environment again. */
export function resetSpendGuard(): void {
  processGuard = undefined;
}

/** A ledger whose payments are charged to the guard before the inner ledger signs them. */
export class GuardedLedger implements Ledger {
  constructor(
    private readonly inner: Ledger,
    private readonly guard: SpendGuard,
  ) {}

  get chain(): ChainId {
    return this.inner.chain;
  }

  get nativeAsset(): string {
    return this.inner.nativeAsset;
  }

  assets(): ChainAsset[] {
    return this.inner.assets();
  }

  createFresh(options?: { trustlines?: boolean }): Promise<FreshAccount> {
    return this.inner.createFresh(options);
  }

  fund(address: string): Promise<{ address: string; amount: string }> {
    return this.inner.fund(address);
  }

  balances(address: string): Promise<Balances> {
    return this.inner.balances(address);
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    this.guard.charge(request.asset, request.amount);
    return this.inner.pay(request);
  }

  /** Reading costs nothing; only pay() passes the guard. */
  incoming(address: string, options?: { identifier?: string; limit?: number }): Promise<IncomingPayment[]> {
    return this.inner.incoming(address, options);
  }

  explorerUrl(hash: string): string {
    return this.inner.explorerUrl(hash);
  }

  addressOf(seed: string): string {
    return this.inner.addressOf(seed);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
