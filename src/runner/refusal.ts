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
 * whitespace before the colon allowed) and `data-ld-` markup.
 */
function scanText(text: string, found: Found): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined && parsed !== text) {
    walk(parsed, found);
    return;
  }
  for (const field of CONTRACT_FIELDS) {
    if (new RegExp(`"${field}"\\s*:`).test(text)) found.fields.add(field);
  }
  if (text.includes('data-ld-')) found.markup = true;
}

/** Every key at any depth; every string value goes through the same rule as the body. */
function walk(value: unknown, found: Found): void {
  if (typeof value === 'string') {
    scanText(value, found);
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((CONTRACT_FIELDS as readonly string[]).includes(key)) found.fields.add(key);
      walk(item, found);
    }
  }
}
