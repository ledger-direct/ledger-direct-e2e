import { Client } from 'xrpl';
import type { Driver, PlacedOrder, PaymentPageView, ShopConfig, StatusPayload } from '../drivers/driver.js';
import { pay, type PaymentResult } from '../ledger/payments.js';
import type { Asset } from '../assets.js';

export interface Evidence {
  kind: 'order' | 'tx' | 'state' | 'note';
  text: string;
  hash?: string;
  explorer?: string;
}

export class CaseContext {
  readonly evidence: Evidence[] = [];
  readonly states: string[] = [];

  constructor(
    readonly driver: Driver,
    readonly client: Client,
    private readonly payerSeed: string,
    readonly timeoutMs: number,
    readonly log: (line: string) => void,
    readonly shop: ShopConfig,
  ) {}

  /** Re-points the shop with one setting changed; the caller restores it afterwards. */
  async reconfigure(changes: Partial<ShopConfig>): Promise<void> {
    await this.driver.configure({ ...this.shop, ...changes });
  }

  note(text: string): void {
    this.evidence.push({ kind: 'note', text });
    this.log(text);
  }

  async placeOrder(asset: PaymentPageView['asset']): Promise<{ order: PlacedOrder; page: PaymentPageView }> {
    const order = await this.driver.placeOrder(asset, '');
    const page = await this.driver.paymentPage(order);
    this.evidence.push({ kind: 'order', text: `order ${order.reference} (#${order.id}), page shows ${page.amountDisplayed} ${page.asset} to ${page.destinationAccount} tag ${page.destinationTag}, state ${page.state}` });
    this.log(`order ${order.reference}: ${page.amountDisplayed} ${page.asset}, tag ${page.destinationTag}`);
    return { order, page };
  }

  async pay(page: PaymentPageView, amount: string, asset: Asset = page.asset, extra: { partial?: boolean } = {}): Promise<PaymentResult> {
    const result = await pay(this.client, { seed: this.payerSeed, to: page.destinationAccount, destinationTag: page.destinationTag, amount, asset, partial: extra.partial });
    this.evidence.push({ kind: 'tx', text: `sent ${amount} ${asset} → ${result.result}`, hash: result.hash, explorer: result.explorer });
    this.log(`paid ${amount} ${asset}: ${result.result} ${result.hash}`);
    if (result.result !== 'tesSUCCESS') throw new Error(`payment failed: ${result.result}`);
    return result;
  }

  /** Polls the status endpoint until `until` accepts a payload, recording every state seen. */
  async pollUntil(order: PlacedOrder, until: (s: StatusPayload) => boolean, label: string, intervalMs = 8000): Promise<StatusPayload> {
    const deadline = Date.now() + this.timeoutMs;
    let last: StatusPayload | undefined;
    while (Date.now() < deadline) {
      last = await this.driver.status(order);
      if (this.states[this.states.length - 1] !== last.state) {
        this.states.push(last.state);
        this.evidence.push({ kind: 'state', text: `poll: ${last.state}${last.redirect ? ' + redirect' : ''}` });
        this.log(`state ${last.state}${last.redirect ? ' (redirect)' : ''}`);
      }
      if (until(last)) return last;
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for ${label}; last state ${last?.state ?? 'none'}`);
  }

  expect(condition: boolean, message: string): void {
    if (!condition) throw new Error(`expectation failed: ${message}`);
    this.evidence.push({ kind: 'note', text: `ok: ${message}` });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
