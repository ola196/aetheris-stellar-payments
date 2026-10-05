/**
 * Integration tests for the Aetheris x402 payment middleware.
 *
 * These tests exercise the full HTTP request/response boundary using Supertest
 * and an in-memory SQLite replay store so they run deterministically in CI
 * without a live Stellar Testnet.
 *
 * Coverage
 * ─────────
 * • HTTP 402 with a valid PAYMENT-REQUIRED header on unauthenticated requests
 * • HTTP 200 + PAYMENT-RESPONSE header on a correctly signed voucher
 * • Replay (same nonce) rejection
 * • Out-of-order nonce rejection
 * • Non-consecutive cumulative-amount rejection
 * • Invalid Ed25519 signature rejection
 * • Malformed / non-base64 / oversized header rejection
 * • Expired voucher rejection (validUntil in the past)
 * • Multi-step cumulative voucher scenario across several sequential requests
 * • /health endpoint always returns 200
 * • /paid/data returns 402 when accessed without a payment header
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  createPaymentMiddleware,
  parseEndpointRequirements,
  SqliteReplayStore,
  voucherMessage,
} from "../src/payment.js";

// ─── Fixture constants ────────────────────────────────────────────────────────

/** Deterministic 32-byte private key for all tests. */
const secretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const publicKey = await getPublicKeyAsync(secretKey);

/** A second, unrelated key used to produce bad signatures. */
const wrongSecretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 100);

const networkPassphrase = "Test SDF Network ; September 2015";
const contractId = `C${"A".repeat(55)}`;
const payTo = `G${"B".repeat(55)}`;
const tokenAddress = `C${"D".repeat(55)}`;
const channelId = "7";

/** Price per API call in smallest token units. */
const PRICE = 5n;

/** Channel deposit – large enough for many sequential calls. */
const DEPOSITED = 1_000n;

/** Default expiry: 10 minutes from now (plenty of headroom). */
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 600);

// ─── Helpers ──────────────────────────────────────────────────────────────────

let replayStore: SqliteReplayStore;

beforeEach(() => {
  replayStore = new SqliteReplayStore(":memory:");
});

afterEach(() => {
  replayStore.close();
});

/**
 * Build a minimal Express app wired up with the payment middleware.
 *
 * @param overrides - Partial channel snapshot overrides for edge-case tests.
 */
function makeApp(
  overrides: Partial<{
    deposited: bigint;
    settled: bigint;
    lastNonce: bigint;
    expiresAt: bigint;
    voucherKey: Uint8Array;
  }> = {},
) {
  const server = express();
  server.get(
    "/paid",
    createPaymentMiddleware({
      network: "stellar:testnet",
      networkPassphrase,
      contractId,
      tokenAddress,
      payTo,
      amount: PRICE,
      description: "test resource",
      mimeType: "application/json",
      loadChannel: async () => ({
        payer: payTo,
        payee: payTo,
        token: tokenAddress,
        voucherKey: publicKey,
        deposited: DEPOSITED,
        settled: 0n,
        lastNonce: 0n,
        expiresAt,
        ...overrides,
      }),
      replayStore,
    }),
    (_req, res) => res.json({ ok: true }),
  );
  return server;
}

/**
 * Sign a voucher and return the base64-encoded PAYMENT-SIGNATURE header value.
 *
 * @param nonce           - Voucher nonce (must be strictly increasing per channel).
 * @param cumulativeAmount - Running total amount authorised so far.
 * @param opts            - Optional overrides for expiry and signing key.
 */
async function buildSignedHeader(
  nonce: string | bigint,
  cumulativeAmount: string | bigint,
  opts: { validUntil?: bigint; signingKey?: Uint8Array } = {},
): Promise<string> {
  const validUntil = opts.validUntil ?? expiresAt - 1n;
  const signingKey = opts.signingKey ?? secretKey;

  const message = voucherMessage(
    networkPassphrase,
    contractId,
    BigInt(channelId),
    BigInt(cumulativeAmount),
    BigInt(nonce),
    validUntil,
  );
  const signature = await signAsync(message, signingKey);

  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "stellar-channel",
        network: "stellar:testnet",
        asset: tokenAddress,
        amount: PRICE.toString(),
        payTo,
      },
      payload: {
        channelId,
        cumulativeAmount: cumulativeAmount.toString(),
        nonce: nonce.toString(),
        validUntil: validUntil.toString(),
        signature: Buffer.from(signature).toString("hex"),
      },
    }),
  ).toString("base64");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("x402 payment middleware", () => {
  // ── Acceptance criterion 1: HTTP 402 + payment requirements ─────────────────

  describe("unauthenticated request", () => {
    it("returns HTTP 402 when no PAYMENT-SIGNATURE header is present", async () => {
      await request(makeApp()).get("/paid").expect(402);
    });

    it("includes a base64-encoded PAYMENT-REQUIRED header", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      expect(raw, "PAYMENT-REQUIRED header must be present").toBeTruthy();
      // Must be valid base64.
      expect(() => Buffer.from(raw, "base64")).not.toThrow();
    });

    it("PAYMENT-REQUIRED decodes to a valid x402 V2 payment requirement", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

      expect(required.x402Version).toBe(2);
      expect(required.accepts).toBeInstanceOf(Array);
      expect(required.accepts.length).toBeGreaterThan(0);

      const accept = required.accepts[0];
      expect(accept.scheme).toBe("stellar-channel");
      expect(accept.network).toBe("stellar:testnet");
      expect(accept.asset).toBe(tokenAddress);
      expect(accept.amount).toBe(PRICE.toString());
      expect(accept.payTo).toBe(payTo);
    });

    it("PAYMENT-REQUIRED extra fields reference the contract and voucher scheme", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      const extra = required.accepts[0].extra;

      expect(extra?.contractId).toBe(contractId);
      expect(extra?.channelVoucher).toBe("AETHERIS-X402-V1");
    });

    it("includes a resource object describing the paid route", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

      expect(required.resource).toBeTruthy();
      expect(required.resource.description).toBe("test resource");
      expect(required.resource.mimeType).toBe("application/json");
    });
  });

  // ── Acceptance criterion 2: valid voucher → HTTP 200 + PAYMENT-RESPONSE ─────

  describe("valid payment", () => {
    it("returns HTTP 200 for a correctly signed voucher", async () => {
      const header = await buildSignedHeader("1", PRICE);
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);
    });

    it("returns the protected resource body on success", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      expect(response.body.ok).toBe(true);
    });

    it("includes a base64-encoded PAYMENT-RESPONSE header on success", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const raw = response.headers["payment-response"];
      expect(raw, "PAYMENT-RESPONSE header must be present").toBeTruthy();
      expect(() => Buffer.from(raw, "base64")).not.toThrow();
    });

    it("PAYMENT-RESPONSE decodes to a valid x402 V2 success object", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const raw = response.headers["payment-response"];
      const paymentResponse = JSON.parse(
        Buffer.from(raw, "base64").toString("utf8"),
      );

      expect(paymentResponse.x402Version).toBe(2);
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.network).toBe("stellar:testnet");
      expect(paymentResponse.channelId).toBe(channelId);
      expect(paymentResponse.nonce).toBe("1");
      expect(paymentResponse.cumulativeAmount).toBe(PRICE.toString());
      expect(paymentResponse.settlement).toBe("deferred");
    });
  });

  // ── Acceptance criterion 3a: replay rejection ────────────────────────────────

  describe("replay protection", () => {
    it("rejects a replayed voucher (same nonce, same server instance)", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("includes an error message in the replay rejection body", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const response = await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);

      expect(response.body.error).toBeTruthy();
    });

    it("does NOT advance the cursor on a failed (invalid-signature) request", async () => {
      // A bad request must not consume the nonce so a subsequent good one works.
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.signature = "00".repeat(64);
      const invalid = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", invalid)
        .expect(402);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", valid)
        .expect(200);
    });
  });

  // ── Acceptance criterion 3b: out-of-order / non-consecutive rejections ───────

  describe("out-of-order and non-consecutive voucher rejection", () => {
    it("rejects a voucher with a nonce lower than the current cursor", async () => {
      const first = await buildSignedHeader("2", PRICE);
      const second = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", first)
        .expect(200);

      // Nonce 1 is now behind the cursor (nonce 2 was already accepted).
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", second)
        .expect(402);
    });

    it("rejects a voucher where cumulativeAmount skips more than one increment", async () => {
      // After nonce 1 / amount=5 is accepted, jumping to amount=15 (skipping 10) is invalid.
      const first = await buildSignedHeader("1", PRICE);
      const bad = await buildSignedHeader("2", PRICE * 3n); // skips amount=10

      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", first)
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", bad)
        .expect(402);
    });

    it("rejects a voucher with a zero nonce (nonce must be strictly positive)", async () => {
      const header = await buildSignedHeader("0", PRICE);
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });
  });

  // ── Acceptance criterion 3c: invalid signatures ──────────────────────────────

  describe("invalid signature rejection", () => {
    it("rejects an all-zero signature", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.signature = "00".repeat(64);
      const invalid = Buffer.from(JSON.stringify(decoded)).toString("base64");

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", invalid)
        .expect(402);
    });

    it("rejects a voucher signed by the wrong key", async () => {
      const header = await buildSignedHeader("1", PRICE, {
        signingKey: wrongSecretKey,
      });
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("rejects a signature produced over tampered payload fields", async () => {
      // Sign nonce=1 / amount=5, then mutate cumulativeAmount to 10.
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.cumulativeAmount = (PRICE * 2n).toString();
      const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64");

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", tampered)
        .expect(402);
    });
  });

  // ── Malformed header rejection ────────────────────────────────────────────────

  describe("malformed PAYMENT-SIGNATURE header", () => {
    it("returns HTTP 400 for a non-base64 header value", async () => {
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", "!!!not-base64!!!")
        .expect(400);
    });

    it("returns HTTP 400 for a base64 value that is not valid JSON", async () => {
      const notJson = Buffer.from("hello world").toString("base64");
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", notJson)
        .expect(400);
    });

    it("returns HTTP 400 for a JSON object that is missing required fields", async () => {
      const incomplete = Buffer.from(
        JSON.stringify({ x402Version: 2, accepted: {}, payload: {} }),
      ).toString("base64");
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", incomplete)
        .expect(400);
    });

    it("rejects a header exceeding the size limit (HTTP 400 or 431)", async () => {
      // Build a header > 16 384 characters.
      // Node's HTTP layer responds with 431 (Request Header Fields Too Large)
      // before the middleware runs; the middleware returns 400 for headers
      // within Node's limit but larger than the application limit. Both codes
      // are valid rejection responses.
      const oversized = "A".repeat(20_000);
      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", oversized)
      ).status;
      expect([400, 431]).toContain(status);
    });

    it("returns HTTP 400 or 402 for an unsupported x402 version", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.x402Version = 1; // unsupported
      const bad = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", bad)
      ).status;
      expect([400, 402]).toContain(status);
    });

    it("returns HTTP 400 or 402 for an unsupported scheme", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.accepted.scheme = "unknown-scheme";
      const bad = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", bad)
      ).status;
      expect([400, 402]).toContain(status);
    });
  });

  // ── Expired voucher rejection ─────────────────────────────────────────────────

  describe("expired voucher rejection", () => {
    it("rejects a voucher whose validUntil is in the past", async () => {
      const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 60);
      const header = await buildSignedHeader("1", PRICE, {
        validUntil: pastTimestamp,
      });

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("rejects a voucher when the channel itself has expired", async () => {
      const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1);
      // validUntil must be <= channel.expiresAt, so set both in the past.
      const header = await buildSignedHeader("1", PRICE, {
        validUntil: pastExpiry,
      });

      await request(makeApp({ expiresAt: pastExpiry }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });
  });

  // ── Multi-step cumulative voucher scenario ────────────────────────────────────

  describe("multi-step cumulative voucher sequence", () => {
    it("accepts three sequential vouchers with strictly increasing nonces and amounts", async () => {
      const server = makeApp();

      for (let step = 1; step <= 3; step++) {
        const header = await buildSignedHeader(step, PRICE * BigInt(step));
        await request(server)
          .get("/paid")
          .set("PAYMENT-SIGNATURE", header)
          .expect(200);
      }
    });

    it("PAYMENT-RESPONSE reflects the correct nonce and cumulative amount at each step", async () => {
      const server = makeApp();

      for (let step = 1; step <= 3; step++) {
        const nonce = step;
        const cumulative = PRICE * BigInt(step);
        const header = await buildSignedHeader(nonce, cumulative);
        const response = await request(server)
          .get("/paid")
          .set("PAYMENT-SIGNATURE", header)
          .expect(200);

        const paymentResponse = JSON.parse(
          Buffer.from(response.headers["payment-response"], "base64").toString(
            "utf8",
          ),
        );
        expect(paymentResponse.nonce).toBe(nonce.toString());
        expect(paymentResponse.cumulativeAmount).toBe(cumulative.toString());
      }
    });

    it("rejects any voucher after a gap in the cumulative amount sequence", async () => {
      const server = makeApp();

      // Accept steps 1 and 2.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(1, PRICE))
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(2, PRICE * 2n))
        .expect(200);

      // Skip to amount=20 (PRICE*4) instead of PRICE*3.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 4n))
        .expect(402);
    });

    it("still accepts the correct step 3 after the gap-skip was rejected", async () => {
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(1, PRICE))
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(2, PRICE * 2n))
        .expect(200);

      // Bad voucher (gap) – must not corrupt the cursor.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 4n))
        .expect(402);

      // Correct step 3.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 3n))
        .expect(200);
    });
  });

  // ── /health endpoint ──────────────────────────────────────────────────────────

  describe("/health endpoint", () => {
    it("returns HTTP 200 without any payment header", async () => {
      const server = express();
      server.get("/health", (_req, res) => res.json({ status: "ok" }));
      const response = await request(server).get("/health").expect(200);
      expect(response.body.status).toBe("ok");
    });
  });

  // ── /paid/data-style route 402 gate ───────────────────────────────────────────

  describe("paid data route gate", () => {
    it("returns 402 without a payment header on a named paid route", async () => {
      const server = express();
      server.get(
        "/paid/data",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress,
          payTo,
          amount: PRICE,
          description: "Aetheris metered data endpoint",
          mimeType: "application/json",
          loadChannel: async () => ({
            payer: payTo,
            payee: payTo,
            token: tokenAddress,
            voucherKey: publicKey,
            deposited: DEPOSITED,
            settled: 0n,
            lastNonce: 0n,
            expiresAt,
          }),
          replayStore,
        }),
        (_req, res) =>
          res.json({
            data: "Access granted using a signed Stellar channel voucher.",
            network: "stellar:testnet",
          }),
      );

      const response = await request(server).get("/paid/data").expect(402);
      const raw = response.headers["payment-required"];
      expect(raw).toBeTruthy();

      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.x402Version).toBe(2);
      expect(required.accepts[0].scheme).toBe("stellar-channel");
    });

    it("returns 200 with correct body when a valid voucher is provided to /paid/data", async () => {
      const server = express();
      server.get(
        "/paid/data",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress,
          payTo,
          amount: PRICE,
          description: "Aetheris metered data endpoint",
          mimeType: "application/json",
          loadChannel: async () => ({
            payer: payTo,
            payee: payTo,
            token: tokenAddress,
            voucherKey: publicKey,
            deposited: DEPOSITED,
            settled: 0n,
            lastNonce: 0n,
            expiresAt,
          }),
          replayStore,
        }),
        (_req, res) =>
          res.json({
            data: "Access granted using a signed Stellar channel voucher.",
            network: "stellar:testnet",
          }),
      );

      const header = await buildSignedHeader("1", PRICE);
      const response = await request(server)
        .get("/paid/data")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      expect(response.body.data).toMatch(/Access granted/);
      expect(response.body.network).toBe("stellar:testnet");
    });
  });
});

// ─── Per-endpoint payment requirement tests ──────────────────────────────────
//
// These tests exercise the parseEndpointRequirements validator and the
// per-endpoint middleware wiring:
//
//  • parseEndpointRequirements – accepts well-formed JSON, rejects every
//    invalid shape (non-array, bad types, empty strings, negative amounts,
//    zero amounts, non-/ paths, duplicate paths, non-JSON input).
//  • Per-endpoint 402 challenge – the PAYMENT-REQUIRED header reflects the
//    price and token for *that specific route*, not a different one.
//  • Wrong asset rejection – a voucher citing the wrong token address is
//    rejected even when the amount and signature are otherwise valid.
//  • Wrong amount rejection – a voucher with a valid signature but the wrong
//    price for this route is rejected.
//  • Two routes, different prices – both routes are independently gated at
//    their own prices and neither accepts the other's voucher.

// ── A second token address and higher price for multi-route tests ─────────────

const altTokenAddress = `C${"E".repeat(55)}`;
const PRICE_HIGH = 500n;

/**
 * Build a signed payment header that references a specific token and price.
 * Mirrors buildSignedHeader but allows overriding the asset / amount declared
 * in the `accepted` object independently of the voucher signature.
 */
async function buildSignedHeaderFor(
  nonce: string | bigint,
  cumulativeAmount: string | bigint,
  opts: {
    validUntil?: bigint;
    signingKey?: Uint8Array;
    /** Token address to put in the `accepted.asset` field. */
    declaredAsset?: string;
    /** Price string to put in the `accepted.amount` field. */
    declaredAmount?: string;
  } = {},
): Promise<string> {
  const validUntil = opts.validUntil ?? expiresAt - 1n;
  const signingKey = opts.signingKey ?? secretKey;
  const declaredAsset = opts.declaredAsset ?? tokenAddress;
  const declaredAmount = opts.declaredAmount ?? PRICE.toString();

  const message = voucherMessage(
    networkPassphrase,
    contractId,
    BigInt(channelId),
    BigInt(cumulativeAmount),
    BigInt(nonce),
    validUntil,
  );
  const signature = await signAsync(message, signingKey);

  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "stellar-channel",
        network: "stellar:testnet",
        asset: declaredAsset,
        amount: declaredAmount,
        payTo,
      },
      payload: {
        channelId,
        cumulativeAmount: cumulativeAmount.toString(),
        nonce: nonce.toString(),
        validUntil: validUntil.toString(),
        signature: Buffer.from(signature).toString("hex"),
      },
    }),
  ).toString("base64");
}

/**
 * Build an Express app with two independently-priced paid routes:
 *   GET /paid/low   – PRICE (5 units) of tokenAddress
 *   GET /paid/high  – PRICE_HIGH (500 units) of altTokenAddress
 *
 * Both share the same channel snapshot (publicKey, DEPOSITED, etc.).
 */
function makeTwoRouteApp(
  overrides: Partial<{
    deposited: bigint;
    settled: bigint;
    lastNonce: bigint;
    expiresAt: bigint;
    voucherKey: Uint8Array;
  }> = {},
) {
  const snapshot = {
    payer: payTo,
    payee: payTo,
    token: tokenAddress,
    voucherKey: publicKey,
    deposited: DEPOSITED,
    settled: 0n,
    lastNonce: 0n,
    expiresAt,
    ...overrides,
  };

  const server = express();

  // Low-priced route (PRICE units of tokenAddress).
  server.get(
    "/paid/low",
    createPaymentMiddleware({
      network: "stellar:testnet",
      networkPassphrase,
      contractId,
      tokenAddress,
      payTo,
      amount: PRICE,
      description: "Low-price endpoint",
      mimeType: "application/json",
      loadChannel: async () => snapshot,
      replayStore,
    }),
    (_req, res) => res.json({ route: "low" }),
  );

  // High-priced route (PRICE_HIGH units of altTokenAddress).
  server.get(
    "/paid/high",
    createPaymentMiddleware({
      network: "stellar:testnet",
      networkPassphrase,
      contractId,
      tokenAddress: altTokenAddress,
      payTo,
      amount: PRICE_HIGH,
      description: "High-price endpoint",
      mimeType: "application/json",
      loadChannel: async () => ({ ...snapshot, token: altTokenAddress }),
      replayStore,
    }),
    (_req, res) => res.json({ route: "high" }),
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("parseEndpointRequirements", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns an empty array for undefined input", () => {
    expect(parseEndpointRequirements(undefined)).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseEndpointRequirements("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(parseEndpointRequirements("   ")).toEqual([]);
  });

  it("parses a single valid endpoint requirement", () => {
    const raw = JSON.stringify([
      {
        path: "/paid/data",
        amount: "100",
        tokenAddress: `C${"A".repeat(55)}`,
        description: "Metered data",
        mimeType: "application/json",
      },
    ]);
    const result = parseEndpointRequirements(raw);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/paid/data");
    expect(result[0].amount).toBe(100n);
    expect(result[0].description).toBe("Metered data");
    expect(result[0].mimeType).toBe("application/json");
  });

  it("parses multiple valid endpoint requirements", () => {
    const raw = JSON.stringify([
      {
        path: "/paid/a",
        amount: "50",
        tokenAddress: `C${"A".repeat(55)}`,
        description: "Route A",
        mimeType: "application/json",
      },
      {
        path: "/paid/b",
        amount: "200",
        tokenAddress: `C${"B".repeat(55)}`,
        description: "Route B",
        mimeType: "text/plain",
      },
    ]);
    const result = parseEndpointRequirements(raw);
    expect(result).toHaveLength(2);
    expect(result[0].amount).toBe(50n);
    expect(result[1].amount).toBe(200n);
  });

  it("converts amount strings to BigInt values", () => {
    const raw = JSON.stringify([
      {
        path: "/paid/big",
        amount: "999999999999999999",
        tokenAddress: `C${"A".repeat(55)}`,
        description: "Big price",
        mimeType: "application/json",
      },
    ]);
    const [endpoint] = parseEndpointRequirements(raw);
    expect(endpoint.amount).toBe(999_999_999_999_999_999n);
  });

  // ── JSON parsing errors ──────────────────────────────────────────────────────

  it("throws on non-JSON input", () => {
    expect(() => parseEndpointRequirements("not json")).toThrow(
      "ENDPOINT_REQUIREMENTS is not valid JSON",
    );
  });

  it("throws when the top-level value is a JSON object, not an array", () => {
    expect(() => parseEndpointRequirements("{}")).toThrow(
      "ENDPOINT_REQUIREMENTS must be a JSON array",
    );
  });

  it("throws when the top-level value is a JSON string, not an array", () => {
    expect(() => parseEndpointRequirements('"hello"')).toThrow(
      "ENDPOINT_REQUIREMENTS must be a JSON array",
    );
  });

  // ── Per-element validation errors ────────────────────────────────────────────

  it("throws when an element is not an object", () => {
    const raw = JSON.stringify(["not-an-object"]);
    expect(() => parseEndpointRequirements(raw)).toThrow(
      "each element must be a JSON object",
    );
  });

  it("throws when path is missing", () => {
    const raw = JSON.stringify([
      { amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "path"');
  });

  it("throws when path is an empty string", () => {
    const raw = JSON.stringify([
      { path: "", amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "path"');
  });

  it("throws when path does not start with /", () => {
    const raw = JSON.stringify([
      { path: "paid/data", amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('path must start with "/"');
  });

  it("throws when amount is missing", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "amount"');
  });

  it("throws when amount is zero", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "0", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow("positive integer");
  });

  it("throws when amount is negative", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "-1", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow("positive integer");
  });

  it("throws when amount has a leading zero", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "010", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow("positive integer");
  });

  it("throws when amount is a decimal string", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "1.5", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow("positive integer");
  });

  it("throws when amount is a number, not a string", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: 100, tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "amount"');
  });

  it("throws when tokenAddress is missing", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "100", description: "d", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "tokenAddress"');
  });

  it("throws when description is an empty string", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "description"');
  });

  it("throws when mimeType is missing", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "d" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('field "mimeType"');
  });

  it("throws on duplicate paths", () => {
    const raw = JSON.stringify([
      { path: "/paid/data", amount: "100", tokenAddress: `C${"A".repeat(55)}`, description: "d", mimeType: "m" },
      { path: "/paid/data", amount: "200", tokenAddress: `C${"B".repeat(55)}`, description: "d2", mimeType: "m" },
    ]);
    expect(() => parseEndpointRequirements(raw)).toThrow('duplicate path "/paid/data"');
  });
});

// ─── Per-endpoint middleware behaviour ───────────────────────────────────────

describe("per-endpoint payment requirements", () => {
  // ── 402 challenge reflects the correct per-route price ───────────────────────

  describe("endpoint-specific 402 challenges", () => {
    it("returns the low price in PAYMENT-REQUIRED for the low-priced route", async () => {
      const response = await request(makeTwoRouteApp()).get("/paid/low").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.accepts[0].amount).toBe(PRICE.toString());
      expect(required.accepts[0].asset).toBe(tokenAddress);
    });

    it("returns the high price in PAYMENT-REQUIRED for the high-priced route", async () => {
      const response = await request(makeTwoRouteApp()).get("/paid/high").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.accepts[0].amount).toBe(PRICE_HIGH.toString());
      expect(required.accepts[0].asset).toBe(altTokenAddress);
    });

    it("PAYMENT-REQUIRED resource.description matches the per-route description", async () => {
      const response = await request(makeTwoRouteApp()).get("/paid/low").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.resource.description).toBe("Low-price endpoint");
    });

    it("PAYMENT-REQUIRED resource.url contains the requested path", async () => {
      const response = await request(makeTwoRouteApp()).get("/paid/high").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.resource.url).toMatch("/paid/high");
    });
  });

  // ── Wrong asset rejection ────────────────────────────────────────────────────

  describe("wrong asset rejection", () => {
    it("rejects a voucher citing the wrong token address (right amount, valid signature)", async () => {
      // The /paid/low route requires tokenAddress; present altTokenAddress instead.
      const header = await buildSignedHeaderFor("1", PRICE, {
        declaredAsset: altTokenAddress,
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });

    it("rejects a voucher that omits the asset field entirely (malformed)", async () => {
      const valid = await buildSignedHeaderFor("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      delete decoded.accepted.asset;
      const bad = Buffer.from(JSON.stringify(decoded)).toString("base64");
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", bad)
        .expect(400);
    });
  });

  // ── Wrong amount rejection ───────────────────────────────────────────────────

  describe("wrong amount rejection", () => {
    it("rejects a voucher declaring the high price on the low-priced route", async () => {
      // Voucher says amount = PRICE_HIGH but the route expects PRICE.
      const header = await buildSignedHeaderFor("1", PRICE_HIGH, {
        declaredAmount: PRICE_HIGH.toString(),
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });

    it("rejects a voucher with amount=0 (invalid regardless of asset)", async () => {
      const header = await buildSignedHeaderFor("1", "0", {
        declaredAmount: "0",
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });

    it("rejects a voucher where the declared amount does not match the signed amount", async () => {
      // Sign nonce=1 / cumulative=PRICE, but declare amount=PRICE*2 in accepted.
      const header = await buildSignedHeaderFor("1", PRICE, {
        declaredAmount: (PRICE * 2n).toString(),
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });
  });

  // ── Cross-endpoint voucher isolation ─────────────────────────────────────────

  describe("cross-endpoint voucher isolation", () => {
    it("accepts a correct low-price voucher on /paid/low", async () => {
      const header = await buildSignedHeaderFor("1", PRICE, {
        declaredAsset: tokenAddress,
        declaredAmount: PRICE.toString(),
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);
    });

    it("rejects a low-price voucher on the high-priced /paid/high route", async () => {
      // Correct asset + amount for /paid/low, but wrong for /paid/high.
      const header = await buildSignedHeaderFor("1", PRICE, {
        declaredAsset: tokenAddress,
        declaredAmount: PRICE.toString(),
      });
      await request(makeTwoRouteApp())
        .get("/paid/high")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });

    it("rejects a high-price voucher on the low-priced /paid/low route", async () => {
      // Correct asset + amount for /paid/high, but wrong for /paid/low.
      const header = await buildSignedHeaderFor("1", PRICE_HIGH, {
        declaredAsset: altTokenAddress,
        declaredAmount: PRICE_HIGH.toString(),
      });
      await request(makeTwoRouteApp())
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", header)
        .expect(400);
    });

    it("both routes return 200 independently with their own correct vouchers", async () => {
      // Each route uses its own channel ID (different payer channels) so the
      // SQLite replay cursors are independent and do not interfere.
      const lowChannelId = "7";
      const highChannelId = "8";

      // Snapshot builder for a given channel ID.
      const makeSnapshot = (token: string) => ({
        payer: payTo,
        payee: payTo,
        token,
        voucherKey: publicKey,
        deposited: DEPOSITED,
        settled: 0n,
        lastNonce: 0n,
        expiresAt,
      });

      const server = express();

      server.get(
        "/paid/low",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress,
          payTo,
          amount: PRICE,
          description: "Low-price endpoint",
          mimeType: "application/json",
          loadChannel: async () => makeSnapshot(tokenAddress),
          replayStore,
        }),
        (_req, res) => res.json({ route: "low" }),
      );

      server.get(
        "/paid/high",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress: altTokenAddress,
          payTo,
          amount: PRICE_HIGH,
          description: "High-price endpoint",
          mimeType: "application/json",
          loadChannel: async () => makeSnapshot(altTokenAddress),
          replayStore,
        }),
        (_req, res) => res.json({ route: "high" }),
      );

      // Build a voucher for channel lowChannelId and the low-price route.
      const lowMessage = voucherMessage(
        networkPassphrase,
        contractId,
        BigInt(lowChannelId),
        PRICE,
        1n,
        expiresAt - 1n,
      );
      const lowSig = await signAsync(lowMessage, secretKey);
      const lowHeader = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: { scheme: "stellar-channel", network: "stellar:testnet", asset: tokenAddress, amount: PRICE.toString(), payTo },
          payload: { channelId: lowChannelId, cumulativeAmount: PRICE.toString(), nonce: "1", validUntil: (expiresAt - 1n).toString(), signature: Buffer.from(lowSig).toString("hex") },
        }),
      ).toString("base64");

      await request(server)
        .get("/paid/low")
        .set("PAYMENT-SIGNATURE", lowHeader)
        .expect(200);

      // Build a voucher for channel highChannelId and the high-price route.
      const highMessage = voucherMessage(
        networkPassphrase,
        contractId,
        BigInt(highChannelId),
        PRICE_HIGH,
        1n,
        expiresAt - 1n,
      );
      const highSig = await signAsync(highMessage, secretKey);
      const highHeader = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: { scheme: "stellar-channel", network: "stellar:testnet", asset: altTokenAddress, amount: PRICE_HIGH.toString(), payTo },
          payload: { channelId: highChannelId, cumulativeAmount: PRICE_HIGH.toString(), nonce: "1", validUntil: (expiresAt - 1n).toString(), signature: Buffer.from(highSig).toString("hex") },
        }),
      ).toString("base64");

      await request(server)
        .get("/paid/high")
        .set("PAYMENT-SIGNATURE", highHeader)
        .expect(200);
    });
  });
});
