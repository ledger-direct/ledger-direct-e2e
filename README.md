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

Eleven cases with fixed IDs, platform-neutral, from the LedgerDirect payment-status contract. Ten
run unattended; PS-10 waits 35 minutes and belongs to a nightly run.

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
```

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
| XRPL testnet | destination tag | XRP | `faucet.altnet.rippletest.net`, DEX top-ups | ten cases green against PrestaShop |
| Stellar testnet | `MEMO_ID` | XLM | Friendbot | wallets and payments with memo verified; issued assets follow the core's Stellar registry; cases run once a plugin accepts Stellar |

A third chain is one class behind the contract, one entry in `ledgerFor()`, one treasury variable.

## Drivers

A platform is eight methods (`src/drivers/driver.ts`): configure the shop, place an order, read the
payment page (state, **displayed** amount, account, tag), read the status endpoint, refresh an
expired quote, close an order, trigger the safety net, count node requests. Everything on the
ledger side is shared; the catalogue never changes per platform.

| Platform | Driver | Notes |
|---|---|---|
| PrestaShop 9 | `prestashop.ts` | orders through the module's `dev/bin/e2e.php` inside the shop container; everything a customer does is HTTP |
| Shopware 6 | — | next: Store API |
| WooCommerce | — | planned |
| Magento 2 | — | planned |

The displayed amount is read off the page and never recomputed. That is the number a customer
types into a wallet, and the one a rounding bug hides in.

## Evidence into the pull request

```
ld-e2e report pr --repo owner/name --pr 15 --dry-run
ld-e2e report pr --repo owner/name --pr 15
```

The pull request stays the record. In its "Manual end-to-end tests" section, every line that starts
with a case ID is replaced by the report's line for that case: ticked when it passed, with order
reference and hashes; left open with the reason when it failed. Lines without an ID and every other
section are untouched; a second run replaces its own lines. It runs as you, through `gh`.

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

## Secrets

Seeds come from the environment and from nowhere else. The program knows no file: locally you
`source` one (`.env.example` shows the variables; the convention is `~/.config/ledger-direct/testnet.env`,
outside every repository), in CI the same variable names are organisation secrets. Anything that looks like a seed is
redacted before it can reach an error message, a report or a log. Never put a seed in this
repository — not in a test, not as a sample.

## Status

0.1.0. Ten cases automated and green against PrestaShop on XRPL with real testnet transactions;
Stellar wired and verified on the ledger side. Next:
the Shopware driver, an MCP server over the same functions so a coding session can run a case as a
tool, then WooCommerce and Magento, then nightly runs.

MIT.
