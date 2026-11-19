# Changelog

## Unreleased

- `--chain INTERLEDGER`: the harness pays as an agent over Open Payments, from a wallet whose owner
  approved a spending limit. Once per process it asks the paying wallet for a grant (quotes, and outgoing
  payments up to `LD_E2E_INTERLEDGER_GRANT_LIMIT`), prints where the owner decides and waits; afterwards
  every order is quoted and paid without them. The client is written against the specifications with
  `node:crypto` and `fetch` (RFC 9421 signatures, GNAP with the redirect interaction, continuation by
  polling). A run uses the shop's own wallet address instead of a fresh account
  (`LD_E2E_<TARGET>_INTERLEDGER_SHOP_ACCOUNT`); the agent's key is
  `LEDGERDIRECT_INTERLEDGER_TESTNET_CUSTOMER_PRIVATE_KEY`, the paying wallet `LD_E2E_INTERLEDGER_PAYING_WALLET`.
- The chain contract gained `makesAccounts`, `accountPerQuote`, `authorize()` and `authorization()`; the
  catalogue marks the cases that pay (`pays`), so the owner is asked before the first order and only then.
- The payment page reader takes a page without an identifier where the account is a URL (an incoming
  payment); its id stands in.
- MCP tool `wallet_authorize`; `shop_pay_order` and `pay` refuse with the place to approve instead of
  waiting for a person.
- Shopware driver: Interledger payment methods, and what arrived on an incoming payment read from the
  order's stored intent.
- `ld-e2e record` asks for the grant before anything is ordered or filmed, and hides a dev shop's debug
  toolbar (Symfony's) in every page it films.
- `ld-e2e record --as customer`: an account made for the recording is logged in off camera (the plugin's
  walk exports `logIn`), so the film shows the cart and the checkout without the address form.
  `--product <number>` names the article the walk buys, for a shop without the try catalogue. The walk
  is told the chain, so it can pick an Interledger payment method.
- A request to the paying wallet's owner that lapsed or was refused is reported once to a caller that
  does not wait, before the owner is asked again.
- PS-12 on a chain with an account per quote compares the account alone: the page shows no identifier
  beside it, and the status carries its amounts as objects there.
- An Interledger payment counts as arrived when the incoming payment holds the amount *and* the
  harness's own outgoing payment has sent something: money somebody else paid in is not taken for it.
  A read that fails after the wallet took the payment is repeated; a payment that can never be read
  back is reported as "accepted by the paying wallet as …, not confirmed", not as an error to retry.
- In the receiver's own asset an Interledger payment has to have sent at least the amount before the
  incoming payment's total counts as its own; in another asset, anything at all. A payment the wallet
  took and that was not seen to arrive carries `unconfirmed: true` and the outgoing payment's id in
  its result, also when it merely did not arrive in time, and the runner, `record` and the MCP tools
  say "not confirmed" for it instead of "failed".
- A 401 for a token another payment has renewed, or is renewing, no longer forgets the renewed
  grant, and each request of a payment goes out with the grant's token of that moment.
  `authorization()` rotates a minute earlier than a payment would, so the payment after an
  "approved" need not; a token that cannot be rotated is approved for as long as it lasts.
- A grant is kept by what was asked (paying wallet, client, key, limit). One whose token the wallet no
  longer knows (401) is forgotten; a token is rotated once however many payments need it; and a caller
  that does not wait gets the new place to approve when the wallet will not renew it.
- Requests are signed for the URL in the form fetch sends it (host in lower case, no default port, a
  path of at least `/`), whatever form the wallet named it in.
- A waiting request is withdrawn when the wallet answers with a server error, not only when the
  harness gives up; a request refused at once is told to the caller who asked, and not again.
- MCP: `shop_place_order` takes `EUR`, `USD` and `DSUSD`, the assets an Interledger wallet may hold.
- Shopware driver: the record of an incoming payment is read where its URL names a port.
- PS-12 takes only a number or a decimal for `amount_requested`; `{ "value": null }` no longer passes.
- `ld-e2e record`: a grant the owner refuses or lets lapse ends the recording like any other failure,
  in the log and in `recording.json`.
- `ld-e2e record --color-scheme light|dark` (MCP: `colorScheme`), `light` by default: what the pages see as
  `prefers-color-scheme`. Headless Chrome took the system's before, so a Mac in dark mode filmed a dark payment
  page. The default folder name includes the scheme; `recording.json` records it always.

## 0.2.0

- `ld-e2e record` films a real testnet purchase in a headless Chrome: the payment page from
  `--start payment`, or the whole purchase from the home page with `--start shop`, the payment, the
  page noticing it, and the order confirmation. Output: `recording.mp4` (H.264, 25 fps),
  `first.png`, `settled.png`, `confirmation.png`, `recording.json` with the transaction hash and the
  moments for the edit, and `record.log`. Options `--asset`, `--start`, `--size`, `--out`.
- `--start shop` walks the storefront with the plugin's `dev/try/browser/walk.mjs`; with
  `--start payment` the walk places the order off camera, so the confirmation at the end belongs to
  the session that ordered. Without a walk the driver places the order, as in the catalogue.
- MCP tool `shop_record_purchase`, a background job like `run_cases`.
- `puppeteer-core` 25.16.0 (as in the plugins' try walks) as an optional dependency, loaded by `record` alone; ffmpeg from the PATH.
- A payment result carries the ledger index (`ledgerIndex`) of its transaction.
- Drivers may report the plugin version (`pluginVersion()`); Shopware does, from its plugin list.
- One version constant for the CLI, the MCP server and reports (`src/version.ts`).

## 0.1.0

- The harness: testnet wallets on XRPL, Stellar and Xahau, the payment-status catalogue PS-01…PS-15,
  drivers for Shopware, PrestaShop, WooCommerce and Magento, the try stacks, the MCP server, the
  spend guard, and evidence into pull requests.
