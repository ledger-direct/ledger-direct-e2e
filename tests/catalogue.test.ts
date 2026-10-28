import { describe, expect, it } from 'vitest';
import { appliesTo, CASES, findCase } from '../src/cases/catalogue.js';

describe('the catalogue', () => {
  it('is platform-neutral except where a case names its platforms', () => {
    const scoped = CASES.filter((c) => c.targets !== undefined).map((c) => c.id);
    expect(scoped).toEqual(['PS-12']);
  });

  it('applies a scoped case to its platforms only', () => {
    const ps12 = findCase('PS-12')!;
    expect(appliesTo(ps12, 'shopware')).toBe(true);
    for (const other of ['prestashop', 'woocommerce', 'magento']) expect(appliesTo(ps12, other)).toBe(false);
  });

  it('applies an unscoped case everywhere', () => {
    const ps05 = findCase('PS-05')!;
    for (const platform of ['prestashop', 'shopware', 'woocommerce', 'magento']) expect(appliesTo(ps05, platform)).toBe(true);
  });
});
