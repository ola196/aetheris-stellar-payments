# Architecture

## Payment lifecycle

1. The buyer connects Freighter and submits an `open_channel` Soroban
   transaction. The payer authorizes the token deposit and a delegate voucher
   public key in the same call.
2. The API returns an x402 V2 `PAYMENT-REQUIRED` header when a paid route is
   requested without a payment payload.
3. The buyer signs a cumulative Ed25519 voucher off-chain and retries with
   `PAYMENT-SIGNATURE`. The signature is bound to a network, contract, channel,
   cumulative amount, nonce, and deadline.
4. The server loads the live channel through Soroban RPC, verifies the voucher,
   and atomically advances a SQLite replay cursor. It returns the resource with
   `PAYMENT-RESPONSE`; it does not submit a Soroban transaction per API request.
5. The dashboard retains the newest signed cumulative voucher in browser memory.
   The payee connects Freighter and submits it to `settle`; the contract
   transfers only the difference between the new cumulative amount and what
   has already been settled. After channel expiry, the payer can recover the
   unclaimed balance with `refund`.

## Components

- `contracts/channel`: Soroban escrow state machine, signature verifier,
  circuit breaker, and TTL maintenance.
- `server`: Express x402 V2-style HTTP middleware, Soroban RPC channel reader,
  and atomic SQLite replay protection.
- `frontend`: Next.js dashboard for Testnet channel creation via Freighter and
  signed API requests.
- `scripts`: Testnet deployment helpers for PowerShell and Bash.

The scheme name `stellar-channel` is an Aetheris extension, not a claim that the
x402 Foundation has registered or standardized this Stellar scheme. The
protocol headers and version follow the x402 V2 conventions; ecosystem
interoperability will require compatible clients/facilitators and appropriate
scheme registration.

## Trust boundaries and current scope

- Contract checks are authoritative for fund movement. The API's off-chain
  verification is an early access decision, not final on-chain settlement.
- The server reader uses a configured public source account for RPC simulation;
  it does not need its private key. Protect the Testnet RPC endpoint and apply
  rate limits before exposing the service publicly.
- Channel expiry is capped at 30 days. The contract extends entry TTL on calls,
  but only submitted transactions commit a TTL extension; read-only RPC
  simulations do not.
- After channel expiry the payer (and only the payer) can recover the unsettled
  balance by calling `refund`. The dashboard shows expiry time, a countdown,
  and the split between settled and remaining escrow amounts to make this clear.
  See [expiry-and-refund.md](./expiry-and-refund.md) for the full user-facing
  description and error reference.
- SQLite is an atomic single-host replay cursor. Multi-instance production
  deployments need a shared transactional store (for example PostgreSQL) and
  operational monitoring.
- This MVP has no automated channel indexer, batch-claim scheduler, dispute
  mechanism, or production key-management service. The payee must keep the
  dashboard tab open until it submits the latest voucher on-chain to settle.
  Do not use real funds.
