import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'xrpl';
import { retireClient, XrplLedger } from '../src/chains/xrpl/ledger.js';

// XrplLedger connects to TESTNET_WS; here that is the local stand-in below.
const target = vi.hoisted(() => ({ url: '' }));
vi.mock('../src/chains/xrpl/assets.js', async (original) => {
  const actual = await original<typeof import('../src/chains/xrpl/assets.js')>();
  return { ...actual, get TESTNET_WS() { return target.url; } };
});

/**
 * A local rippled stand-in: answers server_info, counts connections, and can
 * leave a client's socket CLOSING — it sends a close frame (1001, not xrpl.js's
 * intentional 4000) and stops reading, so the client's close never completes
 * until the test lets it.
 */
async function fakeRippled() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const { id } = JSON.parse(data.toString()) as { id: number };
      ws.send(JSON.stringify({ id, type: 'response', status: 'success', result: { info: { build_version: '2.3.0', network_id: 1 } } }));
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return {
    url,
    connections: () => sockets.length,
    open: () => sockets.filter((ws) => ws.readyState === ws.OPEN).length,
    dropAll: () => sockets.forEach((ws) => ws.terminate()),
    leaveClosing(): () => void {
      const ws = sockets[sockets.length - 1];
      const raw = (ws as unknown as { _socket: import('node:net').Socket })._socket;
      ws.close(1001);
      raw.pause();
      return () => raw.destroy();
    },
    /** Stops reading the client's last socket, so a close the client starts stays CLOSING until resumed. */
    stall(): () => void {
      const ws = sockets[sockets.length - 1];
      const raw = (ws as unknown as { _socket: import('node:net').Socket })._socket;
      raw.pause();
      return () => raw.resume();
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

async function untilClosing(client: Client): Promise<void> {
  for (let i = 0; i < 100 && client.connection.state !== 2; i++) await new Promise((r) => setTimeout(r, 10));
  expect(client.connection.state).toBe(2); // WebSocket.CLOSING
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('retiring a client whose socket is CLOSING', () => {
  let server: Awaited<ReturnType<typeof fakeRippled>>;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients) await c.disconnect().catch(() => undefined);
    clients.length = 0;
    await server.close();
  });

  it('a plain disconnect() lets the discarded client reconnect — the leak', async () => {
    server = await fakeRippled();
    const client = new Client(server.url);
    clients.push(client);
    await client.connect();
    const finishClose = server.leaveClosing();
    await untilClosing(client);

    const disconnected = client.disconnect();
    finishClose();
    await disconnected;
    await wait(600);
    expect(server.connections()).toBe(2);
  });

  it('retireClient() does not wait for the close forever and keeps the client down', async () => {
    server = await fakeRippled();
    const client = new Client(server.url);
    clients.push(client);
    await client.connect();
    const finishClose = server.leaveClosing();
    await untilClosing(client);

    const started = Date.now();
    await retireClient(client, 200);
    expect(Date.now() - started).toBeLessThan(1000);

    finishClose(); // the close arrives after the bounded wait, with code 1001
    await wait(600);
    expect(server.connections()).toBe(1);
    expect(client.isConnected()).toBe(false);
  });

  it('retireClient() also stops a reconnect xrpl.js is already in the middle of', async () => {
    server = await fakeRippled();
    const client = new Client(server.url);
    clients.push(client);
    await client.connect();
    const resume = server.stall();

    // What a failed heartbeat does: reconnect() closes with 4000, waits for the close, then connects the same
    // client again. The close comes back as 4000, so no 'reconnecting' is announced on this path.
    const inFlight = client.connection.reconnect().catch(() => undefined);
    await untilClosing(client);
    await retireClient(client, 200);
    resume();
    await inFlight;
    await wait(600);
    expect(client.isConnected()).toBe(false);
    expect(server.open()).toBe(0);
  });
});

describe('XrplLedger.connect()', () => {
  let server: Awaited<ReturnType<typeof fakeRippled>>;

  afterEach(async () => {
    await server.close();
  });

  it('shares a connection that is still being opened instead of aborting it', async () => {
    server = await fakeRippled();
    target.url = server.url;
    const ledger = new XrplLedger();
    const [a, b] = await Promise.all([ledger.connect(), ledger.connect()]);
    expect(a).toBe(b);
    expect(a.isConnected()).toBe(true);
    expect(server.connections()).toBe(1);
    await ledger.close();
  });

  it('replaces a client whose connection went away', async () => {
    server = await fakeRippled();
    target.url = server.url;
    const ledger = new XrplLedger();
    const first = await ledger.connect();
    server.dropAll();
    for (let i = 0; i < 100 && first.isConnected(); i++) await wait(10);
    const second = await ledger.connect();
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
    await wait(600);
    expect(server.open()).toBe(1);
    await ledger.close();
  });
});
