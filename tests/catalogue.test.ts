import { describe, expect, it } from 'vitest';
import { appliesTo, CASES, findCase } from '../src/cases/catalogue.js';
import { RUNNERS } from '../src/runner/cases.js';
import { resolveCaseIds } from '../src/runner/run.js';

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

describe('the named case sets', () => {
  it('keeps the nightly-only cases out of automated and in nightly', () => {
    const nightlyOnly = CASES.filter((c) => c.nightlyOnly).map((c) => c.id);
    expect(nightlyOnly).toEqual(['PS-04', 'PS-10']);
    const automated = resolveCaseIds('automated');
    for (const id of nightlyOnly) expect(automated).not.toContain(id);
    expect(automated).toContain('PS-12');
    expect(resolveCaseIds('nightly')).toEqual(Object.keys(RUNNERS));
    expect(resolveCaseIds('all')).toEqual(CASES.map((c) => c.id));
  });

  it('reads a list of ids case-insensitively', () => {
    expect(resolveCaseIds('ps-05, PS-12')).toEqual(['PS-05', 'PS-12']);
  });
});

