import type { KeyObject } from 'node:crypto';
import { describeUrl, httpFetch } from '../../http.js';
import { signedHeaders } from './signature.js';

/**
 * The part of Open Payments a paying agent needs, and nothing else: read a wallet
 * address and an incoming payment (public, unsigned), ask for a grant and wait for
 * the owner, quote, pay, and read the payment back.
 *
 * Written against the specifications, not around one wallet: the same calls reach a
 * Dassie node and a Rafiki wallet. Requests go to the URLs the wallet names, exactly
 * as it names them. No token and no key ever reaches an error message.
 */
export interface Amount {
  value: string;
  assetCode: string;
  assetScale: number;
}

export interface WalletAddress {
  id: string;
  assetCode: string;
  assetScale: number;
  authServer: string;
  resourceServer: string;
}

export interface AccessItem {
  type: 'quote' | 'outgoing-payment' | 'incoming-payment';
  actions: string[];
  identifier?: string;
  limits?: { debitAmount?: Amount; receiveAmount?: Amount; interval?: string };
}

/** A grant the owner has not decided yet. */
export interface PendingGrant {
  /** Where the owner decides. It carries the interaction's key: for the owner's eyes, never for a report. */
  redirect?: string;
  continueUri: string;
  continueToken: string;
  waitSeconds: number;
}

export interface AccessToken {
  value: string;
  /** Where the token is rotated or revoked. */
  manage?: string;
  /** Epoch milliseconds; absent when the wallet names no lifetime. */
  expiresAt?: number;
}

export type GrantAnswer = { kind: 'pending'; grant: PendingGrant } | { kind: 'granted'; token: AccessToken };

export interface Quote {
  id: string;
  receiver: string;
  debitAmount: Amount;
  receiveAmount: Amount;
  expiresAt?: string;
}

export interface OutgoingPayment {
  id: string;
  failed: boolean;
  receiver: string;
  debitAmount: Amount;
  receiveAmount: Amount;
  sentAmount: Amount;
}

/** A refusal by a wallet: the status and what the wallet said in the specifications' error form. */
export class OpenPaymentsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OpenPaymentsError';
  }
}

export async function readWalletAddress(url: string): Promise<WalletAddress> {
  const body = await publicJson(url);
  const doc = body as Partial<WalletAddress>;
  if (typeof doc.id !== 'string' || typeof doc.assetCode !== 'string' || typeof doc.assetScale !== 'number' || typeof doc.authServer !== 'string' || typeof doc.resourceServer !== 'string') {
    throw new Error(`${describeUrl(url)} is not a wallet address: id, assetCode, assetScale, authServer or resourceServer is missing`);
  }
  return { id: doc.id, assetCode: doc.assetCode, assetScale: doc.assetScale, authServer: doc.authServer, resourceServer: doc.resourceServer };
}

/** What anyone may read of an incoming payment without a token: how much it has received. */
export async function readReceivedAmount(incomingPaymentUrl: string): Promise<Amount> {
  const body = (await publicJson(incomingPaymentUrl)) as { receivedAmount?: unknown };
  const amount = asAmount(body.receivedAmount);
  if (!amount) throw new Error(`${describeUrl(incomingPaymentUrl)} is not an incoming payment: it names no receivedAmount`);
  return amount;
}

async function publicJson(url: string): Promise<unknown> {
  const response = await httpFetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new OpenPaymentsError(`GET ${describeUrl(url)} answered ${response.status}`, response.status);
  return response.json();
}

export function asAmount(value: unknown): Amount | undefined {
  const a = value as Partial<Amount> | null | undefined;
  if (!a || typeof a.value !== 'string' || !/^\d+$/.test(a.value) || typeof a.assetCode !== 'string' || typeof a.assetScale !== 'number') return undefined;
  return { value: a.value, assetCode: a.assetCode, assetScale: a.assetScale };
}

/** What a grant request or a continuation answered: a token, or the place to wait. */
export function parseGrantAnswer(body: unknown, now = Date.now()): GrantAnswer {
  const answer = body as { access_token?: { value?: unknown; manage?: unknown; expires_in?: unknown }; continue?: { uri?: unknown; wait?: unknown; access_token?: { value?: unknown } }; interact?: { redirect?: unknown } };
  if (typeof answer.access_token?.value === 'string') {
    const expiresIn = answer.access_token.expires_in;
    return {
      kind: 'granted',
      token: {
        value: answer.access_token.value,
        ...(typeof answer.access_token.manage === 'string' ? { manage: answer.access_token.manage } : {}),
        ...(typeof expiresIn === 'number' ? { expiresAt: now + expiresIn * 1000 } : {}),
      },
    };
  }
  const next = answer.continue;
  if (typeof next?.uri === 'string' && typeof next.access_token?.value === 'string') {
    return {
      kind: 'pending',
      grant: {
        ...(typeof answer.interact?.redirect === 'string' ? { redirect: answer.interact.redirect } : {}),
        continueUri: next.uri,
        continueToken: next.access_token.value,
        waitSeconds: typeof next.wait === 'number' && next.wait > 0 ? next.wait : 5,
      },
    };
  }
  throw new Error('the authorization server answered neither a token nor a way to continue');
}

export class OpenPaymentsClient {
  /**
   * @param clientWalletAddress who asks: a wallet address whose `jwks.json` lists the key
   * @param keyId the key's id in that key set
   */
  constructor(
    readonly clientWalletAddress: string,
    private readonly keyId: string,
    private readonly key: KeyObject,
  ) {}

  /** Asks for a grant; with `interactive`, one the owner decides, by GNAP's redirect interaction. */
  async requestGrant(authServer: string, access: AccessItem[], interactive: boolean): Promise<GrantAnswer> {
    const body = { access_token: { access }, client: this.clientWalletAddress, ...(interactive ? { interact: { start: ['redirect'] } } : {}) };
    return parseGrantAnswer(await this.send('POST', authServer, body));
  }

  /** Asks again whether the owner has decided. A refusal or a lapsed request is an OpenPaymentsError. */
  async continueGrant(pending: PendingGrant): Promise<GrantAnswer> {
    const answer = parseGrantAnswer(await this.send('POST', pending.continueUri, {}, pending.continueToken));
    // A wallet that keeps waiting names where to ask next, not where the owner decides: that stays as it was.
    return answer.kind === 'pending' && pending.redirect !== undefined ? { kind: 'pending', grant: { ...answer.grant, redirect: pending.redirect } } : answer;
  }

  /** Withdraws a request the owner has not decided, so nothing is left waiting in their wallet. */
  async cancelGrant(pending: PendingGrant): Promise<void> {
    await this.send('DELETE', pending.continueUri, undefined, pending.continueToken);
  }

  /** A new token for the same grant, before the old one lapses. */
  async rotate(token: AccessToken): Promise<AccessToken> {
    if (!token.manage) throw new Error('the access token names no place to rotate it');
    const answer = parseGrantAnswer(await this.send('POST', token.manage, undefined, token.value));
    if (answer.kind !== 'granted') throw new Error('rotating the access token answered no token');
    return answer.token;
  }

  /** Gives the grant back: the token is of no use afterwards. */
  async revoke(token: AccessToken): Promise<void> {
    if (!token.manage) return;
    await this.send('DELETE', token.manage, undefined, token.value);
  }

  /** What paying `receiveAmount` into the incoming payment `receiver` costs; without an amount, what it still asks for. */
  async createQuote(wallet: WalletAddress, token: AccessToken, receiver: string, receiveAmount?: Amount): Promise<Quote> {
    const body = { walletAddress: wallet.id, receiver, method: 'ilp', ...(receiveAmount ? { receiveAmount } : {}) };
    const quote = (await this.send('POST', `${trimSlash(wallet.resourceServer)}/quotes`, body, token.value)) as Record<string, unknown>;
    const debitAmount = asAmount(quote.debitAmount);
    const received = asAmount(quote.receiveAmount);
    if (typeof quote.id !== 'string' || !debitAmount || !received) throw new Error('the wallet answered a quote without id, debitAmount or receiveAmount');
    return { id: quote.id, receiver, debitAmount, receiveAmount: received, ...(typeof quote.expiresAt === 'string' ? { expiresAt: quote.expiresAt } : {}) };
  }

  async createOutgoingPayment(wallet: WalletAddress, token: AccessToken, quoteId: string): Promise<OutgoingPayment> {
    return outgoingPaymentOf(await this.send('POST', `${trimSlash(wallet.resourceServer)}/outgoing-payments`, { walletAddress: wallet.id, quoteId }, token.value));
  }

  async readOutgoingPayment(token: AccessToken, id: string): Promise<OutgoingPayment> {
    return outgoingPaymentOf(await this.send('GET', id, undefined, token.value));
  }

  private async send(method: string, url: string, body?: unknown, token?: string): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers = signedHeaders({ method, url, ...(text !== undefined ? { body: text } : {}), ...(token !== undefined ? { authorization: `GNAP ${token}` } : {}) }, this.keyId, this.key);
    const response = await httpFetch(url, { method, headers, ...(text !== undefined ? { body: text } : {}) });
    const raw = await response.text();
    if (!response.ok) throw refusal(method, url, response.status, raw, token);
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`${method} ${describeUrl(url)} answered ${response.status} with something that is not JSON`);
    }
  }
}

function outgoingPaymentOf(body: unknown): OutgoingPayment {
  const payment = body as Record<string, unknown>;
  const debitAmount = asAmount(payment.debitAmount);
  const receiveAmount = asAmount(payment.receiveAmount);
  const sentAmount = asAmount(payment.sentAmount);
  if (typeof payment.id !== 'string' || typeof payment.receiver !== 'string' || !debitAmount || !receiveAmount || !sentAmount) {
    throw new Error('the wallet answered an outgoing payment without id, receiver, debitAmount, receiveAmount or sentAmount');
  }
  return { id: payment.id, failed: payment.failed === true, receiver: payment.receiver, debitAmount, receiveAmount, sentAmount };
}

/**
 * The wallet's words for a refusal, as the specifications shape them
 * (`{ error: { code, description } }`), bounded and without control characters:
 * the text ends up in a report. A body in any other shape is not quoted, and the
 * request's own token is taken out of what is.
 */
function refusal(method: string, url: string, status: number, raw: string, token?: string): OpenPaymentsError {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const error = (JSON.parse(raw) as { error?: { code?: unknown; description?: unknown } | string }).error;
    if (typeof error === 'string') code = error;
    else if (error) {
      if (typeof error.code === 'string') code = error.code;
      if (typeof error.description === 'string') description = error.description;
    }
  } catch {
    // Not JSON: nothing to quote.
  }
  // A wallet that repeats the token it was sent does not get it into a report through here.
  const clean = (text: string): string => (token ? text.replaceAll(token, '[token]') : text).replace(/[^\x20-\x7e]/g, ' ').slice(0, 300);
  const said = [code, description].filter((part): part is string => part !== undefined).map(clean).join(': ');
  return new OpenPaymentsError(`${method} ${describeUrl(url)} answered ${status}${said ? ` (${said})` : ''}`, status, code);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** A decimal in the asset's units as the integer of its scale: 1.11667 at scale 9 is 1116670000. */
export function toScale(amount: string, scale: number): string {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(amount);
  if (!m) throw new Error(`"${amount}" is not a non-negative decimal`);
  const fraction = m[2] ?? '';
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) throw new Error(`${amount} has more decimal places than the asset's ${scale}`);
  return BigInt(m[1] + fraction.slice(0, scale).padEnd(scale, '0')).toString();
}

/** The integer of an asset's scale as a decimal with exactly that many places, as a payment page shows it. */
export function fromScale(value: string, scale: number): string {
  if (!/^\d+$/.test(value)) throw new Error(`"${value}" is not an amount in the asset's smallest unit`);
  if (scale === 0) return BigInt(value).toString();
  const digits = BigInt(value).toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
