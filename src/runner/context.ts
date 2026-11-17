import type { Driver, PlacedOrder, PaymentPageView, ShopConfig, StatusPayload } from '../drivers/driver.js';
import type { Ledger, PaymentResult } from '../chains/chain.js';

export interface Evidence {
  kind: 'order' | 'tx' | 'state' | 'note';
  text: string;
  hash?: string;
  explorer?: string;
}

/**
 * A case left the shop in a state no further case may run on: PS-13…15 could not put the
 * run's receiving account back. runCases records the case as failed and the rest as not run.
 */
export class RunAborted extends Error {}

export class CaseContext {
  readonly evidence: Evidence[] = [];
  readonly states: string[] = [];

  constructor(
    readonly driver: Driver,
    readonly ledger: Ledger,
    private readonly payerSeed: string,
    readonly timeoutMs: number,
    readonly log: (line: string) => void,
    readonly shop: ShopConfig,
  ) {}

  /** The quoted asset and the wrong one for PS-04: the chain's two issued assets. */
  wrongAssetPair(): [string, string] {
    const issued = this.ledger.assets().filter((a) => !a.native).map((a) => a.code);
    if (issued.length < 2) throw new Error(`PS-04 needs two issued assets on ${this.ledger.chain}; known: ${issued.join(', ') || 'none'}`);
    return [issued[1], issued[0]];
  }

  /** Re-points the shop with one setting changed; the caller restores it afterwards. */
  async reconfigure(changes: Partial<ShopConfig>): Promise<void> {
    await this.driver.configure({ ...this.shop, ...changes });
  }

  /**
   * Sends a case's own account back to the treasury (PS-13, PS-15), as the run does with its
   * throwaway account; a chain without sweep() leaves it. A failure is noted, not thrown: the
   * case's result does not depend on the money coming back.
   */
  async returnToTreasury(seed: string): Promise<void> {
    if (!this.ledger.sweep) return;
    try {
      const swept = await this.ledger.sweep(seed, this.ledger.addressOf(this.payerSeed));
      this.note(`returned to the treasury: ${swept.native} ${this.ledger.nativeAsset}${swept.failed.length > 0 ? `, failed: ${swept.failed.join(", ")}` : ""}`);
    } catch (error) {
      this.note(`could not return the case's account to the treasury: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  note(text: string): void {
    this.evidence.push({ kind: 'note', text });
    this.log(text);
  }

  async placeOrder(asset: string): Promise<{ order: PlacedOrder; page: PaymentPageView }> {
    const order = await this.driver.placeOrder(asset);
    const page = await this.driver.paymentPage(order);
    this.evidence.push({ kind: 'order', text: `order ${order.reference} (#${order.id}), page shows ${page.amountDisplayed} ${page.asset} to ${page.destinationAccount} id ${page.paymentIdentifier}, state ${page.state}` });
    this.log(`order ${order.reference}: ${page.amountDisplayed} ${page.asset}, id ${page.paymentIdentifier}`);
    return { order, page };
  }

  async pay(page: PaymentPageView, amount: string, asset: string = page.asset, extra: { partial?: boolean } = {}): Promise<PaymentResult> {
    const result = await this.ledger.pay({ seed: this.payerSeed, to: page.destinationAccount, identifier: page.paymentIdentifier, amount, asset, partial: extra.partial });
    this.evidence.push({ kind: 'tx', text: `sent ${amount} ${asset} → ${result.result}`, hash: result.hash, explorer: result.explorer });
    this.log(`paid ${amount} ${asset}: ${result.result} ${result.hash}`);
    if (!result.validated) throw new Error(`payment failed: ${result.result}`);
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
