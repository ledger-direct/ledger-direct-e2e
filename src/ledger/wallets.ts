import { Client, Wallet, TrustSet } from 'xrpl';
import { ASSETS, Asset, TESTNET_FAUCET, TESTNET_ISSUED, assetFromCurrency } from '../assets.js';

export interface Balances {
  address: string;
  xrp: string;
  tokens: Partial<Record<Exclude<Asset, 'XRP'>, string>>;
  trustlines: Exclude<Asset, 'XRP'>[];
}

/**
 * Asks the testnet faucet for XRP. Without a destination it creates a new
 * account and returns its seed; with one it tops up an existing account. The
 * faucet rate-limits, so callers ask for what a run needs, not for stock.
 */
export async function faucet(destination?: string): Promise<{ address: string; seed?: string; amount: number }> {
  const response = await fetch(TESTNET_FAUCET, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(destination ? { destination } : {}),
  });
  if (!response.ok) throw new Error(`Faucet answered ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { account?: { classicAddress?: string; address?: string }; seed?: string; amount?: number; balance?: number };
  const address = body.account?.classicAddress ?? body.account?.address ?? destination;
  if (!address) throw new Error('Faucet answered without an address');
  return { address, seed: body.seed, amount: Number(body.amount ?? body.balance ?? 0) };
}

/** Trust lines to the testnet issuers, one TrustSet per asset; idempotent on the ledger. */
export async function setTrustlines(client: Client, wallet: Wallet, assets: Exclude<Asset, 'XRP'>[] = ['RLUSD', 'USDC'], limit = '1000000'): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const asset of assets) {
    const issued = TESTNET_ISSUED[asset];
    const tx: TrustSet = {
      TransactionType: 'TrustSet',
      Account: wallet.classicAddress,
      LimitAmount: { currency: issued.currency, issuer: issued.issuer, value: limit },
    };
    const prepared = await client.autofill(tx);
    const result = await client.submitAndWait(wallet.sign(prepared).tx_blob);
    const meta = result.result.meta;
    results[asset] = typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown';
  }
  return results;
}

/** A brand-new funded account. `trustlines` makes it able to receive the stablecoins. */
export async function createFresh(client: Client, options: { trustlines?: boolean } = {}): Promise<{ wallet: Wallet; trustlines: Record<string, string> }> {
  const funded = await faucet();
  if (!funded.seed) throw new Error('Faucet created an account but returned no seed');
  const wallet = Wallet.fromSeed(funded.seed);
  // The faucet answers before the funding transaction is validated; wait for the account to exist.
  await waitForAccount(client, wallet.classicAddress);
  const trustlines = options.trustlines ? await setTrustlines(client, wallet) : {};
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
