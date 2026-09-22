import { Client, OfferCreate, OfferCreateFlags, Wallet, xrpToDrops, dropsToXrp } from 'xrpl';
import { Asset, TESTNET_ISSUED } from '../assets.js';

export interface Offer {
  gives: string;
  wants: string;
}

/** The best offers selling `asset` for XRP, as the DEX has them right now. */
export async function bookOffers(client: Client, asset: Exclude<Asset, 'XRP'>, limit = 5): Promise<Offer[]> {
  const issued = TESTNET_ISSUED[asset];
  const book = await client.request({
    command: 'book_offers',
    taker_gets: { currency: issued.currency, issuer: issued.issuer },
    taker_pays: { currency: 'XRP' },
    limit,
  });
  return (book.result.offers ?? []).map((offer) => ({
    gives: typeof offer.TakerGets === 'object' ? `${offer.TakerGets.value} ${asset}` : `${dropsToXrp(offer.TakerGets)} XRP`,
    wants: typeof offer.TakerPays === 'object' ? `${offer.TakerPays.value} ${asset}` : `${dropsToXrp(offer.TakerPays)} XRP`,
  }));
}

/**
 * Buys `value` of `asset` with up to `maxXrp` XRP as an immediate-or-cancel
 * offer: whatever the book can fill now is filled, nothing rests on the
 * ledger. This is how the harness keeps a treasury stocked without a faucet
 * web page and its captcha.
 */
export async function buy(client: Client, wallet: Wallet, asset: Exclude<Asset, 'XRP'>, value: string, maxXrp: string): Promise<{ hash: string; result: string }> {
  const issued = TESTNET_ISSUED[asset];
  const tx: OfferCreate = {
    TransactionType: 'OfferCreate',
    Account: wallet.classicAddress,
    TakerGets: xrpToDrops(maxXrp),
    TakerPays: { currency: issued.currency, issuer: issued.issuer, value },
    Flags: OfferCreateFlags.tfImmediateOrCancel,
  };
  const prepared = await client.autofill(tx);
  const response = await client.submitAndWait(wallet.sign(prepared).tx_blob);
  const meta = response.result.meta;
  return {
    hash: response.result.hash,
    result: typeof meta === 'object' && meta !== null && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown',
  };
}
