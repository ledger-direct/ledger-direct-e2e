/**
 * Decimal strings as the shop displays them, halved without floating point. The harness never
 * recomputes what a page asks for; half of it is the one deliberate exception, for the partial
 * payments of PS-02/PS-03 and the lab's "pay half" button.
 */
export function halfOf(amount: string): string {
  const [int, frac = ''] = amount.split('.');
  const scale = frac.length;
  const units = BigInt(int + frac);
  const half = units / 2n;
  const s = half.toString().padStart(scale + 1, '0');
  return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Decimals as integers with 18 places, so sums of 0.81466 never drift (the same scale as the spend guard). */
const SCALE = 18n;

export function decimalUnits(amount: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(amount);
  if (!m) return null;
  const fraction = (m[2] ?? '').slice(0, Number(SCALE)).padEnd(Number(SCALE), '0');
  return BigInt(m[1]) * 10n ** SCALE + BigInt(fraction);
}

export function fromDecimalUnits(units: bigint): string {
  const whole = units / 10n ** SCALE;
  const fraction = (units % 10n ** SCALE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** Sum of decimal strings, exact; null if one of them is not a decimal. */
export function sumDecimals(amounts: string[]): string | null {
  let total = 0n;
  for (const a of amounts) {
    const u = decimalUnits(a);
    if (u === null) return null;
    total += u;
  }
  return fromDecimalUnits(total);
}

/** "0.83211" equals "0.832110"; a float like 0.83211 from a status payload is read as its decimal text. */
export function sameDecimal(a: string, b: string): boolean {
  const x = decimalUnits(a), y = decimalUnits(b);
  return x !== null && y !== null && x === y;
}

/** The value of an amount as the status payload carries it: a number (native) or `{ value }` (issued). */
export function amountValue(amount: unknown): string | null {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === 'number') return String(amount);
  if (typeof amount === 'string') return amount;
  if (typeof amount === 'object' && 'value' in amount) return String((amount as { value: unknown }).value);
  return null;
}
