# ledger-direct-e2e

**End-to-end tests for ledger payment integrations — XRPL and Stellar — against a real testnet, with evidence you can look up.**

The harness plays the customer with a wallet. It reads what a shop asks for off its payment page,
sends exactly that — or deliberately something else — as a signed transaction on the chain's
testnet, and checks what the shop makes of it. Every result is something a third person can
verify: an order reference, the transaction hashes with explorer links, the sequence of states the
shop's status endpoint answered.

It tests the contract between ledger and shop. Not the ledger (`xrpl.js` does that), not the user
interface (Cypress does that), not the shop's logic with made-up records (its unit tests do that) —
the one question all of those leave open: **does the amount the page shows, paid for real, settle
the order?** And the questions behind it: what if less arrives, or the wrong token, or the quote has
expired, or the customer is a guest, or nobody keeps the page open, or the merchant cancelled?

Testnet only. There is no mainnet URL in this code.

## The cases

Twelve cases with fixed IDs from the LedgerDirect payment-status contract, platform-neutral but one:
PS-12 is Shopware's Store API and runs there only (a run against another platform records it as
skipped). All twelve run unattended. Two are nightly-only: PS-04 needs the public testnet's issuers,
PS-10 waits 35 minutes for the payment token to expire. `--cases automated` is the set without those
two, a dev-shop run in minutes; `--cases nightly` is every case; `--cases all` is the whole catalogue,
whatever has no runner recorded as skipped.

| ID | Case | What it proves |
|---|---|---|
| PS-01 | Waiting | nothing sent: state `waiting`, countdown falls, no redirect |
| PS-02 | Expired, then refreshed | an expired quote is refreshed on the same account and tag; a partial payment survives the refresh |
| PS-03 | Partial, then topped up | half arrives: `partial` with the shortfall; the shortfall arrives: `settled`, two hashes, one payment record |
| PS-04 | Wrong asset, then the right one | a USDC order paid in RLUSD from the real issuers: `wrong_asset`, full amount still due, merchant sees it; USDC settles |
| PS-05 | Settled | **the one that matters:** the displayed amount, sent exactly, settles — on a small order, where rounding bites hardest |
| PS-06 | Guest | page and status endpoint work with the order's secret alone, no session |
| PS-07 | Wrong key | refused with 403, identically for a wrong key and an unknown order, no data in the answer |
| PS-08 | Throttling | two status calls inside 5 s cause one node request |
| PS-09 | Safety net | paid, nobody polls: the platform's cron or scheduled task settles the order alone |
| PS-10 | Late return | paid 35 minutes after checkout: settles, redirect goes to an order page, not an expired token |
| PS-11 | Closed by the merchant | cancelled, paid anyway: redirect, no state change back to open |
| PS-12 | Headless (Shopware) | as a guest without a session: `quote` over the Store API carries every value the payment page shows, `check` the contract; a wrong code is refused like an unknown order; paid: redirect to an absolute URL; afterwards `quote` answers 410 |

`ld-e2e cases list` and `ld-e2e cases show PS-05` print the catalogue.

## Quick start

```
npm install && npm run build
set -a; source ~/.config/ledger-direct/testnet.env; set +a
#   LEDGERDIRECT_TESTNET_XRPL_TREASURY_SEED     the XRPL treasury (XRP, RLUSD, USDC)
#   LEDGERDIRECT_TESTNET_STELLAR_TREASURY_SEED  the Stellar treasury (XLM)
ld-e2e wallet status                          # --chain XRPL is the default
ld-e2e --chain STELLAR wallet status
ld-e2e run --target prestashop --base-url http://localhost:8080 \
  --compose-dir /path/to/prestashop-harness --cases automated   # --chain STELLAR once a plugin accepts it
ld-e2e run --target shopware --base-url http://localhost \
  --access-key <sales channel access key> --cases automated
ld-e2e run --target woocommerce --base-url http://localhost:8082 \
  --compose-dir /path/to/wordpress-stack --cases automated      # WP-CLI runs in that stack
ld-e2e run --target magento --base-url https://localhost:8444 \
  --compose-dir /path/to/magento-stack --cases automated         # PHP runs in that stack
```

Every `--base-url` and `--compose-dir` has an environment fallback, `LD_E2E_<TARGET>_BASE_URL` and
`LD_E2E_<TARGET>_COMPOSE_DIR`, so a run is usually just `--target` and `--cases`. Without a compose folder
the current one is used; the PrestaShop driver checks it before its first command and names the variable,
and says to `docker compose up -d` when the stack is stopped. Started from anywhere else — the lab, an MCP
client — set the variable.

Every command takes `--chain XRPL|STELLAR`; without it, XRPL. Each chain has its own treasury
wallet, and a run creates a fresh receiving account on that chain (two runs must never share an
identifier space), sets trust lines, points the shop at it, places real orders and pays them from
the chain's treasury. `out/report.json` holds the evidence; the console prints one checklist line per
case.

## Chains

The catalogue talks about a receiving account, a payment identifier, a native asset, issued assets
and a hash — none of which is XRPL. `src/chains/chain.ts` is the contract; `xrpl/` and `stellar/`
fulfil it. `--chain XRPL|STELLAR` picks one, each with its own treasury in the environment.

| Chain | Identifier | Native | Faucet | Status |
|---|---|---|---|---|
| XRPL testnet | destination tag | XRP | `faucet.altnet.rippletest.net`, DEX top-ups | ten cases green against PrestaShop and Shopware |
| Stellar testnet | `MEMO_ID` | XLM | Friendbot | wallets and payments with memo verified; issued assets follow the core's Stellar registry; cases run once a plugin accepts Stellar |

A third chain is one class behind the contract, one entry in `ledgerFor()`, one treasury variable.

## Drivers

How the whole of LedgerDirect is tested across the core, the shared page package and the four plugins — the layers, what each catches, the nightly end-to-end runs and the manual cases — is in [`docs/testing.md` of the core](https://github.com/ledger-direct/ledger-direct-core-php/blob/master/docs/testing.md).

A platform is eight methods (`src/drivers/driver.ts`): configure the shop, place an order, read the
payment page (state, **displayed** amount, account, tag), read the status endpoint, refresh an
expired quote, close an order, trigger the safety net, count node requests. Everything on the
ledger side is shared; the catalogue never changes per platform.

The payment page is read by one function for all platforms, `readPaymentPage()` in
`src/drivers/page.ts`, through the markup contract of
[`@ledger-direct/payment-ui`](https://github.com/ledger-direct/ledger-direct-payment-ui) (`src/README.md`
there): `data-ld-state`, `data-ld-amount-requested` and `data-ld-asset` on the root, `[data-ld-account]`
and `[data-ld-tag]` by their `data-value`, `data-ld-poll-url` for the status endpoint. A driver never
parses a platform id or a label; all four plugins render the contract (Shopware 1.4.2, PrestaShop 0.5.0,
Magento 1.1.0, WooCommerce 1.3.0).

| Platform | Driver | Notes |
|---|---|---|
| PrestaShop 9 | `prestashop.ts` | orders through the module's `dev/bin/e2e.php` inside the shop container; everything a customer does is HTTP |
| Shopware 6.7 | `shopware.ts` | Store API for the order (guest registration, cart, order, handle-payment), Admin API for configuration, order state and cancelling; the scheduled task runs through the container's console. The only driver with a `headless` API (`quote` and `check` over the Store API, plugin 1.8.0), which PS-12 uses |
| WooCommerce | `woocommerce.ts` | orders through WP-CLI in the stack's running `wp` container (a PHP script on stdin, as the gateway's `process_payment` would); page, status endpoint and the refresh form over HTTP; the Action Scheduler hook fired for the safety net |
| Magento 2 | `magento.ts` | REST API for the order (guest cart, item, addresses, payment method), admin REST for order state and cancelling; configuration, cron job and throttle mark as PHP inside the `phpfpm` container; accepts the dev shop's self-signed certificate |

The displayed amount is read off the page and never recomputed. That is the number a customer
types into a wallet, and the one a rounding bug hides in.

PS-08 needs an observable for "a sync happened": PrestaShop exposes the throttle mark in a table,
WooCommerce in a transient and Magento in its cache (all three hold the time of the last sync, read
through the platform's CLI), Shopware logs one debug line per sync (`LedgerDirect: ledger synced`,
`APP_ENV=dev`). The first
Shopware run of PS-08 found that Shopware's own dev configuration backs the object cache with an
in-memory array adapter, which turns the plugin's throttle and rate cache into no-ops per request:
the dev shop needs `framework.cache.app: cache.adapter.filesystem` (or Redis), as production has.

## Evidence into the pull request

```
ld-e2e report pr --repo owner/name --pr 15 --dry-run
ld-e2e report pr --repo owner/name --pr 15
```

The pull request stays the record. In its "Manual end-to-end tests" section, every line that starts
with a case ID is replaced by the report's line for that case: ticked when it passed, with order
reference and hashes; left open with the reason when it failed. Lines without an ID and every other
section are untouched; a second run replaces its own lines. It runs as you, through `gh`.

## MCP server

The same functions as tools for a coding session or an agent — `ld-e2e mcp` speaks MCP over stdio.
Register it in Claude Code through the wrapper that loads the wallet file into the process
environment (seeds never go into an MCP configuration):

```
claude mcp add ledger-direct-e2e -- /path/to/ledger-direct-e2e/scripts/ld-e2e-mcp
```

Give the server the shops it may talk to through the environment (in the same file):
`LD_E2E_<TARGET>_BASE_URL` and `LD_E2E_<TARGET>_COMPOSE_DIR` for PrestaShop, WooCommerce and
Magento, `LD_E2E_SHOPWARE_ACCESS_KEY` for Shopware (`.env.example` lists them all), and optionally
the spending limits below.

**Which door when.** In a session with a shell (Claude Code), prefer the CLI with `--json`: the
state lives in the file system — order numbers, hashes, `out/report.json` — and a long run needs no
job to poll. The MCP server is for clients without a shell (Desktop, Cowork) and for the shopping
agent. Both call the same functions.

| Group | Tools |
|---|---|
| Shopping and paying | `shop_search_products`, `shop_place_order`, `shop_pay_order`, `shop_order_status`, `shop_wait_for`, `shop_order_evidence` |
| Wallets | `wallet_status`, `wallet_fresh` (address only), `wallet_fund`, `pay` |
| Catalogue | `list_cases`, `run_cases` (background job), `job_status`, `report_pr` |

"Order two mugs on the PrestaShop dev shop and pay in RLUSD" is four tool calls: search, place,
pay, wait — and the answer carries the transaction hash, the explorer link and what the shop
recorded. The rules every tool keeps: testnet only; no seed ever leaves the server; a payment above
`LD_E2E_MAX_PAYMENT` or beyond `LD_E2E_RUN_BUDGET` is refused, not questioned; a payment the ledger
rejected is an error, never a success with a hash. `wallet_status` shows what the server has paid
since it started.

## As a library: the session and the deviation rules

The third door, for a person: [`ledger-direct-lab`](https://github.com/ledger-direct/ledger-direct-lab)
shows an order as three windows side by side — what the customer sees, what the shop recorded, what
the ledger holds — and a demo stage. It has no logic of its own; it imports this package
(`src/index.ts` is the public entry):

- `ShopSession` (`src/session.ts`) is the kernel of the MCP shop tools: one driver per target, the
  orders of this process, `payOrder()` for the displayed amount, half of it, the shortfall or another
  asset — always from the chain treasury, always through the spend guard.
- `Ledger.incoming(address, { identifier })` lists what arrived on the chain: the delivered amount
  (not the sent maximum), the issuer, the tag or memo and how it travelled (tag, memo id, text memo,
  muxed id).
- `observe()` (`src/watch/observe.ts`) reads the three sides at one moment; a side that cannot be
  read is recorded, never hides the other two. `deviations()` compares a series of observations:

| Rule | Level | Holds when |
|---|---|---|
| `ledger-paid-page-waiting` | alarm | the ledger has a payment in the quoted asset, the status endpoint still says `waiting`/`expired` |
| `ledger-foreign-not-shown` | alarm | a token from another issuer arrived on a token quote, the endpoint does not say `wrong_asset` |
| `status-settled-shop-open`, `shop-paid-status-open` | alarm | endpoint and shop disagree on whether the order is paid |
| `page-amount-differs` | alarm, at once | the page asks for another amount than the quote (the 0.83-for-0.83211 bug) |
| `page-not-testnet` | alarm, at once | the page names another network |
| `page-status-differ` | warning | page and endpoint show different states |
| `amount-paid-differs` | warning | what the endpoint counts is not what arrived |
| `tx-not-recorded` | warning | a validated transaction the shop has not stored |
| `settled-no-redirect` | warning | settled, but the page gets nowhere to go |
| `customer-unreachable`, `shop-unreachable`, `ledger-unreachable` | warning | a side cannot be read |

Every rule but the two marked "at once" has to hold for a grace period (20 s by default: the sync is
throttled to 5 s, a page polls every 8 s). The payment page's QR request (`data-ld-payment-uri`),
its network and the quoted issuer are now part of what `readPaymentPage()` returns, and every driver
adds the page URL — the lab shows the shop's own QR code instead of building one.

## Spending limits

Every payment passes one guard before it is signed — `ld-e2e pay`, the catalogue (so the nightly)
and the MCP tools alike (`src/chains/spend.ts`, wrapped around every ledger `ledgerFor()` hands out):

- `LD_E2E_MAX_PAYMENT` (default 50) caps a single payment, in the asset's units.
- `LD_E2E_RUN_BUDGET`, e.g. `XRP=15,RLUSD=5,USDC=5`, caps the sum per process and asset — per run for
  the CLI, per server start for MCP. Unset, there is no budget. Once set, an asset it does not name
  gets nothing.

A payment counts when it is about to be signed, the catalogue's deliberate wrong ones included.
Crossing a limit is an error: the case fails, the wallet keeps its funds. The report carries what
the run spent (`spending`), the CLI prints it after the checklist. A full XRPL run with the 1-euro
test article spends roughly 5 XRP, 2 RLUSD and 1 USDC. DEX purchases (`wallet top-up`) are not
payments and have their own `--max-xrp`.

## Wallets

```
ld-e2e wallet fresh --trustlines                 # a new XRPL account for one run; prints the seed once
ld-e2e --chain STELLAR wallet fresh              # the same on Stellar, via Friendbot
ld-e2e wallet fund r...                          # XRPL faucet, +100 XRP
ld-e2e --chain STELLAR wallet fund G...          # Friendbot, +10 000 XLM
ld-e2e wallet book RLUSD                         # XRPL only: what the testnet DEX offers
ld-e2e wallet top-up --rlusd 20                  # XRPL only: buy tokens on the DEX — no faucet web page, no captcha
ld-e2e pay --to r... --id 123 --amount 0.83 [--asset RLUSD] [--partial]     # XRPL: --id is the destination tag
ld-e2e --chain STELLAR pay --to G... --id 123 --amount 1.5                    # Stellar: --id is the MEMO_ID
```

On Stellar, issued assets (USDC, EURC) are not listed until the core's Stellar registry ships;
`wallet status` shows XLM only, and a test asset can be issued for the wrong-asset case.

## The shop's own account

A run configures a fresh throwaway account as the shop's receiving account; nothing else is
safe, two runs must never share an identifier space. It used to leave that account there, so the
next manual test paid into an account nobody watched. Now the run puts the shop back on its own
account when it knows one — `LEDGERDIRECT_TESTNET_<TARGET>_SHOP_ADDRESS` in the wallet file, or
`LD_E2E_<TARGET>_SHOP_ACCOUNT` — and says so; `--keep-account` leaves the throwaway in place for
debugging. The same by hand, after a manual test changed something:

```
ld-e2e shop reset --target woocommerce            # the shop's own account, testnet, every asset on, 300 s quote
ld-e2e shop reset --target shopware --account r…  # a specific account
```

In CI neither variable is set and the run leaves the shop as it is; the container is gone a
minute later.

## Secrets

Seeds come from the environment and from nowhere else. The program knows no file: locally you
`source` one (`.env.example` shows the variables; the convention is `~/.config/ledger-direct/testnet.env`,
outside every repository), in CI the same variable names are organisation secrets. Anything that looks like a seed is
redacted before it can reach an error message, a report or a log. Never put a seed in this
repository — not in a test, not as a sample.

## Status

0.1.0. Ten cases automated and green against PrestaShop, Shopware, WooCommerce and Magento on XRPL
with real testnet transactions; Stellar wired and verified on the ledger side; the MCP server drives
the same functions, verified with a two-item RLUSD order placed, paid and settled through the tools.
Next: nightly runs. A mainnet mode follows once the canary token
exists — a separate decision, not a flag.

MIT.
