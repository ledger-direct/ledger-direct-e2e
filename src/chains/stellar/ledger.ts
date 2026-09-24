import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import type { Balances, ChainAsset, FreshAccount, Ledger, PaymentRequest, PaymentResult } from '../chain.js';
import { NATIVE, TESTNET_EXPLORER_TX, TESTNET_FRIENDBOT, TESTNET_HORIZON, TESTNET_ISSUED } from './assets.js';

/**
 * The Stellar testnet behind the chain contract, through Horizon.
 *
 * The payment identifier is the transaction memo of type MEMO_ID — the
 * core's Stellar port carries it in PaymentIntent.destination_tag, so the
 * catalogue does not change. A muxed address (M…) would be the other way to
 * carry it; the harness sends what the payment page shows.
 */
export class StellarLedger implements Ledger {
  readonly chain = 'STELLAR' as const;
  readonly nativeAsset = NATIVE;
  private readonly horizon = new Horizon.Server(TESTNET_HORIZON);
  /** Test assets issued during this process, so a case can pay "the wrong token" without a real second issuer. */
  private readonly issued = new Map<string, { code: string; issuer: string }>(Object.entries(TESTNET_ISSUED));

  assets(): ChainAsset[] {
    return [{ code: NATIVE, native: true }, ...[...this.issued.values()].map((a) => ({ code: a.code, native: false, issuer: a.issuer }))];
  }

  async createFresh(options: { trustlines?: boolean } = {}): Promise<FreshAccount> {
    const kp = Keypair.random();
    await this.fund(kp.publicKey());
    const trustlines: Record<string, string> = {};
    if (options.trustlines) {
      for (const asset of this.issued.values()) {
        trustlines[asset.code] = await this.changeTrust(kp.secret(), asset.code, asset.issuer);
      }
    }
    return { address: kp.publicKey(), seed: kp.secret(), trustlines };
  }

  async fund(address: string): Promise<{ address: string; amount: string }> {
    const response = await fetch(`${TESTNET_FRIENDBOT}?addr=${encodeURIComponent(address)}`);
    if (!response.ok) throw new Error(`Friendbot answered ${response.status} ${response.statusText}`);
    return { address, amount: '10000' };
  }

  async balances(address: string): Promise<Balances> {
    const account = await this.horizon.loadAccount(address);
    const out: Balances = { address, native: '0', tokens: {}, trustlines: [] };
    for (const b of account.balances) {
      if (b.asset_type === 'native') out.native = b.balance;
      else if ('asset_code' in b) {
        out.tokens[b.asset_code] = b.balance;
        out.trustlines.push(b.asset_code);
      }
    }
    return out;
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    const kp = Keypair.fromSecret(request.seed);
    const source = await this.horizon.loadAccount(kp.publicKey());
    const asset = this.resolveAsset(request.asset);
    if (request.partial) throw new Error('Stellar has no partial payments; a path payment with a lower destination amount is a different case');

    const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: request.to, asset, amount: request.amount }))
      .setTimeout(60);
    if (request.identifier !== undefined) builder.addMemo(Memo.id(request.identifier));
    const tx = builder.build();
    tx.sign(kp);
    const submitted = await this.horizon.submitTransaction(tx);
    return {
      hash: submitted.hash,
      result: submitted.successful ? 'success' : 'failed',
      validated: submitted.successful,
      delivered: `${request.amount} ${request.asset}`,
      explorer: this.explorerUrl(submitted.hash),
      from: kp.publicKey(),
    };
  }

  /** Trust line to an issued asset; the receiving side of PS-04 on Stellar. */
  async changeTrust(seed: string, code: string, issuer: string, limit = '1000000'): Promise<string> {
    const kp = Keypair.fromSecret(seed);
    const source = await this.horizon.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: new Asset(code, issuer), limit }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const r = await this.horizon.submitTransaction(tx);
    return r.successful ? 'success' : 'failed';
  }

  /**
   * Issues a classic test asset from a fresh issuer account into `holderSeed`.
   * That is how the M0 spike produced TESTUSD, and how the harness gets a
   * token "from another issuer" for the wrong-asset case without touching
   * the core's registry.
   */
  async issueTestAsset(code: string, holderSeed: string, amount = '1000'): Promise<{ code: string; issuer: string }> {
    const issuer = Keypair.random();
    await this.fund(issuer.publicKey());
    await this.changeTrust(holderSeed, code, issuer.publicKey());
    const source = await this.horizon.loadAccount(issuer.publicKey());
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.fromSecret(holderSeed).publicKey(), asset: new Asset(code, issuer.publicKey()), amount }))
      .setTimeout(60)
      .build();
    tx.sign(issuer);
    await this.horizon.submitTransaction(tx);
    const asset = { code, issuer: issuer.publicKey() };
    this.issued.set(code, asset);
    return asset;
  }

  registerAsset(code: string, issuer: string): void {
    this.issued.set(code, { code, issuer });
  }

  explorerUrl(hash: string): string {
    return TESTNET_EXPLORER_TX + hash;
  }

  addressOf(seed: string): string {
    return Keypair.fromSecret(seed).publicKey();
  }

  async close(): Promise<void> {
    // Horizon is plain HTTP; nothing to close.
  }

  private resolveAsset(code: string): Asset {
    if (code === NATIVE) return Asset.native();
    const issued = this.issued.get(code);
    if (!issued) throw new Error(`Stellar: unknown asset ${code} — register it (registerAsset) or issue a test asset first`);
    return new Asset(issued.code, issued.issuer);
  }
}
