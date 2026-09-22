import { Client } from 'xrpl';
import { TESTNET_WS } from '../assets.js';

/** Runs `fn` with a connected client and always disconnects afterwards. */
export async function withClient<T>(fn: (client: Client) => Promise<T>, url: string = TESTNET_WS): Promise<T> {
  const client = new Client(url);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}
