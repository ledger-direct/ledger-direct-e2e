import type { Driver, PlacedOrder } from './driver.js';

/**
 * What the platform itself recorded for an order — the merchant's view, not the customer's.
 * Drivers expose it as an optional `orderState()` with a common shape
 * (`state.is_paid`, `state.is_incomplete`, `payments[].transaction_id`, `intent.hash`).
 */
export interface PlatformState {
  /** The platform's own name for the state (`paid`, `processing`, `Payment accepted` …). */
  name?: string;
  paid: boolean;
  incomplete: boolean;
  awaiting?: boolean;
  /** Transaction hashes on the order's payment records, one entry per record (empty when a record has none yet). */
  payments: string[];
  /** The hash in the stored payment intent. */
  intentHash?: string;
  raw: Record<string, unknown>;
}

type WithOrderState = Driver & { orderState?: (order: PlacedOrder) => Promise<Record<string, unknown>> };

export function hasPlatformState(driver: Driver): boolean {
  return typeof (driver as WithOrderState).orderState === 'function';
}

/** Null when the driver cannot see the platform's state. */
export async function readPlatformState(driver: Driver, order: PlacedOrder): Promise<PlatformState | null> {
  const d = driver as WithOrderState;
  if (!d.orderState) return null;
  const raw = await d.orderState(order);
  const state = (raw.state ?? {}) as { is_paid?: boolean; is_incomplete?: boolean; is_awaiting?: boolean; name?: string };
  const payments = ((raw.payments as Array<{ transaction_id?: string }> | undefined) ?? []).map((p) => String(p.transaction_id ?? ''));
  const intent = raw.intent as { hash?: string } | null | undefined;
  return {
    ...(state.name !== undefined ? { name: String(state.name) } : {}),
    paid: state.is_paid === true,
    incomplete: state.is_incomplete === true,
    ...(state.is_awaiting !== undefined ? { awaiting: state.is_awaiting === true } : {}),
    payments,
    ...(intent?.hash ? { intentHash: intent.hash } : {}),
    raw,
  };
}
