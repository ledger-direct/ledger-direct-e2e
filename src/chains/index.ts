import type { ChainId, Ledger } from './chain.js';
import { GuardedLedger, spendGuard } from './spend.js';
import { StellarLedger } from './stellar/ledger.js';
import { XrplLedger } from './xrpl/ledger.js';

export const CHAINS: readonly ChainId[] = ['XRPL', 'STELLAR'];

export function isChain(value: string): value is ChainId {
  return (CHAINS as readonly string[]).includes(value.toUpperCase());
}

/** Every ledger the harness hands out pays through the process's spend guard (spend.ts). */
export function ledgerFor(chain: string): Ledger {
  return new GuardedLedger(unguardedLedger(chain), spendGuard());
}

function unguardedLedger(chain: string): Ledger {
  switch (chain.toUpperCase()) {
    case 'XRPL':
      return new XrplLedger();
    case 'STELLAR':
      return new StellarLedger();
    default:
      throw new Error(`unknown chain ${chain}; known: ${CHAINS.join(', ')}`);
  }
}

/** The environment variable holding the treasury seed for a chain. */
export function treasurySeedVariable(chain: ChainId): string {
  return `LEDGERDIRECT_TESTNET_${chain}_TREASURY_SEED`;
}
