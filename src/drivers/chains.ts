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
