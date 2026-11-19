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
