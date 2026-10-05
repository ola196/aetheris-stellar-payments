# Running the integration tests

The server integration tests exercise the full x402 payment flow across the
HTTP boundary. They use Supertest and an in-memory SQLite replay store, so they
run **deterministically in CI without any live Stellar Testnet connection**.

## Prerequisites

- Node.js ≥ 22.13 (Node 24 recommended, matching the CI workflow)
- `npm` (comes with Node)

## Quick start

```bash
# From the repository root
npm ci --prefix server
npm --prefix server run build
npm --prefix server test
```

Or, if you are already inside the `server/` directory:

```bash
npm ci
npm run build
npm test
```

The `build` step (TypeScript compile) is required before running the test
runner; Vitest imports the source directly via the TypeScript loader, but the
build step confirms there are no type errors before the suite runs.

## What the tests cover

The suite is in `server/test/payment.test.ts` and is organised into eight
groups:

| Group | Description |
| --- | --- |
| `unauthenticated request` | A request with no `PAYMENT-SIGNATURE` header must receive HTTP 402 and a well-formed x402 V2 `PAYMENT-REQUIRED` header with the correct scheme, network, asset, amount, `payTo`, contract ID, and resource metadata. |
| `valid payment` | A correctly signed cumulative voucher must receive HTTP 200, return the protected resource body, and include a base64-encoded `PAYMENT-RESPONSE` header whose decoded JSON reports `success: true`, the correct nonce, cumulative amount, and `"settlement": "deferred"`. |
| `replay protection` | Submitting the same voucher twice (same nonce) must be rejected with HTTP 402. A failed request (bad signature) must not consume the nonce; the matching valid voucher must still be accepted afterwards. |
| `out-of-order and non-consecutive voucher rejection` | A nonce lower than the current cursor, a cumulative amount that skips more than one price increment, and a zero nonce are all rejected. |
| `invalid signature rejection` | An all-zero signature, a signature produced by the wrong key, and a signature over tampered payload fields are all rejected. |
| `malformed PAYMENT-SIGNATURE header` | Non-base64 values, non-JSON base64, JSON missing required fields, oversized headers (≥ 20 000 bytes), wrong `x402Version`, and wrong scheme are all rejected at the parse layer (HTTP 400) or payment layer (HTTP 400/402). |
| `expired voucher rejection` | A voucher whose `validUntil` timestamp is in the past is rejected; so is a voucher whose channel's `expiresAt` is in the past. |
| `multi-step cumulative voucher sequence` | Three sequential vouchers with strictly incrementing nonces and amounts are all accepted; the `PAYMENT-RESPONSE` at each step reflects the correct nonce and running total; a gap in the amount sequence is rejected without corrupting the cursor. |
| `/health endpoint` | The `/health` route returns HTTP 200 and `{"status":"ok"}` with no payment required. |
| `paid data route gate` | A separate `/paid/data`-style route (matching the production route in `src/index.ts`) returns HTTP 402 without a payment header and HTTP 200 with a valid voucher, mirroring real production behaviour. |

## Interpreting results

A successful run looks like this:

```
✓ test/payment.test.ts (33 tests) 270ms

Test Files  1 passed (1)
      Tests  33 passed (33)
   Duration  ~700ms
```

All 33 tests must pass. The suite is deterministic and does not depend on
network access, environment variables, or timing beyond a 600-second voucher
expiry window.

## Continuous integration

The `server` job in `.github/workflows/ci.yml` runs these steps automatically
on every push and pull request:

```yaml
- run: npm ci
  working-directory: server
- run: npm install-scripts approve esbuild
  working-directory: server
- run: npm run build
  working-directory: server
- run: npm test
  working-directory: server
```

No Testnet credentials or secrets are required.

## Adding new tests

Import from `../src/payment.js` and reuse the `buildSignedHeader` helper in the
test file to sign vouchers with the deterministic test key. Mount additional
routes via `makeApp()` or create a local Express instance for route-specific
scenarios. Keep the in-memory `replayStore` (created fresh in `beforeEach`) so
each test starts with a clean cursor state.
