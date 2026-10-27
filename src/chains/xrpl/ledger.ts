import { Client, Wallet } from 'xrpl';
import type { Balances, ChainAsset, FreshAccount, IncomingPayment, Ledger, PaymentRequest, PaymentResult } from '../chain.js';
import { ASSETS, TESTNET_EXPLORER_TX, TESTNET_ISSUED, TESTNET_WS, isAsset } from './assets.js';
import { parseXrplIncoming } from './incoming.js';
import { pay } from './payments.js';
import { balances, createFresh, faucet } from './wallets.js';

/** The XRP Ledger testnet behind the chain contract. */
export class XrplLedger implements Ledger {
  readonly chain = 'XRPL' as const;
  readonly nativeAsset = 'XRP';
  private client?: Client;

  /**
   * The client is reused across a run, but a socket that sat idle through
   * PS-10's 35-minute wait comes back closed — the first request after it
   * timed out, and PS-11 then found the socket CLOSING. A client that is
   * not connected any more is replaced, not reused.
   */
  async connect(): Promise<Client> {
    if (this.client && !this.client.isConnected()) {
      const stale = this.client;
      this.client = undefined;
      await retireClient(stale);
    }
    if (!this.client) {
      this.client = new Client(TESTNET_WS);
      await this.client.connect();
    }
    return this.client;
  }

  assets(): ChainAsset[] {
    return ASSETS.map((code) => (code === 'XRP' ? { code, native: true } : { code, native: false, issuer: TESTNET_ISSUED[code].issuer }));
  }

  async createFresh(options: { trustlines?: boolean } = {}): Promise<FreshAccount> {
    const c = await this.connect();
    const created = await createFresh(c, options);
    return { address: created.wallet.classicAddress, seed: created.wallet.seed!, trustlines: created.trustlines };
  }

  async fund(address: string): Promise<{ address: string; amount: string }> {
    const r = await faucet(address);
    return { address: r.address, amount: String(r.amount) };
  }

  async balances(address: string): Promise<Balances> {
    const c = await this.connect();
    const b = await balances(c, address);
    return { address: b.address, native: b.xrp, tokens: { ...b.tokens }, trustlines: [...b.trustlines] };
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    if (!isAsset(request.asset)) throw new Error(`XRPL: unknown asset ${request.asset}`);
    const c = await this.connect();
    return pay(c, {
      seed: request.seed,
      to: request.to,
      destinationTag: request.identifier === undefined ? undefined : Number.parseInt(request.identifier, 10),
      amount: request.amount,
      asset: request.asset,
      partial: request.partial,
    });
  }

  async incoming(address: string, options: { identifier?: string; limit?: number } = {}): Promise<IncomingPayment[]> {
    const c = await this.connect();
    const answer = await c.request({ command: 'account_tx', account: address, limit: options.limit ?? 50, forward: false });
    const payments = parseXrplIncoming(answer.result.transactions as unknown[], address, TESTNET_EXPLORER_TX);
    return options.identifier === undefined ? payments : payments.filter((p) => p.identifier === options.identifier);
  }

  explorerUrl(hash: string): string {
    return TESTNET_EXPLORER_TX + hash;
  }

  addressOf(seed: string): string {
    return Wallet.fromSeed(seed).classicAddress;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = undefined;
    }
  }
}

/**
 * Lets go of a client whose socket died, for good.
 *
 * A socket that is already CLOSING is not closed again by disconnect(), which
 * only clears the timers and waits for the close. When that close comes with a
 * code other than xrpl.js's intentional 4000, the connection schedules a
 * reconnect — after the timers were cleared — and the discarded client would
 * come back with a socket and a heartbeat nobody closes. Every such reconnect
 * announces itself with 'reconnecting' just before its timer is set; a
 * disconnect() on the next turn cancels it.
 *
 * The wait for the close is bounded: ws gives up on a closing socket after 30 s
 * by itself, longer than a run should stand still. A close that comes later is
 * still caught by the listener.
 */
export async function retireClient(stale: Client, waitMs = 5000): Promise<void> {
  stale.connection.on('reconnecting', () => setImmediate(() => void stale.disconnect().catch(() => undefined)));
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)));
  await Promise.race([stale.disconnect().catch(() => undefined), bounded]);
  clearTimeout(timer);
}
