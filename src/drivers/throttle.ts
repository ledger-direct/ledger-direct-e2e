import { createHash } from 'node:crypto';

/**
 * The cache keys under which the core's SyncThrottle keeps the time of the last sync of a
 * receiving account. Core 0.11 puts the chain in and the account as a digest (PSR-16 keys
 * are 64 characters at most); before, the key spelled the account out and knew the XRP
 * Ledger alone. A driver reads the new key first and falls back to the old one, so a shop
 * on an older core still proves PS-08.
 */
export function throttleKeys(chain: string, network: string, account: string): string[] {
  const digest = createHash('sha256').update(account).digest('hex').slice(0, 16);
  const current = `ledger-direct.sync.v2.${chain.toLowerCase()}.${network}.${digest}`;
  return chain.toUpperCase() === 'XRPL' ? [current, `ledger-direct.sync.v1.${network}.${account}`] : [current];
}
