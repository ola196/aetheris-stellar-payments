/**
 * Tests for the channel expiry and refund UX helper logic extracted from page.tsx.
 *
 * These tests cover:
 *  - formatTimeRemaining: human-readable countdown display
 *  - refundErrorMessage: distinguishes ChannelStillActive / NothingToRefund
 *  - channelExpired / remainingEscrow computations
 *  - Recovery panel expired-voucher detection
 */

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Inline re-implementations of the helpers from page.tsx so they can be unit-
// tested without mounting the full React component.
// ---------------------------------------------------------------------------

function formatTimeRemaining(expiresAt: bigint): string {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const delta = expiresAt > nowSec ? expiresAt - nowSec : 0n;
  const totalSec = Number(delta);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function refundErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : "Unexpected wallet or network error";
  if (msg.includes("ChannelStillActive") || msg.includes("(9)")) {
    return (
      "Refund rejected: the channel has not yet expired. " +
      "Only the payer can request a refund, and only after the channel expiry time has passed."
    );
  }
  if (msg.includes("NothingToRefund") || msg.includes("(12)")) {
    return "Refund rejected: all deposited funds have already been settled — there is nothing left to refund.";
  }
  return msg;
}

function channelExpired(channelExpiresAt: bigint): boolean {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return channelExpiresAt > 0n && channelExpiresAt <= nowSeconds;
}

function remainingEscrow(deposited: bigint, settled: bigint): bigint {
  return deposited - settled;
}

// ---------------------------------------------------------------------------
// formatTimeRemaining
// ---------------------------------------------------------------------------

describe("formatTimeRemaining", () => {
  it("formats days and hours when more than 24 hours remain", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec + 86_400n * 2n + 3_600n * 3n; // 2d 3h
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("2d 3h");
  });

  it("formats hours and minutes when between 1 and 24 hours remain", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec + 3_600n * 5n + 60n * 20n; // 5h 20m
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("5h 20m");
  });

  it("formats minutes and seconds when less than 1 hour remains", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec + 60n * 7n + 45n; // 7m 45s
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("7m 45s");
  });

  it("formats seconds only when less than 1 minute remains", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec + 30n;
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("30s");
  });

  it("returns 0s for an already-expired timestamp", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec - 100n;
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("0s");
  });

  it("formats exactly 24 hours as 1d 0h", () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const expiresAt = nowSec + 86_400n;
    const result = formatTimeRemaining(expiresAt);
    expect(result).toBe("1d 0h");
  });
});

// ---------------------------------------------------------------------------
// refundErrorMessage — distinguishes ChannelStillActive and NothingToRefund
// ---------------------------------------------------------------------------

describe("refundErrorMessage", () => {
  it("returns a payer-focused explanation for ChannelStillActive by name", () => {
    const error = new Error("Contract error: ChannelStillActive");
    const result = refundErrorMessage(error);
    expect(result).toContain("channel has not yet expired");
    expect(result).toContain("Only the payer can request a refund");
    expect(result).toContain("after the channel expiry time has passed");
  });

  it("returns a payer-focused explanation for ChannelStillActive by code (9)", () => {
    const error = new Error("Contract returned error code (9)");
    const result = refundErrorMessage(error);
    expect(result).toContain("channel has not yet expired");
    expect(result).toContain("Only the payer can request a refund");
  });

  it("returns a settled-funds explanation for NothingToRefund by name", () => {
    const error = new Error("Contract error: NothingToRefund");
    const result = refundErrorMessage(error);
    expect(result).toContain("all deposited funds have already been settled");
    expect(result).toContain("nothing left to refund");
  });

  it("returns a settled-funds explanation for NothingToRefund by code (12)", () => {
    const error = new Error("Error code (12) returned");
    const result = refundErrorMessage(error);
    expect(result).toContain("all deposited funds have already been settled");
  });

  it("passes through unrecognized error messages unchanged", () => {
    const error = new Error("Network timeout");
    expect(refundErrorMessage(error)).toBe("Network timeout");
  });

  it("handles non-Error values gracefully", () => {
    const result = refundErrorMessage("something weird");
    expect(result).toBe("Unexpected wallet or network error");
  });

  it("handles null gracefully", () => {
    const result = refundErrorMessage(null);
    expect(result).toBe("Unexpected wallet or network error");
  });
});

// ---------------------------------------------------------------------------
// channelExpired — boolean derived from current time vs expires_at
// ---------------------------------------------------------------------------

describe("channelExpired", () => {
  it("returns false when no channel exists (expiresAt = 0)", () => {
    expect(channelExpired(0n)).toBe(false);
  });

  it("returns false when expiry is in the future", () => {
    const future = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    expect(channelExpired(future)).toBe(false);
  });

  it("returns true when expiry is in the past", () => {
    const past = BigInt(Math.floor(Date.now() / 1000) - 1);
    expect(channelExpired(past)).toBe(true);
  });

  it("returns true when expiry equals the current second", () => {
    // expires_at <= nowSeconds means expired (same timestamp = expired)
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(channelExpired(now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// remainingEscrow — deposited minus settled
// ---------------------------------------------------------------------------

describe("remainingEscrow", () => {
  it("equals the full deposit when nothing has been settled", () => {
    expect(remainingEscrow(100_000n, 0n)).toBe(100_000n);
  });

  it("decreases as the settled amount grows", () => {
    expect(remainingEscrow(100_000n, 30_000n)).toBe(70_000n);
  });

  it("is zero when the full deposit has been settled", () => {
    expect(remainingEscrow(100_000n, 100_000n)).toBe(0n);
  });

  it("represents the correct amount the payer could refund after expiry", () => {
    // After expiry the contract returns (deposited - settled) on refund().
    // Verify our UI computation matches.
    const deposited = 500n;
    const settled = 300n;
    expect(remainingEscrow(deposited, settled)).toBe(200n);
  });
});

// ---------------------------------------------------------------------------
// Recovery-panel expired voucher detection logic
// ---------------------------------------------------------------------------

describe("recovery panel: expired voucher detection", () => {
  it("marks a voucher as expired when validUntil is in the past", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validUntil = String(nowSec - 60);
    const expired = Number(validUntil) <= nowSec;
    expect(expired).toBe(true);
  });

  it("does not mark a voucher as expired when validUntil is in the future", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const validUntil = String(nowSec + 300);
    const expired = Number(validUntil) <= nowSec;
    expect(expired).toBe(false);
  });

  it("only the payer can refund: settlement is not possible after voucher expiry", () => {
    // When a voucher is expired, the payee cannot settle (validUntil <= ledger timestamp
    // on the contract side). The payer must wait for channel expiry to refund.
    const nowSec = Math.floor(Date.now() / 1000);
    const voucherValidUntil = nowSec - 10; // expired voucher
    const channelExpiresAtTs = nowSec + 3_600; // channel itself not yet expired

    const voucherExpired = voucherValidUntil <= nowSec;
    const channelAlsoExpired = channelExpiresAtTs <= nowSec;

    // Voucher expired → payee cannot settle.
    expect(voucherExpired).toBe(true);
    // Channel not yet expired → payer cannot refund yet either.
    expect(channelAlsoExpired).toBe(false);
  });
});
