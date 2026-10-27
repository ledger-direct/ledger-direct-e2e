import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'xrpl';
import { retireClient } from '../src/chains/xrpl/ledger.js';

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
    leaveClosing(): () => void {
      const ws = sockets[sockets.length - 1];
      const raw = (ws as unknown as { _socket: import('node:net').Socket })._socket;
      ws.close(1001);
      raw.pause();
      return () => raw.destroy();
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
});
