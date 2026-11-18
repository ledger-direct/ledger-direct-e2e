import { join } from 'node:path';
import type { ChainId } from '../chains/chain.js';

/**
 * What `ld-e2e record` and the MCP tool `shop_record_purchase` take, checked before anything is
 * started: a browser, an order or a payment are only worth starting once the arguments are right.
 */
export const RECORD_ASSETS = ['XRP', 'RLUSD', 'USDC', 'XAH'] as const;
export type RecordAsset = (typeof RECORD_ASSETS)[number];

/** `payment`: from the payment page on. `shop`: the whole purchase from the home page. */
export const RECORD_STARTS = ['payment', 'shop'] as const;
export type RecordStart = (typeof RECORD_STARTS)[number];

export interface VideoSize {
  width: number;
  height: number;
}

/** The frame rate of every recording: even, and enough for scrolling and the page's countdowns. */
export const RECORD_FPS = 25;

/**
 * What the page is told about the viewer's colour preference (`prefers-color-scheme`). Headless
 * Chrome otherwise takes the operating system's, so the same command filmed a dark payment page on
 * a Mac in dark mode and a light one elsewhere. A recording names it instead.
 */
export const RECORD_COLOR_SCHEMES = ['light', 'dark'] as const;
export type RecordColorScheme = (typeof RECORD_COLOR_SCHEMES)[number];

export const RECORD_DEFAULTS = { asset: 'RLUSD' as RecordAsset, start: 'payment' as RecordStart, size: '1280x720', colorScheme: 'light' as RecordColorScheme };

export function parseColorScheme(value: string): RecordColorScheme {
  const scheme = value.trim().toLowerCase();
  if (!(RECORD_COLOR_SCHEMES as readonly string[]).includes(scheme)) throw new Error(`--color-scheme: ${value} is not one of ${RECORD_COLOR_SCHEMES.join(', ')}`);
  return scheme as RecordColorScheme;
}

/** `1280x720` → { width: 1280, height: 720 }. Even sides only: H.264 in yuv420p needs them. */
export function parseSize(value: string): VideoSize {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim());
  if (!match) throw new Error(`--size: "${value}" is not WIDTHxHEIGHT, e.g. 1280x720 or 1080x1080`);
  const [width, height] = [Number(match[1]), Number(match[2])];
  if (width < 320 || height < 320 || width > 3840 || height > 3840) throw new Error(`--size: ${value} is outside 320…3840 pixels a side`);
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`--size: ${value} has an odd side; H.264 in yuv420p needs even ones`);
  return { width, height };
}

export function parseAsset(value: string): RecordAsset {
  const asset = value.trim().toUpperCase();
  if (!(RECORD_ASSETS as readonly string[]).includes(asset)) throw new Error(`--asset: ${value} is not one of ${RECORD_ASSETS.join(', ')}`);
  return asset as RecordAsset;
}

/**
 * The chain a recording pays on: Xahau for XAH, which exists nowhere else (a try shop sends XAH to
 * its own Xahau account), else the one asked for.
 */
export function recordChain(asset: RecordAsset, chain: ChainId): ChainId {
  return asset === 'XAH' ? 'XAHAU' : chain;
}

export function parseStart(value: string): RecordStart {
  const start = value.trim().toLowerCase();
  if (!(RECORD_STARTS as readonly string[]).includes(start)) throw new Error(`--start: ${value} is not one of ${RECORD_STARTS.join(', ')}`);
  return start as RecordStart;
}

/** `2026-11-18T09:05:03.123Z` → `20261118-090503`, UTC: sortable, and safe in a folder name. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
}

/** `out/recordings/<target>-<asset>-<start>-<size>-<timestamp>/`, the default of --out. */
export function defaultOutDir(target: string, asset: RecordAsset, start: RecordStart, size: VideoSize, date: Date, root = 'out/recordings', colorScheme: RecordColorScheme = 'light'): string {
  return join(root, `${target}-${asset.toLowerCase()}-${start}-${size.width}x${size.height}-${colorScheme}-${stamp(date)}`);
}

/** The files one recording leaves in its folder. */
export const RECORD_FILES = {
  video: 'recording.mp4',
  first: 'first.png',
  settled: 'settled.png',
  confirmation: 'confirmation.png',
  manifest: 'recording.json',
  log: 'record.log',
  /** Only when a recording stops early: what the browser showed. */
  failure: 'failure.png',
} as const;

/**
 * Who places the order. --start shop: the browser, on camera. --start payment: the browser off
 * camera when the plugin has a walk, because a storefront shows its order confirmation only to the
 * session that ordered (Shopware sends anyone else to the cart); the driver otherwise, as in the
 * catalogue.
 */
export type OrderedBy = 'browser' | 'driver';

export function orderedBy(start: RecordStart, walkModule: string | undefined): OrderedBy {
  return start === 'shop' || walkModule ? 'browser' : 'driver';
}
