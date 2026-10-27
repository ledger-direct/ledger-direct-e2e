import { StrKey } from '@stellar/stellar-sdk';
import { isValidClassicAddress } from 'xrpl';
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

/**
 * Whether an address has the form of a receiving account on the chain: a classic
 * r-address on XRPL, a G-address on Stellar. Checked before an account is written
 * into a shop, so a Stellar card never gets an XRPL address (or the other way round)
 * from a mistyped variable or option.
 */
export function isAccountOf(chain: string, address: string): boolean {
  switch (chain.toUpperCase()) {
    case 'XRPL':
      return isValidClassicAddress(address);
    case 'STELLAR':
      return StrKey.isValidEd25519PublicKey(address);
    default:
      return false;
  }
}
