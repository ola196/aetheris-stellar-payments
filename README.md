# Aetheris x402 Engine

Aetheris explores a practical payment channel for API calls and AI-agent
micropayments on Stellar. Buyers escrow tokens once in a Soroban contract, then
authorize usage with compact off-chain Ed25519 vouchers. An API server checks
each voucher without requiring an on-chain transaction for every request; a
payee can later claim the latest cumulative voucher on-chain.

> **Status: experimental Testnet MVP.** It has not been audited and is not for
> real funds. `stellar-channel` is a project-specific x402 V2-style scheme, not
> an officially registered x402 scheme or SDF product. No project can promise
> grant, Wave, or program approval.

## Why this is useful to Stellar

Soroban is a programmable settlement layer, but settling every tiny API request
on-chain adds avoidable latency and transaction overhead. Voucher channels move
request authorization off-chain while leaving custody and final settlement in
Soroban escrow. That gives API providers and autonomous agents a testable path
to usage-based payments using Stellar assets and wallets, while maintaining
on-chain deposit limits, expiry, signature checks, and refunds.

The design is intentionally honest about its boundary: it removes a chain
transaction per request, not all cost or trust. Buyers still pay for channel
opening, payees pay to claim, and the service must verify the channel and
prevent voucher replay.

## How the MVP works

1. Connect Freighter and open a Soroban channel, depositing a test asset and
   binding a delegate Ed25519 public key.
2. Request a protected endpoint. The Express server returns HTTP 402 with a
   base64-encoded x402 V2 `PAYMENT-REQUIRED` object.
3. Sign a domain-separated cumulative voucher in the browser and retry with
   `PAYMENT-SIGNATURE`.
4. The server checks the live channel over Soroban RPC, verifies the voucher,
   and atomically advances its replay cursor before granting the resource.
5. The dashboard keeps the latest voucher in memory. The configured payee can
   switch Freighter to its account and submit that voucher through the contract.
   After expiry, the payer can refund the remaining escrow.

See [architecture](./docs/architecture.md) and the exact
[voucher byte format](./docs/voucher-format.md) and
[contract API](./docs/contract-api.md).

## Repository layout

```text
contracts/channel/   Soroban escrow contract and Rust unit tests
server/              Express x402 middleware, Soroban reader, API tests
frontend/            Next.js + TypeScript + Freighter Testnet dashboard
scripts/              Testnet deployment helpers (PowerShell and Bash)
docs/                 Architecture and voucher protocol
.github/workflows/    CI for Rust, server, and frontend
```

## Prerequisites

- Rust 1.91+ and the `wasm32v1-none` target
- Stellar CLI 28 or newer, configured with a funded Testnet identity
- Node.js 24 (Node 22.13+ is supported) and npm
- Freighter browser extension for the dashboard's transaction flow

Soroban SDK is pinned to **28.0.0** in the contract manifest (the current
release verified while this project was scaffolded). Rust tests use Soroban
testutils and do not require a live network.

## Build and test

From the workspace root:

```powershell
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
stellar contract build --package aetheris-channel
```

Run API tests and type-check:

```powershell
npm.cmd ci --prefix server
npm.cmd --prefix server install-scripts approve esbuild
npm.cmd --prefix server run build
npm.cmd --prefix server test
```

Build the web dashboard:

```powershell
npm.cmd ci --prefix frontend
npm.cmd --prefix frontend install-scripts approve esbuild
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

The Express/Supertest integration tests cover the full x402 payment flow
without a live Testnet: the 402 challenge and payment requirements, valid
signed-voucher acceptance with PAYMENT-RESPONSE header verification, replay
and out-of-order nonce rejection, invalid and tampered signature rejection,
malformed header rejection, expired voucher rejection, and multi-step
cumulative voucher sequences. See [docs/testing.md](./docs/testing.md) for
a full description of every test scenario and how to run them locally.
Contract tests exercise deposits, cumulative settlement, replay/overdraw
rejection, refunds, and the pause switch.

## Local configuration

Copy the examples to ignored local environment files:

```powershell
Copy-Item server\.env.example server\.env
Copy-Item frontend\.env.example frontend\.env.local
```

Set these values before starting the server:

| Variable | Meaning |
| --- | --- |
| `SOROBAN_CONTRACT_ID` | Deployed channel contract (`C...`) |
| `SOROBAN_TOKEN_ID` | Testnet token contract used for escrow |
| `PAY_TO` | Channel payee address (`G...`) |
| `SOROBAN_SOURCE_ACCOUNT` | Public Testnet account used to simulate read-only channel queries |
| `STELLAR_RPC_URL` | Soroban RPC URL (defaults to Testnet) |
| `FRONTEND_ORIGINS` | Comma-separated exact browser origins allowed by CORS |
| `REQUEST_PRICE` | Smallest token units charged per API call; default `100`. Used only when `ENDPOINT_REQUIREMENTS` is not set. |
| `REPLAY_DATABASE` | Local SQLite cursor path; default `./data/replay.sqlite` |
| `ENDPOINT_REQUIREMENTS` | JSON array of per-endpoint payment requirements (see below). When set, takes full precedence over `REQUEST_PRICE` and `SOROBAN_TOKEN_ID`. |

### Configuring protected endpoints

Each protected route can define its own price and accepted token. Set
`ENDPOINT_REQUIREMENTS` to a JSON array — one object per route:

```json
[
  {
    "path": "/paid/data",
    "amount": "100",
    "tokenAddress": "C...",
    "description": "Metered data endpoint",
    "mimeType": "application/json"
  },
  {
    "path": "/paid/premium",
    "amount": "500",
    "tokenAddress": "C...",
    "description": "Premium analytics endpoint",
    "mimeType": "application/json"
  }
]
```

In your `.env` file, write it as a single line:

```env
ENDPOINT_REQUIREMENTS=[{"path":"/paid/data","amount":"100","tokenAddress":"C...","description":"Metered data endpoint","mimeType":"application/json"}]
```

Field rules (validated at startup — the server refuses to start on any error):

| Field | Required | Constraints |
| --- | --- | --- |
| `path` | yes | Must start with `/` |
| `amount` | yes | Positive integer string; no leading zeros; minimum `"1"` |
| `tokenAddress` | yes | Non-empty Stellar contract address string (`C...`) |
| `description` | yes | Non-empty string; included in the HTTP 402 response body |
| `mimeType` | yes | Non-empty string; included in the HTTP 402 response body |

Duplicate paths are rejected. When `ENDPOINT_REQUIREMENTS` is absent or empty, the server falls back to the legacy single-route mode using `REQUEST_PRICE` and `SOROBAN_TOKEN_ID` for the built-in `/paid/data` route.

Set the corresponding `NEXT_PUBLIC_SOROBAN_CONTRACT_ID`,
`NEXT_PUBLIC_SOROBAN_TOKEN_ID`, `NEXT_PUBLIC_PAY_TO`,
`NEXT_PUBLIC_PAID_API_URL`, and `NEXT_PUBLIC_REQUEST_PRICE` in
`frontend/.env.local`. The frontend and server prices must match. Use an asset
and payee that are consistent with the channel contract.

Start each process in its own terminal:

```powershell
npm.cmd --prefix server run dev
npm.cmd --prefix frontend run dev
```

Open `http://localhost:3000`, connect Freighter on Testnet, and use the
dashboard. The source account configured on the server must exist on the same
network. The API's `GET /health` endpoint checks that the process is running;
`GET /paid/data` is the example paid route.

For settlement, the **payee address must be available in Freighter**, because
only that account can authorize the claim. The checked-in local demo
configuration uses the CLI deployer address as `PAY_TO`. If you want to settle
from your own Freighter account instead, set `PAY_TO` in `server/.env` and
`NEXT_PUBLIC_PAY_TO` in `frontend/.env.local` to that account's public `G...`
address, then restart both processes and open a **new** channel. A channel's
payee cannot be changed after it is opened. The dashboard keeps the delegate
key and latest signed voucher in memory; keep the tab open through settlement.

## Reviewer walkthrough

Use Stellar Testnet and a small amount of test funds. The dashboard and server
must be configured for the same contract, token, payee, and request price.

1. **Connect Freighter.** Switch Freighter to Testnet and connect it to the
   dashboard. Confirm the dashboard shows your connected public address.
2. **Open a channel.** Enter the channel details and open it. Confirm the
   dashboard shows the new channel and its deposited amount.
3. **Make a paid request.** Use the dashboard to call the example paid API.
   Without payment, the API responds with HTTP `402 Payment Required`. The
   dashboard then creates a signed voucher for the request.
4. **Settle the voucher.** Keep the dashboard tab open while the voucher is
   waiting to be settled. Use the payee account in Freighter to submit the
   settlement transaction.
5. **Check the result.** Confirm the dashboard shows the settlement, then open
   the transaction in Stellar Testnet Explorer to verify it was recorded.

The dashboard keeps its temporary voucher-signing key and pending voucher in
browser memory. They are not saved as private keys in local storage, so keep the
tab open until settlement is complete.

## Testnet deployment

First create/fund a Stellar CLI identity and arrange a compatible Testnet token
contract. Then deploy and initialize the channel contract:

```powershell
.\scripts\deploy-testnet.ps1 -Identity aetheris-deployer
```

Or on Bash:

```bash
bash ./scripts/deploy-testnet.sh aetheris-deployer
```

The CLI identity is used to submit deployment/initialization transactions; the
admin defaults to that identity's public address. The script prints the
contract ID to copy into both local environment files. It does not create a
token, fund accounts, or write credentials to the repository.

## Security and limitations

- Soroban checks payer authorization for deposits, payee authorization for
  settlement, and admin authorization for the circuit breaker.
- A payer explicitly binds the delegate voucher key while opening the
  channel. Vouchers are scoped to network, contract, channel, nonce, amount,
  and expiry. Escrow transfers use checks-effects-interactions.
- The server reads channel state from Soroban RPC and uses a transactional
  SQLite nonce/amount cursor. SQLite is single-host; production horizontal
  scaling requires a shared transactional store and rate limiting.
- There is no automatic batch-settlement worker, production wallet/key custody,
  dispute flow, or audited facilitator yet. Settlement is a manual payee action
  from the dashboard; the server does not hold the payee's signing key.
- The dashboard keeps the delegate private key in page memory only. Reloading
  loses it; open only demo channels with funds you are willing to leave locked
  until expiry/refund.
- Soroban state rent/TTL costs apply. Channels are limited to 30 days and state
  entries are extended on contract calls, but an RPC simulation does not commit
  a TTL extension. Review network rent parameters and expiry behavior before
  any production deployment.

Read [SECURITY.md](./SECURITY.md) before experimenting. Testnet execution,
repository activity, Drips identity verification, and walkthrough recording
are separate operational steps; this code cannot guarantee program acceptance.
