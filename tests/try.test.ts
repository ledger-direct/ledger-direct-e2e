import { describe, expect, it } from 'vitest';
import { createDriver } from '../src/drivers/factory.js';
import { TRY_PRESETS, tryAccountFromLog, tryLogSource } from '../src/drivers/try.js';
import { isolateEnv } from './env.js';

/** The options a driver was built with; every driver keeps them in `options`. */
const optionsOf = (driver: unknown): Record<string, unknown> => (driver as { options: Record<string, unknown> }).options;

describe('--try preset', () => {
  isolateEnv([
    'LD_E2E_SHOPWARE_BASE_URL', 'LD_E2E_SHOPWARE_ACCESS_KEY', 'LD_E2E_SHOPWARE_CONTAINER', 'LD_E2E_SHOPWARE_ADMIN_USER', 'LD_E2E_SHOPWARE_ADMIN_PASSWORD', 'LD_E2E_SHOPWARE_TEST_PRODUCT',
    'LD_E2E_MAGENTO_BASE_URL', 'LD_E2E_MAGENTO_COMPOSE_DIR', 'LD_E2E_MAGENTO_ADMIN_USER', 'LD_E2E_MAGENTO_ADMIN_PASSWORD',
    'LD_E2E_PRESTASHOP_COMPOSE_DIR', 'LD_E2E_WOOCOMMERCE_COMPOSE_DIR',
  ]);

  it('reaches every try shop by its port and compose project', () => {
    for (const target of ['magento', 'prestashop', 'woocommerce'] as const) {
      const { driver, baseUrl } = createDriver(target, { try: true });
      expect(baseUrl).toBe(TRY_PRESETS[target].baseUrl);
      expect(optionsOf(driver).composeProject).toBe(TRY_PRESETS[target].composeProject);
    }
  });

  it('gives Shopware its access key, container, demo login and test article', () => {
    const { driver, baseUrl } = createDriver('shopware', { try: true });
    expect(baseUrl).toBe('http://localhost:8091');
    expect(optionsOf(driver)).toMatchObject({
      accessKey: 'SWSCLEDGERDIRECTTRYSHOP000', container: 'ledger-direct-try-shopware-shopware-1',
      adminUser: 'demo', adminPassword: 'demo-ledgerdirect-1', testProductNumber: 'ledger-direct-demo',
    });
  });

  it('gives Magento the demo login', () => {
    expect(optionsOf(createDriver('magento', { try: true }).driver)).toMatchObject({ adminUser: 'demo', adminPassword: 'demo-ledgerdirect-1' });
  });

  it("ignores the dev shop's variables, which would otherwise reach the dev shop", () => {
    process.env.LD_E2E_SHOPWARE_BASE_URL = 'http://localhost';
    process.env.LD_E2E_SHOPWARE_ACCESS_KEY = 'SWSCDEVSHOP';
    process.env.LD_E2E_MAGENTO_ADMIN_USER = 'john.smith';
    process.env.LD_E2E_MAGENTO_COMPOSE_DIR = '/somewhere/dev-magento';
    const shopware = createDriver('shopware', { try: true });
    expect(shopware.baseUrl).toBe('http://localhost:8091');
    expect(optionsOf(shopware.driver).accessKey).toBe('SWSCLEDGERDIRECTTRYSHOP000');
    const magento = optionsOf(createDriver('magento', { try: true }).driver);
    expect(magento.adminUser).toBe('demo');
    expect(magento.composeDir).toBe('.');
    expect(magento.composeProject).toBe('ledger-direct-try-magento');
  });

  it('lets command-line options win, e.g. another port', () => {
    const { baseUrl, driver } = createDriver('shopware', { try: true, baseUrl: 'http://localhost:8093', container: 'other' });
    expect(baseUrl).toBe('http://localhost:8093');
    expect(optionsOf(driver).container).toBe('other');
  });

  it('uses an explicit compose folder instead of the project name', () => {
    const options = optionsOf(createDriver('prestashop', { try: true, composeDir: '/x/dev/try' }).driver);
    expect(options.composeDir).toBe('/x/dev/try');
    expect(options.composeProject).toBeUndefined();
  });

  it('changes nothing without --try', () => {
    process.env.LD_E2E_SHOPWARE_ACCESS_KEY = 'SWSCDEVSHOP';
    const { driver, baseUrl } = createDriver('shopware', {});
    expect(baseUrl).toBe('http://localhost');
    expect(optionsOf(driver).accessKey).toBe('SWSCDEVSHOP');
    expect(optionsOf(createDriver('magento', {}).driver).composeProject).toBeUndefined();
  });
});

describe('tryAccountFromLog', () => {
  it('reads the account a try stack logs on start', () => {
    expect(tryAccountFromLog('boot\n[ledger-direct-try] receiving account: rK5jKjTdrvCvhfRUfG9GYXB214bYKqxc9c\nready')).toBe('rK5jKjTdrvCvhfRUfG9GYXB214bYKqxc9c');
  });

  it('takes the last start, e.g. after a restart with LD_TESTNET_ACCOUNT', () => {
    const log = '[ledger-direct-try] receiving account: rFirst\n...\n[ledger-direct-try] receiving account: rSecond\n';
    expect(tryAccountFromLog(log)).toBe('rSecond');
  });

  it('is undefined for a log without that line', () => {
    expect(tryAccountFromLog('Starting Apache\n')).toBeUndefined();
  });
});

describe('tryLogSource', () => {
  it('reads the preset container by default', () => {
    expect(tryLogSource('magento')).toEqual({ args: ['logs', 'ledger-direct-try-magento-phpfpm-1'] });
  });

  it('reads the stack chosen with --compose-dir, through its service', () => {
    expect(tryLogSource('woocommerce', { composeDir: '/x/dev/try' })).toEqual({
      args: ['compose', 'logs', '--no-color', '--no-log-prefix', 'wp'], cwd: '/x/dev/try',
    });
  });

  it('passes the compose files chosen with --compose-files, as the driver does', () => {
    expect(tryLogSource('woocommerce', { composeDir: '/x', composeFiles: ['compose.yaml', 'compose.try.yaml'] })).toEqual({
      args: ['compose', '-f', 'compose.yaml', '-f', 'compose.try.yaml', 'logs', '--no-color', '--no-log-prefix', 'wp'], cwd: '/x',
    });
  });

  it('reads the container chosen with --container', () => {
    expect(tryLogSource('shopware', { container: 'other-shopware-1', composeDir: '/ignored' })).toEqual({ args: ['logs', 'other-shopware-1'] });
  });
});
