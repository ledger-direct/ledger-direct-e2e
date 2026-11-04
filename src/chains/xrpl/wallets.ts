import { Client, Wallet, TrustSet, TrustSetFlags } from 'xrpl';
import { httpFetch } from '../../http.js';
import { ASSETS, Asset, TESTNET_FAUCET, TESTNET_ISSUED, assetFromCurrency } from './assets.js';
import { submitWithRetry } from './submit.js';

export interface Balances {
  address: string;
  xrp: string;
  tokens: Partial<Record<Exclude<Asset, 'XRP'>, string>>;
  trustlines: Exclude<Asset, 'XRP'>[];
}

/** The faucet is slow at times; it gets more than a shop request. */
const FAUCET_TIMEOUT_MS = 60_000;

/**
 * Asks the testnet faucet for XRP. Without a destination it creates a new
 * account and returns its seed; with one it tops up an existing account. The
 * faucet rate-limits, so callers ask for what a run needs, not for stock.
 */
export async function faucet(destination?: string): Promise<{ address: string; seed?: string; amount: number }> {
  const response = await httpFetch(TESTNET_FAUCET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(destination ? { destination } : {}),
  }, FAUCET_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Faucet answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { account?: { classicAddress?: string; address?: string }; seed?: string; amount?: number; balance?: number };
  const address = body.account?.classicAddress ?? body.account?.address ?? destination;
  if (!address) throw new Error('Faucet answered without an address');
  return { address, seed: body.seed, amount: Number(body.amount ?? body.balance ?? 0) };
}

/**
 * Trust lines to the testnet issuers, one TrustSet per asset; idempotent on
 * the ledger. With NoRipple: these accounts hold tokens, they do not route
 * them, and a wallet like Xaman flags a line that ripples as misconfigured.
 */
export async function setTrustlines(client: Client, wallet: Wallet, assets: Exclude<Asset, 'XRP'>[] = ['RLUSD', 'USDC'], limit = '1000000'): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const asset of assets) {
    const issued = TESTNET_ISSUED[asset];
    const tx: TrustSet = {
      TransactionType: 'TrustSet',
      Account: wallet.classicAddress,
      LimitAmount: { currency: issued.currency, issuer: issued.issuer, value: limit },
      Flags: TrustSetFlags.tfSetNoRipple,
    };
    const result = await submitWithRetry(client, wallet, tx);
    const meta = result.result.meta;
    results[asset] = typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown';
  }
  return results;
}

/**
 * Throws unless every TrustSet of `setTrustlines()` succeeded. A validated tec result
 * leaves the line as it was (missing, or limit 0), so whatever comes next — receiving a
 * payment, a sweep paying a coin back, a DEX purchase — would fail or misbehave later.
 */
export function requireTrustlines(results: Record<string, string>): void {
  const failed = Object.entries(results).filter(([, code]) => code !== 'tesSUCCESS');
  if (failed.length > 0) throw new Error(`trust line not set: ${failed.map(([asset, code]) => `${asset} ${code}`).join(', ')}`);
}

/** A brand-new funded account. `trustlines` makes it able to receive the stablecoins. */
export async function createFresh(client: Client, options: { trustlines?: boolean } = {}): Promise<{ wallet: Wallet; trustlines: Record<string, string> }> {
  const funded = await faucet();
  if (!funded.seed) throw new Error('Faucet created an account but returned no seed');
  const wallet = Wallet.fromSeed(funded.seed);
  // The faucet answers before the funding transaction is validated; wait for the account to exist.
  await waitForAccount(client, wallet.classicAddress);
  const trustlines = options.trustlines ? await setTrustlines(client, wallet) : {};
  requireTrustlines(trustlines);
  return { wallet, trustlines };
}

export async function balances(client: Client, address: string): Promise<Balances> {
  const xrp = await client.getXrpBalance(address);
  const lines = await client.request({ command: 'account_lines', account: address });
  const tokens: Balances['tokens'] = {};
  const trustlines: Exclude<Asset, 'XRP'>[] = [];
  for (const line of lines.result.lines) {
    const asset = assetFromCurrency(line.currency);
    if (asset === null || asset === 'XRP') continue;
    if (TESTNET_ISSUED[asset].issuer !== line.account) continue;
    trustlines.push(asset);
    tokens[asset] = line.balance;
  }
  return { address, xrp: String(xrp), tokens, trustlines };
}

export function assetsWithoutXrp(): Exclude<Asset, 'XRP'>[] {
  return ASSETS.filter((a): a is Exclude<Asset, 'XRP'> => a !== 'XRP');
}

async function waitForAccount(client: Client, address: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`Account ${address} did not appear on the ledger after funding`);
}
