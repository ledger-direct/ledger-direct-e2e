import type { Client } from 'xrpl';
import type { WithdrawnAsset } from '../chain.js';

/**
 * A testnet reset deletes every account, the issuers of RLUSD and USDC included, and they
 * come back only when Ripple and Circle create them again. Until then no trust line, no
 * purchase and no payment in those tokens is possible — and a run that tried would fail on
 * something no plugin can fix.
 *
 * So an issued asset whose issuer does not exist is withdrawn from a run, but only while the
 * reset is fresh: the testnet's validated ledger index is its age, since a reset starts it at
 * 1 again. Within RESET_WINDOW_LEDGERS the asset is withdrawn with a warning; later a missing
 * issuer is no reset any more but a question (has it come back under another address?), and
 * the asset stays in, so the run fails and somebody looks. An issuer that is back ends the
 * exception by itself.
 */

/** Seven days of testnet ledgers: about 3.24 s each (measured on 26.11.2026, ledgers 12 000 to 22 000). */
export const RESET_WINDOW_LEDGERS = 186_000;
const SECONDS_PER_LEDGER = 3.24;

export interface IssuedAsset {
  code: string;
  issuer: string;
}

export interface IssuerCheck {
  /** The validated ledger index of the testnet. */
  ledgerIndex: number;
  /** The issued assets whose issuer account does not exist (actNotFound). */
  missing: IssuedAsset[];
}

export interface IssuerJudgement {
  /** Withdrawn from the run: the issuer is missing within the window after a reset. */
  withdrawn: WithdrawnAsset[];
  /** Missing, but too long after a reset to be one: the asset stays in and the run fails on it. */
  stillMissing: WithdrawnAsset[];
}

/** About how many days ago the network started again, from its ledger index. */
export function daysSinceReset(ledgerIndex: number): number {
  return Math.round(((ledgerIndex * SECONDS_PER_LEDGER) / 86_400) * 10) / 10;
}

export function judgeIssuers(check: IssuerCheck): IssuerJudgement {
  const days = daysSinceReset(check.ledgerIndex);
  const fresh = check.ledgerIndex < RESET_WINDOW_LEDGERS;
  const withdrawn: WithdrawnAsset[] = [];
  const stillMissing: WithdrawnAsset[] = [];
  for (const asset of check.missing) {
    if (fresh) {
      withdrawn.push({ ...asset, reason: `${asset.code} withdrawn: its issuer ${asset.issuer} is not on the testnet, which started again about ${days} days ago (ledger ${check.ledgerIndex}); a reset, the issuer has not come back yet` });
    } else {
      stillMissing.push({ ...asset, reason: `${asset.code}: its issuer ${asset.issuer} is not on the testnet, about ${days} days (ledger ${check.ledgerIndex}) after the network started again — longer than a reset explains; has it come back under another address? (only from the issuer's own documentation)` });
    }
  }
  return { withdrawn, stillMissing };
}

/** Asks the network: its validated ledger index and which issuers do not exist. */
export async function checkIssuers(client: Client, assets: IssuedAsset[]): Promise<IssuerCheck> {
  const ledger = await client.request({ command: 'ledger', ledger_index: 'validated' });
  const ledgerIndex = Number(ledger.result.ledger_index);
  const missing: IssuedAsset[] = [];
  for (const asset of assets) {
    try {
      await client.request({ command: 'account_info', account: asset.issuer, ledger_index: 'validated' });
    } catch (error) {
      if ((error as { data?: { error?: string } } | null)?.data?.error === 'actNotFound') missing.push(asset);
      else throw error;
    }
  }
  return { ledgerIndex, missing };
}

/** A line for the log; in a GitHub Actions run also an annotation, so a green run still shows it. */
export function warn(line: string, write: (text: string) => void = (text) => process.stderr.write(text)): void {
  write(`warning: ${line}\n`);
  if (process.env.GITHUB_ACTIONS === 'true') write(`::warning title=Testnet reset::${line.replace(/\r?\n/g, ' ')}\n`);
}
