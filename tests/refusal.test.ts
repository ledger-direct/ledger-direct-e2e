import { describe, expect, it } from 'vitest';
import { refusalLeaks } from '../src/runner/refusal.js';

describe('refusalLeaks (PS-07)', () => {
  it('accepts the plugins\' JSON refusal', () => {
    expect(refusalLeaks('{"error":"forbidden"}', '000000004')).toEqual([]);
  });

  it('accepts a platform error format with a status of its own', () => {
    expect(refusalLeaks('{"errors":[{"code":"0","status":"403","title":"Forbidden"}]}', 'ABC')).toEqual([]);
  });

  it('accepts an HTML error page that mentions "state" and "amount"', () => {
    const html = '<!DOCTYPE html><html><body><script>var state = {}; let amount = 0;</script><h1>403</h1></body></html>';
    expect(refusalLeaks(html, 'QIUHFBAPK')).toEqual([]);
  });

  it('finds contract fields in a JSON refusal', () => {
    expect(refusalLeaks('{"error":"forbidden","state":"waiting","amount_requested":"1"}', 'x')).toEqual(['field state', 'field amount_requested']);
  });

  it('finds the order reference anywhere', () => {
    expect(refusalLeaks('<p>Order QIUHFBAPK</p>', 'QIUHFBAPK')).toEqual(['order reference']);
  });

  it('finds the payment page markup in an HTML body', () => {
    expect(refusalLeaks('<div data-ld-state="waiting"></div>', 'x')).toEqual(['payment page markup']);
  });
});
