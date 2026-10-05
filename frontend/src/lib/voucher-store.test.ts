import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVoucher,
  listStoredVouchers,
  loadVoucher,
  saveVoucher,
  type PersistedVoucher,
} from "./voucher-store";

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

function makeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
}

const fakeStorage = makeLocalStorage();

beforeEach(() => {
  fakeStorage.clear();
  vi.stubGlobal("localStorage", fakeStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SIGNATURE = "ab".repeat(64); // 128 hex chars

function sampleVoucher(overrides: Partial<PersistedVoucher> = {}): PersistedVoucher {
  return {
    channelId: "12345",
    amount: "500",
    nonce: "5",
    validUntil: String(Math.floor(Date.now() / 1000) + 300),
    signature: VALID_SIGNATURE,
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveVoucher / loadVoucher round-trip
// ---------------------------------------------------------------------------

describe("saveVoucher and loadVoucher", () => {
  it("persists and retrieves a voucher by channelId", () => {
    const voucher = sampleVoucher();
    saveVoucher(voucher);
    const loaded = loadVoucher("12345");
    expect(loaded).not.toBeNull();
    expect(loaded?.channelId).toBe("12345");
    expect(loaded?.amount).toBe("500");
    expect(loaded?.nonce).toBe("5");
    expect(loaded?.signature).toBe(VALID_SIGNATURE);
  });

  it("overwrites previous voucher for the same channelId (cumulative semantics)", () => {
    saveVoucher(sampleVoucher({ nonce: "3", amount: "300" }));
    saveVoucher(sampleVoucher({ nonce: "5", amount: "500" }));
    const loaded = loadVoucher("12345");
    expect(loaded?.nonce).toBe("5");
    expect(loaded?.amount).toBe("500");
  });

  it("returns null for an unknown channelId", () => {
    expect(loadVoucher("nonexistent")).toBeNull();
  });

  it("stores different channels independently", () => {
    saveVoucher(sampleVoucher({ channelId: "111", amount: "100", nonce: "1" }));
    saveVoucher(sampleVoucher({ channelId: "222", amount: "200", nonce: "2" }));
    expect(loadVoucher("111")?.amount).toBe("100");
    expect(loadVoucher("222")?.amount).toBe("200");
  });

  it("adds a savedAt ISO timestamp automatically", () => {
    const before = new Date().toISOString();
    saveVoucher(sampleVoucher());
    const after = new Date().toISOString();
    const loaded = loadVoucher("12345");
    expect(loaded?.savedAt).toBeDefined();
    expect(loaded!.savedAt >= before).toBe(true);
    expect(loaded!.savedAt <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearVoucher
// ---------------------------------------------------------------------------

describe("clearVoucher", () => {
  it("removes the stored voucher for the given channelId", () => {
    saveVoucher(sampleVoucher());
    clearVoucher("12345");
    expect(loadVoucher("12345")).toBeNull();
  });

  it("is a no-op for an unknown channelId", () => {
    expect(() => clearVoucher("nonexistent")).not.toThrow();
  });

  it("does not remove vouchers for other channels", () => {
    saveVoucher(sampleVoucher({ channelId: "AAA" }));
    saveVoucher(sampleVoucher({ channelId: "BBB" }));
    clearVoucher("AAA");
    expect(loadVoucher("AAA")).toBeNull();
    expect(loadVoucher("BBB")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listStoredVouchers
// ---------------------------------------------------------------------------

describe("listStoredVouchers", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(listStoredVouchers()).toEqual([]);
  });

  it("returns all persisted vouchers", () => {
    saveVoucher(sampleVoucher({ channelId: "1" }));
    saveVoucher(sampleVoucher({ channelId: "2" }));
    saveVoucher(sampleVoucher({ channelId: "3" }));
    expect(listStoredVouchers()).toHaveLength(3);
  });

  it("ignores unrelated localStorage keys", () => {
    fakeStorage.setItem("some_other_key", "irrelevant");
    fakeStorage.setItem("aetheris_config", "also_ignored");
    saveVoucher(sampleVoucher({ channelId: "42" }));
    const list = listStoredVouchers();
    expect(list).toHaveLength(1);
    expect(list[0].channelId).toBe("42");
  });

  it("ignores malformed entries", () => {
    fakeStorage.setItem("aetheris_voucher_bad", "not-valid-json{{{");
    fakeStorage.setItem(
      "aetheris_voucher_incomplete",
      JSON.stringify({ channelId: "x" }),
    );
    saveVoucher(sampleVoucher({ channelId: "good" }));
    const list = listStoredVouchers();
    expect(list).toHaveLength(1);
    expect(list[0].channelId).toBe("good");
  });
});

// ---------------------------------------------------------------------------
// Recovery scenario: missing voucher state (page closed before any API call)
// ---------------------------------------------------------------------------

describe("recovery: missing voucher state", () => {
  it("returns null when no voucher was ever persisted for a channel", () => {
    // Simulates a payer who opened a channel but never made an API call and
    // then refreshed the page.
    const voucher = loadVoucher("channel-never-used");
    expect(voucher).toBeNull();
  });

  it("payee has nothing to settle when voucher is missing", () => {
    // The payee must wait for the channel to expire and the payer to refund.
    const storedVouchers = listStoredVouchers();
    expect(storedVouchers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery scenario: expired-channel behavior
// ---------------------------------------------------------------------------

describe("recovery: expired channel behavior", () => {
  it("detects an expired voucher validUntil", () => {
    const expiredVoucher = sampleVoucher({
      channelId: "expired-channel",
      validUntil: String(Math.floor(Date.now() / 1000) - 60), // 60 seconds in the past
    });
    saveVoucher(expiredVoucher);

    const loaded = loadVoucher("expired-channel");
    expect(loaded).not.toBeNull();

    const nowSeconds = Math.floor(Date.now() / 1000);
    const isExpired = Number(loaded!.validUntil) <= nowSeconds;
    expect(isExpired).toBe(true);
  });

  it("non-expired voucher is still settleable", () => {
    const freshVoucher = sampleVoucher({
      channelId: "fresh-channel",
      validUntil: String(Math.floor(Date.now() / 1000) + 3600),
    });
    saveVoucher(freshVoucher);

    const loaded = loadVoucher("fresh-channel");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const isExpired = Number(loaded!.validUntil) <= nowSeconds;
    expect(isExpired).toBe(false);
  });

  it("cleared voucher after settlement leaves no residue", () => {
    saveVoucher(sampleVoucher({ channelId: "settled-channel" }));
    clearVoucher("settled-channel");
    expect(loadVoucher("settled-channel")).toBeNull();
    expect(listStoredVouchers()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Security: private key is never in a persisted voucher
// ---------------------------------------------------------------------------

describe("security: private key is never stored", () => {
  it("persisted voucher contains no secretKey field", () => {
    saveVoucher(sampleVoucher());
    const raw = fakeStorage.getItem("aetheris_voucher_12345");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("secretKey");
    expect(parsed).not.toHaveProperty("privateKey");
    expect(parsed).not.toHaveProperty("secret");
  });

  it("persisted voucher contains only the expected safe fields", () => {
    saveVoucher(sampleVoucher());
    const raw = fakeStorage.getItem("aetheris_voucher_12345");
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    const allowedKeys = new Set([
      "channelId",
      "amount",
      "nonce",
      "validUntil",
      "signature",
      "savedAt",
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowedKeys.has(key), `unexpected key in storage: ${key}`).toBe(true);
    }
  });
});
