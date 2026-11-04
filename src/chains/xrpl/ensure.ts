/**
 * Keeps the treasury above the minimums a run needs, before the run starts.
 *
 * Since runs return their throwaway account's funds (sweep.ts) the treasury mostly
 * refills itself; this is the safety net for what still drains it: a run that broke
 * off before it could return anything, a testnet reset, the reserve. XRP comes from
 * the faucet (about 100 per request), the stablecoins from the testnet DEX like
 * `wallet top-up`. A treasury that cannot be brought up fails here, with the
 * shortfall named, instead of a payment failing mid-run with tecUNFUNDED_PAYMENT.
 */
export type Stablecoin = 'RLUSD' | 'USDC';

export interface Minimums {
  xrp: number;
  tokens: Partial<Record<Stablecoin, number>>;
}

export interface TreasuryState {
  xrp: number;
  tokens: Partial<Record<Stablecoin, number>>;
}

export interface EnsureDeps {
  read(): Promise<TreasuryState>;
  /** One faucet request to the treasury. */
  fund(): Promise<void>;
  /**
   * Buys `amount` of the coin on the DEX, spending at most the configured XRP. Sets the
   * treasury's trust line first: a line an offer creates has limit 0, and the treasury
   * could then not receive the coin back from a run's sweep.
   */
  buy(coin: Stablecoin, amount: string): Promise<string>;
  /** Waits briefly; a faucet answers before its payment is validated. */
  pause(ms: number): Promise<void>;
  log(line: string): void;
}

export interface EnsureResult {
  before: TreasuryState;
  after: TreasuryState;
  actions: string[];
}

const FAUCET_REQUESTS = 3;
const FAUCET_SETTLE_POLLS = 10;
const POLL_MS = 3000;

export async function ensureTreasury(minimums: Minimums, deps: EnsureDeps): Promise<EnsureResult> {
  const before = await deps.read();
  const actions: string[] = [];
  let state = before;

  const topUpXrp = async (): Promise<void> => {
    for (let request = 1; state.xrp < minimums.xrp && request <= FAUCET_REQUESTS; request++) {
      const had = state.xrp;
      deps.log(`XRP ${had} is below ${minimums.xrp}: faucet request ${request} of ${FAUCET_REQUESTS}`);
      await deps.fund();
      actions.push('faucet');
      for (let poll = 0; poll < FAUCET_SETTLE_POLLS && state.xrp <= had; poll++) {
        await deps.pause(POLL_MS);
        state = await deps.read();
      }
    }
  };

  // XRP first: the purchases below pay with it.
  await topUpXrp();

  let bought = false;
  for (const coin of Object.keys(minimums.tokens) as Stablecoin[]) {
    const want = minimums.tokens[coin] ?? 0;
    const have = state.tokens[coin] ?? 0;
    if (have >= want) continue;
    bought = true;
    // The shortfall, rounded up to the cent; the DEX fills what its book allows.
    const amount = (Math.ceil((want - have) * 100) / 100).toFixed(2);
    deps.log(`${coin} ${have} is below ${want}: buying ${amount} on the DEX`);
    const result = await deps.buy(coin, amount);
    actions.push(`buy ${amount} ${coin}: ${result}`);
    state = await deps.read();
  }
  // The purchases spent XRP; bring it back above the minimum.
  if (bought) await topUpXrp();

  const short = shortfalls(minimums, state);
  if (short.length > 0) {
    throw new Error(`treasury below its minimums after topping up: ${short.join(', ')}; a run would fail mid-way. Check the faucet and the DEX book (ld-e2e wallet book <asset>).`);
  }
  return { before, after: state, actions };
}

/**
 * Whether a ledger request failed because the account does not exist: after a testnet
 * reset the treasury is gone until the faucet creates it again, so `ensure` reads it as
 * empty instead of failing before it can ask the faucet.
 */
export function isAccountNotFound(error: unknown): boolean {
  return (error as { data?: { error?: string } } | null)?.data?.error === 'actNotFound';
}

export function shortfalls(minimums: Minimums, state: TreasuryState): string[] {
  const short: string[] = [];
  if (state.xrp < minimums.xrp) short.push(`XRP ${state.xrp} < ${minimums.xrp}`);
  for (const coin of Object.keys(minimums.tokens) as Stablecoin[]) {
    const want = minimums.tokens[coin] ?? 0;
    const have = state.tokens[coin] ?? 0;
    if (have < want) short.push(`${coin} ${have} < ${want}`);
  }
  return short;
}
