import { Client, Payment, Wallet, TrustSet, TrustSetFlags, type ECDSA } from 'xrpl';
import { httpFetch } from '../../http.js';
import { ASSETS, Asset, TESTNET_ISSUED } from './assets.js';
import { XRPL, type XrplProfile, assetFromCurrencyOn } from './profile.js';
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
 * The wallet a seed stands for. A seed names its own algorithm: `sEd…` is
 * ed25519, every other `s…` seed is secp256k1 — the XRPL and Xahau faucets
 * hand out the latter. xrpl.js before 5.0 assumed ed25519 for a seed without
 * the prefix and derived an address that owns nothing; 5.0 reads the prefix
 * as well. Every seed in this harness still goes through here, so the account
 * a seed stands for does not depend on the library version.
 */
export function walletFromSeed(seed: string): Wallet {
  // The enum's values, spelled out: xrpl.js re-exports ECDSA in a way Node's ESM loader does not see as a named export.
  const algorithm = (seed.startsWith('sEd') ? 'ed25519' : 'ecdsa-secp256k1') as ECDSA;
  return Wallet.fromSeed(seed, { algorithm });
}

/**
 * Asks the testnet faucet for XRP. Without a destination it creates a new
 * account and returns its seed; with one it tops up an existing account. The
 * faucet rate-limits, so callers ask for what a run needs, not for stock.
 */
export async function faucet(destination?: string, url: string = XRPL.faucet): Promise<{ address: string; seed?: string; amount: number }> {
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(destination ? { destination } : {}),
  }, FAUCET_TIMEOUT_MS);
  if (!response.ok) throw new Error(`Faucet answered ${response.status} ${response.statusText}`);
  // The XRPL faucet answers `{ account, seed, amount }`, Xahau's `{ account: { secret, … }, amount }`.
  const body = (await response.json()) as { account?: { classicAddress?: string; address?: string; secret?: string }; seed?: string; amount?: number; balance?: number; error?: string };
  // Xahau's faucet answers a refusal with 200 and an error field ("you must wait 36 seconds before requesting again").
  if (body.error) throw new Error(`Faucet refused: ${body.error}`);
  const address = body.account?.classicAddress ?? body.account?.address ?? destination;
  if (!address) throw new Error('Faucet answered without an address');
  return { address, seed: body.seed ?? body.account?.secret, amount: Number(body.amount ?? body.balance ?? 0) };
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

/**
 * A brand-new funded account. `trustlines` makes it able to receive the chain's issued
 * assets, where it has any. Funded by the faucet, or — where the profile says so — by a
 * payment from `funderSeed`, the chain's treasury: a new key pair, opened by the first payment.
 */
export async function createFresh(client: Client, options: { trustlines?: boolean; funderSeed?: string } = {}, profile: XrplProfile = XRPL): Promise<{ wallet: Wallet; trustlines: Record<string, string> }> {
  const wallet = profile.freshAccounts === 'treasury' ? await openFromTreasury(client, options.funderSeed, profile) : await fromFaucet(profile);
  // The faucet answers before the funding transaction is validated; wait for the account to exist.
  await waitForAccount(client, wallet.classicAddress);
  const trustlines = options.trustlines && Object.keys(profile.issued).length > 0 ? await setTrustlines(client, wallet) : {};
  requireTrustlines(trustlines);
  return { wallet, trustlines };
}

async function fromFaucet(profile: XrplProfile): Promise<Wallet> {
  const funded = await faucet(undefined, profile.faucet);
  if (!funded.seed) throw new Error('Faucet created an account but returned no seed');
  return walletFromSeed(funded.seed);
}

async function openFromTreasury(client: Client, funderSeed: string | undefined, profile: XrplProfile): Promise<Wallet> {
  if (!funderSeed) throw new Error(`${profile.chain}: a fresh account is opened by the treasury; its seed is needed (LEDGERDIRECT_TESTNET_${profile.chain}_TREASURY_SEED)`);
  const wallet = Wallet.generate();
  const funder = walletFromSeed(funderSeed);
  const tx: Payment = { TransactionType: 'Payment', Account: funder.classicAddress, Destination: wallet.classicAddress, Amount: profile.freshAccountDrops };
  const response = await submitWithRetry(client, funder, tx);
  const meta = response.result.meta;
  const code = typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown';
  if (code !== 'tesSUCCESS') throw new Error(`opening a fresh ${profile.chain} account from the treasury failed: ${code} (${response.result.hash})`);
  return wallet;
}

export async function balances(client: Client, address: string, profile: XrplProfile = XRPL): Promise<Balances> {
  const xrp = await client.getXrpBalance(address);
  const lines = await client.request({ command: 'account_lines', account: address });
  const tokens: Balances['tokens'] = {};
  const trustlines: Exclude<Asset, 'XRP'>[] = [];
  for (const line of lines.result.lines) {
    const asset = assetFromCurrencyOn(profile, line.currency) as Exclude<Asset, 'XRP'> | null;
    if (asset === null || asset === profile.nativeAsset) continue;
    if (profile.issued[asset].issuer !== line.account) continue;
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
