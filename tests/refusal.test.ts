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

  // The reference must not occur in the bodies: `&#x22;` contains an x.
  const REF = 'QIUHFBAPK';

  it('finds contract fields and markup written with HTML entities in an HTML body (#18)', () => {
    const page = (inner: string) => `<!DOCTYPE html><html><body><div data-props="${inner}"></div></body></html>`;
    expect(refusalLeaks(page('{&quot;state&quot;:&quot;waiting&quot;}'), REF)).toEqual(['field state']);
    expect(refusalLeaks(page('{&#34;amount_paid&#34;:&#34;1&#34;}'), REF)).toEqual(['field amount_paid']);
    expect(refusalLeaks(page('{&#x22;seconds_left&#x22; : 120}'), REF)).toEqual(['field seconds_left']);
    expect(refusalLeaks(page('{&#X22;hash&#X22;:&#X22;ABC&#X22;}'), REF)).toEqual(['field hash']);
    expect(refusalLeaks(page('{&QUOT;redirect&QUOT;:&QUOT;/x&QUOT;}'), REF)).toEqual(['field redirect']);
    expect(refusalLeaks(page('{&quotshortfall&quot:0}'), REF)).toEqual(['field shortfall']);
    expect(refusalLeaks(page('{&#34base_asset&#34&colon;"XRP"}'), REF)).toEqual(['field base_asset']);
    expect(refusalLeaks('<p>data&#45;ld-state</p><p>data&hyphen;ld-amount</p>', REF)).toEqual(['payment page markup']);
    expect(refusalLeaks('&lt;div data-ld-state=&quot;waiting&quot;&gt;', REF)).toEqual(['payment page markup']);
  });

  it('decodes HTML entities written twice and inside JSON string values (#18)', () => {
    expect(refusalLeaks('<pre>{&amp;quot;state&amp;quot;:1}</pre>', REF)).toEqual(['field state']);
    expect(refusalLeaks('<pre>{&amp;#34;amount_requested&amp;#x22;:1}</pre>', REF)).toEqual(['field amount_requested']);
    expect(refusalLeaks(JSON.stringify({ error: 'forbidden', html: '<div data-x="{&quot;schema_version&quot;:1}"></div>' }), REF)).toEqual(['field schema_version']);
    expect(refusalLeaks(JSON.stringify({ error: 'forbidden', details: '{&quot;state&quot;:&quot;waiting&quot;}' }), REF)).toEqual(['field state']);
    expect(refusalLeaks('<pre>{&amp;amp;amp;quot;hash&amp;amp;amp;quot;:1}</pre>', REF)).toEqual(['field hash']);
  });

  it('decodes numeric references with leading zeroes (#18)', () => {
    expect(refusalLeaks('<p>{&#000000034;state&#000000034;:1}</p>', REF)).toEqual(['field state']);
    expect(refusalLeaks('<p>{&#x0000000022;amount_paid&#x0000000022;:1}</p>', REF)).toEqual(['field amount_paid']);
  });

  it('bounds the work for deeply encoded text (#18)', () => {
    const deep = '&' + 'amp;'.repeat(200_000) + 'quot;state' + '&quot;:1';
    expect(() => refusalLeaks(deep, REF)).not.toThrow();
    expect(refusalLeaks(JSON.stringify({ error: 'forbidden', html: deep }), REF)).toEqual([]);
  });

  it('accepts an entity-encoded HTML page that only mentions contract words (#18)', () => {
    expect(refusalLeaks('<p>&quot;state&quot; unknown &amp; amount_paid not shown &#8212; 403</p>', REF)).toEqual([]);
    expect(refusalLeaks('<p>&unknown; &#0; &#x110000; &#99999999; &amp</p>', REF)).toEqual([]);
    expect(refusalLeaks(`<p>&#${'9'.repeat(400)}; &#x${'f'.repeat(400)};</p>`, REF)).toEqual([]);
  });
});
