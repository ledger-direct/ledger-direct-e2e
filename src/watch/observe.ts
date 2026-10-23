import type { IncomingPayment } from '../chains/chain.js';
import type { PaymentPageView, StatusPayload } from '../drivers/driver.js';
import type { PlatformState } from '../drivers/platform.js';
import { redact } from '../config.js';
import type { ShopSession } from '../session.js';

/**
 * One look at an order from three sides at the same moment — what the customer sees, what the
 * shop recorded, what the ledger holds. The deviation rules (deviations.ts) compare a series of
 * these; the lab shows them as three windows side by side.
 *
 * Every side is read on its own: one that cannot be read is itself a finding, and never hides
 * the other two.
 */
export interface Observation {
  at: string;
  customer: {
    /** HTTP status of the payment page: 200 while the order waits, a redirect once it is closed. */
    pageStatus?: number;
    page?: PaymentPageView;
    status?: StatusPayload;
    error?: string;
  };
  shop: {
    /** Null: the driver cannot see the platform's state. */
    platform?: PlatformState | null;
    /** Every hash the shop stored for the order's account and identifier. */
    recorded?: string[];
    error?: string;
  };
  ledger: {
    incoming?: IncomingPayment[];
    error?: string;
  };
}

/** Where the order is paid: the account and identifier the page showed first. */
export interface PaymentTarget {
  destinationAccount: string;
  paymentIdentifier: string;
}

const message = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

async function attempt<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: message(e) };
  }
}

/**
 * Reads the three sides of an order placed in `session`. `target` is where it is paid; the page
 * stops rendering once the order is closed, so the caller keeps the first one it saw.
 */
export async function observe(session: ShopSession, key: string, target: PaymentTarget): Promise<Observation> {
  const at = new Date().toISOString();
  const [pageResponse, status, platform, recorded, incoming] = await Promise.all([
    attempt(() => session.pageResponse(key)),
    attempt(() => session.status(key)),
    attempt(() => session.platformState(key)),
    attempt(() => session.recordedHashes(key, target)),
    attempt(() => session.incoming(key, target)),
  ]);
  let page: { value?: PaymentPageView; error?: string } = {};
  if (pageResponse.value?.status === 200) page = await attempt(() => session.page(key));

  const customerError = [pageResponse.error, page.error, status.error].filter(Boolean).join('; ');
  const shopError = [platform.error, recorded.error].filter(Boolean).join('; ');
  return {
    at,
    customer: {
      ...(pageResponse.value ? { pageStatus: pageResponse.value.status } : {}),
      ...(page.value ? { page: page.value } : {}),
      ...(status.value ? { status: status.value } : {}),
      ...(customerError ? { error: customerError } : {}),
    },
    shop: {
      ...(platform.error === undefined ? { platform: platform.value ?? null } : {}),
      ...(recorded.value ? { recorded: recorded.value } : {}),
      ...(shopError ? { error: shopError } : {}),
    },
    ledger: {
      ...(incoming.value ? { incoming: incoming.value } : {}),
      ...(incoming.error ? { error: incoming.error } : {}),
    },
  };
}
