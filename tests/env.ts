import { afterEach, beforeEach } from 'vitest';

/**
 * Runs each test of the file without the given environment variables and puts
 * their values back afterwards. Locally the wallet file is often loaded into the
 * shell (`set -a; source …/testnet.env`), so a test must neither depend on what is
 * set there nor delete it for the tests that follow.
 */
export function isolateEnv(names: readonly string[]): void {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of names) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
