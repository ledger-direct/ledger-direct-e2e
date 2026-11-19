import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAccountOf, isChain, treasurySeedVariable } from '../src/chains/index.js';
import { GuardedLedger, SpendGuard } from '../src/chains/spend.js';
import { fromScale, OpenPaymentsClient, parseGrantAnswer, targetUri, toScale } from '../src/chains/interledger/client.js';
import { consentLinks, incomingPaymentId, InterledgerLedger, interledgerSettings, type InterledgerSettings, resetInterledgerGrants } from '../src/chains/interledger/ledger.js';
import { contentDigest, privateKeyOf, signatureBase, signatureParams, signedHeaders } from '../src/chains/interledger/signature.js';
import type { Ledger } from '../src/chains/chain.js';
import type { Driver } from '../src/drivers/driver.js';
import { readPaymentPage } from '../src/drivers/page.js';
import { isPlainHttpsUrl } from '../src/drivers/shopware.js';
import { INTERLEDGER_ASSETS } from '../src/chains/interledger/assets.js';
import { ORDER_ASSETS } from '../src/mcp.js';
import { amountValue, isAmount } from '../src/amounts.js';
import { runCases } from '../src/runner/run.js';
import { approvedOrRefuse } from '../src/session.js';
import { isolateEnv } from './env.js';

// A key made for this file: nothing here is derived from a key anybody holds.
const pair = generateKeyPairSync('ed25519');
const PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SEED = Buffer.from(PEM).toString('base64');

const CLIENT = 'https://wallet.example/agent';
const PAYER = 'https://payer.example/pay/xrp';
const INCOMING = 'https://merchant.example/incoming-payments/3f2c0d8e-1111-4222-8333-444455556666';
const TOKEN = 'tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';

describe('HTTP message signatures', () => {
  const key = privateKeyOf(SEED);
  const post = { method: 'post', url: 'https://payer.example/quotes', body: '{"walletAddress":"x"}', authorization: `GNAP ${TOKEN}` };

  it('covers method, target, token and body, in that order', () => {
    const params = signatureParams(post, 'key-1', 1_800_000_000);
    expect(params).toBe('("@method" "@target-uri" "authorization" "content-digest" "content-length" "content-type");keyid="key-1";created=1800000000');
    expect(signatureBase(post, params).split('\n')).toEqual([
      '"@method": POST',
      '"@target-uri": https://payer.example/quotes',
      `"authorization": GNAP ${TOKEN}`,
      `"content-digest": ${contentDigest(post.body)}`,
      '"content-length": 21',
      '"content-type": application/json',
      `"@signature-params": ${params}`,
    ]);
  });

  it('covers only method and target for a request without token and body', () => {
    expect(signatureParams({ method: 'GET', url: PAYER }, 'k', 1)).toBe('("@method" "@target-uri");keyid="k";created=1');
  });

  it('writes the signature as a byte sequence that verifies against the public key', () => {
    const headers = signedHeaders(post, 'key-1', key, 1_800_000_000);
    const signature = /^sig1=:([A-Za-z0-9+/]+=*):$/.exec(headers.Signature);
    expect(signature).not.toBeNull();
    const base = signatureBase(post, headers['Signature-Input'].replace(/^sig1=/, ''));
    expect(verify(null, Buffer.from(base), pair.publicKey, Buffer.from(signature![1], 'base64'))).toBe(true);
    expect(headers['Content-Digest']).toBe(contentDigest(post.body));
    expect(headers.Authorization).toBe(`GNAP ${TOKEN}`);
    // fetch writes the length itself and refuses a second one.
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-length');
  });

  it('counts the body in bytes, not characters', () => {
    const request = { method: 'POST', url: PAYER, body: '{"note":"Grüße"}' };
    expect(signatureBase(request, 'x')).toContain('"content-length": 18');
  });

  it('refuses a key id that would change the header', () => {
    expect(() => signatureParams(post, 'a"b', 1)).toThrow(/key id/);
    expect(() => signatureParams(post, '', 1)).toThrow(/key id/);
  });

  it('takes the key as base64 of its PEM or as the PEM, and says nothing of a key it cannot read', () => {
    expect(privateKeyOf(PEM).asymmetricKeyType).toBe('ed25519');
    expect(() => privateKeyOf('bm90IGEga2V5IGF0IGFsbA==')).toThrow('the Interledger client key is not a PEM private key, or the base64 of one');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => privateKeyOf(rsa)).toThrow(/must be Ed25519, this one is rsa/);
  });
});

describe('amounts at an asset\'s scale', () => {
  it('turns what a payment page shows into the wallet\'s integer and back', () => {
    expect(toScale('1.116670000', 9)).toBe('1116670000');
    expect(toScale('1.11667', 9)).toBe('1116670000');
    expect(toScale('19.99', 2)).toBe('1999');
    expect(toScale('5', 0)).toBe('5');
    expect(fromScale('1116670000', 9)).toBe('1.116670000');
    expect(fromScale('5', 9)).toBe('0.000000005');
    expect(fromScale('1999', 2)).toBe('19.99');
    expect(fromScale('7', 0)).toBe('7');
  });

  it('refuses digits the asset cannot carry, but not trailing zeros', () => {
    expect(toScale('1.2300', 2)).toBe('123');
    expect(() => toScale('1.234', 2)).toThrow(/more decimal places/);
    expect(() => toScale('-1', 2)).toThrow(/not a non-negative decimal/);
    expect(() => fromScale('1.5', 2)).toThrow(/smallest unit/);
  });
});

describe('what an authorization server answers', () => {
  it('reads a grant that waits for the owner', () => {
    const answer = parseGrantAnswer({ interact: { redirect: 'https://payer.example/gnap/interact/g1/k1', finish: 'n' }, continue: { access_token: { value: 'c1' }, uri: 'https://payer.example/gnap/continue/g1', wait: 5 } });
    expect(answer).toEqual({ kind: 'pending', grant: { redirect: 'https://payer.example/gnap/interact/g1/k1', continueUri: 'https://payer.example/gnap/continue/g1', continueToken: 'c1', waitSeconds: 5 } });
  });

  it('reads a token with the moment it lapses', () => {
    const answer = parseGrantAnswer({ access_token: { value: TOKEN, manage: 'https://payer.example/gnap/token/t1', expires_in: 3600 } }, 1_000);
    expect(answer).toEqual({ kind: 'granted', token: { value: TOKEN, manage: 'https://payer.example/gnap/token/t1', expiresAt: 3_601_000 } });
  });

  it('refuses an answer that is neither', () => {
    expect(() => parseGrantAnswer({})).toThrow(/neither a token nor a way to continue/);
  });
});

describe('where the owner decides', () => {
  const redirect = 'https://node.front-door.example/gnap/interact/63988707-ab42/4iz710OHkJ8e2doS';

  it('is the redirect where nothing else is known', () => {
    expect(consentLinks(redirect)).toEqual([redirect]);
  });

  it('is the consent page of the owner\'s own wallet for a node behind a front door', () => {
    expect(consentLinks(redirect, 'https://127.0.0.1:9443')).toEqual(['https://127.0.0.1:9443/consent/63988707-ab42?key=4iz710OHkJ8e2doS']);
  });

  it('falls back to the wallet\'s list for a redirect in another shape', () => {
    expect(consentLinks('https://auth.example/interact/abc', 'https://127.0.0.1:9443')).toEqual(['https://127.0.0.1:9443/grants', 'https://auth.example/interact/abc']);
    expect(consentLinks(undefined, 'https://127.0.0.1:9443')).toEqual(['https://127.0.0.1:9443/grants']);
    expect(consentLinks(undefined)).toEqual([]);
  });
});

describe('the agent\'s settings', () => {
  const names = ['LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_WALLET_ADDRESS', 'LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_KEY_ID', 'LD_E2E_INTERLEDGER_PAYING_WALLET', 'LD_E2E_INTERLEDGER_OWNER_WALLET', 'LD_E2E_INTERLEDGER_ASSET', 'LD_E2E_INTERLEDGER_GRANT_LIMIT'];
  isolateEnv(names);
  const base = { LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_WALLET_ADDRESS: '$wallet.example/agent', LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_KEY_ID: 'key-1' };

  it('pays from the client\'s own wallet unless another is named, in XRP, up to 10', () => {
    expect(interledgerSettings(base)).toEqual({ clientWalletAddress: CLIENT, keyId: 'key-1', payingWalletAddress: CLIENT, asset: 'XRP', grantLimit: '10' });
  });

  it('takes the paying wallet, the owner\'s wallet, the asset and the limit from the environment', () => {
    const settings = interledgerSettings({ ...base, LD_E2E_INTERLEDGER_PAYING_WALLET: `${PAYER}/`, LD_E2E_INTERLEDGER_OWNER_WALLET: 'https://127.0.0.1:9443/', LD_E2E_INTERLEDGER_ASSET: 'eur', LD_E2E_INTERLEDGER_GRANT_LIMIT: '2.5' });
    expect(settings).toMatchObject({ payingWalletAddress: PAYER, ownerWallet: 'https://127.0.0.1:9443', asset: 'EUR', grantLimit: '2.5' });
  });

  it('names what is missing or wrong', () => {
    expect(() => interledgerSettings({})).toThrow(/LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_WALLET_ADDRESS is not set/);
    expect(() => interledgerSettings({ ...base, LD_E2E_INTERLEDGER_PAYING_WALLET: 'http://payer.example/pay' })).toThrow(/https wallet address/);
    expect(() => interledgerSettings({ ...base, LD_E2E_INTERLEDGER_ASSET: 'BTC' })).toThrow(/one of XRP, EUR, USD, DSUSD/);
    expect(() => interledgerSettings({ ...base, LD_E2E_INTERLEDGER_GRANT_LIMIT: '0' })).toThrow(/positive decimal/);
  });
});

describe('Interledger among the chains', () => {
  it('is a chain whose accounts are wallet addresses and whose payer holds a key', () => {
    expect(isChain('interledger')).toBe(true);
    expect(isAccountOf('INTERLEDGER', 'https://node.example/pay/xrp')).toBe(true);
    expect(isAccountOf('INTERLEDGER', '$node.example/pay/xrp')).toBe(true);
    expect(isAccountOf('INTERLEDGER', 'rMW6jyfsGyB5kPoYWVV4z1h9DA5KmEGPYq')).toBe(false);
    expect(isAccountOf('XRPL', 'https://node.example/pay/xrp')).toBe(false);
    expect(treasurySeedVariable('INTERLEDGER')).toBe('LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY');
  });

  it('names a payment by its incoming payment', () => {
    expect(incomingPaymentId(INCOMING)).toBe('3f2c0d8e-1111-4222-8333-444455556666');
    expect(incomingPaymentId(`${INCOMING}/`)).toBe('3f2c0d8e-1111-4222-8333-444455556666');
  });
});

describe('an Interledger payment page', () => {
  const page = `
<div class="ld-page" data-ld-page
     data-ld-state="waiting"
     data-ld-chain="INTERLEDGER"
     data-ld-poll-url="http://localhost/ledger-direct/payment/check/0123?deepLinkCode=abc"
     data-ld-asset="XRP"
     data-ld-network="testnet"
     data-ld-amount-requested="1.113950000">
  <span class="ld-amount-value" data-ld-amount>1.113950000</span>
  <span class="ld-field-value" data-ld-account data-value="${INCOMING}">${INCOMING}</span>
</div>`;

  it('is read without an identifier beside the account: the incoming payment names itself', () => {
    expect(readPaymentPage(page)).toMatchObject({ state: 'waiting', amountDisplayed: '1.113950000', asset: 'XRP', destinationAccount: INCOMING, paymentIdentifier: '3f2c0d8e-1111-4222-8333-444455556666' });
  });

  it('still needs the identifier where the account is a ledger\'s', () => {
    expect(readPaymentPage(page.replaceAll(INCOMING, 'rMW6jyfsGyB5kPoYWVV4z1h9DA5KmEGPYq'))).toBeUndefined();
  });
});

/**
 * Two wallets as one fetch: the payer's authorization and resource server, and the
 * merchant's incoming payment. Every request is kept, so a test can say what was asked.
 */
interface WalletOptions {
  pollsUntilApproved?: number;
  deny?: boolean;
  neverDecides?: boolean;
  failPayment?: boolean;
  incomingAsset?: string;
  expiresIn?: number;
  noManage?: boolean;
  refuseRotation?: boolean;
  /** The authorization server refuses the request itself. */
  refuseRequest?: boolean;
  /** The continuation answers this status instead of a decision. */
  continueStatus?: number;
  /** The resource server no longer knows the token. */
  tokenRevoked?: boolean;
  /** Somebody else fills the incoming payment; this payment sends nothing. */
  paidByAnother?: boolean;
  /** How many reads of the outgoing payment fail before one answers; Infinity for all. */
  unreadable?: number;
}

function wallets(options: WalletOptions = {}) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  let polls = 0;
  let received = 0n;
  let paying: bigint | null = null;
  let sent = 0n;
  let token = TOKEN;
  let rotations = 0;
  let unreadable = options.unreadable ?? 0;
  const json = (body: unknown, status = 200): Response => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const pending = { continue: { access_token: { value: 'continue-token' }, uri: 'https://payer.example/gnap/continue/g1', wait: 5 } };

  const fetchStub = vi.fn(async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    requests.push({ method, url, headers, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) });

    if (method === 'GET' && url === PAYER) return json({ id: PAYER, assetCode: 'XRP', assetScale: 9, authServer: 'https://payer.example/gnap', resourceServer: 'https://payer.example' });
    if (method === 'GET' && url === INCOMING) {
      // The money arrives one read after the wallet took the payment.
      if (paying !== null && !options.failPayment) {
        received += paying;
        if (!options.paidByAnother) sent = 1_127_670_000n;
        paying = null;
      }
      return json({ receivedAmount: { value: received.toString(), assetCode: options.incomingAsset ?? 'XRP', assetScale: 9 }, authServer: 'https://merchant.example/gnap' });
    }
    if (method === 'POST' && url === 'https://payer.example/gnap') {
      if (options.refuseRequest) return json({ error: { code: 'invalid_client', description: 'the client is not known' } }, 403);
      return json({ interact: { redirect: 'https://payer.example/gnap/interact/g1/k1', finish: 'nonce' }, ...pending });
    }
    if (method === 'POST' && url === 'https://payer.example/gnap/continue/g1') {
      polls += 1;
      if (options.continueStatus) return json({ error: { code: 'unavailable', description: 'try later' } }, options.continueStatus);
      if (options.deny) return json({ error: { code: 'user_denied', description: 'the owner refused\u0007 the request' } }, 403);
      if (options.neverDecides || polls < (options.pollsUntilApproved ?? 2)) return json(pending);
      return json({ access_token: { value: TOKEN, ...(options.noManage ? {} : { manage: 'https://payer.example/gnap/token/t1' }), expires_in: options.expiresIn ?? 3600 } });
    }
    if (method === 'POST' && url === 'https://payer.example/gnap/token/t1') {
      // A rotation ends the token it was asked with: a second one with the old token is refused.
      if (options.refuseRotation || headers.authorization !== `GNAP ${token}`) return json({ error: { code: 'invalid_rotation', description: 'the grant was revoked' } }, 401);
      rotations += 1;
      token = `${TOKEN}-${rotations + 1}`;
      return json({ access_token: { value: token, manage: 'https://payer.example/gnap/token/t1', expires_in: 3600 } });
    }
    if (method === 'DELETE' && url === 'https://payer.example/gnap/continue/g1') return json(null, 204);
    if (method === 'POST' && url === 'https://payer.example/quotes') {
      if (options.tokenRevoked) return json({ error: { code: 'invalid_token', description: 'the token is not known' } }, 401);
      const receive = (requests.at(-1)!.body as { receiveAmount: { value: string } }).receiveAmount;
      return json({ id: 'https://payer.example/quotes/q1', walletAddress: PAYER, receiver: INCOMING, method: 'ilp', receiveAmount: { ...receive, assetCode: 'XRP', assetScale: 9 }, debitAmount: { value: (BigInt(receive.value) + 11_000_000n).toString(), assetCode: 'XRP', assetScale: 9 }, expiresAt: '2030-01-01T00:00:00Z' });
    }
    if (method === 'POST' && url === 'https://payer.example/outgoing-payments') {
      paying = 1_116_670_000n;
      return json(outgoing(false));
    }
    if (method === 'GET' && url === 'https://payer.example/outgoing-payments/p1') {
      if (unreadable > 0) {
        unreadable -= 1;
        return json({ error: { code: 'unavailable', description: 'try later' } }, 503);
      }
      return json(outgoing(options.failPayment === true));
    }
    return json({ error: { code: 'not_found', description: `no route for ${method}` } }, 404);
  });
  const outgoing = (failed: boolean) => ({ id: 'https://payer.example/outgoing-payments/p1', walletAddress: PAYER, failed, receiver: INCOMING, receiveAmount: { value: '1116670000', assetCode: 'XRP', assetScale: 9 }, debitAmount: { value: '1127670000', assetCode: 'XRP', assetScale: 9 }, sentAmount: { value: sent.toString(), assetCode: 'XRP', assetScale: 9 } });
  vi.stubGlobal('fetch', fetchStub);
  return { requests, options, of: (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url) };
}

const settings: InterledgerSettings = { clientWalletAddress: CLIENT, keyId: 'key-1', payingWalletAddress: PAYER, asset: 'XRP', grantLimit: '5', ownerWallet: 'https://127.0.0.1:9443' };
const noWait = async (): Promise<void> => {};
const order = { seed: SEED, to: INCOMING, identifier: '3f2c0d8e-1111-4222-8333-444455556666', amount: '1.116670000', asset: 'XRP' };

describe('the agent pays an order', () => {
  beforeEach(() => resetInterledgerGrants());
  afterEach(() => vi.unstubAllGlobals());

  it('asks the owner once, with a debit limit in the paying wallet\'s asset, then quotes and pays', async () => {
    const w = wallets();
    const said: string[] = [];
    const ledger = new InterledgerLedger(settings, noWait);

    await ledger.authorize(SEED, (line) => said.push(line));

    const [grant] = w.of('POST', 'https://payer.example/gnap');
    expect(grant.body).toEqual({
      access_token: {
        access: [
          { type: 'quote', actions: ['create', 'read'] },
          { type: 'outgoing-payment', actions: ['create', 'read'], identifier: PAYER, limits: { debitAmount: { value: '5000000000', assetCode: 'XRP', assetScale: 9 } } },
        ],
      },
      client: CLIENT,
      interact: { start: ['redirect'] },
    });
    expect(grant.headers.signature).toMatch(/^sig1=:.+:$/);
    expect(grant.headers['signature-input']).toContain('keyid="key-1"');
    expect(said[0]).toBe('the agent asks to pay up to 5 XRP from https://payer.example/pay/xrp. Approve it in the wallet: https://127.0.0.1:9443/consent/g1?key=k1');
    expect(said[1]).toBe('grant approved: up to 5 XRP');

    const result = await ledger.pay(order);

    expect(result).toEqual({ hash: '3f2c0d8e-1111-4222-8333-444455556666', result: 'completed', validated: true, delivered: '1.116670000', explorer: INCOMING, from: PAYER });
    const [quote] = w.of('POST', 'https://payer.example/quotes');
    expect(quote.body).toEqual({ walletAddress: PAYER, receiver: INCOMING, method: 'ilp', receiveAmount: { value: '1116670000', assetCode: 'XRP', assetScale: 9 } });
    expect(quote.headers.authorization).toBe(`GNAP ${TOKEN}`);
    expect(w.of('POST', 'https://payer.example/outgoing-payments')[0].body).toEqual({ walletAddress: PAYER, quoteId: 'https://payer.example/quotes/q1' });
  });

  it('pays a second order, from another ledger of the process, under the same grant', async () => {
    const w = wallets();
    await new InterledgerLedger(settings, noWait).pay(order);
    await new InterledgerLedger(settings, noWait).pay(order);

    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/outgoing-payments')).toHaveLength(2);
  });

  it('gets a new token for the same grant when the old one is about to lapse', async () => {
    const w = wallets({ expiresIn: 10 });
    await new InterledgerLedger(settings, noWait).pay(order);

    expect(w.of('POST', 'https://payer.example/gnap/token/t1')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/quotes')[0].headers.authorization).toBe(`GNAP ${TOKEN}-2`);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);
  });

  it('asks the owner again when the wallet refuses to renew the token', async () => {
    const w = wallets({ expiresIn: 10, refuseRotation: true });
    await expect(new InterledgerLedger(settings, noWait).pay(order)).resolves.toMatchObject({ validated: true });
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
  });

  it('asks the owner again once a token that cannot be renewed has run out', async () => {
    const w = wallets({ expiresIn: 0, noManage: true });
    const ledger = new InterledgerLedger(settings, noWait);
    await ledger.authorize(SEED, () => {});

    // The grant is over: asking how things stand asks the owner anew, and says that it waits.
    expect((await ledger.authorization(SEED)).approved).toBe(false);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
  });

  it('keeps a request that waits across ledgers that were closed meanwhile, as an MCP tool call leaves them', async () => {
    const w = wallets({ pollsUntilApproved: 3 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = new InterledgerLedger(settings, () => held);
    await expect(approvedOrRefuse(first, SEED)).rejects.toThrow(/has not approved the agent yet/);
    await first.close();

    release();
    const second = new GuardedLedger(new InterledgerLedger(settings, noWait), new SpendGuard(undefined));
    await second.authorize!(SEED, () => {});
    await approvedOrRefuse(second, SEED);
    await second.pay(order);
    await second.close();

    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/outgoing-payments')).toHaveLength(1);
  });

  it('is the same ledger behind the spend guard: no accounts to make, an account per quote, an owner to ask', () => {
    const guarded = new GuardedLedger(new InterledgerLedger(settings, noWait), new SpendGuard(undefined));
    expect(guarded.makesAccounts).toBe(false);
    expect(guarded.accountPerQuote).toBe(true);
    expect(typeof guarded.authorize).toBe('function');
    expect(typeof guarded.authorization).toBe('function');
    expect(guarded.chain).toBe('INTERLEDGER');
  });

  it('refuses another asset before anybody is asked for anything', async () => {
    const w = wallets({ incomingAsset: 'EUR' });

    await expect(new InterledgerLedger(settings, noWait).pay(order)).rejects.toThrow('the incoming payment takes EUR, not XRP');
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(0);
  });

  it('reports a payment the wallet gave up as failed, not as paid', async () => {
    wallets({ failPayment: true });

    const result = await new InterledgerLedger(settings, noWait).pay(order);

    expect(result).toMatchObject({ result: 'failed', validated: false, delivered: null });
  });

  it('says so when the owner refuses, in the wallet\'s words without its control characters, and asks again next time', async () => {
    const w = wallets({ deny: true });
    const ledger = new InterledgerLedger(settings, noWait);

    await expect(ledger.authorize(SEED, () => {})).rejects.toThrow('the grant was not given: POST https://payer.example/gnap/continue/g1 answered 403 (user_denied: the owner refused  the request)');
    await expect(ledger.authorize(SEED, () => {})).rejects.toThrow(/not given/);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
    // The wallet said the request is over: there is nothing to withdraw.
    expect(w.of('DELETE', 'https://payer.example/gnap/continue/g1')).toHaveLength(0);
  });

  it('withdraws a request when the wallet only says it is in trouble: the request may still wait there', async () => {
    const w = wallets({ continueStatus: 503 });

    await expect(new InterledgerLedger(settings, noWait).authorize(SEED, () => {})).rejects.toThrow(/the grant was not given: .*answered 503/);
    expect(w.of('DELETE', 'https://payer.example/gnap/continue/g1')).toHaveLength(1);
  });

  it('tells a request the wallet refused at once to the caller who asked, and not again to the next', async () => {
    const w = wallets({ refuseRequest: true });
    const ledger = new InterledgerLedger(settings, noWait);

    await expect(ledger.authorization(SEED)).rejects.toThrow(/answered 403 \(invalid_client/);
    // The next question is a new request, not the old refusal a second time.
    await expect(ledger.authorization(SEED)).rejects.toThrow(/answered 403/);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
  });

  it('asks for a grant of its own where the limit or the key differs, and shares one where nothing does', async () => {
    const w = wallets();
    await new InterledgerLedger(settings, noWait).authorize(SEED, () => {});
    await new InterledgerLedger({ ...settings }, noWait).authorize(SEED, () => {});
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);

    await new InterledgerLedger({ ...settings, grantLimit: '1' }, noWait).authorize(SEED, () => {});
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
    expect((w.of('POST', 'https://payer.example/gnap')[1].body as { access_token: { access: Array<{ limits?: { debitAmount: { value: string } } }> } }).access_token.access[1].limits?.debitAmount.value).toBe('1000000000');

    await new InterledgerLedger({ ...settings, keyId: 'key-2' }, noWait).authorize(SEED, () => {});
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(3);
  });

  it('forgets a grant whose token the wallet no longer knows, and sends nothing a second time', async () => {
    const w = wallets();
    const ledger = new InterledgerLedger(settings, noWait);
    await ledger.authorize(SEED, () => {});
    w.options.tokenRevoked = true;

    await expect(ledger.pay(order)).rejects.toThrow('POST https://payer.example/quotes answered 401 (invalid_token: the token is not known)');
    expect(w.of('POST', 'https://payer.example/quotes')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/outgoing-payments')).toHaveLength(0);

    // The next question asks the owner again instead of calling the dead token an approval.
    await ledger.authorization(SEED).catch(() => undefined);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
  });

  it('rotates a token once when two payments need it at the same time', async () => {
    const w = wallets({ expiresIn: 10 });
    await new InterledgerLedger(settings, noWait).authorize(SEED, () => {});

    const both = await Promise.all([new InterledgerLedger(settings, noWait).pay(order), new InterledgerLedger(settings, noWait).pay(order)]);

    expect(both.map((r) => r.validated)).toEqual([true, true]);
    expect(w.of('POST', 'https://payer.example/gnap/token/t1')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);
    expect(w.of('POST', 'https://payer.example/quotes').map((q) => q.headers.authorization)).toEqual([`GNAP ${TOKEN}-2`, `GNAP ${TOKEN}-2`]);
  });

  it('answers a caller that does not wait with the new place to approve when the token cannot be renewed', async () => {
    const w = wallets({ expiresIn: 10, refuseRotation: true });
    await new InterledgerLedger(settings, noWait).authorize(SEED, () => {});
    const waiting = new InterledgerLedger(settings, () => new Promise<void>(() => {}));

    // Not "approved" for a grant that is gone, and no payment left waiting for the owner.
    await expect(approvedOrRefuse(waiting, SEED)).rejects.toThrow(/has not approved the agent yet .*They approve at https:\/\/127\.0\.0\.1:9443\/consent\/g1\?key=k1/);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
    expect(w.of('POST', 'https://payer.example/quotes')).toHaveLength(0);
  });

  describe('once the wallet took the payment', () => {
    const untilTheDeadline = () => {
      const clock = vi.spyOn(Date, 'now');
      let now = 1_800_000_000_000;
      clock.mockImplementation(() => now);
      return { clock, sleep: async (ms: number): Promise<void> => { now += ms; } };
    };

    it('does not take money somebody else paid in for its own', async () => {
      const w = wallets({ paidByAnother: true });
      const { clock, sleep } = untilTheDeadline();
      try {
        const result = await new InterledgerLedger(settings, sleep).pay(order);
        // The incoming payment is full, and this payment sent nothing.
        expect(result).toMatchObject({ result: 'not arrived in time', validated: false });
      } finally {
        clock.mockRestore();
      }
      expect(w.of('POST', 'https://payer.example/outgoing-payments')).toHaveLength(1);
    });

    it('asks again when a read fails, and still reports the payment', async () => {
      const w = wallets({ unreadable: 2 });

      await expect(new InterledgerLedger(settings, noWait).pay(order)).resolves.toMatchObject({ result: 'completed', validated: true, delivered: '1.116670000' });
      expect(w.of('GET', 'https://payer.example/outgoing-payments/p1')).toHaveLength(3);
    });

    it('says "accepted, not confirmed" with the payment\'s name when it can never be read back, instead of failing', async () => {
      const w = wallets({ unreadable: Infinity });
      const { clock, sleep } = untilTheDeadline();
      try {
        const result = await new InterledgerLedger(settings, sleep).pay(order);
        expect(result.validated).toBe(false);
        expect(result.result).toBe('accepted by the paying wallet as https://payer.example/outgoing-payments/p1, not confirmed: GET https://payer.example/outgoing-payments/p1 answered 503 (unavailable: try later)');
      } finally {
        clock.mockRestore();
      }
      expect(w.of('POST', 'https://payer.example/outgoing-payments')).toHaveLength(1);
    });
  });

  it('withdraws a request the owner never decided', async () => {
    const w = wallets({ neverDecides: true });
    const clock = vi.spyOn(Date, 'now');
    let now = 1_800_000_000_000;
    clock.mockImplementation(() => now);
    const ledger = new InterledgerLedger(settings, async (ms) => { now += ms * 60; });

    try {
      await expect(ledger.authorize(SEED, () => {})).rejects.toThrow('the owner did not decide the grant in time');
    } finally {
      clock.mockRestore();
    }
    expect(w.of('DELETE', 'https://payer.example/gnap/continue/g1')).toHaveLength(1);
  });

  it('never lets the token into an error', async () => {
    wallets();
    const ledger = new InterledgerLedger(settings, noWait);
    await ledger.authorize(SEED, () => {});
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => (String(input) === INCOMING
      ? new Response(JSON.stringify({ receivedAmount: { value: '0', assetCode: 'XRP', assetScale: 9 } }), { status: 200 })
      : new Response(JSON.stringify({ error: { code: 'invalid_token', description: `token ${TOKEN} is not known` } }), { status: 401 }))));

    const error = await ledger.pay(order).catch((e: unknown) => e as Error);

    // Even a wallet that repeats the token in its refusal does not get it into the message.
    expect((error as Error).message).toBe('POST https://payer.example/quotes answered 401 (invalid_token: token [token] is not known)');
  });

  it('says without waiting where the owner decides, and that they have', async () => {
    wallets({ pollsUntilApproved: 3 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const ledger = new InterledgerLedger(settings, () => held);

    expect(await ledger.authorization(SEED)).toEqual({ approved: false, approveAt: ['https://127.0.0.1:9443/consent/g1?key=k1'], asks: 'up to 5 XRP from https://payer.example/pay/xrp' });
    // Asking again does not ask the wallet again.
    expect((await ledger.authorization(SEED)).approved).toBe(false);

    release();
    await ledger.authorize(SEED, () => {});
    expect(await ledger.authorization(SEED)).toEqual({ approved: true, approveAt: [], asks: 'up to 5 XRP from https://payer.example/pay/xrp' });
  });

  it('tells a caller that does not wait when the request ended badly, once, before asking the owner again', async () => {
    const w = wallets({ deny: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const ledger = new InterledgerLedger(settings, () => held);

    expect((await ledger.authorization(SEED)).approved).toBe(false);
    release();
    await vi.waitFor(async () => {
      await expect(ledger.authorization(SEED)).rejects.toThrow(/the grant was not given: .*user_denied/);
    });
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(1);

    // Told once; the question after that is a new request.
    await ledger.authorization(SEED).catch(() => undefined);
    expect(w.of('POST', 'https://payer.example/gnap')).toHaveLength(2);
  });

  it('a session refuses to pay while the owner has not approved, and names the place', async () => {
    wallets({ neverDecides: true });
    const ledger = new InterledgerLedger(settings, () => new Promise<void>(() => {}));

    await expect(approvedOrRefuse(ledger, SEED)).rejects.toThrow("the paying wallet's owner has not approved the agent yet (up to 5 XRP from https://payer.example/pay/xrp). They approve at https://127.0.0.1:9443/consent/g1?key=k1. Then pay again.");
  });

  it('has nothing to make, fund or read a balance of', async () => {
    const ledger = new InterledgerLedger(settings, noWait);
    await expect(ledger.createFresh()).rejects.toThrow(/no throwaway accounts/);
    await expect(ledger.fund()).rejects.toThrow(/no faucet/);
    await expect(ledger.balances(PAYER)).rejects.toThrow(/shows no balance/);
    expect(ledger.assets()).toEqual([{ code: 'XRP', native: true }]);
    expect(ledger.addressOf()).toBe(PAYER);
    expect(ledger.explorerUrl(INCOMING)).toBe(INCOMING);
  });

  it('shows what an incoming payment received as its one record', async () => {
    wallets();
    const ledger = new InterledgerLedger(settings, noWait);
    expect(await ledger.incoming(INCOMING)).toEqual([]);
    await ledger.pay(order);
    expect(await ledger.incoming(INCOMING)).toEqual([{ hash: '3f2c0d8e-1111-4222-8333-444455556666', asset: 'XRP', amount: '1.116670000', from: '', result: 'received', validated: true, explorer: INCOMING }]);
    expect(await ledger.incoming('https://merchant.example/pay/xrp')).toEqual([]);
  });
});

describe('the client asks at the URLs the wallet names', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a grant request to the authorization server as given, and keeps the owner\'s link while it waits', async () => {
    const w = wallets({ neverDecides: true });
    const client = new OpenPaymentsClient(CLIENT, 'key-1', privateKeyOf(SEED));

    const first = await client.requestGrant('https://payer.example/gnap', [{ type: 'quote', actions: ['create'] }], false);
    expect(w.requests[0].url).toBe('https://payer.example/gnap');
    expect(w.requests[0].body).toEqual({ access_token: { access: [{ type: 'quote', actions: ['create'] }] }, client: CLIENT });
    if (first.kind !== 'pending') throw new Error('expected a pending grant');

    const again = await client.continueGrant(first.grant);
    expect(again).toMatchObject({ kind: 'pending', grant: { redirect: 'https://payer.example/gnap/interact/g1/k1' } });
    expect(w.of('POST', 'https://payer.example/gnap/continue/g1')[0].headers.authorization).toBe('GNAP continue-token');
  });

  it('signs the URL in the form it is sent in, whatever form the wallet named it in', async () => {
    const w = wallets({ neverDecides: true });
    const client = new OpenPaymentsClient(CLIENT, 'key-1', privateKeyOf(SEED));

    await client.requestGrant('https://PAYER.example:443/gnap#top', [{ type: 'quote', actions: ['create'] }], false);

    const [sent] = w.requests;
    expect(sent.url).toBe('https://payer.example/gnap');
    const base = signatureBase({ method: 'POST', url: 'https://payer.example/gnap', body: JSON.stringify(sent.body) }, sent.headers['signature-input'].replace(/^sig1=/, ''));
    const signature = /^sig1=:(.+):$/.exec(sent.headers.signature)![1];
    expect(verify(null, Buffer.from(base), pair.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });

  it('knows the form fetch sends: a path of at least "/", no default port, no fragment', () => {
    expect(targetUri('https://auth.example')).toBe('https://auth.example/');
    expect(targetUri('https://Auth.Example:443/gnap/../grants?x=1#f')).toBe('https://auth.example/grants?x=1');
    expect(targetUri('https://node.example:8443/pay/xrp')).toBe('https://node.example:8443/pay/xrp');
  });
});

describe('what the harness takes for an incoming payment and an amount', () => {
  it('reads the record of an incoming payment whose wallet names a port', () => {
    expect(isPlainHttpsUrl(INCOMING)).toBe(true);
    expect(isPlainHttpsUrl('https://wallet.example:8443/incoming-payments/p1')).toBe(true);
    // Nothing that would end the quoted SQL string, or mean something to the shell around it.
    for (const url of ["https://wallet.example/p1' OR '1'='1", 'https://wallet.example/$(id)', 'https://wallet.example/`id`', 'https://wallet.example/p1"', 'https://wallet.example:port/p1', 'https://wallet.example/p1?x=1', 'http://wallet.example/p1', 'https://wallet.example']) {
      expect(isPlainHttpsUrl(url), url).toBe(false);
    }
  });

  it('takes a number or a decimal for an amount, and nothing that only has the shape of one', () => {
    for (const amount of [0.83211, '1.116670000', { value: '1.116670000', currency: 'XRP' }, { value: 2 }]) expect(isAmount(amount), JSON.stringify(amount)).toBe(true);
    for (const amount of [null, undefined, { value: null }, { value: { nested: 1 } }, { value: 'abc' }, { currency: 'XRP' }, Number.NaN, 'abc', true]) expect(isAmount(amount), JSON.stringify(amount)).toBe(false);
    expect(amountValue({ value: null })).toBeNull();
    expect(amountValue({ value: { nested: 1 } })).toBeNull();
    expect(amountValue({ value: '1.5' })).toBe('1.5');
    expect(amountValue(0.83211)).toBe('0.83211');
  });

  it('lets an MCP client order in every asset an Interledger wallet may hold, and in the ledgers\' as before', () => {
    for (const asset of [...INTERLEDGER_ASSETS, 'XRP', 'RLUSD', 'USDC', 'XAH', 'XLM', 'EURC']) expect(ORDER_ASSETS, asset).toContain(asset);
    expect(new Set(ORDER_ASSETS).size).toBe(ORDER_ASSETS.length);
  });
});

describe('a run on a chain without throwaway accounts', () => {
  isolateEnv(['LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY', 'LD_E2E_SHOPWARE_INTERLEDGER_SHOP_ACCOUNT', 'LEDGERDIRECT_TESTNET_SHOPWARE_INTERLEDGER_SHOP_ADDRESS']);

  const fakes = () => {
    const touched: string[] = [];
    const ledger = {
      chain: 'INTERLEDGER',
      nativeAsset: 'XRP',
      makesAccounts: false,
      assets: () => [{ code: 'XRP', native: true }],
      createFresh: async () => { touched.push('createFresh'); throw new Error('must not be called'); },
      authorize: async () => { touched.push('authorize'); },
      close: async () => {},
    } as unknown as Ledger;
    const driver = { name: 'shopware', configure: async (c: { destinationAccount: string }) => { touched.push(`configure ${c.destinationAccount}`); } } as unknown as Driver;
    return { touched, ledger, driver };
  };

  it('uses the shop\'s own wallet address and asks for the grant before a case that pays', async () => {
    process.env.LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY = SEED;
    process.env.LD_E2E_SHOPWARE_INTERLEDGER_SHOP_ACCOUNT = 'https://merchant.example/pay/xrp';
    const { touched, ledger, driver } = fakes();

    const report = await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-05'], timeoutMs: 1000, version: 'test', log: () => {} });

    expect(touched.slice(0, 2)).toEqual(['authorize', 'configure https://merchant.example/pay/xrp']);
    expect(report.receivingAccount).toBe('https://merchant.example/pay/xrp');
    expect(report.chain).toBe('INTERLEDGER');
  });

  it('asks nobody when no selected case pays', async () => {
    process.env.LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY = SEED;
    const { touched, ledger, driver } = fakes();

    await runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-01'], receivingAccount: 'https://merchant.example/pay/xrp', timeoutMs: 1000, version: 'test', log: () => {} });

    expect(touched[0]).toBe('configure https://merchant.example/pay/xrp');
    expect(touched).not.toContain('authorize');
  });

  it('refuses to start without a wallet address, or with an account of another chain', async () => {
    process.env.LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY = SEED;
    const { touched, ledger, driver } = fakes();

    await expect(runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-01'], timeoutMs: 1000, version: 'test', log: () => {} })).rejects.toThrow(/INTERLEDGER has no throwaway accounts: name the shop's own with --receiving-account or LD_E2E_SHOPWARE_INTERLEDGER_SHOP_ACCOUNT/);
    await expect(runCases({ driver, ledger, baseUrl: 'http://shop.test', caseIds: ['PS-01'], receivingAccount: 'rMW6jyfsGyB5kPoYWVV4z1h9DA5KmEGPYq', timeoutMs: 1000, version: 'test', log: () => {} })).rejects.toThrow(/is not a INTERLEDGER account/);
    expect(touched).toEqual([]);
  });
});
