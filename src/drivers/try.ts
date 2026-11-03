import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Target } from './factory.js';

const run = promisify(execFile);

/**
 * The try stacks (`dev/try` in each plugin repository): a complete shop per platform on the
 * testnet, started with `docker compose up -d --wait`. Their ports, compose project names and demo
 * logins are fixed and public (each plugin's README and `dev/try/compose.yaml`), so `--try` can
 * reach one without any per-shop settings. The compose project name replaces the compose folder:
 * `docker compose -p <project> exec` works from anywhere while the stack runs.
 */
export interface TryPreset {
  baseUrl: string;
  composeProject: string;
  /** The container whose log names the shop's own receiving account. */
  container: string;
  /** The compose service of that container, for a stack chosen with --compose-dir. */
  service: string;
  accessKey?: string;
  adminUser?: string;
  adminPassword?: string;
  testProductNumber?: string;
}

const DEMO_ADMIN = { adminUser: 'demo', adminPassword: 'demo-ledgerdirect-1' };

export const TRY_PRESETS: Record<Target, TryPreset> = {
  magento: {
    baseUrl: 'http://localhost:8088',
    composeProject: 'ledger-direct-try-magento',
    container: 'ledger-direct-try-magento-phpfpm-1',
    service: 'phpfpm',
    ...DEMO_ADMIN,
  },
  prestashop: {
    baseUrl: 'http://localhost:8089',
    composeProject: 'ledger-direct-try-prestashop',
    container: 'ledger-direct-try-prestashop-prestashop-1',
    service: 'prestashop',
  },
  shopware: {
    baseUrl: 'http://localhost:8091',
    composeProject: 'ledger-direct-try-shopware',
    container: 'ledger-direct-try-shopware-shopware-1',
    service: 'shopware',
    accessKey: 'SWSCLEDGERDIRECTTRYSHOP000',
    testProductNumber: 'ledger-direct-demo',
    ...DEMO_ADMIN,
  },
  woocommerce: {
    baseUrl: 'http://localhost:8092',
    composeProject: 'ledger-direct-try-woocommerce',
    container: 'ledger-direct-try-woocommerce-wp-1',
    service: 'wp',
  },
};

/**
 * The receiving account a try shop set up on its last start, from the line every try stack logs
 * (`[ledger-direct-try] receiving account: r…`): its own testnet wallet, or LD_TESTNET_ACCOUNT. The
 * last such line wins, because a restart with another account logs a new one.
 */
export function tryAccountFromLog(log: string): string | undefined {
  const matches = [...log.matchAll(/\[ledger-direct-try\] receiving account: ([A-Za-z0-9]+)/g)];
  return matches.at(-1)?.[1];
}

/** Which try shop to read: the one the driver talks to, so a run never restores another stack's account. */
export interface TrySelection {
  composeDir?: string;
  /** WooCommerce: the compose files passed with -f, as the driver passes them. */
  composeFiles?: string[];
  container?: string;
}

/**
 * Where the selected try shop's log comes from: an explicit --container, else the compose service
 * of the stack chosen with --compose-dir and/or --compose-files (the same `-f` files the driver
 * uses), else the preset container.
 */
export function tryLogSource(target: Target, selection: TrySelection = {}): { args: string[]; cwd?: string } {
  const preset = TRY_PRESETS[target];
  if (selection.container) return { args: ['logs', selection.container] };
  const files = selection.composeFiles ?? [];
  if (selection.composeDir || files.length > 0) {
    return { args: ['compose', ...files.flatMap((f) => ['-f', f]), 'logs', '--no-color', '--no-log-prefix', preset.service], cwd: selection.composeDir };
  }
  return { args: ['logs', preset.container] };
}

/** Reads the selected try shop's own receiving account from its log; undefined if it is not running or never logged one. */
export async function tryShopAccount(target: Target, selection: TrySelection = {}): Promise<string | undefined> {
  const { args, cwd } = tryLogSource(target, selection);
  try {
    const { stdout, stderr } = await run('docker', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return tryAccountFromLog(stdout + '\n' + stderr);
  } catch {
    return undefined;
  }
}
