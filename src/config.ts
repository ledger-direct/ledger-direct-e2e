/**
 * Everything secret comes from the environment and nowhere else.
 *
 * Locally: `set -a; source ~/.config/ledger-direct/testnet.env; set +a`.
 * In CI: organisation secrets mapped to the same variable names.
 * There is no file loader in this project on purpose — a second loading path
 * is how a seed ends up being read from a repository one day.
 */
/** One treasury per chain: LEDGERDIRECT_TESTNET_<CHAIN>_TREASURY_SEED / _ADDRESS. */
export const ENV_XRPL_TREASURY_SEED = 'LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED';
export const ENV_XRPL_TREASURY_ADDRESS = 'LEDGERDIRECT_TESTNET_XRPL_TREASURY_ADDRESS';

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(
      `${name} is not set. Load ~/.config/ledger-direct/testnet.env into the environment ` +
        '(set -a; source …; set +a) or pass --seed-env <VARIABLE> to use another variable.',
    );
    this.name = 'MissingSecretError';
  }
}

export function requireSeed(variable: string): string {
  const seed = process.env[variable];
  if (!seed || seed.trim() === '') throw new MissingSecretError(variable);
  return seed.trim();
}

export function optionalAddress(variable: string): string | undefined {
  const value = process.env[variable];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Removes anything that looks like a family seed from a string before it can
 * reach a log or a report. GitHub masks a secret only when it is printed
 * verbatim; a seed inside a JSON dump or an error message is not caught.
 */
export function redact(text: string): string {
  return text.replace(/\bs[1-9A-HJ-NP-Za-km-z]{25,35}\b/g, '[seed redacted]');
}
