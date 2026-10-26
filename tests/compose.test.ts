import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertComposeDir, explainComposeError } from '../src/drivers/compose.js';
import { PrestaShopDriver } from '../src/drivers/prestashop.js';

describe('the compose folder of a container-driven shop', () => {
  const dirs: string[] = [];
  const dir = (): string => { const d = mkdtempSync(join(tmpdir(), 'ld-compose-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('names the variable that fixes a folder without a compose file', () => {
    const empty = dir();
    expect(() => assertComposeDir('prestashop', empty)).toThrow(/no docker-compose\.yml in .*LD_E2E_PRESTASHOP_COMPOSE_DIR/s);
  });

  it('accepts every name docker compose looks for', () => {
    for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
      const d = dir();
      writeFileSync(join(d, name), 'services: {}\n');
      expect(() => assertComposeDir('prestashop', d)).not.toThrow();
    }
  });

  it('says to start a stopped stack, and passes other errors through', () => {
    const stopped = Object.assign(new Error('Command failed'), { stderr: 'service "prestashop" is not running' });
    expect(explainComposeError('prestashop', '/x', stopped).message).toMatch(/not running .*docker compose up -d.* \/x/);
    const other = new Error('something else');
    expect(explainComposeError('prestashop', '/x', other)).toBe(other);
  });

  it('the PrestaShop driver stops before Docker when the folder is wrong', async () => {
    const driver = new PrestaShopDriver({ composeDir: dir(), baseUrl: 'http://localhost:8080' });
    await expect(driver.placeOrder('RLUSD')).rejects.toThrow(/LD_E2E_PRESTASHOP_COMPOSE_DIR/);
  });
});
