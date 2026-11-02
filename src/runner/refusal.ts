/** The fields of the status contract; any of them in a refusal is order data. */
const CONTRACT_FIELDS = ['schema_version', 'state', 'base_asset', 'amount_requested', 'amount_paid', 'shortfall', 'seconds_left', 'redirect', 'hash'];

/**
 * What a refusal of the status endpoint gives away about the order (PS-07): its
 * reference, or a field of the status contract. A JSON body is read as JSON — a
 * platform's error format (`{"errors":[{"status":"403"}]}`) is no leak; any other
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
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const field of CONTRACT_FIELDS) {
      if (field in parsed) {
        leaks.push(`field ${field}`);
      }
    }
    return leaks;
  }
  if (parsed === undefined) {
    for (const field of CONTRACT_FIELDS) {
      if (body.includes(`"${field}":`)) {
        leaks.push(`field ${field}`);
      }
    }
    if (body.includes('data-ld-')) {
      leaks.push('payment page markup');
    }
  }
  return leaks;
}
