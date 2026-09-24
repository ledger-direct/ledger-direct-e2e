import { Client, Wallet } from 'xrpl';
import type { Balances, ChainAsset, FreshAccount, Ledger, PaymentRequest, PaymentResult } from '../chain.js';
import { ASSETS, TESTNET_EXPLORER_TX, TESTNET_ISSUED, TESTNET_WS, isAsset } from './assets.js';
import { pay } from './payments.js';
import { balances, createFresh, faucet } from './wallets.js';

/** The XRP Ledger testnet behind the chain contract. */
export class XrplLedger implements Ledger {
  readonly chain = 'XRPL' as const;
  readonly nativeAsset = 'XRP';
  private client?: Client;

  async connect(): Promise<Client> {
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
