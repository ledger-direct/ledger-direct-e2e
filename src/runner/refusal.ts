/** The fields of the status contract; any of them in a refusal is order data. */
const CONTRACT_FIELDS = ['schema_version', 'state', 'base_asset', 'amount_requested', 'amount_paid', 'shortfall', 'seconds_left', 'redirect', 'hash'];

/**
 * What a refusal of the status endpoint gives away about the order (PS-07): its
 * reference, or a field of the status contract. A JSON body is read as JSON, at
 * every depth — a platform's error format (`{"errors":[{"status":"403"}]}`) is no
 * leak, a contract field nested under `details` is; any other
 * body (a platform's HTML error page) only by the reference and the contract's
 * markers, not by words like "state" that every error page contains.
 */
export function refusalLeaks(body: string, reference: string): string[] {
  const leaks: string[] = [];
  if (reference !== '' && body.includes(reference)) {
    leaks.push('order reference');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const found = { fields: new Set<string>(), markup: false };
    walk(parsed, found);
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
  for (const field of CONTRACT_FIELDS) {
    if (new RegExp(`"${field}"\\s*:`).test(body)) {
      leaks.push(`field ${field}`);
    }
  }
  if (body.includes('data-ld-')) {
    leaks.push('payment page markup');
  }
  return leaks;
}

/** Every key at any depth, and whether a string value carries the payment page's markup. */
function walk(value: unknown, found: { fields: Set<string>; markup: boolean }): void {
  if (typeof value === 'string') {
    if (value.includes('data-ld-')) found.markup = true;
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if ((CONTRACT_FIELDS as readonly string[]).includes(key)) found.fields.add(key);
      walk(item, found);
    }
  }
}
