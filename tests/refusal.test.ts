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

  it('finds contract fields and markup nested in a JSON refusal', () => {
    expect(refusalLeaks('{"error":"forbidden","details":{"state":"waiting","amount_requested":"1"}}', 'x')).toEqual(['field state', 'field amount_requested']);
    expect(refusalLeaks('[{"error":"forbidden","html":"<div data-ld-state=\\"waiting\\"></div>"}]', 'x')).toEqual(['payment page markup']);
  });

  it('finds a contract field with whitespace before the colon in an HTML body', () => {
    expect(refusalLeaks('<script>const order = { "state" : "waiting" }</script>', 'x')).toEqual(['field state']);
  });

  it('finds contract fields and markup in stringified JSON and HTML inside string values', () => {
    expect(refusalLeaks('{"error":"forbidden","details":"{\\"state\\":\\"waiting\\"}"}', 'x')).toEqual(['field state']);
    expect(refusalLeaks(JSON.stringify({ error: 'forbidden', details: JSON.stringify({ inner: JSON.stringify({ amount_paid: '1' }) }) }), 'x')).toEqual(['field amount_paid']);
    expect(refusalLeaks(JSON.stringify({ error: 'forbidden', html: '<script>const o = { "seconds_left" : 120 }</script>' }), 'x')).toEqual(['field seconds_left']);
  });

  it('accepts string values that only mention contract words', () => {
    expect(refusalLeaks('{"error":"forbidden","message":"state unknown, amount_paid not shown"}', 'x')).toEqual([]);
    expect(refusalLeaks('{"error":"forbidden","code":"403"}', 'x')).toEqual([]);
  });
});
