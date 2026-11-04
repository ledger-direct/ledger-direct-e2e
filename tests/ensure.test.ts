import { describe, expect, it } from 'vitest';
import { ensureTreasury, type EnsureDeps, type Stablecoin, type TreasuryState } from '../src/chains/xrpl/ensure.js';

const minimums = { xrp: 50, tokens: { RLUSD: 10, USDC: 10 } as Partial<Record<Stablecoin, number>> };

/** A treasury whose balances the faucet and the DEX change, as configured per test. */
function treasury(start: TreasuryState, effects: { faucet?: number; fills?: Partial<Record<Stablecoin, number>>; xrpPerBuy?: number } = {}) {
  let state: TreasuryState = { xrp: start.xrp, tokens: { ...start.tokens } };
  const calls = { fund: 0, buy: [] as string[] };
  const deps: EnsureDeps = {
    read: async () => ({ xrp: state.xrp, tokens: { ...state.tokens } }),
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
    expect(calls).toEqual({ fund: 0, buy: [] });
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

  it('fails naming every shortfall when the faucet gives nothing', async () => {
    const { deps, calls } = treasury({ xrp: 1.7, tokens: { RLUSD: 20, USDC: 20 } }, { faucet: 0 });
    await expect(ensureTreasury(minimums, deps)).rejects.toThrow('XRP 1.7 < 50');
    expect(calls.fund).toBe(3);
  });

  it('fails when the DEX book cannot fill the purchase', async () => {
    const { deps } = treasury({ xrp: 100, tokens: { RLUSD: 20, USDC: 2 } }, { fills: { USDC: 1 } });
    await expect(ensureTreasury(minimums, deps)).rejects.toThrow('USDC 3 < 10');
  });
});
