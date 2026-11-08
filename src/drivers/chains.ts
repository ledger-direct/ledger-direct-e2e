/**
 * The chain an order for `asset` goes on. The chain configure() pointed the shop at wins when
 * it has the asset; otherwise the first chain that has it. A session may place an order without
 * configuring first (the MCP server does), and an asset like XAH names its chain on its own,
 * while USDC exists on the XRP Ledger and on Stellar, so the configured chain decides there.
 */
export function chainForAsset(configured: string, asset: string, assetsByChain: Record<string, readonly string[]>): string {
  if (assetsByChain[configured]?.includes(asset)) return configured;
  const chain = Object.keys(assetsByChain).find((c) => assetsByChain[c].includes(asset));
  if (!chain) throw new Error(`no payment method for ${asset} on any chain (${Object.keys(assetsByChain).join(', ')})`);
  return chain;
}

/**
 * The chain for one order: the chain the caller named, which must have the asset (an order for
 * XAH on the XRP Ledger is a mistake, not a hint), else chainForAsset() from the configured one.
 */
export function orderChain(requested: string | undefined, configured: string, asset: string, assetsByChain: Record<string, readonly string[]>): string {
  if (requested === undefined) return chainForAsset(configured, asset, assetsByChain);
  const chain = requested.toUpperCase();
  if (!assetsByChain[chain]?.includes(asset)) throw new Error(`no payment method for ${asset} on ${chain}`);
  return chain;
}
