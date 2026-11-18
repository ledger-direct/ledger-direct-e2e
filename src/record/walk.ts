import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserPage } from './browser.js';

const run = promisify(execFile);

/**
 * `--start shop` does not know a storefront's cart and checkout. The plugin does: each plugin's
 * try stack has `dev/try/browser/walk.mjs`, the module its own visitor.mjs walks with and try.yml
 * checks on every pull request. The harness imports it from the compose folder of the stack:
 * --compose-dir, else the folder docker compose recorded for the running shop container.
 */
export type WalkToPaymentPage = (
  page: BrowserPage,
  options: { asset: string; base: string; log?: (line: string) => void },
) => Promise<{ url: string; state?: string | null; amount?: string | null; asset?: string | null }>;

export function walkPath(composeDir: string): string {
  return join(composeDir, 'browser', 'walk.mjs');
}

/** The working folder docker compose stored on the container (`com.docker.compose.project.working_dir`). */
export async function composeDirOf(container: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}', container]);
    const dir = stdout.trim();
    return dir && dir !== '<no value>' ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** The walk module's path, or an error that says where it was looked for and why --start shop needs it. */
export async function findWalkModule(target: string, options: { composeDir?: string; container?: string }, exists: (path: string) => boolean = existsSync): Promise<string> {
  const dir = options.composeDir ?? (options.container ? await composeDirOf(options.container) : undefined);
  if (!dir) {
    throw new Error(`--start shop: no compose folder for ${target}. Pass --compose-dir (the plugin's dev/try), or start the try stack so its container names it`);
  }
  const path = walkPath(dir);
  if (!exists(path)) {
    throw new Error(`--start shop: ${target} has no browser walk yet (looked for ${path}). Use --start payment, or add dev/try/browser/walk.mjs to the plugin`);
  }
  return path;
}
