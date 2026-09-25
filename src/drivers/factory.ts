import type { Driver } from './driver.js';
import { PrestaShopDriver } from './prestashop.js';
import { ShopwareDriver } from './shopware.js';
import { WooCommerceDriver } from './woocommerce.js';
import { MagentoDriver } from './magento.js';

export const TARGETS = ['prestashop', 'shopware', 'woocommerce', 'magento'] as const;
export type Target = (typeof TARGETS)[number];

/** Command-line overrides; anything absent comes from LD_E2E_<TARGET>_* or the dev-stack default. */
export interface DriverOverrides {
  baseUrl?: string;
  composeDir?: string;
  composeFiles?: string[];
  accessKey?: string;
  container?: string;
}

const DEFAULT_BASE_URL: Record<Target, string> = {
  prestashop: 'http://localhost:8080',
  shopware: 'http://localhost',
  woocommerce: 'http://localhost:8082',
  magento: 'https://localhost:8444',
};

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/**
 * One place that knows how each dev shop is reached. The CLI and the MCP server
 * both build drivers here, so an environment variable means the same in both.
 */
export function createDriver(target: string, overrides: DriverOverrides = {}): { driver: Driver; baseUrl: string } {
  if (!isTarget(target)) throw new Error(`no driver for ${target} — targets: ${TARGETS.join(', ')}`);
  const env = (suffix: string): string | undefined => process.env[`LD_E2E_${target.toUpperCase()}_${suffix}`];
  const baseUrl = overrides.baseUrl ?? env('BASE_URL') ?? DEFAULT_BASE_URL[target];
  const composeDir = overrides.composeDir ?? env('COMPOSE_DIR') ?? '.';

  switch (target) {
    case 'prestashop':
      return { driver: new PrestaShopDriver({ composeDir, baseUrl }), baseUrl };
    case 'shopware': {
      const accessKey = overrides.accessKey ?? env('ACCESS_KEY');
      if (!accessKey) throw new Error('Shopware needs --access-key (or LD_E2E_SHOPWARE_ACCESS_KEY): the sales channel access key');
      return {
        driver: new ShopwareDriver({ baseUrl, accessKey, container: overrides.container ?? env('CONTAINER'), adminUser: env('ADMIN_USER'), adminPassword: env('ADMIN_PASSWORD') }),
        baseUrl,
      };
    }
    case 'woocommerce': {
      const composeFiles = overrides.composeFiles ?? env('COMPOSE_FILES')?.split(',').map((f) => f.trim()).filter(Boolean);
      return { driver: new WooCommerceDriver({ composeDir, composeFiles, baseUrl, service: env('SERVICE') }), baseUrl };
    }
    case 'magento':
      return {
        driver: new MagentoDriver({ baseUrl, composeDir, service: env('SERVICE'), adminUser: env('ADMIN_USER'), adminPassword: env('ADMIN_PASSWORD') }),
        baseUrl,
      };
  }
}
