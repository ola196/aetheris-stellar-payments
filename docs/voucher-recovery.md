# Voucher recovery after a page refresh or browser close

## What happens when the page is refreshed or closed

The Aetheris dashboard keeps three pieces of state exclusively in browser
memory (React `useState`):

| State | Stored where | Lost on refresh? |
| --- | --- | --- |
| `voucherSigner.secretKey` | Page memory only | **Yes** |
| `voucherSigner.publicKey` | Page memory only | **Yes** |
| `channelId` | Page memory only | **Yes** |
| `latestVoucher` (amount, nonce, validUntil, signature) | Page memory only | **Yes** |

When the page is refreshed or closed before the payee settles:

1. **The channel on-chain is unaffected.** The Soroban escrow contract still
   holds the deposited tokens. No funds move until `settle` or `refund` is
   explicitly called.

2. **The delegate signing key is gone.** The ephemeral Ed25519 private key
   exists only in page memory and cannot be recovered. No new vouchers can be
   signed for this channel from this browser session.

3. **The latest signed voucher may be gone.** If no voucher was ever
   persisted, the payee cannot produce a valid `settle` transaction and the
   escrow remains locked until the channel expires.

4. **After channel expiry the payer can recover their deposit.** The contract's
   `refund` entrypoint returns any unclaimed escrow to the payer once
   `expires_at` has passed.

## Recovery approach

The dashboard automatically persists the latest signed voucher in
`localStorage` as `aetheris_voucher_<channelId>`. Only the fields the payee
needs to call `settle` are stored — **no private key or signing secret is
ever written to storage**:

```json
{
  "channelId": "12345678",
  "amount": "500",
  "nonce": "5",
  "validUntil": "1700100000",
  "signature": "aabbcc…"
}
```

Because vouchers are cumulative the latest voucher supersedes all previous
ones. Only the current entry for each `channelId` is kept; stale entries are
pruned automatically.

### After a refresh — payer side

The payer's signing key is lost. The payer **cannot sign new vouchers** for
the same channel. If more API calls are needed, the payer must open a new
channel. The old channel's escrow remains locked until:

- the payee settles the stored voucher, or
- the channel expires and the payer calls `refund`.

### After a refresh — payee side

The payee can still settle using the stored voucher:

1. Reload the dashboard. The recovery panel appears automatically when a
   stored voucher is found in `localStorage`.
2. Connect the configured payee account in Freighter.
3. Click **Settle recovered voucher**. The dashboard calls the contract's
   `settle` entrypoint with the persisted fields.

### Channel expiry and refund

If no voucher was ever stored (the page was closed before any API call) or if
the voucher's `validUntil` is in the past, settlement is no longer possible.
After `expires_at` the payer can recover unclaimed escrow:

1. Connect the payer's Freighter account.
2. On the dashboard, the **Refund expired channel** button becomes active once
   the channel's expiry timestamp has passed.
3. Click it to submit the `refund` transaction.

## Security properties

- The private key never leaves page memory and is never written to any
  persistent store.
- Only the signed, self-contained voucher is persisted. A voucher is only
  valid if the Soroban contract's signature check, nonce check, expiry check,
  and deposit check all pass — storing a voucher does not grant any additional
  authority beyond what the payee already has via the running server.
- `localStorage` is origin-scoped and not accessible to other origins.
- Sensitive signing state is still ephemeral: clearing browser data or opening
  a fresh private-browsing tab produces a clean state with no stored vouchers.

## Limitations

- If the payer closes the tab without ever calling the paid API, no voucher
  exists to recover. The escrow remains locked until expiry.
- A `validUntil` timestamp that has already passed makes on-chain settlement
  impossible even if the voucher is present. Open channels with `validUntil`
  set far enough in the future (the dashboard uses +5 minutes per voucher,
  which is refreshed on each call). Only the *latest* voucher needs a live
  `validUntil`; if the last voucher expired, wait for channel expiry and use
  `refund`.
- This recovery mechanism is designed for the Testnet demo. A production
  deployment should use a server-side receipt store (e.g. the existing SQLite
  cursor already tracks every accepted voucher) so the payee can always
  retrieve the latest accepted voucher independently of the payer's browser.
