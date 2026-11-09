import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IncomingPayment, Ledger, PaymentRequest, PaymentResult } from '../src/chains/chain.js';
import type { Driver, PaymentPageView, PlacedOrder, StatusPayload } from '../src/drivers/driver.js';
import { createServer } from '../src/mcp.js';
import { ShopSession } from '../src/session.js';
import { observe } from '../src/watch/observe.js';

// A shop and a ledger in memory: what the session asks of them, and what it does with the answers.
const signed: PaymentRequest[] = [];
let shortfall: string | null = null;

function fakeDriver(name: Driver['name'], nextId: () => string): Driver & { orderState(o: PlacedOrder): Promise<Record<string, unknown>> } {
  const page = (o: PlacedOrder): PaymentPageView => ({ state: 'waiting', amountDisplayed: '0.85635', asset: 'XRP', destinationAccount: 'rShop', paymentIdentifier: o.id === '1' ? '7' : '8', statusUrl: 's', network: 'testnet' });
  const status = (): StatusPayload => ({ schema_version: 1, state: 'waiting', base_asset: 'XRP', amount_requested: 0.85635, amount_paid: null, shortfall: shortfall === null ? null : Number(shortfall), seconds_left: 300 });
  return {
    name,
    async configure() {},
    async findProducts() { return [{ id: 'p1', number: 'LD-E2E-001', name: 'Mug', price: '1.00', currency: 'EUR' }]; },
    async placeOrder() { const id = nextId(); return { id, reference: `R${id}`, secret: 'secret' }; },
    async paymentPage(o) { return page(o); },
    async status() { return status(); },
    async statusResponse() { return { status: 200, body: '{}' }; },
    unknownOrderId: () => '999',
    async pageResponse() { return { status: 200 }; },
    async refresh() {},
    async close() {},
    async safetyNet() { return null; },
    async recordedHashes() { return ['H1']; },
    async nodeRequests() { return null; },
    async orderState(o) { return { state: { name: 'open', is_paid: false }, payments: [], intent: { hash: null }, id_order: o.id }; },
  };
}

const fakeLedger = (): Ledger => ({
  chain: 'XRPL', nativeAsset: 'XRP',
  assets: () => [{ code: 'XRP', native: true }],
  async createFresh() { return { address: 'rFresh', seed: 'x', trustlines: {} }; },
  async fund(address) { return { address, amount: '0' }; },
  async balances(address) { return { address, native: '0', tokens: {}, trustlines: [] }; },
  async pay(request): Promise<PaymentResult> { signed.push(request); return { hash: `H${signed.length}`, result: 'tesSUCCESS', validated: true, delivered: request.amount, explorer: 'e', from: 'rTreasury' }; },
  async incoming(): Promise<IncomingPayment[]> { return [{ hash: 'H1', asset: 'XRP', amount: '0.85635', identifier: '7', from: 'rTreasury', result: 'tesSUCCESS', validated: true, explorer: 'e/H1' }]; },
  explorerUrl: (h) => h,
  addressOf: () => 'rTreasury',
  async close() {},
});

function session(): ShopSession {
  let n = 0;
  const shared = () => String(++n);
  return new ShopSession({ driver: (t) => ({ driver: fakeDriver(t as Driver['name'], t === 'magento' ? () => '1' : shared), baseUrl: 'http://shop' }), ledger: fakeLedger, payerSeed: () => 'sTreasury' });
}

beforeEach(() => {
  signed.length = 0;
  shortfall = null;
});

describe('ShopSession', () => {
  it('pays what the page shows, half of it, or what is still due', async () => {
    const s = session();
    const { entry } = await s.placeOrder('shopware', 'XRP');
    await s.payOrder(entry.key);
    await s.payOrder(entry.key, { amount: 'half' });
    shortfall = '0.42817';
    await s.payOrder(entry.key, { amount: 'shortfall', asset: 'RLUSD' });
    expect(signed.map((r) => [r.amount, r.asset, r.to, r.identifier, r.seed])).toEqual([
      ['0.85635', 'XRP', 'rShop', '7', 'sTreasury'],
      ['0.42817', 'XRP', 'rShop', '7', 'sTreasury'],
      ['0.42817', 'RLUSD', 'rShop', '7', 'sTreasury'],
    ]);
  });

  it('refuses to pay a shortfall that is not there', async () => {
    const s = session();
    const { entry } = await s.placeOrder('shopware', 'XRP');
    await expect(s.payOrder(entry.key, { amount: 'shortfall' })).rejects.toThrow(/no shortfall/);
  });

  it('keeps two shops apart when they hand out the same order id', async () => {
    const s = session();
    const a = await s.placeOrder('shopware', 'XRP');
    const b = await s.placeOrder('magento', 'XRP');
    expect([a.entry.key, b.entry.key]).toEqual(['1', 'magento:1']);
    expect(s.list().map((e) => e.target)).toEqual(['shopware', 'magento']);
    expect(() => s.get('nope')).toThrow(/not placed in this session/);
  });

  it('observes the three sides of an order', async () => {
    const s = session();
    const { entry, page } = await s.placeOrder('shopware', 'XRP');
    const o = await observe(s, entry.key, page);
    expect(o.customer).toMatchObject({ pageStatus: 200, page: { amountDisplayed: '0.85635' }, status: { state: 'waiting' } });
    expect(o.shop).toMatchObject({ platform: { paid: false, name: 'open' }, recorded: ['H1'] });
    expect(o.ledger.incoming?.[0].hash).toBe('H1');
    expect(o.customer.error ?? o.shop.error ?? o.ledger.error).toBeUndefined();
  });
});

describe('MCP shop tools over the session', () => {
  it('place and pay go through the same kernel', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ session: session() }).connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const placed = await client.callTool({ name: 'shop_place_order', arguments: { target: 'prestashop', asset: 'XRP' } });
    const body = JSON.parse((placed.content as Array<{ text: string }>)[0].text);
    expect(body).toMatchObject({ orderId: '1', reference: 'R1', paymentPage: { amountDisplayed: '0.85635' } });
    const paid = await client.callTool({ name: 'shop_pay_order', arguments: { orderId: '1' } });
    expect(JSON.parse((paid.content as Array<{ text: string }>)[0].text)).toMatchObject({ paid: '0.85635 XRP', to: 'rShop', identifier: '7', hash: 'H1' });
    const evidence = await client.callTool({ name: 'shop_order_evidence', arguments: { orderId: '1' } });
    expect(JSON.parse((evidence.content as Array<{ text: string }>)[0].text)).toMatchObject({ state: { name: 'open' } });
    const unknown = await client.callTool({ name: 'shop_order_status', arguments: { orderId: '42' } });
    expect(unknown.isError).toBe(true);
  });

  async function connected(s: ShopSession): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ session: s }).connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    return client;
  }

  it('offers Xahau on every tool that takes a chain, and XAH where an asset is chosen', async () => {
    const { tools } = await (await connected(session())).listTools();
    const property = (tool: string, name: string) => (tools.find((t) => t.name === tool)?.inputSchema.properties?.[name] ?? {}) as { enum?: string[] };
    for (const tool of ['shop_pay_order', 'wallet_status', 'wallet_fresh', 'wallet_fund', 'pay', 'run_cases']) {
      expect(property(tool, 'chain').enum, tool).toContain('XAHAU');
    }
    for (const tool of ['shop_place_order', 'shop_pay_order']) expect(property(tool, 'asset').enum, tool).toContain('XAH');
  });

  it('pays an XAH order on Xahau when the client names no chain', async () => {
    const ledgers: string[] = [];
    const xah = (o: PlacedOrder): PlacedOrder => ({ ...o, chain: 'XAHAU' });
    const base = fakeDriver('prestashop', () => '1');
    const driver: Driver = {
      ...base,
      async placeOrder(asset, options) { return xah(await base.placeOrder(asset, options)); },
      async paymentPage(o) { return { ...(await base.paymentPage(o)), asset: 'XAH' }; },
    };
    const s = new ShopSession({ driver: () => ({ driver, baseUrl: 'http://shop' }), ledger: (chain) => { ledgers.push(chain); return fakeLedger(); }, payerSeed: () => 'sTreasury' });
    const client = await connected(s);

    const placed = await client.callTool({ name: 'shop_place_order', arguments: { target: 'prestashop', asset: 'XAH' } });
    expect(placed.isError).toBeFalsy();
    const paid = await client.callTool({ name: 'shop_pay_order', arguments: { orderId: '1' } });
    expect(paid.isError).toBeFalsy();
    expect(ledgers).toEqual(['XAHAU']);
    expect(signed[0]).toMatchObject({ asset: 'XAH', to: 'rShop' });
  });
});
