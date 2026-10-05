# Channel expiry and refund

This document explains how escrow funds are locked, when the payer can
recover them, and how the dashboard communicates channel status.

## How escrow funds are locked

When a payer opens a channel they transfer a token deposit into the Soroban
contract. Those funds are locked until one of two things happens:

1. **The payee settles** — calling `settle` with a valid signed voucher
   transfers only the settled-amount difference from escrow to the payee.
   The remaining balance stays locked until either another settlement or an
   expiry refund.
2. **The channel expires and the payer refunds** — after the channel's
   `expires_at` timestamp the payer can call `refund` to recover whatever
   has not yet been settled.

There is no automatic release: escrow remains locked until an explicit
on-chain action is taken.

## Channel lifetime

A channel has a maximum lifetime of **30 days** from the time it is opened.
The expiry timestamp is set during `open_channel` and cannot be changed
afterwards.

The dashboard shows:

- The exact expiry date and time.
- A human-readable countdown while the channel is still active (for example
  "23h 55m" or "5m 30s").
- An "expired" label once the channel has passed its expiry time.

## Settled vs remaining escrow

The dashboard shows two amounts in the channel panel:

| Label | Meaning |
| --- | --- |
| **Settled** | How many token units the payee has claimed on-chain so far. |
| **Remaining in escrow** | How many token units are still locked (deposited − settled). |

The same breakdown appears in the HTTP 402 flow panel so the payer can
always see how much is outstanding at a glance.

## Who can request a refund

**Only the payer can request a refund.** The contract enforces this with
`payer.require_auth()` inside the `refund` function. The payee's account
is never authorized to call `refund`.

**A refund can only be requested after the channel expires.** The contract
checks `env.ledger().timestamp() > channel.expires_at` and returns
`ChannelStillActive` if the channel has not yet expired.

The dashboard enforces this in the UI:

- While the channel is still active, the refund button is hidden and a
  notice explains that refunds are only available after expiry.
- After expiry, the Refund button appears showing exactly how many token
  units will be returned to the payer.
- The Refund button is disabled if there is nothing left to refund (the
  full deposit was already settled by the payee).

## Refund flow step by step

1. Wait for the channel's expiry time to pass.
2. Open the dashboard (or the recovery panel if the page was reloaded).
3. Connect **the original payer account** in Freighter. The contract will
   reject the transaction if any other account signs it.
4. Click **Refund `<amount>` units to payer**.
5. Approve the Soroban transaction in Freighter.
6. The contract transfers the remaining escrow back to the payer and
   removes the channel from on-chain storage.

## Error messages

| Error | Dashboard message | What it means |
| --- | --- | --- |
| `ChannelStillActive` | "Refund rejected: the channel has not yet expired. Only the payer can request a refund, and only after the channel expiry time has passed." | The expiry timestamp has not been reached. Wait and try again after expiry. |
| `NothingToRefund` | "Refund rejected: all deposited funds have already been settled — there is nothing left to refund." | The payee already settled the entire deposit. No funds remain in escrow. |
| `Unauthorized` | Wallet or network error propagated from Freighter | The connected account is not the channel's payer. Switch Freighter to the correct account. |

## Recovery panel

If the page was reloaded or closed before a refund, the **Recovery /
Unsettled Vouchers** panel appears automatically when the tab is reopened
(vouchers are saved to `localStorage`).

- If the voucher's `valid_until` has expired but the channel itself is
  still active: the payee cannot settle and the payer must wait until the
  channel expires before refunding.
- If the channel has also expired: click **Refund expired channel** after
  switching Freighter to the payer account.

See [voucher-recovery.md](./voucher-recovery.md) for the full recovery
walkthrough.

## Contract reference

The relevant contract functions and errors are documented in
[contract-api.md](./contract-api.md). Key details:

- `refund(id)` — authorized by channel payer, requires `timestamp > expires_at`,
  transfers `deposited - settled` back to payer, removes the channel entry.
- `ChannelStillActive` (error 9) — returned when `timestamp <= expires_at`.
- `NothingToRefund` (error 12) — returned when `deposited == settled`.
- `Unauthorized` (error 3) — returned when the signer is not the channel's payer.
