/** The fields of the status contract; any of them in a refusal is order data. */
const CONTRACT_FIELDS = ['schema_version', 'state', 'base_asset', 'amount_requested', 'amount_paid', 'shortfall', 'seconds_left', 'redirect', 'hash'];

/**
 * What a refusal of the status endpoint gives away about the order (PS-07): its
 * reference, or a field of the status contract. A JSON body is read as JSON, at
 * every depth — a platform's error format (`{"errors":[{"status":"403"}]}`) is no
 * leak, a contract field nested under `details` is, also inside a stringified
 * value; any other body (a platform's HTML error page) only by the reference and
 * the contract's markers, not by words like "state" that every error page contains.
 */
export function refusalLeaks(body: string, reference: string): string[] {
  const leaks: string[] = [];
  if (reference !== '' && body.includes(reference)) {
    leaks.push('order reference');
  }
  const found = { fields: new Set<string>(), markup: false };
  scanText(body, found);
  for (const field of CONTRACT_FIELDS) {
    if (found.fields.has(field)) {
      leaks.push(`field ${field}`);
    }
  }
  if (found.markup) {
    leaks.push('payment page markup');
  }
  return leaks;
}

type Found = { fields: Set<string>; markup: boolean };

/**
 * One rule for every text: the body itself and every string value inside it.
 * Text that parses as JSON is read as JSON (a stringified refusal inside
 * `details` included); any other text by the contract's markers (`"state":`,
 * whitespace before the colon allowed) and `data-ld-` markup, and once more
 * after decoding its HTML entities, so an HTML page carrying the contract as
 * `{&quot;state&quot;:…}` is read like the plain one (up to MAX_DECODINGS layers).
 */
function scanText(text: string, found: Found, decodings = 0): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed !== text) {
    walk(parsed, found, decodings);
    return;
  }
  for (const field of CONTRACT_FIELDS) {
    if (new RegExp(`"${field}"\\s*:`).test(text)) found.fields.add(field);
  }
  if (text.includes('data-ld-')) found.markup = true;
  if (decodings >= MAX_DECODINGS) return;
  const decoded = decodeEntities(text);
  if (decoded !== text) scanText(decoded, found, decodings + 1);
}

/** Layers of entity encoding read per text; a page encodes once, rarely twice. Bounds the work for `&amp;amp;amp;…`. */
const MAX_DECODINGS = 4;

/** Every key at any depth; every string value goes through the same rule as the body. */
function walk(value: unknown, found: Found, decodings: number): void {
  if (typeof value === 'string') {
    scanText(value, found, decodings);
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, found, decodings);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((CONTRACT_FIELDS as readonly string[]).includes(key)) found.fields.add(key);
      walk(item, found, decodings);
    }
  }
}

/**
 * Every named entity that can write a character of a marker: the quote, the
 * colon, the underscore of a field name, whitespace before the colon (all that
 * `\s` matches), and `&`, `<`, `>` for markup written twice. Letters and `-`
 * have no named entity; they come as numeric references.
 */
const NAMED_ENTITIES: Record<string, string> = {
  quot: '"', QUOT: '"', amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', apos: "'",
  colon: ':', lowbar: '_', UnderBar: '_',
  Tab: '\t', NewLine: '\n', nbsp: '\u00a0', NonBreakingSpace: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', emsp13: '\u2004', emsp14: '\u2005', numsp: '\u2007', puncsp: '\u2008',
  thinsp: '\u2009', ThinSpace: '\u2009', hairsp: '\u200a', VeryThinSpace: '\u200a', MediumSpace: '\u205f',
};
/** HTML also reads these without `;` (`&quot`, `&quotstate`); matched in any case, a little wider than HTML, which only errs towards a finding. */
const LEGACY_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: '\u00a0' };

/**
 * One pass of HTML entity decoding as a browser reads it: decimal (`&#34;`) and
 * hexadecimal (`&#x22;`) with or without `;`, named ones with `;` (`&quot;`),
 * the legacy ones also without `;`. One pass only: `&amp;quot;`
 * becomes `&quot;`, which the next scan decodes in turn.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*);|(quot|amp|lt|gt|nbsp))/gi, (match: string, dec?: string, hex?: string, named?: string, legacy?: string) => {
    if (dec !== undefined || hex !== undefined) {
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex as string, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (named !== undefined) {
      const known = NAMED_ENTITIES[named];
      if (known !== undefined) return known;
      // `&quotstate;` is no entity, but a browser still reads its legacy prefix
      const prefix = Object.keys(LEGACY_ENTITIES).find((key) => named.toLowerCase().startsWith(key));
      return prefix === undefined ? match : LEGACY_ENTITIES[prefix] + match.slice(1 + prefix.length);
    }
    return LEGACY_ENTITIES[(legacy as string).toLowerCase()] ?? match;
  });
}
