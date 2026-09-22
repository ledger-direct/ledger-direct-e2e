# ledger-direct-e2e

End-to-end harness for the LedgerDirect plugins (PrestaShop, Shopware, WooCommerce, Magento):
XRPL testnet wallets, payments the way a customer wallet sends them, and the payment-status case
catalogue PS-01 … PS-11 — one tool for all four shops, as a CLI and, later, as an MCP server.

Testnet only. This tool never touches mainnet.

## Setup

```
npm install
npm run build          # dist/cli.js, exposed as `ld-e2e`
npm test
```

Secrets come from the environment and from nowhere else:

```
set -a; source ~/.config/ledger-direct/testnet.env; set +a
```

`LEDGERDIRECT_TESTNET_TREASURY_SEED` is the wallet that pays. In CI the same variable is an
organisation secret. Seeds are never written to a repository, a report, a log or an error message.

## Wallets

```
ld-e2e wallet status                       # treasury: XRP, RLUSD, USDC
ld-e2e wallet status rSomeShopAccount      # any account
ld-e2e wallet fresh --trustlines           # a new receiving account for one run — one per run, never shared
ld-e2e wallet fund rSomeAccount            # faucet top-up, +100 XRP
ld-e2e wallet book RLUSD                   # what the testnet DEX offers
ld-e2e wallet top-up --rlusd 20 --usdc 20  # buy tokens on the DEX (no faucet web page, no captcha)
```

## Paying

Read the amount, account and tag off the shop's payment page and send exactly that — the harness
never recomputes an amount, because the number the customer types into a wallet is the one that
has to settle:

```
ld-e2e pay --to r... --tag 406757891 --amount 15.06378
ld-e2e pay --to r... --tag 406757891 --amount 5              # PS-03: half now, the shortfall later
ld-e2e pay --to r... --tag 406757891 --amount 12.5 --asset RLUSD   # PS-04: a USDC order paid in RLUSD
```

Every payment prints the hash and an explorer link — the evidence a pull request's checklist asks for.

## Catalogue

```
ld-e2e cases list
ld-e2e cases show PS-05
ld-e2e run --target shopware --cases PS-05   # drivers are the next milestone
```

## Roadmap

See `Handover-E2E-Teststrategie.md` (harness folder). In order: ledger tooling (done),
Shopware driver, PS-01/03/05/08 against Shopware, the other three drivers, the MCP server,
nightly `e2e.yml` workflows with organisation secrets.
