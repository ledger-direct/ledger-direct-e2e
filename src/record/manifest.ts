import { RECORD_FILES, RECORD_FPS, type OrderedBy, type RecordColorScheme, type RecordAsset, type RecordStart, type VideoSize } from './options.js';

/**
 * Seconds from the first frame of the video, with a tenth of a second — what the edit needs to
 * find the moments. Null for a moment the recording never reached.
 */
export interface RecordTimeline {
  /** The payment page is in the browser (0 with --start payment). */
  paymentPageReached: number | null;
  /** The payment was handed to the ledger. */
  paymentSent: number | null;
  /** The ledger validated it. */
  transactionValidated: number | null;
  /** The page shows the payment as received (data-ld-state="settled"). */
  pageShowsSettled: number | null;
  /** The page left for the order confirmation. */
  redirect: number | null;
  /** The last frame. */
  end: number | null;
}

export interface RecordFacts {
  target: string;
  baseUrl: string;
  try: boolean;
  chain: string;
  pluginVersion: string | null;
  harnessVersion: string;
  asset: RecordAsset;
  start: RecordStart;
  /** `prefers-color-scheme` as the page saw it. */
  colorScheme: RecordColorScheme;
  /** Who placed the order: the browser (with a walk), or the driver. */
  orderedBy: OrderedBy;
  /** `customer` when an account made for the recording was logged in off camera; absent for a guest. */
  buyer?: 'guest' | 'customer';
  size: VideoSize;
  startedAt: Date;
  /** The order as the driver placed it; absent when the browser placed it. */
  order?: { id: string; reference: string };
  payment?: {
    amount: string;
    asset: string;
    destinationAccount: string;
    destinationTag: string;
    hash: string;
    result: string;
    ledgerIndex?: number;
    explorer: string;
  };
  /** Milliseconds since the epoch for each moment; the first frame is `videoStart`. */
  moments: { videoStart: number | null } & Partial<Record<Exclude<keyof RecordTimeline, never>, number | null>>;
  /** Null when the recording went through; the reason when it stopped early. */
  error: string | null;
}

/** Seconds from `from` to `at`, one decimal; null when either is unknown. */
export function relative(from: number | null | undefined, at: number | null | undefined): number | null {
  if (from === null || from === undefined || at === null || at === undefined) return null;
  return Math.round((at - from) / 100) / 10;
}

/**
 * recording.json: what the edit and the post need — the shop, the payment with its hash as
 * evidence, and when each moment happens in the video. Testnet facts only: no seed, no page URL
 * (it carries the order's secret), no admin login.
 */
export function buildManifest(facts: RecordFacts): Record<string, unknown> {
  const t0 = facts.moments.videoStart;
  const at = (key: keyof RecordTimeline) => relative(t0, facts.moments[key]);
  const timeline: RecordTimeline = {
    paymentPageReached: at('paymentPageReached'),
    paymentSent: at('paymentSent'),
    transactionValidated: at('transactionValidated'),
    pageShowsSettled: at('pageShowsSettled'),
    redirect: at('redirect'),
    end: at('end'),
  };
  return {
    schemaVersion: 1,
    shop: { target: facts.target, baseUrl: facts.baseUrl, try: facts.try, pluginVersion: facts.pluginVersion },
    chain: facts.chain,
    network: 'testnet',
    asset: facts.asset,
    start: facts.start,
    orderedBy: facts.orderedBy,
    ...(facts.buyer ? { buyer: facts.buyer } : {}),
    colorScheme: facts.colorScheme,
    order: facts.order ?? null,
    payment: facts.payment
      ? {
          amount: facts.payment.amount,
          asset: facts.payment.asset,
          destinationAccount: facts.payment.destinationAccount,
          destinationTag: facts.payment.destinationTag,
          transactionHash: facts.payment.hash,
          result: facts.payment.result,
          ledgerIndex: facts.payment.ledgerIndex ?? null,
          explorer: facts.payment.explorer,
        }
      : null,
    timeline,
    video: { file: RECORD_FILES.video, width: facts.size.width, height: facts.size.height, fps: RECORD_FPS, codec: 'h264', pixelFormat: 'yuv420p' },
    stills: { first: RECORD_FILES.first, settled: RECORD_FILES.settled, confirmation: RECORD_FILES.confirmation },
    recordedAt: facts.startedAt.toISOString(),
    harness: { name: 'ledger-direct-e2e', version: facts.harnessVersion },
    error: facts.error,
  };
}
