# Changelog

## Unreleased

- `ld-e2e record --color-scheme light|dark` (MCP: `colorScheme`), `light` by default: what the pages see as
  `prefers-color-scheme`. Headless Chrome took the system's before, so a Mac in dark mode filmed a dark payment
  page. The scheme is in the folder name and in `recording.json`.

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
