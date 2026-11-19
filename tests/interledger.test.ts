import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAccountOf, isChain, treasurySeedVariable } from '../src/chains/index.js';
import { fromScale, OpenPaymentsClient, parseGrantAnswer, toScale } from '../src/chains/interledger/client.js';
import { consentLinks, incomingPaymentId, InterledgerLedger, interledgerSettings, type InterledgerSettings, resetInterledgerGrants } from '../src/chains/interledger/ledger.js';
import { contentDigest, privateKeyOf, signatureBase, signatureParams, signedHeaders } from '../src/chains/interledger/signature.js';
import type { Ledger } from '../src/chains/chain.js';
import type { Driver } from '../src/drivers/driver.js';
import { readPaymentPage } from '../src/drivers/page.js';
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
function wallets(options: { pollsUntilApproved?: number; deny?: boolean; neverDecides?: boolean; failPayment?: boolean; incomingAsset?: string } = {}) {
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  let polls = 0;
  let received = 0n;
  let paying: bigint | null = null;
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
        paying = null;
      }
      return json({ receivedAmount: { value: received.toString(), assetCode: options.incomingAsset ?? 'XRP', assetScale: 9 }, authServer: 'https://merchant.example/gnap' });
    }
    if (method === 'POST' && url === 'https://payer.example/gnap') return json({ interact: { redirect: 'https://payer.example/gnap/interact/g1/k1', finish: 'nonce' }, ...pending });
    if (method === 'POST' && url === 'https://payer.example/gnap/continue/g1') {
      polls += 1;
      if (options.deny) return json({ error: { code: 'user_denied', description: 'the owner refused\u0007 the request' } }, 403);
      if (options.neverDecides || polls < (options.pollsUntilApproved ?? 2)) return json(pending);
      return json({ access_token: { value: TOKEN, manage: 'https://payer.example/gnap/token/t1', expires_in: 3600 } });
    }
    if (method === 'DELETE' && url === 'https://payer.example/gnap/continue/g1') return json(null, 204);
    if (method === 'POST' && url === 'https://payer.example/quotes') {
      const receive = (requests.at(-1)!.body as { receiveAmount: { value: string } }).receiveAmount;
      return json({ id: 'https://payer.example/quotes/q1', walletAddress: PAYER, receiver: INCOMING, method: 'ilp', receiveAmount: { ...receive, assetCode: 'XRP', assetScale: 9 }, debitAmount: { value: (BigInt(receive.value) + 11_000_000n).toString(), assetCode: 'XRP', assetScale: 9 }, expiresAt: '2030-01-01T00:00:00Z' });
    }
    if (method === 'POST' && url === 'https://payer.example/outgoing-payments') {
      paying = 1_116_670_000n;
      return json(outgoing(false));
    }
    if (method === 'GET' && url === 'https://payer.example/outgoing-payments/p1') return json(outgoing(options.failPayment === true));
    return json({ error: { code: 'not_found', description: `no route for ${method}` } }, 404);
  });
  const outgoing = (failed: boolean) => ({ id: 'https://payer.example/outgoing-payments/p1', walletAddress: PAYER, failed, receiver: INCOMING, receiveAmount: { value: '1116670000', assetCode: 'XRP', assetScale: 9 }, debitAmount: { value: '1127670000', assetCode: 'XRP', assetScale: 9 }, sentAmount: { value: '0', assetCode: 'XRP', assetScale: 9 } });
  vi.stubGlobal('fetch', fetchStub);
  return { requests, of: (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url) };
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
