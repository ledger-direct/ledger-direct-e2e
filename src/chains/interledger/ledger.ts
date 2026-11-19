import type { Authorization, Balances, ChainAsset, FreshAccount, IncomingPayment, Ledger, PaymentRequest, PaymentResult } from '../chain.js';
import { describeUrl } from '../../http.js';
import { INTERLEDGER_ASSETS } from './assets.js';
import { type AccessToken, type Amount, fromScale, OpenPaymentsClient, OpenPaymentsError, type OutgoingPayment, type PendingGrant, readReceivedAmount, readWalletAddress, toScale, type WalletAddress } from './client.js';
import { privateKeyOf } from './signature.js';

/**
 * Interledger behind the chain contract, through Open Payments: the harness as an
 * agent that pays from somebody's wallet, within a limit its owner approved.
 *
 * What the contract's words mean here:
 * - The **receiving account** is the merchant's wallet address; a run does not make
 *   one, it uses the shop's (see runCases).
 * - A payment goes **to** an incoming payment's URL, which is what the payment page
 *   shows as the account. The identifier travels with that URL; nothing is sent beside it.
 * - The **seed** is the agent's private key. With it alone nothing can be paid: the key
 *   signs requests, and the owner's grant decides what they may move.
 * - There is **no ledger to read**: a payment is on record at the two wallets. Anyone
 *   may read what an incoming payment has received, and that is the proof. The **hash**
 *   of a payment is therefore the incoming payment's id: the one name both sides know,
 *   and what the shop stores. Two payments into one incoming payment share it.
 *
 * The grant is asked for once per process and kept in memory only: an outgoing-payment
 * grant with a debit limit, decided by the owner in their wallet. Until they approve,
 * nothing is paid; afterwards every order is quoted and paid without them.
 */
export interface InterledgerSettings {
  /** Who asks: the wallet address whose key set lists the agent's key. */
  clientWalletAddress: string;
  keyId: string;
  /** The wallet the money comes from; the client's own when not named. */
  payingWalletAddress: string;
  /** The asset the shop's wallet takes, and so the one orders are quoted in. */
  asset: string;
  /** The most the grant may debit, in the paying wallet's units. */
  grantLimit: string;
  /** The owner's own wallet (a Dassie node's local one), for a link straight to the consent page. */
  ownerWallet?: string;
}

export const ENV_CLIENT_WALLET_ADDRESS = 'LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_WALLET_ADDRESS';
export const ENV_CLIENT_KEY_ID = 'LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_KEY_ID';
export const ENV_CLIENT_PRIVATE_KEY = 'LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY';
export const DEFAULT_GRANT_LIMIT = '10';

export function interledgerSettings(env: NodeJS.ProcessEnv = process.env): InterledgerSettings {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set. Load ~/.config/ledger-direct/testnet.env into the environment (set -a; source …; set +a).`);
    return value;
  };
  const clientWalletAddress = httpsUrl(required(ENV_CLIENT_WALLET_ADDRESS), ENV_CLIENT_WALLET_ADDRESS);
  const paying = env.LD_E2E_INTERLEDGER_PAYING_WALLET?.trim();
  const owner = env.LD_E2E_INTERLEDGER_OWNER_WALLET?.trim();
  const asset = (env.LD_E2E_INTERLEDGER_ASSET?.trim() || 'XRP').toUpperCase();
  if (!INTERLEDGER_ASSETS.includes(asset)) throw new Error(`LD_E2E_INTERLEDGER_ASSET must be one of ${INTERLEDGER_ASSETS.join(', ')}, got "${asset}"`);
  const grantLimit = env.LD_E2E_INTERLEDGER_GRANT_LIMIT?.trim() || DEFAULT_GRANT_LIMIT;
  if (!/^\d+(\.\d+)?$/.test(grantLimit) || Number(grantLimit) <= 0) throw new Error(`LD_E2E_INTERLEDGER_GRANT_LIMIT must be a positive decimal, got "${grantLimit}"`);
  return {
    clientWalletAddress,
    keyId: required(ENV_CLIENT_KEY_ID),
    payingWalletAddress: paying ? httpsUrl(paying, 'LD_E2E_INTERLEDGER_PAYING_WALLET') : clientWalletAddress,
    asset,
    grantLimit,
    ...(owner ? { ownerWallet: owner.replace(/\/+$/, '') } : {}),
  };
}

/** A wallet address is an https URL; a payment pointer (`$wallet.example/alice`) is its short form. */
export function httpsUrl(value: string, label: string): string {
  const candidate = value.startsWith('$') ? `https://${value.slice(1)}` : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${label} must be a wallet address (https://…), got something that is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must be an https wallet address`);
  return candidate.replace(/\/+$/, '');
}

export function isWalletAddress(value: string): boolean {
  try {
    httpsUrl(value, 'wallet address');
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the owner decides. The redirect is where the specifications send a browser.
 * A Dassie node behind a front door serves no wallet there: its owner decides in their
 * own wallet, at `/consent/{id}?key={key}`, the two parts the interaction URL ends with.
 */
export function consentLinks(redirect: string | undefined, ownerWallet?: string): string[] {
  if (!redirect) return ownerWallet ? [`${ownerWallet}/grants`] : [];
  const interaction = /\/gnap\/interact\/([^/?#]+)\/([^/?#]+)\/?$/.exec(redirect);
  if (ownerWallet && interaction) return [`${ownerWallet}/consent/${interaction[1]}?key=${encodeURIComponent(interaction[2])}`];
  return ownerWallet ? [`${ownerWallet}/grants`, redirect] : [redirect];
}

interface Granted {
  token: AccessToken;
  wallet: WalletAddress;
}

/** The last segment of an incoming payment's URL: its id at the receiving wallet. */
export function incomingPaymentId(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
}

/** How long the owner has: a Dassie node lets a request lapse after ten minutes. */
const APPROVAL_WAIT_MS = 10 * 60 * 1000;
/** How long a payment may take to arrive once the wallet accepted it. */
const DELIVERY_WAIT_MS = 90_000;
/** A token this close to its end is rotated before it is used. */
const ROTATE_BEFORE_MS = 30_000;

/** One request to an owner: the grant once it is given, and until then where the owner decides. */
interface GrantRequest {
  granted: Promise<Granted>;
  /** Resolves when the request is out and waits, or is decided, whichever is first. */
  asked: Promise<void>;
  approved: boolean;
  approveAt: string[];
  asks: string;
  /** The grant, once given: its token is what tells a grant that is over from one that lasts. */
  grant?: Granted;
  /** A rotation of the token that is under way: everybody who needs the token waits for this one. */
  rotating?: Promise<void>;
}

/**
 * A wallet's answer that ends a request for good: it was refused, lapsed or is not known.
 * A server in trouble (5xx) and a client told to slow down (408, 429) say nothing of the
 * request, which may still wait in the owner's wallet.
 */
function isFinal(error: unknown): boolean {
  return error instanceof OpenPaymentsError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

/** The wallet does not know the token (any more): revoked by the owner, or run out. */
function isUnauthorized(error: unknown): boolean {
  return error instanceof OpenPaymentsError && error.status === 401;
}

/** A grant whose token ran out and names no place to get another: the owner has to be asked again. */
function isOver(request: GrantRequest, now = Date.now()): boolean {
  const token = request.grant?.token;
  return token !== undefined && token.expiresAt !== undefined && token.expiresAt <= now && !token.manage;
}

/**
 * Grants by what was asked (paying wallet, client, its key, the limit), for the life of the
 * process: the MCP server and a catalogue run in it pay under one approval, and a ledger with
 * another limit asks for its own. In memory only: a token never touches a disk.
 */
const grants = new Map<string, GrantRequest>();

/**
 * How the last request ended when it ended badly (refused, lapsed), until somebody who asks
 * without waiting has been told. Without it such a caller would never hear of it: the next
 * question would quietly put a new request in front of the owner, and the one after that again.
 */
const failures = new Map<string, Error>();

/** Tests only: forget every grant of the process. */
export function resetInterledgerGrants(): void {
  grants.clear();
  failures.clear();
}

export class InterledgerLedger implements Ledger {
  readonly chain = 'INTERLEDGER' as const;
  readonly nativeAsset: string;
  readonly makesAccounts = false;
  readonly accountPerQuote = true;
  private readonly settings: InterledgerSettings;
  private client?: OpenPaymentsClient;

  /** @param sleep tests pass their own, so no test waits for a wallet */
  constructor(
    settings?: InterledgerSettings,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.settings = settings ?? interledgerSettings();
    this.nativeAsset = this.settings.asset;
  }

  /** One asset: the one the merchant's wallet address holds. Nothing here is issued, so no case pays "the wrong token". */
  assets(): ChainAsset[] {
    return [{ code: this.nativeAsset, native: true }];
  }

  createFresh(): Promise<FreshAccount> {
    return Promise.reject(new Error('Interledger has no throwaway accounts: the receiving account is the merchant\'s wallet address, which the wallet gives out, not the harness'));
  }

  fund(): Promise<{ address: string; amount: string }> {
    return Promise.reject(new Error('Interledger has no faucet: the paying wallet is filled by its owner'));
  }

  balances(address: string): Promise<Balances> {
    return Promise.reject(new Error(`Open Payments shows no balance of ${describeUrl(address)}: only the wallet's owner sees it, in the wallet`));
  }

  /** The seed is the agent's key; the address that pays is the wallet the owner granted access to. */
  addressOf(): string {
    return this.settings.payingWalletAddress;
  }

  /** There is no explorer: the public record of a payment is the incoming payment it went into. */
  explorerUrl(hash: string): string {
    return /^https:\/\//.test(hash) ? hash : '';
  }

  /**
   * Asks the owner of the paying wallet for the grant, once per process, and waits for the
   * decision. `announce` gets the line that tells the owner where to decide.
   */
  async authorize(seed: string, announce: (line: string) => void): Promise<void> {
    try {
      await this.granted(seed, announce);
    } catch (error) {
      // This caller waited and has the answer; it is not news for the next question.
      failures.delete(this.grantId());
      throw error;
    }
  }

  /** Asks if nobody has yet, and answers as soon as the request waits or is decided. A refusal throws. */
  async authorization(seed: string): Promise<Authorization> {
    // A request that ended badly since the last question is reported once, and only the
    // question after that asks the owner again: nobody is asked anew behind the caller's back.
    const id = this.grantId();
    const failed = failures.get(id);
    if (failed && !grants.has(id)) {
      failures.delete(id);
      throw failed;
    }
    const announce = (line: string): void => console.error(line);
    let request = this.request(seed, announce);
    await this.outOrDecided(request);
    // A grant whose token the wallet will not renew is no approval. The owner is asked again
    // here, and the caller told where: a payment after this answer does not wait for them.
    if (request.grant && !(await this.renewed(seed, request, request.grant))) {
      request = this.request(seed, announce);
      await this.outOrDecided(request);
    }
    return { approved: request.approved, approveAt: request.approved ? [] : request.approveAt, asks: request.asks };
  }

  /** Until the request waits in the owner's wallet or is decided. A refusal throws, and is then told. */
  private async outOrDecided(request: GrantRequest): Promise<void> {
    try {
      await Promise.race([request.asked, request.granted]);
    } catch (error) {
      // This caller has the answer; it is not news for the next question.
      if (failures.get(this.grantId()) === error) failures.delete(this.grantId());
      throw error;
    }
  }

  async pay(request: PaymentRequest): Promise<PaymentResult> {
    if (!/^https:\/\//.test(request.to)) throw new Error('an Interledger payment goes to an incoming payment\'s URL, as the payment page shows it');
    const before = await readReceivedAmount(request.to);
    if (before.assetCode.toUpperCase() !== request.asset.toUpperCase()) {
      throw new Error(`the incoming payment takes ${before.assetCode}, not ${request.asset}: an Open Payments wallet cannot be paid in another asset`);
    }
    const receive: Amount = { value: toScale(request.amount, before.assetScale), assetCode: before.assetCode, assetScale: before.assetScale };
    if (BigInt(receive.value) === 0n) throw new Error(`${request.amount} ${request.asset} is nothing at the asset's scale of ${before.assetScale}`);

    const granted = await this.usable(request.seed, (line) => console.error(line));
    const client = this.clientFor(request.seed);
    let payment: OutgoingPayment;
    try {
      const quote = await client.createQuote(granted.wallet, granted.token, request.to, receive);
      payment = await client.createOutgoingPayment(granted.wallet, granted.token, quote.id);
    } catch (error) {
      // A token the wallet no longer knows pays nothing again: the next payment asks the owner.
      // Nothing is sent a second time here; whoever called decides that.
      if (isUnauthorized(error) && grants.get(this.grantId())?.grant === granted) grants.delete(this.grantId());
      throw error;
    }

    // Two things say that this payment arrived. The receiver: the incoming payment holds the
    // amount more than before. The payer: this outgoing payment has sent something and has not
    // failed, so the amount is not somebody else's. An outgoing payment names what it sent in
    // the payer's asset and nothing of what was delivered, so the receiver's total stays the measure.
    const target = BigInt(before.value) + BigInt(receive.value);
    const deadline = Date.now() + DELIVERY_WAIT_MS;
    let received = before;
    let unread: unknown;
    const arrived = (): boolean => !payment.failed && BigInt(received.value) >= target && BigInt(payment.sentAmount.value) > 0n;
    while (!payment.failed && !arrived() && Date.now() < deadline) {
      await this.sleep(1500);
      try {
        // The wallet has the payment. A read that fails does not undo that: it is asked again.
        received = await readReceivedAmount(request.to);
        payment = await client.readOutgoingPayment(granted.token, payment.id);
        unread = undefined;
      } catch (error) {
        unread = error;
      }
    }
    const delivered = BigInt(received.value) - BigInt(before.value);
    // Accepted and never read back is not "failed": sending again could pay twice.
    const unconfirmed = `accepted by the paying wallet as ${payment.id}, not confirmed: ${unread instanceof Error ? unread.message : 'it could not be read back'}`;
    return {
      hash: incomingPaymentId(request.to),
      result: arrived() ? 'completed' : payment.failed ? 'failed' : unread !== undefined ? unconfirmed : 'not arrived in time',
      validated: arrived(),
      delivered: delivered > 0n ? fromScale(delivered.toString(), received.assetScale) : null,
      explorer: request.to,
      from: this.settings.payingWalletAddress,
    };
  }

  /** What an incoming payment has received, as one entry: Open Payments does not list the payments that paid it. */
  async incoming(address: string): Promise<IncomingPayment[]> {
    if (!/\/incoming-payments\//.test(address)) return [];
    const received = await readReceivedAmount(address);
    if (BigInt(received.value) === 0n) return [];
    return [{ hash: incomingPaymentId(address), asset: received.assetCode, amount: fromScale(received.value, received.assetScale), from: '', result: 'received', validated: true, explorer: address }];
  }

  async close(): Promise<void> {
    // Nothing is held open. The grant stays for the process: the next ledger of it pays under the same approval.
  }

  private clientFor(seed: string): OpenPaymentsClient {
    return (this.client ??= new OpenPaymentsClient(this.settings.clientWalletAddress, this.settings.keyId, privateKeyOf(seed)));
  }

  private granted(seed: string, announce: (line: string) => void): Promise<Granted> {
    return this.request(seed, announce).granted;
  }

  private request(seed: string, announce: (line: string) => void): GrantRequest {
    const id = this.grantId();
    const known = grants.get(id);
    if (known && !isOver(known)) return known;
    let out!: () => void;
    const request: GrantRequest = { granted: undefined as unknown as Promise<Granted>, asked: new Promise<void>((resolve) => (out = resolve)), approved: false, approveAt: [], asks: '' };
    request.granted = this.askOwner(seed, announce, (asks, approveAt) => {
      request.asks = asks;
      request.approveAt = approveAt;
      out();
    }).then((granted) => {
      request.approved = true;
      request.grant = granted;
      return granted;
    });
    grants.set(id, request);
    failures.delete(id);
    // A refusal or a lapse is not kept: the next payment asks again.
    request.granted.catch((error: unknown) => {
      if (grants.get(id) !== request) return;
      grants.delete(id);
      failures.set(id, error instanceof Error ? error : new Error(String(error)));
    });
    return request;
  }

  private async askOwner(seed: string, announce: (line: string) => void, waiting: (asks: string, approveAt: string[]) => void): Promise<Granted> {
    const client = this.clientFor(seed);
    const wallet = await readWalletAddress(this.settings.payingWalletAddress);
    const limit: Amount = { value: toScale(this.settings.grantLimit, wallet.assetScale), assetCode: wallet.assetCode, assetScale: wallet.assetScale };
    let answer = await client.requestGrant(
      wallet.authServer,
      [
        { type: 'quote', actions: ['create', 'read'] },
        { type: 'outgoing-payment', actions: ['create', 'read'], identifier: wallet.id, limits: { debitAmount: limit } },
      ],
      true,
    );
    const asks = `up to ${this.settings.grantLimit} ${wallet.assetCode} from ${describeUrl(wallet.id)}`;
    if (answer.kind === 'pending') {
      const links = consentLinks(answer.grant.redirect, this.settings.ownerWallet);
      waiting(asks, links);
      announce(`the agent asks to pay ${asks}. Approve it in the wallet${links.length > 0 ? `: ${links.join(' or ')}` : ''}`);
    } else {
      waiting(asks, []);
    }
    const deadline = Date.now() + APPROVAL_WAIT_MS;
    let pending: PendingGrant | undefined;
    try {
      while (answer.kind === 'pending') {
        pending = answer.grant;
        if (Date.now() >= deadline) throw new Error('the owner did not decide the grant in time');
        await this.sleep(pending.waitSeconds * 1000);
        answer = await client.continueGrant(pending);
      }
    } catch (error) {
      // Whatever ended the wait, nothing stays waiting in the owner's wallet: withdrawn, unless
      // the wallet itself said the request is over.
      if (pending && !isFinal(error)) await client.cancelGrant(pending).catch(() => undefined);
      throw error instanceof OpenPaymentsError ? new Error(`the grant was not given: ${error.message}`) : error;
    }
    announce(`grant approved: up to ${this.settings.grantLimit} ${wallet.assetCode}`);
    return { token: answer.token, wallet };
  }

  private grantId(): string {
    return [this.settings.payingWalletAddress, this.settings.clientWalletAddress, this.settings.keyId, this.settings.grantLimit].join('\n');
  }

  /**
   * The grant with a token that still has time: rotated when it is about to lapse. A token
   * that cannot be rotated is used while it lasts; a grant whose token is gone for good, or
   * whose rotation the wallet refuses, is forgotten and the owner is asked again, so a
   * long-lived process (the MCP server) does not keep paying with a dead token.
   */
  private async usable(seed: string, announce: (line: string) => void): Promise<Granted> {
    const request = this.request(seed, announce);
    const granted = await request.granted;
    return (await this.renewed(seed, request, granted)) ? granted : this.granted(seed, announce);
  }

  /**
   * Rotates the grant's token when it is about to lapse. One rotation at a time: a wallet
   * ends the old token with the new one, so a second rotation beside the first would fail
   * and take a grant for dead that has just been renewed. False when the wallet refused:
   * the grant is forgotten, and the owner has to be asked again.
   */
  private async renewed(seed: string, request: GrantRequest, granted: Granted): Promise<boolean> {
    if (request.rotating === undefined) {
      const { expiresAt, manage } = granted.token;
      if (expiresAt === undefined || expiresAt - Date.now() > ROTATE_BEFORE_MS || !manage) return true;
      request.rotating = this.clientFor(seed)
        .rotate(granted.token)
        .then((token) => {
          granted.token = token;
        })
        .finally(() => {
          request.rotating = undefined;
        });
    }
    try {
      await request.rotating;
      return true;
    } catch {
      if (grants.get(this.grantId()) === request) grants.delete(this.grantId());
      return false;
    }
  }
}
