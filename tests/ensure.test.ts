import { describe, expect, it } from 'vitest';
import { ensureTreasury, isAccountNotFound, type EnsureDeps, type Stablecoin, type TreasuryState } from '../src/chains/xrpl/ensure.js';

const minimums = { xrp: 50, tokens: { RLUSD: 10, USDC: 10 } as Partial<Record<Stablecoin, number>> };

/** A treasury whose balances the faucet and the DEX change, as configured per test. */
function treasury(start: TreasuryState, effects: { faucet?: number; fills?: Partial<Record<Stablecoin, number>>; xrpPerBuy?: number; xrpPerLine?: number; limits?: Partial<Record<Stablecoin, string>> } = {}) {
  let state: TreasuryState = { xrp: start.xrp, tokens: { ...start.tokens } };
  const limits: Partial<Record<Stablecoin, string>> = { ...(effects.limits ?? { RLUSD: '1000000', USDC: '1000000' }) };
  const calls = { fund: 0, buy: [] as string[], lines: [] as string[] };
  const deps: EnsureDeps = {
    read: async () => ({ xrp: state.xrp, tokens: { ...state.tokens } }),
    lineLimits: async () => ({ ...limits }),
    setLine: async (coin) => {
      calls.lines.push(coin);
      limits[coin] = '1000000';
      state = { ...state, xrp: state.xrp - (effects.xrpPerLine ?? 0) };
    },
    fund: async () => {
      calls.fund += 1;
      state = { ...state, xrp: state.xrp + (effects.faucet ?? 100) };
    },
    buy: async (coin, amount) => {
      calls.buy.push(`${amount} ${coin}`);
      const filled = effects.fills?.[coin] ?? Number(amount);
      state = { xrp: state.xrp - (effects.xrpPerBuy ?? 0), tokens: { ...state.tokens, [coin]: (state.tokens[coin] ?? 0) + filled } };
      return 'tesSUCCESS';
    },
    pause: async () => {},
    log: () => {},
  };
  return { deps, calls };
}

describe('ensureTreasury', () => {
  it('does nothing when every balance is above its minimum', async () => {
    const { deps, calls } = treasury({ xrp: 200, tokens: { RLUSD: 880, USDC: 10.5 } });
    const result = await ensureTreasury(minimums, deps);
    expect(result.actions).toEqual([]);
    expect(calls).toEqual({ fund: 0, buy: [], lines: [] });
  });

  it('asks the faucet until XRP is above the minimum', async () => {
    const { deps, calls } = treasury({ xrp: 1.7, tokens: { RLUSD: 20, USDC: 20 } }, { faucet: 30 });
    const result = await ensureTreasury(minimums, deps);
    expect(calls.fund).toBe(2);
    expect(result.after.xrp).toBeCloseTo(61.7);
  });

  it('buys the shortfall of each stablecoin, rounded up to the cent', async () => {
    const { deps, calls } = treasury({ xrp: 100, tokens: { RLUSD: 9.991, USDC: 0 } });
    await ensureTreasury(minimums, deps);
    expect(calls.buy).toEqual(['0.01 RLUSD', '10.00 USDC']);
  });

  it('tops up XRP before buying stablecoins with it', async () => {
    const order: string[] = [];
    const { deps } = treasury({ xrp: 10, tokens: { RLUSD: 0, USDC: 20 } });
    const wrapped: EnsureDeps = { ...deps, fund: async () => { order.push('faucet'); await deps.fund(); }, buy: async (c, a) => { order.push('buy'); return deps.buy(c, a); } };
    await ensureTreasury(minimums, wrapped);
    expect(order).toEqual(['faucet', 'buy']);
  });

  it('asks the faucet again when the purchases took XRP below the minimum', async () => {
    const { deps, calls } = treasury({ xrp: 55, tokens: { RLUSD: 0, USDC: 20 } }, { xrpPerBuy: 20 });
    const result = await ensureTreasury(minimums, deps);
    expect(calls.buy).toEqual(['10.00 RLUSD']);
    expect(calls.fund).toBe(1);
    expect(result.after.xrp).toBe(135);
  });

  it('stops before any repair or purchase when the faucet gives nothing', async () => {
    const { deps, calls } = treasury({ xrp: 1.7, tokens: { RLUSD: 0, USDC: 20 } }, { faucet: 0, limits: {} });
    await expect(ensureTreasury(minimums, deps)).rejects.toThrow('XRP 1.7 < 50, RLUSD 0 < 10');
    expect(calls.lines).toEqual([]);
    expect(calls.buy).toEqual([]);
  });

  it('fails naming every shortfall when the faucet gives nothing', async () => {
    const { deps, calls } = treasury({ xrp: 1.7, tokens: { RLUSD: 20, USDC: 20 } }, { faucet: 0 });
    await expect(ensureTreasury(minimums, deps)).rejects.toThrow('XRP 1.7 < 50');
    expect(calls.fund).toBe(3);
  });

  it('starts from nothing on a reset testnet: a missing account reads as empty, the faucet creates it', async () => {
    expect(isAccountNotFound(Object.assign(new Error('Account not found.'), { data: { error: 'actNotFound' } }))).toBe(true);
    expect(isAccountNotFound(Object.assign(new Error('timeout'), { data: { error: 'timeout' } }))).toBe(false);
    expect(isAccountNotFound(new Error('plain'))).toBe(false);
    expect(isAccountNotFound(null)).toBe(false);
    const { deps, calls } = treasury({ xrp: 0, tokens: {} });
    const result = await ensureTreasury(minimums, deps);
    expect(calls.fund).toBe(1);
    expect(calls.buy).toEqual(['10.00 RLUSD', '10.00 USDC']);
    expect(result.after.xrp).toBe(100);
  });

  it('repairs a missing or zero-limit trust line even when no purchase is needed', async () => {
    const { deps, calls } = treasury({ xrp: 200, tokens: { RLUSD: 880, USDC: 20 } }, { limits: { RLUSD: '0' } });
    const result = await ensureTreasury(minimums, deps);
    expect(calls.lines).toEqual(['RLUSD', 'USDC']);
    expect(calls.buy).toEqual([]);
    expect(result.actions).toEqual(['trust line RLUSD', 'trust line USDC']);
  });

  it('raises a line whose limit leaves too little room above the balance', async () => {
    const { deps, calls } = treasury({ xrp: 200, tokens: { RLUSD: 20, USDC: 20 } }, { limits: { RLUSD: '20', USDC: '1020' } });
    await ensureTreasury(minimums, deps);
    expect(calls.lines).toEqual(['RLUSD']);
  });

  it('stops when setting a line fails', async () => {
    const { deps, calls } = treasury({ xrp: 200, tokens: { RLUSD: 20, USDC: 20 } }, { limits: { RLUSD: '0' } });
    const failing: EnsureDeps = { ...deps, setLine: async () => { throw new Error('trust line not set: RLUSD tecNO_LINE_INSUF_RESERVE'); } };
    await expect(ensureTreasury(minimums, failing)).rejects.toThrow('tecNO_LINE_INSUF_RESERVE');
    expect(calls.buy).toEqual([]);
  });

  it('sets the lines before it buys', async () => {
    const order: string[] = [];
    const { deps } = treasury({ xrp: 100, tokens: {} }, { limits: {} });
    const wrapped: EnsureDeps = { ...deps, setLine: async (c) => { order.push(`line ${c}`); await deps.setLine(c); }, buy: async (c, a) => { order.push(`buy ${c}`); return deps.buy(c, a); } };
    await ensureTreasury(minimums, wrapped);
    expect(order).toEqual(['line RLUSD', 'line USDC', 'buy RLUSD', 'buy USDC']);
  });

  it('reads again after a line repair and tops up the XRP its fee took below the minimum', async () => {
    const { deps, calls } = treasury({ xrp: 50, tokens: { RLUSD: 20, USDC: 20 } }, { limits: { RLUSD: '0', USDC: '1000000' }, xrpPerLine: 0.000012 });
    const result = await ensureTreasury(minimums, deps);
    expect(calls.lines).toEqual(['RLUSD']);
    expect(calls.buy).toEqual([]);
    expect(calls.fund).toBe(1);
    expect(result.after.xrp).toBeGreaterThanOrEqual(50);
  });

  it('tops up between two repairs, before the second one needs the XRP', async () => {
    const order: string[] = [];
    const { deps } = treasury({ xrp: 50, tokens: { RLUSD: 20, USDC: 20 } }, { limits: {}, xrpPerLine: 0.000012 });
    const wrapped: EnsureDeps = { ...deps, fund: async () => { order.push('faucet'); await deps.fund(); }, setLine: async (c) => { order.push(`line ${c}`); await deps.setLine(c); } };
    await ensureTreasury(minimums, wrapped);
    expect(order).toEqual(['line RLUSD', 'faucet', 'line USDC']);
  });

  it('fails when the DEX book cannot fill the purchase', async () => {
    const { deps } = treasury({ xrp: 100, tokens: { RLUSD: 20, USDC: 2 } }, { fills: { USDC: 1 } });
    await expect(ensureTreasury(minimums, deps)).rejects.toThrow('USDC 3 < 10');
  });
});

describe('requireTrustlines', () => {
  it('passes when every TrustSet succeeded and names every one that did not', async () => {
    const { requireTrustlines } = await import('../src/chains/xrpl/wallets.js');
    expect(() => requireTrustlines({ RLUSD: 'tesSUCCESS', USDC: 'tesSUCCESS' })).not.toThrow();
    expect(() => requireTrustlines({})).not.toThrow();
    expect(() => requireTrustlines({ RLUSD: 'tesSUCCESS', USDC: 'tecNO_LINE_INSUF_RESERVE' })).toThrow('trust line not set: USDC tecNO_LINE_INSUF_RESERVE');
    expect(() => requireTrustlines({ RLUSD: 'unknown' })).toThrow('RLUSD unknown');
  });
});
